import XCTest
@testable import BaroChart

final class BackendSelectionTests: XCTestCase {
    private func withDefault(_ backend: BaroChartBackend, _ body: () throws -> Void) rethrows {
        let previous = BaroChartEngine.defaultBackend
        defer { BaroChartEngine.defaultBackend = previous }
        BaroChartEngine.defaultBackend = backend
        try body()
    }

    func testDefaultIsJavaScriptAndExplicitBackendIsImmutable() throws {
        XCTAssertEqual(BaroChartEngine.defaultBackend, .javaScript)
        let engine = try BaroChartEngine(options: BaroChartEngineOptions(), backend: .javaScript)
        XCTAssertEqual(engine.backend, .javaScript)
        try engine.close()
        XCTAssertEqual(engine.backend, .javaScript)
    }

    func testExplicitJavaScriptOverridesRustDefault() throws {
        try withDefault(.rust) {
            let engine = try BaroChartEngine(options: BaroChartEngineOptions(), backend: .javaScript)
            defer {try? engine.close()}
            XCTAssertEqual(engine.backend, .javaScript)
        }
    }

    func testRustDefaultDoesNotReadBundleURLWhenRustIsUnavailable() throws {
        try withDefault(.rust) {
            let missingURL = URL(fileURLWithPath: "/definitely/not/a/JavaScript/bundle.js")
#if canImport(BaroChartCoreRust)
            let engine = try BaroChartEngine(bundleURL: missingURL)
            defer {try? engine.close()}
            XCTAssertEqual(engine.backend, .rust)
#else
            XCTAssertThrowsError(try BaroChartEngine(bundleURL: missingURL)) { error in
                let typed = BaroChartError.wrap(error)
                XCTAssertEqual(typed.code, .unavailable)
                XCTAssertTrue(typed.message.contains("Rust backend is not included"), typed.message)
            }
#endif
        }
    }
}
