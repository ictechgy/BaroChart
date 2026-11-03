import BaroChart
import SwiftUI

/// 샘플 화면: 상단 동작 버튼, 상태 문구, 오류 배너, 차트
struct ChartScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = ChartModel()
    /// 실기기 성능 측정 결과(-barochart-benchmark로 실행했을 때만)
    @State private var benchmark: String?

    var body: some View {
        VStack(spacing: 8) {
            controls
            Text(model.status).font(.footnote.monospaced()).accessibilityIdentifier("sample-status")
            Text(model.streamSummary).font(.caption.monospaced()).accessibilityIdentifier("sample-stream-summary")
            if let benchmark {
                Text(benchmark).font(.caption2.monospaced()).lineLimit(1).accessibilityIdentifier("sample-benchmark")
            }
            if let message = model.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.white).padding(8).frame(maxWidth: .infinity)
                    .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier("sample-error")
            }
            BaroChartView(engine: model.engine, onError: { model.report($0) }, configure: { $0.adjustsFontForContentSizeCategory = true })
                .accessibilityIdentifier("sample-chart")
        }
        .padding(12)
        .background(model.isDark ? Color(red: 0.05, green: 0.07, blue: 0.13) : Color(white: 0.97))
        // 시스템 글자·버튼 색이 배경과 대비되도록 화면 색 구성을 차트 테마에 맞춘다(접근성 감사)
        .preferredColorScheme(model.isDark ? .dark : .light)
        .task(id: model.isStreaming && scenePhase == .active) {
            guard model.isStreaming, scenePhase == .active, !DeviceBenchmark.isRequested else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, model.isStreaming else { return }
                model.streamTick()
            }
        }
        .task {
            guard DeviceBenchmark.isRequested else { return }
            model.isStreaming = false
            benchmark = DeviceBenchmark.run()
        }
    }

    private var controls: some View {
        // 스트림 제어는 항상 보이게 두고 나머지 동작은 큰 글씨에서도 가로로 탐색한다.
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) { buttons }
            Button(model.isStreaming ? "Pause" : "Live") { model.isStreaming.toggle() }
                .accessibilityValue(model.isStreaming ? "Streaming" : "Paused")
                .accessibilityIdentifier("sample-stream")
        }
        .buttonStyle(.borderedProminent)
        .tint(Color(red: 0.0, green: 0.32, blue: 0.70))
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button("Line") { model.addHorizontalLine() }.accessibilityIdentifier("sample-line")
            Button("Save") { model.save() }.accessibilityIdentifier("sample-save")
            Button("Restore") { Task { await model.restore() } }.accessibilityIdentifier("sample-restore")
            Button(model.isDark ? "Light" : "Dark") { model.toggleTheme() }.accessibilityIdentifier("sample-theme")
        }
    }
}
