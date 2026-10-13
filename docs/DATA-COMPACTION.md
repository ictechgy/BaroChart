# Explicit retained-window compaction

`api.compactData({keepLastBars: 50000, studyHistory: 'restart', maxPeakStoreBytes: 30_000_000})`
keeps the newest exact OHLCV suffix in the **same BarStore**. This is a synchronous,
host-triggered operation, not automatic eviction. No scheduling, network backpressure,
or full-chart memory limit is implied. Long copies/index construction can block the
calling thread; no async wrapper is supplied in this slice.

## Required semantics

- `keepLastBars` is a positive safe integer at most 4,194,304; `studyHistory` must
  explicitly be `'restart'`. Unknown options/accessors are rejected. Empty stores
  are rejected. If keep >= length, valid options yield a no-op: no source allocation,
  notification, version change, cache reset or invalidation. Shared owners and implicit
  percent panels are therefore allowed for a no-op. `pendingData` defaults to `'reject'`
  and may explicitly be `'preserve-retained'`. A no-op does not validate/certify pending
  payload or rebind its source version, even when that option is supplied.
- A real trim copies all six Float64 columns without rounding or changing signed zero.
  Capacity becomes the next power of two, minimum16. SourceIndex/asOfIndex are rebased
  current-window indices, not persistent row identifiers. Use time+version externally.
- Every study restarts against that suffix, including hidden/unbound studies. No factory,
  create, step, snapshot, restore or validator is called by compaction. Existing output
  arrays and series indices are unlinked immediately; checkpoints are cleared. The next
  explicit query/render may synchronously recalculate and may fail under its usual rules.
  Borrowed old output arrays are not overwritten. A suspended calculation/async result
  for the old source becomes stale.
- Restart results match a fresh study over the retained data, **not** the tail of a
  study over all original history. EMA/RSI/ATR seed and warm-up restart; OBV/ADL cumulative
  bases restart. Session/anchored VWAP and pivots see only retained observations, including
  a possibly partial first session. No old prefix state or evicted correction is retained.
  Definitions/params remain installed; a custom definition must provide fresh deterministic
  state from create for this oracle to apply. Arbitrary host state captured by trusted
  custom callbacks is neither reset nor certified by compaction.

## Admission and ownership

Actual compaction requires exactly one live ChartModel and its IndicatorEngine registered
against the store. A second model or standalone IndicatorEngine blocks it until disposed.
The package-private token ledger does not infer ownership from subscriber counts. Register
occurs after successful construction, unregister in dispose finally; undisposed ownership
conservatively blocks. Arbitrary external store observers remain host-controlled.

No external position-aligned `series.values`, active drawing transaction or controller
gesture is accepted. Percent panels require an explicit nonzero base (independent percent
axes already require one). A configured ingestion session must be paused, idle and
unleased; a model async ingestion fence also blocks. By default it must also be empty.
Without a configured session this part of admission is unnecessary. Queued data is never
discarded implicitly.

The usual empty-queue cycle is: stop producer → drain while active → pause → compact →
resume → restart producer. Trigger before hard-cap rejection where possible.

### Explicitly preserve accepted pending data

`pendingData: 'preserve-retained'` lets a paused session retain its accepted FIFO while
source history is compacted. This is useful when a drain has already failed at its stored
row/capacity limit. It requires the session's original `sourceVersion` to still match the
store: changing the source outside ingestion while data is pending is rejected, not
silently rebound. Normal exclusive ownership and other compaction constraints still apply.

All queued events are checked in FIFO order against the retained timestamps and a virtual
tail. An append must be later than that tail; an update must exactly match it. A correction
must target an exact retained source timestamp or a timestamp appended **earlier** in the
same pending FIFO. Repeated corrections and append→update/correction are allowed. A
correction to an evicted/nonexistent timestamp, including a not-yet-appended future target,
rejects the entire compaction before publication. There is no implicit upsert.

Ring buffers, physical head/count, event kind, Float64 values (including signed zero), FIFO
order, sequence cursors, policy, counters, paused state and the existing error diagnostic
are preserved. Only `sourceVersion` is rebound and `epoch` advances at the compaction
commit, before observers run. No queued event is applied or cancelled by compaction.
Observers may explicitly resume/drain and see that complete new binding; their errors
still use the normal bounded listener error channel. Resume clears the prior diagnostic
under its existing contract.

```js
// Producer is stopped; the session is configured with maxBatchEvents >= 8.
// Choose keepLastBars against the actual stored-row and capacity-byte budgets.
api.pauseDataIngestion();
api.compactData({
  keepLastBars: 32,
  studyHistory: 'restart',
  pendingData: 'preserve-retained',
});
api.resumeDataIngestion();
api.drainDataEvents(8); // bounded prefix; host schedules remaining work explicitly
```

Preservation approval is **not** a promise that every later drain will succeed. Enqueue
acceptance is not full-transaction validation. Existing drains still enforce intermediate
volume arithmetic, `maxStoredBars`, power-of-two capacity and `maxStoreBytes`. Even when
`keep + appended` fits a row budget, the rounded capacity may exceed the byte budget.
Small `maxEvents` drains followed by explicit pause/compact/resume cycles can make progress
when a whole prefix would not fit. However, a later queued correction may require an old
retained bar and prevent further trimming; the host then needs sufficient admission budget
or an explicit cancellation/reload policy. No automatic retry, cancellation, eviction or
budget expansion is performed.

## View, anchors and notifications

Follow=true keeps the old view span at the retained right edge (including forward offset).
Follow=false translates by removed rows and clamps against remaining data without enabling
follow. The screen-only `{x,y}` crosshair is cleared. Drawing time/raw-price anchors,
selection and undo/redo documents are unchanged, including anchors outside retained history.
Their prior screen projection is not guaranteed when neighboring historical bars disappear.
The keyboard explorer retains its timestamp selection or reports missing after eviction.

A successful mutation increments version and timeVersion once, then publishes one
`{kind:'compact',from:0,removed,studyHistory:'restart',version}` store event. Complete
source, cache, view and ingestion state is installed before public observers run. Existing
reset/fit listeners are not reused. Observers can read, append or compact again; the outer
receipt continues to describe its own commit, not later observer mutations.

API invalidation is attempted once after event publication. Store observer exceptions use
the existing bounded `listenerErrors`/`onListenerError` channel. An invalidation throw cannot
turn a committed compaction into a failure: the successful receipt sets
`invalidationFailed:true`. No original Error object is retained in the receipt. No-op
invalidation count is zero. This is an explicit contract of this new API, not a change to
older mutation APIs' observer behavior.

## Atomicity and resource boundary

Validation, source copy, RangeIndex creation, cleanup planning and final owner/version
checks precede publication. A precommit failure leaves old source, versions, view, caches,
drawings and ingestion state unchanged. Library-managed ordinary writable data fields are
required. Altered checkpoint Map subclasses/own cleanup properties and internal accessors
are rejected. NativeCheckpointMap clearing uses its private brand and captured package
operation, returns ledger bytes and keeps that bounded map reusable. Arbitrary replacement
of internal objects with Proxies/global intrinsic modification is unsupported.

Six source Float64 vectors cost 48×capacity; min/max/volume RangeIndex costs another
48×capacity. The logical source overlap is `96*(oldCapacity+newCapacity)` bytes.
`maxPeakStoreBytes` is checked **before** new source allocation, defaults to
805,306,368 bytes and may be lowered to any nonnegative safe integer. Any later extra
source staging copy must be included in that budget. No such extra copy is used here.
This excludes existing/retired study outputs, checkpoints, object graphs, rendering,
worker copies, external held views and GC/RSS. Pending preservation adds at most
`49 * pendingCount` temporary typed bytes (200,704 bytes at 4,096 events), plus bounded
queue-field guard objects and a set of at most 4,096 appended timestamps. These queue
validation allocations are separate from the source-only `maxPeakStoreBytes` budget;
the existing owned ring capacity is unchanged. Custom checkpoints remain subject to their
existing contracts, not a newly promised universal byte limit. Closed-over suspended
iterators can retain old arrays until the caller releases/resumes them.

The receipt reports removed/length/capacity/bytes/previousBytes/peakSourceBytes,
firstRetainedTime, version/timeVersion, studyHistory and invalidationFailed. Bytes may not
shrink if old/new length round to the same capacity; compaction still creates append
headroom. Repeated host high/low-water cycles can bound retained source capacity, not
all memory in the host process.

## Measured boundary and validation

Two isolated fresh Node24 processes per size, same custom single-output study, retained
one quarter of source rows. These are absolute maintenance costs, not a comparative
speedup benchmark or browser/native UI latency promise.

| source → retained rows | source typed bytes before → after | overlap budget | compaction | next explicit lazy read |
| --- | --- | --- | --- | --- |
| 100,000 →25,000 | 12MiB →3MiB | 15MiB | 65.8–67.0ms | 21.8–24.3ms |
| 1,000,000 →250,000 | 96MiB →24MiB | 120MiB | 264–323ms | 115–131ms |

Compaction invoked zero study callbacks. The former 1MiB/8MiB study vectors, 391/3907
checkpoints and series index were unlinked before lazy reading. The benchmark did not
measure collection, RSS or host-held references. Twelve smaller high/low-water cycles
asserted capacity 256→128→256 and immediate derived-cache retirement each time. A large
compaction is unsuitable as invisible per-tick UI work; schedule explicit maintenance
with these synchronous costs in mind. No worker compaction API is supplied here.

The independent all-34 builtin fresh-suffix oracle includes append/update/correction,
NaN/−0, hidden/unbound studies, tiny-price and zero-volume conditions; scalar examples
explicitly show the intended difference from full-history EMA/OBV/ADL/VWAP/pivots.
Actual standalone Linux QuickJS ran 11 fixed nativeCommand scenarios using the existing
verified binary and updated JS bundle. Runtime/OOM/interrupt cleanup returned zero live
requested bytes and allocation counts. Swift/Java dedicated facade methods, Android JNI,
Apple JSC, native SDK/device and real browser behavior are not verified by this result.


## Native facade and validation boundary

Swift `engine.compactData(options)` and Java `engine.compactData(JSONObject)` forward
this same synchronous operation on the original owner thread. They do not launch workers
or evict in the background. A real trim produces one host revision/change notification;
a valid no-op produces none. The native deferred async begin gap is gated BUSY, including
workspace cleanup ownership that has not yet been released. Existing wrong-thread/closed
checks and host observer diagnostic behavior remain in force.

Use the same explicit pause/drain/maintenance/resume sequence. The 264–323ms Node cost
above does not predict JSC/JNI/device latency and is not suitable as per-frame work.

A source mutation can already be committed when JSON/JSC transport, allocation or receipt
conversion fails. Such an exception does **not** prove rollback. Do not blindly retry;
inspect the live source/version or re-establish the host dataset binding. This inherited
native bridge limitation also applies to raw common command calls. Host ordinary observer
errors use existing diagnostics; fatal runtime failures are not transactional rollback.

Current new-facade coverage is source assertions and Java compilation against test-only
Android/org.json signatures. A small production nested Java decoder can run without
initializing the JNI-backed Engine; this proves only receipt classification. Swift
compilation, JSC/ARC execution, JNI/Android SDK, owner-thread scheduling and actual native
notifications still require the corresponding real platform validation.

Native facade validation checkpoint:10 source-contract tests and8 decoder guard tests
passed. Actual Java compiler-module execution passed58 decoder scenarios/92 assertions,
with35 Java8 class outputs and zero compiler diagnostics; a separate public API consumer
compile also passed. The raw class-initialization trace/stdout is retained. The complete
Node suite was2551/2552, with one unchanged CLI dry-run15-second watchdog failure;
its unchanged test file then passed131/131 in isolation. This is not a fully passing
aggregate run. Syntax418, TypeScript and package/evidence checks passed; no timing
limit or assertion was changed to obtain a pass.

### Pending FIFO recovery probe (Node, 2026-10-13)

`node benchmarks/pending-compaction.mjs` reproduces a failed drain at a 64-row cap,
then preserves 4,096 accepted appends through 128 explicit 32-event drain/compaction
cycles. Three serial fresh Node 24.19.0 Linux x64 processes all reached the exact
64-row suffix, including signed zero, with accepted=applied=4,096, cancelled=0,
unchanged store/ring identity and zero study create/step/snapshot/restore callbacks.
Source-owned bytes remained 6,144 (source overlap peak9,216); the existing ring stayed
200,704 bytes. The temporary queue snapshot was at most 200,704 bytes. Cleanup released
listeners and the ingestion ring. These are logical owned-byte counts, not process RSS.

| Fresh process | Entire 128-cycle loop ms | Largest individual compaction ms |
|---|---:|---:|
| 1 | 596.557 | 26.519 |
| 2 | 582.541 | 175.875 |
| 3 | 980.928 | 55.777 |

Every compaction revalidates the entire **remaining** FIFO: this probe examined 264,192
pending events in total. Very small drain prefixes therefore repeat work; the queue is
bounded, but this is not a constant-cost operation. The outlier's cause was not determined.
Do not copy this tight benchmark loop into UI event handlers. Schedule bounded host work,
choose sufficient headroom and account for the synchronous copy/index/validation cost.
Even a single call has no hard latency guarantee. These samples demonstrate successful
bounded-cap recovery, not a speedup, renderer performance or mobile/browser responsiveness.

The generated native bundle also runs four fixed pending-compaction scenarios in a bare
Node VM and real standalone Linux QuickJS, including `nativeCommand` cap recovery,
evicted/future correction rejection and cleanup. QuickJS normal/OOM/interrupt fixtures
ended with zero live requested bytes and allocations. This does not establish Android
JNI/SDK, Apple JavaScriptCore/Swift or actual UI-thread behavior.

This pending-data slice passed 2,621/2,621 serial Node tests, 359 ESM syntax checks,
strict TypeScript 5.9.3 and offline installed-package checks. Package verification used
an explicit output path with an existing parent directory; fresh-clone creation of its
default `artifacts/` output directory is a separate known tooling fix. The dedicated
pending suite has 66 tests, with baseline rejection/green evidence and independent review.
