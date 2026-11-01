# Aster 이름에서 BaroChart로 옮기기

0.3.0은 첫 공개 릴리스 전에 네이티브 SDK의 공개 이름을 제품명으로 바꿉니다. 동작은 같고, 이전 버전이 저장한 문서도 그대로 열립니다. [English](MIGRATING-FROM-ASTER.md)

## 바뀐 것

| 이전 | 이후 |
| --- | --- |
| SwiftPM 제품·모듈 `AsterNative` | `BaroChart` |
| Swift `AsterEngine`, `AsterBar`, `AsterColumns`, `Aster…` 타입 | `BaroChartEngine`, `BaroChartBar`, `BaroChartColumns`, `BaroChart…` |
| Swift `AsterChartView` (UIKit) | `BaroChartUIView`. SwiftUI는 새 `BaroChartView`를 씁니다 |
| Swift `AsterError` | `BaroChartLowLevelError`. 타입 API는 새 `BaroChartError`를 던집니다 |
| Android 패키지 `dev.aster.charts` | `kr.coden.barochart` |
| Android `AsterEngine`, `AsterChartView`, `AsterColumns` | `BaroChartEngine`, `BaroChartView`, `BaroChartColumns` |
| Android 네이티브 라이브러리 `libaster.so` | `libbarochart.so` |
| Android 리소스 `aster_sdk_version` | `barochart_sdk_version` |
| Android `AsterChartView.lastError` 필드 | `BaroChartView.getLastError()` (Kotlin에서는 `lastError`) |

0.3.0의 타입 API는 새로 생겼습니다. 딕셔너리·`JSONObject` 메서드는 고급 저수준 API로 남아 있으니, 가능하면 타입 API를 쓰세요.

## 바뀌지 않은 것

- 저장 문서 스키마: `aster.workspace`, `aster.drawings` 등 `aster.*` 식별자.
- 내장 코어 파일 이름 `aster-core.js`와 JavaScript 브리지 함수.
- 웹 React export `AsterChart` (네이티브 SDK 범위 밖).

## Swift

```swift
import BaroChart

let engine = try BaroChartEngine(options: BaroChartEngineOptions())
try engine.setBars(bars)
let chartView = BaroChartUIView(engine: engine)
```

뷰의 `setTool(_:)`, `setCrosshairSnap(_:)`, `setDrawingMagnet(_:)`은 이제 실패를 `lastError`에 조용히 남기지 않고 던집니다. `do`/`catch`로 감싸세요.

## Android

```kotlin
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.BaroChartView
import kr.coden.barochart.EngineOptions

val engine = BaroChartEngine.create(context, EngineOptions.defaults())
val chart = BaroChartView(context, engine)
chart.setOnChartErrorListener { error -> android.util.Log.w("Chart", error.toString()) }
```

예외 처리가 두 군데 바뀌었습니다.

- `BaroChartView`의 `fire`, `setTool`, `setCrosshairSnap`, `setDrawingMagnet`는 이제 `BaroChartException`을 던집니다.
- `fit`, `undo`, `redo`, `removeSeries`, `removeIndicator`, `selectDrawing`, `saveDrawings`, `loadDrawings`는 checked `JSONException` 대신 unchecked `BaroChartException`을 던집니다.

R8 keep 규칙에 `dev.aster.charts`를 직접 적었다면 새 패키지로 바꾸세요. AAR에 포함된 소비자 규칙은 이미 새 패키지를 씁니다.

## 저장 문서

옮길 것이 없습니다. 0.2.x가 저장한 작업공간·드로잉 문서는 0.3.0에서 그대로 읽히고, 다시 저장해도 바이트 단위로 같습니다(`test/legacy-documents-compat.test.mjs`가 확인).
