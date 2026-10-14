# BaroChart development-preview validation

This development source tree is derived from the private 0.2.13 development checkpoint. It is not a stable SDK release or a claim of commercial feature/performance parity. Historical platform runs do not certify later changes.

## Linked-range and contrast update (2026-10-14)

The subsequent TimeRangeGroup and drawing-demo contrast update passed **3,502/3,502 Node tests**, all **177 files exactly once in nine serial batches**, with zero failures/skips/cancellations, missing files or duplicates. The fixed test/source snapshot and each batch log hash were checked. This is segmented completion, not one monolithic run. All **406 ESM syntax checks**, strict TypeScript 5.9.3 and offline installed-package/type checks also passed.

Time-range coverage includes independent stored-time mapping, interval/gap cases, per-receiver missing-data results, automatic-data-change suppression, real CanvasChart controller wiring and initialization/cleanup of the shipped linked-ranges module using modeled DOM/Canvas primitives. Mapping/publication calculation-count assertions stop before ordinary dirty redraw. No new Mac/browser/AT or competitive performance result is claimed for this feature. The separately recorded Mac checks below apply only to their stated earlier fixture and hotfixes.

## Cumulative cloud regression checks (2026-10-14)

All **3,479/3,479 Node tests** passed with no failures, skips or cancellations. A fixed manifest covered all **173 test files exactly once**, in **nine short serial batches**, with zero missing/duplicate files, zero exit codes and verified log hashes. This was segmented completion, not a single monolithic invocation. The code under test was `423eb03654eefedca337a20a6154640d021d96a2`; the working changes were limited to the browser-QA documentation recorded here. No production code changed for this verification.

**400 ESM syntax checks**, strict TypeScript 5.9.3 and offline package consumer verification also passed.

This integrates the local demo, focus and CDP harness fixes rather than relying only on the earlier 3,417-test baseline. The cloud run did not launch an actual browser; the separate Mac browser evidence is scoped below. No additional remote push or registry publication was performed.

## First public source-tree checks (2026-10-13)

The sanitized BaroChart tree passed **2,554/2,554 serial Node tests** (355.397 seconds, zero failures/skips), all **356 source ESM syntax checks**, strict TypeScript 5.9.3 and offline local npm package installation/type/runtime checks. The local package is named `barochart`, licensed Apache-2.0 and remains `private: true` to prevent accidental registry publication. The two added branding tests verify package/example agreement and preserved legacy API identifiers. No product deadline was increased and no core test was removed to obtain this result.

The lower syntax-file count compared with the private checkpoint excludes frozen historical evidence copies and a private archive wrapper; it does not remove production modules. README core examples also executed under Node 24. Browser/native platform gaps below remain open. This successful run does not erase the prior watchdog failure.

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
- The Mac Chrome checks below cover selected real-browser flows. Screen-reader/assistive-technology behavior, other browsers, mobile browser UI and broad visual regression remain unverified. Cloud browser execution was blocked by local socket/reachability restrictions; no sandbox/security bypass was used.
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
