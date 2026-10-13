# Contributing to BaroChart

BaroChart is a development-preview financial chart engine, licensed under Apache-2.0. Contributions should preserve numerical precision, explicit data ownership, bounded resources and failure/cleanup behavior.

- Keep the calculation core independent of DOM and OS renderers. Source OHLCV and time/price drawing anchors use Float64 values; display geometry is a separate concern.
- Document input ordering, UTC milliseconds, warm-up, NaN/overflow, correction and session semantics. Compare incremental results with independent full-history oracles.
- Add red/green regressions for bugs. Cover cancellation, stale results, callback reentry, disposal and held-buffer ownership when relevant.
- Run `npm test`, `npm run check`, and the relevant type/package checks. See [public validation](docs/PUBLIC-VALIDATION.md) for unresolved coverage and required platform tooling.
- Performance claims require the same data, viewport, renderer, device-pixel ratio and hardware, with raw measurements and stated boundaries. Report regressions and total-time/memory tradeoffs. Do not equate CPU submission with display FPS.
- Keep credentials, local user paths, generated binaries, raw private traces, caches and large archives out of commits. Retain licenses/notices for vendored code. Do not copy restricted third-party implementations.
- Public API changes need compatibility notes and tests. Existing `Aster*`, `dev.aster.charts` and `aster.*` protocol identifiers are retained compatibility names; do not rename them casually.

Issue reports should include a minimal synthetic-data reproduction, platform/runtime versions, expected and actual behavior, and whether the issue uses a browser renderer, core-only API or native host. Do not attach credentials or private market/customer data.
