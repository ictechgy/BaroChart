# Android용 BaroChart

BaroChart는 금융 차트를 네이티브로 그립니다. 차트 코어는 JNI로 내장 QuickJS 엔진에서 돌고 화면은 Android `Canvas`로 그립니다. WebView가 아닙니다. 데이터와 엔진은 앱이 소유하고, BaroChart는 시세를 가져오지 않습니다. [English](ANDROID-GUIDE.md)

## 지원 범위

| 항목 | 값 |
| --- | --- |
| 최소 SDK | 26 (Android 8.0), 컴파일 SDK 36 |
| ABI | `arm64-v8a`, `x86_64`. 둘 다 16 KiB 페이지 정렬 |
| 언어 | Java 8 이상과 Kotlin. 코어 라이브러리에는 Kotlin 의존성이 없습니다 |
| UI | Jetpack Compose `BaroChart`(`barochart-compose`), Android View `BaroChartView` |
| Compose 모듈 | Compose 1.11, Kotlin 2.1 이상 앱, AGP 8.6 이상 |
| 검증 환경 | API 36 에뮬레이터(arm64)와 CI x86_64 에뮬레이터. 실기기 수치는 [측정](#측정과-한계)에 있습니다 |

## 설치

### Gradle

아티팩트 그룹은 `kr.coden`입니다. Maven Central에 릴리스가 공개되면 다음처럼 추가합니다.

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("kr.coden:barochart-android:X.Y.Z")   // View + 타입 API
    implementation("kr.coden:barochart-compose:X.Y.Z")   // 선택: Jetpack Compose 래퍼
}
```

코어 AAR에는 런타임 의존성이 없고, JNI 브리지용 R8 소비자 규칙이 들어 있습니다. Compose 아티팩트는 코어 아티팩트, Compose UI, Kotlin 표준 라이브러리 2.2에 의존합니다.

### 첫 릴리스 전

아직 공개된 릴리스가 없습니다. 그동안은 두 가지 방법 중 하나를 씁니다.

- [examples/compose-sample](../examples/compose-sample)처럼 `includeBuild("../BaroChart/native/android/library")`로 로컬 체크아웃의 SDK 빌드를 포함합니다.
- `node scripts/rehearse-native-distribution.mjs`로 로컬 Maven 저장소에 게시해 씁니다.

## 빠른 시작 (Compose)

엔진은 `ViewModel` 같은 소유자 안에서 메인 스레드로 만들고 `BaroChart`에 넘깁니다. 소유자가 정리될 때 닫습니다. 시간은 UTC 기준 밀리초입니다.

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

`EngineOptions.defaults()`는 라벨 없는 `price` 패널 하나와 캔들 시리즈로 시작합니다. 생성자 `new BaroChartEngine(context, count)`는 라벨이 붙은 데모 차트를 만드니 앱에서는 `BaroChartEngine.create`를 쓰세요.

시스템 글꼴 크기 같은 뷰 옵션은 `configure`로 설정합니다. 새 내부 뷰마다 한 번 실행됩니다: `BaroChart(engine = engine, configure = { it.setSystemFontScaleEnabled(true) })`.

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

## 데이터와 스트리밍

```kotlin
engine.setBars(history)                          // 전체 교체
engine.apply(DataEvent.update(currentBar))       // 마지막 봉과 같은 시간
engine.apply(DataEvent.append(nextBar))          // 마지막 봉보다 나중
engine.apply(DataEvent.correction(fixedBar))     // 기존 봉 정정
engine.apply(DataEvent.prepend(olderBars))       // 과거 이력 추가
```

잘못된 이벤트는 `INVALID_ARGUMENT` 코드의 `BaroChartException`을 던지고 데이터를 바꾸지 않습니다. 예를 들어 시간이 마지막 봉과 다른 `update`, 가격이 유한하지 않은 봉이 그렇습니다.

## 지표, 드로잉, 테마

```kotlin
// RSI 선은 rsi 패널이 있어야 하므로 그 패널을 가진 엔진을 만든다
val options = EngineOptions(
    listOf(Panel("price", 3.0), Panel("rsi", 1.0)),
    listOf(Series.builder("price", SeriesType.CANDLES).build()),
    null,
)
val engine = BaroChartEngine.create(context, options)
engine.setBars(history)
engine.addIndicator(Indicator.rsi(14), "rsi14")
engine.addSeries(Series.builder("rsi14-line", SeriesType.LINE).panel("rsi").indicator("rsi14").build())
engine.updateSeries("rsi14-line", SeriesPatch.builder().color("#f0b755").build())   // 색만 바꾼다
val rsi = engine.indicatorValue("rsi14", null, 199)

engine.setTool(DrawingTool.TRENDLINE)            // 이제 터치로 추세선을 그림
val lineId = engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, listOf(ChartPoint(lastTime, 101.0))).build())
engine.deleteDrawings(listOf(lineId))
engine.undo()

engine.setTheme(Theme.LIGHT)
```

내장 지표 35종은 `IndicatorKind`, 드로잉 도구 16종은 `DrawingTool`에 있습니다. `rsi` 같은 패널은 `EngineOptions(panels, series, theme)`로 추가합니다. `updateSeries`와 `updateDrawing`은 `SeriesPatch`·`DrawingPatch`를 받습니다. 설정한 필드만 바뀌고, 시리즈 종류와 드로잉 도구는 바꿀 수 없습니다.

## 심볼과 시간대

```kotlin
engine.setSymbol(Symbol.builder("AAPL", "XNAS", "America/New_York", "USD", 2, 0.01).build())
```

심볼의 시간대로 시간축 라벨을 만듭니다. `vwap`과 `pivots`의 세션 달력 시간대도 같은 규칙을 따릅니다. `America/New_York`, `Asia/Seoul` 같은 IANA 이름(대소문자 무시)이나 `+09:00`, `-05:30` 꼴의 고정 오프셋을 쓰세요. `Z`, `UT`, `UTC+9`, `GMT+0`, `GMT-03:00`처럼 일부 플랫폼만 받는 이름은 거절합니다. 기기의 시간대 데이터에 없는 이름도 거절합니다. 이때 `setSymbol`은 코드가 `INVALID_ARGUMENT`이고 메시지가 `Unsupported time zone: <이름>`인 `BaroChartException`을 던집니다. 지원하는 지역 날짜는 1000년부터 9999년까지입니다. 지역 날짜가 이 범위를 벗어난 시각을 표시하려 하면 `Time zone conversion year out of range`로 실패합니다. 타입 메서드는 이를 `INVALID_ARGUMENT` 코드로 던지고, 뷰는 그리는 중에 `OnChartErrorListener`로 알립니다. 웹·iOS·Android가 같은 규칙을 쓰므로, 결과는 플랫폼의 시간대 데이터가 다를 때만 달라집니다. 0.3.0 전에는 Android가 `Z`, `UTC+9`, `GMT+0`, `+0900` 같은 `java.time` 이름도 받았습니다. 이런 이름으로 저장한 작업공간은 이제 복원되지 않습니다.

## 저장과 복원

작업공간에는 차트 설정, 지표, 시리즈, 드로잉이 저장되고 봉 데이터는 저장되지 않습니다. 저장할 때와 같은 봉 위에 복원해야 합니다. 데이터셋 바인딩이 다르거나 봉 범위가 바뀌면 거부됩니다.

```kotlin
val binding = DatasetBinding("AAPL:1m", "42", "raw", "USD", Adjustment.RAW)
val document = engine.saveWorkspace(binding)
// 나중에, 같은 봉을 불러온 상태에서, 메인 스레드에서:
val handle = engine.restoreWorkspace(document, binding) { error ->
    if (error == null) showRestored() else showError(error)
}
// handle.cancel()은 복원이 이미 끝나지 않았다면 CANCELLED를 보고합니다
```

문서는 이식 가능한 `aster.workspace` 스키마라 이전 버전이 저장한 파일도 그대로 열립니다.

## 스레드와 수명주기

- 엔진은 만든 스레드에 속합니다. 뷰에 붙일 엔진은 메인 스레드에서 만들어야 합니다.
- 다른 스레드에서 부르면 앱이 죽지 않고 `WRONG_THREAD` 코드의 `BaroChartException`을 던집니다.
- 터치·키 입력 중 실패는 뷰 밖으로 던지지 않고 `OnChartErrorListener`로 전달합니다.
- `BaroChart`와 `BaroChartView`는 엔진을 닫지 않습니다. 소유자가 사라질 때 직접 닫으세요.

## 오류 처리

타입 API 메서드는 unchecked 예외인 `BaroChartException` 하나만 던집니다.

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

## 저수준 API

`JSONObject` 기반 메서드는 고급 기능(수집 큐, 비동기 준비, 압축, 데이터 탐색)용으로 공개되어 있습니다. 이 메서드들은 **고급 기능이며 1.x 안에서 바뀔 수 있습니다.** 기존 예외를 그대로 쓰며, [ANDROID-SDK.md](ANDROID-SDK.md)에 정리되어 있습니다. 안정 범위는 타입 API, 뷰, `BaroChartException`입니다.

## 측정과 한계

- 에뮬레이터 결과: [네이티브 기준선](measurements/native-baseline-20261101.json), [soak](measurements/native-soak-android.json), [배포 리허설](measurements/native-distribution-rehearsal.json).
- 실기기([실기기 측정](measurements/native-device-performance.json)): Samsung SM-S947N(Android API 37)에서 엔진 생성 + 1만 봉 + 첫 프레임이 199ms(p50), 1만 봉 팬 프레임 렌더가 3.8ms(p95)입니다. SDK가 더하는 크기는 APK 압축 전 ABI당 약 1.8MB(네이티브 라이브러리 + 코어 자산 + 클래스)입니다. 화면 표시 프레임 속도가 아니라 비트맵에 그리는 CPU 시간이며, 기기 한 대에서 쟀습니다.
- 숫자는 Float64이며 십진 정밀 연산이 아닙니다. 작업공간 복원에는 같은 호스트 데이터가 필요합니다. 자동 검사 밖의 TalkBack 동작은 수동 확인이 필요합니다([체크리스트](NATIVE-ACCESSIBILITY-CHECKLIST.md)).
