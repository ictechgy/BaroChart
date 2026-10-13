# BaroChart development-preview validation

This first public source tree is derived from the private 0.2.13 development checkpoint. It is not a stable SDK release or a claim of commercial feature/performance parity. Historical platform runs do not certify later changes.

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

## Open validation gaps

- Recent Swift facade/workspace ownership changes received static review, but have not been compiled or executed with Swift/Apple JavaScriptCore in this validation environment.
- Recent Android host changes have not been built/run against the real Android SDK/JNI or on devices here.
- Latest keyboard exploration, focus, live announcements and visual behavior have controller/fake-DOM regression coverage, but no recent real-browser/screen-reader verification. Browser launch was blocked by the environment's local socket restriction. No browser sandbox/security bypass was used.
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
