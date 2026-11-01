#if canImport(UIKit)
import BaroChart
import JavaScriptCore
import UIKit
import XCTest

/// 엔진 수명주기의 메모리 계약: 닫고 놓은 엔진의 JSContext는 호출자의 autorelease 풀이 비워지기 전에도 해제되어야 한다.
///
/// 테스트 메서드 안에는 풀 비움이 없으므로, JSC 임시 JSValue가 SDK 밖 풀에 남으면 컨텍스트가 살아남아 실패한다.
/// (백그라운드 소유 스레드나 한 런루프 턴 안에서 엔진을 반복 생성하는 앱에서 컨텍스트가 쌓이던 문제의 회귀 방지)
@MainActor
final class EngineMemoryTests: XCTestCase {
    private func bars(_ count: Int) -> [BaroChartBar] {
        (0..<count).map { i in BaroChartBar(time: 1_700_000_000_000 + Double(i) * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10) }
    }

    func testClosedEngineReleasesContextWithoutOuterAutoreleasePool() throws {
        weak var releasedContext: JSContext?
        do {
            let engine = try BaroChartEngine(options: BaroChartEngineOptions())
            try engine.setBars(bars(200))
            let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 320, height: 240))
            view.setNeedsDisplay(); view.layer.displayIfNeeded()
            view.dispose()
            try engine.close()
            releasedContext = engine.context
        }
        XCTAssertNil(releasedContext, "JSContext outlived its closed engine; autoreleased JSC values are escaping the SDK's pools")
    }
}
#endif
