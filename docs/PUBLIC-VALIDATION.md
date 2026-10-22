# BaroChart development-preview validation

This development source tree is derived from the 0.2.13 development checkpoint. It is not a stable SDK release or a claim of commercial feature/performance parity. Historical platform runs do not certify later changes.

The later [October 21 source review](REVIEW-2026-10-21.md) describes its changes,
measured synchronous control work and explicit verification limits.

## Core/web feature integration checkpoint (2026-10-18)

At source `381fb00fc41c49aadfb72f45fb0c0a66f500d62c` (834 tracked files),
**4,870/4,870 Node tests** passed (4,826 top-level cases; zero failures/skips).
All **513 ESM syntax checks**, strict TypeScript **5.9.3**, and the offline
packed-consumer check passed on cloud Linux/Node **24.19.0**. The package check
used 209 packed files and did not publish to a registry. Counts describe this
whole-suite run, not a sum of historical scoped runs.

Changes since the October 17 checkpoint include shared-model fixture coverage,
data lifecycle/session regression checks, drawing magnet, optional crosshair
snapping, long/short annotations, visibility, duplication, style-only presets,
manual prefix replay and its isolated forward-study optimization, and an
example-local explicit-baseline percent comparison. Feature documents distinguish
core, example, generated JavaScript bridge and source-only native facade coverage.
Presets have no new Swift/Java registry; replay has no native replay facade/UI;
relative comparison adds no core API. The comparison review separately checked
276 stored-Float64 exact-rational cases (maximum observed deviation 1 ULP); this
is not a general correctly-rounded arithmetic guarantee.

Actual-browser checks for these changes remain unrun; modeled Canvas/DOM/RAF
checks do not validate rendering pixels, trusted input, browser scheduling,
assistive technology or physical GPU fallback. No new Mac/native SDK/JNI
execution, device FPS result or publication is claimed. Replay CPU measurements
are synchronous cloud samples with documented cold-seek and cancellation-pattern
costs, not browser frame-rate or hard-latency guarantees.

The older pre-branding 2,551/2,552 watchdog failure and its isolated rerun remain
recorded below. Later passing suites do not establish the cause of that earlier
failure or retroactively turn it into a passing run.

## Native prepare construction ownership (2026-10-17)

A trusted statically linked factory could also reenter `nativePrepareCreate`
before its owner was assigned. Nested prepare/workspace ownership could be
overwritten, while a nested params target could coexist and split buffer/start
routing. A construction-only flag now blocks all four target Create entry points
and is released in `finally`, including direct factory and later constructor
validation errors. No buffer, step, finish or rendering loop changed.

All **9 new / 221 scoped Node tests** passed. The byte-identical final fixture
passed three and failed six cases on the unchanged baseline. Actual standalone
Linux QuickJS reproduced that baseline and passed **9 scenarios / 141 assertions**
on the candidate, with a fresh runtime per scenario and no Intl shim. All normal,
OOM and interrupt cleanup runs ended with zero final requested live bytes and
allocations. Independent actual-bundle compatibility checks passed **3 scenarios /
49 assertions**, including initialized-runtime admission and workspace cancellation
followed by a replacement prepare retaining its buffer identity and cursor.

The four target constructors were reviewed together: prepare calls a linked
factory during construction, async does not, and workspace/params retain their
existing reservation tokens. Legacy prepare has no JS bridge Dispose API;
workspace/params disposal does not cancel it. Its existing host job cancellation
flag and worker-runtime retirement contract are unchanged and are not certified
by these VM/QuickJS checks. This concerns trusted callback admission, not remote
code execution, unrelated factory side effects or a demonstrated permanent leak.

The checked-in resource is byte-identical to the unchanged canonical generator:
**497,535 bytes**, SHA-256
`6d99d31aea41a69d2e516ba17cd0f662bf379e4522676a7540bfcbac0980e12d`.
Only the two reviewed bridge chunks changed. The full native build command and
one direct-script diagnostic generated that resource but could not compile a
native executable because `swiftc` was absent; their failed results are retained.
The existing standalone Linux QuickJS host was reused without an SDK build.

At frozen production commit `1b50256c3175757d3431c6f68a0f849bc5419185`,
**4,130/4,130 Node tests passed across 224 files exactly once in 38 serial batches**.
Independent audit reconciled every raw TAP plan/count and all **779 tracked files**
against Git blobs. Failures, skips, cancellations, todos, missing/duplicate files
and source changes were zero. All **469 ESM syntax checks** and strict TypeScript
5.9.3 checks passed sequentially afterward. This entry is documentation-only.

A separate read-only Java SE composition probe passed **4 scenarios / 67 checks**
using both production job machines, fake Hosts and real worker threads. Pending
params cleanup and workspace work shared the exact logical slot/byte limit;
third-job rejection, one-byte-over-limit cases, independent recovery and final
zero accounting passed. This found no production defect and did not allocate the
claimed logical budget in actual native memory. No Android/JNI, Swift/JSC/ARC,
device/browser/GPU, accessibility, heap-leak or performance certification follows.

## Native workspace construction ownership (2026-10-17)

A trusted linked indicator factory could reenter workspace-target construction
before its bridge owner was registered. Nested and outer creation both succeeded,
overwriting the nested owner; disposal during construction returned false. The
bridge now reserves construction before callbacks, rejects competing target
admission, honors constructor-time cancellation and preserves a replacement
admitted after cancellation. Rejection disposes only its local result, and
conditional final cleanup releases its reservation even when cleanup throws.
That checkpoint covered workspace-originating construction ownership; it did not
give legacy constructors a new reservation guarantee. The overwritten baseline target was GC-eligible
without diagnostic references, so this is not evidence of a permanent memory leak.

All **12 new / 411 scoped Node tests** passed. The exact final fixture passed four
and failed eight cases on the unchanged baseline. It covers all four target-create
entry points, cancellation, constructor/cleanup exceptions, workspace/params
replacement identity and transfer position, completion and fresh recovery.
The same fixture in actual standalone Linux QuickJS passed **12 scenarios / 141
assertions**, reproducing the baseline's four-pass/eight-fail result first. The
existing verified vendored QuickJS host was reused; normal, OOM and interrupt
cleanup ended with zero final requested live bytes and allocations. No Intl shim
was needed. Independent source review found no blocker.

The checked-in native resource was regenerated with the unchanged canonical
generator: **497,133 bytes**, SHA-256
`bf430020009bd1683319106e615ddc50805e944ab5a3733158aad6d6261a6913`.
Independent comparison verified that only the two reviewed bridge chunks changed.
No per-bar, checkpoint, render or transfer loop changed; no speedup is claimed.

At frozen source commit `998cefdcd85c9df130dcc534dbb987282b4d1522`,
**4,121/4,121 Node tests passed across 223 files exactly once in 38 serial batches**.
Failures, skips, cancellations, todos, missing/duplicate files and source hash
changes were zero. Independent audit reconciled all raw TAP plans/counts and
all **777 tracked files** against Git blobs. All **468 ESM syntax checks** and
strict TypeScript 5.9.3 checks passed sequentially afterward. This entry is a
documentation-only follow-up. Trusted callback ownership checks do not certify
Android SDK/JNI, Swift/JSC/ARC, devices, browser/GPU, accessibility, heap leaks or
performance, and do not sandbox unrelated factory side effects.

## Workspace symbol fidelity and native resource integration (2026-10-17)

Supported optional symbol `provider` and `adjustmentVersion` metadata previously
made workspace export and import reject. Both now round-trip as optional bounded
strings, with known undefined fields omitted on save. Required-only documents,
strict unknown/malformed-field rejection, independent dataset binding, formatter
mode and precision remain covered. The exact final regression fixture failed
12 of 31 cases on the preceding source; all **31 new / 538 scoped Node tests**
passed after the fix, including actual Node Worker transport and generated VM
coverage. Independent source review found no blocker.

The checked-in native JavaScript resource had lagged committed core changes.
A separate commit regenerates it from the existing canonical generator, updating
the drawings, interaction, model and workspace chunks. A new exact-byte freshness
test prevents that resource from silently drifting again; a second test executes
the checked-in resource in Node VM. Both exact final tests failed against the old
resource. The initial fixture syntax error and corrected-baseline evidence are
retained. The refreshed resource is **496,494 bytes**, SHA-256
`8c0a7b4a85db37e60e2020bfd91026f3f9230fbe96f5c1ec9e2dec0dd67446c4`.

Standalone vendored QuickJS 2026-06-04, compiled locally with GCC 14.2.0, passed
**9 checked-in-resource checks, 23 native-control checks and 130 linked-workspace
checks**. Each run reported zero final live bytes/allocations after normal, forced
OOM and interrupt cleanup. The resource metadata fixture uses an explicitly
modeled UTC-only formatter because bare QuickJS lacks Intl; this does not verify
Java/Apple timezone bridges. No SDK, JSC/JNI/ARC, device, browser/GPU, accessibility,
heap-leak or performance certification follows from these checks.

At frozen source commit `115d198206ebc3a61550819fc86b1fd9ab58b425`,
**4,109/4,109 Node tests passed across 222 files exactly once in 37 serial batches**.
Failures, skips, cancellations, todos, missing/duplicate files and tracked-source
hash changes were zero. Independent audit verified every raw TAP plan/count and
all **775 tracked files** against Git blobs. All **467 ESM syntax checks**, strict
TypeScript 5.9.3 and offline installed-package checks passed sequentially after the
suite; all 194 retained package members matched the frozen source. This paragraph
is a documentation-only follow-up. Earlier results retain their recorded scope.

## Collapsed-ellipse integration and streaming composition (2026-10-17)

At source commit `83c37ae5d44a943c4ff07f378deb9fc59562bccf`, **4,071/4,071 Node tests passed** across **219 files exactly once in 37 serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. Independent evidence review verified raw TAP structure/counts/plans, log hashes and all 769 tracked hashes against committed Git blobs. All 463 ESM syntax checks, strict TypeScript and offline package checks passed. This supersedes the preceding ellipse section's then-current full-suite gap. The earlier unexplained plan-only CLI failure and unchanged rerun evidence remain retained.

A subsequent test-only [queued-streaming lifecycle harness](STREAMING-LIFECYCLE.md) adds five passing regressions. Its eight-run bounded pilot combines 4/8 charts, shared/independent models and two seeds at 4,096 rounds each: 233,675 accepted events, 28,588 FIFO wraps, 896 pending-data save/restores and 17,964 chart constructions/destructions. Independent event/ledger/EMA oracles, fresh implementation scene comparisons and cleanup counters passed. No production defect was found or production module changed. These modeled DOM/RAF, scene-cache and non-raster checks establish neither real-browser/GPU behavior, heap-leak freedom, device capacity nor performance; the pilot is operation-count bounded, not a wall-clock duration qualification. The 4,071-test integration above predates these five added tests.

The final frozen follow-up at `6dd77027ca6c46324f7ef84776eeba6856042442` passed **4,076/4,076 Node tests across 220 files exactly once in 37 serial batches**, including the five new tests. All 772 tracked hashes were unchanged; failures, skips, cancellations, todos and missing/duplicate files were zero. Independent audit reconstructed the raw TAP totals and checked every tracked file against committed Git blobs. All 465 ESM syntax checks, strict TypeScript and offline package checks passed sequentially after the suite. This final paragraph is documentation-only; no executable file changed afterward. The strengthened pilot additionally checked 12,288 unchanged base-cache reuse frames, and two temporary fault injections were detected by the data and cache assertions. These results retain the same stated platform, timing and memory limitations.

## Collapsed ellipse body selection (2026-10-16)

An ellipse with exactly one zero projected radius still produces a horizontal or vertical stroke in the WebGL mesh builder, but its body previously could not be selected. Hit testing now uses the existing line-segment distance allowance for that case. Both-zero outlines remain without a body hit; selected handles, locking, panel/axis filtering, stroke-width tolerance and ordinary positive-radius ellipse selection retain their existing policies. Filled shapes still use outline selection. No rendering geometry or public API changed.

**17 new tests / 1,112 scoped Node tests passed** across **31 files in six serial batches**, with no failures, skips or cancellations. Sixteen corrected-baseline regressions failed before the fix; an earlier unsupported-null-fill test fixture error is retained separately. Coverage includes horizontal/vertical and reversed anchors, fill presence, width/tolerance/endpoint bounds, clipping, selected-handle priority, topmost locked bodies, real controller movement/undo/redo and a generated core VM. The shipped WebGL render/segment/quad methods are executed with no-op GL calls, and test probes are required to lie in nonzero-area submitted triangles before checking the hit result. This verifies CPU mesh construction, not GPU rasterization or Canvas/browser pixels.

An independent scalar-distance audit checked 103,168 collapsed-outline probes and preserved 80,910 ordinary, tiny-positive-radius and both-zero comparisons. A separate 128-fixture common-case comparison, covering all 14 drawing types and positive ellipse aspect ratios, matched all 371,712 hit results and emitted-command hashes against the preceding source. These are correctness comparisons, not timing measurements. Independent review found no blocker in this bounded change. The preceding 4,054-test full integration below was not rerun; no real browser, GPU, native SDK/device or assistive-technology execution was attempted.

## Integrated axis-precision validation and retained failure (2026-10-16)

At source commit `d3f2c46777a035a3a4ab642c9409f225f0848614`, the fresh serial rerun passed **4,054/4,054 Node tests across 218 files exactly once in 37 batches**. Every batch exited zero; skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. Independent evidence review checked all raw TAP/log hashes, file coverage, all 768 tracked source hashes and packaged source members without rerunning tests. All 462 ESM syntax checks, strict TypeScript and offline package checks passed. This final documentation-only follow-up changes no executable source.

The first integration at the same source passed 4,053 tests and failed one plan-only CLI trace-cap check. That child invocation has a 15-second timeout; the failed test lasted about 19.1 seconds, but its TAP did not retain child exit/signal metadata, so the original termination cause remains unresolved. The exact CLI command subsequently passed unchanged in about 158 ms, and the unchanged affected batch passed 182/182. A complete serial rerun followed with no concurrent owned validation jobs. Its source/test manifest is byte-identical to the failed run. No test, timeout or executable source was changed to obtain the passing result; all initial failure and rerun evidence remains retained. The CLI only prints a plan and hashes and did not start a browser or run a measurement.

The integrated result is segmented Node coverage, not a monolithic run or actual browser/GPU/native SDK/device/assistive-technology validation. The earlier 4,041-test integration below remains the preceding source baseline.

## Narrow binary64 price-axis precision (2026-10-16)

Normalizing finite prices before subtraction displaced the exact stored midpoint of `[100, 100.00000000000003]` by about 75.67 CSS pixels in a 454-pixel renderer-neutral plot, and inverse lookup at the center lost that midpoint. Linear axes now subtract first when safe. Inverse interpolation retains the low part of the finite endpoint difference; normalized fallbacks still handle overflowing spans, off-domain differences and inverse intermediates. The projection mode and direction are selected once per layout. These unusually narrow valid domains are a correctness boundary; their practical frequency is unmeasured.

**13 new / 158 related Node tests passed**. Eight initial regressions failed before the fix; independent review exposed an additional asymmetric cross-zero inverse edge in the first candidate, which was reproduced and corrected. Coverage includes manual/automatic and independent axes, inversion, adjacent stored values, negative/cross-zero/large/subnormal domains, overflow-safe extrapolation, scene/drawing/crosshair readout and generated-core VM execution. An independent exact-rational sweep covers 2,162 forward comparisons, 4,192 inverse samples and 74 transformed-axis checks. It found no remaining blocker under its bounded tolerances, not a universal correctly-rounded interpolation guarantee.

Both CPU pilots retain all samples. The first candidate increased pooled linear-scene median cost in its fixture. After invariant choices moved out of the per-value loop, the second pilot did not reproduce that median regression. The final pilot's linear/log/percent scene medians were 0.540→0.497, 0.791→0.809 and 0.461→0.403 ms, respectively, with 320 samples per version/case. The linear-scene median of per-run medians changed by only −0.7% in the final pilot, versus +6.9% in the first. Some tails and maxima were worse, including the log-scene maximum. Baseline timings also varied across pilots. These cloud Node measurements establish neither universal non-regression nor a stable speedup, browser/GPU/display performance, native-device or assistive-technology behavior. No original decimal precision is recovered, and no new browser/device/SDK execution was attempted.

## Integrated CPU-harness and seeded-lifecycle coverage (2026-10-16)

At source commit `3105e4ab0a5dd4c67d937c891822a0b4a1094465`, **4,041/4,041 Node tests passed** across **217 files exactly once in 37 short serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. This includes the 11 multi-chart CPU-harness and 7 seeded-lifecycle tests added after the previous integrated run. All 461 ESM syntax checks, strict TypeScript and offline package checks passed. Independent evidence review checked the raw TAP/log hashes, test coverage, all 767 tracked source hashes and the verified package's 193 members against source without rerunning the suite.

This is a segmented Node run, not one monolithic invocation. This documentation-only follow-up adds no production change. Modeled DOM/RAF, generated VM and CPU-harness checks do not establish actual browser/GPU behavior, heap-leak freedom, native SDK/device or assistive-technology operation, display performance or competitive speed. No new browser or native-platform execution was attempted.

## Seeded shared-controller lifecycle composition (2026-10-16)

Six deterministic sequences (seeds 7, 41, 117, 991, 2026 and 65537) each execute 120 operations across three actual CanvasChart/controllers under modeled DOM/RAF. Every seed covers create/edit attempts, pointer move/up/cancel, pinch, sibling destroy/recreate, source append/update, explicit tool changes and global cancel/undo/redo/Escape. Incidental foreign operations preserve transaction identity, geometry and undo/redo contents; explicit shared/global commands retain their separate semantics. Final listener counts return to the model's pre-chart baseline and pending RAF counts reach zero. These counters do not prove heap collection or long-term leak freedom.

**7 new / 59 related Node tests passed**. The six sequences reached 15 new create gestures, 9 edits, 52 pinch transitions and 13 protection checks while a foreign transaction existed (including source-update cases, not 13 stale-pointer cases). Individual seeds do not reach every state; a seventh suite-level gate checks aggregate reach. An initial synthetic-event fixture omitted button0 and silently skipped pointerdown; those invalid coverage results were retained, the fixture was corrected, and the same seeds were rerun. No new production defect was found and no production module changed. Seeds and operation counts are retained; a failed assertion includes the reproducible event trace. Changed-test syntax, strict TypeScript and offline package checks passed. This bounded exploration is not exhaustive concurrency verification or actual browser/device/SDK/AT testing. The integrated 4,023-test source result below predates these test additions; the 4,041-test run above includes them. Actual browser execution of these multi-chart scenarios remains unverified; Node contract tests do not establish browser behavior.

## Multi-chart core CPU baseline (2026-10-16)

A bounded Node-only [multi-chart harness](MULTI-CHART-CPU.md) adds 1/4/8 independent-model clean/update/append workloads with fixed-total and fixed-per-chart data. **11 harness regressions and 41 existing streaming-composition tests passed**. Changed-module syntax, strict TypeScript and offline package checks passed. One pilot completed 54 case runs and retained all 540 measured samples, with full source/fresh-implementation EMA checks, scalar range oracles and final timed-scene checks outside timing. Source/harness hashes matched before and after. Group CPU times include outliers and index-policy differences; they are not renderer submission, browser/GPU/FPS, native-device or heap-leak evidence. No production optimization or synchronization-cap change followed. The integrated 4,023-test result below predates these benchmark/test-only additions; the 4,041-test run above includes them.

## Integrated fallback and stale-input ownership coverage (2026-10-16)

At source commit `20de0bed3d32bf889e74694c372f72eee7e0647c`, **4,023/4,023 Node tests passed** across **215 files exactly once in 36 short serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. Independent evidence review checked raw log hashes, TAP totals, coverage and source hashes without rerunning the suite. All 458 ESM syntax checks, strict TypeScript and offline package checks passed. This integrates the fallback and stale-pointer ownership fixes below; it is a segmented run, not one monolithic invocation. This documentation-only follow-up adds no production change. Modeled DOM/RAF and generated VM coverage do not establish real-browser/GPU behavior, heap-leak freedom, device capacity, SDK/AT operation or performance.

## Stale shared-model drawing input (2026-10-16)

After an explicit shared-model command replaced a drawing transaction, the old controller's move could cancel the new owner's drawing and its up could commit that drawing early. Move/up now check the captured transaction identity and retire only stale local gesture/pointer state, with another check after layout creation. Same-ID replacements remain protected, the new owner completes with one undo entry, and explicit global cancellation retains its existing meaning.

**12 new / 176 related Node tests passed** across two scoped runs. Five of the initial eight regressions failed before the fix. Coverage includes stale move/up/cancel, same-ID replacement, layout reentry, external commit, fresh down, actual Canvas pointer handlers under modeled DOM and a generated core VM. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. The subsequent 4,023-test integration is recorded above. No actual browser/device/SDK/AT execution or performance measurement was performed.

## Shared-model renderer fallback (2026-10-16)

An idle or panning sibling switching to Canvas fallback previously cancelled another chart's in-progress drawing. The fallback cleanup now rolls back only the receiving controller's current captured transaction, preserving foreign/manual/replaced transactions. Its own create/edit rollback and existing reentry guards remain intact. **6 new / 105 related Node tests passed**; three baseline regressions failed before the one-call ownership fix. Tests invoke the shipped fallback method with modeled DOM and verify owner/sibling rollback, canvas replacement and a new gesture started by onFallback. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. The subsequent 4,023-test integration is recorded above. No physical GPU context-loss event, browser/device/SDK/AT execution or performance measurement was performed.

## Integrated keyboard and multi-chart ownership coverage (2026-10-16)

At source commit `def93209dab319ea4b55b060d38919314479baf0`, **4,005/4,005 Node tests passed**. A fixed manifest covered **213 test files exactly once in 36 short serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. Independent evidence review checked the raw log hashes, TAP totals, file coverage and source hashes without rerunning the suite. This integrates web modifier routing and the three shared-model teardown/input/pinch ownership fixes below. It is a segmented run, not a single monolithic invocation. All 456 ESM syntax checks, strict TypeScript and offline package checks passed. The bounded 1/4/16-chart matrix uses modeled DOM/RAF and an injected non-raster renderer; it does not measure real-browser/GPU behavior, heap leaks, device limits, SDK/AT operation or performance. This section is a documentation-only follow-up to the measured source commit.

## Shared-model pinch takeover (2026-10-16)

A sibling controller moving from pan to two-pointer pinch previously rolled back another controller's drawing transaction. Pinch now restores only its own non-null captured transaction when its identity still matches the current one. Own create/edit takeover retains rollback, manual/replacement transactions survive, and explicit cancellation retains its previous global meaning. Shared-model viewport changes remain shared; this is not independent viewport behavior.

**9 new / 143 related Node tests passed**, including a generated core VM check. Four initial regressions failed before the conditional rollback fix. Coverage includes both sibling-pan start orders, own create/edit, manual and replaced transactions, reentry during rollback, pointer release and explicit cancellation. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. No actual browser/device/SDK/AT execution or performance measurement was performed. The subsequent full integration is recorded above; source `35ed4f8` remains the preceding whole-suite baseline.

## Shared-model input failure and multi-chart matrix (2026-10-16)

A rejected second chart pointerdown previously cancelled the first chart's active drawing transaction. Web error cleanup now checks transaction ownership; begin-to-gesture setup failures clean up only their own still-current transaction. Tracked pointercancel/lostpointercapture follow the same rule and late cancellation of an untracked pointer is ignored. The original busy error remains visible; there is no automatic retry. Explicit core/native cancel behavior remains unchanged.

**14 new tests and 208 related checks passed** across scoped Node runs (159 interaction, 48 existing synchronization checks and one generated-core setup-failure check). The new matrix covers 1, 4 and 16 chart instances with independent or intentionally shared models: source append, view/crosshair state boundaries, resize, destroy/recreate, pending RAF removal and store listener counts returning to their pre-chart baseline. It uses actual CanvasChart/controller/scene building with modeled DOM/RAF and an injected non-raster renderer. Existing synchronization tests retain their explicit group policies and membership limits; the 16-chart matrix does not imply a 16-member synchronization group. These are bounded lifecycle/state checks, not heap-leak measurements, device capacity limits or browser/AT/GPU performance results. Setup errors, ownership replacement, late cancellation and generated VM behavior are covered. Initial matrix fixture assumptions about baseline listeners and event spelling were corrected with the logs retained. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. The subsequent full integration is recorded above; source `35ed4f8` below remains the preceding whole-suite baseline.

## Shared-model chart teardown (2026-10-16)

Destroying an idle chart sharing a model previously cancelled another chart's in-progress drawing. Renderer teardown now rolls back only the exact drawing transaction captured by its own create/edit gesture. Sibling pan/wait controllers and stale creators preserve other transactions; explicit core/native cancellation keeps its prior contract. Shared models still share view/crosshair/drawing state and do not support independent simultaneous transactions.

**11 new / 134 related Node tests passed**, including actual CanvasChart/controller integration under a minimal DOM and a generated core VM check. Four corrected-baseline regressions failed before the fix; an initial test assumption about an unset disposed flag was corrected and its log retained. Cases cover owner rollback, sibling survival, undo/load followed by a new transaction, teardown reentry and repeated destroy. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. The subsequent full integration is recorded above; source `35ed4f8` below remains the preceding whole-suite baseline. No real browser/device/SDK/AT execution, renderer pixel validation or performance measurement was performed.

## Web keyboard modifier routing (2026-10-15)

With exploration off, the web canvas previously consumed Ctrl/Cmd zoom shortcuts and Alt+ArrowLeft, changing chart view and calling preventDefault. A narrow web event filter now leaves Alt combinations and unassigned Ctrl/Cmd combinations to the host. Existing Ctrl/Cmd undo/redo and arrow routing, plain/Shift chart shortcuts, editable-target/IME checks and exploration mode remain intact; native/core key semantics are unchanged.

**13 new / 122 related Node tests passed**, including the actual CanvasChart handler under fake DOM. Eight modifier regressions failed before the fix. Tests cover all four Ctrl/Cmd arrow directions, undo/redo, Shift drawing movement, composition, prior event consumption, editable targets and exploration. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. This verifies event consumption and chart state, not actual browser-default execution or assistive technology. The subsequent full integration is recorded above; source `35ed4f8` below remains the preceding whole-suite baseline. No new browser/device/SDK run or performance measurement was performed.

## Integrated ingestion-demo and readout coverage (2026-10-15)

At source commit `35ed4f8e5a7d2138ce3cde6c26e1bdd1b37dac33`, **3,958/3,958 Node tests passed**. A fixed manifest covered **209 test files exactly once in 35 short serial batches**. All batches exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. An independent evidence audit checked all 35 raw log hashes, TAP totals, file coverage and source hashes without rerunning the suite. This integration includes the manual queue example and tiny-volume summary fix below. It is a segmented run, not a single monolithic invocation. All 452 ESM syntax checks, strict TypeScript and offline package checks passed. No new browser/device/SDK/AT execution or timing measurement was performed.

## Tiny-volume demo readout (2026-10-15)

The main demo's latest-bar summary previously used locale-default rounding: stored volumes `0.00000001` and `0.0001` displayed as `0`. Its volume field now uses a round-trippable stored Number string, preserving `-0` and allowing exponent notation without grouping. This does not recover original decimal input precision; price and axis formatting are unchanged. **5 new / 69 related Node tests passed**. Tests execute the shipped sync handler across KR/US/crypto metadata, tiny/fractional/large values, market changes and empty data, with source identity/version and price formatting checks. The original four regression cases failed before the fix. Changed-module syntax, strict TypeScript and offline package checks passed; independent review found no blocker. The subsequent full-source integration is recorded above; `cb92cb31` below remains the preceding baseline. No real-browser/AT/device execution or timing measurement was performed.

## Manual ingestion queue example (2026-10-15)

The standalone [queue example](INGESTION-DEMO.md) uses manual synthetic packets to expose atomic queue-budget rejection, exact packet retry, one-event draining, pause/cancel and source-stale recovery. Resume is explicitly a source-version rebind; validation happens at the next drain. Counters separate packets from events and show accepted/applied/cancelled/pending conservation. The ingestion guide now points to supported synchronous and asynchronous indicator-parameter replacement rather than removal/recreation.

**7 new / 92 related Node tests passed**, including imports of the actual shipped example module with real CanvasChart/core and fake DOM/canvas primitives. Tests cover source-cap atomic failure, partial-drain cancellation, rejected-payload preservation, BFCache lifecycle and teardown during a callback. All 451 ESM syntax checks, strict TypeScript and offline package checks passed. An initial package command omitted the workspace TypeScript path and failed before packaging; its log is retained alongside the correctly configured successful run. Independent review found no blocker. No core implementation changed. The subsequent full-source integration is recorded above; the earlier `cb92cb31` result is retained below. There was no new browser/AT/device execution, screenshot or timing measurement.

## Integrated drawing-input coverage (2026-10-15)

At source commit `cb92cb31ebd9fa3f57750688671560dd3f9dd481`, **3,946/3,946 Node tests passed**. A fixed manifest covered **207 test files exactly once in 35 short serial batches**. All batches exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were zero. All 35 log hashes, TAP totals, manifest coverage and source hashes were independently verified without rerunning the suite. This integration includes the thick-stroke body selection and no-selection keyboard-cycle fixes below. It is a segmented run, not one monolithic test invocation. All 449 ESM syntax checks, strict TypeScript and offline package checks also passed. No new browser/device/SDK/AT run or timing measurement was performed.

## Keyboard drawing-cycle boundary (2026-10-15)

With three drawings and no selection, PageUp incorrectly selected the middle drawing. The no-selection branch now enters the last drawing for PageUp and the first for PageDown, retaining existing wrap and locked/orphan inclusion rules. Regressions cover 0/1/3 drawings, Escape/undo/load, a stale selected ID, active drawing cancellation and generated native-bundle VM behavior. This is a core keyboard-state correction; actual platform key delivery and accessibility behavior remain unverified. **13 new / 72 related Node tests passed**, including the generated VM test; changed-module syntax, strict TypeScript and offline package checks passed. The subsequent full-source integration is recorded above; the 3,915-test section below remains its earlier `fa5d17f` baseline.

## Thick drawing body selection (2026-10-15)

A supported 50px horizontal stroke rendered around y=200 was not selectable at y=220 with the default 8px input radius. Body hit testing now includes half the stroke width using `max(inputTolerance, width/2)`, including its candidate bounds. Thin strokes, text and selected handles retain their previous selection allowance; panel clipping, hidden axes, locked and topmost selection remain intact. This is the existing geometric proximity test, not a renderer pixel-mask test; ellipse distance remains approximate.

**18 new / 91 related Node tests passed**, including actual generated native-bundle VM selection, movement and undo. Existing scene geometry supplies the stroke-width oracle. Changed modules passed syntax checks, strict TypeScript and the offline package consumer checks. Independent review found no blocker. The subsequent full-source integration is recorded above; the 3,915-test section below remains its earlier `fa5d17f` baseline. Actual browser/device hit testing, SDK execution and timing were not performed.

## Integrated native-controls coverage (2026-10-15)

At source commit `fa5d17fc6de670b5ac522dbd4fd158afe9889262`, **3,915/3,915 Node tests** passed. A fixed manifest covered all **205 test files exactly once in 35 short serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were all zero. Raw logs and hashes were retained and independently audited without rerunning the suite.

All **449 ESM syntax checks**, strict TypeScript 5.9.3 and offline package checks passed again. This segmented full-suite completion includes the unchanged-batch facade, shared QuickJS fixture tests and opt-in native example source contracts. The actual standalone QuickJS execution remains the separately reported run below; this Node integration does not add UIKit/Activity compilation, JNI/JSC/ARC, device/AT, browser or performance verification. This documentation-only follow-up does not change production code.

## Opt-in iOS/Android exploration example (2026-10-15)

The existing demo applications now optionally show eight explicitly labelled exploration controls and a scrollable last-result readout. Default launches and existing validation modes retain their prior layout. Read values remains an explicit synchronous action; navigation does not calculate indicators. The proposed snapshot-repeat button was removed because diagnostic JSON loses negative zero. See [example flags, lifecycle and limits](NATIVE-CONTROLS-DEMO.md).

All **6 new tests and 53 related Node tests** passed, including an actual generated-bridge signed-zero/source-version regression and source-order checks. Strict TypeScript and offline package checks passed. The unchanged production Java facade and consumer signatures were rechecked against compile-only stubs; this does **not** compile or run the full Activity. The UIKit example is source-reviewed only. Prior standalone QuickJS results below are reused because the bridge and fixture are unchanged. Actual widget layout/focus, Swift/UIKit compilation, Android SDK/JNI and assistive technology remain unverified for these controls; there are no new screenshots or timing claims.

## Shared native-controls fixture in standalone QuickJS (2026-10-15)

A shared fixture now runs unchanged in bare Node VM and the existing standalone Linux QuickJS host. All **23 assertions across 10 scenarios** passed in both engines: explicit exploration actions and navigation without indicator computation, bounded readout refresh, exact unchanged batches, replacement volume, whole-batch rejection, signed zero, append anchoring, legacy publication and cleanup. The notification counter is the JavaScript API invalidation callback, not a Swift/Java host observer measurement.

The vendored QuickJS **2026-06-04** sources were compiled locally with GCC 14.2.0, without downloads. Normal runtime, forced OOM and interrupt cleanup each reported **zero final live bytes and allocations** through the existing C host. The tracked provenance and MIT notice remain unchanged. Reproduce with `node scripts/test-quickjs-cloud.mjs --native-controls`; this optional compiler check is separate from Node-only tests. The **10 added Node tests and 54 related tests** passed, including negative result-schema/cleanup gates. All **448 ESM syntax checks**, strict TypeScript 5.9.3 and offline package checks also passed. This adds no Android JNI/SDK, Apple JSC/ARC, device or assistive-technology execution. The earlier full-suite result below remains at its stated source revision.

## Native unchanged-batch overloads (2026-10-15)

Additive Swift/Java boolean overloads expose the existing exact final-value batch option without changing default/false or generic JSON command behavior. Validated unchanged success can suppress host notifications; uncertain true-path errors conservatively notify the same open owner and preserve the original error. See [the native batch contract](NATIVE-BATCH-UNCHANGED.md).

All **13 added tests and 357 related tests** passed, including generated VM behavior and facade source checks. The production Java nested receipt decoder passed **105 checks** in an isolated JVM; the full Engine was compiled against independent Android/JSON stubs (**51 classes, no diagnostics**) but was not initialized/executed by that decoder harness. All **445 ESM syntax checks**, strict TypeScript 5.9.3 and offline package checks passed. Swift/JSC/ARC, Android SDK/JNI, actual JSON container behavior, devices and timing remain unverified for this addition. The subsequent integrated native-controls run above includes this overload change.

## Integrated native exploration and streaming coverage (2026-10-15)

At source commit `04ce5d2db85e66771bd85b1a115b2c2f3e243651`, **3,886/3,886 Node tests** passed. A fixed manifest covered all **201 test files exactly once in 34 short serial batches**. Every batch exited zero; failures, skips, cancellations, todos, missing/duplicate files and tracked-source hash changes were all zero. Raw logs and hashes were retained. This is segmented full-suite completion, including the streaming-composition and explicit native-exploration additions below.

All **441 ESM syntax checks**, strict TypeScript 5.9.3 and offline package checks passed again. This later validation documentation does not change production code. Native facade tests retain their stated Java-stub/source-review limits; this integrated run adds no actual Swift/JSC/ARC, Android SDK/JNI, VoiceOver/TalkBack, browser/device or performance validation.

## Explicit native data exploration (2026-10-15)

The experimental Swift/Java facade now exposes four explicit actions: enable/disable, navigate, refresh and read. Navigation and refresh do not calculate indicators or notify/redraw the chart; explicit read can calculate all visible dirty indicators and can make an existing async parameter capture stale. Native key dispatch, VoiceOver/TalkBack controls and automatic accessibility announcements are not wired by this addition. See [the native exploration contract](NATIVE-DATA-EXPLORATION.md).

All **21 added tests and 240 related tests** passed, including generated JavaScript VM execution and facade source checks. All **441 ESM syntax checks**, strict TypeScript 5.9.3 and offline package checks passed. Actual javac compilation against independent compile-only Android/JSON stubs produced **50 classes with no diagnostics**. Swift received source-level ownership/reentry review only; Swift compilation, JSC/ARC execution, Android SDK/JNI, device accessibility and performance remain unverified for this addition. The subsequent integrated run above covers this addition; the earlier integrated result below remains scoped to its recorded source commit. No new browser/device run accompanied this change.

## Streaming composition regression coverage (2026-10-15)

A subsequent test-only change adds **41 deterministic cases** covering raw-series block/capacity boundaries, shared-model deferred reads, mixed append/correction batches, current-bar updates, rejected atomic batches, compaction ownership/restart and all 35 builtins. All **126 related tests**, the added test module's syntax check, strict TypeScript 5.9.3 and offline package checks passed. No production defect was found or production code changed in this investigation. The full-suite result below remains scoped to its recorded source commit.

Raw extrema and finite counts are checked by direct element scans. Indicator outputs are compared element-by-element with `Object.is` (including NaN equality and signed-zero distinction) with a fresh instance of the same implementation; this detects incremental/cache divergence but is not an independent financial-formula oracle. Existing dedicated formula tests remain separate. This coverage adds no browser/device execution or performance claim.

## Integrated scene and ingestion checks (2026-10-15)

At source commit `3c382efcfe807ec8fec067bf5aa0b1d25f50820d`, **3,824/3,824 Node tests** passed. A fixed manifest covered all **198 test files exactly once in 33 short serial batches**. Every batch exited zero, with zero failures, skips, cancellations, todos, missing files or duplicates. Tracked source hashes remained unchanged and all raw logs and hashes were retained. This is segmented full-suite completion; the following documentation-only commit does not change production code.

All **437 ESM syntax checks**, strict TypeScript 5.9.3 and offline installed-package/type checks also passed. This integrates the canonical column-prefix allocation path, deferred-append block-index correctness fix, README screenshot checks and singleton line/area query removal. The rejected raw-index optimization remains reverted.

The singleton query change has an independent scene oracle and bounded cloud CPU pilot, including a worse maximum outlier and noisy compressed controls; see [the data performance notes](DATA.md). These results do not certify browser paint, native-device performance or comparative superiority. No new browser or native SDK/device execution accompanied this integrated run. Historical screenshots retain their recorded source revision.

## Rejected raw-index optimization experiment (2026-10-15)

A bounded cloud Node CPU A/B compared baseline `9eca235` with candidate `b1d1069`
using eight alternating ABBA/BAAB runs, 10,000 synthetic bars, two symbols and
four additional lines. Each operation/version retained 160 measured samples;
all correctness and cleanup checks passed. The candidate reduced middle-correction
core-stage median from 5.367 to 3.971 ms, but increased common current-update
median from 0.961 to 1.308 ms. Separate clean raw-query 400-call batch means had
median 0.195 versus 0.394 microseconds per call. These batch-mean quantiles are not
individual-call latency percentiles. Scheduler/GC/JIT variation and large outliers
remain in the retained raw samples.

The optimization was **reverted**, rather than presented as an overall improvement.
The prior deferred-append range-index correctness fix and verified screenshot
gallery remain. This experiment measures cloud CPU stages only, not browser paint,
GPU, native-device or competitor performance. The earlier full-suite scope below
is unchanged; the restored production tree uses the already-validated baseline.

## Integrated ingestion and interaction checks (2026-10-15)

At source commit `49db3311910d3aff516d4a6e8efcf578b28047b3`, **3,772/3,772 Node tests** passed. A frozen manifest covered all **195 test files exactly once in 33 short serial batches**, with zero failures, skips, cancellations, todos, missing files or duplicates. Every batch exited zero; tracked source hashes remained unchanged, and each raw log hash was retained. This is segmented full-suite completion, not a single monolithic invocation. The documentation-only commit recording this result does not change production code.

All **434 ESM syntax checks**, strict TypeScript 5.9.3 and offline installed-package/type checks also passed.

This integrates the previous financial-data fixes plus stale pan/pinch viewport preservation, fixed `setData` row-count admission, consistent single-capture `setColumns` validation/copy, and reuse of a single indicator result for default-output crosshair readout. The last change reduces the readout's default-output lookup from two `get` calls to one per visible indicator series; layout and dirty-calculation costs remain. No input-latency, paint, throughput or comparative performance improvement was measured.

The suite combines Node core tests, modeled DOM/Canvas interaction, worker tests, generated native bundle VM checks and native source/fixture checks. It does not establish a new browser run, actual Swift/JSC/Android SDK/JNI/device execution or assistive-technology certification. Earlier Mac results below remain limited to their stated source and fixtures. No publication, new provider connection or SDK installation was performed.

## Integrated financial-data regression checks (2026-10-14)

At source commit `4f0398efd46e556413a9f07f8bee609c0e7248ca`, **3,718/3,718 Node tests** passed. A frozen manifest covered all **191 test files exactly once in 32 short serial batches**, with zero failures, skips, cancellations, todos, missing files or duplicates. Every batch exited zero; source hashes remained unchanged and each raw log hash was retained. This is a segmented full-suite run, not a single monolithic invocation. The documentation update recording this result does not change production code.

All **430 ESM syntax checks**, strict TypeScript 5.9.3 and offline installed-package/type checks also passed.

This integrates the exact decimal-string timestamp normalization, equivalent session-clock comparison and opt-in direct-JavaScript `skipUnchanged` batch behavior, alongside the existing ingestion, indicators, rendering, native-protocol and lifecycle tests. The option preserves full intermediate validation and only avoids publication when final OHLCV fields are unchanged. It does not infer feed freshness or change ordered queue accounting. No timing improvement was measured for it.

The suite includes modeled browser/DOM tests, Node worker tests, native bundle VM tests and native source/fixture checks. These do not establish a new Mac browser run, actual Swift/JSC/Android SDK/JNI/device execution, assistive-technology certification or comparative market-feed performance. Existing platform results below remain limited to their recorded source/fixtures. No remote publication or new provider connection was performed for this verification.

## Cached-history example lifecycle fix (2026-10-14)

A subsequent Mac Chrome 155 check found that returning to linked-ranges through the back/forward cache restored the page with zero canvases: its unconditional pagehide cleanup had destroyed both charts. The same source pattern existed in linked-cursors and drawing-groups. These three examples now retain existing charts, models, groups and controls on persisted pagehide, and request resize/redraw on persisted pageshow without creating new instances or listeners. Nonpersisted pagehide still performs one terminal cleanup. A cached page can be discarded without another event; this is not a guarantee of an explicit callback on every browser/process exit.

The shipped-module regression failed in all three examples before the fix. Afterward, **82/82 related Node tests** passed, including repeated cached transitions, stable canvas/panel identities and listener counts, continued actions, terminal cleanup, and linked-chart restoration interrupted by a synchronous terminal pagehide callback. DOM/Canvas primitives are modeled in those cloud tests. A separate Mac Chrome 155 retest of `e3284e54b638b8a373311ef3788fcff003f6477a` passed **22 checks**: all **four history restorations** reported `pageshow.persisted=true`, retained the existing chart/model/canvas/listener instances, and supported interaction after return. This is scoped browser QA, not AT certification or a long-term memory/performance benchmark. The 3,502-test integrated result below applies to the preceding `e2e834c` source, not a new full-suite run of this hotfix.

See the [browser lifecycle guidance](https://web.dev/articles/bfcache): persisted pagehide signals intent to cache, while persisted pageshow identifies a cache restoration. The example redraw is an application choice to refresh layout, not a browser requirement to recreate chart objects.

## Linked-range and contrast update (2026-10-14)

The subsequent TimeRangeGroup and drawing-demo contrast update passed **3,502/3,502 Node tests**, all **177 files exactly once in nine serial batches**, with zero failures/skips/cancellations, missing files or duplicates. The fixed test/source snapshot and each batch log hash were checked. This is segmented completion, not one monolithic run. All **406 ESM syntax checks**, strict TypeScript 5.9.3 and offline installed-package/type checks also passed.

Time-range coverage includes independent stored-time mapping, interval/gap cases, per-receiver missing-data results, automatic-data-change suppression, real CanvasChart controller wiring and initialization/cleanup of the shipped linked-ranges module using modeled DOM/Canvas primitives. Mapping/publication calculation-count assertions stop before ordinary dirty redraw. No new Mac/browser/AT or competitive performance result is claimed for this feature. The separately recorded Mac checks below apply only to their stated earlier fixture and hotfixes.

## Cumulative cloud regression checks (2026-10-14)

All **3,479/3,479 Node tests** passed with no failures, skips or cancellations. A fixed manifest covered all **173 test files exactly once**, in **nine short serial batches**, with zero missing/duplicate files, zero exit codes and verified log hashes. This was segmented completion, not a single monolithic invocation. The code under test was `423eb03654eefedca337a20a6154640d021d96a2`; the working changes were limited to the browser-QA documentation recorded here. No production code changed for this verification.

**400 ESM syntax checks**, strict TypeScript 5.9.3 and offline package consumer verification also passed.

This integrates the local demo, focus and CDP harness fixes rather than relying only on the earlier 3,417-test baseline. The cloud run did not launch an actual browser; the separate Mac browser evidence is scoped below. No additional remote push or registry publication was performed.

## First public source-tree checks (2026-10-13)

The sanitized BaroChart tree passed **2,554/2,554 serial Node tests** (355.397 seconds, zero failures/skips), all **356 source ESM syntax checks**, strict TypeScript 5.9.3 and offline local npm package installation/type/runtime checks. The local package is named `barochart`, licensed Apache-2.0 and remains `private: true` to prevent accidental registry publication. The two added branding tests verify package/example agreement and preserved legacy API identifiers. No product deadline was increased and no core test was removed to obtain this result.

The lower syntax-file count compared with the development checkpoint excludes frozen historical evidence copies and an archive wrapper; it does not remove production modules. README core examples also executed under Node 24. Browser/native platform gaps below remain open. This successful run does not erase the prior watchdog failure.

## Baseline execution record

The baseline before public branding was tested on Linux with Node.js 24.19.0:

- Serial Node suite: **2,551 of 2,552 tests passed**. One unchanged browser-ingestion **dry-run CLI** exceeded its 15-second subprocess hang watchdog (SIGTERM, no stdout/stderr). This was not a browser rendering test.
- The same unchanged contract file passed **131/131** in an isolated rerun. That does not turn the full-suite failure into a pass; the stalled phase/cause is unresolved.
- 418 ESM syntax checks, strict TypeScript 5.9.3 and offline local npm package consumer checks passed.
- Real standalone QuickJS executed core/native-bundle fixtures and normal/OOM/interrupt cleanup checks. This does not exercise JNI, Android, Apple JavaScriptCore, Swift ARC or rendering.
- The native compaction receipt decoder executed 58 Java scenarios / 92 assertions. Production Java sources compiled against **test-only stubs** (35 classes, zero diagnostics). This does not establish Android SDK/JNI or Handler-thread correctness.

These baseline numbers are retained as historical evidence, separate from the successful first public source-tree checks above.

## Scoped Mac browser QA (2026-10-14)

Installed Google Chrome **155.0.8059.79**, isolated headless profiles, real DOM/Canvas, and trusted CDP Input mouse/keyboard events were used. These are browser checks, not physical-device input/display timing or screen-reader certification.

The product fixture was commit `efd973bac0283addf02c449206324e74bd9cef98` plus exactly two source hotfixes: the linked-cursor sample uses the supported `candles` series type (from `d93443e`), and the drawing panel moves focus to Refresh before disabling the focused action/page button (from `8064791`). The entire fixture was not upgraded to the later cloud HEAD. The bounded WebGL probe separately used the CDP helper from `423eb03`.

- Drawing groups: actual click/Tab/Space/Enter, checked style application, selection across 32-row pages, deletion, Undo/Redo and destroy/remount were exercised. The initial run exposed focus loss and the linked-demo startup error; later targeted retests address those findings rather than relabeling the initial run as all-pass.
- Focus retest: **16 scenarios / 60 checks passed**. Apply/Delete/Clear and endpoint Previous/Next via click and Enter moved focus to Refresh before disabling, then Tab reached a row checkbox. Normalized no-op, blank checked value and zero width retained Apply focus, selection and Undo state. Page exceptions and console errors were zero. Favicon HTTP 403 resource errors were recorded separately.
- Linked cursors: **16 targeted checks passed** after the supported-type fix, including both charts, time matching/gaps, keyboard readouts and disconnect behavior. These counts are from a separate run and are not added to the focus scenario count.
- Main demo: the 100k initial load, 10k worker reload, VWMA price-panel placement, separate Aroon panel, pointer drawing/delete/Undo and keyboard exploration readout were exercised.
- Bounded remount probe: **one Canvas → WebGL2 → Canvas round trip succeeded**, with 28/28 CDP requests responding. It kept the same model, 10,000 bars and VWMA/Aroon panels, retired the previous views, produced a scene in each renderer, and reported no fallback, lastError, page exception or console error. A favicon 403 was separate. This probe used programmatic select/change fixture setup; it did not test native OS select menus or GPU pixel equivalence. The 2.397-second supervising-process elapsed time is a tool observation, not a performance benchmark.

The earlier WebGL wait interruption was **not reproduced; its cause remains unconfirmed**. The corrected CDP navigation wait is independently reproduced and tested, but no evidence establishes that it caused the original interruption. A single successful round trip does not establish long-term GPU stability, leak freedom or competitive speed. The test-owned Mac processes were checked as stopped separately from the helper's close return.

Remaining gaps include screen-reader announcements, broad contrast/layout and cross-browser coverage, sustained multi-chart/streaming GPU and memory measurements, and real Swift/JSC/Android SDK/JNI/device execution. The initial panel's low button-text contrast was subsequently corrected in the drawing-groups example with an explicit foreground/background pair. The declared normal colors calculate to 12.944:1 versus the observed old pair's 1.114:1; the CSS fix has source-level regression checks, but has not yet been remeasured as browser computed styles. This is not an accessibility pass.

## Open validation gaps

- Recent Swift facade/workspace ownership changes received static review, but have not been compiled or executed with Swift/Apple JavaScriptCore in this validation environment.
- Recent Android host changes have not been built/run against the real Android SDK/JNI or on devices here.
- The Mac Chrome checks above cover selected real-browser flows. Screen-reader/assistive-technology behavior, other browsers, mobile browser UI and broad visual regression remain unverified. The newer Node-tested fixtures remain unverified in an actual browser; Node contract tests do not establish browser behavior.
- No universal latency/FPS, long-term leak-freedom, accessibility certification or superiority over TradingView, SciChart or Vela has been demonstrated.

## Reproduce the supported checks

```sh
node --version
node --test --test-concurrency=1 test/*.test.mjs
npm run check
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:package
```

TypeScript is a development tool, not a runtime dependency. Browser/native scripts additionally require their documented SDKs, browser, local server access and host permissions. Optional Java and QuickJS cloud harnesses are explicit commands, not evidence of a full mobile SDK build.

## Interpret measurements carefully

Measure the same data, viewport, device-pixel ratio, indicator settings, renderer, hardware and warm-up when comparing versions. Keep benchmarks separate from builds/tests. CPU submission, event-loop timer gaps and offscreen rendering are different from input-to-display latency or display FPS. Worker offloading can reduce owner-thread blocking while increasing total wall time and memory/copy cost. Some small workloads are faster synchronously.

Large synchronous indicator queries, workspace JSON parsing and history compaction can block the UI. Choose bounded workloads, explicit scheduling and documented worker APIs where available. Compaction restarts study history; suffix results can differ from a full-history calculation. Retained host references and GC/RSS are not covered by library-owned typed-byte budgets.
