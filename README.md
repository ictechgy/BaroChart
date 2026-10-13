# BaroChart (바로차트)

Financial charts built around your own data: a DOM-free Float64 core, Canvas and WebGL2 rendering, an optional React adapter, and Apple/Android native integrations.

[한국어](README.ko.md) · [API reference](docs/API.md) · [Validation status](docs/PUBLIC-VALIDATION.md)

**Version 0.2.13 is a development preview.** Source is available under Apache-2.0; the npm package has not been published. Recent native host changes and browser interaction changes still need platform validation. See the [current validation limits](docs/PUBLIC-VALIDATION.md) before adopting this version.

## What you can build

- Candlestick, OHLC, line, area and histogram charts with multiple panels, independent price axes, pan/zoom and streaming updates.
- Studies using **35 built-in indicators**, including SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Ichimoku and session-aware VWAP. Numerical seeds, warm-up and undefined values have [documented contracts](docs/INDICATORS.md).
- Annotations using **14 drawing tools**, with time/price anchors, selection, editing, locking and undo/redo.
- Data-driven views with historical corrections, ordered ingestion batches, screen-independent queries and explicit session-based OHLCV resampling.
- Portable chart configuration, drawings and study settings, with explicit dataset ownership and validation.

The core and web renderers have no npm runtime dependencies. React is an optional peer used only by the `/react` entry point. Market data feeds, exchange calendars and trading execution belong to the host application.

## Try the demo

Use **Node.js 22 or later**. The current cloud validation used Node.js 24.19.0. The basic demo and core tests need no dependency installation.

```sh
git clone https://github.com/ictechgy/BaroChart.git
cd BaroChart
npm run demo
```

Open [http://127.0.0.1:5173/examples/web/](http://127.0.0.1:5173/examples/web/). The demo uses deterministic **synthetic data**, including stock-like and small-price fixtures. It lets you explore renderers, indicators, drawings, themes and live-update simulation.

Other examples on the same server:

- [Independent price axes](http://127.0.0.1:5173/examples/web/axes.html)
- [Financial coordinates and time alignment](http://127.0.0.1:5173/examples/web/financial.html)
- [Session studies and custom modules](http://127.0.0.1:5173/examples/web/analysis.html)

Run tests separately:

```sh
npm test
# Runs: node --test --test-concurrency=1 test/*.test.mjs
```

## Your first chart

In the checkout, save this as `examples/web/quickstart.html`:

```html
<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>BaroChart quick start</title>
  <div id="chart" style="height: 420px"></div>
  <script type="module" src="./quickstart.mjs"></script>
</html>
```

Save the following as `examples/web/quickstart.mjs`, then open `/examples/web/quickstart.html` on the demo server:

```js
import { BarStore, ChartModel, createChart } from '../../src/index.mjs';

const store = new BarStore([
  { time: 1700000000000, open: 100, high: 103, low: 99, close: 102, volume: 500 },
  { time: 1700000060000, open: 102, high: 104, low: 101, close: 103, volume: 650 },
  { time: 1700000120000, open: 103, high: 105, low: 102, close: 104, volume: 700 },
  { time: 1700000180000, open: 104, high: 106, low: 103, close: 105, volume: 800 },
]);

const model = new ChartModel({ store });
model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
model.indicators.add('ema3', 'ema', { period: 3 });
model.addSeries({
  id: 'ema3', type: 'line', panel: 'price',
  indicator: 'ema3', color: '#f0b755',
});

const chart = createChart(document.getElementById('chart'), model, {
  renderer: 'canvas',
});

// Replace the current bar. A later timestamp appends a new bar.
store.upsert({
  time: 1700000180000, open: 104, high: 107,
  low: 103, close: 106, volume: 900,
});
chart.setTool('trendline');
```

Give the container a real height. On unmount, call `chart.destroy({ disposeModel: true })` if the chart owns its model. Shared models need a separate owner responsible for final disposal. Stop application-owned timers and data subscriptions as well.

Canvas is the default. Set `renderer: 'webgl2'` to opt into WebGL2; initialization/render failures and context loss can fall back to Canvas. Performance depends on the scene and device, and text shaping and line joins are not pixel-identical across renderers.

## Use it in an application

There is **no published npm release yet**. Build a local tarball from this checkout:

```sh
mkdir -p /tmp/barochart-pack
npm pack --ignore-scripts --pack-destination /tmp/barochart-pack

# In your application:
npm install /tmp/barochart-pack/barochart-0.2.13.tgz
```

After installing that tarball, replace the source import above with:

```js
import { BarStore, ChartModel, createChart } from 'barochart';
```

Available entry points:

- `barochart/core`: DOM-free data, indicators, models, drawings and calculation APIs
- `barochart/canvas` and `barochart/webgl`: browser renderers
- `barochart/worker`: worker-backed preparation and calculation APIs
- `barochart/worker-entry`: entry point for a separately bundled worker
- `barochart/react`: optional React web adapter

TypeScript declarations are included. Use `/core` for Node projects without DOM types. Examples, tests and benchmarks live in the repository; they are not included in the npm tarball.

### React

The adapter currently retains the export name `AsterChart`:

```jsx
import { AsterChart } from 'barochart/react';

export function PriceChart({ bars }) {
  return <AsterChart data={bars} style={{ height: 420 }} />;
}
```

React 18.3.1 or 19 is an optional peer; the application supplies ReactDOM. See the [React integration contract](docs/REACT.md) for streaming updates, `dataRevision`, model ownership, cleanup and SSR limits. The [TypeScript example](examples/react-web/README.md) has its own pinned development dependencies and requires registry access for the initial `npm ci`.

### Native

Apple integration uses JavaScriptCore and CoreGraphics with SwiftPM. Android uses QuickJS, JNI and Android Canvas with an Android library/AAR build path. These renderer paths do not embed a WebView.

See the [Swift SDK](docs/SWIFT-SDK.md), [Android SDK](docs/ANDROID-SDK.md) and [native integration guide](docs/NATIVE.md). Recent Swift and Android host additions have **not** been compiled and run against their actual SDKs/devices in the current validation environment. Earlier platform results do not verify those later changes. React Native and Flutter adapters are not provided.

### Compatibility names

BaroChart was previously named Aster. The npm package is now named `barochart`, while these existing identifiers are deliberately retained:

- React: `AsterChart`, `AsterChartHandle`
- Swift: `AsterNative`, `AsterEngine`, `AsterChartView`
- Android: `dev.aster.charts` and its existing class/JNI names
- Serialized document schemas and browser events: `aster.*` and `aster:*`

Use those API names as documented. Do not rename saved schema identifiers to match the product branding.

## Important contracts

- **Time and numbers:** OHLCV input uses finite numbers and strictly increasing UTC Unix timestamps in integer **milliseconds**. Storage is Float64, not arbitrary-precision decimal arithmetic. The default time axis spaces trading bars evenly and compresses missing periods. See [data ownership and input rules](docs/DATA.md).
- **Array ownership:** OHLCV object/column inputs are copied. Store columns and returned indicator views are read-only by contract. External `series.values` are borrowed, not copied; reapply them through the supported setter to invalidate caches after changes.
- **Indicator history:** Studies run on source bars. Seeds, warm-up `NaN` gaps, session boundaries and zero-denominator policies matter when comparing results. See [indicator math](docs/INDICATORS.md) and [session studies](docs/SESSION-STUDIES.md).
- **Async costs:** Worker APIs support cancellation, stale-source checks and logical memory budgets. Snapshotting, validation and allocations still cost time; offloading can improve responsiveness while increasing total wall time and memory. Budgets are not process RSS limits or guaranteed maximum UI blocking times.
- **Retention is explicit:** `api.compactData({ keepLastBars, studyHistory: 'restart' })` is synchronous maintenance. It restarts every study on the retained suffix, so results may differ from the tail of a full-history calculation. It requires the documented ownership/ingestion conditions and does not automatically evict data. Read the [compaction contract](docs/DATA-COMPACTION.md) first.
- **Persistence needs source data:** Workspaces save portable configuration, not OHLCV or a complete application session. The host must provide the intended dataset and matching binding when restoring. See [workspace ownership and limits](docs/WORKSPACES.md).

## Documentation

- [API, drawing tools and lifecycle](docs/API.md) · [independent price axes](docs/INDEPENDENT-AXES.md)
- [Data queries](docs/DATA-EXPLORER.md) · [ordered ingestion](docs/INGESTION.md)
- [Indicator parameter edits](docs/INDICATOR-PARAMETERS.md) · [async parameter edits](docs/ASYNC-INDICATOR-PARAMS.md) · [custom modules](docs/INDICATOR-MODULES.md)
- [OHLCV resampling](docs/RESAMPLING.md) · [async resampling](docs/ASYNC-RESAMPLING.md)
- [Architecture](docs/ARCHITECTURE.md) · [render layers](docs/RENDER-LAYERS.md)
- [Current validation status](docs/PUBLIC-VALIDATION.md) · [contributing](CONTRIBUTING.md)

Some detailed contract documents retain historical version notes and Aster-era names. The public validation summary distinguishes those older results from the current preview.

## Validation and limitations

The pre-branding Linux/Node baseline passed **2,551 of 2,552 tests**. One dry-run CLI hit a 15-second watchdog; its unchanged test file then passed **131/131** in isolation. The full-suite failure remains unresolved. This is not an all-green release certification.

Recent browser focus, keyboard exploration and visual changes need real-browser and assistive-technology validation. Standalone QuickJS tests and Java tests using stubbed Android types do not substitute for native SDK builds or device runs. There is no verified claim of universal performance, commercial-product parity or physical-device FPS.

To run the available local checks:

```sh
npm test
npm run check
# With a separately installed TypeScript 5.9+ compiler:
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:package
```

Browser and native test scripts require their documented browsers, SDKs and host permissions. For measured results, outstanding gaps and how to interpret timings, use [PUBLIC-VALIDATION.md](docs/PUBLIC-VALIDATION.md).

## License

BaroChart is licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licensing notes](docs/LICENSING.md) for attribution and separately licensed components. The npm package remains `private: true` until a registry release is explicitly prepared.
