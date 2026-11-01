import XCTest

/// 샘플 차트 화면에 XCUI 접근성 감사(대비·설명·터치 영역·Dynamic Type·잘림 등)를 실행한다(G7).
final class AccessibilityUITests: XCTestCase {
    @MainActor
    func testChartScreenPassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["Financial chart"].waitForExistence(timeout: 30))
        let stream = app.buttons["sample-stream"]
        stream.tap()  // 감사 중 화면이 바뀌지 않게 스트리밍을 멈춘다
        // 탭 직후에는 버튼이 눌림 강조로 흐려져 대비 검사가 그 순간을 잡는다. 상태가 바뀐 뒤 강조가 끝날 때까지 기다린다
        let paused = expectation(for: NSPredicate(format: "label == 'Live'"), evaluatedWith: stream)
        wait(for: [paused], timeout: 5)
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "press highlight settles")], timeout: 1)
        // 실패 원인을 가릴 수 있도록 각 문제의 종류·요소를 로그에 남긴다(무시하지 않음)
        try app.performAccessibilityAudit { issue in
            print("AUDIT_ISSUE type=\(issue.auditType.rawValue) desc=\(issue.compactDescription) element=\(issue.element.map { "\($0.elementType.rawValue) id=\($0.identifier) label=\($0.label)" } ?? "nil")")
            return false
        }
    }
}
