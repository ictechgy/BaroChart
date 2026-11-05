import Foundation

/// Typed BaroChart API. Every method throws only `BaroChartError` and must be called on the
/// engine's owner thread (the thread that created it; main for engines attached to a view).
/// Calls from another thread throw `.wrongThread` instead of crashing. Each method converts its
/// value types to the low-level dictionary API, so behavior is shared with that API.
extension BaroChartEngine {
    /// Creates an engine with an explicit backend and initial layout. Call on the owner thread.
    public convenience init(options: BaroChartEngineOptions, backend: BaroChartBackend) throws {
        do { try self.init(options: options.lowLevel, runtimeBackend: backend) } catch { throw BaroChartError.wrap(error) }
    }

    /// Creates an engine with an explicit initial layout and no bars. Call on the owner thread.
    ///
    /// Prefer this over the low-level `init()`, which builds a labeled demonstration chart.
    public convenience init(options: BaroChartEngineOptions) throws {
        do { try self.init(count: 0, options: options.lowLevel) } catch { throw BaroChartError.wrap(error) }
    }

    /// Replaces every bar of the primary series.
    public func setBars(_ bars: [BaroChartBar]) throws {
        try BaroChartError.mapping { try setData(bars) }
    }

    /// Applies a streaming or correction event. Invalid events throw `.invalidArgument` and leave data unchanged.
    public func apply(_ event: BaroChartDataEvent) throws {
        try BaroChartError.mapping { try applyDataEvent(event.lowLevel) }
    }

    /// Adds a series.
    public func addSeries(_ series: BaroChartSeries) throws {
        try BaroChartError.mapping { try addSeries(series.lowLevel) }
    }

    /// Changes only the fields set in `patch` on the series `id`. The series type cannot change; `nil` fields keep their value.
    public func updateSeries(id: String, _ patch: BaroChartSeriesPatch) throws {
        try BaroChartError.mapping { try setSeries(id, patch.lowLevel) }
    }

    /// Adds an indicator under `id`. Bind it to a line/area/histogram series with `BaroChartSeries(indicator:)`.
    public func addIndicator(_ indicator: BaroChartIndicator, id: String) throws {
        try BaroChartError.mapping { _ = try addIndicator(id, indicator.kind.rawValue, indicator.lowLevelParams) }
    }

    /// Replaces indicator parameters synchronously.
    public func setIndicatorParams(id: String, _ params: [String: BaroChartParamValue]) throws {
        try BaroChartError.mapping { _ = try setIndicatorParams(id, params.mapValues(\.lowLevel)) }
    }

    /// Reads one indicator output at a bar index. `output` defaults to the indicator's first output.
    public func indicatorValue(id: String, output: String? = nil, index: Int) throws -> BaroChartIndicatorValue {
        try BaroChartError.mapping {
            let raw = try indicatorValueAt(id, output: output, index: index)
            return BaroChartIndicatorValue(value: raw["value"] as? Double, sourceIndex: raw["sourceIndex"] as? Int, sourceTime: raw["sourceTime"] as? Double)
        }
    }

    /// Selects the active drawing tool for touch input.
    public func setTool(_ tool: BaroChartDrawingTool) throws {
        try BaroChartError.mapping { try setTool(tool.rawValue) }
    }

    /// Adds a drawing and returns its id. `.select` is not a drawing and throws `.invalidArgument`.
    @discardableResult public func addDrawing(_ drawing: BaroChartDrawing) throws -> String {
        try BaroChartError.mapping {
            try Self.requireDrawable(drawing.tool)
            return try addDrawing(drawing.lowLevel)
        }
    }

    /// Changes only the fields set in `patch` on the drawing `id`. The tool cannot change; `nil` fields keep their value.
    public func updateDrawing(id: String, _ patch: BaroChartDrawingPatch) throws {
        try BaroChartError.mapping { try editDrawing(id, patch.lowLevel) }
    }

    /// Deletes drawings as one undo step and returns how many were removed. Missing or locked ids throw.
    @discardableResult public func deleteDrawings(ids: [String]) throws -> Int {
        try BaroChartError.mapping {
            let receipt = try deleteDrawings(ids)
            guard let changed = receipt["changed"] as? Int else {
                throw BaroChartError(code: .javaScript, message: "Delete receipt has no changed count.")
            }
            return changed
        }
    }

    /// Applies a complete theme.
    public func setTheme(_ theme: BaroChartTheme) throws {
        try BaroChartError.mapping { try setTheme(theme.lowLevel) }
    }

    /// Sets instrument metadata used for price and time formatting.
    public func setSymbol(_ symbol: BaroChartSymbol) throws {
        try BaroChartError.mapping { try setSymbol(symbol.lowLevel) }
    }

    /// Current visible range in bar-index coordinates.
    public func visibleRange() throws -> BaroChartVisibleRange {
        try BaroChartError.mapping {
            let view = try command("inspect").toDictionary()["view"] as? [String: Any]
            guard let from = view?["from"] as? Double, let to = view?["to"] as? Double else {
                throw BaroChartError(code: .javaScript, message: "Chart state has no visible range.")
            }
            return BaroChartVisibleRange(from: from, to: to)
        }
    }

    /// Sets the visible range in bar-index coordinates. `to` must be greater than `from`.
    public func setVisibleRange(_ range: BaroChartVisibleRange) throws {
        try BaroChartError.mapping { try command("setVisibleRange", [range.from, range.to]) }
    }

    /// Saves chart settings, indicators, series and drawings as a portable `aster.workspace` document.
    public func saveWorkspace(binding: BaroChartDatasetBinding) throws -> String {
        try BaroChartError.mapping { try saveWorkspace(binding.lowLevel) }
    }

    /// Restores a saved workspace onto this engine's current bars without blocking the main thread.
    ///
    /// The engine must be main-thread owned and hold the same bars the document was saved with.
    /// Cancelling the task cancels the restore and throws `.cancelled`; the engine stays usable.
    @MainActor
    public func restoreWorkspace(_ document: String, binding: BaroChartDatasetBinding) async throws {
        if Task.isCancelled { throw BaroChartError.wrap(CancellationError()) }
        let holder = BaroChartWorkspaceJobHolder()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                startRestore(document, binding: binding, holder: holder, continuation: continuation)
            }
        } onCancel: {
            holder.cancel()
        }
    }

    /// Values under the crosshair for a view of the given size, or `nil` when there is no crosshair.
    public func crosshair(width: Double, height: Double) throws -> BaroChartCrosshairValues? {
        try BaroChartError.mapping {
            guard let raw = try crosshairValues(width: width, height: height) else { return nil }
            return BaroChartCrosshairValues(lowLevel: raw)
        }
    }

    /// Whether `close()` has completed. A closed engine rejects every call with `.engineClosed`.
    public var isClosed: Bool { closedState }

    // MARK: - 내부 보조

    /// select 도구는 드로잉을 만들 수 없다
    private static func requireDrawable(_ tool: BaroChartDrawingTool) throws {
        guard tool != .select else {
            throw BaroChartError(code: .invalidArgument, message: "The select tool cannot create a drawing.",
                                 recovery: "Use a drawing tool such as .trendline or .horizontal.")
        }
    }

    /// 저수준 비동기 복원을 시작하고 결과를 continuation으로 한 번 전달한다
    private func startRestore(_ document: String, binding: BaroChartDatasetBinding, holder: BaroChartWorkspaceJobHolder,
                              continuation: CheckedContinuation<Void, Error>) {
        do {
            let job = try restoreWorkspaceAsync(document, datasetBinding: binding.lowLevel) { result in
                switch result {
                case .success: continuation.resume()
                case .failure(let error): continuation.resume(throwing: BaroChartError.wrap(error))
                }
            }
            holder.attach(job)
        } catch {
            continuation.resume(throwing: BaroChartError.wrap(error))
        }
    }
}

/// 취소 핸들러(임의 스레드)와 복원 시작(메인)이 작업 참조를 안전하게 공유하기 위한 상자
final class BaroChartWorkspaceJobHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var job: BaroChartWorkspaceJob?
    private var cancelled = false

    /// 시작된 작업을 붙이고, 이미 취소 요청이 왔다면 바로 취소한다
    func attach(_ job: BaroChartWorkspaceJob) {
        lock.lock(); self.job = job; let shouldCancel = cancelled; lock.unlock()
        if shouldCancel { job.cancel() }
    }

    /// 작업이 있으면 취소하고, 아직 없으면 붙는 즉시 취소되게 표시한다
    func cancel() {
        lock.lock(); cancelled = true; let current = job; lock.unlock()
        current?.cancel()
    }
}

extension BaroChartCrosshairValues {
    /// 코어 crosshairValues 결과(index, time, primary.bar, series[])에서 만든다
    init(lowLevel raw: [String: Any]) {
        let primary = raw["primary"] as? [String: Any]
        let bar = (primary?["bar"] as? [String: Any]).flatMap(Self.bar(_:))
        let series = (raw["series"] as? [[String: Any]] ?? []).map {
            SeriesValue(id: $0["id"] as? String ?? "", label: $0["label"] as? String ?? "", panel: $0["panel"] as? String ?? "", value: $0["value"] as? Double)
        }
        self.init(index: raw["index"] as? Int ?? 0, time: raw["time"] as? Double ?? 0, bar: bar, series: series)
    }

    private static func bar(_ raw: [String: Any]) -> BaroChartBar? {
        guard let time = raw["time"] as? Double, let open = raw["open"] as? Double, let high = raw["high"] as? Double,
              let low = raw["low"] as? Double, let close = raw["close"] as? Double, let volume = raw["volume"] as? Double else { return nil }
        return BaroChartBar(time: time, open: open, high: high, low: low, close: close, volume: volume)
    }
}
