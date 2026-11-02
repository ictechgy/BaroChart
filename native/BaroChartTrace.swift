import Foundation
import JavaScriptCore
import CommonCrypto

// 테스트·디버그 전용 코어 호출 추적(설계 §6.5-1, §7.3, M0 Task 6).
// BaroChartEngine.traceDirectoryForTesting을 설정한 동안 새로 만드는 코어 런타임마다
// <디렉터리>/runtime-<n>.jsonl 파일 하나에 BCJSON(무손실 JSON 상위 집합, 설계 §4.2) 줄을 쓴다.
//   호출: {"fn":…,"args":[…],"ok":…} 또는 {"fn":…,"args":[…],"err":{"name":…,"message":…,"code":…}}
//   호스트 쓰기: {"write":{"view":k,"sha256":…,"data":"<base64 리틀엔디언 바이트>"}}
// 줄 형식과 값 글자는 Node 기록기(scripts/trace/record.mjs, bcjson.mjs)와 같다. 그래야 같은 세션의 추적을
// 어느 백엔드에든 재생해 결과를 바이트 단위로 비교할 수 있다. 설정하지 않으면 파일을 만들지 않는다.
// 기록이 호출을 바꾸면 안 되므로 값은 JSC C API로만 읽는다. 예외는 지역 출력 인자로 받아 JSContext.exception을
// 건드리지 않는다. 담을 수 없는 값을 만나면 그 런타임의 기록을 멈추고 옆 파일 <이름>.meta.json에 자리와 이유를 남긴다.

extension BaroChartEngine {
    /// 테스트 전용 내부 훅. 설정하면 그 뒤에 만드는 코어 런타임마다 이 디렉터리에 BCJSON 추적 파일
    /// `runtime-<n>.jsonl`을 쓴다(n은 1부터, 설정할 때마다 다시 센다). `nil`(기본값)이면 아무 파일도 만들지 않는다.
    static var traceDirectoryForTesting: URL? {
        get {BaroChartTraceSettings.directory}
        set {BaroChartTraceSettings.directory = newValue}
    }
}

/// 추적 설정과 런타임 번호. 작업 런타임이 다른 스레드에서 만들어지므로 잠금으로 지킨다.
enum BaroChartTraceSettings {
    /// 아래 상태를 지키는 잠금
    private static let lock = NSLock()
    /// 추적을 쓸 디렉터리. nil이면 꺼져 있다.
    private static var storedDirectory: URL?
    /// 마지막으로 붙인 런타임 번호
    private static var runtimeCount = 0
    /// 파일을 쓰지 못한 기록(테스트가 비어 있는지 확인한다)
    private static var storedFailures: [String] = []

    /// 추적 디렉터리. 새 디렉터리를 설정하면 런타임 번호와 실패 목록을 비운다. nil로 끄면 실패 목록은 남긴다.
    static var directory: URL? {
        get {lock.lock();defer {lock.unlock()};return storedDirectory}
        set {
            lock.lock();defer {lock.unlock()}
            storedDirectory = newValue
            if newValue != nil {runtimeCount = 0;storedFailures = []}
        }
    }

    /// 마지막 설정 뒤로 파일을 쓰지 못한 이유들. 비어 있어야 추적이 완전하다.
    static var failuresForTesting: [String] {lock.lock();defer {lock.unlock()};return storedFailures}

    /// 추적이 켜져 있으면 다음 번호의 기록기를 만든다. 런타임을 만든 직후 한 번 부른다.
    /// - Returns: 기록기. 꺼져 있거나 파일을 만들지 못하면 nil(실패는 failuresForTesting에 남는다)
    static func makeWriter() -> BaroChartTraceWriter? {
        lock.lock()
        guard let directory = storedDirectory else {lock.unlock();return nil}
        runtimeCount += 1
        let url = directory.appendingPathComponent("runtime-\(runtimeCount).jsonl")
        lock.unlock()
        return BaroChartTraceWriter(url: url)
    }

    /// 파일을 쓰지 못한 이유를 남긴다. 추적 실패가 엔진 호출을 실패시키면 안 되므로 던지지 않는다.
    /// - Parameter message: 원인과 경로를 담은 개발자용 문구
    static func recordFailure(_ message: String) {lock.lock();storedFailures.append(message);lock.unlock()}
}

/// BCJSON으로 쓸 수 없는 값. 기록기는 이 오류를 받으면 그 런타임의 기록을 멈춘다.
struct BaroChartTraceUnsupported: Error {
    /// 멈춘 이유(Node 기록기의 이유 낱말과 같은 뜻)
    let reason: String
}

/// 직전 호출이 돌려준 Float64Array 뷰. 호스트가 이 뷰에 쓰면 write 줄을 남긴다.
struct BaroChartTraceView {
    /// 뷰 객체(JSC 셀 포인터). 같은 객체인지 비교할 때만 쓴다.
    let reference: OpaquePointer
    /// 추적 안의 뷰 순번(결과에 나온 순서, 0부터)
    let index: Int
    /// 마지막으로 알려진 바이트의 sha256
    var sha256: String
}

/// 부르기 직전에 쓴 호출 머리. 인자는 코어가 바꾸기 전에 쓴다.
struct BaroChartTracePending {
    /// 함수 이름(멈춤 기록용)
    let name: String
    /// `{"fn":…,"args":…,` 까지의 줄 앞부분
    let head: String
}

/// 런타임 하나의 추적 파일. 소유 스레드와 작업 스레드가 차례로 쓸 수 있어 잠금으로 지킨다.
final class BaroChartTraceWriter {
    /// 아래 상태를 지키는 잠금
    private let lock = NSLock()
    /// 추적 파일 경로
    private let url: URL
    /// 열린 추적 파일. 멈추거나 쓰기에 실패하면 더 쓰지 않는다.
    private var handle: FileHandle?
    /// 쓴 줄 수(호출 줄과 쓰기 줄)
    private var lines = 0
    /// 다음 뷰 순번
    private var nextView = 0
    /// 직전 호출이 돌려준 맨 바깥 Float64Array 뷰
    private var lastView: BaroChartTraceView?
    /// 기록을 멈췄는지
    private var stopped = false

    /// 추적 파일을 새로 만든다(있으면 비운다).
    /// - Parameter url: `runtime-<n>.jsonl` 경로
    init?(url: URL) {
        self.url = url
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: url.path, contents: Data()) else {
                BaroChartTraceSettings.recordFailure("Trace file could not be created at \(url.path); check that the directory is writable")
                return nil
            }
            handle = try FileHandle(forWritingTo: url)
        } catch {
            BaroChartTraceSettings.recordFailure("Trace file could not be opened at \(url.path): \(error)")
            return nil
        }
    }

    deinit {
        do {try handle?.close()} catch {BaroChartTraceSettings.recordFailure("Trace file could not be closed at \(url.path): \(error)")}
    }

    /// 호출 직전에 부른다. 인자를 BCJSON으로 미리 쓴다.
    /// - Parameters:
    ///   - name: 전역 함수 이름
    ///   - arguments: 호스트가 넘기는 인자(JSC가 JS 값으로 바꾸는 것과 같은 규칙으로 쓴다)
    /// - Returns: 결과를 기록할 때 넘길 머리. 기록을 멈췄으면 nil
    func begin(_ name: String, _ arguments: [Any]) -> BaroChartTracePending? {
        lock.lock();defer {lock.unlock()}
        if stopped {return nil}
        // 호스트는 호출이 돌려준 뷰에 바로 쓴다. 다음 호출이 시작되면 이전 뷰에는 더 쓰지 않는다.
        lastView = nil
        do {
            let argumentsText = try BaroChartTraceEncoder.arguments(arguments)
            return BaroChartTracePending(name: name, head: "{\"fn\":\(BaroChartTraceEncoder.quoted(name)),\"args\":\(argumentsText),")
        } catch let unsupported as BaroChartTraceUnsupported {
            stop(name, "argument: \(unsupported.reason)")
        } catch {
            stop(name, "argument: \(error)")
        }
        return nil
    }

    /// 정상 반환을 기록한다. 결과의 Float64Array는 나온 순서대로 뷰 순번을 받는다.
    /// - Parameters:
    ///   - pending: begin이 돌려준 머리
    ///   - value: 결과 값
    ///   - context: 값을 만든 컨텍스트
    func finish(_ pending: BaroChartTracePending, returned value: JSValue, in context: JSContext) {
        lock.lock();defer {lock.unlock()}
        if stopped {return}
        do {
            var views: [(reference: OpaquePointer, sha256: String)] = []
            let text = try BaroChartTraceEncoder.value(value, in: context, views: &views)
            guard write(pending.head + "\"ok\":" + text + "}") else {return}
            // 호스트는 맨 바깥 결과가 뷰일 때만 그 뷰에 쓴다
            if let first = views.first, first.reference == value.jsValueRef {lastView = BaroChartTraceView(reference: first.reference, index: nextView, sha256: first.sha256)}
            nextView += views.count
        } catch let unsupported as BaroChartTraceUnsupported {
            stop(pending.name, "result: \(unsupported.reason)")
        } catch {
            stop(pending.name, "result: \(error)")
        }
    }

    /// 코어 예외를 err 레코드로 기록한다.
    /// - Parameters:
    ///   - pending: begin이 돌려준 머리
    ///   - exception: 던져진 값
    ///   - context: 예외가 난 컨텍스트
    func finish(_ pending: BaroChartTracePending, threw exception: JSValue, in context: JSContext) {
        lock.lock();defer {lock.unlock()}
        if stopped {return}
        do {
            _ = write(pending.head + "\"err\":" + (try BaroChartTraceEncoder.errorRecord(exception, in: context)) + "}")
        } catch let unsupported as BaroChartTraceUnsupported {
            stop(pending.name, "error: \(unsupported.reason)")
        } catch {
            stop(pending.name, "error: \(error)")
        }
    }

    /// 호스트가 직전 호출이 돌려준 뷰 전체를 덮어쓴 뒤 부른다. 내용이 바뀌었을 때만 write 줄을 쓴다(Node 기록기와 같다).
    /// - Parameters:
    ///   - view: 바이트를 쓴 뷰
    ///   - bytes: 쓴 바이트(리틀엔디언 f64)
    ///   - count: f64 원소 수
    func hostWrote(into view: JSValue, from bytes: UnsafeRawPointer, count: Int) {
        lock.lock();defer {lock.unlock()}
        if stopped {return}
        guard var last = lastView, last.reference == view.jsValueRef else {stop(nil, "write: view was not returned by the previous call");return}
        let byteCount = count * MemoryLayout<Double>.size, sha256 = BaroChartTraceEncoder.sha256(bytes, byteCount)
        if sha256 == last.sha256 {return}
        let data = Data(bytes: bytes, count: byteCount).base64EncodedString()
        guard write("{\"write\":{\"view\":\(last.index),\"sha256\":\"\(sha256)\",\"data\":\"\(data)\"}}") else {return}
        last.sha256 = sha256;lastView = last
    }

    /// 줄 하나를 덧붙인다. 테스트가 중간에 멈춰도 그때까지의 줄이 남도록 바로 쓴다.
    /// - Parameter text: BCJSON 줄(줄바꿈 없음)
    /// - Returns: 썼으면 true. 실패하면 기록을 멈추고 실패 목록에 남긴다.
    private func write(_ text: String) -> Bool {
        guard let handle = handle else {return false}
        do {
            try handle.write(contentsOf: Data((text + "\n").utf8))
            lines += 1
            return true
        } catch {
            BaroChartTraceSettings.recordFailure("Trace line could not be written to \(url.path): \(error)")
            stopped = true;self.handle = nil
            return false
        }
    }

    /// 기록을 멈추고 옆 파일 <이름>.meta.json에 멈춘 자리와 이유를 남긴다(Node 기록기의 stopped와 같은 모양).
    /// - Parameters:
    ///   - name: 멈춘 호출의 함수 이름(호출과 무관하면 nil)
    ///   - reason: 이유
    private func stop(_ name: String?, _ reason: String) {
        if stopped {return}
        stopped = true;lastView = nil
        let meta = url.deletingPathExtension().appendingPathExtension("meta.json")
        let text = "{\"stopped\":{\"line\":\(lines + 1),\"fn\":\(name.map(BaroChartTraceEncoder.quoted) ?? "null"),\"reason\":\(BaroChartTraceEncoder.quoted(reason))}}\n"
        do {try Data(text.utf8).write(to: meta)} catch {BaroChartTraceSettings.recordFailure("Trace stop could not be recorded at \(meta.path): \(error)")}
    }
}

/// BCJSON 글자 만들기. scripts/trace/bcjson.mjs의 stringifyLossless와 같은 글자를 낸다.
enum BaroChartTraceEncoder {
    /// 값 나무 깊이 상한. 코어 결과는 얕으므로 넘으면 순환이나 비정상 값으로 보고 기록을 멈춘다.
    private static let depthLimit = 512

    /// 호스트 인자 목록을 BCJSON 배열로 쓴다. JSC가 Objective-C 값을 JS 값으로 바꾸는 규칙을 따른다:
    /// NSNull은 null, CFBoolean은 불리언, 그 밖의 NSNumber는 doubleValue, NSString은 문자열, NSArray는 배열,
    /// NSDictionary는 문자열 키만 담은 객체, JSValue는 그 JS 값이다. 딕셔너리는 정해진 순서가 없어 키를 UTF-16 오름차순으로 쓴다.
    /// - Parameter arguments: 인자 목록
    /// - Returns: BCJSON 배열 글자
    /// - Throws: BaroChartTraceUnsupported(그 밖의 객체, 너무 깊은 값)
    static func arguments(_ arguments: [Any]) throws -> String {
        var output = "["
        for (index, argument) in arguments.enumerated() {
            if index > 0 {output += ","}
            try appendArgument(argument, to: &output, depth: 1)
        }
        return output + "]"
    }

    /// 호스트 인자 하나를 쓴다.
    private static func appendArgument(_ value: Any, to output: inout String, depth: Int) throws {
        guard depth <= depthLimit else {throw BaroChartTraceUnsupported(reason: "depth")}
        // Swift 값은 JSC로 넘어갈 때와 같은 브리징으로 Objective-C 객체가 된다(nil Optional은 NSNull).
        let object = value as AnyObject
        if object is NSNull {output += "null";return}
        if let number = object as? NSNumber {
            output += CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : Self.number(number.doubleValue)
            return
        }
        if let string = object as? NSString {output += quoted(string);return}
        if let javaScript = object as? JSValue {
            guard let context = javaScript.context else {throw BaroChartTraceUnsupported(reason: "detached JSValue")}
            var views: [(reference: OpaquePointer, sha256: String)] = []
            output += try Self.value(javaScript, in: context, views: &views)
            return
        }
        if let array = object as? NSArray {
            output += "["
            for (index, element) in array.enumerated() {
                if index > 0 {output += ","}
                try appendArgument(element, to: &output, depth: depth + 1)
            }
            output += "]"
            return
        }
        if let dictionary = object as? NSDictionary {
            var entries: [(key: NSString, value: Any)] = []
            for (key, element) in dictionary {if let key = key as? NSString {entries.append((key, element))}}
            entries.sort {units($0.key).lexicographicallyPrecedes(units($1.key))}
            output += "{"
            for (index, entry) in entries.enumerated() {
                if index > 0 {output += ","}
                output += quoted(entry.key) + ":"
                try appendArgument(entry.value, to: &output, depth: depth + 1)
            }
            output += "}"
            return
        }
        throw BaroChartTraceUnsupported(reason: "host value \(type(of: value))")
    }

    /// JS 값을 BCJSON으로 쓴다. 객체 키는 JS 자기 키 순서이고, Float64Array는 F64(<길이>,<sha256>)이다.
    /// - Parameters:
    ///   - value: 쓸 값
    ///   - context: 값을 만든 컨텍스트
    ///   - views: 출력 순서대로 받은 Float64Array(객체 포인터, 바이트 sha256)
    /// - Returns: BCJSON 글자
    /// - Throws: BaroChartTraceUnsupported(함수, 심볼, 다른 타입 배열, 순환, 평범하지 않은 프로토타입, 구멍)
    static func value(_ value: JSValue, in context: JSContext, views: inout [(reference: OpaquePointer, sha256: String)]) throws -> String {
        guard let ctx = context.jsGlobalContextRef else {throw BaroChartTraceUnsupported(reason: "context")}
        var state = JavaScriptState(context: ctx)
        var output = ""
        try appendJavaScript(value.jsValueRef, &state, to: &output, depth: 1)
        views = state.views
        return output
    }

    /// 던져진 값을 err 레코드 {name, message, code}로 쓴다. name과 message는 문자열이어야 하고
    /// code는 없거나 null·문자열·숫자·불리언이어야 한다(Node traceErrorRecord와 같은 규칙).
    /// - Parameters:
    ///   - exception: 던져진 값
    ///   - context: 예외가 난 컨텍스트
    /// - Returns: `{"name":…,"message":…,"code":…}` 글자(code가 없으면 undefined 토큰)
    /// - Throws: BaroChartTraceUnsupported(원시 값, 함수, 형식이 다른 필드)
    static func errorRecord(_ exception: JSValue, in context: JSContext) throws -> String {
        guard let ctx = context.jsGlobalContextRef else {throw BaroChartTraceUnsupported(reason: "context")}
        guard JSValueGetType(ctx, exception.jsValueRef) == kJSTypeObject else {throw BaroChartTraceUnsupported(reason: "primitive")}
        var exceptionRef: JSValueRef?
        guard let object = JSValueToObject(ctx, exception.jsValueRef, &exceptionRef), exceptionRef == nil else {throw BaroChartTraceUnsupported(reason: "primitive")}
        if JSObjectIsFunction(ctx, object) {throw BaroChartTraceUnsupported(reason: "function")}
        let name = try property(object, "name", ctx), message = try property(object, "message", ctx), code = try property(object, "code", ctx)
        guard JSValueGetType(ctx, name) == kJSTypeString, JSValueGetType(ctx, message) == kJSTypeString else {throw BaroChartTraceUnsupported(reason: "name or message")}
        let codeType = JSValueGetType(ctx, code)
        guard [kJSTypeUndefined, kJSTypeNull, kJSTypeString, kJSTypeNumber, kJSTypeBoolean].contains(codeType) else {throw BaroChartTraceUnsupported(reason: "code")}
        var state = JavaScriptState(context: ctx)
        var output = "{\"name\":"
        try appendJavaScript(name, &state, to: &output, depth: 1)
        output += ",\"message\":"
        try appendJavaScript(message, &state, to: &output, depth: 1)
        output += ",\"code\":"
        try appendJavaScript(code, &state, to: &output, depth: 1)
        return output + "}"
    }

    /// 한 번의 JS 값 쓰기 상태
    private struct JavaScriptState {
        /// JSC 전역 컨텍스트
        let context: JSGlobalContextRef
        /// 지금 열린 조상 객체(순환 검사)
        var ancestors = Set<OpaquePointer>()
        /// 출력 순서대로 만난 Float64Array
        var views: [(reference: OpaquePointer, sha256: String)] = []
        /// 이 realm의 %Object.prototype%과 %Array.prototype%(처음 객체를 만날 때 구한다)
        var prototypes: (object: JSValueRef, array: JSValueRef)?
    }

    /// JS 값 하나를 쓴다.
    private static func appendJavaScript(_ value: JSValueRef, _ state: inout JavaScriptState, to output: inout String, depth: Int) throws {
        guard depth <= depthLimit else {throw BaroChartTraceUnsupported(reason: "depth")}
        let ctx = state.context
        switch JSValueGetType(ctx, value) {
        case kJSTypeUndefined: output += "undefined"
        case kJSTypeNull: output += "null"
        case kJSTypeBoolean: output += JSValueToBoolean(ctx, value) ? "true" : "false"
        case kJSTypeNumber:
            var exception: JSValueRef?
            let number = JSValueToNumber(ctx, value, &exception)
            guard exception == nil else {throw BaroChartTraceUnsupported(reason: "number")}
            output += Self.number(number)
        case kJSTypeString:
            var exception: JSValueRef?
            guard let string = JSValueToStringCopy(ctx, value, &exception), exception == nil else {throw BaroChartTraceUnsupported(reason: "string")}
            defer {JSStringRelease(string)}
            output += quoted(string)
        case kJSTypeObject: try appendObject(value, &state, to: &output, depth: depth)
        default: throw BaroChartTraceUnsupported(reason: "symbol or bigint")
        }
    }

    /// 객체 하나를 쓴다. 배열은 인덱스 순서, 평범한 객체는 열거 가능한 자기 키 순서다.
    private static func appendObject(_ value: JSValueRef, _ state: inout JavaScriptState, to output: inout String, depth: Int) throws {
        let ctx = state.context
        var exception: JSValueRef?
        guard let object = JSValueToObject(ctx, value, &exception), exception == nil else {throw BaroChartTraceUnsupported(reason: "object")}
        if JSObjectIsFunction(ctx, object) {throw BaroChartTraceUnsupported(reason: "function")}
        let typedArray = JSValueGetTypedArrayType(ctx, value, &exception)
        guard exception == nil else {throw BaroChartTraceUnsupported(reason: "typed array")}
        if typedArray != kJSTypedArrayTypeNone {
            guard typedArray == kJSTypedArrayTypeFloat64Array else {throw BaroChartTraceUnsupported(reason: "typed array")}
            try appendFloat64(object, &state, to: &output)
            return
        }
        let identity = object
        guard !state.ancestors.contains(identity) else {throw BaroChartTraceUnsupported(reason: "cycle")}
        let isArray = JSValueIsArray(ctx, value)
        let prototypes = try realmPrototypes(&state)
        guard JSValueIsStrictEqual(ctx, JSObjectGetPrototype(ctx, object), isArray ? prototypes.array : prototypes.object) else {throw BaroChartTraceUnsupported(reason: "prototype")}
        state.ancestors.insert(identity);defer {state.ancestors.remove(identity)}
        let names = JSObjectCopyPropertyNames(ctx, object)
        defer {JSPropertyNameArrayRelease(names)}
        let count = JSPropertyNameArrayGetCount(names)
        if isArray {
            let length = try property(object, "length", ctx)
            guard JSValueGetType(ctx, length) == kJSTypeNumber, JSValueToNumber(ctx, length, nil) == Double(count) else {throw BaroChartTraceUnsupported(reason: "hole or extra property")}
            output += "["
            for index in 0..<count {
                // 열거 가능한 키가 정확히 0..length-1이어야 구멍이나 덧붙은 속성이 없다
                guard let name = JSPropertyNameArrayGetNameAtIndex(names, index), JSStringIsEqualToUTF8CString(name, String(index)) else {throw BaroChartTraceUnsupported(reason: "hole or extra property")}
                if index > 0 {output += ","}
                let element = JSObjectGetPropertyAtIndex(ctx, object, UInt32(index), &exception)
                guard let element = element, exception == nil else {throw BaroChartTraceUnsupported(reason: "element")}
                try appendJavaScript(element, &state, to: &output, depth: depth + 1)
            }
            output += "]"
            return
        }
        output += "{"
        for index in 0..<count {
            guard let name = JSPropertyNameArrayGetNameAtIndex(names, index) else {throw BaroChartTraceUnsupported(reason: "property name")}
            let member = JSObjectGetProperty(ctx, object, name, &exception)
            guard let member = member, exception == nil else {throw BaroChartTraceUnsupported(reason: "property")}
            if index > 0 {output += ","}
            output += quoted(name) + ":"
            try appendJavaScript(member, &state, to: &output, depth: depth + 1)
        }
        output += "}"
    }

    /// Float64Array를 F64(<길이>,<리틀엔디언 바이트 sha256>)로 쓰고 뷰 목록에 더한다.
    private static func appendFloat64(_ object: JSObjectRef, _ state: inout JavaScriptState, to output: inout String) throws {
        let ctx = state.context
        var exception: JSValueRef?
        let length = JSObjectGetTypedArrayLength(ctx, object, &exception)
        let byteLength = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
        let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
        guard exception == nil else {throw BaroChartTraceUnsupported(reason: "typed array bounds")}
        var sha256 = Self.sha256(nil, 0)
        if byteLength > 0 {
            // 포인터는 뷰가 아니라 버퍼 시작을 가리킨다(asterTypedBytes와 같은 계약). 다른 JSC 호출 전에 해시한다.
            guard let base = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception), exception == nil else {throw BaroChartTraceUnsupported(reason: "typed array bytes")}
            sha256 = Self.sha256(UnsafeRawPointer(base.advanced(by: offset)), byteLength)
        }
        output += "F64(\(length),\(sha256))"
        state.views.append((object, sha256))
    }

    /// 이 realm의 평범한 객체·배열 프로토타입. 새 객체로 구하므로 테스트가 전역 Object·Array를 바꿔도 내장값이다.
    private static func realmPrototypes(_ state: inout JavaScriptState) throws -> (object: JSValueRef, array: JSValueRef) {
        if let prototypes = state.prototypes {return prototypes}
        let ctx = state.context
        var exception: JSValueRef?
        let plain = JSObjectMake(ctx, nil, nil), array = JSObjectMakeArray(ctx, 0, nil, &exception)
        guard let plain = plain, let array = array, exception == nil,
              let objectPrototype = JSObjectGetPrototype(ctx, plain), let arrayPrototype = JSObjectGetPrototype(ctx, array) else {throw BaroChartTraceUnsupported(reason: "realm")}
        state.prototypes = (objectPrototype, arrayPrototype)
        return (objectPrototype, arrayPrototype)
    }

    /// 객체 속성 하나를 읽는다(예외는 지역 출력 인자로 받는다).
    private static func property(_ object: JSObjectRef, _ name: String, _ ctx: JSContextRef) throws -> JSValueRef {
        let key = JSStringCreateWithUTF8CString(name)
        defer {JSStringRelease(key)}
        var exception: JSValueRef?
        guard let value = JSObjectGetProperty(ctx, object, key, &exception), exception == nil else {throw BaroChartTraceUnsupported(reason: "property \(name)")}
        return value
    }

    /// 숫자를 BCJSON 글자로 바꾼다. 유한한 수는 JS Number#toString과 같고, -0과 비유한 수는 토큰이다.
    /// Swift의 Double 설명은 왕복하는 가장 짧은(가장 가까운) 십진 자릿수를 주므로, 그 자릿수를 ECMAScript
    /// Number::toString 규칙(지수 21 이상·-7 이하는 지수 표기)에 맞춰 다시 배치한다.
    /// - Parameter value: 숫자
    /// - Returns: 숫자 토큰
    static func number(_ value: Double) -> String {
        if value.isNaN {return "NaN"}
        if value.isInfinite {return value < 0 ? "-Infinity" : "Infinity"}
        if value == 0 {return value.sign == .minus ? "-0" : "0"}
        let (digits, exponent) = shortestDigits(value.magnitude)
        return (value < 0 ? "-" : "") + ecmaScriptLayout(digits, exponent)
    }

    /// 0이 아닌 유한한 양수의 가장 짧은 십진 자릿수와 지수 n(값 = 0.자릿수 × 10^n)을 구한다.
    private static func shortestDigits(_ value: Double) -> (digits: [Character], exponent: Int) {
        let text = "\(value)"
        let parts = text.split(separator: "e", maxSplits: 1, omittingEmptySubsequences: false)
        let mantissa = parts[0], power = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let pieces = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let integer = pieces[0], fraction = pieces.count > 1 ? pieces[1] : ""
        var digits = Array(integer + fraction), exponent = integer.count + power
        while digits.first == "0" {digits.removeFirst();exponent -= 1}
        while digits.last == "0" {digits.removeLast()}
        return (digits, exponent)
    }

    /// ECMAScript Number::toString(10)의 배치 규칙. k = 자릿수 수, n = 지수.
    private static func ecmaScriptLayout(_ digits: [Character], _ exponent: Int) -> String {
        let count = digits.count
        if count <= exponent && exponent <= 21 {return String(digits) + String(repeating: "0", count: exponent - count)}
        if 0 < exponent && exponent <= 21 {return String(digits[..<exponent]) + "." + String(digits[exponent...])}
        if -6 < exponent && exponent <= 0 {return "0." + String(repeating: "0", count: -exponent) + String(digits)}
        let power = exponent - 1, sign = power < 0 ? "-" : "+"
        let lead = count == 1 ? String(digits) : String(digits[0]) + "." + String(digits[1...])
        return lead + "e" + sign + String(abs(power))
    }

    /// Swift 문자열을 JSON.stringify와 같은 글자로 쓴다.
    static func quoted(_ text: String) -> String {quoted(Array(text.utf16))}

    /// NSString을 UTF-16 코드 단위 그대로(단독 서로게이트 포함) 따옴표 글자로 쓴다.
    static func quoted(_ text: NSString) -> String {quoted(units(text))}

    /// JSC 문자열을 UTF-16 코드 단위 그대로 따옴표 글자로 쓴다.
    private static func quoted(_ text: JSStringRef) -> String {
        let length = JSStringGetLength(text)
        guard length > 0, let characters = JSStringGetCharactersPtr(text) else {return "\"\""}
        return quoted(Array(UnsafeBufferPointer(start: characters, count: length)))
    }

    /// NSString의 UTF-16 코드 단위
    private static func units(_ text: NSString) -> [UInt16] {
        var buffer = [UInt16](repeating: 0, count: text.length)
        if !buffer.isEmpty {text.getCharacters(&buffer, range: NSRange(location: 0, length: text.length))}
        return buffer
    }

    /// UTF-16 코드 단위를 JSON.stringify(ES2019 이후) 규칙으로 따옴표 글자로 쓴다.
    /// 짧은 이스케이프(\b \t \n \f \r \" \\), 나머지 제어 문자는 \u00xx, 단독 서로게이트는 \udxxx(16진 소문자)다.
    private static func quoted(_ units: [UInt16]) -> String {
        var result: [UInt16] = [0x22]
        result.reserveCapacity(units.count + 2)
        func escape(_ unit: UInt16) {
            let hex = String(unit, radix: 16)
            result.append(contentsOf: Array(("\\u" + String(repeating: "0", count: 4 - hex.count) + hex).utf16))
        }
        var index = 0
        while index < units.count {
            let unit = units[index]
            index += 1
            switch unit {
            case 0x22: result.append(contentsOf: [0x5C, 0x22])
            case 0x5C: result.append(contentsOf: [0x5C, 0x5C])
            case 0x08: result.append(contentsOf: [0x5C, 0x62])
            case 0x09: result.append(contentsOf: [0x5C, 0x74])
            case 0x0A: result.append(contentsOf: [0x5C, 0x6E])
            case 0x0C: result.append(contentsOf: [0x5C, 0x66])
            case 0x0D: result.append(contentsOf: [0x5C, 0x72])
            case 0..<0x20: escape(unit)
            case 0xD800...0xDBFF:
                if index < units.count, (0xDC00...0xDFFF).contains(units[index]) {result.append(unit);result.append(units[index]);index += 1}
                else {escape(unit)}
            case 0xDC00...0xDFFF: escape(unit)
            default: result.append(unit)
            }
        }
        result.append(0x22)
        return String(decoding: result, as: UTF16.self)
    }

    /// 바이트의 sha256 16진 소문자
    /// - Parameters:
    ///   - bytes: 해시할 바이트(count가 0이면 nil이어도 된다)
    ///   - count: 바이트 수
    /// - Returns: 64자 16진 문자열
    static func sha256(_ bytes: UnsafeRawPointer?, _ count: Int) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        let empty: [UInt8] = []
        if let bytes = bytes, count > 0 {_ = CC_SHA256(bytes, CC_LONG(count), &digest)}
        else {empty.withUnsafeBytes {_ = CC_SHA256($0.baseAddress, 0, &digest)}}
        return digest.map {String(format: "%02x", $0)}.joined()
    }
}

/// M0 Task 6 1단계: 이음새를 넣기 전 구조(asterInvoke·call·전용 경로)에 넣는 최소 기록 훅.
/// JSContext마다 기록기를 연관 객체로 붙여 두고, 코어 함수를 부르는 자리와 호스트가 뷰에 쓰는 자리에서 부른다.
/// 이음새 리팩터링 뒤에는 BaroChartRecordingCoreRuntime이 같은 기록기로 같은 줄을 쓴다.
enum BaroChartTraceHooks {
    /// 연관 객체 키(주소만 쓴다)
    private static let key = UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)

    /// 새로 만든 컨텍스트에 추적이 켜져 있으면 기록기를 붙인다.
    /// - Parameter context: 방금 만든 JSContext
    static func attach(_ context: JSContext) {
        guard let writer = BaroChartTraceSettings.makeWriter() else {return}
        objc_setAssociatedObject(context, key, writer, .OBJC_ASSOCIATION_RETAIN)
    }

    /// 코어 함수를 부르기 직전에 인자를 쓴다.
    /// - Returns: 기록기와 머리. 추적이 꺼져 있으면 nil
    static func begin(_ context: JSContext, _ name: String, _ arguments: [Any]) -> (writer: BaroChartTraceWriter, pending: BaroChartTracePending)? {
        guard let writer = objc_getAssociatedObject(context, key) as? BaroChartTraceWriter, let pending = writer.begin(name, arguments) else {return nil}
        return (writer, pending)
    }

    /// 코어 함수가 돌아온 직전에(예외 처리 전에) 결과나 예외를 쓴다.
    static func end(_ trace: (writer: BaroChartTraceWriter, pending: BaroChartTracePending)?, _ context: JSContext, _ value: JSValue) {
        guard let trace = trace else {return}
        if let exception = context.exception {trace.writer.finish(trace.pending, threw: exception, in: context)}
        else {trace.writer.finish(trace.pending, returned: value, in: context)}
    }

    /// 호스트가 직전 결과 뷰에 바이트를 쓴 뒤 부른다.
    static func hostWrote(_ context: JSContext, _ view: JSValue, _ bytes: UnsafeRawPointer, _ count: Int) {
        (objc_getAssociatedObject(context, key) as? BaroChartTraceWriter)?.hostWrote(into: view, from: bytes, count: count)
    }
}
