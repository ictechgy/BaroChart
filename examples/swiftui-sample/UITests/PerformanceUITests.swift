import XCTest

/// 실기기 성능 측정(G6): 앱을 측정 모드로 띄우고 결과 JSON을 로그로 남긴다(scripts/measure-native-device.mjs가 수집).
final class PerformanceUITests: XCTestCase {
    @MainActor
    func testDeviceBenchmark() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-barochart-benchmark"]
        app.launch()
        let result = app.staticTexts["sample-benchmark"]
        XCTAssertTrue(result.waitForExistence(timeout: 180), "benchmark did not finish")
        print("BAROCHART_DEVICE_BENCHMARK \(result.label)")
        XCTAssertFalse(result.label.contains("\"error\""), result.label)
    }
}
