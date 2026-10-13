# Session-anchored OHLCV resampling (first slice)

`resampleOHLCV({columns,length}, {sourceIntervalMs,targetIntervalMs,calendar,kinds,asOf,partialTarget})` is a synchronous, DOM-free calculation API. Every option is required. Input uses the existing six `Float64Array` OHLCV columns with a logical length. Both intervals are positive exact integer milliseconds, at most one day; target must be a multiple of source. `kinds` explicitly selects one or more session kinds. Calendar is an injected `SessionCalendar`; no venue schedule is supplied or inferred.

Source timestamps label opens of half-open `[time,time+sourceIntervalMs)` intervals. Seconds, close-labelled timestamps and inclusive final-millisecond conventions must be normalized explicitly upstream. Source timestamps must be strictly increasing, aligned to the selected session's open, and wholly contained in one session and target. Outside-session bars, ambiguous overlapping selected sessions, off-grid bars and boundary-crossing bars are errors. Every row, including rows after `asOf`, is validated before filtering. Input columns and the original calendar/cache are unchanged; provider callbacks remain trusted host code.

Each target starts on a session-open grid. Lunch segments re-anchor independently. Its end is the lesser of nominal target end and session close. Source bars are never cropped or prorated. Only source bars whose close is at or before `asOf` participate. Complete means exact continuous source-slot coverage from target start to target end, including shortened terminal targets. A non-source-grid early close cannot be completely covered by fixed-width sources. Entirely empty targets are not synthesized.

`partialTarget` must be `reject`, `omit`, or `include-unconfirmed`; it governs populated incomplete targets, including leading, interior and trailing gaps. Output owns exact-length typed columns and metadata:

- `columns`, `length`, `sourceIntervalMs`, `targetIntervalMs`, `asOf`
- `endTime` and `availableAt`: Float64Array UTC milliseconds; unconfirmed availability is NaN
- `sourceFrom`, `sourceTo`: Uint32Array, half-open indices into the original input
- `complete`, `confirmed`: Uint8Array flags (0/1)

Confirmed means complete supplied coverage and target close <= event-time `asOf`. It does not certify provider finality. An omitted no-trade minute makes coverage incomplete. `availableAt` is theoretical close time, not receipt time. Without arrival/revision timestamps this API cannot guarantee point-in-time backtests; later historical corrections can change earlier confirmed values.

`alignConfirmedByTime(decisionTimes, values, timing)` explicitly carries the most recent confirmed value available at each decision timestamp. `timing` supplies `length,endTime,availableAt,complete,confirmed,asOf` from the result. Decision times are strictly increasing UTC integers; callers choose whether decisions happen at lower-bar opens or closes. Values are a Float64Array of finite numbers or NaN. A confirmed NaN resets the carry to NaN; unconfirmed observations are ignored. No prior value produces NaN. Metadata is structurally checked, not authenticated. Null and infinite values are errors. End times and confirmed availability must be strictly increasing; confirmed availability equals end time and cannot exceed asOf.

Resource bounds: existing maxBars applies, plus a conservative 256 MiB ceiling for new typed snapshots/results, at most 4096 consulted calendar dates and 64 segments per date and 16384 segments in total. SharedArrayBuffer-backed inputs are rejected. Adjacent dates are consulted for overnight overlap detection; this may reject an ambiguous selected schedule adjacent to supplied rows. Provider results are captured once per consulted date in a bounded local calendar. No global result cache is retained. No automatic day/week/month aggregation, source-interval inference, empty-bar synthesis, streaming incremental state or UI/timeframe switch is included.

## Example and deployment scope

`examples/resampling.mjs` exposes `confirmedFiveMinuteClose(columns,length,calendar,asOf)`: resample one-minute sources into five-minute targets, then align confirmed closes to explicit one-minute close decisions. The first four one-minute decisions have no confirmed five-minute result and remain NaN. With an earlier asOf, later decisions can only carry values already confirmed at that asOf. Gaps stay incomplete; this is not a promise that the provider emitted every trade.

Both functions are exported from package root and `/core`, and included in generated native JavaScript. There is no new Swift/Java facade or native compiled artifact, chart timeframe selector, or browser screen QA in this slice. Node execution of the generated JavaScript is distinct from execution in JavaScriptCore/QuickJS on a device. Large inputs are synchronous; benchmark cost before using this path on a UI thread.

## Verified scope and absolute cost (Linux Node)

On 2026-10-13, Node24.19.0/Linux x86_64, Xeon Platinum8573C: 10 sequential fresh processes, 100k then1m rows repeated5times, with one5000-row warmup per process. Fixture is synthetic UTC24-hour sessions, one-minute→five-minute, complete OHLCV. No concurrent own tests/builds/benchmarks. `node benchmarks/resampling.mjs 100000 1` reproduces one sample. Raw files and manifest are in `benchmarks/results/cycle19-node-resampling/` in the evidence archive.

| Source rows | Resample median (min..max), ms | Alignment median (min..max), ms | Owned resample result | Owned aligned result |
|---|---:|---:|---:|---:|
|100,000|66.13 (60.51..71.83)|3.97 (3.92..5.00)|1,480,000bytes|800,000bytes|
|1,000,000|495.68 (477.77..500.95)|26.65 (26.26..28.65)|14,800,000bytes|8,000,000bytes|

These are absolute full-call Node CPU costs, not improvements over an equivalent prior API or competing product. Allocation and full source validation are included; fixture construction, verification and caller-side decision timestamp construction are excluded. Every sample matches an independent fixed-five-slot oracle for every OHLCV value, source bound, flag, availability and aligned decision. Source hashes are identical across each size. Process memory snapshots are not peaks; GC and retained warmup arrays affect differences. Owned result bytes exclude the temporary source snapshot, calendar/JS objects, caller input and subsequent indicator output.

Do not call the million-row synchronous path directly on a UI thread: roughly half a second of calculation can visibly block interaction. A separate execution context is recommended for large datasets. The subsequent [resampleOHLCVAsync slice](ASYNC-RESAMPLING.md) now provides a dedicated Worker, cancellation and bounded copy/validation protocol with explicit source ownership modes. It has a longer total-completion-time tradeoff and does not add an asynchronous indicator-parameter-edit facade. The latter remains a follow-on.

44 new regressions pass, including35 independent contract/oracle cases and9 snapshot/resource/example cases. Baseline checkpoint lacks the module, so baseline-red is a module-load failure, not44 individually executed failing cases. Existing+new full suite:1316tests, zero failures/skips;324ECMAScript modules; strict TypeScript5.9.3 and offline npm consumers pass. Date/session ambiguity, source-grid gaps, future validation, ±1ms availability, confirmed NaN, DST, early closes, Float64 volume overflow, source/calendar immutability and typed-array override/shared-memory boundaries are covered. Browser/SDK/device execution remains unperformed here.
