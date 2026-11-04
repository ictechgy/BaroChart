#if canImport(BaroChartCoreRust)
import Foundation
import JavaScriptCore
import XCTest
@testable import BaroChart

/// Regression coverage for the Rust runtime's typed F64 path through the recording wrapper.
final class RustTypedTraceTests: XCTestCase {
    private func outcome(_ body: () throws -> Void) -> String {
        do {
            try body()
            return "ok"
        } catch {
            return "\(type(of: error)): \(error)"
        }
    }

    private func assertInvalidProtocol(
        _ body: () throws -> Void,
        message expected: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        do {
            try body()
            XCTFail("Expected invalid protocol: \(expected)", file: file, line: line)
        } catch let error as BaroChartAsyncError {
            guard case .invalidProtocol(let message) = error else {
                return XCTFail("Unexpected async error: \(error)", file: file, line: line)
            }
            XCTAssertEqual(message, expected, file: file, line: line)
        } catch {
            XCTFail("Unexpected error: \(error)", file: file, line: line)
        }
    }

    func testJavaScriptTypedReadValidatesCountAfterOneCoreInvocation() throws {
        let context = try XCTUnwrap(JSContext())
        let runtime = BaroChartJSCoreRuntime(context: context)
        let script = """
        var typedReadCalls = 0;
        const typedReadValues = new Float64Array([1, 2, 3, 4]);
        function typedReadView(offset, count) { typedReadCalls++; return typedReadValues.subarray(offset, offset + count); }
        function typedReadFailure() { typedReadCalls++; throw new TypeError('typed read failed'); }
        function typedReadCallCount() { return typedReadCalls; }
        """
        XCTAssertNil(runtime.evaluateBundle(script))

        for (index, count) in [0, -1, 262145].enumerated() {
            XCTAssertThrowsError(try runtime.readFloat64Data("typedReadView", [0, count], count: count))
            XCTAssertEqual(try runtime.invoke("typedReadCallCount", []).toInt32(), Int32(index + 1))
        }
        XCTAssertThrowsError(try runtime.readFloat64Data("typedReadView", [0, 4], count: 3))
        XCTAssertEqual(try runtime.invoke("typedReadCallCount", []).toInt32(), 4)
        XCTAssertThrowsError(try runtime.readFloat64Data("typedReadFailure", [], count: 0)) {error in
            guard case .javaScript(let message)? = error as? BaroChartLowLevelError else {
                return XCTFail("The core exception must precede invalid-count validation: \(error)")
            }
            XCTAssertEqual(message, "TypeError: typed read failed")
        }
        XCTAssertEqual(try runtime.invoke("typedReadCallCount", []).toInt32(), 5)
    }

    func testRustTypedReadRecordsTheActualF64Payload() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-trace-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        var result = [Double](repeating: 123, count: 4)
        do {
            let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
            _ = try runtime.invoke("nativeCommand", ["addIndicator", ["ema", "ema", ["period": 3]] as [Any]])
            try result.withUnsafeMutableBytes {bytes in
                try runtime.readFloat64(
                    "nativeIndicatorBuffer",
                    ["ema", "value", 0, 4],
                    into: bytes.baseAddress!,
                    count: 4
                )
            }
        }

        let digest = result.withUnsafeBytes {bytes in
            BaroChartTraceEncoder.sha256(bytes.baseAddress, bytes.count)
        }
        let expected = "{\"fn\":\"nativeIndicatorBuffer\",\"args\":[\"ema\",\"value\",0,4],\"ok\":F64(4,\(digest))}"
        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertTrue(BaroChartTraceSettings.failuresForTesting.isEmpty)
        XCTAssertTrue(lines.contains(expected), "Rust typed read did not emit the actual F64 result: \(lines)")
    }

    func testRustTypedReadErrorKeepsTheMissingCodeToken() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-trace-error-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        do {
            let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
            let echo = try runtime.invoke("nativeEcho", [["code": NSNull()] as [String: Any]])
            XCTAssertTrue(try XCTUnwrap(echo.forProperty("code")).isNull, "plain code:null must stay null")
            var destination = [Double](repeating: 123, count: 4)
            XCTAssertThrowsError(try destination.withUnsafeMutableBytes {bytes in
                try runtime.readFloat64(
                    "nativeIndicatorBuffer",
                    ["missing", "value", 0, 4],
                    into: bytes.baseAddress!,
                    count: 4
                )
            })
        }

        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        let error = try XCTUnwrap(lines.first {
            $0.contains("\"fn\":\"nativeIndicatorBuffer\"") && $0.contains("\"err\":")
        }, "the Rust core exception must be recorded")
        XCTAssertTrue(error.contains("\"code\":undefined"), "missing JS error code must remain undefined: \(error)")
        XCTAssertFalse(error.contains("\"code\":null"), "missing code must not be normalized to null: \(error)")
    }

    func testRustTypedReadLengthMismatchRecordsCoreViewBeforeHostValidation() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-trace-length-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        do {
            let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
            _ = try runtime.invoke("nativeCommand", ["addIndicator", ["ema", "ema", ["period": 3]] as [Any]])
            var destination = [Double](repeating: 123, count: 3)
            XCTAssertThrowsError(try destination.withUnsafeMutableBytes {bytes in
                try runtime.readFloat64(
                    "nativeIndicatorBuffer",
                    ["ema", "value", 0, 4],
                    into: bytes.baseAddress!,
                    count: 3
                )
            }, "the 4-element core view must fail the host's 3-element copy")
        }

        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        let transfer = try XCTUnwrap(lines.first {
            $0.contains("\"fn\":\"nativeIndicatorBuffer\"") && $0.contains("\"args\":[\"ema\",\"value\",0,4]")
        })
        XCTAssertTrue(transfer.contains("\"ok\":F64(4,"), "trace must record the actual core view before host count validation: \(transfer)")
    }

    func testRustTypedReadInvalidHostCountsStillRecordOneCoreResult() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-trace-counts-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        do {
            let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
            _ = try runtime.invoke("nativeCommand", ["addIndicator", ["ema", "ema", ["period": 3]] as [Any]])
            assertInvalidProtocol({ _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["ema", "value", 0, 4], count: 0) }, message: "Invalid copy count")
            assertInvalidProtocol({ _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["ema", "value", 0, 4], count: -1) }, message: "Invalid copy count")
            assertInvalidProtocol({ _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["ema", "value", 0, 4], count: 3) }, message: "Typed buffer bounds mismatch")
            assertInvalidProtocol({ _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["ema", "value", 0, 4], count: 262145) }, message: "Invalid copy count")
        }

        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        let transfers = lines.filter {$0.contains("\"fn\":\"nativeIndicatorBuffer\"")}
        XCTAssertEqual(transfers.count, 4)
        XCTAssertTrue(transfers.allSatisfy {$0.contains("\"ok\":F64(4,")}, "each host count error follows one successful 4-element Core result: \(transfers)")
    }

    func testRustTypedReadPriorityIsIdenticalWithTracingOffAndOn() throws {
        let direct = try runRustTypedReadPriorityScenario(traced: false)
        let traced = try runRustTypedReadPriorityScenario(traced: true)
        XCTAssertEqual(traced, direct)
        XCTAssertEqual(direct.count, 5)
        for (index, message) in direct.prefix(4).enumerated() {
            let expected = index == 2 ? "Typed buffer bounds mismatch" : "Invalid copy count"
            XCTAssertTrue(message.contains(expected), message)
        }
        XCTAssertTrue(direct[4].contains("Error: Missing indicator: missing"), direct[4])
    }

    private func runRustTypedReadPriorityScenario(traced: Bool) throws -> [String] {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-read-priority-\(UUID().uuidString)", isDirectory: true)
        if traced {BaroChartEngine.traceDirectoryForTesting = directory}
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }
        let runtime: BaroChartCoreRuntime = traced
            ? try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            : try XCTUnwrap(BaroChartRustCoreRuntime())
        _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
        _ = try runtime.invoke("nativeCommand", ["addIndicator", ["ema", "ema", ["period": 3]] as [Any]])
        var outcomes = [String]()
        for count in [0, -1, 3, 262145] {
            outcomes.append(outcome {
                _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["ema", "value", 0, 4], count: count)
            })
        }
        outcomes.append(outcome {
            _ = try runtime.readFloat64Data("nativeIndicatorBuffer", ["missing", "value", 0, 4], count: 262145)
        })
        return outcomes
    }

    func testRustNonF64ReadTracesTheOriginalValueBeforeTypedGuard() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-trace-non-f64-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        do {
            let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            _ = try runtime.invoke("nativeInit", [0, [:] as [String: Any]])
            var destination = [Double](repeating: 123, count: 4)
            XCTAssertThrowsError(try destination.withUnsafeMutableBytes {bytes in
                try runtime.readFloat64(
                    "nativeEcho",
                    [["payload": 1] as [String: Any]],
                    into: bytes.baseAddress!,
                    count: 4
                )
            })
        }

        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        let echo = try XCTUnwrap(lines.first {$0.contains("\"fn\":\"nativeEcho\"")})
        XCTAssertTrue(echo.contains("\"ok\":{\"payload\":1}"), "ordinary core values must be traced before the host typed-array guard: \(echo)")
        XCTAssertFalse(echo.contains("\"err\":"), "the host type guard is not a core error: \(echo)")
    }

    func testJavaScriptTypedWriteTracesCoreBeforeHostValidationAndNeverMutatesInvalidCopies() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("js-typed-write-priority-\(UUID().uuidString)", isDirectory: true)
        BaroChartEngine.traceDirectoryForTesting = directory
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .javaScript))
        let script = """
        var typedWriteCalls = 0;
        const typedWriteValues = new Float64Array(4);
        function typedWriteView(slot) { typedWriteCalls++; return typedWriteValues.subarray(slot, slot + 1); }
        function typedWriteFailure() { typedWriteCalls++; throw new TypeError('typed write failed'); }
        function typedWriteCallCount() { return typedWriteCalls; }
        function typedWriteSnapshot() { return Array.from(typedWriteValues); }
        """
        XCTAssertNil(runtime.evaluateBundle(script))
        let source = [Double(bitPattern: 0x7ff8_0000_0000_0042), -0.0]
        for (slot, count) in [0, -1, 262145, 2].enumerated() {
            assertInvalidProtocol({
                try source.withUnsafeBytes {
                    try runtime.writeFloat64("typedWriteView", [slot], from: $0.baseAddress!, count: count)
                }
            }, message: count == 2 ? "Typed buffer bounds mismatch" : "Invalid copy count")
            XCTAssertEqual(try runtime.invoke("typedWriteCallCount", []).toInt32(), Int32(slot + 1))
        }
        XCTAssertThrowsError(try source.withUnsafeBytes {
            try runtime.writeFloat64("typedWriteFailure", [], from: $0.baseAddress!, count: 0)
        }) { error in
            guard case .javaScript(let message)? = error as? BaroChartLowLevelError else {
                return XCTFail("Core exception must precede the invalid host count: \(error)")
            }
            XCTAssertEqual(message, "TypeError: typed write failed")
        }
        XCTAssertEqual(try runtime.invoke("typedWriteCallCount", []).toInt32(), 5)
        XCTAssertEqual(try runtime.invoke("typedWriteSnapshot", []).toArray() as? NSArray, [0.0, 0.0, 0.0, 0.0] as NSArray)

        let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
        let lines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        let views = lines.filter {$0.contains("\"fn\":\"typedWriteView\"")}
        XCTAssertEqual(views.count, 4)
        XCTAssertTrue(views.allSatisfy {$0.contains("\"ok\":F64(1,")}, "raw Core views must be logged before every host rejection: \(views)")
        XCTAssertTrue(lines.contains {$0.contains("\"fn\":\"typedWriteFailure\"") && $0.contains("\"err\":")})
        XCTAssertFalse(lines.contains {$0.contains("\"write\":")}, "invalid host copies must not emit write rows")
    }

    func testRustTypedWriteParityIsIdenticalWithTracingOffAndOn() throws {
        let direct = try runRustTypedWritePriorityScenario(traced: false)
        let traced = try runRustTypedWritePriorityScenario(traced: true)
        XCTAssertEqual(traced.outcomes, direct.outcomes)
        XCTAssertEqual(direct.outcomes.count, 13)
        for index in stride(from: 0, to: 12, by: 3) {
            XCTAssertTrue(direct.outcomes[index].contains("invalidProtocol"), direct.outcomes[index])
            XCTAssertTrue(direct.outcomes[index + 1].contains("RangeError: Prepare target slice"), direct.outcomes[index + 1])
            XCTAssertEqual(direct.outcomes[index + 2], "ok")
        }
        XCTAssertTrue(direct.outcomes[12].contains("Error: Async target missing"), direct.outcomes[12])

        let lines = try XCTUnwrap(traced.traceLines)
        let rejected = lines.filter {line in
            line.contains("\"fn\":\"nativeAsyncTargetBuffer\"") &&
                ["[0,0,1]", "[1,0,1]", "[2,0,1]", "[3,0,1]"].contains(where: {line.contains("\"args\":\($0)")})
        }
        XCTAssertEqual(rejected.count, 8, "each invalid copy has one raw result and one deliberate cursor retry: \(rejected)")
        for slot in 0..<4 {
            let rows = rejected.filter {$0.contains("\"args\":[\(slot),0,1]")}
            XCTAssertEqual(rows.count, 2)
            XCTAssertTrue(rows.contains {$0.contains("\"ok\":F64(1,")})
            XCTAssertTrue(rows.contains {$0.contains("\"err\":")})
        }
        XCTAssertTrue(lines.contains {
            $0.contains("\"fn\":\"nativeAsyncTargetBuffer\"") &&
                $0.contains("\"args\":[0,1,1]") && $0.contains("\"ok\":F64(1,")
        })
        XCTAssertTrue(lines.contains {$0.contains("\"write\":")}, "the valid bit-exact writes must retain normal trace receipts")
    }

    private func runRustTypedWritePriorityScenario(traced: Bool) throws -> (outcomes: [String], traceLines: [String]?) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-typed-write-priority-\(UUID().uuidString)", isDirectory: true)
        if traced {BaroChartEngine.traceDirectoryForTesting = directory}
        defer {
            BaroChartEngine.traceDirectoryForTesting = nil
            try? FileManager.default.removeItem(at: directory)
        }

        let sourceRuntime = try XCTUnwrap(BaroChartRustCoreRuntime())
        _ = try sourceRuntime.invoke("nativeInit", [2, [:] as [String: Any]])
        let beginText = try XCTUnwrap(try sourceRuntime.invoke(
            "nativePrepareBegin",
            ["{\"kind\":\"columns\",\"length\":2,\"visibleBars\":1}"]
        ).toString())
        let beginData = try XCTUnwrap(beginText.data(using: .utf8))
        let begin = try XCTUnwrap(JSONSerialization.jsonObject(with: beginData) as? [String: Any])
        let metadata = try XCTUnwrap(begin["metadataJSON"] as? String)

        let target: BaroChartCoreRuntime = traced
            ? try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            : try XCTUnwrap(BaroChartRustCoreRuntime())
        _ = try target.invoke("nativePrepareCreate", [metadata])
        let bits = [Double(bitPattern: 0x7ff8_0000_0000_0042), -0.0]
        var outcomes: [String] = []
        for (slot, count) in [0, -1, 262145, 2].enumerated() {
            outcomes.append(outcome {
                try bits.withUnsafeBytes {
                    try target.writeFloat64("nativeAsyncTargetBuffer", [slot, 0, 1], from: $0.baseAddress!, count: count)
                }
            })
            outcomes.append(outcome {
                try bits.withUnsafeBytes {
                    try target.writeFloat64("nativeAsyncTargetBuffer", [slot, 0, 1], from: $0.baseAddress!, count: 1)
                }
            })
            outcomes.append(outcome {
                try bits.withUnsafeBytes {
                    try target.writeFloat64("nativeAsyncTargetBuffer", [slot, 1, 1], from: $0.baseAddress!, count: 1)
                }
            })
        }

        let absent: BaroChartCoreRuntime = traced
            ? try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
            : try XCTUnwrap(BaroChartRustCoreRuntime())
        outcomes.append(outcome {
            try bits.withUnsafeBytes {
                try absent.writeFloat64("nativeAsyncTargetBuffer", [0, 0, 1], from: $0.baseAddress!, count: 0)
            }
        })
        let traceLines: [String]?
        if traced {
            let traceURL = directory.appendingPathComponent("runtime-1.jsonl")
            traceLines = try String(contentsOf: traceURL, encoding: .utf8).split(separator: "\n").map(String.init)
        } else {
            traceLines = nil
        }
        return (outcomes, traceLines)
    }
}
#endif
