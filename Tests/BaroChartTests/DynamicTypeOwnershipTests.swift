#if canImport(UIKit)
import UIKit
import XCTest
@testable import BaroChart

/// 같은 엔진을 두 뷰가 이어받아도(SwiftUI 재생성 순서: 새 뷰 생성 → 이전 뷰 정리) Dynamic Type 배율은 원래 글꼴에서 한 번만 적용되고,
/// 소유 뷰가 정리될 때만 원래 글꼴로 돌아와야 한다.
@MainActor
final class DynamicTypeOwnershipTests: XCTestCase {
    private var window: UIWindow!

    override func setUp() async throws {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.makeKeyAndVisible()
        // 테스트 호스트 앱은 비활성 상태라 창에 붙은 차트가 일시정지된다. 실제 앱의 활성화 알림을 재현한다.
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    override func tearDown() async throws {
        window.isHidden = true
        window = nil
    }

    private func font(_ engine: BaroChartEngine) throws -> String { try XCTUnwrap(engine.call("nativeThemeFont").toString()) }

    private func attachedView(_ engine: BaroChartEngine) -> BaroChartUIView {
        let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 390, height: 320))
        window.addSubview(view)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        return view
    }

    func testSecondViewTakesOverScaleWithoutDoubleScaling() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        defer { try? engine.close() }
        let base = try font(engine)
        let first = attachedView(engine)
        first.adjustsFontForContentSizeCategory = true
        let scaledOnce = try font(engine)
        XCTAssertNotEqual(scaledOnce, base, "the accessibility size category must scale the font")

        let second = attachedView(engine)
        second.adjustsFontForContentSizeCategory = true
        XCTAssertEqual(try font(engine), scaledOnce, "the second view must scale from the original font, not the scaled one")

        first.dispose()
        XCTAssertEqual(try font(engine), scaledOnce, "a view that no longer owns the scale must not restore the font")
        second.dispose()
        XCTAssertEqual(try font(engine), base, "the owning view restores the original font")
    }
}
#endif
