# Third-party notices

BaroChart's own code is licensed under Apache-2.0; see [LICENSE](LICENSE)
and [NOTICE](NOTICE). The separate licenses below continue to apply to the
corresponding third-party code. This inventory does not relicense it.

## Production source and optional framework integration

- **QuickJS 2026-06-04, MIT.** Bundled C/H source under
  `native/android/quickjs/` is compiled into the Android JNI runtime.
  Preserve the original [LICENSE](native/android/quickjs/LICENSE), source
  headers, [VERSION](native/android/quickjs/VERSION), and
  [PROVENANCE.json](native/android/quickjs/PROVENANCE.json).
  The source archive is identified by SHA-256 in that provenance file.
  Upstream: <https://bellard.org/quickjs/>.
  Android AAR builds include the original MIT license as
  `assets/licenses/QUICKJS-LICENSE.txt`, the BaroChart Apache-2.0 license as
  `assets/licenses/LICENSE.txt`, and [NOTICE](NOTICE) as
  `assets/licenses/NOTICE.txt`. NOTICE also preserves the copyright lines
  in the selected QuickJS source files. Distributing a separately built
  JNI library or APK requires carrying these applicable notices with it.
- **React, MIT, optional peer dependency.** Only the `/react` entry requires
  React (`^18.3.1 || ^19.0.0`). React is not bundled into BaroChart's source
  package. React DOM is a dependency of the example/consumer application,
  not the base SDK. Applications distributing React, React DOM, or scheduler
  must retain their upstream MIT notices.
  Upstream: <https://github.com/facebook/react/blob/main/LICENSE>.
- The base JavaScript core and web renderers declare no external npm runtime
  dependencies. Apple and Android platform frameworks are referenced through
  platform APIs; their SDK/framework binaries are not included in this source
  repository. Platform/toolchain terms continue to apply separately.

## Optional benchmark comparator

The files in `benchmarks/vendor/` are used only by the local comparison
benchmark. Production `src/` and native code do not import the comparator;
the npm package file selection excludes `benchmarks/`.

- **TradingView Lightweight Charts 5.2.1, Apache-2.0.** Preserve the original
  bundle header and [LICENSE](benchmarks/vendor/LICENSE.lightweight-charts),
  [NOTICE](benchmarks/vendor/NOTICE.lightweight-charts),
  [README](benchmarks/vendor/README.lightweight-charts.md), and
  [package metadata](benchmarks/vendor/package.lightweight-charts.json).
  Its upstream attribution is:

  TradingView Lightweight Charts™
  Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/

  The upstream bundle header separately says Copyright (c) 2026 TradingView,
  Inc.; both original notices are preserved. The benchmark page displays the
  attribution and a TradingView link even though its chart logo is disabled.
  Keep that visible attribution and link if publishing the comparator page.
  Upstream: <https://github.com/tradingview/lightweight-charts/tree/v5.2.1>.
- **fancy-canvas 2.1.0, MIT.** Included inside the standalone comparator,
  not a BaroChart runtime dependency. Preserve
  [LICENSE.fancy-canvas](benchmarks/vendor/LICENSE.fancy-canvas) and
  [its provenance](benchmarks/vendor/PROVENANCE.fancy-canvas.json).
  Upstream version: <https://github.com/tradingview/fancy-canvas/tree/2.1.0>.
- **tslib helper portions, BSD Zero Clause.** The comparator's upstream
  README identifies embedded helpers as Copyright (c) Microsoft Corporation
  under the BSD Zero Clause license. That original attribution is retained
  in the vendor README. The upstream helper license is
  <https://github.com/microsoft/tslib/blob/v2.8.1/LICENSE.txt>.

## Example and development dependencies

The tracked `examples/react-web/package-lock.json` records package versions,
integrities and declared licenses. Its third-party package inventory is:

- Example application runtime: React 19.3.0, React DOM 19.3.0 and
  scheduler 0.28.0, all MIT.
- Development/type tooling: `@types/react` 19.3.0, `@types/react-dom` 19.3.0,
  csstype 3.2.3 and esbuild 0.28.2, all MIT; TypeScript 5.9.3, Apache-2.0.
- The lock also contains 26 optional, platform-specific `@esbuild/*`
  packages at 0.28.2, all MIT. These are development tool binaries, not
  runtime dependencies of BaroChart.
- Separate package-consumer tests pin esbuild 0.28.2, Vite 7.3.7 and
  Rollup 4.64.5 (MIT), TypeScript 5.9.3 (Apache-2.0), and React 18.3.1/19.3.0
  consumer matrices. Their generated lockfiles enumerate each test
  installation's transitive dependencies. They are validation tooling,
  not bundled BaroChart source.

`node_modules`, tool binaries and generated example bundles are excluded
from the source repository. Installing these dependencies is not the same
as redistributing them. When distributing a built example or application,
preserve the license/copyright notices of the code actually included in its
output; minifier legal comments alone should not be assumed to include
complete upstream license texts. The React example preserves legal comments
at the end of its generated JavaScript.

## Preservation rules

- Keep third-party copyright, license, attribution and applicable NOTICE
  files when redistributing their source or binaries.
- Preserve all vendored originals. If a vendored Apache-2.0 file is modified,
  mark the modification prominently in that file.
- BaroChart's Apache-2.0 license does not grant rights to third-party
  trademarks or imply endorsement by TradingView, React, or QuickJS authors.
- Public source publication does not imply npm publication. The package's
  `private: true` publishing guard is independent of its Apache-2.0 license.
