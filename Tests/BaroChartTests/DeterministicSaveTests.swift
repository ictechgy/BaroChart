import XCTest
@testable import BaroChart

/// 타입 API가 저장하는 문서가 프로세스와 상관없이 같은 바이트인지 확인한다(설계 §7.4-1, M0 Task 4 Step 2).
///
/// 타입 값은 호출마다 새 Swift `Dictionary`로 바뀌어 코어에 들어간다. 딕셔너리 순회 순서는 프로세스 해시 시드와
/// 딕셔너리 저장소 주소로 정해진다. 같은 프로세스에서도 인스턴스마다 다르고, 프로세스가 바뀌면 또 달라진다.
/// 그래서 코어가 저장 레코드를 정규 키 순서로 다시 담지 않으면, 같은 입력도 실행마다 다른 문서가 된다
/// (정규화 전에는 4회 실행에 해시가 4개 나왔다).
/// 이 테스트는 저장 문서를 정규 순서 리터럴과 비교한다. 드로잉은 새 엔진 여러 개에 넣어 한 프로세스 안의 여러 순서도 본다.
/// 프로세스 시드까지 바꾸려면 테스트를 프로세스 10번 따로 돌린다:
/// `for i in $(seq 1 10); do swift test --scratch-path artifacts/swift-test --filter DeterministicSaveTests || break; done`
///
/// 기대 리터럴은 같은 번들을 Node `node:vm`에 올려 레코드 키 순서를 12가지로 섞어 넣었을 때 하나로 나온 문서다.
/// 정규 순서는 다음과 같다.
/// - 드로잉: `id, panel, locked, style, type, points, text, visible`
/// - 스타일: `color, width, fill, font` / 앵커: `time, price`
/// - 패널·시리즈·테마·심볼: 검증기 허용 목록 순서 / 지표 params: 정의가 선언한 순서
@MainActor
final class DeterministicSaveTests: XCTestCase {
    /// 첫 봉 시각(UTC epoch ms). 레거시 픽스처와 같은 시각이다.
    private static let start = 1_700_000_000_000.0

    /// 필드 8개를 모두 채운 추세선. 스타일 필드 4개도 모두 채워, 딕셔너리 순서가 달라질 여지를 가장 크게 둔다.
    private static let drawing = BaroChartDrawing(
        id: "deterministic-trend", tool: .trendline,
        points: [BaroChartPoint(time: start, price: 100), BaroChartPoint(time: start + 1_200_000, price: 125.5)],
        panel: "price",
        style: BaroChartDrawingStyle(color: "#ff0000ff", fill: "#00ff0033", width: 2, font: "12px monospace"),
        text: "Deterministic", locked: false, visible: true)

    /// `drawing`을 정규 키 순서로 저장한 드로잉 문서. `visible`이 있어 문서 버전은 4다.
    private static let canonicalDrawingDocument = ##"{"schema":"aster.drawings","version":4,"drawings":[{"id":"deterministic-trend","panel":"price","locked":false,"style":{"color":"#ff0000ff","width":2,"fill":"#00ff0033","font":"12px monospace"},"type":"trendline","points":[{"time":1700000000000,"price":100},{"time":1700001200000,"price":125.5}],"text":"Deterministic","visible":true}]}"##

    /// 스타일 없이 추가한 드로잉을 스타일·텍스트·숨김 패치로 바꾼 뒤의 정규 문서. 패치가 새로 넣는 키도 정규 자리에 온다.
    private static let canonicalPatchedDocument = ##"{"schema":"aster.drawings","version":4,"drawings":[{"id":"patched","panel":"price","locked":false,"style":{"color":"#00ff00ff","width":3,"fill":"#0000ff22","font":"bold 13px monospace"},"type":"trendline","points":[{"time":1700000000000,"price":100},{"time":1700000600000,"price":110}],"text":"Patched","visible":false}]}"##

    /// `testTypedWorkspaceSavesCanonicalBytes`가 저장하는 작업공간의 정규 문서. 읽기 쉽게 레코드 단위로 나눠 이어 붙인다.
    /// 심볼(8키)·지표 params(macd 3키, bollinger 2키)·시리즈·패널·테마·데이터셋 바인딩·드로잉이 모두 Swift 딕셔너리에서 온다.
    private static let canonicalWorkspaceDocument = [
        ##"{"schema":"aster.workspace","version":1,"##,
        ##""dataset":{"key":"deterministic:1m","revision":"7","adjustmentVersion":"raw","priceUnit":"USD","adjustment":"raw"},"##,
        ##""source":{"length":30,"firstTime":1700000000000,"lastTime":1700001740000},"##,
        ##""chart":{"panels":[{"id":"price","weight":3,"scale":"linear","inverted":false,"padding":0.08},"##,
        ##"{"id":"lower","weight":1,"label":"MACD","scale":"linear","inverted":false,"padding":0.08}],"axes":[],"##,
        ##""theme":{"background":"#101820ff","grid":"#203040ff","text":"#8090a0ff","up":"#20c090ff","down":"#e05060ff","crosshair":"#c0d0e0ff","font":"11px monospace"},"##,
        ##""symbol":{"id":"DET","exchange":"XTEST","timezone":"America/New_York","currency":"USD","volumeUnit":"shares","priceDecimals":2,"tickSize":0.01,"adjustment":"raw"},"##,
        ##""formatters":"symbol","precision":2,"axisWidth":82,"view":{"from":-0.5,"to":29.5},"follow":true},"##,
        ##""indicators":[{"id":"macd","name":"macd","params":{"fast":5,"slow":13,"signal":4},"outputs":["macd","signal","histogram"],"plotOffsets":{}},"##,
        ##"{"id":"bb","name":"bollinger","params":{"period":10,"deviation":2.5},"outputs":["middle","upper","lower"],"plotOffsets":{}}],"##,
        ##""series":[{"id":"price","type":"candles","panel":"price","color":"#7898ff","width":1,"offset":0},"##,
        ##"{"id":"close","type":"line","panel":"price","source":"close","color":"#3366ffff","width":1.25,"offset":0,"visible":false,"label":"Close"},"##,
        ##"{"id":"macd-signal","type":"line","panel":"lower","indicator":"macd","output":"signal","color":"#aa5500ff","width":1.5,"offset":0,"visible":true,"label":"Signal"},"##,
        ##"{"id":"bb-upper","type":"line","panel":"price","indicator":"bb","output":"upper","color":"#00aa55ff","width":1,"offset":0}],"##,
        ##""drawings":"##, canonicalDrawingDocument, "}",
    ].joined()

    /// 1분봉 30개(종가 100부터 0.5씩 오른다). Node 오라클 스크립트와 같은 값이다.
    private func bars() -> [BaroChartBar] {
        (0..<30).map { i in
            let close = 100 + Double(i) * 0.5
            return BaroChartBar(time: Self.start + Double(i) * 60_000, open: close - 1, high: close + 1.5, low: close - 2, close: close, volume: 1_000 + Double(i) * 10)
        }
    }

    /// 주어진 레이아웃으로 엔진을 만들고 `bars()`를 넣는다.
    /// - Parameter options: 엔진 생성 옵션. 기본값은 타입 API 기본 레이아웃(price 패널, 캔들 하나)이다.
    /// - Returns: 봉 30개가 들어간 새 엔진. 호출한 테스트가 닫는다.
    private func engineWithBars(_ options: BaroChartEngineOptions = BaroChartEngineOptions()) throws -> BaroChartEngine {
        let engine = try BaroChartEngine(options: options)
        try engine.setBars(bars())
        return engine
    }

    /// 필드 8개짜리 드로잉을 추가하면 저장 문서가 정규 순서 리터럴과 바이트 단위로 같다.
    /// 새 엔진 8개에 차례로 넣는다. `addDrawing`마다 새 딕셔너리가 만들어져 한 프로세스 안에서도 키 순서가 여러 가지로 들어간다.
    func testTypedDrawingSavesCanonicalBytes() throws {
        for attempt in 1...8 {
            let engine = try engineWithBars()
            defer { try? engine.close() }
            XCTAssertEqual(try engine.addDrawing(Self.drawing), "deterministic-trend", "attempt \(attempt)")
            XCTAssertEqual(try engine.saveDrawings(), Self.canonicalDrawingDocument, "attempt \(attempt)")
        }
    }

    /// 패치가 기존 드로잉에 없던 키(text, visible)와 새 스타일을 넣어도 저장 문서는 정규 순서다.
    func testTypedDrawingPatchKeepsCanonicalBytes() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        let plain = BaroChartDrawing(id: "patched", tool: .trendline,
                                     points: [BaroChartPoint(time: Self.start, price: 100), BaroChartPoint(time: Self.start + 600_000, price: 110)])
        try engine.addDrawing(plain)
        let style = BaroChartDrawingStyle(color: "#00ff00ff", fill: "#0000ff22", width: 3, font: "bold 13px monospace")
        try engine.updateDrawing(id: "patched", BaroChartDrawingPatch(style: style, text: "Patched", visible: false))
        XCTAssertEqual(try engine.saveDrawings(), Self.canonicalPatchedDocument)
    }

    /// 타입 값으로 만든 패널·시리즈·테마·지표·심볼·드로잉을 작업공간으로 저장하면 정규 순서 리터럴과 바이트 단위로 같다.
    func testTypedWorkspaceSavesCanonicalBytes() throws {
        let theme = BaroChartTheme(background: "#101820", grid: "#203040", text: "#8090a0", up: "#20c090",
                                   down: "#e05060", crosshair: "#c0d0e0", font: "11px monospace")
        let options = BaroChartEngineOptions(
            panels: [BaroChartPanel(id: "price", weight: 3), BaroChartPanel(id: "lower", weight: 1, label: "MACD")],
            series: [BaroChartSeries(id: "price", type: .candles),
                     BaroChartSeries(id: "close", type: .line, source: .close, color: "#3366ff", width: 1.25, visible: false, label: "Close")],
            theme: theme)
        let engine = try engineWithBars(options)
        defer { try? engine.close() }
        try engine.addIndicator(.macd(fast: 5, slow: 13, signal: 4), id: "macd")
        try engine.addIndicator(.bollinger(period: 10, deviation: 2.5), id: "bb")
        try engine.addSeries(BaroChartSeries(id: "macd-signal", type: .line, panel: "lower", indicator: "macd", output: "signal",
                                             color: "#aa5500", width: 1.5, visible: true, label: "Signal"))
        try engine.addSeries(BaroChartSeries(id: "bb-upper", type: .line, indicator: "bb", output: "upper", color: "#00aa55", width: 1))
        try engine.setSymbol(BaroChartSymbol(id: "DET", exchange: "XTEST", timezone: "America/New_York", currency: "USD",
                                             priceDecimals: 2, tickSize: 0.01))
        try engine.addDrawing(Self.drawing)
        let binding = BaroChartDatasetBinding(key: "deterministic:1m", revision: "7", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        XCTAssertEqual(try engine.saveWorkspace(binding: binding), Self.canonicalWorkspaceDocument)
    }
}
