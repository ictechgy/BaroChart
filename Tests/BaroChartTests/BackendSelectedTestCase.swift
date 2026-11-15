import XCTest
@testable import BaroChart

/// Selects the SDK backend for shared tests without changing the production default.
///
/// `BAROCHART_TEST_BACKEND` is intentionally test-only. When it is absent, setup
/// leaves the process-wide default untouched so ordinary test runs retain the
/// JavaScript production default.
class BackendSelectedTestCase: XCTestCase {
    private var previousBackend: BaroChartBackend?

    override func setUp() {
        super.setUp()
        guard let requested = ProcessInfo.processInfo.environment["BAROCHART_TEST_BACKEND"] else { return }

        let backend: BaroChartBackend
        switch requested {
        case "javascript": backend = .javaScript
        case "rust": backend = .rust
        default:
            XCTFail("BAROCHART_TEST_BACKEND must be javascript or rust")
            return
        }

        onMainThread {
            self.previousBackend = BaroChartEngine.defaultBackend
            BaroChartEngine.defaultBackend = backend
        }
    }

    override func tearDown() {
        if let previousBackend {
            onMainThread {
                BaroChartEngine.defaultBackend = previousBackend
            }
        }
        super.tearDown()
    }

    func onMainThread(_ body: () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.sync(execute: body)
        }
    }
}

/// Selects JavaScript for tests that intentionally inspect JavaScriptCore or
/// record JavaScript traces. Generic typed tests keep the compiled Rust default.
class JavaScriptSelectedTestCase: BackendSelectedTestCase {
    private var previousJavaScriptBackend: BaroChartBackend?

    override func setUp() {
        super.setUp()
        onMainThread {
            previousJavaScriptBackend = BaroChartEngine.defaultBackend
            BaroChartEngine.defaultBackend = .javaScript
        }
    }

    override func tearDown() {
        if let previousJavaScriptBackend {
            onMainThread {
                BaroChartEngine.defaultBackend = previousJavaScriptBackend
            }
        }
        super.tearDown()
    }
}
