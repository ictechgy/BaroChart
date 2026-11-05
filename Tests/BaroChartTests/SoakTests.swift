#if canImport(UIKit)
import Darwin
import UIKit
import XCTest
@_spi(BaroChartValidation) @testable import BaroChart

/// 장시간 안정성(G5): 스트리밍 중 메모리가 평탄하고, 엔진·뷰 생성/해제를 반복해도 누수가 없어야 한다.
///
/// 기본 실행은 짧게(약 12초) 돈다. 30분 soak는 `TEST_RUNNER_BAROCHART_SOAK_MINUTES=30`으로 xcodebuild를 실행한다
/// (scripts/run-native-soak.mjs). 판정 기준은 soak 모드(15분 이상)에서만 적용하고, 짧은 실행은 동작만 확인한다.
@MainActor
final class SoakTests: XCTestCase {
    private var soakMinutes: Double { Double(ProcessInfo.processInfo.environment["TEST_RUNNER_BAROCHART_SOAK_MINUTES"] ?? ProcessInfo.processInfo.environment["BAROCHART_SOAK_MINUTES"] ?? "") ?? 0.2 }
    private var backend: String { ProcessInfo.processInfo.environment["TEST_RUNNER_BAROCHART_BACKEND"] ?? "javascript" }
    private var runId: String { ProcessInfo.processInfo.environment["TEST_RUNNER_BAROCHART_RUN_ID"] ?? "missing-run-id" }

    private func makeEngine() throws -> BaroChartEngine {
        let engine = try BaroChartValidation.makeEngine(options: BaroChartEngineOptions(), backend: backend)
        let actualBackend = try BaroChartValidation.actualBackend(for: engine)
        guard actualBackend == backend else { throw NSError(domain: "BaroChartValidation", code: 2) }
        return engine
    }

    /// 현재 프로세스의 물리 메모리 사용량(phys_footprint, 바이트)
    private func footprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) : 0
    }

    private func bars(_ count: Int, start: Double = 1_700_000_000_000) -> [BaroChartBar] {
        (0..<count).map { i in
            let close = 100 + sin(Double(i) / 9) * 3
            return BaroChartBar(time: start + Double(i) * 60_000, open: close - 0.4, high: close + 0.8, low: close - 0.9, close: close, volume: 500 + Double(i % 13) * 20)
        }
    }

    /// 보고서를 임시 폴더에 쓰고 경로를 출력한다(runner가 읽는다)
    private func writeReport(_ name: String, _ report: [String: Any]) throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("barochart-\(name).json")
        var report = report
        report["runId"] = runId; report["backend"] = backend
        report["runtimeAllocationBytes"] = NSNull()
        report["runtimeAllocationNote"] = "Swift FFI does not expose requested Rust runtime bytes; process phys_footprint remains a separate metric."
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted]).write(to: url)
        print("BAROCHART_SOAK_REPORT \(name) \(url.path) \(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)")
    }

    func testStreamingSoak() async throws {
        let engine = try makeEngine()
        defer { try? engine.close() }
        var data = bars(10_000)
        try engine.setBars(data)
        try engine.addIndicator(.ema(period: 20), id: "ema")
        try engine.addSeries(BaroChartSeries(id: "ema-line", type: .line, indicator: "ema"))
        let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 390, height: 320))
        let deadline = Date().addingTimeInterval(soakMinutes * 60)
        let sampleEvery = soakMinutes >= 15 ? 60.0 : 2.0
        var samples: [[String: Double]] = [], nextSample = Date(), ticks = 0, crashes = 0
        let started = Date()
        while Date() < deadline {
            ticks += 1
            guard let previous = data.last else { break }
            // 앱의 메인 런루프처럼 틱마다 autorelease 풀을 비우고 CoreAnimation 트랜잭션을 커밋한다.
            // SwiftPM 테스트 호스트는 UIKit 앱의 런루프 풀 비움을 보장하지 않아, 그대로 두면 테스트 환경의 지연 해제가 증가로 보인다.
            autoreleasepool {
                var last = previous
                do {
                    if ticks % 10 == 0 {
                        last = BaroChartBar(time: last.time + 60_000, open: last.close, high: last.close + 0.5, low: last.close - 0.5, close: last.close, volume: 600)
                        try engine.apply(.append(last)); data.append(last)
                    } else {
                        let close = last.close + sin(Double(ticks) / 7) * 0.2
                        last = BaroChartBar(time: last.time, open: last.open, high: max(last.high, close), low: min(last.low, close), close: close, volume: last.volume + 1)
                        try engine.apply(.update(last)); data[data.count - 1] = last
                    }
                    if ticks % 600 == 0 { _ = try engine.compactData(["keepLastBars": 10_000, "studyHistory": "restart"]); data = Array(data.suffix(10_000)) }
                } catch { crashes += 1; XCTFail("Streaming step failed: \(error)") }
                view.setNeedsDisplay(); view.layer.displayIfNeeded()
                CATransaction.flush()
            }
            if Date() >= nextSample { samples.append(["seconds": Date().timeIntervalSince(started), "footprint": footprint()]); nextSample = Date().addingTimeInterval(sampleEvery) }
            try await Task.sleep(for: .milliseconds(100))
        }
        view.dispose()
        let report = streamingVerdict(samples, ticks: ticks, failures: crashes)
        try writeReport("ios-streaming-soak", report)
        if soakMinutes >= 15 { XCTAssertEqual(report["passed"] as? Bool, true, "\(report)") }
        XCTAssertNil(view.lastError)
    }

    /// 워밍업 5분 뒤 10분 구간마다 증가율이 5% 이하인지 판정한다
    private func streamingVerdict(_ samples: [[String: Double]], ticks: Int, failures: Int) -> [String: Any] {
        let warm = samples.filter { ($0["seconds"] ?? 0) >= 300 }
        var windows: [[String: Double]] = []
        var start = 0
        while start < warm.count {
            let origin = warm[start]["seconds"] ?? 0
            guard let end = warm[start...].firstIndex(where: { ($0["seconds"] ?? 0) - origin >= 600 }) else { break }
            let growth = ((warm[end]["footprint"] ?? 0) - (warm[start]["footprint"] ?? 0)) / max(1, warm[start]["footprint"] ?? 1) * 100
            windows.append(["fromSeconds": origin, "toSeconds": warm[end]["seconds"] ?? 0, "growthPercent": growth])
            start = end
        }
        let passed = failures == 0 && !windows.isEmpty && windows.allSatisfy { ($0["growthPercent"] ?? 100) <= 5 }
        return ["minutes": soakMinutes, "ticks": ticks, "failures": failures, "samples": samples, "windows": windows, "passed": passed,
                "rule": "after 5 min warm-up, footprint growth <= 5% per 10-min window"]
    }

    /// 생성·해제 루프의 메모리 표본(회차, 바이트)
    struct LeakSample { let cycle: Double; let bytes: Double }

    /// 생성·해제 누수 판정. 끝점 두 개를 비교하지 않고 최소제곱 기울기로 회당 증가를 추정한다.
    /// 작은 footprint(약 24MB)에서는 할당자 잡음(±2MB)이 5% 기준(1.2MB)보다 커서 끝점 비교가 잡음을 판정하기 때문이다.
    /// 반환: 회당 기울기, 기준값(앞 3표본 평균), `cycles`회로 투영한 증가율(%), 통과 여부(투영 증가 5% 이하)
    static func leakVerdict(_ samples: [LeakSample], cycles: Double) -> [String: Any] {
        let count = Double(samples.count), meanCycle = samples.map(\.cycle).reduce(0, +) / count
        let meanBytes = samples.map(\.bytes).reduce(0, +) / count
        let covariance = samples.reduce(0.0) { $0 + ($1.cycle - meanCycle) * ($1.bytes - meanBytes) }
        let variance = samples.reduce(0.0) { $0 + ($1.cycle - meanCycle) * ($1.cycle - meanCycle) }
        let slope = variance > 0 ? covariance / variance : 0
        let baseline = samples.prefix(3).map(\.bytes).reduce(0, +) / Double(min(3, samples.count))
        let projected = slope * cycles / max(1, baseline) * 100
        return ["slopeBytesPerCycle": slope, "baselineFootprint": baseline, "projectedGrowthPercent": projected, "passed": projected <= 5,
                "rule": "least-squares footprint slope over samples every 25 cycles after warm-up, projected over the measured cycles, <= 5% of baseline"]
    }

    /// 판정 자체의 검증: ±2MB 잡음만 있는 평탄한 계열은 통과하고, 회당 8KB씩 느는 계열(450회에 약 15%)은 실패해야 한다
    func testLeakVerdictIgnoresNoiseButCatchesSlope() {
        let cycles: [Double] = (0..<19).map { Double(50 + $0 * 25) }
        let noisy: [LeakSample] = cycles.enumerated().map { index, cycle in
            let noise: Double = index % 2 == 0 ? 2e6 : -2e6
            return LeakSample(cycle: cycle, bytes: 24e6 + noise)
        }
        XCTAssertEqual(SoakTests.leakVerdict(noisy, cycles: 450)["passed"] as? Bool, true)
        let leaking: [LeakSample] = cycles.map { LeakSample(cycle: $0, bytes: 24e6 + ($0 - 50) * 8_000) }
        XCTAssertEqual(SoakTests.leakVerdict(leaking, cycles: 450)["passed"] as? Bool, false)
    }

    func testCreateDisposeCycles() throws {
        let cycles = soakMinutes >= 15 ? 500 : 40, warmup = soakMinutes >= 15 ? 50 : 10
        var samples: [LeakSample] = []
        for cycle in 0..<cycles {
            if cycle >= warmup && (cycle - warmup) % 25 == 0 { samples.append(LeakSample(cycle: Double(cycle), bytes: footprint())) }
            // 한 회를 앱의 런루프 한 턴처럼 다룬다: 풀을 비우고 CoreAnimation 트랜잭션을 커밋한다.
            // 커밋하지 않으면 해제된 뷰의 백킹 스토어가 미커밋 트랜잭션에 남는다. SDK가 자기 임시 JSValue를
            // 바깥 풀 없이도 비우는지는 EngineMemoryTests가 따로 확인한다.
            try autoreleasepool {
                let engine = try makeEngine()
                try engine.setBars(bars(200))
                let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 320, height: 240))
                view.setNeedsDisplay(); view.layer.displayIfNeeded()
                view.dispose()
                try engine.close()
                CATransaction.flush()
            }
        }
        samples.append(LeakSample(cycle: Double(cycles), bytes: footprint()))
        var report = SoakTests.leakVerdict(samples, cycles: Double(cycles - warmup))
        report["cycles"] = cycles; report["warmupCycles"] = warmup
        report["samples"] = samples.map { ["cycle": $0.cycle, "footprint": $0.bytes] }
        try writeReport("ios-create-dispose", report)
        if soakMinutes >= 15 { XCTAssertEqual(report["passed"] as? Bool, true, "\(report)") }
    }
}
#endif
