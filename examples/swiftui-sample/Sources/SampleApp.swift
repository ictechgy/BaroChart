import SwiftUI

/// BaroChart SwiftUI 샘플 앱 진입점
@main
struct SampleApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.environment["BAROCHART_DEVICE_TEST_HOST"] == "1" {
                Color.clear
            } else {
                ChartScreen()
            }
        }
    }
}
