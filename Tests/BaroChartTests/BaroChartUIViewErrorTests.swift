#if canImport(UIKit)
import XCTest
import UIKit
@testable import BaroChart

/// UIKit 뷰가 던질 수 없는 경로의 실패를 onError로 전달하고, 앱이 부르는 setter는 오류를 던지는지 확인한다.
@MainActor
final class BaroChartUIViewErrorTests: XCTestCase {
    private func makeView(_ engine: BaroChartEngine) -> BaroChartUIView {
        BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 320, height: 240))
    }

    func testDrawFailureReachesOnError() throws {
        let engine = try BaroChartEngine()
        let view = makeView(engine)
        var received: [BaroChartError.Code] = []
        view.onError = { received.append($0.code) }
        try engine.close()
        _ = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in view.draw(view.bounds) }
        XCTAssertEqual(received, [.engineClosed])
        XCTAssertNotNil(view.lastError)
    }

    func testSetToolThrowsInsteadOfSwallowing() throws {
        let engine = try BaroChartEngine()
        defer { try? engine.close() }
        let view = makeView(engine)
        XCTAssertThrowsError(try view.setTool("bogus")) { error in
            XCTAssertEqual((error as? BaroChartError)?.code, .javaScript)
            XCTAssertTrue((error as? BaroChartError)?.message.contains("Unknown drawing tool") == true)
        }
        XCTAssertNoThrow(try view.setTool("trendline"))
    }
}
#endif
