import XCTest

/// 샘플 앱의 주요 흐름을 실제 앱 프로세스에서 확인한다(차트 표시·드로잉·저장/복원·테마·오류 없음).
final class SampleUITests: XCTestCase {
    @MainActor
    private func updates(_ element: XCUIElement) -> Int {
        Int(element.label.components(separatedBy: "Updates ").last ?? "-1") ?? -1
    }

    @MainActor
    func testStreamingSuspensionAndPausedIntent() throws {
        let app = XCUIApplication()
        app.launch()
        let summary = app.staticTexts["sample-stream-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 30))
        let active = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label MATCHES %@", "Bars [0-9]+ · Updates [1-9][0-9]*"), object: summary)
        XCTAssertEqual(XCTWaiter.wait(for: [active], timeout: 10), .completed)
        let before = updates(summary)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        Thread.sleep(forTimeInterval: 2.2)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertGreaterThanOrEqual(updates(summary), before, "returning must retain the same source")
        XCTAssertLessThanOrEqual(updates(summary), before + 1, "background must not keep streaming; one foreground tick is allowed for UI query latency")
        XCTAssertTrue(app.buttons["sample-stream"].wait(for: \.isHittable, toEqual: true, timeout: 5), "stream control must remain reachable")
        app.buttons["sample-stream"].tap()
        XCTAssertTrue(app.buttons["sample-stream"].wait(for: \.label, toEqual: "Live", timeout: 5), "pause action must be accepted before leaving the app")
        let paused = updates(summary)
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1.2)
        app.activate()
        XCTAssertEqual(updates(summary), paused)
        XCTAssertEqual(app.buttons["sample-stream"].label, "Live")
    }

    @MainActor
    func testRotationRetainsAnalysis() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["sample-stream"].waitForExistence(timeout: 30))
        app.buttons["sample-stream"].tap()
        app.buttons["sample-line"].tap()
        app.buttons["sample-save"].tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(app.descendants(matching: .any)["Financial chart"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["sample-stream"].label, "Live")
        app.buttons["sample-restore"].tap()
        let status = app.staticTexts["sample-status"]
        XCTAssertTrue(status.wait(for: \.label, toEqual: "Restored", timeout: 15))
        XCTAssertFalse(app.staticTexts["sample-error"].exists)
    }

    @MainActor
    func testSavePausesTheStreamAndRestoresTheSameSource() throws {
        let app = XCUIApplication()
        app.launch()
        let summary = app.staticTexts["sample-stream-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 30))
        app.buttons["sample-save"].tap()
        XCTAssertEqual(app.buttons["sample-stream"].label, "Live")
        let saved = updates(summary)
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertEqual(updates(summary), saved)
        app.buttons["sample-restore"].tap()
        let status = app.staticTexts["sample-status"]
        XCTAssertTrue(status.wait(for: \.label, toEqual: "Restored", timeout: 15))
        XCTAssertFalse(app.staticTexts["sample-error"].exists)
    }

    @MainActor
    func testChangedSourceRejectsTheSavedDatasetRevision() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["sample-stream"].waitForExistence(timeout: 30))
        app.buttons["sample-stream"].tap()
        app.buttons["sample-save"].tap()
        let summary = app.staticTexts["sample-stream-summary"], saved = updates(summary)
        app.buttons["sample-stream"].tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", summary.label), object: summary)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 10), .completed)
        XCTAssertGreaterThan(updates(summary), saved)
        app.buttons["sample-restore"].tap()
        XCTAssertTrue(app.staticTexts["sample-error"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["sample-stream"].label, "Live")
    }

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
