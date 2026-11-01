#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// SwiftUI chart view. The app owns the engine and passes it in; the view never closes it.
///
/// When SwiftUI removes this view, only the underlying ``BaroChartUIView`` is disposed, so the same
/// engine can be shown again later. Passing a different engine replaces the chart view in place.
/// Create the engine on the main thread, for example in an `@Observable` or `ObservableObject` model.
///
/// ```swift
/// BaroChartView(engine: model.engine, onError: { model.lastError = $0 })
///     .frame(height: 320)
/// ```
@MainActor
public struct BaroChartView: UIViewRepresentable {
    /// The engine to show. The app owns it; the view never closes it.
    public let engine: BaroChartEngine
    /// Called after touch or accessibility input changes the chart.
    public var onInteraction: (() -> Void)?
    /// Called for failures that cannot be thrown, such as drawing a closed engine.
    public var onError: ((BaroChartError) -> Void)?

    /// - Parameters:
    ///   - engine: An engine owned by the app on the main thread.
    ///   - onInteraction: Called after touch or accessibility input changes the chart.
    ///   - onError: Called for failures that cannot be thrown, such as drawing a closed engine.
    public init(engine: BaroChartEngine, onInteraction: (() -> Void)? = nil, onError: ((BaroChartError) -> Void)? = nil) {
        self.engine = engine
        self.onInteraction = onInteraction
        self.onError = onError
    }

    /// Creates the underlying ``BaroChartContainerView`` for `engine`.
    public func makeUIView(context: Context) -> BaroChartContainerView {
        let container = BaroChartContainerView(engine: engine)
        container.chartView.onInteraction = onInteraction
        container.chartView.onError = onError
        return container
    }

    /// Applies the current callbacks and replaces the chart view if `engine` changed.
    public func updateUIView(_ container: BaroChartContainerView, context: Context) {
        if container.chartView.engine !== engine { container.replaceEngine(engine) }
        container.chartView.onInteraction = onInteraction
        container.chartView.onError = onError
    }

    /// Disposes the underlying chart view. The engine stays open and can be shown again.
    public static func dismantleUIView(_ container: BaroChartContainerView, coordinator: ()) {
        container.chartView.dispose()
    }
}

/// UIKit container used by ``BaroChartView``. It holds exactly one ``BaroChartUIView`` sized to its bounds.
@MainActor
public final class BaroChartContainerView: UIView {
    /// The chart view currently shown. It is replaced when the engine changes.
    public private(set) var chartView: BaroChartUIView

    init(engine: BaroChartEngine) {
        chartView = BaroChartUIView(engine: engine)
        super.init(frame: .zero)
        install(chartView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// 엔진이 바뀌면 이전 차트 뷰를 정리하고 새 엔진의 차트 뷰로 교체한다(콜백은 호출자가 다시 설정)
    func replaceEngine(_ engine: BaroChartEngine) {
        let previous = chartView
        chartView = BaroChartUIView(engine: engine)
        previous.dispose()
        previous.removeFromSuperview()
        install(chartView)
    }

    /// 차트 뷰를 컨테이너 크기에 맞춰 붙인다
    private func install(_ view: BaroChartUIView) {
        view.frame = bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(view)
    }
}
#endif
