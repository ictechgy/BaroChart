import XCTest
@testable import BaroChart

/// 타입 API의 enum 원시값·테마 프리셋이 코어 어휘(vocabulary.json)와 같은지, 저수준 변환이 정확한지 확인한다.
final class TypesParityTests: XCTestCase {
    private struct Vocabulary: Decodable {
        let indicators: [String], drawings: [String], seriesTypes: [String]
        let darkTheme: [String: String], lightTheme: [String: String]
    }

    private func vocabulary() throws -> Vocabulary {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "vocabulary", withExtension: "json"))
        return try JSONDecoder().decode(Vocabulary.self, from: Data(contentsOf: url))
    }

    func testIndicatorKindsMatchCore() throws {
        XCTAssertEqual(Set(BaroChartIndicatorKind.allCases.map(\.rawValue)), Set(try vocabulary().indicators))
        XCTAssertEqual(BaroChartIndicatorKind.allCases.count, 35)
    }

    func testDrawingToolsMatchCore() throws {
        let drawable = BaroChartDrawingTool.allCases.filter { $0 != .select }.map(\.rawValue)
        XCTAssertEqual(Set(drawable), Set(try vocabulary().drawings))
        XCTAssertEqual(drawable.count, 16)
    }

    func testSeriesTypesMatchCore() throws {
        XCTAssertEqual(BaroChartSeriesType.allCases.map(\.rawValue), try vocabulary().seriesTypes)
    }

    func testThemePresetsMatchCore() throws {
        let vocabulary = try vocabulary()
        XCTAssertEqual(BaroChartTheme.dark.lowLevel as? [String: String], vocabulary.darkTheme)
        XCTAssertEqual(BaroChartTheme.light.lowLevel as? [String: String], vocabulary.lightTheme)
    }

    func testSeriesLowLevelOmitsNilFields() {
        let lowLevel = BaroChartSeries(id: "e", type: .line).lowLevel
        XCTAssertEqual(lowLevel.count, 3)
        XCTAssertEqual(lowLevel["id"] as? String, "e")
        XCTAssertEqual(lowLevel["type"] as? String, "line")
        XCTAssertEqual(lowLevel["panel"] as? String, "price")
    }

    func testDataEventKinds() {
        let bar = BaroChartBar(time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1)
        let kinds = [BaroChartDataEvent.reset([bar]), .append(bar), .update(bar), .correction(bar), .prepend([bar]), .batch([.append(bar)])]
            .map { $0.lowLevel["kind"] as? String }
        XCTAssertEqual(kinds, ["reset", "append", "update", "correction", "prepend", "batch"])
        let batch = BaroChartDataEvent.batch([.append(bar)]).lowLevel["events"] as? [[String: Any]]
        XCTAssertEqual(batch?.first?["kind"] as? String, "append")
    }

    func testIndicatorConveniencesUseCoreParameterNames() {
        XCTAssertEqual(BaroChartIndicator.macd(fast: 12, slow: 26, signal: 9).params, ["fast": 12, "slow": 26, "signal": 9])
        XCTAssertEqual(BaroChartIndicator.bollinger(period: 20, deviation: 2).params, ["period": 20, "deviation": 2])
        XCTAssertEqual(BaroChartIndicator.ema(period: 3).kind, .ema)
        XCTAssertEqual(BaroChartIndicator.vwap().params, [:])
    }

    func testDrawingAndBindingLowLevel() {
        let drawing = BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: 10, price: 101)], text: "Level")
        let lowLevel = drawing.lowLevel
        XCTAssertEqual(lowLevel["type"] as? String, "horizontal")
        XCTAssertEqual((lowLevel["points"] as? [[String: Double]])?.first, ["time": 10, "price": 101])
        XCTAssertNil(lowLevel["id"])
        let binding = BaroChartDatasetBinding(key: "k", revision: "1", adjustmentVersion: "a", priceUnit: "USD", adjustment: .totalReturn).lowLevel
        XCTAssertEqual(binding["adjustment"] as? String, "total-return")
    }
}
