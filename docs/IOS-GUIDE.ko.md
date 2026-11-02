# iOS용 BaroChart

BaroChart는 금융 차트를 네이티브로 그립니다. 차트 코어는 JavaScriptCore에서 돌고 화면은 Core Graphics로 그립니다. WebView가 아닙니다. 데이터와 엔진은 앱이 소유하고, BaroChart는 시세를 가져오지 않습니다. [English](IOS-GUIDE.md)

## 지원 범위

| 항목 | 값 |
| --- | --- |
| 최소 OS | iOS 17 (엔진만 쓰거나 테스트할 때는 macOS 13) |
| Swift | Swift 6 툴체인. 라이브러리는 Swift 5 언어 모드로 빌드되고 Swift 6 앱에서 쓸 수 있습니다 |
| UI | SwiftUI `BaroChartView`, UIKit `BaroChartUIView` |
| 배포 | Swift Package Manager (`BaroChart` 제품) |
| 검증 환경 | iOS 27 시뮬레이터와 macOS JavaScriptCore. 실기기 수치는 [측정](#측정과-한계)에 있습니다 |

## 설치

### Swift Package Manager

릴리스는 저장소에 `X.Y.Z` 태그로 표시됩니다. 릴리스 태그가 공개되면 다음처럼 추가합니다.

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/ictechgy/BaroChart.git", from: "X.Y.Z")
],
targets: [
    .target(name: "MyApp", dependencies: [.product(name: "BaroChart", package: "BaroChart")])
]
```

Xcode에서는 **File › Add Package Dependencies…**에 같은 URL을 넣습니다. 예제와 문서가 같은 저장소에 있어서 패키지 체크아웃은 약 19MB입니다.

### 첫 릴리스 전

아직 공개된 릴리스 태그가 없습니다. 그동안은 [examples/swiftui-sample](../examples/swiftui-sample)처럼 `.package(path: "../BaroChart")`로 로컬 체크아웃을 씁니다.

## 빠른 시작 (SwiftUI)

엔진은 앱이 소유한 객체 안에서 메인 스레드로 만들고 `BaroChartView`에 넘깁니다. 시간은 UTC 기준 밀리초입니다.

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

`BaroChartEngineOptions()`는 라벨 없는 `price` 패널 하나와 캔들 시리즈로 시작합니다. 저수준 `BaroChartEngine()` 생성자는 라벨이 붙은 데모 차트를 만드니 앱에서는 `BaroChartEngine(options:)`를 쓰세요.

Dynamic Type 같은 뷰 옵션은 `configure`로 설정합니다. 새 내부 뷰마다 한 번 실행됩니다: `BaroChartView(engine: engine, configure: { $0.adjustsFontForContentSizeCategory = true })`.

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

    /// 화면이 더 이상 차트를 쓰지 않을 때(예: 닫기 전) 부릅니다.
    func tearDown() {
        chartView.dispose()
        do { try engine.close() } catch { print("Chart close failed: \(error)") }
    }
}
```

`dispose()`는 뷰만 정리합니다. 엔진은 소유자가 사라질 때 직접 닫으세요.

## 데이터와 스트리밍

```swift
try engine.setBars(history)                 // 전체 교체
try engine.apply(.update(currentBar))       // 마지막 봉과 같은 시간
try engine.apply(.append(nextBar))          // 마지막 봉보다 나중
try engine.apply(.correction(fixedBar))     // 기존 봉 정정
try engine.apply(.prepend(olderBars))       // 과거 이력 추가
```

잘못된 이벤트는 `.invalidArgument` 코드의 `BaroChartError`를 던지고 데이터를 바꾸지 않습니다. 예를 들어 시간이 마지막 봉과 다른 `update`, 가격이 유한하지 않은 봉이 그렇습니다.

## 지표, 드로잉, 테마

```swift
// RSI 선은 rsi 패널이 있어야 하므로 그 패널을 가진 엔진을 만든다
let engine = try BaroChartEngine(options: BaroChartEngineOptions(panels: [BaroChartPanel(id: "price", weight: 3), BaroChartPanel(id: "rsi", weight: 1)]))
try engine.setBars(history)
try engine.addIndicator(.rsi(period: 14), id: "rsi14")
try engine.addSeries(BaroChartSeries(id: "rsi14-line", type: .line, panel: "rsi", indicator: "rsi14"))
try engine.updateSeries(id: "rsi14-line", BaroChartSeriesPatch(color: "#f0b755"))   // 색만 바꾼다
let rsi = try engine.indicatorValue(id: "rsi14", index: 199)

try engine.setTool(.trendline)              // 이제 터치로 추세선을 그림
let lineID = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: lastTime, price: 101)]))
try engine.deleteDrawings(ids: [lineID])
try engine.undo()

try engine.setTheme(.light)
```

내장 지표 35종은 `BaroChartIndicatorKind`, 드로잉 도구 16종은 `BaroChartDrawingTool`에 있습니다. `rsi` 같은 패널은 `BaroChartEngineOptions(panels:)`로 추가합니다. `updateSeries`와 `updateDrawing`은 패치를 받습니다. 설정한 필드만 바뀌고, 시리즈 종류와 드로잉 도구는 바꿀 수 없습니다.

## 심볼과 시간대

```swift
try engine.setSymbol(BaroChartSymbol(id: "AAPL", exchange: "XNAS", timezone: "America/New_York", currency: "USD", priceDecimals: 2, tickSize: 0.01))
```

심볼의 시간대로 시간축 라벨을 만듭니다. `vwap`과 `pivots`의 세션 달력 시간대도 같은 규칙을 따릅니다. `America/New_York`, `Asia/Seoul` 같은 IANA 이름(대소문자 무시)이나 `+09:00`, `-05:30` 꼴의 고정 오프셋을 쓰세요. `Z`, `UT`, `UTC+9`, `GMT+0`, `GMT-03:00`처럼 일부 플랫폼만 받는 이름은 거절합니다. 기기의 시간대 데이터에 없는 이름도 거절합니다. 이때 `setSymbol`은 코드가 `.invalidArgument`이고 메시지가 `Unsupported time zone: <이름>`인 `BaroChartError`를 던집니다. 지원하는 지역 날짜는 1000년부터 9999년까지입니다. 지역 날짜가 이 범위를 벗어난 시각을 표시하려 하면 `Time zone conversion year out of range`로 실패합니다. 타입 메서드는 이를 `.invalidArgument`로 던지고, 뷰는 그리는 중에 `onError`로 알립니다. 웹·iOS·Android가 같은 규칙을 쓰므로, 결과는 플랫폼의 시간대 데이터가 다를 때만 달라집니다. 0.3.0 전에는 iOS가 `GMT+0`, `+0900`, `+09` 같은 이름도 받았습니다. 이런 이름으로 저장한 작업공간은 이제 복원되지 않습니다.

## 저장과 복원

작업공간에는 차트 설정, 지표, 시리즈, 드로잉이 저장되고 봉 데이터는 저장되지 않습니다. 저장할 때와 같은 봉 위에 복원해야 합니다. 데이터셋 바인딩이 다르거나 봉 범위가 바뀌면 거부됩니다.

```swift
let binding = BaroChartDatasetBinding(key: "AAPL:1m", revision: "42", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
let document = try engine.saveWorkspace(binding: binding)
// 나중에, 같은 봉을 불러온 상태에서:
try await engine.restoreWorkspace(document, binding: binding)
```

감싼 Task를 취소하면 복원도 취소되어 `.cancelled`를 던지고, 엔진은 계속 쓸 수 있습니다. 문서는 이식 가능한 `aster.workspace` 스키마라 이전 버전이 저장한 파일도 그대로 열립니다.

## 스레드와 수명주기

- 엔진은 만든 스레드에 속합니다. 뷰에 붙일 엔진은 메인 스레드에서 만들어야 합니다.
- 다른 스레드에서 부르면 앱이 죽지 않고 `.wrongThread`를 던집니다. 뷰와 `BaroChartView`는 main actor 타입입니다.
- 뷰는 백그라운드에서 그리기를 멈추고 앱이 활성화되면 다시 그립니다.
- `BaroChartView`는 엔진을 닫지 않습니다. 소유자가 해제될 때 직접 닫으세요.

## 오류 처리

타입 API 메서드는 `BaroChartError` 하나만 던집니다.

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

던질 수 없는 실패(예: 닫힌 엔진 그리기)는 `BaroChartView`나 `BaroChartUIView`의 `onError`로 전달됩니다.

## 저수준 API

`engine.command(_:_:)` 같은 딕셔너리 기반 메서드는 고급 기능(수집 큐, 비동기 준비, 압축, 데이터 탐색)용으로 공개되어 있습니다. 이 메서드들은 **고급 기능이며 1.x 안에서 바뀔 수 있습니다.** 기존 오류 타입을 그대로 쓰며, [SWIFT-SDK.md](SWIFT-SDK.md)에 정리되어 있습니다. 안정 범위는 타입 API, 뷰, `BaroChartError`입니다.

## 개인정보 매니페스트

패키지에는 `PrivacyInfo.xcprivacy`가 들어 있습니다. 추적과 수집 데이터는 없고, 엔진이 `ProcessInfo.systemUptime`으로 경과 시간을 재기 때문에 시스템 부팅 시간 API 범주(사유 `35F9.1`)만 선언합니다. Xcode가 앱의 개인정보 보고서에 합칩니다.

## 측정과 한계

- 시뮬레이터·macOS 결과: [네이티브 기준선](measurements/native-baseline-20261101.json), [시작 시간](measurements/native-startup.json), [soak](measurements/native-soak-ios.json), [배포 리허설](measurements/native-distribution-rehearsal.json).
- 실기기([실기기 측정](measurements/native-device-performance.json)): iPhone XR(iOS 18.7.10)에서 엔진 생성 + 1만 봉 + 첫 프레임이 155ms(p50), 1만 봉 팬 프레임 렌더가 6.5ms(p95)입니다. SDK가 앱에 더하는 크기는 약 1MB(arm64 코드 + 코어 번들)입니다. 화면 표시 프레임 속도가 아니라 CPU 렌더 시간이며, 기기 한 대에서 쟀습니다.
- 숫자는 Float64이며 십진 정밀 연산이 아닙니다. 작업공간 복원에는 같은 호스트 데이터가 필요합니다. 자동 검사 밖의 VoiceOver 동작은 수동 확인이 필요합니다([체크리스트](NATIVE-ACCESSIBILITY-CHECKLIST.md)).
