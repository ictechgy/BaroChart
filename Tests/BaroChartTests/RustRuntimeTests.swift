#if canImport(BaroChartCoreRust)
import XCTest
import JavaScriptCore
@testable import BaroChart

final class RustRuntimeTests: XCTestCase {
    func testCanonicalEmptyResourceStatusesKeepTheirPlatformErrorClass() {
        let cases: [(UInt32, String)] = [(7, "InternalError: out of memory"), (8, "RangeError: Out of memory")]
        for (status, expected) in cases {
            guard case .rejected(let error) = BaroChartRustStatusDecoder.outcome(status: status, value: nil),
                  case .javaScript(let message)? = error as? BaroChartLowLevelError else {
                return XCTFail("Resource status must keep its fixed platform error")
            }
            XCTAssertEqual(message, expected)
        }
    }

    func testGenericNativeIndicatorCallReturnsAFloat64Array() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions(), backend: .rust)
        defer {try? engine.close()}
        _ = try engine.call("nativeInit", [32, [:] as [String: Any]])
        _ = try engine.addIndicator("s", "sma", ["period": 3])
        let values = try engine.call("nativeIndicatorBuffer", ["s", "value", -0.0, 4])
        XCTAssertEqual(values.forProperty("constructor")?.forProperty("name")?.toString(), "Float64Array")
        XCTAssertEqual(values.forProperty("length")?.toInt32(), 4)
        XCTAssertTrue(try XCTUnwrap(values.atIndex(0)).toDouble().isNaN)
        XCTAssertTrue(try XCTUnwrap(values.atIndex(2)).toDouble().isFinite)
        XCTAssertEqual(values.invokeMethod("subarray", withArguments: [1, 3])?.forProperty("length")?.toInt32(), 2)
    }

    func testGenericPacketCallKeepsItsFloat64NumberBuffer() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions(), backend: .rust)
        defer {try? engine.close()}
        _ = try engine.call("nativeInit", [16, [:] as [String: Any]])
        let packet = try engine.call("nativeScenePacket", ["scene", NSNull(), 320, 240, false])
        XCTAssertEqual(packet.forProperty("metadata")?.isString, true)
        let numbers = try XCTUnwrap(packet.forProperty("numbers"))
        XCTAssertEqual(numbers.forProperty("constructor")?.forProperty("name")?.toString(), "Float64Array")
        XCTAssertGreaterThan(try XCTUnwrap(numbers.forProperty("length")).toInt32(), 0)
    }

    func testRustBusyStatusMapsToTransientUnavailableInsteadOfClosed() {
        let outcome = BaroChartRustStatusDecoder.outcome(status: 5, value: nil) // BC_BUSY
        guard case .rejected(let error) = outcome else {return XCTFail("BC_BUSY must be a host rejection")}
        let wrapped = BaroChartError.wrap(error)
        XCTAssertEqual(wrapped.code, .unavailable)
        XCTAssertEqual(wrapped.message, "Another asynchronous job is already active on this engine.")
    }

    func testRustClosedAndPoisonedStatusesRetainDisposedClassification() {
        for status: UInt32 in [3, 4] { // BC_CLOSED, BC_POISONED
            let outcome = BaroChartRustStatusDecoder.outcome(status: status, value: nil)
            guard case .rejected(let error) = outcome,
                  let lowLevel = error as? BaroChartLowLevelError,
                  case .javaScript(let message) = lowLevel else {
                return XCTFail("\(status) must reject with the disposed host error")
            }
            XCTAssertEqual(message, "Error: Chart disposed")
            XCTAssertEqual(BaroChartError.wrap(error).code, .engineClosed)
        }
    }

    func testRawCallReturnsTheRustNativeInitValue() throws {
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        defer {try? engine.close()}
        XCTAssertEqual(try engine.call("nativeInit", [7]).toInt32(), 7)
    }

    func testDataCommandsAndIngestionUseRealRustOwnedPayloads() throws {
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        defer {try? engine.close()}
        _ = try engine.call("nativeInit", [0, [String: Any]()])
        let bar: [String: Any] = ["time": 1000, "open": 1, "high": 2, "low": 0, "close": 1, "volume": 1]
        XCTAssertTrue(try engine.call("nativeCommand", ["setData", [[bar]]]).isNull)
        let configured = try engine.call("nativeDataIngestionCommand", ["configureDataIngestion", [["streamId": "native", "generation": 1]]])
        XCTAssertEqual(configured.forProperty("result")?.forProperty("policy")?.forProperty("streamId")?.toString(), "native")
        let next: [String: Any] = ["time": 2000, "open": 2, "high": 3, "low": 1, "close": 2, "volume": 1]
        let packet: [String: Any] = ["streamId": "native", "generation": 1, "firstSequence": 0, "events": [["kind": "append", "bar": next]]]
        let enqueued = try engine.call("nativeDataIngestionCommand", ["enqueueDataEvents", [packet]])
        XCTAssertEqual(enqueued.forProperty("result")?.forProperty("pendingEvents")?.toInt32(), 1)
        let drained = try engine.call("nativeDataIngestionCommand", ["drainDataEvents"])
        XCTAssertEqual(drained.forProperty("result")?.forProperty("length")?.toInt32(), 2)
        _ = try engine.call("nativeReleaseDataIngestion")
        let closed = try engine.call("nativeDataIngestionCommand", ["dataIngestionStats"])
        XCTAssertEqual(closed.forProperty("error")?.forProperty("code")?.toString(), "CLOSED")
    }

    func testNativeIndicatorF64ReadsActualSliceAndKeepsWarmupNan() throws {
        let runtime = try XCTUnwrap(BaroChartRustCoreRuntime())
        _ = try runtime.invoke("nativeInit", [32, [:] as [String: Any]])
        _ = try runtime.invoke("nativeCommand", ["addIndicator", ["ema", "ema", ["period": 3]] as [Any]])
        var values = [Double](repeating: 123, count: 4)
        try values.withUnsafeMutableBytes { bytes in
            try runtime.readFloat64("nativeIndicatorBuffer", ["ema", "value", 0, 4], into: bytes.baseAddress!, count: 4)
        }
        XCTAssertTrue(values[0].isNaN); XCTAssertTrue(values[1].isNaN)
        XCTAssertTrue(values[2].isFinite); XCTAssertTrue(values[3].isFinite)
        let previous = values.map(\.bitPattern)
        XCTAssertThrowsError(try values.withUnsafeMutableBytes { bytes in
            try runtime.readFloat64("nativeIndicatorBuffer", ["ema", "value", 31, 4], into: bytes.baseAddress!, count: 4)
        })
        XCTAssertEqual(values.map(\.bitPattern), previous)
    }

    func testDecodedUTF16StringKeepsTheCoreStringContract() throws {
        let realm = try XCTUnwrap(RustValueRealm.current())
        let value = try realm.materialize(.wtf16([0x61, 0xd800]))
        XCTAssertTrue(value.isString)
    }

    func testValueRealmPreservesKeysUndefinedAndJavaScriptCoercions() throws {
        let realm = try XCTUnwrap(RustValueRealm.current())
        var parser = RustJSONParser("{\"z\":undefined,\"__proto__\":{\"kept\":true},\"\\ud800\":1,\"\\ud801\":2,\"�\":3,\"a\":-0}")
        let value = try realm.materialize(parser.parse())
        XCTAssertTrue(try XCTUnwrap(value.forProperty("z")).isUndefined)
        XCTAssertNil(value.toDictionary()?["z"])
        XCTAssertTrue(try XCTUnwrap(value.forProperty("__proto__")?.forProperty("kept")).toBool())
        XCTAssertEqual(value.javaScriptValue.context.evaluateScript("typeof nativeInit")?.toString(), "undefined")
        let keys = value.javaScriptContext.objectForKeyedSubscript("Object")?.forProperty("keys")?.call(withArguments: [value.javaScriptValue])
        XCTAssertEqual(keys?.toArray()?.count, 6)
        XCTAssertEqual(keys?.atIndex(2)?.invokeMethod("charCodeAt", withArguments: [0])?.toInt32(), 0xd800)
        XCTAssertEqual(try realm.materialize(.number(1e30)).toInt32(), 0)
        XCTAssertEqual(try realm.materialize(.array([.number(1), .null, .undefined, .number(2)])).toString(), "1,,,2")
        XCTAssertEqual(try realm.materialize(.string(" \n ")).toDouble(), 0)
        XCTAssertEqual(try realm.materialize(.number(1)).toString(), "1")
        for (number, expected) in [(pow(2, 63), Int32(0)), (1e20, Int32(1661992960)), (-1, Int32(-1)), (Double.nan, Int32(0)), (Double.infinity, Int32(0)), (-0.0, Int32(0))] {
            XCTAssertEqual(try realm.materialize(.number(number)).toInt32(), expected)
        }
        let array = try XCTUnwrap(try realm.materialize(.array([.undefined, .null, .bool(true)])).toArray())
        XCTAssertTrue(array[0] is NSNull)
        XCTAssertTrue(array[1] is NSNull)
        XCTAssertTrue(try realm.materialize(.bool(true)).isBoolean)
    }

    func testValueRealmReusesTheCurrentThreadAfterRuntimeHandoff() throws {
        let realm = try XCTUnwrap(RustValueRealm.current())
        XCTAssertTrue(realm === RustValueRealm.current())
        let box = RustRuntimeHandoffBox(), finished = DispatchSemaphore(value: 0)
        Thread {
            do {
                let runtime = try XCTUnwrap(BaroChartRustCoreRuntime())
                let result = try runtime.invoke("nativeInit", [2])
                box.store(runtime, result.javaScriptContext)
            } catch {box.failure = error}
            finished.signal()
        }.start()
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        if let failure = box.failure {throw failure}
        let runtime = try XCTUnwrap(box.runtime)
        let value = try runtime.invoke("nativeInit", [3])
        XCTAssertEqual(value.toInt32(), 3)
        XCTAssertTrue(value.javaScriptContext === realm.context)
        XCTAssertFalse(value.javaScriptContext === box.context)
    }

    func testRustRuntimeRejectsExcessiveHostDepthBeforeEncoding() throws {
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
        var nested: Any = 1
        for _ in 0..<64 {nested = [nested]}
        guard case .rejected = runtime.perform("nativeInit", [nested]) else {return XCTFail("deep arguments must be rejected")}
        XCTAssertEqual(try runtime.invoke("nativeInit", [7]).toInt32(), 7)
    }

    func testRustRawCallAndErrorsCanBeRecorded() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        BaroChartTraceSettings.directory = directory
        defer {BaroChartTraceSettings.directory = nil;try? FileManager.default.removeItem(at: directory)}
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        XCTAssertEqual(try engine.call("nativeInit", [3]).toInt32(), 3)
        XCTAssertThrowsError(try engine.call("nativeView", [2, 1]))
        try engine.close()
        XCTAssertTrue(BaroChartTraceSettings.failuresForTesting.isEmpty)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let text = try String(contentsOf: files[0], encoding: .utf8)
        XCTAssertTrue(text.contains("nativeInit"))
        XCTAssertTrue(text.contains("RangeError"))
    }

    func testBCJSONEncoderPreservesNumericKindsAndSortsKeysByUTF16() throws {
        let object = try RustJSON.from(["b": NSNumber(value: 1), "a": NSNumber(value: true), "negativeZero": -0.0,
                                       "nan": Double.nan, "positiveInfinity": Double.infinity, "negativeInfinity": -Double.infinity,
                                       "large": 1e20, "small": 1e-7])
        XCTAssertEqual(object.encoded(lossless: true),
                       "{\"a\":true,\"b\":1,\"large\":100000000000000000000,\"nan\":NaN,\"negativeInfinity\":-Infinity,\"negativeZero\":-0,\"positiveInfinity\":Infinity,\"small\":1e-7}")
        XCTAssertEqual(try RustJSON.from(Double.nan).encoded(lossless: false), "null")
    }

    func testBCJSONEncoderEscapesIsolatedUTF16Surrogates() throws {
        let invalidString = NSString(characters: [0xd800], length: 1)
        XCTAssertEqual(try RustJSON.from(invalidString).encoded(lossless: true), "\"\\ud800\"")
        let invalidKey = NSString(characters: [0xdfff], length: 1)
        let dictionary = NSDictionary(object: NSNumber(value: 1), forKey: invalidKey)
        XCTAssertEqual(try RustJSON.from(dictionary).encoded(lossless: true), "{\"\\udfff\":1}")
    }

    func testBCJSONDecoderRoundTripsLosslessTokensAndWTF16() throws {
        var parser = RustJSONParser("[undefined,-0,NaN,Infinity,-Infinity,\"\\ud800\"]")
        XCTAssertEqual(try parser.parse().encoded(lossless: true), "[undefined,-0,NaN,Infinity,-Infinity,\"\\ud800\"]")
    }

    func testRustEngineInitializesAndUnportedFunctionsAreUnavailable() throws {
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        defer {try? engine.close()}
        XCTAssertFalse(engine.isClosed)
        XCTAssertNoThrow(try engine.fit())
        let rejected = ["nativeWorkspaceTargetDispose", "nativeWorkspaceSourceBuffer", "nativeWorkspaceSourceDispose",
                        "nativeAsyncUI", "nativeRegisterIndicatorSource", "nativeAnalysisDemo", "nativeAnalysisReload",
                        "nativeStudyVerification", "nativePublicationOrderSelfTest", "nativeSelfTest", "nativeExtendedSelfTest",
                        "nativeHardeningSelfTest", "nativeComparisonDemo", "nativeComparisonReadout", "nativeComparisonAction",
                        "nativeAxesSelfTest", "nativeParamsTargetDispose"]
        for name in rejected {
            let lowLevel = try XCTUnwrap(failure {try engine.call(name)})
            XCTAssertEqual(lowLevel.code, .unavailable)
            let expected = name == "nativeRegisterIndicatorSource"
                ? "Indicator source registration requires the javaScript backend"
                : "\(name) is not available in the Rust backend"
            XCTAssertEqual(lowLevel.message, expected)
        }
    }

    func testUnknownFunctionKeepsTheJavaScriptHostMissingOutcome() throws {
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeRustEngineRuntime())
        guard case .missing = runtime.perform("__not_a_native_function", []) else {
            return XCTFail("Undefined names must retain the missing outcome")
        }
        XCTAssertTrue(runtime.supports("nativeSelfTest"))
        XCTAssertFalse(runtime.supports("__not_a_native_function"))
    }

    func testIsolatedRuntimeUsesRequestedRustBackend() throws {
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .rust))
        if case .rust = runtime.backend {} else {XCTFail("Isolated runtime changed backend")}
    }

    func testClosedRustEngineRetainsClosedClassification() throws {
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        try engine.close()
        XCTAssertEqual(code {try engine.fit()}, .engineClosed)
    }

    func testRustEngineOwnerThreadCheckMatchesJavaScriptBackend() throws {
        let engine = try BaroChartEngine(options: nil, runtimeBackend: .rust)
        defer {try? engine.close()}
        let finished = DispatchSemaphore(value: 0)
        let result = RustRuntimeResultBox()
        Thread {
            do {try engine.fit();result.code = nil} catch {result.code = BaroChartError.wrap(error).code}
            finished.signal()
        }.start()
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(result.code, .wrongThread)
    }

    private func code(_ body: () throws -> Void) -> BaroChartError.Code? {
        do {try body();return nil} catch {return BaroChartError.wrap(error).code}
    }

    private func failure(_ body: () throws -> Void) -> BaroChartError? {
        do {try body();return nil} catch {return BaroChartError.wrap(error)}
    }
}

private final class RustRuntimeResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: BaroChartError.Code?
    var code: BaroChartError.Code? {get {lock.lock();defer {lock.unlock()};return value} set {lock.lock();value = newValue;lock.unlock()}}
}

private final class RustRuntimeHandoffBox: @unchecked Sendable {
    // Semaphore publication happens-before the sole reader; the worker is the only writer.
    var runtime: BaroChartCoreRuntime?
    var context: JSContext?
    var failure: Error?
    func store(_ runtime: BaroChartCoreRuntime, _ context: JSContext) {self.runtime = runtime;self.context = context}
}
#endif
