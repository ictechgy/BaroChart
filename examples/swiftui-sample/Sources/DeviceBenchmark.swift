@_spi(BaroChartValidation) import BaroChart
import Darwin
import Foundation
import UIKit

/// 실기기 성능 측정(G6). `-barochart-benchmark` 인자로 앱을 띄우면 실행되고, 결과 JSON을 반환한다.
///
/// 화면 표시 FPS가 아니라 기기 CPU에서의 렌더 시간이다: 오프스크린 BaroChartUIView에 레이어를 그리는 데 걸린 시간을 잰다.
@MainActor
enum DeviceBenchmark {
    static var isRequested: Bool { ProcessInfo.processInfo.arguments.contains("-barochart-benchmark") }
    private static var backend: String {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "-barochart-backend").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "javascript"
    }
    private static var runId: String {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "-barochart-run-id").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "missing-run-id"
    }

    /// 측정 전체를 실행해 JSON 문자열로 돌려준다
    static func run() -> String {
        var result: [String: Any] = ["backend": backend, "runId": runId, "percentileMethod": "nearest-rank", "fixtureId": "seeded-sine-bars-10k-ema20-v1", "physicalDevice": ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == nil, "device": deviceModel(), "os": UIDevice.current.systemVersion, "scale": UIScreen.main.scale,
                                     "method": "offscreen BaroChartUIView layer render on the device CPU; not display FPS"]
        do {
            result["startup"] = try startup()
            let panResult = try pan(bars: 10_000)
            result["pan10k"] = panResult
            result["actualBackend"] = panResult["actualBackend"]
            result["backendVerified"] = (panResult["actualBackend"] as? String) == backend
        } catch {
            result["error"] = String(describing: error)
        }
        do {
            return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)
        } catch {
            return "{\"error\":\"benchmark report encoding failed: \(error)\"}"
        }
    }

    /// 엔진 생성 → 1만 봉 설정 → 첫 프레임 렌더까지(10회, 앞 2회 워밍업 제외)
    private static func startup() throws -> [String: Double] {
        var samples: [Double] = []
        let data = bars(10_000)
        for run in 0..<12 {
            let start = DispatchTime.now().uptimeNanoseconds
            let engine = try BaroChartValidation.makeEngine(options: BaroChartEngineOptions(), backend: backend)
            guard try BaroChartValidation.actualBackend(for: engine) == backend else { throw NSError(domain: "BaroChartValidation", code: 2) }
            try engine.setBars(data)
            let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 390, height: 320))
            view.contentScaleFactor = UIScreen.main.scale
            view.setNeedsDisplay(); view.layer.displayIfNeeded()
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
            if run >= 2 { samples.append(elapsed) }
            view.dispose(); try engine.close()
        }
        return summary(samples)
    }

    /// 1만 봉에서 보이는 범위를 120번 옮기며 프레임마다 렌더 시간을 잰다
    private static func pan(bars count: Int) throws -> [String: Any] {
        let engine = try BaroChartValidation.makeEngine(options: BaroChartEngineOptions(), backend: backend)
        let actualBackend = try BaroChartValidation.actualBackend(for: engine)
        guard actualBackend == backend else { throw NSError(domain: "BaroChartValidation", code: 2) }
        defer { do { try engine.close() } catch { print("Benchmark engine close failed: \(error)") } }
        try engine.setBars(bars(count))
        try engine.addIndicator(.ema(period: 20), id: "ema")
        try engine.addSeries(BaroChartSeries(id: "ema-line", type: .line, indicator: "ema"))
        let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 390, height: 320))
        view.contentScaleFactor = UIScreen.main.scale
        try engine.setVisibleRange(BaroChartVisibleRange(from: Double(count - 200), to: Double(count)))
        view.setNeedsDisplay(); view.layer.displayIfNeeded()
        var samples: [Double] = []
        for warmup in 0..<2 {
            let from = Double(count - 206 - warmup * 3)
            try engine.setVisibleRange(BaroChartVisibleRange(from: from, to: from + 200))
            view.setNeedsDisplay(); view.layer.displayIfNeeded()
        }
        for frame in 0..<120 {
            let start = DispatchTime.now().uptimeNanoseconds
            let from = Double(count - 200 - frame * 3)
            try engine.setVisibleRange(BaroChartVisibleRange(from: from, to: from + 200))
            view.setNeedsDisplay(); view.layer.displayIfNeeded()
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
        }
        var out: [String: Any] = summary(samples)
        out["actualBackend"] = actualBackend
        out["footprintMB"] = footprintMB()
        out["runtimeAllocationBytes"] = NSNull()
        out["runtimeAllocationNote"] = "Swift FFI does not expose requested Rust runtime bytes; phys_footprint is reported separately."
        view.dispose()
        return out
    }

    private static func summary(_ values: [Double]) -> [String: Double] {
        let sorted = values.sorted()
        return ["p50Ms": sorted[min(sorted.count - 1, Int(ceil(Double(sorted.count) * 0.50)) - 1)], "p95Ms": sorted[min(sorted.count - 1, Int(ceil(Double(sorted.count) * 0.95)) - 1)], "maxMs": sorted.last ?? 0, "runs": Double(sorted.count)]
    }

    private static func bars(_ count: Int) -> [BaroChartBar] {
        (0..<count).map { i in
            let close = 100 + sin(Double(i) / 9) * 3
            return BaroChartBar(time: 1_700_000_000_000 + Double(i) * 60_000, open: close - 0.4, high: close + 0.8, low: close - 0.9, close: close, volume: 500 + Double(i % 13) * 20)
        }
    }

    private static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return status == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }

    private static func deviceModel() -> String {
        var system = utsname(); uname(&system)
        return withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}
