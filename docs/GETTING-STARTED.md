# Choose your first BaroChart integration

[한국어](GETTING-STARTED.ko.md) · [API](API.md)

Start with the local checkout. This is `0.3.0-dev`; npm, SwiftPM release tags and Maven Central artifacts have not been published. The examples use synthetic data and need no account or market-data key.

## Try the analysis workflow

From the repository root, with Node.js 22 or later:

```sh
npm run demo
```

Open [the main analysis demo](http://127.0.0.1:5173/examples/web/). Choose an indicator, draw a line, open **도형 관리**, then save **분석 파일 저장**. Change the chart and restore that file with **분석 파일 복원**. The file restores the captured bars, studies, drawings and visible range, and pauses the synthetic stream. [Workflow and file limits](ANALYSIS-DEMO.md).

For a smaller first render, open [the four-bar example](http://127.0.0.1:5173/examples/web/quickstart.html). These URLs work while the local demo server is running.

## Choose an integration

| Target | Runnable starting point | Mount, update and release ownership |
| --- | --- | --- |
| JavaScript / TypeScript | [Four-bar web example](../examples/web/quickstart.mjs) | Give the container a height; create the model/chart; apply a data event; call `chart.destroy({disposeModel: true})` when its owner ends. |
| Migrating from Lightweight Charts | [Candlestick conversion page](http://127.0.0.1:5173/examples/web/lightweight-migration.html) · [Guide](MIGRATING-FROM-LIGHTWEIGHT-CHARTS.md) | Converts numeric UTC seconds to milliseconds, requires an explicit volume source, and routes updates by time. It is a data recipe, not a drop-in adapter or a freshness protocol. |
| React web | [TypeScript consumer](../examples/react-web/README.md) | Use `AsterChart` from `barochart/react`; update through the ref; the adapter releases its owned model on unmount. Borrowed models remain app-owned. |
| SwiftUI / UIKit | [SwiftUI sample](../examples/swiftui-sample) and [iOS guide](IOS-GUIDE.md#before-the-first-release) | The app creates the engine on the main thread, calls `setBars`/`apply`, and closes the engine when its owner ends. The view borrows it. |
| Compose / Android View | [Compose sample](../examples/compose-sample) and [Android guide](ANDROID-GUIDE.md#before-the-first-release) | The app creates and updates the engine on its owner thread and calls `close()` when its owner ends. Disposing the view does not close the engine. |

### Plain web package

Create a source tarball from the repository root:

```sh
npm pack --ignore-scripts --pack-destination /tmp
```

In your app, install the emitted `barochart-0.3.0-dev.tgz` file, then import:

```sh
npm install /tmp/barochart-0.3.0-dev.tgz
```

```js
import {BarStore, ChartModel, createChart} from 'barochart';
```

Use the [complete first-chart source](../examples/web/quickstart.mjs), replacing its relative import with the package import above. The example includes a live-bar replacement and page-exit cleanup. [Package details](PACKAGE-CONSUMPTION.md).

### React consumer

```sh
cd examples/react-web
npm ci
npm run typecheck
npm start
```

Open `http://127.0.0.1:5174`. This installs the example's locked development dependencies; it is separate from the dependency-free plain web demo. `AsterChart` is the compatibility export name, not a React Native component.

### SwiftUI sample

Open `examples/swiftui-sample/BaroChartSample.xcodeproj` in Xcode, select the `BaroChartSample` scheme and an iOS Simulator, then Run. The checked-in project references the SDK locally; no public tag is required. XcodeGen is needed only if you regenerate the project.

Use **Pause**, **Line**, **Save** and **Restore** to try the native sample. Its Save stores workspace metadata, not bars: keep the same source for Restore. [iOS lifecycle and data events](IOS-GUIDE.md).

### Compose sample

Open `examples/compose-sample` in Android Studio and run the `app` configuration on an API 26+ device or emulator. Its included Gradle build resolves the local SDK. Android toolchain/dependency setup may need downloads.

Use **Pause**, **Line**, **Save** and **Restore**. As on iOS, the native sample's workspace expects matching bars. [Android lifecycle and data events](ANDROID-GUIDE.md).

## Connect your feed

Use the [executable HTTP/stream recipe](FEED-INTEGRATION.md) for snapshot/live overlap, sequence gaps, cancellation and reconnect. Run `node scripts/serve-feed.mjs` to try the local fixture.

## Check your first integration

1. A chart appears inside a container with a nonzero size.
2. An update replaces the last bar at the same UTC millisecond timestamp; an append uses a later timestamp.
3. An invalid event is reported without changing the accepted data.
4. Leaving/unmounting the screen releases what it owns; coming back creates a usable chart.

The host owns feeds, subscription cancellation and storage. The SDK does not place orders or supply market data. Start with a known dataset before adding your network feed. [Data contract](DATA.md) · [Streaming recipes and boundaries](INGESTION.md) · [Current support matrix and release gates](SUPPORT.md).
