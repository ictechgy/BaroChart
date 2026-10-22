# Bounded queued-streaming lifecycle composition

`benchmarks/streaming-lifecycle.mjs` exports `runStreamingLifecycle`. Importing it
runs nothing. It is a deterministic synchronous Node correctness harness, despite
its directory: it does not measure throughput, latency, wall-clock endurance,
heap collection, GPU or browser behavior.

```sh
node --input-type=module -e "import {runStreamingLifecycle} from './benchmarks/streaming-lifecycle.mjs'; console.log(JSON.stringify(runStreamingLifecycle({charts:4, shared:false, rounds:4096, seed:42})))"
```

The harness bounds charts to 1–8 and rounds to 128–8192. Ordinary regression tests
use four charts, 256 rounds, independent/shared models and seeds 42 and 2026.
A fifth test rejects out-of-bounds configuration before touching globals.

## What this adds

Earlier coverage separately exercised short queue transactions, mixed source
updates and short chart remount sequences. This harness composes those lifetimes:

- Actual `DataIngestion`, `ChartModel`, `CanvasChart`, scene cache and controller
  construction run under modeled DOM and queued RAF with a non-raster renderer.
- A seven-event FIFO with drain limits of three repeatedly wraps. Random packets
  contain ordered append, update and correction events. Caller rows are changed
  after enqueue to exercise ownership. Partial drains have exact publication and
  sequence-receipt assertions.
- Queue-budget rejection and pause/rejection/resume mix with cancellation. An
  independent ledger checks accepted/applied/cancelled counts and sequence
  conservation after each operation.
- Every 127 rounds, the live ingestion document is saved, charts and their model
  are disposed, and the source plus document are restored into a fresh model.
  Pending events and cursors survive; the old session releases its typed ring.
- Charts repeatedly unmount while frames are pending, then mount again. Source
  listeners, event-handler bookkeeping, renderer disposal calls, scene-cache references, canvas
  dimensions and pending RAF counts are checked after teardown. Shared models
  intentionally share view and data; this does not test independent shared-model
  viewports or synchronized-group capacity.
- Every 16 rounds, an unchanged hover-only invalidation must reuse the identical
  base scene, keep base/drawing rebuild flags false and preserve command values.
  A separate scalar check asserts the expected following 31-bar viewport.
- Every 32 rounds and at endpoints, complete OHLCV values are compared with a
  separate ordered-event oracle. A scalar EMA5 recurrence supplies an independent
  formula check with relative tolerance; a fresh implementation also checks exact
  indicator outputs and scene commands. Scalar scans check range extrema/counts.

The default initial history is 31 bars, growing only through accepted and drained
appends. This specifically crosses repeated small-capacity boundaries, not the
large-series 65,536-row index-policy boundary already covered elsewhere.

## 2026-10-17 bounded pilot

Eight serial runs combined 4/8 charts, independent/shared models and seeds
42/2026, with 4,096 rounds each. All passed. Source and harness SHA-256 values
matched before and after the run.

Across the eight runs:

- 114,688 candidate packets; 233,675 accepted events, of which 214,489 were applied
  and 19,186 explicitly cancelled
- 28,588 FIFO wraps, 14,871 queue-budget rejections and 3,724 paused rejections
- 896 save/restores, all carrying pending events
- 17,964 chart constructions/destructions and 924 stream-owning model lifecycles;
  fresh comparison models are additional and separately disposed
- 203,215 non-raster render callbacks and 12,288 verified base-cache reuse frames, 35,094,010 OHLCV/EMA value checks and 7,280
  scalar range checks; the largest resulting history contained 2,795 bars

All owned chart/model counters balanced and pending RAF counts returned to zero.
Destroyed chart references were deliberately retained and inspected, so this
cannot establish that garbage collection released them. There is no heap, RSS,
GPU memory, real timer, live provider, actual network, browser pixel, native SDK,
device or assistive-technology result here. The run is operation-count bounded;
it is not a multi-minute duration qualification or a performance comparison.
Two temporary in-process negative controls deliberately corrupt an owned queue
close value or falsely report a cache rebuild. Both trigger the harness assertions;
prototypes and globals are restored afterward. Independent review found no blocker.
No production defect was found and no production module was changed.
