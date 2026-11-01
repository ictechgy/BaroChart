# BaroChart for iOS

BaroChart draws financial charts natively: the chart core runs in JavaScriptCore and the UI is drawn with Core Graphics. It is not a WebView. Your app owns the data and the engine; BaroChart never fetches market data. [한국어](IOS-GUIDE.ko.md)

## Support

| Item | Value |
| --- | --- |
| Minimum OS | iOS 17 (macOS 13 for engine-only use and tests) |
| Swift | Swift 6 toolchain; the library builds in Swift 5 language mode and is used from Swift 6 apps |
| UI | SwiftUI `BaroChartView`, UIKit `BaroChartUIView` |
| Distribution | Swift Package Manager (`BaroChart` product) |
| Verified on | iOS 27 Simulator and macOS JavaScriptCore; physical-device numbers are in [measurements](#measurements-and-limits) |

## Installation

### Swift Package Manager

Releases are tagged `X.Y.Z` on the repository. Once a release tag is published, add:

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/ictechgy/BaroChart.git", from: "X.Y.Z")
],
targets: [
    .target(name: "MyApp", dependencies: [.product(name: "BaroChart", package: "BaroChart")])
]
```

In Xcode use **File › Add Package Dependencies…** with the same URL. The package checkout is about 19 MB because examples and documentation live in the same repository.

### Before the first release

No release tag is published yet. Until then depend on a local checkout with `.package(path: "../BaroChart")`, as [examples/swiftui-sample](../examples/swiftui-sample) does.

## Quick start (SwiftUI)

Create the engine on the main thread in an object your app owns, then pass it to `BaroChartView`. Timestamps are UTC epoch milliseconds.

```swift
import BaroChart
import Observation
import SwiftUI

@MainActor @Observable
final class PriceChartModel {
    let engine: BaroChartEngine
    var errorText: String?

    init(bars: [BaroChartBar]) throws {
        engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars(bars)
        try engine.addIndicator(.ema(period: 20), id: "ema20")
        try engine.addSeries(BaroChartSeries(id: "ema20-line", type: .line, indicator: "ema20", color: "#f0b755"))
        try engine.fit()
    }
}

struct PriceChartScreen: View {
    let model: PriceChartModel

    var body: some View {
        BaroChartView(engine: model.engine, onError: { model.errorText = $0.message })
            .frame(height: 320)
    }
}
```

`BaroChartEngineOptions()` creates one unlabeled `price` panel with a candlestick series. The low-level `BaroChartEngine()` initializer builds a labeled demonstration chart; prefer `BaroChartEngine(options:)` in apps.

## UIKit

```swift
import BaroChart
import UIKit

final class ChartViewController: UIViewController {
    private var engine: BaroChartEngine!
    private var chartView: BaroChartUIView!

    override func viewDidLoad() {
        super.viewDidLoad()
        do {
            engine = try BaroChartEngine(options: BaroChartEngineOptions())
            chartView = BaroChartUIView(engine: engine, frame: view.bounds)
            chartView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            chartView.onError = { error in print("Chart error: \(error)") }
            view.addSubview(chartView)
        } catch {
            print("Chart setup failed: \(error)")
        }
    }

    /// Call when the screen no longer needs the chart, for example before dismissing it.
    func tearDown() {
        chartView.dispose()
        do { try engine.close() } catch { print("Chart close failed: \(error)") }
    }
}
```

`dispose()` releases only the view. Close the engine yourself when its owner goes away.

## Data and streaming

```swift
try engine.setBars(history)                 // replace everything
try engine.apply(.update(currentBar))       // same time as the last bar
try engine.apply(.append(nextBar))          // later than the last bar
try engine.apply(.correction(fixedBar))     // replace an existing bar
try engine.apply(.prepend(olderBars))       // older history
```

An invalid event, such as an `update` whose time is not the last bar's time or a bar with a non-finite price, throws `BaroChartError` with code `.invalidArgument` and leaves the data unchanged.

## Indicators, drawings and themes

```swift
try engine.addIndicator(.rsi(period: 14), id: "rsi14")
try engine.addSeries(BaroChartSeries(id: "rsi14-line", type: .line, panel: "rsi", indicator: "rsi14"))
let rsi = try engine.indicatorValue(id: "rsi14", index: 199)

try engine.setTool(.trendline)              // touch input now draws trend lines
let lineID = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: lastTime, price: 101)]))
try engine.deleteDrawings(ids: [lineID])
try engine.undo()

try engine.setTheme(.light)
```

`BaroChartIndicatorKind` lists the 35 built-in indicators and `BaroChartDrawingTool` the 16 drawing tools. Add panels such as `rsi` through `BaroChartEngineOptions(panels:)`.

## Saving and restoring

A workspace stores chart settings, indicators, series and drawings, not your bars. Restore it onto the same bars it was saved with; a different dataset binding or a changed bar range is rejected.

```swift
let binding = BaroChartDatasetBinding(key: "AAPL:1m", revision: "42", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
let document = try engine.saveWorkspace(binding: binding)
// later, with the same bars loaded:
try await engine.restoreWorkspace(document, binding: binding)
```

Cancelling the surrounding task cancels the restore and throws `.cancelled`; the engine stays usable. Documents use the portable `aster.workspace` schema, so files saved by earlier versions still load.

## Threading and lifecycle

- An engine belongs to the thread that created it. Engines attached to a view must be created on the main thread.
- Calls from another thread throw `.wrongThread` instead of crashing. Views and `BaroChartView` are main-actor types.
- The view pauses rendering in the background and resumes when the app becomes active.
- `BaroChartView` never closes the engine. Close it when its owner is released.

## Error handling

Typed API methods throw only `BaroChartError`:

```swift
do {
    try engine.apply(.update(bar))
} catch let error as BaroChartError {
    switch error.code {
    case .invalidArgument: showWarning(error.message)
    case .engineClosed: recreateEngine()
    default: log("\(error.code.rawValue): \(error.message) — \(error.recovery)")
    }
}
```

Failures that cannot be thrown, such as drawing a closed engine, go to `onError` on `BaroChartView` or `BaroChartUIView`.

## Low-level API

Dictionary-based methods such as `engine.command(_:_:)` remain public for advanced features (ingestion queues, async preparation, compaction, data exploration). They are **advanced and may change within 1.x**, keep their own error types, and are documented in [SWIFT-SDK.md](SWIFT-SDK.md). The typed API, views and `BaroChartError` are the stable surface.

## Privacy manifest

The package ships `PrivacyInfo.xcprivacy`: no tracking, no collected data, and the system boot time API category (reason `35F9.1`) because the engine measures elapsed time with `ProcessInfo.systemUptime`. Xcode merges it into your app's privacy report.

## Measurements and limits

- Simulator and macOS results: [native baseline](measurements/native-baseline-20261101.json), [startup](measurements/native-startup.json), [soak](measurements/native-soak-ios.json), [distribution rehearsal](measurements/native-distribution-rehearsal.json).
- Physical device ([device measurements](measurements/native-device-performance.json)): on an iPhone XR (iOS 18.7.10), engine creation + 10,000 bars + first frame takes 155 ms (p50), and a pan frame over 10,000 bars renders in 6.5 ms (p95). The SDK adds about 1 MB to an app (arm64 code + core bundle). These are CPU render times, not display frame rates, measured on one device.
- Float64 numbers, not decimal arithmetic. Workspaces need matching host data. VoiceOver behavior beyond the automated audit needs a manual check ([checklist](NATIVE-ACCESSIBILITY-CHECKLIST.md)).
