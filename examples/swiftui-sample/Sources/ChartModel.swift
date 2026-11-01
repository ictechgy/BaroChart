import BaroChart
import Foundation
import Observation

/// 차트 엔진을 소유하고 샘플 동작(스트리밍·드로잉·저장/복원·테마)을 담당하는 모델.
///
/// 엔진은 메인 스레드에서 만들고 메인 스레드에서만 호출한다. SwiftUI 뷰는 엔진을 빌려 그리기만 한다.
@MainActor
@Observable
final class ChartModel {
    /// SwiftUI BaroChartView에 넘기는 엔진(앱이 소유)
    let engine: BaroChartEngine
    /// 화면 상단 상태 문구(UI 테스트가 읽는다)
    private(set) var status = "Ready"
    /// 마지막 오류. nil이 아니면 배너로 보여 준다
    private(set) var errorMessage: String?
    /// 1초 스트리밍 진행 여부
    var isStreaming = true { didSet { isStreaming ? startStreaming() : stopStreaming() } }
    private(set) var isDark = true

    private var bars: [BaroChartBar]
    private var savedWorkspace: String?
    private var streamTask: Task<Void, Never>?
    private var tick = 0
    private static let binding = BaroChartDatasetBinding(key: "SAMPLE:SYNTH", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)

    init() {
        bars = Self.syntheticBars(count: 240)
        do {
            engine = try BaroChartEngine(options: Self.layout())
            try engine.setBars(bars)
            try configureStudies()
            try engine.fit()
        } catch {
            // 엔진 구성이 실패하면 샘플을 쓸 수 없으므로 원인을 담아 즉시 알린다(개발자용)
            fatalError("BaroChart sample setup failed: \(error)")
        }
        startStreaming()
    }

    /// 가격(캔들+EMA) · 거래량 · RSI 세 패널 구성
    private static func layout() -> BaroChartEngineOptions {
        BaroChartEngineOptions(
            panels: [BaroChartPanel(id: "price", weight: 3), BaroChartPanel(id: "volume", weight: 1), BaroChartPanel(id: "rsi", weight: 1)],
            series: [BaroChartSeries(id: "price", type: .candles),
                     BaroChartSeries(id: "volume", type: .histogram, panel: "volume", source: .volume, color: "#397e8c")])
    }

    private func configureStudies() throws {
        try engine.addIndicator(.ema(period: 20), id: "ema20")
        try engine.addSeries(BaroChartSeries(id: "ema20-line", type: .line, indicator: "ema20", color: "#f0b755"))
        try engine.addIndicator(.rsi(period: 14), id: "rsi14")
        try engine.addSeries(BaroChartSeries(id: "rsi14-line", type: .line, panel: "rsi", indicator: "rsi14", color: "#a78bfa"))
    }

    /// 마지막 봉 근처에 수평선을 긋는다
    func addHorizontalLine() {
        guard let last = bars.last else { return }
        perform("Line added") {
            _ = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [BaroChartPoint(time: last.time, price: last.close)], text: "Level"))
        }
    }

    /// 현재 차트 설정·지표·드로잉을 작업공간 문서로 저장한다
    func save() {
        perform("Saved") { savedWorkspace = try engine.saveWorkspace(binding: Self.binding) }
    }

    /// 저장한 작업공간을 복원한다. 저장 뒤 봉이 추가됐다면 코어가 거부하고 오류 배너가 뜬다.
    func restore() async {
        guard let document = savedWorkspace else { errorMessage = "Save a workspace first."; return }
        do {
            try await engine.restoreWorkspace(document, binding: Self.binding)
            status = "Restored"; errorMessage = nil
        } catch let error as BaroChartError {
            errorMessage = "\(error.message) \(error.recovery)"
        } catch {
            errorMessage = String(describing: error)
        }
    }

    /// 다크/라이트 테마를 바꾼다
    func toggleTheme() {
        isDark.toggle()
        perform(isDark ? "Dark" : "Light") { try engine.setTheme(isDark ? .dark : .light) }
    }

    /// SwiftUI 래퍼가 전달한 그리기 오류를 배너로 보여 준다
    func report(_ error: BaroChartError) { errorMessage = "\(error.message) \(error.recovery)" }

    /// 엔진 호출을 실행하고 성공 문구 또는 오류 배너를 갱신한다
    private func perform(_ success: String, _ body: () throws -> Void) {
        do { try body(); status = success; errorMessage = nil } catch let error as BaroChartError {
            errorMessage = "\(error.message) \(error.recovery)"
        } catch {
            errorMessage = String(describing: error)
        }
    }

    private func startStreaming() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                self?.streamTick()
            }
        }
    }

    private func stopStreaming() { streamTask?.cancel(); streamTask = nil }

    /// 1초마다 현재 봉을 갱신하고 15번째마다 새 봉을 추가한다(합성 데이터)
    private func streamTick() {
        tick += 1
        guard let last = bars.last else { return }
        let drift = sin(Double(tick) / 3) * 0.4
        if tick % 15 == 0 {
            let next = BaroChartBar(time: last.time + 60_000, open: last.close, high: last.close + 0.6, low: last.close - 0.6, close: last.close + drift, volume: 900)
            perform(status) { try engine.apply(.append(next)) }
            if errorMessage == nil { bars.append(next) }
        } else {
            let close = last.close + drift
            let updated = BaroChartBar(time: last.time, open: last.open, high: max(last.high, close), low: min(last.low, close), close: close, volume: last.volume + 10)
            perform(status) { try engine.apply(.update(updated)) }
            if errorMessage == nil { bars[bars.count - 1] = updated }
        }
    }

    /// 결정적 합성 1분봉(실제 시세 아님)
    private static func syntheticBars(count: Int) -> [BaroChartBar] {
        var close = 100.0
        return (0..<count).map { i in
            let open = close
            close = open + sin(Double(i) / 7) * 0.8 + cos(Double(i) / 3) * 0.3
            return BaroChartBar(time: 1_700_000_000_000 + Double(i) * 60_000, open: open, high: max(open, close) + 0.5, low: min(open, close) - 0.5, close: close, volume: 500 + Double(i % 17) * 40)
        }
    }
}
