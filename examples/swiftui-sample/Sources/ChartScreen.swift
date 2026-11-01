import BaroChart
import SwiftUI

/// 샘플 화면: 상단 동작 버튼, 상태 문구, 오류 배너, 차트
struct ChartScreen: View {
    @State private var model = ChartModel()
    /// 실기기 성능 측정 결과(-barochart-benchmark로 실행했을 때만)
    @State private var benchmark: String?

    var body: some View {
        VStack(spacing: 8) {
            controls
            Text(model.status).font(.footnote.monospaced()).accessibilityIdentifier("sample-status")
            if let benchmark {
                Text(benchmark).font(.caption2.monospaced()).lineLimit(1).accessibilityIdentifier("sample-benchmark")
            }
            if let message = model.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.white).padding(8).frame(maxWidth: .infinity)
                    .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier("sample-error")
            }
            BaroChartView(engine: model.engine, onError: { model.report($0) })
                .accessibilityIdentifier("sample-chart")
        }
        .padding(12)
        .background(model.isDark ? Color(red: 0.05, green: 0.07, blue: 0.13) : Color(white: 0.97))
        // 시스템 글자·버튼 색이 배경과 대비되도록 화면 색 구성을 차트 테마에 맞춘다(접근성 감사)
        .preferredColorScheme(model.isDark ? .dark : .light)
        .task {
            guard DeviceBenchmark.isRequested else { return }
            model.isStreaming = false
            benchmark = DeviceBenchmark.run()
        }
    }

    private var controls: some View {
        // 좁은 화면·큰 글씨에서도 버튼 글자가 잘리지 않도록 가로 스크롤한다
        ScrollView(.horizontal, showsIndicators: false) { buttons }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button("Line") { model.addHorizontalLine() }.accessibilityIdentifier("sample-line")
            Button("Save") { model.save() }.accessibilityIdentifier("sample-save")
            Button("Restore") { Task { await model.restore() } }.accessibilityIdentifier("sample-restore")
            Button(model.isDark ? "Light" : "Dark") { model.toggleTheme() }.accessibilityIdentifier("sample-theme")
            // 버튼형 Toggle은 꺼진 상태에서 채움 없이 색 글자만 남아 대비 기준(감사)에 못 미치므로, 항상 채워진 버튼으로 상태를 바꾼다
            Button(model.isStreaming ? "Pause" : "Live") { model.isStreaming.toggle() }
                .accessibilityValue(model.isStreaming ? "Streaming" : "Paused")
                .accessibilityIdentifier("sample-stream")
        }
        .buttonStyle(.borderedProminent)
        .tint(Color(red: 0.0, green: 0.32, blue: 0.70))
    }
}
