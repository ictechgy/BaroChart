# Local package consumption

BaroChart is distributed here as source. An npm registry release has not been made. Run `npm pack --ignore-scripts` and install the resulting local `barochart-0.2.13.tgz` in a consumer project.

The root and `/core`, `/canvas`, `/webgl`, `/worker`, `/worker-entry`, optional `/react` exports include ESM and TypeScript declarations. Use `/core` for DOM-free Node consumers. React remains an optional peer dependency; its existing `AsterChart` component name is retained for compatibility.

`TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:package` builds a local tarball, installs it offline in a temporary consumer and checks export/type/runtime contracts. It does not publish or require React.

The command creates the ignored `artifacts/` directory when needed and writes `artifacts/npm-package-verification.json`. To select a different report location, use `npm run check:package -- /path/to/reports/package.json`; missing parent directories are created recursively. Filesystem permission/path errors are propagated, and the selected report file may be overwritten. Temporary package installation stays outside the repository.

The larger `scripts/test-package-consumers.mjs` matrix additionally needs pinned development bundlers and optional React versions. Network installation occurs only with its explicit `--allow-network` flag. Old baseline archives are optional external inputs, not included in this public repository. Their original `aster-financial-charts` package name is retained by the isolated baseline consumer.

<!-- package-footprint:start -->
No new public-tree package footprint matrix has been recorded. Generate it from the actual source and pinned consumer tools; do not treat historical private checkpoint measurements as this release's package size.
<!-- package-footprint:end -->
