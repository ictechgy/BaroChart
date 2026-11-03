# Migrating from TradingView Lightweight Charts

This guide covers **Lightweight Charts 5.2.1**, the open source browser charting library. It does not describe TradingView Advanced Charts, Trading Platform, broker integrations, or Pine Script. BaroChart is a separate project and does not provide drop-in API compatibility with Lightweight Charts.

The converter and runnable page are [lightweight-migration.mjs](../examples/web/lightweight-migration.mjs) and [lightweight-migration.html](../examples/web/lightweight-migration.html). Start the local server with `npm run demo` and open `http://127.0.0.1:5173/examples/web/lightweight-migration.html`.

## Convert data explicitly

Lightweight Charts `UTCTimestamp` values are Unix seconds. BaroChart bars use exact UTC Unix milliseconds. The helper `lightweightSecondsToMilliseconds` accepts only safe integer seconds whose millisecond result is also a safe integer in the JavaScript Date range. It preserves JavaScript negative zero through the multiplication. It intentionally rejects date strings and `BusinessDay` objects: a session date needs a caller-chosen exchange timezone, calendar, and session-open policy before it can become an instant.

```js
import { BarStore, ChartModel, createChart } from '../../src/index.mjs';
import { lightweightBarsToBaro } from './lightweight-migration.mjs';

const bars = lightweightBarsToBaro(lightweightRows);
const store = new BarStore(bars);
const model = new ChartModel({ store });
model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
model.fit();
const chart = createChart(document.querySelector('#chart'), model);
```

Each row must have finite `open`, `high`, `low`, and `close` values with a valid OHLC envelope. BaroChart's data model is OHLCV, while a Lightweight Charts candlestick row is usually OHLC. The helper does not invent volume: provide a `volume` field or an explicit policy such as `lightweightBarsToBaro(rows, { volumeForBar: row => volumeByTime.get(row.time) ?? 0 })`. A zero policy is a deliberate statement that absent volume means zero; it is not an inferred market value. Volume must be finite and nonnegative. Converted arrays must be strictly chronological.

For line data, map `{time, value}` to the BaroChart series/data representation intentionally; this candle converter does not translate whitespace points or other Lightweight Charts series shapes. Do not pass price values through timestamp conversion.

## Streaming, appending, and corrections

`applyLightweightBar(store, row)` converts one numeric-time row, then appends a later timestamp, updates the last timestamp, or corrects an existing earlier timestamp. An unknown timestamp before the current end is rejected instead of inserted into an ordered store. For example:

```js
import { applyLightweightBar } from './lightweight-migration.mjs';

feed.subscribe(row => {
  // row must include volume, or supply { volumeForBar } explicitly.
  applyLightweightBar(store, row);
});
```

Lightweight Charts `series.update(bar, historicalUpdate)` exposes its own update policy; BaroChart uses the timestamp in its host-owned `BarStore`. This helper's timestamp routing chooses append, update, or correction; it does **not** establish event freshness. A late event for an existing timestamp still routes to that row. Use the provider's sequence, revision, or watermark protocol to decide whether an event is current. See [feed ordering, watermark and reconnect guidance](FEED-INTEGRATION.md#required-provider-contract). If an upstream correction identifies an existing time, it updates that row. A genuinely new older bar changes ordering and should be applied by replacing/reloading the ordered history, not by pretending it is an append. The BarStore notification updates its model and renderer; the host remains responsible for feed subscriptions, retries, and persistence.

If a feed/ingestion owner is coordinating writes to this same BarStore, send events through that owner or coordinate exclusive writes with it. Direct BarStore writes must not race its sequence checks, source-version guards, or reconnect lifecycle. See [feed session ownership](FEED-INTEGRATION.md#session-lifecycle).

## Ownership and saved state

Keep one host-owned `BarStore` for the exact dataset and give it to `ChartModel`. Keep the corresponding provider, venue, symbol, timeframe, session/calendar and adjustment identity in your application state. When saving a portable workspace, use an explicit dataset binding and verify it on restore; a workspace saves chart configuration, not source bars or a fingerprint of their contents. See [workspace identity and restore contract](WORKSPACES.md#dataset-identity-is-explicit-not-a-fingerprint).

When a chart owns its model, dispose it on final teardown with `chart.destroy({ disposeModel: true })` and unsubscribe host feed/timer handlers. If multiple charts share a model, dispose the model only at the final owner. The runnable page handles normal teardown and back/forward-cache restoration; its example feed is synthetic and local.

## Scope to plan separately

This conversion covers a numeric-time candlestick feed and basic append/update/correction. It does not recreate Lightweight Charts plugins, custom series, markers, price lines, panes, price-scale behavior, localized formatters, or drawing interactions. Map each needed feature to BaroChart's documented API and decide its visual/behavioral contract in the host app. Do not infer a timezone from a date-only string or silently treat a missing volume field as trading volume.

Lightweight Charts 5.2.1's pinned source and third-party notices are under [`benchmarks/vendor`](../benchmarks/vendor/README.lightweight-charts.md); its Apache-2.0 notice is in [`NOTICE.lightweight-charts`](../benchmarks/vendor/NOTICE.lightweight-charts).
