# Rust-first WASM web backend

The development package's default export is an asynchronous Rust/WASM chart factory. Existing named JavaScript APIs keep their synchronous behavior, and `barochart/javascript` provides an explicit compatibility entry. Rust never silently falls back to JavaScript: an unavailable capability or failed worker construction is reported to the caller.

The Rust engine, model state, indicators, drawings, interaction state, and scene calculation live in a dedicated Web Worker. The browser main thread owns the DOM, accessibility tree, Canvas/WebGL2 surface, and packet renderer. A `RustSession` owns one actor and at most one attached `RustChartView`; closing either side is explicit, and closing a view does not close its session.

## Rust-primary entry point

The root import is SSR-safe: importing it does not fetch or instantiate WASM and does not create a Worker. The returned owner closes its chart, session and Workers through one idempotent `destroy()` call.

```js
import createBaroChart from 'barochart';

const owner = await createBaroChart(document.querySelector('#chart'), {
  prepare: {kind: 'columns', columns, visibleBars: 200},
  view: {renderer: 'canvas'}, // or 'webgl2'
});

await owner.destroy();
```

The factory snapshots control options before its first asynchronous boundary. Large prepared columns remain caller-owned until `prepareData` begins, where the established session path makes its single owned copy. Aborting or failing during initialization cleans up every session and view already created.

## Low-level Rust entry points

Use `barochart/wasm` when the application needs to own the session and view separately:

```js
import {loadRustBackend, createRustChart} from 'barochart/wasm';

const backend = await loadRustBackend();
const session = await backend.createSession({count: 0});

const columns = {
  time: new Float64Array(),
  open: new Float64Array(),
  high: new Float64Array(),
  low: new Float64Array(),
  close: new Float64Array(),
  volume: new Float64Array(),
};

await session.prepareData({kind: 'columns', columns, visibleBars: 200});
const chart = await createRustChart(document.querySelector('#chart'), session, {
  renderer: 'canvas', // or 'webgl2'
});
```

`loadRustBackend({wasmURL, workerURL, signal})` accepts application-provided asset and module-worker URLs when a bundler requires explicit asset handling. `backend.createSession({count, options})` creates an independent worker and memory. `prepareData` and `recreate` build a private candidate worker, validate it, render a first frame, and promote it atomically. The source worker remains active until promotion succeeds.

For a saved workspace, use `createSessionFromWorkspace` with the exact store descriptor (`length`, `maxBars`, `timeframeMs`, `timeOrigin`, `version`, and `timeVersion`) and actual chart size. Do not invent defaults for those fields. `createSessionFromMigration` consumes a validated workspace/UI capture produced by the migration helpers.

## State and mutations

Use `session.snapshot()` or `session.subscribe()` for immutable Rust-authored presentation state. `query('web.presentationState')`, `query('web.configuration')`, `query('web.drawingsState')`, and `query('web.indicatorCatalog')` are bounded read-only queries. Large columns use `readDataColumn` or the explicit bounded `exportColumns` API; returned typed arrays are owned copies.

The supported chart interaction calls are exposed through `invoke`/the view (`nativePointer`, `nativeWheel`, `nativeKey`, `nativeTool`, `nativeHoverExit`, `nativeResize`, and `nativeView`). Higher-level `command` calls cover drawing, view, theme, series, ingestion, and readout operations. Parameter updates use the asynchronous two-worker path:

```js
await session.setIndicatorParams('ema', {period: 20}, {
  onProgress: progress => console.log(progress.stage),
});
```

If a mutation reply or authoritative snapshot cannot be decoded, the session is quarantined or marked `requiresResync`; mutations are blocked until `resync()` succeeds. The runtime does not retry an operation after an uncertain publish. A failed job is cleaned up explicitly, including its private worker.

JavaScript indicator source registration remains JavaScript-only. Rust reports `JAVASCRIPT_BACKEND_REQUIRED`; there is no automatic fallback or source evaluation in the Rust worker.

## Demo and migration

The main example selects Rust when the URL has no backend option and keeps an explicit JavaScript/Rust engine selector. `?backend=javascript` is a persistent compatibility choice. Both directions use a staged root and a private candidate: data, indicator configuration, drawing and layout history, drawing selection/serial, viewport, theme, tool/text, crosshair snap, and drawing magnet are validated before the old owner is retired. Layout undo/redo retains generated resources still referenced by drawing history or other series. A running ingestion job must reach the documented paused, empty safe point before migration.

Workspace migration is separate from the analysis-file format. Analysis v1 keeps its existing exact workspace text, signed-zero handling, 250,000-bar limit, and 32 MiB file limit. Custom JavaScript source indicators cannot be migrated to Rust and fail with the explicit backend-required error.

## Packaging and deployment

The package exports these paths:

- `barochart` default export / `createBaroChart` — Rust-owned asynchronous factory.
- `barochart/javascript` — explicit synchronous JavaScript compatibility surface.
- `barochart/wasm` — backend, session, chart view, and public types.
- `barochart/wasm-asset` — typed default WASM URL helper.
- `barochart/wasm-worker-entry` — module-worker entry for explicit bundler output.
- `barochart/wasm-migration` — JavaScript↔Rust workspace/UI migration helpers.

The production module is built with the pinned Rust 1.98.1 toolchain, `std` plus `panic_unwind`, and WebAssembly exception handling. Use Node 22 for the build and verification tools. On a fresh checkout, prepare the pinned public dependencies once:

```sh
(cd rust && rustup toolchain install --no-self-update)
rustup component add --toolchain 1.98.1 rust-src
node scripts/rust/cargo.mjs fetch --locked
python3 scripts/rust/prepare-wasm-eh.py --download
```

The module and manifest are generated files excluded from Git. Build and check them before creating a local npm tarball. With the dependency cache prepared, these steps are offline:

```sh
python3 scripts/rust/prepare-wasm-eh.py --offline
node scripts/rust/build-web-wasm.mjs --offline
node scripts/rust/build-web-wasm.mjs --check
```

The development server serves `.wasm` as `application/wasm` and adds only the narrow `wasm-unsafe-eval` permission needed for WebAssembly compilation. JavaScript `eval` remains disabled; worker execution is restricted to the application origin. With esbuild, emit the worker as a separate module and pass an explicit `workerURL`/`wasmURL` when the default relative URL is not preserved. The installed npm tarball's Rust-primary factory was executed in Headless Chrome 157 directly and through Vite 7.3.7 and esbuild 0.28.2 production output with 10,000 OHLCV rows; all created Workers terminated. Verification tools are pinned in [test/toolchains/web-wasm](../test/toolchains/web-wasm/package-lock.json); they are not runtime dependencies.

Run `npm run test:wasm:browser` for the real browser feature matrix, `node test/web-bootstrap-failures-browser.mjs` for transition failures, and `npm run test:wasm:package -- --tools-dir <local-verification-tools>` for offline tarball consumption. The package check requires both bundlers and does not count a missing tool as a pass.

The web path has no runtime npm dependency. It is a development preview and is not published by these checks. Browser evidence currently covers production WASM in Chrome 156, including the 100,000-bar JavaScript↔Rust flow, all 16 drawing tools, and a 390 CSS-pixel layout with no horizontal overflow. Safari 27.2 was present but its automation was disabled; Firefox was not installed. Touch hardware and assistive-technology certification are not implied.

[Measured SDK startup, rendering, input, and memory results](measurements/web-rust-wasm.md) cover 10k/100k/1m inputs and three repeats. They distinguish Worker transport from synchronous submission and render events from physical display latency. Their historical default decision remains part of that dated measurement; the development package now recommends the Rust-primary entry described above.

The existing named `createChart`, `ChartModel`, `ChartAPI` and `barochart/react` `AsterChart` contracts remain JavaScript compatibility APIs. JavaScript source indicators also require that path. Android physical-device raw-PSS/soak and manual VoiceOver/TalkBack acceptance remain native release gates; see [RUST-BACKEND.md](RUST-BACKEND.md).
