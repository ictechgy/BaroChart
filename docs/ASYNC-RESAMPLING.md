# Cancellable worker resampling (first async calculation slice)

`resampleOHLCVAsync(source, options)` is exported from the package root and
`/worker`. It runs calculation in a dedicated bundled Web module Worker, with
bounded owner-side capture and result-validation chunks. It is not a Promise
wrapper around synchronous resampling. The synchronous `/core` API remains
available and has a different input shape.

## Explicit input ownership

- `{kind:'store',store:barStore}`: captures a real `BarStore`'s columns, length
  and version. Managed changes during copying, calculation, validation or final
  cleanup reject with `StaleSourceError`. Store identity/version/data are not
  changed by this API. Direct writes to store columns bypass managed versions
  and are unsupported while the job is active.
- `{kind:'immutable-columns',columns,length}`: caller must keep all source
  columns unchanged until the promise settles. A chunked copy is not an atomic
  call-time snapshot. The SDK cannot detect arbitrary writes to bare arrays.

Neither mode detaches caller buffers. The operation copies logical-length
Float64 columns, including nonzero-offset views, and transfers only its own
buffers. SharedArrayBuffer inputs are rejected. The returned result owns clean
buffers and does not install itself into any chart. The caller must associate
results with its current request and handle source staleness. Continuous managed
streaming can repeatedly invalidate a store-mode job; there is no automatic or
infinite retry.

Options retain the synchronous API's required source/target intervals,
`calendar`, `kinds`, `asOf` and `partialTarget`. They also accept `signal`,
`timeoutMs` (default30000, maximum120000), `onProgress`, and an optional trusted
`workerFactory(url)` adapter. The default is a Web module Worker. Node does not
receive a new built-in adapter in this release; test helpers use actual
`worker_threads`. The injected adapter must implement Worker-compatible clone /
transfer, message, error and termination behavior. It is trusted host code, not
an untrusted worker sandbox.

The calendar/provider and options must remain consistent for the job's
lifetime. Provider callbacks are invoked only in the owner context, once for
each consulted date, and are converted to bounded UTC session records. They are
not serialized or evaluated in the worker. The original calendar cache is not
changed. This uses the base SessionCalendar provider/clock semantics, not custom
subclass `sessions`/`at` overrides. Consulted range includes adjacent dates,
is bounded to4096 calendar dates (four-digit ISO years),64 segments/date and
16384 total segments. A conservative2MiB escaped UTF-8 plan budget is checked
incrementally before constructing a large serialized string; no giant
JSON/TextEncoder intermediate is used. Clock strings are HH:mm or HH:mm:ss.

## Cancellation, deadline and publication

A pre-aborted signal rejects before source getters, provider calls or Worker
creation. The monotonic deadline covers capture, worker work, validation and
final cleanup. Abort/deadline/source checks run before and after every cooperative
checkpoint, including checkpoints that do not wait for a timer, and immediately
before returning a result. Cheap owner-side units share a nominal1ms work slice,
with a forced macrotask after at most8 units even on a coarse clock. A unit remains
a bounded copy/validation chunk or one calendar date. This amortizes timer
scheduling rather than enlarging chunks; the1ms threshold is checked between
units, not a hard per-task latency limit. Fewer than8 cheap units may finish
without an initial/final macrotask when the slice stays below1ms; an abort queued
for a later timer is not guaranteed to run before that short work completes. Dedicated Worker termination is requested
on success, cancellation, timeout and failure. Promise-returning adapter
termination is awaited before the final guard. Timers, listeners and logical
reservations are released once; late packets/errors cannot publish another
result. Cancellation after final publication does not revoke a returned result.

Progress phases are `snapshot`, `calendar`, `compute`, and `validate`.
`compute` reports request/response boundaries, not per-row worker progress.
Progress callback exceptions are ignored; cancellation or source changes made
by a callback are still checked. One provider/callback call, buffer allocation,
GC pause or adapter termination cannot be forcibly preempted on the owner
thread. This is not a hard real-time deadline or zero-main-thread-work promise.

`AbortError`, `TimeoutError`, and `StaleSourceError` have distinct `name` values.
Other validation/worker/cleanup failures reject normally. The existing
synchronous price, coverage, empty-target, future-row validation, availability
and revision limitations in [RESAMPLING.md](RESAMPLING.md) still apply.

## Admission and transport boundary

At most2 jobs are admitted, with512MiB total logical reservation. A job reserves
`252 * sourceLength + 4MiB`, capped at256MiB, before large allocations or calendar
capture. This conservatively covers source copy48N, worker snapshot48N, retained
owner timestamps8N, result74N and clean validation copy74N, plus two bounded plan /
protocol allowances. It can reject inputs accepted by synchronous resampling.
The current formula admits at most1,048,576 source rows per job. These are typed/serialized bookkeeping limits, not a whole-process RSS or
arbitrary trusted-provider/Worker-factory allocation guarantee. Worker runtime,
JS-object overhead, allocations/GC and caller-owned inputs are separate.

Packets bind job id, kind, protocol, source length, intervals, asOf and partial
policy. Validation rejects accessors, wrong intrinsic typed kinds/lengths,
shared or aliased/overlapping buffers, oversized backing buffers, nonfinite
OHLCV, invalid envelopes, and inconsistent source ranges/target times/coverage /
confirmation. Retained source timestamps and captured UTC sessions reconstruct
required target groups, including omission policy. Confirmed availability must
be target close at or before asOf; incomplete availability is NaN. This checks
structure and request consistency. It does not authenticate a worker's numeric
arithmetic, provider finality, receipt timing, or historical revision availability.

## Example and current execution scope

`examples/resampling-async.mjs` returns `{promise,cancel}` from
`startFiveMinuteResample(store,calendar,asOf,options)`. Retain the job, call its
cancel method on teardown/newer requests, and handle errors before choosing
whether to install a still-current result. Abort is not an implicit data reset.

Actual Node worker_threads tests exercise separate-thread calculation,
cancellation and cleanup. Browser Worker bundling/device execution and new
Swift/Java async support are not certified here. Existing native prepare
mechanisms are unchanged. Entry-only async indicator parameter publication is a
separate API described in [ASYNC-INDICATOR-PARAMS.md](ASYNC-INDICATOR-PARAMS.md).

## Measured tradeoff, not a throughput win

2026-10-13, Node24.19.0, Linux x86_64/Xeon Platinum8573C. Twenty sequential fresh
processes, five samples per mode/size, with sync/async order alternated. The
fixture is identical synthetic UTC24-hour one-minute→five-minute OHLCV. Owner
code warms on5000 rows; async mode also runs one unmeasured job, but each measured
Worker starts fresh. No concurrent own tests/builds/benchmarks. Reproduce with
`node benchmarks/resampling-async.mjs async 1000000 1` (or `sync`). Raw records,
source hashes and manifest are in `benchmarks/results/cycle20-node-async-resampling/`
in the evidence archive. These results use a different harness/warmup from the
initial synchronous-only cost report; do not mix those timing populations.

|Rows|Sync total median (range), ms|Async total median (range), ms|Sync run-max timer gap median|Async run-max timer gap median (range)|Async p95 gap median|
|---|---:|---:|---:|---:|---:|
|100k|92.43 (91.76..98.08)|294.36 (285.53..342.19)|92.70ms|18.89ms (17.53..40.61)|2.72ms|
|1m|658.19 (532.59..681.47)|1823.43 (1714.22..1940.30)|658.50ms|38.25ms (17.39..47.71)|2.80ms|

Async completion is about3.18×/2.77× slower in these fixtures. The intended gain
is allowing the owner event loop to run between bounded pieces, not faster total
completion. A2ms Node timer is only an event-loop proxy; scheduling and GC affect
it. The observed worst async gaps40.61/47.71ms are not zero stalls and do not
establish browser responsiveness, frame rate, mobile performance or a latency SLA.

Async phase-wall medians for100k/1m: setup0.14/0.14ms; snapshot plus calendar-range
setup21.79/197.50ms; calendar including per-date yields86.30/845.07ms; Worker
startup/transfer/compute roundtrip135.73/566.03ms; result validation plus awaited
termination47.97/226.00ms. Phase medians need not sum to total median. Actual
Worker synchronous calculation plus response posting is70.04/493.46ms median,
excluding startup. Synthetic provider callback CPU is recorded separately in
raw files; timezone resolution and deliberate scheduling waits are in the
calendar phase. Per-date yielding is a substantial scheduling cost, especially
at1m, and is a candidate for a separately measured optimization without weakening
cancellation or worsening owner gaps.

Logical reservation is29,394,304/256,194,304bytes, while owned returned typed
results are1,480,000/14,800,000bytes. Process memory snapshots are not peaks or
complete attribution of Worker memory. All20 samples match every OHLCV field,
source bound, time/availability and flag oracle; source digests match both modes,
caller buffers remain attached, Workers terminate and logical counters return
to baseline. These finite runs do not prove long-term leak freedom.


Validation total:77new tests (36 actual-thread lifecycle/example and41 packet /
resource cases);1393combined tests, zero failures/skips;335ESM; strict
TypeScript5.9.3; offline npm consumers and evidence manifests. Baseline-red is
module absence, not77 individually executed failures. Trusted progress callback
throws/reentrant abort and final source checks after termination are explicitly
covered. Existing44synchronous resampling regressions still pass.

## Cooperative scheduling follow-up

The owner checkpoint now batches cheap units using the1ms/eight-unit policy
above, while copy and temporal-validation chunks shrink from65536 to16384 rows.
The numeric worker, protocol, budgets, source guards and result oracle are
unchanged. Progress event counts are implementation details and may increase.

Two separately preserved experiments use the exact same cycle20 harness and
fixture: five fresh-process baseline/candidate pairs per size, alternating order,
with no concurrent own builds/tests. Baseline is commit `db080f3`. The first
experiment changes only scheduling; it reduces1m median wall1762.78→924.02ms,
but p95 timer gap2.82→3.89ms and100k run-max gap17.77→18.10ms. It is not the
selected implementation. The smaller-chunk candidate gives up some of that
throughput gain to reduce long owner-side units. Raw JSON, source hashes, patches,
runner and SHA manifests preserve both experiments in
`cycle21-node-cooperative-scheduling/` and
`cycle21-node-fine-cooperative-scheduling/` under evidence `benchmarks/results/`.
Do not mix samples between experiments or with the original sync comparison.

Selected candidate, same Node/Linux scope, five samples per cell:

|Rows|Baseline async wall median (range), ms|Candidate async wall median (range), ms|Baseline run-max gap median (range), ms|Candidate run-max gap median (range), ms|Baseline→candidate p95 gap median, ms|
|---|---:|---:|---:|---:|---:|
|100k|284.62 (277.99..310.48)|203.77 (193.33..225.37)|18.03 (17.05..20.13)|6.82 (6.25..7.65)|2.72→3.27|
|1m|1732.88 (1653.67..2296.25)|1011.80 (981.12..1281.83)|33.75 (27.71..161.99)|10.32 (8.94..53.64)|2.93→3.01|

Wall medians improve28.4%/41.6%, while p95 gaps are slightly worse. Fewer idle
timer waits change the gap sample distribution; this does not excuse hiding the
regression. Run-max medians improve, but the observed53.64ms candidate outlier
remains. A1ms cooperative target is not a blocking-time limit or browser SLA.

Phase-wall medians for100k/1m, baseline→candidate: snapshot/calendar-range
setup22.12→16.61 /166.41→126.49ms; calendar+yields87.69→16.35 /
855.11→145.13ms; Worker roundtrip131.00→128.55 /507.89→514.99ms;
validation+termination46.77→40.70 /219.51→231.47ms. The1m validation phase
is slower despite smaller individual units. Core worker computation is unchanged;
this is an owner scheduling tradeoff, not faster arithmetic. Phase medians do
not add exactly to total medians. Every output field and metadata value still
matches the fixed-slot oracle, caller buffers stay attached, and worker/job
counters return to baseline. RSS samples remain non-peak observations.
