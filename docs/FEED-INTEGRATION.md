# Connect a host-owned market feed

[한국어](FEED-INTEGRATION.ko.md) · [Data contract](DATA.md) · [Bounded ingestion queue](INGESTION.md)

This executable recipe connects an HTTP history snapshot to an ordered live stream. Feed acquisition, authentication, entitlement and retries remain in your app. It uses existing SDK data methods; it does not add a feed client to the SDK.

## Run without a provider account

```sh
node scripts/serve-feed.mjs
```

Open `http://127.0.0.1:5190/examples/web/feed.html`. The same-origin fixture supplies 64 synthetic bars and an actual SSE connection. Click Connect, Update, Append, Correction, Duplicate, Gap, Disconnect and Reconnect. There are no market prices, external requests, automatic retries or orders. The fixture is limited to 256 bars / 8 streams and is not a production service.

The [host session](../examples/web/feed-session.mjs) and [HTTP/SSE adapter](../examples/web/feed-transport.mjs) are example code. The adapter keeps snapshot responses within 16 MiB by cancelling an over-limit response body; individual event text is limited to 16,384 characters. Network traffic uses only the local server unless the host replaces the adapter.

## Required provider contract

A snapshot returns `{bars, lastSequence}`. The stream returns `{sequence, kind, bar}`, where kind is `update`, `append` or `correction`. Both must describe the **same instrument, timeframe, session/adjustment policy and sequence domain**. The snapshot includes all changes through `lastSequence`; stream sequence numbers after that watermark must be contiguous. The stream's `ready` promise must settle only after it can deliver every subsequent event. Close must retire its resources.

This is not a generic assumption about exchange APIs. If your provider has per-channel cursors, revisions, reconnect tokens or a different bootstrap protocol, implement that protocol in the host adapter. Timestamps or arrival order cannot establish which of two conflicting prices is newer.

## Session lifecycle

1. Retire the previous subscription and abort its snapshot. Open a new subscription first.
2. Wait for subscription readiness, then request the snapshot. Buffer at most 128 copied events by default (configurable up to 4,096).
3. Validate the snapshot in a detached BarStore. Ignore buffered events at or below its watermark and apply the remaining contiguous events to that candidate.
4. Check the mounted source has not changed, then publish the candidate columns once. Invalid data or a buffered gap retains the accepted chart.
5. Apply live events through the existing public data API. Ignore duplicate sequence numbers. On a gap, invalid event, external source mutation or budget error, stop and require an explicit reconnect.
6. Disconnect on suspension or when leaving the screen; dispose on terminal owner teardown. A new connection uses its own generation, so late callbacks and old snapshot results cannot publish.

The browser example suspends its network subscription while hidden. Returning with connect intent requests a fresh snapshot. Explicit user Pause remains paused. It disables the browser EventSource's implicit retry by closing the source on error.

```js
// In an application, change the imports to your package/local recipe paths.
import {createFeedSession} from './feed-session.mjs';
import {createHttpFeedTransport} from './feed-transport.mjs';

const transport = createHttpFeedTransport();
const feed = createFeedSession(chart.api, {
  ...transport,
  maxBars: 100000,
  maxBufferedEvents: 128,
  onState: state => renderConnectionState(state),
});
await feed.connect();
// User action: await feed.connect() to resnapshot after an error.
// Owner ends: feed.dispose(); chart.destroy({disposeModel: true});
```

Transport URLs and credentials are app configuration; never paste production credentials into the example or a bug report. For WebSocket APIs, replace `subscribe` with an adapter returning `{ready, close}` and invoking `onEvent`/`onClose`; open readiness, sequence mapping and reconnect behavior are provider-specific. Supply a snapshot timeout and retry policy in your host transport if required. The session always accepts owner cancellation; it does not invent retry timing or a freshness rule.

## Data semantics across SDKs

| Meaning | Web | Swift | Android |
| --- | --- | --- | --- |
| Initial history | `api.setData(bars)` / `setColumns` | `engine.setBars(bars)` | `engine.setBars(bars)` |
| Replace current candle | `applyDataEvent({kind:'update', bar})` | `engine.apply(.update(bar))` | `engine.apply(DataEvent.update(bar))` |
| Append later candle | `applyDataEvent({kind:'append', bar})` | `engine.apply(.append(bar))` | `engine.apply(DataEvent.append(bar))` |
| Correct an existing timestamp | `applyDataEvent({kind:'correction', bar})` | `engine.apply(.correction(bar))` | `engine.apply(DataEvent.correction(bar))` |

All SDK inputs use UTC epoch **milliseconds**, finite OHLCV and increasing source timestamps. An update replaces cumulative volume; do not add the same cumulative snapshot repeatedly. A correction cannot create an absent bar. Unknown gaps, sorting, deduplication, calendar conversion and price rounding are not supplied automatically. Native apps should implement the same host ordering/cancellation policy using their networking stack; the browser recipe is not a Swift/Kotlin networking library.

## Failure and resource boundaries

Snapshot/bootstrap validation happens before publication. A live SDK call can commit and then report an observer/notification failure; an error does not prove rollback. Inspect the accepted source and reconnect with a new snapshot instead of replaying an uncertain write. Do not mutate raw source columns or chart internals; source-version guards cover public managed writes.

The bar count and pending-event budgets do not bound total process memory, renderer allocations or network buffers. Parsing/allocation and detached bootstrap staging are synchronous; run large host preprocessing outside latency-sensitive UI handlers. This reference does not persist a feed cursor, pending queue or credentials in workspace files. If the UI edits source data while connected, the session stops rather than overwriting it.

## Reproduce the checks

```sh
node --test test/feed-session.test.mjs test/feed-transport.test.mjs
```

Tests use the real ChartAPI/BarStore and actual loopback HTTP/SSE. They cover snapshot/live overlap, producer object reuse, updates, appends, corrections, duplicate/gap, buffer overflow, invalid snapshots, stale source, reconnect generations, cancellation, close ownership and byte-budget cancellation. Browser checks exercise the actual fetch/EventSource adapter and controls separately.
