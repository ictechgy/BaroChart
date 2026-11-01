import XCTest

/// 샘플 앱의 주요 흐름을 실제 앱 프로세스에서 확인한다(차트 표시·드로잉·저장/복원·테마·오류 없음).
final class SampleUITests: XCTestCase {
    @MainActor
    func testMainFlow() throws {
        let app = XCUIApplication()
        app.launch()
        let status = app.staticTexts["sample-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 30))
        XCTAssertTrue(app.descendants(matching: .any)["Financial chart"].waitForExistence(timeout: 10))
        app.descendants(matching: .any)["sample-stream"].firstMatch.tap()  // 저장~복원 사이에 새 봉이 추가되지 않도록 스트리밍을 멈춘다
        app.buttons["sample-line"].tap()
        XCTAssertEqual(status.label, "Line added")
        app.buttons["sample-save"].tap()
        XCTAssertEqual(status.label, "Saved")
        app.buttons["sample-restore"].tap()
        XCTAssertTrue(status.wait(for: \.label, toEqual: "Restored", timeout: 15), "restore status: \(status.label)")
        app.buttons["sample-theme"].tap()
        XCTAssertEqual(status.label, "Light")
        XCTAssertFalse(app.staticTexts["sample-error"].exists)
    }
}
