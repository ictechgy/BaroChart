import Foundation
import JavaScriptCore
import XCTest
@testable import BaroChart

/// 코어 이음새 BaroChartCoreRuntime(JS 구현)이 리팩터링 전 asterInvoke·asterTypedBytes+memcpy와 같은 의미인지 확인한다(M0 Task 6).
/// 비교 기준은 이 파일 아래의 legacyInvoke·legacyTypedBytes로, 리팩터링 전 BaroChartEngine.swift 본문을 그대로 옮겨 둔 것이다.
final class CoreRuntimeTests: XCTestCase {
    /// 시험용 전역 함수들. 결과 종류, 던지는 값, Float64Array 뷰를 고르게 낸다.
    private static let script = """
    var definedNumber = 5;
    var undefinedGlobal = undefined;
    function undefinedValue() { return undefined; }
    function nullValue() { return null; }
    function numberValue() { return 42.75; }
    function nanValue() { return NaN; }
    function negativeZero() { return -0; }
    function stringValue() { return 'text \\u00e9'; }
    function booleanValue() { return true; }
    function dictionaryValue() { return {b: 'x', a: 1, c: null, d: undefined, e: [1, 'two', null, undefined], f: {g: NaN}}; }
    function echo(value) { return value; }
    function typeError() { throw new TypeError('Bad input: limit 3'); }
    function ingestionError() { const error = new Error('Queue is full'); error.name = 'IngestionError'; error.code = 'QUEUE_FULL'; throw error; }
    function longCodeError() { const error = new Error('Too long'); error.name = 'IngestionError'; error.code = 'X'.repeat(65); throw error; }
    function numberCodeError() { const error = new Error('Numeric code'); error.name = 'IngestionError'; error.code = 7; throw error; }
    function primitiveThrow() { throw 'plain text'; }
    function nullThrow() { throw null; }
    var store = Float64Array.from({length: 16}, (_, i) => i * 1.5 - 3);
    store[3] = NaN; store[4] = -0;
    function view(offset, count) { return store.subarray(offset, offset + count); }
    function plainArray() { return [1, 2, 3]; }
    function snapshot() { return Array.from(store); }
    """

    /// 시험 스크립트를 평가한 JS 런타임
    private func makeRuntime() throws -> BaroChartCoreRuntime {
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .javaScript))
        XCTAssertNil(runtime.evaluateBundle(Self.script)?.toString())
        return runtime
    }

    /// 같은 스크립트를 평가한 날 JSContext(비교 기준용)
    private func makeLegacyContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext(virtualMachine: JSVirtualMachine()))
        context.evaluateScript(Self.script)
        XCTAssertNil(context.exception)
        return context
    }

    /// supports는 이전 존재 검사처럼 전역이 정의돼 있는지만 본다(함수가 아니어도 참, undefined면 거짓).
    func testBackendAndSupportsFollowGlobalDefinition() throws {
        let runtime = try makeRuntime(), legacy = try makeLegacyContext()
        XCTAssertEqual(runtime.backend, .javaScript)
        // 이전 검사는 objectForKeyedSubscript(name)?.isUndefined == false였다: 함수가 아니어도 정의돼 있으면 참이다.
        for name in ["numberValue", "definedNumber", "undefinedGlobal", "missingFunction", "store", "Math"] {
            XCTAssertEqual(runtime.supports(name), legacy.objectForKeyedSubscript(name)?.isUndefined == false, name)
        }
        XCTAssertTrue(runtime.supports("numberValue"))
        XCTAssertFalse(runtime.supports("missingFunction"))
        XCTAssertFalse(runtime.supports("undefinedGlobal"))
    }

    /// invoke 결과 접근자는 JSValue 멤버와 같은 값을 낸다(undefined, null, 숫자, NaN, -0, 문자열, 딕셔너리, 배열).
    func testInvokeValueAccessorsMatchJSValue() throws {
        let runtime = try makeRuntime(), legacy = try makeLegacyContext()
        let undefinedValue = try runtime.invoke("undefinedValue", [])
        XCTAssertTrue(undefinedValue.isUndefined)
        XCTAssertFalse(undefinedValue.isNull)
        let nullValue = try runtime.invoke("nullValue", [])
        XCTAssertTrue(nullValue.isNull)
        XCTAssertFalse(nullValue.isUndefined)
        XCTAssertNil(nullValue.toDictionary())
        let number = try runtime.invoke("numberValue", [])
        XCTAssertTrue(number.isNumber)
        XCTAssertEqual(number.toDouble(), 42.75)
        XCTAssertEqual(number.toInt32(), 42)
        XCTAssertEqual(number.toString(), "42.75")
        XCTAssertTrue(try runtime.invoke("nanValue", []).toDouble().isNaN)
        let zero = try runtime.invoke("negativeZero", []).toDouble()
        XCTAssertEqual(zero, 0)
        XCTAssertEqual(zero.sign, .minus)
        let string = try runtime.invoke("stringValue", [])
        XCTAssertTrue(string.isString)
        XCTAssertEqual(string.toString(), "text é")
        let boolean = try runtime.invoke("booleanValue", [])
        XCTAssertTrue(boolean.isBoolean)
        XCTAssertTrue(boolean.toBool())
        let dictionary = try runtime.invoke("dictionaryValue", [])
        XCTAssertTrue(dictionary.isObject)
        XCTAssertFalse(dictionary.isArray)
        let expected = try legacyInvoke(legacy, "dictionaryValue")
        XCTAssertEqual(NSDictionary(dictionary: try XCTUnwrap(dictionary.toDictionary())), NSDictionary(dictionary: try XCTUnwrap(expected.toDictionary())))
        XCTAssertEqual(dictionary.forProperty("a")?.toDouble(), 1)
        XCTAssertEqual(dictionary.forProperty("b")?.toString(), "x")
        XCTAssertEqual(try XCTUnwrap(dictionary.forProperty("f")?.forProperty("g")).toDouble().isNaN, true)
        let array = try runtime.invoke("plainArray", [])
        XCTAssertTrue(array.isArray)
        XCTAssertEqual(array.toArray() as? [Int], [1, 2, 3])
        // 인자는 JSValue와 같은 규칙으로 넘어간다(NSNull은 null, CFBoolean은 불리언)
        XCTAssertTrue(try runtime.invoke("echo", [NSNull()]).isNull)
        XCTAssertTrue(try runtime.invoke("echo", [false]).isBoolean)
        XCTAssertEqual(try runtime.invoke("echo", [["k": [1.5, "v"]]]).forProperty("k")?.toArray() as? NSArray, [1.5, "v"] as NSArray)
        // 공개 call이 돌려주는 JSValue는 같은 컨텍스트의 값이다
        XCTAssertTrue(number.javaScriptValue.context === runtime.javaScriptContext)
    }

    /// invoke의 오류 형식·문구와 남는 JSC 예외 상태가 이전 asterInvoke와 같다.
    func testInvokeErrorsMatchLegacyAsterInvoke() throws {
        for name in ["missingFunction", "typeError", "ingestionError", "longCodeError", "numberCodeError", "primitiveThrow", "nullThrow", "definedNumber"] {
            let runtime = try makeRuntime(), legacy = try makeLegacyContext()
            let actual = errorDescription {_ = try runtime.invoke(name, [])}
            let expected = errorDescription {_ = try legacyInvoke(legacy, name)}
            XCTAssertNotNil(actual, name)
            XCTAssertEqual(actual, expected, name)
            // 예외 처리 중 JSC가 남기는 상태(null을 던졌을 때 속성 읽기가 남기는 TypeError 등)까지 같아야 JSC 호출 순서가 같다
            XCTAssertEqual(runtime.javaScriptContext.exception?.toString(), legacy.exception?.toString(), name)
        }
    }

    /// readFloat64·writeFloat64가 이전 asterTypedBytes + memcpy 경로와 같은 바이트를 옮기고 같은 오류를 낸다.
    func testFloat64CopiesMatchLegacyMemcpyPath() throws {
        let runtime = try makeRuntime(), legacy = try makeLegacyContext()
        let read = try runtime.readFloat64Data("view", [2, 8], count: 8)
        let expected = Data(bytes: try legacyTypedBytes(try legacyInvoke(legacy, "view", [2, 8]), legacy, count: 8), count: 64)
        XCTAssertEqual(read, expected)
        var raw = [UInt8](repeating: 0xAA, count: 64)
        try raw.withUnsafeMutableBytes {try runtime.readFloat64("view", [2, 8], into: $0.baseAddress!, count: 8)}
        XCTAssertEqual(Data(raw), expected)
        // 쓰기: NaN 페이로드와 -0 비트까지 그대로 옮긴다
        let source: [UInt64] = [0x7ff8_0000_0000_0001, 0x8000_0000_0000_0000, Double(12.5).bitPattern, 0x7ff0_0000_0000_0000, Double(-1).bitPattern, 1]
        try source.withUnsafeBytes {try runtime.writeFloat64("view", [4, 6], from: $0.baseAddress!, count: 6)}
        let target = try legacyTypedBytes(try legacyInvoke(legacy, "view", [4, 6]), legacy, count: 6)
        source.withUnsafeBytes {_ = memcpy(target, $0.baseAddress!, 48)}
        XCTAssertEqual(try runtime.readFloat64Data("view", [0, 16], count: 16), Data(bytes: try legacyTypedBytes(try legacyInvoke(legacy, "view", [0, 16]), legacy, count: 16), count: 128))
        // 실패 문구도 같다: 개수 범위, 타입 배열이 아닌 결과, 길이 불일치, 코어 예외
        let cases: [(String, [Any], Int)] = [("view", [0, 4], 0), ("view", [0, 4], 262145), ("plainArray", [], 3), ("view", [0, 4], 5), ("typeError", [], 1), ("missingFunction", [], 1)]
        for (name, arguments, count) in cases {
            let readError = errorDescription {_ = try runtime.readFloat64Data(name, arguments, count: count)}
            let writeError = errorDescription {try [Double](repeating: 1, count: max(count, 1)).withUnsafeBytes {try runtime.writeFloat64(name, arguments, from: $0.baseAddress!, count: count)}}
            let legacyError = errorDescription {_ = try legacyTypedBytes(try legacyInvoke(legacy, name, arguments), legacy, count: count)}
            XCTAssertNotNil(legacyError, name)
            XCTAssertEqual(readError, legacyError, "\(name) \(count)")
            XCTAssertEqual(writeError, legacyError, "\(name) \(count)")
        }
    }

    /// 기록 런타임은 결과와 오류를 바꾸지 않고, 코어 호출만 BCJSON 줄로 남긴다(supports·번들 평가는 쓰지 않는다).
    func testRecordingRuntimeForwardsTheSameOutcomes() throws {
        let directory = try TraceFiles.temporaryDirectory("core-runtime", removedAfter: self)
        BaroChartEngine.traceDirectoryForTesting = directory
        let recorded: BaroChartCoreRuntime
        do {
            recorded = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .javaScript))
            BaroChartEngine.traceDirectoryForTesting = nil
        } catch {
            BaroChartEngine.traceDirectoryForTesting = nil
            throw error
        }
        XCTAssertTrue(recorded is BaroChartRecordingCoreRuntime)
        XCTAssertNil(recorded.evaluateBundle(Self.script)?.toString())
        let plain = try makeRuntime()
        XCTAssertFalse(plain is BaroChartRecordingCoreRuntime)
        XCTAssertEqual(try recorded.invoke("numberValue", []).toDouble(), try plain.invoke("numberValue", []).toDouble())
        XCTAssertEqual(errorDescription {_ = try recorded.invoke("ingestionError", [])}, errorDescription {_ = try plain.invoke("ingestionError", [])})
        XCTAssertEqual(recorded.supports("view"), plain.supports("view"))
        XCTAssertEqual(try recorded.readFloat64Data("view", [0, 4], count: 4), try plain.readFloat64Data("view", [0, 4], count: 4))
        let lines = try String(contentsOf: directory.appendingPathComponent("runtime-1.jsonl"), encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines.first.map(String.init), "{\"fn\":\"numberValue\",\"args\":[],\"ok\":42.75}")
        XCTAssertEqual(lines.dropFirst().first.map(String.init), "{\"fn\":\"ingestionError\",\"args\":[],\"err\":{\"name\":\"IngestionError\",\"message\":\"Queue is full\",\"code\":\"QUEUE_FULL\"}}")
    }

    /// 던진 오류의 형식과 내용(던지지 않으면 nil)
    private func errorDescription(_ body: () throws -> Void) -> String? {
        do {try body();return nil} catch {return "\(type(of: error)): \(error)"}
    }
}

// 아래 두 함수는 리팩터링 전 native/BaroChartEngine.swift의 asterInvoke와 asterTypedBytes 본문을 그대로 옮긴 비교 기준이다.

/// 리팩터링 전 asterInvoke
private func legacyInvoke(_ context: JSContext, _ name: String, _ args: [Any] = []) throws -> JSValue {
    guard let function = context.objectForKeyedSubscript(name), !function.isUndefined,
          let value = function.call(withArguments: args) else {throw BaroChartLowLevelError.javaScript("Missing function: \(name)")}
    if let exception = context.exception {
        context.exception = nil
        if exception.forProperty("name")?.toString()=="IngestionError",let code=exception.forProperty("code"),code.isString,let codeText=code.toString(),!codeText.isEmpty,codeText.utf16.count<=64,let message=exception.forProperty("message"),message.isString,let messageText=message.toString(),messageText.utf16.count<=256 {
            throw BaroChartIngestionError(code:codeText,message:messageText)
        }
        throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Unknown JS error")
    }
    return value
}

/// 리팩터링 전 asterTypedBytes
private func legacyTypedBytes(_ value: JSValue, _ context: JSContext, count: Int) throws -> UnsafeMutableRawPointer {
    guard count > 0, count <= 262144 else {throw BaroChartAsyncError.invalidProtocol("Invalid copy count")}
    var exception: JSValueRef?
    let ctx = context.jsGlobalContextRef!
    guard JSValueGetTypedArrayType(ctx, value.jsValueRef, &exception) == kJSTypedArrayTypeFloat64Array,
          let object = JSValueToObject(ctx, value.jsValueRef, &exception) else {throw BaroChartAsyncError.invalidProtocol("Expected Float64Array")}
    let length = JSObjectGetTypedArrayLength(ctx, object, &exception)
    let byteLength = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
    let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
    guard let buffer = JSObjectGetTypedArrayBuffer(ctx, object, &exception) else {throw BaroChartAsyncError.invalidProtocol("Missing typed buffer")}
    let total = JSObjectGetArrayBufferByteLength(ctx, buffer, &exception)
    guard exception == nil, length == count, byteLength == count * MemoryLayout<Double>.size,
          offset <= total, byteLength <= total - offset, offset % MemoryLayout<Double>.size == 0 else {throw BaroChartAsyncError.invalidProtocol("Typed buffer bounds mismatch")}
    guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception), exception == nil else {throw BaroChartAsyncError.invalidProtocol("Unavailable typed bytes")}
    return pointer.advanced(by: offset)
}
