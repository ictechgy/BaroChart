import XCTest

/// 실기기 성능 측정(G6): 앱을 측정 모드로 띄우고 결과 JSON을 로그로 남긴다(scripts/measure-native-device.mjs가 수집).
final class PerformanceUITests: XCTestCase {
    @MainActor
    func testDeviceBenchmark() throws {
        let app = XCUIApplication()
        let backend = ProcessInfo.processInfo.environment["TEST_RUNNER_BAROCHART_BACKEND"] ?? "javascript"
        let runId = ProcessInfo.processInfo.environment["TEST_RUNNER_BAROCHART_RUN_ID"] ?? "missing-run-id"
        app.launchArguments = ["-barochart-benchmark", "-barochart-backend", backend, "-barochart-run-id", runId]
        app.launchEnvironment["BAROCHART_BACKEND"] = backend
        app.launchEnvironment["BAROCHART_RUN_ID"] = runId
        app.launch()
        let result = app.staticTexts["sample-benchmark"]
        XCTAssertTrue(result.waitForExistence(timeout: 180), "benchmark did not finish")
        print("BAROCHART_DEVICE_BENCHMARK \(result.label)")
        let payload = try XCTUnwrap(result.label.data(using: .utf8))
        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertNil(report["error"], result.label)
        XCTAssertEqual(report["runId"] as? String, runId)
        XCTAssertEqual(report["actualBackend"] as? String, backend)
        XCTAssertEqual(report["backendVerified"] as? Bool, true)
    }
}
