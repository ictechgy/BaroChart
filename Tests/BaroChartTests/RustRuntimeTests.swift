#if canImport(BaroChartCoreRust)
import XCTest
import JavaScriptCore
@testable import BaroChart

final class RustRuntimeTests: XCTestCase {
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
        XCTAssertThrowsError(try engine.fit())
        try engine.close()
        XCTAssertTrue(BaroChartTraceSettings.failuresForTesting.isEmpty)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let text = try String(contentsOf: files[0], encoding: .utf8)
        XCTAssertTrue(text.contains("nativeInit"))
        XCTAssertTrue(text.contains("UnavailableError"))
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
        let typed = try XCTUnwrap(failure {try engine.fit()})
        XCTAssertEqual(typed.code, .unavailable)
        XCTAssertTrue(typed.message.contains("nativeCommand"), typed.message)
        for name in ["nativeCommand", "nativeAsyncBegin", "nativeSelfTest"] {
            let lowLevel = try XCTUnwrap(failure {try engine.call(name)})
            XCTAssertEqual(lowLevel.code, .unavailable)
            XCTAssertTrue(lowLevel.message.contains(name), lowLevel.message)
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
