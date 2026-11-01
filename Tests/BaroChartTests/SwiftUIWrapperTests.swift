#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI
import UIKit
import XCTest
@testable import BaroChart

/// SwiftUI 래퍼는 사라질 때 뷰만 정리하고 엔진은 닫지 않으며, 다시 만들어지면 같은 엔진을 그린다.
@MainActor
final class SwiftUIWrapperTests: XCTestCase {
    private var window: UIWindow!
    private var host: UIHostingController<AnyView>!

    override func setUp() async throws {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 500))
        host = UIHostingController(rootView: AnyView(EmptyView()))
        window.rootViewController = host
        window.makeKeyAndVisible()
    }

    override func tearDown() async throws {
        window.isHidden = true
        window = nil
        host = nil
    }

    private func show(_ view: some View) {
        host.rootView = AnyView(view.frame(width: 390, height: 300))
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        // 테스트 호스트 앱은 활성 상태가 아니어서 창에 붙은 차트가 일시정지된다. 실제 앱의 활성화 알림을 재현한다.
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// 계층에서 래퍼 컨테이너를 찾는다
    private func container(in view: UIView? = nil) -> BaroChartContainerView? {
        let root = view ?? host.view!
        if let found = root as? BaroChartContainerView { return found }
        for child in root.subviews { if let found = container(in: child) { return found } }
        return nil
    }

    /// 차트 뷰를 실제로 그리게 해 renderedRevision·onError를 갱신한다
    private func render(_ chart: BaroChartUIView) {
        chart.setNeedsDisplay()
        chart.layer.displayIfNeeded()
    }

    /// 실패 시 원인을 가를 수 있도록 상태를 문자열로 남긴다
    private func diagnostics(_ chart: BaroChartUIView) -> String {
        "bounds=\(chart.bounds) window=\(chart.window != nil) appState=\(UIApplication.shared.applicationState.rawValue) disposed=\(chart.isDisposed) revision=\(chart.renderedRevision) lastError=\(chart.lastError ?? "nil")"
    }

    private func engine() throws -> BaroChartEngine {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars((0..<30).map { BaroChartBar(time: 1_700_000_000_000 + Double($0) * 60_000, open: 100, high: 102, low: 99, close: 101, volume: 10) })
        return engine
    }

    func testDismantleDisposesViewNotEngine() throws {
        let engine = try engine()
        defer { try? engine.close() }
        show(BaroChartView(engine: engine))
        let chart = try XCTUnwrap(container()?.chartView)
        show(EmptyView())
        XCTAssertTrue(chart.isDisposed)
        XCTAssertFalse(engine.isClosed)
    }

    func testRecreatedWrapperRendersSameEngine() throws {
        let engine = try engine()
        defer { try? engine.close() }
        show(BaroChartView(engine: engine))
        show(EmptyView())
        show(BaroChartView(engine: engine))
        let chart = try XCTUnwrap(container()?.chartView)
        XCTAssertFalse(chart.isDisposed)
        render(chart)
        XCTAssertGreaterThan(chart.renderedRevision, 0, diagnostics(chart))
        XCTAssertNil(chart.lastError)
    }

    func testEngineChangeReplacesChartView() throws {
        let first = try engine(), second = try engine()
        defer { try? first.close(); try? second.close() }
        show(BaroChartView(engine: first))
        let old = try XCTUnwrap(container()?.chartView)
        show(BaroChartView(engine: second))
        let replaced = try XCTUnwrap(container()?.chartView)
        XCTAssertTrue(old.isDisposed)
        XCTAssertTrue(replaced.engine === second)
    }

    func testOnErrorDelivered() throws {
        let engine = try engine()
        var codes: [BaroChartError.Code] = []
        show(BaroChartView(engine: engine, onError: { codes.append($0.code) }))
        let chart = try XCTUnwrap(container()?.chartView)
        try engine.close()
        render(chart)
        XCTAssertEqual(codes.first, .engineClosed, diagnostics(chart))
    }

    /// configure는 새 차트 뷰마다 한 번 불리고(엔진 교체 포함) SwiftUI 갱신만으로는 다시 불리지 않는다
    func testConfigureRunsOncePerCreatedChartView() throws {
        let first = try engine(), second = try engine()
        defer { try? first.close(); try? second.close() }
        var configured: [ObjectIdentifier] = []
        let configure: (BaroChartUIView) -> Void = { view in
            view.adjustsFontForContentSizeCategory = true
            configured.append(ObjectIdentifier(view))
        }
        show(BaroChartView(engine: first, configure: configure))
        let chart = try XCTUnwrap(container()?.chartView)
        XCTAssertTrue(chart.adjustsFontForContentSizeCategory)
        show(BaroChartView(engine: first, onInteraction: {}, configure: configure))
        XCTAssertEqual(configured, [ObjectIdentifier(chart)])
        show(BaroChartView(engine: second, configure: configure))
        let replaced = try XCTUnwrap(container()?.chartView)
        XCTAssertEqual(configured, [ObjectIdentifier(chart), ObjectIdentifier(replaced)])
        XCTAssertTrue(replaced.adjustsFontForContentSizeCategory)
    }
}
#endif
