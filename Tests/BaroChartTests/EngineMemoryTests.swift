#if canImport(UIKit)
import BaroChart
import Darwin
import JavaScriptCore
import UIKit
import XCTest

/// 엔진 수명주기의 메모리 계약: 닫고 놓은 엔진의 JSContext는 호출자의 autorelease 풀이 비워지기 전에도 해제되어야 한다.
///
/// 테스트 메서드 안에는 풀 비움이 없으므로, JSC 임시 JSValue가 SDK 밖 풀에 남으면 컨텍스트가 살아남아 실패한다.
/// (백그라운드 소유 스레드나 한 런루프 턴 안에서 엔진을 반복 생성하는 앱에서 컨텍스트가 쌓이던 문제의 회귀 방지)
@MainActor
final class EngineMemoryTests: XCTestCase {
    private func bars(_ count: Int) -> [BaroChartBar] {
        (0..<count).map { i in BaroChartBar(time: 1_700_000_000_000 + Double(i) * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10) }
    }

    func testClosedEngineReleasesContextWithoutOuterAutoreleasePool() throws {
        weak var releasedContext: JSContext?
        do {
            let engine = try BaroChartEngine(options: BaroChartEngineOptions())
            try engine.setBars(bars(200))
            let view = BaroChartUIView(engine: engine, frame: CGRect(x: 0, y: 0, width: 320, height: 240))
            view.setNeedsDisplay(); view.layer.displayIfNeeded()
            view.dispose()
            try engine.close()
            releasedContext = engine.context
        }
        XCTAssertNil(releasedContext, "JSContext outlived its closed engine; autoreleased JSC values are escaping the SDK's pools")
    }

    /// 현재 프로세스의 물리 메모리(phys_footprint, 바이트)
    private nonisolated static func footprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) : 0
    }

    /// 백그라운드 스레드가 소유한 엔진을 바깥 autorelease 풀 없이 스트리밍해도 메모리가 쌓이지 않아야 한다.
    /// (soak는 앱 런루프처럼 틱마다 풀을 비우므로, SDK가 자기 호출의 임시 객체를 스스로 비우는지는 여기서 본다)
    func testBackgroundOwnerStreamingDoesNotAccumulateWithoutPool() throws {
        var samples: [(cycle: Double, bytes: Double)] = [], failure: (any Error)?
        let finished = DispatchSemaphore(value: 0)
        let bars = bars(1_000)
        Thread {
            do {
                let engine = try BaroChartEngine(options: BaroChartEngineOptions())
                try engine.setBars(bars)
                var last = bars[bars.count - 1]
                for tick in 1...60_000 {
                    let close = 100.5 + sin(Double(tick) / 7) * 0.2
                    last = BaroChartBar(time: last.time, open: last.open, high: max(last.high, close), low: min(last.low, close), close: close, volume: last.volume + 1)
                    try engine.apply(.update(last))
                    // 앞 12,000틱은 JSC 힙·GC 예열(진단: 120,000틱 실행에서 그 뒤로 평평)이라 표본에서 뺀다
                    if tick >= 12_000 && tick % 2_000 == 0 { samples.append((Double(tick), Self.footprint())) }
                }
                try engine.close()
            } catch { failure = error }
            finished.signal()
        }.start()
        finished.wait()
        XCTAssertNil(failure)
        let verdict = SoakTests.leakVerdict(samples.map { SoakTests.LeakSample(cycle: $0.cycle, bytes: $0.bytes) }, cycles: 48_000)
        XCTAssertEqual(verdict["passed"] as? Bool, true, "\(verdict)")
    }
}
#endif
