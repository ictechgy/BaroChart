# Manual ingestion queue example

Run `npm run demo` from the repository root and open
[the queue example](../examples/web/ingestion-queue.html) at
`http://127.0.0.1:5173/examples/web/ingestion-queue.html`.
This standalone example uses 32 synthetic minute bars, no provider connection,
no timers and no automatic retries. It exercises the existing
[ingestion contract](INGESTION.md); it does not change the engine API.

## Try the bounded workflow

1. Enqueue four times. Each packet contains two events: replacement of the
   virtual current bar's cumulative volume, then one append. Eight events are
   accepted but the source has not changed. A fifth packet is rejected whole.
2. Drain once: one event is applied. Retry Enqueue: two free slots are required,
   so it still rejects. Drain again, then retry: the exact retained packet and
   sequence can now be accepted. Successful admission alone advances the producer
   tail, including accepted appends that are still pending.
3. Pause, then try Enqueue or Drain. Accepted events remain queued. Resume does
   not apply them; a separate Drain is required.
4. With pending events, replace the source timeline. The session becomes stale.
   Resume only binds to the current source version and clears pause; it does not
   validate or discard the FIFO. The next Drain fails on the old timestamps.
   Cancel explicitly discards the pending events and the unaccepted offer, then
   rebuilds the producer tail from the source. It does not reuse accepted sequence
   numbers or clear pause. Resume and Enqueue explicitly to continue.

Counters distinguish events from packets, including rejected attempts, and show
`accepted = applied + cancelled + pendingEvents` after each action. Volume is a
cumulative snapshot replacement, never a sum of received snapshots. This example
has one producer and does not infer freshness from timestamps or arrival order.

The ring permits eight events / 392 payload bytes, with two events per packet.
The source permits 64 bars / 6,144 owned typed bytes. Draining an append beyond
that limit fails and retains the pending event; there is no automatic eviction.
Cancel explicitly, reload the example, or design host-owned retention using the
[separate compaction contract](DATA-COMPACTION.md). These limits exclude indicator,
renderer, caller and process memory. A failed response must not be assumed to undo
an already committed operation; inspect the counters and source before deciding
whether to retry.

## Lifecycle and validation scope

Native HTML buttons have explicit labels, and action results use a polite status
region. Controls are not removed or disabled after actions. A persisted pagehide
keeps the chart and queue for BFCache; pageshow resizes the existing chart. Final
pagehide removes handlers and disposes the model/chart. Returning action callbacks
check their live owner before writing UI.

Tests import the shipped module with real CanvasChart/core/queue code and fake
DOM/canvas primitives. They verify admission, exact retry, partial drain,
pause/cancel, source-stale recovery failure, event conservation and teardown.
This example has not been run in a real browser or with assistive technology;
there is no new execution screenshot or performance measurement.
