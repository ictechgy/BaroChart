# Onboarding and main analysis workflow — 2026-11-03

Base: main `4283d56`; implementation branch `feat/onboarding-analysis-workflow`.
This change implements the first agreed product-improvement bundle: first integration and a complete main-demo analysis flow.

## Result

- English/Korean first-integration guide routes developers to the existing plain web, React, SwiftUI and Compose consumers, with mount/update/release ownership. Local preview distribution is explicit; the stale `0.2.13` tarball example is corrected.
- The main demo binds the existing drawing-object panel to each accepted model/renderer. A workflow link opens it; other example links are collapsed to reduce first-screen clutter.
- An example-owned analysis file contains captured OHLCV, the existing portable workspace and demo settings. Restore runs the existing workspace Worker, checks the current owner, mounts a candidate and retires the old chart after acceptance. Successful restore pauses the synthetic stream.
- File limits: 250,000 bars / 32 MiB UTF-8, bounded nesting, strict fields and validated OHLCV/source extent/market binding. Column negative zero is preserved. Invalid input, cancellation, supersession, source/configuration/drawing/view changes and navigation retain or retire the correct owner. Drawing/layout undo histories are not restored. SDK workspace schemas and source modules are unchanged.

## Executed checks

| Check | Result |
| --- | --- |
| Node whole suite, TypeScript compiler configured | 5,908 passed, zero failures/cancellations/skips |
| Focused analysis/readiness/page lifecycle | 72 passed |
| ESM syntax | 644 modules parsed |
| Strict TypeScript 5.9.3 | Passed |
| Offline installed npm consumer | Passed; 328 files, 1,784,833 packed bytes, 6,900,087 unpacked bytes |
| Existing offline TypeScript AST source scan | Zero findings; narrow syntax rules on `src/`, not a security certification |
| Documentation | 143 relative links resolved before the final report; whitespace/diff checks passed |
| Actual Chrome via isolated agent-browser | 13 behavioral/layout checks passed; zero page errors |

Chrome checks add MACD through the real UI/Worker, commit a horizontal drawing using pointer input, open the object manager, hide/delete checked drawings, download an analysis, modify the chart and upload/restore the file. All captured column values are compared with `Object.is`; studies, drawing visibility, panels, theme and viewport match. Invalid upload retains the current model. Renderer replacement binds one fresh manager. Widths 1440, 390 and 320 have no horizontal overflow; dark/light screenshots were inspected.

The optional agent-browser domain-restriction launch produced `Worker failed` before the chart mounted. A fresh isolated ordinary launch executed the same Worker successfully. No application fallback or Worker bypass was added. This observation identifies the affected launch condition, not the internals of the browser tool.

## Reproduction and evidence

```sh
TSC_PATH=/path/to/typescript/lib/tsc.js node --test --test-concurrency=1 test/*.test.mjs
node --test test/demo-analysis-session.test.mjs test/demo-readiness.test.mjs test/demo-page-lifecycle.test.mjs
npm run check
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:package
npm run demo
```

Local ignored artifacts: `artifacts/onboarding-analysis-20261103/` contains the TAP logs, browser command runner/results, downloaded synthetic file, and desktop/mobile/light/drawing-manager screenshots. Public workflow instructions: [analysis demo](../ANALYSIS-DEMO.md).

Native source and sample code did not change; native builds, physical touch and screen-reader checks were not rerun for this bundle. Chrome mobile viewport checks are not physical-device qualification. Initial file parsing/export remain bounded synchronous UI work. No registry publication, release tag or deployment occurred.
