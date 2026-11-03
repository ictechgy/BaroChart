# BaroChart for Android

BaroChart draws financial charts natively: the chart core runs in an embedded QuickJS engine through JNI and the UI is drawn on an Android `Canvas`. It is not a WebView. Your app owns the data and the engine; BaroChart never fetches market data. [한국어](ANDROID-GUIDE.ko.md)

## Support

| Item | Value |
| --- | --- |
| Minimum SDK | 26 (Android 8.0); compiled against 36 |
| ABIs | `arm64-v8a`, `x86_64`, both with 16 KiB page alignment |
| Languages | Java 8+ and Kotlin; the core library has no Kotlin dependency |
| UI | Jetpack Compose `BaroChart` (`barochart-compose`), Android View `BaroChartView` |
| Compose module | Compose 1.11, Kotlin 2.1+ apps, AGP 8.6+ |
| Verified on | API 36 emulator (arm64) and CI x86_64 emulator; physical-device numbers are in [measurements](#measurements-and-limits) |

## Installation

### Gradle

The current development preview uses a [local checkout](#before-the-first-release). Artifacts use the group `kr.coden`. Once a release is published to Maven Central, add:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("kr.coden:barochart-android:X.Y.Z")   // View + typed API
    implementation("kr.coden:barochart-compose:X.Y.Z")   // optional Jetpack Compose wrapper
}
```

The core AAR has no runtime dependencies and ships consumer R8 rules for its JNI bridge. The Compose artifact depends on the core artifact, Compose UI and the Kotlin standard library 2.2.

### Before the first release

No release is published yet. Until then include the SDK build from a local checkout, as [examples/compose-sample](../examples/compose-sample) does with `includeBuild("../BaroChart/native/android/library")`, or publish it to a local Maven repository with `node scripts/rehearse-native-distribution.mjs`.

## Quick start (Compose)

Create the engine on the main thread in an owner such as a `ViewModel`, pass it to `BaroChart`, and close it when the owner is cleared. Timestamps are UTC epoch milliseconds.

```kotlin
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import kr.coden.barochart.Bar
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.EngineOptions
import kr.coden.barochart.Indicator
import kr.coden.barochart.Series
import kr.coden.barochart.SeriesType
import kr.coden.barochart.compose.BaroChart

class PriceChartViewModel(application: android.app.Application) : AndroidViewModel(application) {
    val engine: BaroChartEngine = BaroChartEngine.create(application, EngineOptions.defaults())

    fun load(bars: List<Bar>) {
        engine.setBars(bars)
        engine.addIndicator(Indicator.ema(20), "ema20")
        engine.addSeries(Series.builder("ema20-line", SeriesType.LINE).indicator("ema20").color("#f0b755").build())
        engine.fit()
    }

    override fun onCleared() = engine.close()
}

@Composable
fun PriceChart(viewModel: PriceChartViewModel) {
    BaroChart(engine = viewModel.engine, modifier = Modifier.fillMaxWidth().height(320.dp), onError = { error -> println(error) })
}
```

`EngineOptions.defaults()` creates one unlabeled `price` panel with a candlestick series. The constructor `new BaroChartEngine(context, count)` builds a labeled demonstration chart; prefer `BaroChartEngine.create` in apps.

To set view options such as system font scaling, pass `configure`. It runs once for each new underlying view: `BaroChart(engine = engine, configure = { it.setSystemFontScaleEnabled(true) })`.

## Android View

```java
import kr.coden.barochart.BaroChartEngine;
import kr.coden.barochart.BaroChartView;
import kr.coden.barochart.EngineOptions;

public final class ChartActivity extends android.app.Activity {
    private BaroChartEngine engine;

    @Override protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        engine = BaroChartEngine.create(this, EngineOptions.defaults());
        BaroChartView chart = new BaroChartView(this, engine);
        chart.setOnChartErrorListener(error -> android.util.Log.w("Chart", error.toString()));
        setContentView(chart);
    }

    @Override protected void onDestroy() {
        engine.close();
        super.onDestroy();
    }
}
```

## Data and streaming

```kotlin
engine.setBars(history)                          // replace everything
engine.apply(DataEvent.update(currentBar))       // same time as the last bar
engine.apply(DataEvent.append(nextBar))          // later than the last bar
engine.apply(DataEvent.correction(fixedBar))     // replace an existing bar
engine.apply(DataEvent.prepend(olderBars))       // older history
```

An invalid event, such as an `update` whose time is not the last bar's time or a bar with a non-finite price, throws `BaroChartException` with code `INVALID_ARGUMENT` and leaves the data unchanged.

## Indicators, drawings and themes

```kotlin
// An RSI line needs an `rsi` panel, so create the engine with one.
val options = EngineOptions(
    listOf(Panel("price", 3.0), Panel("rsi", 1.0)),
    listOf(Series.builder("price", SeriesType.CANDLES).build()),
    null,
)
val engine = BaroChartEngine.create(context, options)
engine.setBars(history)
engine.addIndicator(Indicator.rsi(14), "rsi14")
engine.addSeries(Series.builder("rsi14-line", SeriesType.LINE).panel("rsi").indicator("rsi14").build())
engine.updateSeries("rsi14-line", SeriesPatch.builder().color("#f0b755").build())   // changes only the color
val rsi = engine.indicatorValue("rsi14", null, 199)

engine.setTool(DrawingTool.TRENDLINE)            // touch input now draws trend lines
val lineId = engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, listOf(ChartPoint(lastTime, 101.0))).build())
engine.deleteDrawings(listOf(lineId))
engine.undo()

engine.setTheme(Theme.LIGHT)
```

`IndicatorKind` lists the 35 built-in indicators and `DrawingTool` the 16 drawing tools. Add panels such as `rsi` through `EngineOptions(panels, series, theme)`. `updateSeries` and `updateDrawing` take a `SeriesPatch` / `DrawingPatch`: only the fields you set change, and the series type or drawing tool cannot change.

## Symbols and time zones

```kotlin
engine.setSymbol(Symbol.builder("AAPL", "XNAS", "America/New_York", "USD", 2, 0.01).build())
```

The symbol's time zone formats the time-axis labels, and the session calendars of `vwap` and `pivots` follow the same rules. Use an IANA name such as `America/New_York` or `Asia/Seoul` (letter case is ignored) or a fixed offset written `+09:00` or `-05:30`. Names that only some platforms accept, such as `Z`, `UT`, `UTC+9`, `GMT+0` or `GMT-03:00`, are rejected, and so are names the device's time zone data does not know: `setSymbol` throws `BaroChartException` with code `INVALID_ARGUMENT` and the message `Unsupported time zone: <name>`. Local dates from year 1000 through 9999 are supported. Formatting a time whose local date falls outside that range fails with `Time zone conversion year out of range`: typed methods throw it with code `INVALID_ARGUMENT`, and the view reports it to `OnChartErrorListener` while drawing. Web, iOS and Android apply the same rules, so results differ only where the platforms' time zone data differs. Before 0.3.0, Android also accepted `java.time` names such as `Z`, `UTC+9`, `GMT+0` and `+0900`; a workspace saved with such a name no longer restores.

## Saving and restoring

A workspace stores chart settings, indicators, series and drawings, not your bars. Restore it onto the same bars it was saved with; a different dataset binding or a changed bar range is rejected.

```kotlin
val binding = DatasetBinding("AAPL:1m", "42", "raw", "USD", Adjustment.RAW)
val document = engine.saveWorkspace(binding)
// later, with the same bars loaded, on the main thread:
val handle = engine.restoreWorkspace(document, binding) { error ->
    if (error == null) showRestored() else showError(error)
}
// handle.cancel() reports CANCELLED unless the restore already finished
```

Documents use the portable `aster.workspace` schema, so files saved by earlier versions still load.

## Threading and lifecycle

- An engine belongs to the thread that created it. Engines attached to a view must be created on the main thread.
- Calls from another thread throw `BaroChartException` with `WRONG_THREAD` instead of crashing.
- Touch and key input never throw out of the view; failures go to `OnChartErrorListener`.
- `BaroChart` and `BaroChartView` never close the engine. Close it when its owner is destroyed.

## Error handling

Typed API methods throw only the unchecked `BaroChartException`:

```kotlin
try {
    engine.apply(DataEvent.update(bar))
} catch (error: BaroChartException) {
    when (error.code) {
        BaroChartException.Code.INVALID_ARGUMENT -> showWarning(error.message)
        BaroChartException.Code.ENGINE_CLOSED -> recreateEngine()
        else -> log("${error.code}: ${error.message} — ${error.recovery}")
    }
}
```

## Low-level API

`JSONObject`-based methods remain public for advanced features (ingestion queues, async preparation, compaction, data exploration). They are **advanced and may change within 1.x**, keep their own exceptions, and are documented in [ANDROID-SDK.md](ANDROID-SDK.md). The typed API, views and `BaroChartException` are the stable surface.

## Measurements and limits

- Emulator results: [native baseline](measurements/native-baseline-20261101.json), [soak](measurements/native-soak-android.json), [distribution rehearsal](measurements/native-distribution-rehearsal.json).
- Physical device ([device measurements](measurements/native-device-performance.json)): on a Samsung SM-S947N (Android API 37), engine creation + 10,000 bars + first frame takes 199 ms (p50), and a pan frame over 10,000 bars renders in 3.8 ms (p95). The SDK adds about 1.8 MB per ABI before APK compression (native library + core asset + classes). These are CPU render times into a bitmap, not display frame rates, measured on one device.
- Float64 numbers, not decimal arithmetic. Workspaces need matching host data. TalkBack behavior beyond the automated checks needs a manual check ([checklist](NATIVE-ACCESSIBILITY-CHECKLIST.md)).
