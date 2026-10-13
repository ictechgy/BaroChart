# Entry-only async indicator parameter editing

First web/JavaScript async slice. Existing synchronous
`ChartAPI.setIndicatorParams` and its observer behavior remain unchanged.

## API and publication

Root and `/worker` function:
`setIndicatorParamsAsync(chartAPI, id, params, options)`.
Core stays DOM-free. Options reuse signal, total monotonic timeout, progress and
trusted Worker adapter. A real `ChartAPI`/model/BarStore is required. Pre-abort is
checked before reading chart/source properties or invoking a factory/Worker.
Full primitive params replacement retains Object.is equality (including -0).
Semantic no-op avoids Worker computation but follows the notification contract.

Only canonical builtins and versioned modules prelinked into both owner and
Worker bundles are accepted. No function-source serialization, dynamic import
URL supplied by market data, eval, or new sandbox is introduced. Module
id/version/stateVersion/exportName and factory identity are captured. Trusted
factory/codec code is different from untrusted source data and reply packets.

Snapshot captures managed store version, column identity, logical length and
capacity, original engine/maps, entries and registry identities, target entry,
series bindings and configuration. Bare direct column writes remain unsupported.
Any managed source or guarded configuration change rejects stale work; no retry.
The replacement must preserve exact ordered output schema and effective default
plot offsets, just like the synchronous API. Styles, axis/panel/drawing bindings,
viewport, store/index and other indicator entries remain untouched. Held old
output arrays and range indices are not mutated.

A dedicated Worker computes only the target entry from owned source copies.
Its reply contains outputs and encoded checkpoints, not a whole chart/store.
Owner-side validation creates a detached replacement with validated lazy
checkpoints. All metadata is constructed before publication. After Worker
termination/cleanup, a final source/factory/entry/configuration/deadline guard
precedes one synchronous entry replacement and dependent range-cache reset.
No user callback or await occurs inside the commit. Notification follows commit;
a later abort must not turn an already committed operation into rejection.

The job runner uses an internal synchronous publication hook executed
after awaited cleanup and final guards but before reservation release. Validation
and failure remain pre-commit. The hook is internal, not a caller callback API.

## Notification errors

Current synchronous ChartAPI.changed propagates invalidate exceptions after its
mutation. The new async function must not report a failed transaction after a
successful commit. Explicit async-only contract: invoke invalidate once
on success, zero times on pre-commit failure; capture a thrown notification as a
bounded `{name,message}` diagnostic in the resolved result and report it once to
optional `onObserverError`. A reporting callback's exception cannot change the
committed result. This is intentionally different from the existing synchronous
API, not a claim of existing observer-policy equivalence. No silent loss of the
diagnostic or automatic retry/duplicate notification.

## Concurrent requests

This first slice rejects a second active request for the same
model/id, rather than silently implementing first-completion-wins. Example:
cancel previous job, await its settlement/termination, then start latest params.
Different targets may run within global admission, but any other entry change
can conservatively stale a captured operation. Automatic latest-wins would need
explicit per-entry generations and previous Worker cleanup before replacement
admission; it must not bypass aggregate byte limits.

## Resources and validation targets

Reuse two-active-job, 512MiB aggregate and 256MiB per-job logical reservation,
shared with async resampling. Reserve before large allocations. The conservative reservation is `48*N + 16*C*O + 128MiB + 16*(K+1)`,
where N is logical source length, C is store capacity, O is target output count
and K is zero for empty input, otherwise floor(N/256)+1. Input snapshots use48N;
wire and clean capacity-sized outputs use16CO. The128MiB allowance covers up to
three32MiB encoded checkpoint streams/encoder parts plus bounded per-record
text/decoded-state transients and protocol metadata; indices/offsets are separate.
No decoded checkpoint history accumulates in the Worker: each fresh snapshot is
encoded immediately. Total encoded checkpoints are capped at32MiB and each
record at256KiB; checkpoint size is256. The existing depth32/node-count250000
codec validation remains, with one bounded record decoded at a time.
Large custom checkpoints can be rejected even when synchronous computation works.
Existing model outputs remain caller-owned but total engine output capacity must
still pass the ordinary output-byte policy. Trusted factory state/JS objects,
provider/codecs, runtime and GC are not a hard RSS bound. Do not claim all async
resampling row counts are admitted: output count/checkpoint size affect this job.

Packet checks: job id/kind/protocol, exact requested name/params/module/schema /
offsets/length/capacity/checkpoint size; intrinsic typed metadata and full-owned
nonshared, nonaliased buffers; finite-or-NaN outputs; tail policy; completed
revision/dirty ranges; checkpoint record count/index grid and codec validity.
Validate every checkpoint without retaining decoded history. Structural checks
do not authenticate arithmetic from an arbitrary hostile Worker implementation.
Copy/check/validate in cooperative chunks, with deadline/stale checks through
termination and final commit. No full-model hydrate/installRecomputed path.

Validation targets: preabort callback avoidance; every phase abort /
timeout/stale; wrong, duplicate, late and accessor replies; byte/admission limits;
no-op and -0; factory/module mutation; output-order/offset rejection; original
store/index/other entries/style/axis/drawing identity; held outputs; metadata
throw before commit; exactly-once publication/notification and diagnostic errors;
post-commit abort cannot reject; actual worker_threads and synchronous oracles;
subsequent append/update/historical correction versus full recalculation; repeated
cancellation resource baseline. Browser/Swift/Java execution remains unverified.

Measure matched synchronous/async total wall, snapshot/Worker/validation phases,
2ms Node timer gaps and logical bytes at representative sizes/output counts.
Do not infer browser latency or throughput improvement from the async label.


## Usage and limits

`examples/indicator-params-async.mjs` supplies a host-owned coordinator. Its
generation guard skips superseded queued requests, cancels active work, awaits
settlement, and never clears a newer controller from an older finally block.
Call dispose on unmount and handle every returned promise. This wrapper owns
latest-request behavior; the SDK itself does not implement implicit latest-wins.

Progress phases are snapshot/compute/validate; compute is request/response only.
Same-target work rejects BusyError, managed changes reject StaleSourceError, and
AbortError/TimeoutError distinguish cancellation/deadline. No-op metadata is
returned without a Worker; success still notifies once, matching the synchronous
facade. Notification diagnostics are available as result.observerError and via
onObserverError; name/message are bounded to64/256 characters without invoking
error accessors. Throwing onObserverError is isolated.

Configuration serialization and AbortSignal access can execute host callbacks.
They are evaluated before a final callback-free source/version/entry/panel/axis
identity guard. Commit contains no callback or await. Direct mutation of private
model/engine internals and raw column storage is unsupported. A provider, factory,
codec callback, one bounded parse, allocation or GC pause cannot be preempted;
there is no hard main-thread latency promise. Both runtime contexts must statically
link custom modules. A module descriptor does not transport executable code.

Actual Node worker_threads are tested; browser bundling, rendering and native
Swift/Java facades have not been executed or newly implemented here. Arithmetic
is trusted Worker/module execution, not authenticated by reply validation.

## Measured costs and responsiveness tradeoff

2026-10-13, Node24.19.0/Linux x86_64, Xeon Platinum8573C. Forty serial fresh
processes: five samples per mode/indicator/size, sync/async order alternating.
Seed42 OHLCV; each mode warms on5000 rows, measured Worker still starts fresh.
Source, old indicator and held-output copies are prepared before timing. Every
output/NaN and metadata matches a fresh synchronous engine after timing. Store /
index/column/version identities and held outputs remain unchanged, notification
runs once, workers terminate and job counters return to zero. There were no
concurrent own tests/builds. Reproduce with
`node benchmarks/indicator-params-async.mjs async ema 1000000 1`; substitute
sync/macd/100000 as needed. Forty raw records, hashes, runner and manifest are in
evidence `benchmarks/results/cycle22-node-async-params/`.

|Indicator/rows|Sync wall median (range), ms|Async wall median (range), ms|Sync→async run-max2ms timer gap median, ms|Async run-max gap range, ms|Async p95 gap median, ms|
|---|---:|---:|---:|---:|---:|
|EMA100k|10.30 (8.14..24.34)|271.09 (211.14..691.68)|10.49→6.80|3.15..239.28|3.02|
|EMA1m|84.51 (72.05..153.44)|1189.50 (1164.37..1219.93)|85.27→4.64|3.29..8.40|2.59|
|MACD100k|12.50 (10.78..23.75)|239.92 (235.88..355.27)|12.88→3.95|3.65..49.60|2.79|
|MACD1m|162.53 (134.15..179.98)|1297.19 (1255.35..1451.35)|162.76→5.82|4.98..6.35|2.65|

Async completion is slower in every measured condition, approximately14.1×/8.0×
for1m EMA/MACD. It must not be recommended as a throughput win or a blanket
replacement for cheap synchronous edits. Small100k synchronous calls here take
about10–13ms median, whereas async adds Worker startup, copy, checkpoint codec
and cooperative validation/termination costs. The100k EMA239.28ms and MACD49.60ms
async gap outliers are retained. These runs do not isolate scheduling, GC or host
noise as their cause. Node timers are a proxy, not browser frame latency or a
no-stall guarantee; no outlier was discarded.

Async phase medians for EMA100k/1m and MACD100k/1m respectively:
- Snapshot16.13/104.84 and14.22/108.75ms
- Worker startup/transfer/calculation/encoding roundtrip130.20/430.88 and138.67/490.29ms
- Checkpoint/output validation, termination and publication95.20/644.05 and90.96/715.04ms

The validation phase is an explicit future optimization target, but this first
slice keeps conservative per-record checks and bounded cooperative yields. Phase
medians do not sum exactly to wall medians. Logical reservations are141,121,152 /
199,057,472 bytes (EMA100k/1m),145,315,456 /232,611,904 bytes (MACD).
Encoded installed checkpoints are20,520 /204,934 and60,861 /608,521 bytes; the
conservative reservation is not actual retained size or peak RSS. Memory snapshots
are neither process peaks nor complete attribution of Worker/codec JS state.

## Bounded checkpoint batching follow-up

A diagnostic probe separates owner decode CPU from timer waits. Three fresh
instrumented1m runs per indicator/version inspect all3907 records. Baseline EMA /
MACD decode CPU medians36.28/55.24ms accompany approximately490/489 zero-delay
waits totaling560.78/552.08ms. The optimized params path uses the existing codec
batch mechanism with max32 records/nominal1ms, while a new internal owner hook
checks before and after every record, after progress callbacks, on yield return,
and before final return, including empty histories. Hook errors are never swallowed
with progress errors. Codec defaults32 records/4ms and synchronous validation are
unchanged. No state record, numeric codec check or source guard is omitted.
One256KiB record parse and trusted validation callback remain non-preemptible.

After batching, diagnostic wait-count medians45/60 total56.77/66.74ms. Decode CPU
medians24.00/45.98ms are diagnostic observations, not a claim that JSON parsing
itself was optimized; code/records are unchanged. Instrumentation affects timings.
Primary comparison below uses the unchanged, uninstrumented harness instead.

Fifty serialized matched fresh-process runs are preserved: initial five pairs per
EMA/MACD×100k/1m condition (40 runs), then five additional100k MACD pairs to check
an outlier (10 runs). Baseline commit is `ee43f58`. Pair order alternates; fixture,
warmup, full output/NaN oracle, ownership checks, checkpoint bytes and reservation
formula are identical. No concurrent own builds/tests. Raw records, both diagnostic
sets, implementation patch and SHA manifest are in
`benchmarks/results/cycle23-node-params-validation/` in the evidence archive.

Initial five-pair population, async baseline→candidate:

|Condition|Baseline wall median (range), ms|Candidate wall median (range), ms|Run-max2ms timer gap medians, ms|Baseline gap range, ms|Candidate gap range, ms|P95 gap medians, ms|
|---|---:|---:|---:|---:|---:|---:|
|EMA100k|230.99 (223.70..270.24)|171.03 (160.73..208.51)|4.46→3.37|3.61..5.35|2.90..6.05|2.87→2.70|
|EMA1m|1248.87 (1182.53..1330.42)|685.92 (667.88..860.52)|8.43→6.75|4.11..26.05|4.44..15.74|2.73→2.76|
|MACD100k|244.08 (225.83..289.44)|193.08 (190.11..436.49)|3.42→3.76|3.03..4.80|3.38..132.62|2.76→2.84|
|MACD1m|1351.84 (1302.95..1354.92)|874.98 (837.51..943.55)|5.34→5.85|3.86..7.50|4.75..6.78|2.65→2.95|

Wall medians improve26.0%/45.1% (EMA100k/1m),20.9%/35.3% (MACD).
Validation/termination/publication phase medians74.71→29.89 /686.34→148.35ms
(EMA),86.37→43.63 /726.06→261.78ms (MACD). Normal timer gaps are slightly
worse in MACD, so this is a bounded scheduling tradeoff, not a universal latency
win or a higher-precision computation shortcut.

The separate100k MACD confirmation population gives wall245.12→209.72ms,
run-max gap medians3.39→5.05ms, p952.87→3.02ms. Baseline gap range3.11..131.51ms,
candidate3.82..18.85ms. The large initial candidate outlier therefore cannot be
attributed solely to this patch, but its cause remains unidentified; all samples
are retained, and the ordinary gap regression remains disclosed. Do not pool or
silently discard populations to improve a headline. Browser/device behavior,
RSS peaks and a hard1ms latency bound have not been established.
