import BaroChart
import SwiftUI

/// 샘플 화면: 상단 동작 버튼, 상태 문구, 오류 배너, 차트
struct ChartScreen: View {
    @State private var model = ChartModel()

    var body: some View {
        VStack(spacing: 8) {
            controls
            Text(model.status).font(.footnote.monospaced()).accessibilityIdentifier("sample-status")
            if let message = model.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.white).padding(8).frame(maxWidth: .infinity)
                    .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier("sample-error")
            }
            BaroChartView(engine: model.engine, onError: { model.report($0) })
                .accessibilityIdentifier("sample-chart")
        }
        .padding(12)
        .background(model.isDark ? Color(red: 0.05, green: 0.07, blue: 0.13) : Color(white: 0.97))
    }

    private var controls: some View {
        HStack(spacing: 8) {
            Button("Line") { model.addHorizontalLine() }.accessibilityIdentifier("sample-line")
            Button("Save") { model.save() }.accessibilityIdentifier("sample-save")
            Button("Restore") { Task { await model.restore() } }.accessibilityIdentifier("sample-restore")
            Button(model.isDark ? "Light" : "Dark") { model.toggleTheme() }.accessibilityIdentifier("sample-theme")
            Toggle("Live", isOn: $model.isStreaming).toggleStyle(.button).accessibilityIdentifier("sample-stream")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
}
