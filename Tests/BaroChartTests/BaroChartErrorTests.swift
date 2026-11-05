import XCTest
@testable import BaroChart

/// 저수준 오류가 타입 API 오류(BaroChartError)로 일관되게 바뀌는지 확인한다.
final class BaroChartErrorTests: BackendSelectedTestCase {
    /// 던진 오류의 코드를 꺼낸다(BaroChartError가 아니면 nil)
    private func code(_ body: () throws -> Void) -> BaroChartError.Code? {
        do { try body() } catch { return (error as? BaroChartError)?.code }
        return nil
    }

    func testClosedEngineMapsToEngineClosed() throws {
        let engine = try BaroChartEngine()
        try engine.close()
        XCTAssertEqual(code { try BaroChartError.mapping { try engine.fit() } }, .engineClosed)
    }

    func testJavaScriptTypeErrorMapsToInvalidArgument() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        do {
            try BaroChartError.mapping { try engine.addSeries(["id": "x", "type": "line", "panel": "price", "bogusKey": 1]) }
            XCTFail("An unsupported series field must be rejected")
        } catch let error as BaroChartError {
            XCTAssertEqual(error.code, .invalidArgument)
            XCTAssertTrue(error.message.contains("unsupported field bogusKey"), error.message)
        }
    }

    func testPlainJavaScriptErrorStaysJavaScript() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        XCTAssertEqual(code { try BaroChartError.mapping { try engine.addSeries(["id": "x", "type": "bogus", "panel": "price"]) } }, .javaScript)
    }

    func testUnavailableRustErrorMapsToUnavailable() {
        let error = BaroChartError.wrap(BaroChartLowLevelError.javaScript("UnavailableError: nativeFoo is not available in the Rust backend"))
        XCTAssertEqual(error.code, .unavailable)
        XCTAssertEqual(error.message, "nativeFoo is not available in the Rust backend")
    }

    func testLimitRangeErrorMapsToBudgetExceeded() {
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.javaScript("RangeError: Bars: limit 4194304")).code, .budgetExceeded)
    }

    func testStringLengthValidationIsNotABudget() {
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.javaScript("TypeError: Series panel: string limit 128")).code, .invalidArgument)
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.javaScript("RangeError: Series width")).code, .invalidArgument)
    }

    func testAsyncAndWorkspaceErrorsMap() {
        XCTAssertEqual(BaroChartError.wrap(BaroChartAsyncError.mainOwnerRequired).code, .wrongThread)
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.wrongThread).code, .wrongThread)
        XCTAssertEqual(BaroChartError.wrap(BaroChartAsyncError.cancelled).code, .cancelled)
        XCTAssertEqual(BaroChartError.wrap(CancellationError()).code, .cancelled)
        XCTAssertEqual(BaroChartError.wrap(BaroChartWorkspaceError.cleanupPending(registration: 1)).code, .cleanupPending)
        XCTAssertEqual(BaroChartError.wrap(BaroChartParamsError.cleanupPending(registration: 1, outcome: .unknown)).code, .cleanupPending)
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.invalidScene).code, .invalidScene)
        XCTAssertEqual(BaroChartError.wrap(BaroChartLowLevelError.unavailableContext).code, .unavailable)
    }

    func testWrapIsIdempotentAndKeepsUnderlyingDescription() {
        let wrapped = BaroChartError.wrap(BaroChartAsyncError.engineClosed)
        XCTAssertEqual(BaroChartError.wrap(wrapped).code, .engineClosed)
        XCTAssertNotNil(wrapped.underlyingDescription)
    }

    func testEveryCodeHasRecoveryInDescription() {
        for code in BaroChartError.Code.allCases {
            let error = BaroChartError(code: code, message: "probe")
            XCTAssertFalse(error.recovery.isEmpty, code.rawValue)
            XCTAssertTrue(error.description.contains(code.rawValue) && error.description.contains(error.recovery))
        }
    }

    func testMappingReturnsValue() throws {
        XCTAssertEqual(try BaroChartError.mapping { 42 }, 42)
    }
}
