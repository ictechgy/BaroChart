import Foundation
import JavaScriptCore
import XCTest
@testable import BaroChart

/// 시간대 계약 v1(설계 §7.4-2, M0 Task 2)을 JavaScriptCore에서 확인한다.
///
/// 이름 문법, 지원 연도(1000~9999), 오류 문구는 코어가 정한다. 그래서 JSC Intl의 문구(`invalid time zone: X`)나
/// JSC 날짜 처리(연도 `999`, `Date.parse` NaN) 대신 Node·Android와 같은 계약 결과가 나와야 한다.
/// Android `TimeZoneContractTest`와 같은 시나리오·기대값이다.
final class TimeZoneContractTests: XCTestCase {
    /// 1000-01-01T00:00:00Z(UTC epoch ms): 지원 연도 첫날의 UTC 자정
    private static let year1000 = -30_610_224_000_000.0
    /// 9999-12-31T23:59:00Z(UTC epoch ms): 지원 연도 마지막 날의 마지막 분
    private static let year9999LastMinute = 253_402_300_740_000.0

    /// 시간대만 바꾼 심볼. 나머지 필드는 계약과 무관한 고정값이다.
    private func symbol(_ timezone: String) -> BaroChartSymbol {
        BaroChartSymbol(id: "TZ", exchange: "TEST", timezone: timezone, currency: "USD", priceDecimals: 2, tickSize: 0.01)
    }

    /// 번들 표현식을 JSC에서 실행해 결과 JSON이나 오류 문자열(`RangeError: …`)을 돌려준다.
    /// 공개 `context`는 JS 백엔드 전용 화이트박스 경로라, 계약 함수를 시나리오 없이 직접 부를 때만 쓴다.
    private func evaluate(_ engine: BaroChartEngine, _ expression: String) -> String? {
        autoreleasepool {
            engine.context.evaluateScript("(function(){try{return JSON.stringify(\(expression));}catch(error){return String(error);}})()")?.toString()
        }
    }

    /// 1분봉 10개를 `start`부터 넣은 엔진을 만든다(타입 API, 기본 옵션은 캔들 하나).
    private func engine(barsFrom start: Double) throws -> BaroChartEngine {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars((0..<10).map { i in BaroChartBar(time: start + Double(i) * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10) })
        return engine
    }

    /// 400×300 장면의 시간축 라벨(`role == "time-tick"`)을 돌려준다. 코어 오류는 ``BaroChartError``로 바꿔 던진다.
    private func timeLabels(_ engine: BaroChartEngine) throws -> [String] {
        let text = try BaroChartError.mapping { try engine.call("nativeSceneJSON", [400, 300]).toString() ?? "" }
        let scene = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        let commands = scene?["commands"] as? [[String: Any]] ?? []
        return commands.filter { $0["role"] as? String == "time-tick" }.compactMap { $0["fullText"] as? String }
    }

    /// 본문이 던진 ``BaroChartError``를 돌려준다. 던지지 않으면 테스트를 실패시킨다.
    private func failure(_ body: () throws -> Void, _ message: String) -> BaroChartError? {
        do { try body() } catch let error as BaroChartError { return error } catch { XCTFail("\(message): unexpected \(error)"); return nil }
        XCTFail(message)
        return nil
    }

    func testHostOnlyZoneIsInvalidArgumentWithCoreMessage() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        let error = failure({ try engine.setSymbol(symbol("Z")) }, "'Z' is a java.time-only name and must be rejected by the core")
        XCTAssertEqual(error?.code, .invalidArgument)
        XCTAssertTrue(error?.message.contains("Unsupported time zone: Z") == true, error?.message ?? "")
    }

    func testLowercaseIanaNameAndFixedOffsetAreAccepted() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        XCTAssertNoThrow(try engine.setSymbol(symbol("asia/seoul")))
        XCTAssertNoThrow(try engine.setSymbol(symbol("+09:00")))
    }

    func testJavaScriptCoreFollowsTheCoreContract() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        let cases: [(String, String)] = [
            ("Aster.zonedParts(1773063000000,'america/new_york')", #"{"year":"2026","month":"03","day":"09","hour":"09","minute":"30","second":"00"}"#),
            ("Aster.zonedParts(1773063000000,'+09:00')", #"{"year":"2026","month":"03","day":"09","hour":"22","minute":"30","second":"00"}"#),
            ("Aster.zonedParts(-30610224000000,'Etc/GMT-14')", #"{"year":"1000","month":"01","day":"01","hour":"14","minute":"00","second":"00"}"#),
            ("Aster.zonedParts(-30610224000000,'Etc/GMT+12')", "RangeError: Time zone conversion year out of range"),
            ("Aster.zonedParts(253402300799999,'Etc/GMT+12')", #"{"year":"9999","month":"12","day":"31","hour":"11","minute":"59","second":"59"}"#),
            ("Aster.zonedParts(253402300799999,'Etc/GMT-14')", "RangeError: Time zone conversion year out of range"),
            ("Aster.zonedParts(NaN,'UTC')", "RangeError: Time zone conversion requires a finite time"),
            ("Aster.zonedParts(0,'Foo/Bar')", "RangeError: Unsupported time zone: Foo/Bar"),
            ("Aster.zonedParts(0,'UTC+9')", "RangeError: Unsupported time zone: UTC+9"),
            ("Aster.zonedParts(0,'UT')", "RangeError: Unsupported time zone: UT"),
            ("Aster.zonedEpoch('2026-03-08','02:30','America/New_York')", "RangeError: Nonexistent local time at DST boundary"),
            ("Aster.zonedEpoch('2026-11-01','01:30','America/New_York')", "1793511000000"),
            ("Aster.zonedEpoch('2026-11-01','01:30','America/New_York','later')", "1793514600000"),
            ("Aster.zonedEpoch('2026-02-30','09:30','America/New_York')", "TypeError: ISO date and HH:mm[:ss] required"),
            ("Aster.shiftDate('2024-02-28',1)", #""2024-02-29""#),
            ("Aster.shiftDate('9999-12-31',1)", "RangeError: Time zone conversion year out of range"),
        ]
        for (expression, expected) in cases {
            XCTAssertEqual(evaluate(engine, expression), expected, expression)
        }
    }

    func testTimeLabelsAtSupportedYearEdgesMatchAcrossHosts() throws {
        let early = try engine(barsFrom: Self.year1000)
        defer { try? early.close() }
        try early.setSymbol(symbol("Etc/GMT-14"))
        let earlyLabels = try timeLabels(early)
        XCTAssertFalse(earlyLabels.isEmpty)
        XCTAssertTrue(earlyLabels.allSatisfy { $0.hasPrefix("1000-01-01 ") }, "\(earlyLabels)")
        try early.setSymbol(symbol("Etc/GMT+12"))
        let earlyError = failure({ _ = try timeLabels(early) }, "local year 999 must be rejected")
        XCTAssertEqual(earlyError?.code, .invalidArgument)
        XCTAssertEqual(earlyError?.message, "Time zone conversion year out of range")

        let late = try engine(barsFrom: Self.year9999LastMinute - 9 * 60_000)
        defer { try? late.close() }
        try late.setSymbol(symbol("Etc/GMT+12"))
        let lateLabels = try timeLabels(late)
        XCTAssertFalse(lateLabels.isEmpty)
        XCTAssertTrue(lateLabels.allSatisfy { $0.hasPrefix("9999-12-31 ") }, "\(lateLabels)")
        try late.setSymbol(symbol("Etc/GMT-14"))
        let lateError = failure({ _ = try timeLabels(late) }, "local year 10000 must be rejected")
        XCTAssertEqual(lateError?.code, .invalidArgument)
        XCTAssertEqual(lateError?.message, "Time zone conversion year out of range")
    }
}
