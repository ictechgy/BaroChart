# Migrating from Aster names to BaroChart

Version 0.3.0 renames the native SDK's public names to the product name before the first public release. Behavior is unchanged, and documents saved by earlier versions still load. [한국어](MIGRATING-FROM-ASTER.ko.md)

## What changed

| Before | After |
| --- | --- |
| SwiftPM product / module `AsterNative` | `BaroChart` |
| Swift `AsterEngine`, `AsterBar`, `AsterColumns`, `Aster…` types | `BaroChartEngine`, `BaroChartBar`, `BaroChartColumns`, `BaroChart…` |
| Swift `AsterChartView` (UIKit) | `BaroChartUIView`; SwiftUI uses the new `BaroChartView` |
| Swift `AsterError` | `BaroChartLowLevelError`; the typed API throws the new `BaroChartError` |
| Android package `dev.aster.charts` | `kr.coden.barochart` |
| Android `AsterEngine`, `AsterChartView`, `AsterColumns` | `BaroChartEngine`, `BaroChartView`, `BaroChartColumns` |
| Android native library `libaster.so` | `libbarochart.so` |
| Android resource `aster_sdk_version` | `barochart_sdk_version` |
| Android `AsterChartView.lastError` field | `BaroChartView.getLastError()` (Kotlin: `lastError`) |

The 0.3.0 typed API is new. Prefer it over the dictionary/`JSONObject` methods, which remain as the advanced low-level API.

## What did not change

- Saved document schemas: `aster.workspace`, `aster.drawings` and other `aster.*` identifiers.
- The bundled core file name `aster-core.js` and the JavaScript bridge functions.
- The web React export `AsterChart` (outside the native SDK).

## Swift

```swift
import BaroChart

let engine = try BaroChartEngine(options: BaroChartEngineOptions())
try engine.setBars(bars)
let chartView = BaroChartUIView(engine: engine)
```

View setters `setTool(_:)`, `setCrosshairSnap(_:)` and `setDrawingMagnet(_:)` now throw instead of recording a silent `lastError`; wrap them in `do`/`catch`.

## Android

```kotlin
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.BaroChartView
import kr.coden.barochart.EngineOptions

val engine = BaroChartEngine.create(context, EngineOptions.defaults())
val chart = BaroChartView(context, engine)
chart.setOnChartErrorListener { error -> android.util.Log.w("Chart", error.toString()) }
```

`BaroChartView.fire`, `setTool`, `setCrosshairSnap` and `setDrawingMagnet` now throw `BaroChartException`. `fit`, `undo`, `redo`, `removeSeries`, `removeIndicator`, `selectDrawing`, `saveDrawings` and `loadDrawings` throw the unchecked `BaroChartException` instead of the checked `JSONException`. Update R8 keep rules that named `dev.aster.charts`; the AAR's own consumer rules already use the new package.

## Saved documents

Nothing to migrate. A workspace or drawings document saved by 0.2.x reads and re-saves byte-for-byte in 0.3.0 (covered by `test/legacy-documents-compat.test.mjs`).
