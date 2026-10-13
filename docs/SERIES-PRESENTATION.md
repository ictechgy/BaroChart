# Display-only series patches without indicator calculation

ChartAPI.setSeries now has a deliberately narrow presentation path. A patch
containing only color, fill, upColor, downColor, width, visible or label (including
an empty patch) validates and applies those fields without reading indicator
outputs. This lets a user hide a dirty failing study or change its appearance
without first calculating the data being hidden.

Any other own key uses the existing path: id, indicator, output, source, values,
type, panel, axisId, offset, baseline and symbolId are not optimized here. Symbol
keys also retain the existing path. This is not a general series-binding rewrite.
Portable color normalization, width/visibility checks and label bounds remain in
force. Missing series/indicator and invalid presentation fields still reject;
no invalid patch is silently ignored. Trusted callback exceptions preserve their
original identity. Target numerical create/step/snapshot/restore are not invoked.

## Ownership and display meaning

Before patch getters run, the path captures the model/store version, series
array/current series, external-values revision and exact indicator entry. If
supported callbacks replace/remove those owners, dispose, or update the source,
the patch fails stale rather than overwriting the callback's new state. Unrelated
series appended or edited without replacing the target remain intact. There is
no rollback of application side effects already performed by a getter. Arbitrary
internal Proxies, direct object/buffer edits or modified method bodies are outside
the managed contract.

Only presentation is replaced. Existing rangeIndex, revision and dirtyFrom are
preserved because the raw binding/data did not change. Successful publication
invalidates once, so visibility still changes autoscale and subsequent scene
geometry uses the new color/width. Held output arrays and checkpoint ledgers are
not cleared, rewritten or recomputed. If the series is shown again, its next
ordinary scene/value read calculates dirty data and may report the same genuine
calculation error. This patch does not conceal errors in displayed data or change
post-commit invalidation error policy.

## Structural work evidence

`node benchmarks/set-series-presentation.mjs <root> <100000|1000000> <receipt>`
uses the same harness with baseline 0496b6b and candidate API SHA
6877cc1934837b93f4707da865e4bf292fed1b03893ab2576b6536efff68034d.
The initial study is bound on an empty store, followed by dirty seeded data. A
combined visible/color/width/label patch is applied once. Serial order was
baseline/candidate 100k, then candidate/baseline 1m, Node v24.19.0.

| Rows | Baseline create / step / snapshot / restore | Candidate |
| --- | --- | --- |
| 100,000 | 1 / 100,000 / 391 / 0 | 0 / 0 / 0 / 0 |
| 1,000,000 | 1 / 1,000,000 / 3,907 / 0 | 0 / 0 / 0 / 0 |

In the separate throwing-create case, baseline rejects the presentation patch;
candidate applies the identical valid presentation with zero callbacks. Source
version and listener counts stay unchanged, and both owners dispose cleanly.
Normal single-call times were baseline 91.426/300.177 ms and candidate
0.820/0.768 ms. These un-warmed individual samples document the work avoided,
not latency distributions or a general speed ratio. No browser/device rendering
or UI responsiveness claim follows from them. Raw receipts are preserved as
set-series-presentation-work-{baseline,candidate}-{100k,1m}.json.

A separate 35-condition healthy-model oracle compares final presentation and exact
error name/message against the same baseline. Named/hex/RGBA normalization, null
fill, undefined properties, width bounds, visibility types and label bounds all
match exactly. Reproduce with `benchmarks/set-series-presentation-parity.mjs`;
the receipt is set-series-presentation-healthy-parity.json.

## Browser capability recheck

On 2026-10-13 UTC the restored cloud environment was checked again. Installed
Chromium 154.0.8037.57 and Python Playwright were found. A normal headless
about:blank launch failed to create its default user-data directory. Retrying
with an owned /tmp profile reached process_singleton_posix.cc but socket()
failed with Operation not permitted (exit -6). No sandbox/security bypass,
installation or user-Mac fallback was attempted. Raw commands/results remain in
browser-capability*-20261013-1454.json. The keyboard prototype's real browser
focus/visual/AT QA remains open.

## Frozen validation — 2026-10-13 UTC

Final isolated serial suite: 2486/2486 Node tests passed, no failures/skips,
122.667 seconds. The total includes 33 presentation regressions and 11 Node
VM/coverage-oracle checks; do not add these numbers to the full-suite total.
409 ESM syntax, strict TypeScript5.9.3, offline package and evidence validation
passed. Final test-only reentry edits were syntax-checked again afterward.

The first full run passed 2484/2485. Its one failed expectation assumed that a
label change inside the same indicator's step must recursively calculate and
throw IndicatorBusyError. The new pure-presentation path correctly completes
that label change; the outer dataAt rejects the now-changed display snapshot with
StaleSourceError. The updated test requires that exact error, preserved new label
and correct next value/label. An added test still requires IndicatorBusyError for
an output-binding change and verifies recovery. Independent review confirmed
that this strengthens the new contract rather than weakening stale protection.
The original failed run is preserved.

Actual standalone QuickJS passed six fixed scenarios with the generated native
command bundle SHA
782cf2f53a1fb3fc814708807549ba6f96be971b339f3a94200d560b380a33ee.
The previously verified C/vendor binary SHA
64e75c46f9a5a8f6afe0de2cea3388085949122df72a67f1a7b6c9f9714f1081
was reused; no new C/native SDK compilation is claimed. Runtime/OOM/interrupt
cleanup each ended with zero live bytes and allocation count. Fixture, bundle,
binary and API hashes plus raw results are in the set-series-presentation-
quickjs-20261013-1505 receipt. Android JNI, Apple JSC, browser/AT and devices
remain outside this execution evidence.
