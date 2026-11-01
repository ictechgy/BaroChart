# Aster 이름에서 BaroChart로 옮기기

0.3.0은 첫 공개 릴리스 전에 네이티브 SDK의 공개 이름을 제품명으로 바꿉니다. 저장 문서는 `aster.*` 스키마를 그대로 쓰므로 이전 버전 문서도 열립니다. 동작 변화는 하나입니다. 뷰 setter가 조용히 `lastError`에 기록하던 것을 이제 오류로 던집니다([CHANGELOG](../CHANGELOG.md)). [English](MIGRATING-FROM-ASTER.md)

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

옮길 것이 없습니다. 0.2.x가 저장한 작업공간·드로잉 문서는 0.3.0에서 그대로 읽힙니다. Node·iOS·Android 테스트가 이름 변경 이전 픽스처를 복원해 다시 저장하면 같은 바이트가 나오는지 확인합니다. 다만 iOS 0.2.x가 저장한 작업공간은 다시 저장하면 데이터셋 키 순서가 바뀔 수 있습니다. 0.3.0은 모든 플랫폼에서 키를 정해진 한 순서로 쓰기 때문이며 내용은 같습니다.
