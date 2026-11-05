import XCTest
@testable import BaroChart

/// 타입 엔진 API를 실제 JavaScriptCore에서 실행한다. 모든 실패는 BaroChartError로만 나와야 한다.
@MainActor
final class TypedEngineTests: BackendSelectedTestCase {
    private static let start = 1_700_000_000_000.0
    /// 1분봉 count개(종가 102부터 1씩 증가). 앞 4개는 README 예제와 같다.
    private func bars(_ count: Int = 4) -> [BaroChartBar] {
        (0..<count).map { i in
            let close = 102 + Double(i)
            return BaroChartBar(time: Self.start + Double(i) * 60_000, open: close - 2, high: close + 1, low: close - 3, close: close, volume: 500 + Double(i) * 100)
        }
    }

    private func engineWithBars(_ count: Int = 4) throws -> BaroChartEngine {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars(bars(count))
        return engine
    }

    private func code(_ body: () throws -> Void) -> BaroChartError.Code? {
        do { try body() } catch { return (error as? BaroChartError)?.code }
        return nil
    }

    func testCandlesEmaFlow() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        try engine.addIndicator(.ema(period: 3), id: "ema3")
        try engine.addSeries(BaroChartSeries(id: "ema3-line", type: .line, indicator: "ema3", color: "#f0b755"))
        try engine.fit()
        let value = try engine.indicatorValue(id: "ema3", index: 3)
        // Node 코어로 같은 데이터를 계산한 EMA(3) 값
        XCTAssertEqual(try XCTUnwrap(value.value), 104, accuracy: 1e-9)
        XCTAssertEqual(value.sourceIndex, 3)
        XCTAssertEqual(value.sourceTime, Self.start + 180_000)
    }

    func testDefaultOptionsCreateUnlabeledCandlesOnly() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        defer { try? engine.close() }
        let state = try XCTUnwrap(engine.command("inspect").toDictionary())
        let panels = try XCTUnwrap(state["panels"] as? [[String: Any]])
        XCTAssertEqual(panels.map { $0["id"] as? String }, ["price"])
        XCTAssertNil(panels[0]["label"] as? String)
        let series = try XCTUnwrap(state["series"] as? [[String: Any]])
        XCTAssertEqual(series.map { $0["id"] as? String }, ["price"])
        XCTAssertEqual(series.first?["type"] as? String, "candles")
    }

    func testUpdateMustTargetLastBar() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        let before = try engine.saveDrawings()
        let stale = BaroChartBar(time: Self.start, open: 1, high: 1, low: 1, close: 1, volume: 1)
        XCTAssertEqual(code { try engine.apply(.update(stale)) }, .invalidArgument)
        XCTAssertEqual(try engine.saveDrawings(), before)
        XCTAssertEqual(try engine.command("inspect").toDictionary()["storedBars"] as? Int, 4)
    }

    func testResetRejectsUnsortedAndNaN() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        let bars = bars()
        XCTAssertEqual(code { try engine.apply(.reset([bars[1], bars[0]])) }, .invalidArgument)
        let broken = BaroChartBar(time: Self.start, open: .nan, high: 1, low: 1, close: 1, volume: 1)
        XCTAssertEqual(code { try engine.apply(.reset([broken])) }, .invalidArgument)
        XCTAssertEqual(try engine.command("inspect").toDictionary()["storedBars"] as? Int, 4)
    }

    func testClosedEngineThrows() throws {
        let engine = try engineWithBars()
        try engine.close()
        XCTAssertTrue(engine.isClosed)
        XCTAssertEqual(code { try engine.setBars(self.bars()) }, .engineClosed)
        XCTAssertEqual(code { try engine.addSeries(BaroChartSeries(id: "x", type: .line)) }, .engineClosed)
        XCTAssertEqual(code { try engine.fit() }, .engineClosed)
    }

    func testWrongThreadThrows() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        let bars = bars()
        var observed: BaroChartError.Code?
        let finished = DispatchSemaphore(value: 0)
        // DispatchQueue.sync는 호출 스레드에서 블록을 실행할 수 있어, 실제 다른 스레드를 만든다
        Thread {
            do { try engine.setBars(bars) } catch { observed = (error as? BaroChartError)?.code }
            finished.signal()
        }.start()
        finished.wait()
        XCTAssertEqual(observed, .wrongThread)
    }

    func testDrawingRoundTrip() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        let id = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: Self.start + 60_000, price: 101)]))
        XCTAssertTrue(try engine.saveDrawings().contains("\"schema\":\"aster.drawings\""))
        XCTAssertEqual(try engine.deleteDrawings(ids: [id]), 1)
        XCTAssertFalse(try engine.saveDrawings().contains(id))
        try engine.undo()
        XCTAssertTrue(try engine.saveDrawings().contains(id))
    }

    func testSelectToolCannotBeDrawn() throws {
        let engine = try engineWithBars()
        defer { try? engine.close() }
        XCTAssertEqual(code { _ = try engine.addDrawing(BaroChartDrawing(tool: .select, points: [])) }, .invalidArgument)
        XCTAssertNoThrow(try engine.setTool(.trendline))
    }

    func testThemeAndRange() throws {
        let engine = try engineWithBars(40)
        defer { try? engine.close() }
        try engine.setTheme(.light)
        let theme = try XCTUnwrap(engine.command("inspect").toDictionary()["theme"] as? [String: String])
        // 코어는 색을 #rrggbbaa로 정규화한다
        for (key, value) in BaroChartTheme.light.lowLevel as! [String: String] {
            XCTAssertEqual(theme[key], key == "font" ? value : value + "ff", key)
        }
        try engine.setVisibleRange(BaroChartVisibleRange(from: 5, to: 25))
        let range = try engine.visibleRange()
        XCTAssertEqual(range.from, 5, accuracy: 1e-9)
        XCTAssertEqual(range.to, 25, accuracy: 1e-9)
    }

    func testWorkspaceRoundTrip() async throws {
        let binding = BaroChartDatasetBinding(key: "SYNTH:US", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        let source = try engineWithBars()
        defer { try? source.close() }
        try source.addIndicator(.ema(period: 3), id: "ema3")
        _ = try source.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: Self.start, price: 103)]))
        let document = try source.saveWorkspace(binding: binding)
        let target = try engineWithBars()
        defer { try? target.close() }
        try await target.restoreWorkspace(document, binding: binding)
        XCTAssertEqual(try target.saveWorkspace(binding: binding), document)
    }

    func testRestoreCancellation() async throws {
        let binding = BaroChartDatasetBinding(key: "SYNTH:US", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        let source = try engineWithBars()
        defer { try? source.close() }
        let document = try source.saveWorkspace(binding: binding)
        let target = try engineWithBars()
        defer { try? target.close() }
        let task = Task { @MainActor in try await target.restoreWorkspace(document, binding: binding) }
        task.cancel()
        do {
            try await task.value
            XCTFail("A cancelled restore must not report success")
        } catch let error as BaroChartError {
            XCTAssertEqual(error.code, .cancelled)
        }
        XCTAssertNoThrow(try target.fit())
    }
}
