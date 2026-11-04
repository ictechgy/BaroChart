import Foundation
import JavaScriptCore

// 코어 백엔드 이음새(설계 §4.1, §4.3, M0 Task 6). 엔진의 비공개 경로는 JSContext·JSValue를 직접 만지지 않고
// 이 파일의 BaroChartCoreRuntime으로만 코어를 부른다. M0에는 JS 구현(BaroChartJSCoreRuntime)만 있고, M1에서 Rust 구현이 같은
// 프로토콜을 따른다. JS 구현은 이전 asterInvoke·asterTypedBytes+memcpy 본문을 그대로 옮겼다: JSC 호출 순서, 예외 검사,
// 오류 문구가 같고, autorelease 풀은 지금처럼 엔진 쪽 호출 자리에 둔다.

/// Internal spelling retained for the runtime seam and existing conformance fixtures.
typealias BaroChartRuntimeBackend = BaroChartBackend

/// 코어 함수 한 번을 부른 날것의 결과. 호스트 오류로 바꾸기 전 단계라, 오류를 바꾸는 규칙이 다른 호출 자리(asterInvoke, 공개 call,
/// 전용 경로)가 각자 규칙을 적용하고 추적 기록기가 같은 결과를 그대로 볼 수 있다.
enum BaroChartCoreOutcome {
    /// 그 이름의 전역이 없거나 undefined다(코어를 부르지 않았다).
    case missing
    /// 호스트 인자 검사에서 거절됨(코어를 부르지 않았다).
    case rejected(Error)
    /// 정상 반환한 값
    case returned(BaroChartCoreValue)
    /// 코어가 던진 값(예외는 이미 지웠다)
    case threw(BaroChartCoreValue)
}

/// Swift 값 컨테이너는 Objective-C로 재귀 브리징하기 전에 한 단계씩 읽는다.
private protocol BaroChartArgumentContainer {
    var argumentReference: AnyObject? {get}
    func argumentChildren() -> AnyIterator<Any>
}
private extension BaroChartArgumentContainer {var argumentReference: AnyObject? {nil}}
extension Array: BaroChartArgumentContainer {
    fileprivate func argumentChildren() -> AnyIterator<Any> {
        var iterator = makeIterator()
        return AnyIterator {iterator.next().map {$0 as Any}}
    }
}
extension Dictionary: BaroChartArgumentContainer {
    fileprivate func argumentChildren() -> AnyIterator<Any> {
        var iterator = makeIterator()
        return AnyIterator {iterator.next().map {$0.value as Any}}
    }
}
extension NSArray: BaroChartArgumentContainer {
    fileprivate var argumentReference: AnyObject? {self}
    fileprivate func argumentChildren() -> AnyIterator<Any> {
        var index = 0
        return AnyIterator {
            guard index < self.count else {return nil}
            defer {index += 1}
            return self.object(at: index)
        }
    }
}
extension NSDictionary: BaroChartArgumentContainer {
    fileprivate var argumentReference: AnyObject? {self}
    fileprivate func argumentChildren() -> AnyIterator<Any> {
        let iterator = objectEnumerator()
        return AnyIterator {iterator.nextObject()}
    }
}
private protocol BaroChartArgumentOptional {var argumentValue: Any? {get}}
extension Optional: BaroChartArgumentOptional {
    fileprivate var argumentValue: Any? {map {$0 as Any}}
}

/// 값으로 브리징하는 호스트 배열·딕셔너리를 검사한다. 이미 VM 안에 있는 JSValue·JSExport 참조는 읽지 않는다.
/// 인자 배열이 깊이 1이다. 반복형 DFS와 참조 컨테이너 높이 메모로 순환·공유 부분 트리를 다룬다.
enum BaroChartArgumentDepth {
    private struct Frame {
        var children: AnyIterator<Any>
        let depth: Int
        let reference: AnyObject?
        var height = 1
    }

    private static func container(_ value: Any) -> BaroChartArgumentContainer? {
        var current = value
        while let optional = current as? BaroChartArgumentOptional {
            guard let unwrapped = optional.argumentValue else {return nil}
            current = unwrapped
        }
        return current as? BaroChartArgumentContainer
    }

    static func rejection(for arguments: [Any]) -> BaroChartLowLevelError? {
        var frames = [Frame(children: arguments.argumentChildren(), depth: 1, reference: nil)]
        var active = Set<ObjectIdentifier>()
        // 참조도 보유해 순회 중 주소 재사용을 같은 컨테이너로 오인하지 않는다.
        var completed: [ObjectIdentifier: (owner: AnyObject, height: Int)] = [:]
        defer {withExtendedLifetime(completed) {}}
        while !frames.isEmpty {
            let last = frames.count - 1
            guard let value = frames[last].children.next() else {
                let done = frames.removeLast()
                if let reference = done.reference {
                    let id = ObjectIdentifier(reference)
                    active.remove(id);completed[id] = (reference, done.height)
                }
                if !frames.isEmpty {frames[frames.count - 1].height = max(frames[frames.count - 1].height, done.height + 1)}
                continue
            }
            guard let child = container(value) else {continue}
            let depth = frames[last].depth + 1, reference = child.argumentReference
            guard depth <= 64 else {return .javaScript("SyntaxError: Native argument depth limit")}
            if let reference = reference {
                let id = ObjectIdentifier(reference)
                if active.contains(id) {return .javaScript("SyntaxError: Native argument depth limit")}
                if let height = completed[id]?.height {
                    guard depth + height - 1 <= 64 else {return .javaScript("SyntaxError: Native argument depth limit")}
                    frames[last].height = max(frames[last].height, height + 1)
                    continue
                }
                active.insert(id)
            }
            frames.append(Frame(children: child.argumentChildren(), depth: depth, reference: reference))
        }
        return nil
    }
}

/// 백엔드 중립 결과 값. 엔진이 코어 결과에 쓰던 JSValue 멤버와 이름·의미가 같은 접근자만 둔다.
/// M0의 JS 백엔드는 JSValue와 그 값을 만든 컨텍스트를 그대로 담고, 접근자는 JSValue에 그대로 넘긴다(같은 JSC 호출).
struct BaroChartCoreValue {
    /// JS 백엔드 값. 공개 API(call, command)가 JSValue를 돌려줄 때와 추적 기록기가 값을 읽을 때만 쓴다.
    let javaScriptValue: JSValue
    /// 값을 만든 컨텍스트(이전 asterTypedBytes가 받던 컨텍스트와 같다)
    let javaScriptContext: JSContext

    /// JS undefined인지
    var isUndefined: Bool {javaScriptValue.isUndefined}
    /// JS null인지
    var isNull: Bool {javaScriptValue.isNull}
    /// JS 불리언인지
    var isBoolean: Bool {javaScriptValue.isBoolean}
    /// JS 숫자인지
    var isNumber: Bool {javaScriptValue.isNumber}
    /// JS 문자열인지
    var isString: Bool {javaScriptValue.isString}
    /// JS 객체인지(배열·함수 포함)
    var isObject: Bool {javaScriptValue.isObject}
    /// JS 배열인지
    var isArray: Bool {javaScriptValue.isArray}
    /// JS ToBoolean
    func toBool() -> Bool {javaScriptValue.toBool()}
    /// JS ToNumber
    func toDouble() -> Double {javaScriptValue.toDouble()}
    /// JS ToInt32
    func toInt32() -> Int32 {javaScriptValue.toInt32()}
    /// JS ToString. 변환이 실패하면 nil이다.
    func toString() -> String? {javaScriptValue.toString()}
    /// JSValue.toDictionary와 같은 변환(undefined 키는 빠지고 null은 NSNull). 객체가 아니면 nil이다.
    func toDictionary() -> [AnyHashable: Any]? {javaScriptValue.toDictionary()}
    /// JSValue.toArray와 같은 변환. 배열로 바꿀 수 없으면 nil이다.
    func toArray() -> [Any]? {javaScriptValue.toArray()}
    /// 속성 하나를 읽는다(JSValue.forProperty와 같다).
    /// - Parameter property: 속성 이름
    /// - Returns: 속성 값. JSC가 값을 만들지 못하면 nil
    func forProperty(_ property: String) -> BaroChartCoreValue? {
        javaScriptValue.forProperty(property).map {BaroChartCoreValue(javaScriptValue: $0, javaScriptContext: javaScriptContext)}
    }

    /// 이 값이 count개 원소의 Float64Array이면 그 바이트를 가리키는 임시 포인터로 body를 부른다(이전 asterTypedBytes 본문).
    /// 포인터는 뷰가 아니라 버퍼 시작에 오프셋을 더한 것이다. body 안에서는 JSC를 다시 부르지 않는다
    /// (WebKit JSTypedArray.cpp와 SDK JSTypedArray.h의 수명 계약: 모든 JSC 호출은 포인터를 얻기 전에 끝낸다).
    /// - Parameters:
    ///   - count: 기대하는 원소 수(1...262144)
    ///   - body: 바이트를 옮기는 클로저
    /// - Returns: body의 결과
    /// - Throws: BaroChartAsyncError.invalidProtocol(개수, 타입, 경계가 맞지 않음), body의 오류
    func withFloat64Bytes<Output>(count: Int, _ body: (UnsafeMutableRawPointer) throws -> Output) throws -> Output {
        guard count > 0, count <= 262144 else {throw BaroChartAsyncError.invalidProtocol("Invalid copy count")}
        var exception: JSValueRef?
        let ctx = javaScriptContext.jsGlobalContextRef!
        guard JSValueGetTypedArrayType(ctx, javaScriptValue.jsValueRef, &exception) == kJSTypedArrayTypeFloat64Array,
              let object = JSValueToObject(ctx, javaScriptValue.jsValueRef, &exception) else {throw BaroChartAsyncError.invalidProtocol("Expected Float64Array")}
        let length = JSObjectGetTypedArrayLength(ctx, object, &exception)
        let byteLength = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
        let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
        guard let buffer = JSObjectGetTypedArrayBuffer(ctx, object, &exception) else {throw BaroChartAsyncError.invalidProtocol("Missing typed buffer")}
        let total = JSObjectGetArrayBufferByteLength(ctx, buffer, &exception)
        guard exception == nil, length == count, byteLength == count * MemoryLayout<Double>.size,
              offset <= total, byteLength <= total - offset, offset % MemoryLayout<Double>.size == 0 else {throw BaroChartAsyncError.invalidProtocol("Typed buffer bounds mismatch")}
        guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception), exception == nil else {throw BaroChartAsyncError.invalidProtocol("Unavailable typed bytes")}
        return try body(pointer.advanced(by: offset))
    }
}

/// 코어 백엔드 하나에 대한 호출 이음새. 엔진 소유 스레드(또는 작업 워커가 소유한 대상 런타임)에서만 부른다.
/// 런타임 객체 하나가 코어 실행 환경 하나(JS 백엔드는 JSContext 하나)를 소유한다. 엔진·작업·정리 기록은 이 객체를
/// 지금 JSContext를 담던 자리에 그대로 담고 `===`로 비교하므로, 한 실행 환경에 감싸개를 둘 만들면 안 된다.
protocol BaroChartCoreRuntime: AnyObject {
    /// 이 런타임의 백엔드
    var backend: BaroChartRuntimeBackend { get }
    /// 그 이름의 전역이 정의돼 있는지(이전 `objectForKeyedSubscript(name)?.isUndefined == false` 검사). 코어를 부르지 않는다.
    func supports(_ name: String) -> Bool
    /// 코어 함수를 부르고 이전 asterInvoke 규칙으로 오류를 바꾼다(기본 구현).
    func invoke(_ name: String, _ arguments: [Any]) throws -> BaroChartCoreValue
    /// 코어가 돌려준 count개 원소의 Float64Array를 destination으로 복사한다(기본 구현).
    func readFloat64(_ name: String, _ arguments: [Any], into destination: UnsafeMutableRawPointer, count: Int) throws
    /// 코어가 돌려준 count개 원소의 Float64Array에 source를 복사한다(기본 구현).
    func writeFloat64(_ name: String, _ arguments: [Any], from source: UnsafeRawPointer, count: Int) throws
    /// Returns the target view's old bytes while performing one typed write. The synchronous callback must not retain its pointer.
    func writeFloat64Snapshot(_ name: String, _ arguments: [Any], from source: UnsafeRawPointer, count: Int, before: (UnsafeRawPointer?, Int) -> Void) throws
    /// 알려진 native F64 read 결과 전체를 한 번 호출해 빌린다. false면 이름을 처리하지 않았고 호출도 하지 않았다.
    func readFloat64Snapshot(_ name: String, _ arguments: [Any], consume: (UnsafeRawPointer?, Int) throws -> Void) throws -> Bool
    /// Rust가 C ABI typed slice로 직접 처리하는 read 이름인지 나타낸다.
    func usesNativeFloat64Read(_ name: String) -> Bool
    /// Rust가 C ABI typed target으로 직접 처리하는 write 이름인지 나타낸다.
    func usesNativeFloat64Write(_ name: String) -> Bool
    /// 코어 함수를 한 번 부르고 날것의 결과를 돌려준다. 오류를 바꾸지 않는다.
    func perform(_ name: String, _ arguments: [Any]) -> BaroChartCoreOutcome
    /// 결과 변환(toDictionary 등) 중에 생긴 대기 예외를 꺼내고 지운다. 없으면 nil이다.
    func takeException() -> BaroChartCoreValue?
    /// 직전 native typed transfer가 받은 원래 JavaScript 예외다. 공개 오류 매핑 전 추적용이다.
    func takeTypedException() -> BaroChartCoreValue?
    /// 번들 원문을 평가하고 대기 예외를 꺼낸다(없으면 nil). 엔진 생성과 격리 런타임 준비에서 한 번 부른다.
    func evaluateBundle(_ source: String) -> BaroChartCoreValue?
    /// 공개 `context` 속성이 돌려줄 JSContext(M0의 JS 백엔드 전용).
    var javaScriptContext: JSContext { get }
}

extension BaroChartCoreRuntime {
    func takeTypedException() -> BaroChartCoreValue? {nil}
    func usesNativeFloat64Read(_ name: String) -> Bool {false}
    func usesNativeFloat64Write(_ name: String) -> Bool {false}
    func readFloat64Snapshot(_ name: String, _ arguments: [Any], consume: (UnsafeRawPointer?, Int) throws -> Void) throws -> Bool {false}

    /// 이전 asterInvoke 본문: 함수가 없으면 "Missing function: <이름>", 코어 IngestionError는 안정 코드 오류로, 나머지 예외는 "Name: message" 문구로 던진다.
    /// 예외는 perform이 이미 지웠고, 속성 읽기 순서(name → code → message → toString)도 이전과 같다.
    /// - Parameters:
    ///   - name: 전역 함수 이름
    ///   - arguments: 인자
    /// - Returns: 결과 값
    /// - Throws: BaroChartLowLevelError.javaScript, BaroChartIngestionError
    func invoke(_ name: String, _ arguments: [Any]) throws -> BaroChartCoreValue {
        switch perform(name, arguments) {
        case .missing: throw BaroChartLowLevelError.javaScript("Missing function: \(name)")
        case .rejected(let error): throw error
        case .returned(let value): return value
        case .threw(let exception):
            // Async begin/lease failures retain the same stable queue error code.
            // Other protocol exceptions preserve the existing generic boundary.
            if exception.forProperty("name")?.toString()=="IngestionError",let code=exception.forProperty("code"),code.isString,let codeText=code.toString(),!codeText.isEmpty,codeText.utf16.count<=64,let message=exception.forProperty("message"),message.isString,let messageText=message.toString(),messageText.utf16.count<=256 {
                throw BaroChartIngestionError(code:codeText,message:messageText)
            }
            throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Unknown JS error")
        }
    }

    /// invoke 뒤 결과 뷰의 바이트를 destination으로 옮긴다(이전 asterTypedBytes + memcpy).
    func readFloat64(_ name: String, _ arguments: [Any], into destination: UnsafeMutableRawPointer, count: Int) throws {
        try invoke(name, arguments).withFloat64Bytes(count: count) {_ = memcpy(destination, $0, count * MemoryLayout<Double>.size)}
    }

    /// invoke 뒤 결과 뷰에 source 바이트를 옮긴다(이전 asterTypedBytes + memcpy).
    func writeFloat64(_ name: String, _ arguments: [Any], from source: UnsafeRawPointer, count: Int) throws {
        _ = try writeFloat64View(name, arguments, from: source, count: count)
    }

    /// JS implementation of the snapshot seam: expose the real target bytes immediately before memcpy.
    func writeFloat64Snapshot(_ name: String, _ arguments: [Any], from source: UnsafeRawPointer, count: Int, before: (UnsafeRawPointer?, Int) -> Void) throws {
        let view = try invoke(name, arguments)
        try view.withFloat64Bytes(count: count) {target in
            before(UnsafeRawPointer(target), count)
            _ = memcpy(target, source, count * MemoryLayout<Double>.size)
        }
    }

    /// writeFloat64 본문. 바이트를 옮긴 뷰를 돌려준다(추적 기록기가 쓰기 줄의 뷰를 찾을 때 쓴다).
    func writeFloat64View(_ name: String, _ arguments: [Any], from source: UnsafeRawPointer, count: Int) throws -> BaroChartCoreValue {
        let view = try invoke(name, arguments)
        try view.withFloat64Bytes(count: count) {_ = memcpy($0, source, count * MemoryLayout<Double>.size)}
        return view
    }

    /// readFloat64로 count개 원소를 새 Data에 담는다. 개수 검사와 그 오류는 이전처럼 코어 호출 뒤 readFloat64가 한다.
    /// - Returns: count × 8바이트(리틀엔디언 f64)
    func readFloat64Data(_ name: String, _ arguments: [Any], count: Int) throws -> Data {
        guard count > 0, count <= 262144 else {
            // 잘못된 개수는 복사 전에 거절되므로 빈 자리만 넘긴다
            var placeholder: Double = 0
            try withUnsafeMutableBytes(of: &placeholder) {try readFloat64(name, arguments, into: $0.baseAddress!, count: count)}
            return Data()
        }
        var data = Data(count: count * MemoryLayout<Double>.size)
        try data.withUnsafeMutableBytes {try readFloat64(name, arguments, into: $0.baseAddress!, count: count)}
        return data
    }
}

/// Native typed payloads are observed only after Core returns. Both traced and untraced Rust
/// paths use this validator so host count errors cannot move ahead of a Core result or exception.
enum BaroChartFloat64Transfer {
    static func validate(hostCount: Int, actualCount: Int) throws {
        guard hostCount > 0, hostCount <= 262144 else {
            throw BaroChartAsyncError.invalidProtocol("Invalid copy count")
        }
        guard actualCount == hostCount else {
            throw BaroChartAsyncError.invalidProtocol("Typed buffer bounds mismatch")
        }
    }

    static func copyRead(
        _ source: UnsafeRawPointer?,
        actualCount: Int,
        into destination: UnsafeMutableRawPointer,
        hostCount: Int
    ) throws {
        try validate(hostCount: hostCount, actualCount: actualCount)
        guard let source else {
            throw BaroChartAsyncError.invalidProtocol("Missing native F64 snapshot bytes")
        }
        memcpy(destination, source, hostCount * MemoryLayout<Double>.size)
    }
}

/// JavaScriptCore 백엔드. JSContext 하나를 소유하며, 그 컨텍스트에 평가한 번들의 전역 함수를 부른다.
final class BaroChartJSCoreRuntime: BaroChartCoreRuntime {
    /// 이 런타임의 백엔드
    let backend = BaroChartRuntimeBackend.javaScript
    /// 소유한 컨텍스트(런타임이 사라질 때 함께 놓는다)
    let javaScriptContext: JSContext

    /// 이미 만든 컨텍스트를 감싼다. 컨텍스트 하나에 한 번만 부른다.
    /// - Parameter context: 이 런타임이 소유할 컨텍스트
    init(context: JSContext) {javaScriptContext = context}

    /// 그 이름의 전역이 정의돼 있는지(이전 objectForKeyedSubscript 존재 검사와 같다)
    func supports(_ name: String) -> Bool {javaScriptContext.objectForKeyedSubscript(name)?.isUndefined == false}

    /// 이전 asterInvoke와 공개 call의 앞부분: 전역을 찾아 부르고, 예외가 있으면 지운 뒤 던진 값을 돌려준다.
    func perform(_ name: String, _ arguments: [Any]) -> BaroChartCoreOutcome {
        if let error = BaroChartArgumentDepth.rejection(for: arguments) {return .rejected(error)}
        guard let function = javaScriptContext.objectForKeyedSubscript(name), !function.isUndefined,
              let value = function.call(withArguments: arguments) else {return .missing}
        if let exception = takeException() {return .threw(exception)}
        return .returned(BaroChartCoreValue(javaScriptValue: value, javaScriptContext: javaScriptContext))
    }

    /// 대기 예외를 꺼내고 지운다.
    func takeException() -> BaroChartCoreValue? {
        guard let exception = javaScriptContext.exception else {return nil}
        javaScriptContext.exception = nil
        return BaroChartCoreValue(javaScriptValue: exception, javaScriptContext: javaScriptContext)
    }

    /// 번들을 평가하고 대기 예외를 꺼낸다.
    func evaluateBundle(_ source: String) -> BaroChartCoreValue? {
        javaScriptContext.evaluateScript(source)
        return takeException()
    }
}

/// 런타임 생성 일원화. 추적이 켜져 있으면(BaroChartEngine.traceDirectoryForTesting) 만든 런타임을 기록 런타임으로 감싼다.
/// 번들 평가는 호출 자리가 evaluateBundle로 한다. 자리마다 평가 전에 할 일(복원 작업은 평가 전에 런타임을 소유 칸에 담는다)과
/// 실패 문구("Bundle error", "Workspace bundle", "Worker initialization", 엔진은 "Unknown JS error")가 달라서다.
enum BaroChartRuntimeFactory {
    /// 엔진 본체용 런타임(새 JSContext와 그 VM). 만들 수 없으면 nil이다.
    static func makeEngineRuntime() -> BaroChartCoreRuntime? {
        guard let context = JSContext() else {return nil}
        return traced(BaroChartJSCoreRuntime(context: context))
    }

    /// Engine runtime for an explicit internal backend choice.
    static func makeEngineRuntime(like backend: BaroChartRuntimeBackend) -> BaroChartCoreRuntime? {
        switch backend {
        case .javaScript: return makeEngineRuntime()
        case .rust:
            #if canImport(BaroChartCoreRust)
            return makeRustEngineRuntime()
            #else
            return nil
            #endif
        }
    }

    /// 비동기·복원·params 대상용 격리 런타임(새 VM의 새 컨텍스트). 원본과 같은 백엔드로 만든다.
    /// 작업 스레드에서 부르므로 원본 런타임 대신, 소유 스레드에서 미리 읽어 둔 원본의 백엔드를 받는다.
    /// - Parameter backend: 원본 런타임의 백엔드
    /// - Returns: 번들을 평가하기 전 런타임. 만들 수 없으면 nil
    static func makeIsolated(like backend: BaroChartRuntimeBackend) -> BaroChartCoreRuntime? {
        switch backend {
        case .javaScript:
            guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else {return nil}
            return traced(BaroChartJSCoreRuntime(context: context))
        #if canImport(BaroChartCoreRust)
        case .rust:
            return makeRustEngineRuntime()
        #else
        case .rust:
            return nil
        #endif
        }
    }

    /// 추적이 켜져 있으면 기록 런타임으로 감싼다.
    static func traced(_ runtime: BaroChartCoreRuntime) -> BaroChartCoreRuntime {
        guard let writer = BaroChartTraceSettings.makeWriter() else {return runtime}
        return BaroChartRecordingCoreRuntime(runtime, writer: writer)
    }
}
