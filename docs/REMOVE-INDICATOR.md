# Removing a study without calculating discarded data

The common ChartAPI.removeIndicator command previously called IndicatorEngine.get only to check existence. A dirty study therefore recalculated before deletion; a throwing factory/step could prevent the user from removing the failing study. The command now checks entry existence and ownership without starting a calculation. Low-level IndicatorEngine.remove remains unchanged.

The entry is captured once. After lookup, controller gesture cancellation, drawing-target cleanup and method accessor evaluation, guards verify the same API model, indicator engine, entries map and exact entry identity. The final guard uses an intrinsic Map lookup and own data-property reads rather than calling a replaced entries.get again. The remove method is read before filtering the latest series list, preserving unrelated series added by an accessor. NativeCheckpointEntries retirement is not bypassed.

A changed owner throws StaleSourceError; a disposed chart throws Chart disposed. The Missing indicator error and error-producing ID string conversion remain unchanged. Original callback exceptions propagate. Trusted overridden method bodies, arbitrary internal Proxy replacements or modified intrinsics are not sandboxed. Callback side effects already performed are not rolled back. The existing post-commit invalidation exception behavior is unchanged.

This does not change study calculation correctness, checkpoint convergence or the unresolved general get/append guard overhead. A removal during its own active custom step now removes the entry directly; the outer calculation then rejects stale and cannot resurrect it. Held output buffers are not cleared or overwritten by deletion. Bound drawings retain their anchors and become orphaned, as before.

## Reproducible work accounting

Run `node benchmarks/remove-indicator.mjs <source-root> 100000 <receipt.json>` (also accepts 1000000). Identical harness, seeded source, empty-store initial binding followed by dirty data, fixed baseline 01fa672 and candidate API SHA f433399e49fbf3452aa26655f58f9289aa5784f58c7a00df32fe12774ff38678. Node v24.19.0, serial processes, no competing project builds/tests. Order: baseline/candidate 100k, candidate/baseline 1m.

| Dirty rows | Baseline create / step / snapshot / restore | Candidate |
| --- | --- | --- |
| 100,000 | 1 / 100,000 / 391 / 0 | 0 / 0 / 0 / 0 |
| 1,000,000 | 1 / 1,000,000 / 3,907 / 0 | 0 / 0 / 0 / 0 |

Both candidate sizes also remove a study whose next create would throw. Baseline calls create once and leaves the study/series installed after the error. Store version/listener counts are unchanged in both paths; final model disposal returns listeners to zero.

Raw receipts are `remove-indicator-work-{baseline,candidate}-{100k,1m}.json`. One un-warmed call time is retained per condition (normal baseline 153.972/471.781 ms; normal candidate 0.862/0.178 ms). These are structural-work demonstrations, not latency distributions or general speed ratios. They do not measure rendering, browser interaction, Android JNI, Swift/JSC or physical-device latency.

## Verification

Focused regressions cover dirty throwing calculation, held buffers, Missing ID coercion, lookup replacement, controller reentry/throw/dispose/model/entries replacement, active-step deletion, same-source update, method accessors, unrelated-series additions, shared-store updates and native checkpoint ledger retirement. Existing API, axis/drawing gesture, parameter staging and native target tests remain applicable. Standalone QuickJS uses the generated common JS bundle; native SDK compilation and devices are not verified by that execution.

Final frozen validation (2026-10-13 UTC): 2364/2364 Node tests passed in an
isolated serial 207.680-second run, no failures/skips. 402 ESM syntax checks,
strict TypeScript5.9.3, offline package and evidence validation passed. The
17 targeted ownership regressions and nine Node VM/coverage-oracle tests are
included in that total, not added to it.

The fixed six-scenario fixture also passed on actual standalone QuickJS using
the previously verified binary SHA
64e75c46f9a5a8f6afe0de2cea3388085949122df72a67f1a7b6c9f9714f1081
with new bundle SHA
d33e2b86eb625b6d1a2ad5ee2fe59e36c1acb32333bbe88ec27084d0a5fb360a.
Normal/OOM/interrupt cleanup each ended with zero live bytes and allocation
count (peak requested bytes 3,119,420 / 161,296 / 157,192). This reused an
existing C/vendor build, not a new compilation. Raw receipt and fixture source
are preserved with the checkpoint evidence. Previous suite watchdog failures
remain separate historical results; the timeout constants were not changed.
