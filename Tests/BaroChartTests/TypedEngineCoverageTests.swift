import XCTest
@testable import BaroChart

/// 타입 API 전 메서드의 정상·오류 경로, 오류 분류 표, 이름 변경 이전 저장본 복원을 실제 JavaScriptCore에서 확인한다(G3).
@MainActor
final class TypedEngineCoverageTests: XCTestCase {
    private static let start = 1_700_000_000_000.0

    /// 1분봉 count개(종가 102부터 1씩 증가)
    private func bars(_ count: Int = 4, from offset: Int = 0) -> [BaroChartBar] {
        (offset..<(offset + count)).map { i in
            let close = 102 + Double(i)
            return BaroChartBar(time: Self.start + Double(i) * 60_000, open: close - 2, high: close + 1, low: close - 3, close: close, volume: 500)
        }
    }

    /// price·rsi 두 패널을 가진 엔진(패치가 패널을 옮기지 않는지 보려면 두 번째 패널이 필요하다)
    private func engine(bars count: Int = 4) throws -> BaroChartEngine {
        let options = BaroChartEngineOptions(panels: [BaroChartPanel(id: "price", weight: 3), BaroChartPanel(id: "rsi", weight: 1)])
        let engine = try BaroChartEngine(options: options)
        try engine.setBars(bars(count))
        return engine
    }

    private func code(_ body: () throws -> Void) -> BaroChartError.Code? {
        do { try body() } catch { return (error as? BaroChartError)?.code ?? .unavailable }
        return nil
    }

    private func inspect(_ engine: BaroChartEngine) throws -> [String: Any] {
        try XCTUnwrap(engine.command("inspect").toDictionary() as? [String: Any])
    }

    private func storedBars(_ engine: BaroChartEngine) throws -> Int? { try inspect(engine)["storedBars"] as? Int }

    // MARK: - 오류 분류(Android BaroChartExceptionTest와 같은 표)

    func testClassifierTableMatchesAndroid() {
        let table: [(String, BaroChartError.Code, String)] = [
            ("TypeError: Bar time must be finite", .invalidArgument, "Bar time must be finite"),
            ("RangeError: Invalid OHLCV envelope", .invalidArgument, "Invalid OHLCV envelope"),
            ("RangeError: Drawings: limit 512", .budgetExceeded, "Drawings: limit 512"),
            ("IngestionError: Every OHLCV field must be finite", .invalidArgument, "Every OHLCV field must be finite"),
            ("IngestionError: Packet exceeds queued event/typed-byte budget", .budgetExceeded, "Packet exceeds queued event/typed-byte budget"),
            ("Error: Chart disposed", .engineClosed, "Chart disposed"),
            ("Error: existing panel required", .javaScript, "existing panel required"),
            ("SyntaxError: JSON Parse error: Unexpected identifier \"not\"", .invalidArgument, "JSON Parse error: Unexpected identifier \"not\""),
        ]
        for (raw, expected, message) in table {
            let error = BaroChartError.wrap(BaroChartLowLevelError.javaScript(raw))
            XCTAssertEqual(error.code, expected, raw)
            XCTAssertEqual(error.message, message, raw)
        }
    }

    // MARK: - 데이터 이벤트

    func testSetBarsRejectsNonFiniteValuesAsInvalidArgument() throws {
        let engine = try engine()
        defer { try? engine.close() }
        var data = bars(5)
        data[4] = BaroChartBar(time: data[4].time, open: 1, high: 2, low: 0.5, close: .nan, volume: 1)
        XCTAssertEqual(code { try engine.setBars(data) }, .invalidArgument)
        XCTAssertEqual(try storedBars(engine), 4)
    }

    func testBatchWithInvalidBarIsInvalidArgumentAndChangesNothing() throws {
        let engine = try engine()
        defer { try? engine.close() }
        let next = bars(1, from: 4)[0]
        let broken = BaroChartBar(time: next.time + 60_000, open: 10, high: 5, low: 9, close: 7, volume: 1)  // high < low
        XCTAssertEqual(code { try engine.apply(.batch([.append(next), .append(broken)])) }, .invalidArgument)
        XCTAssertEqual(try storedBars(engine), 4)
    }

    func testAppendCorrectionPrependAndBatch() throws {
        let engine = try engine()
        defer { try? engine.close() }
        try engine.apply(.append(bars(1, from: 4)[0]))
        let fixed = BaroChartBar(time: Self.start + 60_000, open: 100, high: 110, low: 99, close: 108, volume: 9)
        try engine.apply(.correction(fixed))
        try engine.apply(.prepend([BaroChartBar(time: Self.start - 60_000, open: 99, high: 101, low: 98, close: 100, volume: 1)]))
        try engine.apply(.batch([.append(bars(1, from: 5)[0]), .update(bars(1, from: 5)[0])]))
        XCTAssertEqual(try storedBars(engine), 7)
        XCTAssertEqual(code { try engine.apply(.prepend([bars(1, from: 9)[0]])) }, .invalidArgument)
        XCTAssertEqual(code { try engine.apply(.correction(BaroChartBar(time: Self.start + 30_000, open: 1, high: 1, low: 1, close: 1, volume: 1))) }, .invalidArgument)
    }

    // MARK: - 시리즈·지표·드로잉 패치

    func testSeriesPatchChangesOnlyGivenFields() throws {
        let engine = try engine()
        defer { try? engine.close() }
        try engine.addIndicator(.rsi(period: 3), id: "rsi3")
        try engine.addSeries(BaroChartSeries(id: "rsi-line", type: .line, panel: "rsi", indicator: "rsi3", color: "#123456"))
        try engine.updateSeries(id: "rsi-line", BaroChartSeriesPatch(color: "#abcdef"))
        let series = try XCTUnwrap((try inspect(engine)["series"] as? [[String: Any]])?.first { $0["id"] as? String == "rsi-line" })
        XCTAssertEqual(series["panel"] as? String, "rsi")
        XCTAssertEqual((series["color"] as? String)?.prefix(7), "#abcdef")
        XCTAssertNotNil(code { try engine.updateSeries(id: "missing", BaroChartSeriesPatch(color: "#000000")) })
        XCTAssertNoThrow(try engine.removeSeries("rsi-line"))
        XCTAssertNoThrow(try engine.removeSeries("rsi-line"), "removing a missing series is a no-op in the core")
        XCTAssertNoThrow(try engine.removeIndicator("rsi3"))
        XCTAssertNotNil(code { try engine.removeIndicator("rsi3") })
    }

    func testIndicatorParamsChangeValues() throws {
        let engine = try engine(bars: 20)
        defer { try? engine.close() }
        try engine.addIndicator(.ema(period: 3), id: "ema")
        let before = try engine.indicatorValue(id: "ema", index: 19).value
        try engine.setIndicatorParams(id: "ema", ["period": 10])
        XCTAssertNotEqual(try engine.indicatorValue(id: "ema", index: 19).value, before)
        XCTAssertEqual(code { try engine.setIndicatorParams(id: "ema", ["period": -1]) }, .invalidArgument)
        XCTAssertNotNil(code { try engine.setIndicatorParams(id: "missing", ["period": 5]) })
    }

    func testDrawingPatchKeepsPointsAndPanel() throws {
        let engine = try engine()
        defer { try? engine.close() }
        let point = BaroChartPoint(time: Self.start + 60_000, price: 103)
        let id = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [point], panel: "rsi"))
        try engine.updateDrawing(id: id, BaroChartDrawingPatch(visible: false))
        let saved = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(engine.saveDrawings().utf8)) as? [String: Any])
        let drawing = try XCTUnwrap((saved["drawings"] as? [[String: Any]])?.first { $0["id"] as? String == id })
        XCTAssertEqual(drawing["panel"] as? String, "rsi")
        XCTAssertEqual(drawing["visible"] as? Bool, false)
        XCTAssertEqual((drawing["points"] as? [[String: Double]])?.first?["price"], 103)
        XCTAssertNotNil(code { try engine.updateDrawing(id: "missing", BaroChartDrawingPatch(visible: true)) })
    }

    func testSelectRedoAndLoadDrawings() throws {
        let engine = try engine()
        defer { try? engine.close() }
        let id = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: Self.start, price: 103)]))
        XCTAssertNoThrow(try engine.selectDrawing(id))
        XCTAssertNoThrow(try engine.selectDrawing(nil))
        XCTAssertNotNil(code { try engine.selectDrawing("missing") })
        let saved = try engine.saveDrawings()
        XCTAssertEqual(try engine.deleteDrawings(ids: [id]), 1)
        try engine.undo()
        try engine.redo()
        XCTAssertFalse(try engine.saveDrawings().contains(id))
        try engine.loadDrawings(saved)
        XCTAssertTrue(try engine.saveDrawings().contains(id))
        XCTAssertEqual(code { try engine.loadDrawings("not json") }, .invalidArgument)
    }

    func testSymbolAndCrosshair() throws {
        let engine = try engine()
        defer { try? engine.close() }
        XCTAssertNoThrow(try engine.setSymbol(BaroChartSymbol(id: "AAPL", exchange: "XNAS", timezone: "America/New_York", currency: "USD", priceDecimals: 2, tickSize: 0.01)))
        XCTAssertEqual(code { try engine.setSymbol(BaroChartSymbol(id: "AAPL", exchange: "XNAS", timezone: "America/New_York", currency: "USD", priceDecimals: -1, tickSize: 0.01)) }, .invalidArgument)
        XCTAssertNil(try engine.crosshair(width: 1200, height: 700))
        // fit 뒤 보기 범위는 최소 10봉 폭(-0.5~9.5)이라 봉 4개는 왼쪽 40%에 있다. x=250은 2번 봉 위다
        try engine.fit()
        _ = try engine.call("nativePointer", ["move", 1, 250, 300])
        let values = try XCTUnwrap(try engine.crosshair(width: 1200, height: 700))
        XCTAssertTrue((0..<4).contains(values.index))
        XCTAssertEqual(code { _ = try engine.crosshair(width: 10, height: 10) }, .invalidArgument)
    }

    // MARK: - 모든 타입 메서드: 닫힌 엔진·다른 스레드

    /// 모든 공개 타입 메서드를 한 번씩 부르는 표(복원은 async라 따로 확인한다)
    private func everyTypedCall(_ engine: BaroChartEngine) -> [(String, () throws -> Void)] {
        let bar = bars(1, from: 4)[0], data = bars()
        let binding = BaroChartDatasetBinding(key: "k", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        let symbol = BaroChartSymbol(id: "S", exchange: "X", timezone: "UTC", currency: "USD", priceDecimals: 2, tickSize: 0.01)
        let drawing = BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: Self.start, price: 1)])
        // 큰 배열 리터럴은 타입 추론 한계에 걸리므로 하나씩 추가한다
        var calls: [(String, () throws -> Void)] = []
        calls.append(("setBars", { try engine.setBars(data) }))
        calls.append(("apply", { try engine.apply(.append(bar)) }))
        calls.append(("addSeries", { try engine.addSeries(BaroChartSeries(id: "s", type: .line)) }))
        calls.append(("updateSeries", { try engine.updateSeries(id: "price", BaroChartSeriesPatch(color: "#ffffff")) }))
        calls.append(("removeSeries", { try engine.removeSeries("price") }))
        calls.append(("addIndicator", { try engine.addIndicator(.ema(period: 3), id: "e") }))
        calls.append(("setIndicatorParams", { try engine.setIndicatorParams(id: "e", ["period": 4]) }))
        calls.append(("indicatorValue", { _ = try engine.indicatorValue(id: "e", index: 0) }))
        calls.append(("removeIndicator", { try engine.removeIndicator("e") }))
        calls.append(("setTool", { try engine.setTool(.trendline) }))
        calls.append(("addDrawing", { _ = try engine.addDrawing(drawing) }))
        calls.append(("updateDrawing", { try engine.updateDrawing(id: "d", BaroChartDrawingPatch(visible: true)) }))
        calls.append(("deleteDrawings", { _ = try engine.deleteDrawings(ids: ["d"]) }))
        calls.append(("selectDrawing", { try engine.selectDrawing(nil) }))
        calls.append(("undo", { try engine.undo() }))
        calls.append(("redo", { try engine.redo() }))
        calls.append(("saveDrawings", { _ = try engine.saveDrawings() }))
        calls.append(("loadDrawings", { try engine.loadDrawings("{}") }))
        calls.append(("setTheme", { try engine.setTheme(.light) }))
        calls.append(("setSymbol", { try engine.setSymbol(symbol) }))
        calls.append(("visibleRange", { _ = try engine.visibleRange() }))
        calls.append(("setVisibleRange", { try engine.setVisibleRange(BaroChartVisibleRange(from: 0, to: 3)) }))
        calls.append(("fit", { try engine.fit() }))
        calls.append(("saveWorkspace", { _ = try engine.saveWorkspace(binding: binding) }))
        calls.append(("crosshair", { _ = try engine.crosshair(width: 400, height: 300) }))
        return calls
    }

    func testEveryTypedMethodRejectsClosedEngine() async throws {
        let engine = try engine()
        try engine.close()
        for (name, call) in everyTypedCall(engine) { XCTAssertEqual(code(call), .engineClosed, name) }
        do { try await engine.restoreWorkspace("{}", binding: BaroChartDatasetBinding(key: "k", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)); XCTFail("restore on a closed engine must throw") }
        catch let error as BaroChartError { XCTAssertEqual(error.code, .engineClosed) }
        XCTAssertNoThrow(try engine.close(), "close is idempotent")
    }

    func testEveryTypedMethodRejectsOtherThread() throws {
        let engine = try engine()
        defer { try? engine.close() }
        var observed: [(String, BaroChartError.Code?)] = []
        let calls = everyTypedCall(engine) + [("close", { try engine.close() })]
        let finished = DispatchSemaphore(value: 0)
        // 실제 다른 스레드에서 부른다(DispatchQueue.sync는 호출 스레드에서 실행될 수 있다)
        Thread {
            for (name, call) in calls { observed.append((name, self.code(call))) }
            finished.signal()
        }.start()
        finished.wait()
        for (name, observedCode) in observed { XCTAssertEqual(observedCode, .wrongThread, name) }
        XCTAssertFalse(engine.isClosed)
        XCTAssertEqual(try storedBars(engine), 4)
    }

    // MARK: - 이름 변경 이전 저장본

    func testLegacyWorkspaceRestoresAndResavesByteIdentically() async throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "aster-workspace-v1", withExtension: "json"))
        let document = try String(contentsOf: url, encoding: .utf8)
        // test/fixtures/legacy/build-legacy-chart.mjs와 같은 40개 봉
        let rows: [BaroChartBar] = (0..<40).map { (i: Int) -> BaroChartBar in
            let step = Double(i)
            return BaroChartBar(time: Self.start + step * 60_000, open: 100 + step, high: 103 + step, low: 99 + step, close: 102 + step, volume: 500 + step)
        }
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        defer { try? engine.close() }
        try engine.setBars(rows)
        let binding = BaroChartDatasetBinding(key: "legacy-rename", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        try await engine.restoreWorkspace(document, binding: binding)
        XCTAssertEqual(try engine.saveWorkspace(binding: binding), document)
    }
}
