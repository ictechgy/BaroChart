#if canImport(BaroChartCoreRust)
import Foundation
import XCTest
@testable import BaroChart

final class RustAsyncEnvelopeTests: XCTestCase {
    @MainActor
    func testUnchangedHostScenariosMatchEveryJavaScriptTraceGolden() async throws {
        let previous = BaroChartEngine.defaultBackend
        BaroChartEngine.defaultBackend = .rust
        defer {
            BaroChartEngine.defaultBackend = previous
            BaroChartTraceSettings.directory = nil
        }
        let root = try TraceFiles.temporaryDirectory("rust-all-scenarios", removedAfter: self)
        for scenario in TraceScenario.allCases {
            let directory = root.appendingPathComponent(scenario.rawValue)
            BaroChartTraceSettings.directory = directory
            try await scenario.run()
            BaroChartTraceSettings.directory = nil
            XCTAssertEqual(BaroChartTraceSettings.failuresForTesting, [], scenario.rawValue)
            let actual = try TraceFiles.traces(in: directory, scenario: scenario)
            let expected = try TraceFiles.goldens(scenario)
            XCTAssertEqual(actual.map(\.name), expected.map(\.name), scenario.rawValue)
            if let path = ProcessInfo.processInfo.environment["BAROCHART_RUST_TRACE_EVIDENCE"] {
                let output = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                for trace in actual {
                    try trace.text.write(to: output.appendingPathComponent(trace.name), atomically: true, encoding: .utf8)
                }
            }
            for (a, e) in zip(actual, expected) where a.text != e.text {
                XCTFail("\(a.name): \(TraceFiles.firstDifference(a.text, e.text))")
            }
        }
    }
}
#endif
