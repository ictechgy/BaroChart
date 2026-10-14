# Bounded interaction measurement pilot

This harness has **not yet been executed in a real browser**. Node regressions
exercise the shipped Chart module with modeled DOM/raster/RAF primitives, the
measurement ledger, fake CDP failures, and an actual Node worker adapter. They
are wiring/correctness checks, not browser performance results.

The endpoint is **input/event or feed request → CPU submission of a matching
chart state**. It is not compositor presentation, physical display paint, FPS,
or an input-to-photon measurement. `aster:render` follows renderer submission;
WebGL commands may still be pending on the GPU. A one-pixel readback is collected
separately after primary samples and correctness checks, never folded into the
primary latency distribution.

## Plan before execution

From a source checkout, `node benchmarks/interaction.mjs` prints a plan only.
Importing its modules also launches nothing. Actual execution requires an
explicit `--run --output artifacts/interaction-pilot.json`. A suitable existing
Chrome/Chromium and an allowed loopback server are required. The reused launcher
uses `--headless=new`, a fresh temporary profile, no-first-run/default-browser
checks, disabled background networking and an ephemeral debugging port. Headless
results must not be presented as measurements of a visible desktop window.
The harness installs
nothing, does not weaken browser security flags, and does not use a user profile.

The first execution should be the default 10k pilot, only after the operator
has approved the bounded browser workload. Prior functional browser QA does not
constitute a run of this benchmark. A 100k case requires explicit `--large` (or
both `bars:100000,large:true` in `--config`); it is not a default follow-up.

Examples of planning, without running:

```sh
node benchmarks/interaction.mjs
node benchmarks/interaction.mjs --config '{"renderers":["canvas"],"operations":["pan","zoom"],"samples":20}'
node benchmarks/interaction.mjs --large
```

## Fixed first slice

- One chart, 10,000 seed-42 OHLCV bars, recent 200 visible bars, candles + EMA20,
  1200×700 logical chart pixels, DPR1. Each renderer/operation gets a fresh browser
  page/process. Canvas and WebGL2 are separate; fallback is a failure.
- Pan: a trusted CDP mouse press/move/release, alternating ±20 logical pixels.
  Wheel zoom: trusted CDP wheel ±20 at the fixed chart center. Twenty measured
  requests plus five warm-up requests per case; at least 16ms host delay after
  each dispatch. Actual event timestamps are retained; this is not a guaranteed
  60Hz delivery schedule. Dispatch round trips are recorded separately.
- Streaming: twenty eight-append packets plus five warm-ups, minimum 50ms host
  spacing. This is accelerated append replay, not a real market feed. An explicit
  eight-slot ingestion queue is enqueued and drained per
  packet; exact sequence, accepted/applied counters and empty remainder are
  checked. Non-stream cases additionally require original column identity and
  source version preservation. This first slice does not cover correction bursts, saturation,
  retention, or simultaneous input/feed competition.
- EMA parameters: trusted button click switches 20↔50, synchronous and dedicated
  Worker paths separately, four measured requests plus one warm-up. Each job
  settles before the next click. No concurrent feed is mixed into this success
  scenario; cancellation/stale-source behavior retains its existing separate
  correctness tests.
- Maximum 256 raw request rows, 512 long-task records (overflow explicitly
  counted), 32 error records, and existing bounded CDP diagnostics. Default
  request timeout5s, cumulative startup ceiling15s (also capped by remaining
  case/run time), case budget30s, run budget180s; config has hard finite
  bounds. Cases not started after the run budget are marked `not-run`. A browser launch
  failure stops further launch attempts and marks remaining cases `not-run`.

## Completion and raw evidence

Schema `barochart.interaction-results`, version1, retains the full source/harness
SHA-256 manifest, Git commit, config SHA, six initial column SHA digests, browser
build, renderer, viewport/DPR, environment and every issued request. In-page
timestamps use the page performance clock; Node/CDP round-trip durations use a
separate clock and are never subtracted from page timestamps. Planned and
unissued counts are separate. Baseline/source hashes are computed outside timing.

A token contains request time, actual event timestamp/handler time and trust flag
where applicable, API completion time, and expected source version, target entry
generation and visible logical range. Parameter requests retain the previous
entry and explicitly requested period: a wrong/no-op API response is rejected
before frame binding; the oracle uses the requested period, not whatever params
the chart happens to retain. A frame is eligible only with the chart's
current validated layout binding and an exact matching state. The newest matching
request is `rendered`; earlier requests sharing its frame remain `coalesced`,
including requests for an identical state. Older streaming versions can be
coalesced only as applied prefixes with the same indicator generation. Parameter
results cannot borrow a frame from a different entry generation.

`timeout`, `unrendered`, `rejected`, and unissued work stay visible. Late frames
cannot turn an expired token into success. Rendered and coalesced distributions
are separate, with p50/p95/p99/max using nearest rank. Twenty samples (four for
parameters) make tails descriptive only. No timing threshold is a regression
assertion. The selected fixed-order pilot is not an AB/BA optimization comparison
or a statistically powered comparative benchmark.

The harness does not claim an Event Timing metric for continuous pointer/wheel
inputs. They are excluded from that API's event set; custom timestamps and chart
submission events are used instead. See the [W3C Event Timing explainer](https://github.com/w3c/event-timing).

## Correctness and memory outside primary timing

Full source columns are compared with a fresh store populated by the original
fixture and individual append operations. EMA output is compared element by
element (including NaN) with a fresh IndicatorEngine at the final period.
An independent scalar clamp/pan/zoom oracle checks the event's view effect.
This catches incremental/queued-path disagreement; it is not an independent
mathematical proof of the shared EMA implementation or a pixel oracle.

Explicit GC/heap sampling, full correctness walks, selected live typed-buffer
accounting, and readback all happen outside primary samples. Main-target heap
samples include harness telemetry, baseline columns, precomputed packet objects
and oracle temporaries until collection. The selected known-buffer report omits
some indexes/checkpoint objects, worker heaps, GPU VRAM, RSS and transient peaks.
It must not be labeled complete memory usage. The fixture itself intentionally
retains an original 6-column copy and up to 2,000 planned append records for the
untimed oracle. CDP polling/telemetry introduce overhead and are not calibrated.

Destroy aborts/settles an active parameter job, removes owned input/render
listeners and DOM, destroys the chart and disposes its model. Worker termination
requests, calculation job/reservation counters, store subscriptions and pending
chart RAF are checked. The runner deletes the runtime global before post-cleanup
GC. Counts alone are not a GC/leak proof. CDP cleanup confirms the owned browser
root process exit before removing its temporary profile: TERM then, if needed,
KILL, with at most one second waiting for each. Unconfirmed termination is an
error and retains the profile. A small Node child regression checks process exit;
this is not a real Chrome descendant/GPU process cleanup measurement.

Startup deadlines cover both endpoint/socket opening and every initial CDP
setup request cumulatively. Existing callers that omit the optional startup
timeout retain their prior per-request defaults. Protocol deadlines do not
preempt a blocked JS task. Final runtime cleanup/GC/heap calls may take up to
15s, Browser.close up to3s, then root process termination up to2s. Thus a run
budget bounds measurement admission, not total cleanup wall time; filesystem
operations and descendant processes have no hard real-time guarantee. A pilot
with a three-minute overall operational target should reserve cleanup headroom,
for example `--config '{"runTimeoutMs":150000}'`, and report deadline failure
without treating incomplete cases as results.

## Comparison scope

No competitor adapter or dependency is added. Existing vendored Lightweight
Charts5.2.1 is distinct from TradingView Advanced Charts/Trading Platform.
SciChart and Vela are not executed. Any future comparison needs an exact pinned
version, lawful access, matching data/view/indicators, disclosed rendering policy,
per-library completion semantics and independently checked results. This pilot
provides no evidence of superiority over those products.
