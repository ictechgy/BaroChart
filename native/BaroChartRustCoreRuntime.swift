#if canImport(BaroChartCoreRust)
import Foundation
import CoreFoundation
import JavaScriptCore
import BaroChartCoreRust

/// Small JSON/BCJSON value model that keeps booleans, signed zero and non-finite doubles distinct.
indirect enum RustJSON {
    case undefined, null, bool(Bool), number(Double), string(String), wtf16([UInt16]), array([RustJSON]), object([(String, RustJSON)]), objectUTF16([([UInt16], RustJSON)])

    /// 값 전용 realm에 넘길 태그 트리. 객체의 원래 키 순서와 WTF-16을 보존한다.
    var materializationDocument: String {
        switch self {
        case .undefined: return "[\"u\"]"
        case .null: return "[\"z\"]"
        case .bool(let value): return "[\"b\"," + (value ? "true" : "false") + "]"
        case .number(let value): return "[\"n\"," + Self.quote(RustJSON.number(value).encoded(lossless: true)) + "]"
        case .string(let value): return "[\"s\"," + Self.quote(value) + "]"
        case .wtf16(let value): return "[\"s\"," + Self.quoteUnits(value) + "]"
        case .array(let values): return "[\"a\",[" + values.map(\.materializationDocument).joined(separator: ",") + "]]"
        case .object(let values): return "[\"o\",[" + values.map { "[" + Self.quote($0.0) + "," + $0.1.materializationDocument + "]" }.joined(separator: ",") + "]]"
        case .objectUTF16(let values): return "[\"o\",[" + values.map { "[" + Self.quoteUnits($0.0) + "," + $0.1.materializationDocument + "]" }.joined(separator: ",") + "]]"
        }
    }

    static func from(_ value: Any) throws -> RustJSON {
        if value is NSNull {return .null}
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {return .bool(number.boolValue)}
            return .number(number.doubleValue)
        }
        if let string = value as? NSString {return .wtf16((0..<string.length).map {string.character(at: $0)})}
        if let array = value as? [Any] {return .array(try array.map(from))}
        if let dictionary = value as? NSDictionary {
            var entries: [([UInt16], RustJSON)] = []
            let enumerator = dictionary.keyEnumerator()
            while let key = enumerator.nextObject() {
                guard let stringKey = key as? NSString else {throw BaroChartLowLevelError.javaScript("TypeError: Object key must be a string")}
                let units = (0..<stringKey.length).map {stringKey.character(at: $0)}
                guard let child = dictionary.object(forKey: key) else {continue}
                entries.append((units, try from(child)))
            }
            return .objectUTF16(entries)
        }
        if let dictionary = value as? [String: Any] {
            return .object(try dictionary.map { ($0.key, try from($0.value)) }.sorted { utf16Less($0.0, $1.0) })
        }
        throw BaroChartLowLevelError.javaScript("TypeError: Unsupported native argument")
    }

    private static func utf16Less(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
    }

    func encoded(lossless: Bool) -> String {
        switch self {
        case .undefined: return lossless ? "undefined" : "null"
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value.isNaN {return lossless ? "NaN" : "null"}
            if value == .infinity {return lossless ? "Infinity" : "null"}
            if value == -.infinity {return lossless ? "-Infinity" : "null"}
            if value == 0 && value.sign == .minus {return lossless ? "-0" : "0"}
            return Self.numberString(value)
        case .string(let value): return Self.quote(value)
        case .wtf16(let value): return Self.quoteUnits(value)
        case .array(let values): return "[" + values.map {$0.encoded(lossless: lossless)}.joined(separator: ",") + "]"
        case .object(let values):
            let sorted = values.sorted { Self.utf16Less($0.0, $1.0) }
            return "{" + sorted.map { Self.quote($0.0) + ":" + $0.1.encoded(lossless: lossless) }.joined(separator: ",") + "}"
        case .objectUTF16(let values):
            let sorted = values.sorted { $0.0.lexicographicallyPrecedes($1.0) }
            return "{" + sorted.map { Self.quoteUnits($0.0) + ":" + $0.1.encoded(lossless: lossless) }.joined(separator: ",") + "}"
        }
    }

    private static func quote(_ string: String) -> String {
        quoteUnits(Array(string.utf16))
    }

    private static func numberString(_ number: Double) -> String {
        let raw = String(number).lowercased()
        guard let exponentMarker = raw.firstIndex(of: "e") else {
            return raw.hasSuffix(".0") ? String(raw.dropLast(2)) : raw
        }
        let mantissa = String(raw[..<exponentMarker])
        let exponent = Int(raw[raw.index(after: exponentMarker)...]) ?? 0
        if (-6...20).contains(exponent) {
            let negative = mantissa.hasPrefix("-")
            let unsigned = negative ? String(mantissa.dropFirst()) : mantissa
            let pieces = unsigned.split(separator: ".", omittingEmptySubsequences: false)
            let digits = pieces.joined()
            let point = (pieces.first?.count ?? 0) + exponent
            let expanded: String
            if point <= 0 {expanded = "0." + String(repeating: "0", count: -point) + digits}
            else if point >= digits.count {expanded = digits + String(repeating: "0", count: point - digits.count)}
            else {let split = digits.index(digits.startIndex, offsetBy: point);expanded = String(digits[..<split]) + "." + String(digits[split...])}
            return (negative ? "-" : "") + expanded
        }
        let normalizedExponent = exponent >= 0 ? "+\(exponent)" : "\(exponent)"
        return mantissa + "e" + normalizedExponent
    }

    private static func quoteUnits(_ units: [UInt16]) -> String {
        var result = "\""
        var i = 0
        while i < units.count {
            let unit = units[i]
            switch unit {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x0c: result += "\\f"
            case 0x0a: result += "\\n"
            case 0x0d: result += "\\r"
            case 0x09: result += "\\t"
            case 0..<0x20: result += String(format: "\\u%04x", unit)
            case 0xd800...0xdbff where i + 1 < units.count && (0xdc00...0xdfff).contains(units[i + 1]):
                let scalar = 0x10000 + ((UInt32(unit) - 0xd800) << 10) + (UInt32(units[i + 1]) - 0xdc00)
                result += String(UnicodeScalar(scalar)!); i += 1
            case 0xd800...0xdfff: result += String(format: "\\u%04x", unit)
            default: result += String(UnicodeScalar(unit)!)
            }
            i += 1
        }
        return result + "\""
    }
}

/// Parser for JSON plus the five BCJSON tokens accepted by the lossless FFI mode.
struct RustJSONParser {
    private let units: [UInt16]
    private var index = 0
    init(_ text: String) {units = Array(text.utf16)}
    mutating func parse() throws -> RustJSON {
        let value = try parseValue(); skipWhitespace()
        guard index == units.count else {throw invalid()}
        return value
    }
    private mutating func parseValue() throws -> RustJSON {
        skipWhitespace(); guard index < units.count else {throw invalid()}
        switch units[index] {
        case 0x75: try literal("undefined"); return .undefined
        case 0x6e: try literal("null"); return .null
        case 0x74: try literal("true"); return .bool(true)
        case 0x66: try literal("false"); return .bool(false)
        case 0x22: return .wtf16(try parseStringUnits())
        case 0x5b:
            index += 1; skipWhitespace(); if consume(0x5d) {return .array([])}
            var values: [RustJSON] = []
            while true {values.append(try parseValue());skipWhitespace();if consume(0x5d) {break};guard consume(0x2c) else {throw invalid()}}
            return .array(values)
        case 0x7b:
            index += 1; skipWhitespace(); if consume(0x7d) {return .object([])}
            var values: [([UInt16], RustJSON)] = []
            while true {skipWhitespace();guard index < units.count, units[index] == 0x22 else {throw invalid()};let key = try parseStringUnits();skipWhitespace();guard consume(0x3a) else {throw invalid()};values.append((key, try parseValue()));skipWhitespace();if consume(0x7d) {break};guard consume(0x2c) else {throw invalid()}}
            return .objectUTF16(values)
        default: return try parseNumber()
        }
    }
    private mutating func parseStringUnits() throws -> [UInt16] {
        guard consume(0x22) else {throw invalid()}; var output: [UInt16] = []
        while index < units.count {
            let unit = units[index]; index += 1
            if unit == 0x22 {return output}
            if unit == 0x5c {
                guard index < units.count else {throw invalid()}; let escaped = units[index]; index += 1
                switch escaped {
                case 0x22,0x5c,0x2f: output.append(escaped)
                case 0x62: output.append(0x08)
                case 0x66: output.append(0x0c)
                case 0x6e: output.append(0x0a)
                case 0x72: output.append(0x0d)
                case 0x74: output.append(0x09)
                case 0x75:
                    guard index + 4 <= units.count else {throw invalid()};var scalar: UInt16 = 0
                    for _ in 0..<4 {let digit = units[index];index += 1;guard let value = Self.hex(digit) else {throw invalid()};scalar = scalar * 16 + value}
                    output.append(scalar)
                default: throw invalid()
                }
            } else {guard unit >= 0x20 else {throw invalid()};output.append(unit)}
        }
        throw invalid()
    }
    private mutating func parseNumber() throws -> RustJSON {
        for token in ["NaN", "Infinity", "-Infinity"] where matches(token) {
            try literal(token)
            return .number(token == "NaN" ? .nan : token == "Infinity" ? .infinity : -.infinity)
        }
        let start = index
        while index < units.count && (units[index] == 0x2d || units[index] == 0x2b || units[index] == 0x2e || units[index] == 0x65 || units[index] == 0x45 || (0x30...0x39).contains(units[index])) {index += 1}
        guard start < index else {throw invalid()}
        let raw = String(decoding: units[start..<index], as: UTF16.self)
        guard let value = Double(raw) else {throw invalid()}
        return .number(value)
    }
    private mutating func literal(_ text: String) throws {for unit in text.utf16 {guard index < units.count, units[index] == unit else {throw invalid()};index += 1}}
    private mutating func skipWhitespace() {while index < units.count && [0x20,0x09,0x0a,0x0d].contains(units[index]) {index += 1}}
    private mutating func consume(_ unit: UInt16) -> Bool {guard index < units.count, units[index] == unit else {return false};index += 1;return true}
    private func matches(_ text: String) -> Bool {units[index...].starts(with: Array(text.utf16))}
    private func invalid() -> BaroChartLowLevelError {.javaScript("SyntaxError: Invalid Rust value")}
    private static func hex(_ unit: UInt16) -> UInt16? {switch unit {case 0x30...0x39:return unit-0x30;case 0x41...0x46:return unit-0x41+10;case 0x61...0x66:return unit-0x61+10;default:return nil}}
}

/// 소유 스레드마다 공유하는 값 전용 JSContext. 코어 번들이나 사용자 코드를 평가하지 않는다.
final class RustValueRealm {
    let context: JSContext
    private let decode: JSValue

    private init?() {
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else {return nil}
        self.context = context
        // JSON.parse가 문자열과 키를 만들고 defineProperty가 __proto__와 undefined를 보존한다.
        // 태그 트리 전체를 감싸므로 사용자 객체와 특수 숫자 표지가 충돌하지 않는다.
        let source = """
        (function () {
          const parse = JSON.parse, define = Object.defineProperty, NumberValue = Number, ErrorValue = Error, StringValue = String;
          const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
          function value(node) {
            switch (node[0]) {
              case 'u': return undefined;
              case 'z': return null;
              case 'b': case 's': return node[1];
              case 'n': return NumberValue(node[1]);
              case 'a': {
                const result = parse('[]');
                for (let i = 0; i < node[1].length; i++) define(result, StringValue(i), {value:value(node[1][i]), enumerable:true, writable:true, configurable:true});
                return result;
              }
              case 'o': {
                const result = parse('{}');
                for (const entry of node[1]) define(result, entry[0], {value:value(entry[1]), enumerable:true, writable:true, configurable:true});
                return result;
              }
            }
            throw new ErrorValue('Invalid Rust value');
          }
          return function (text, asError) {
            const result = value(parse(text));
            if (!asError) return result;
            const error = new ErrorValue(result.message);
            define(error, 'name', {value:result.name, enumerable:true, writable:true, configurable:true});
            if (hasOwn(result, 'code')) define(error, 'code', {value:result.code, enumerable:true, writable:true, configurable:true});
            return error;
          };
        })()
        """
        guard let decode = context.evaluateScript(source), context.exception == nil else {return nil}
        self.decode = decode
    }

    static func current() -> RustValueRealm? {
        let key = "kr.coden.barochart.rust-value-realm"
        if let value = Thread.current.threadDictionary[key] as? RustValueRealm {return value}
        guard let value = RustValueRealm() else {return nil}
        Thread.current.threadDictionary[key] = value
        return value
    }

    func materialize(_ value: RustJSON, asError: Bool = false) throws -> BaroChartCoreValue {
        context.exception = nil
        guard let result = decode.call(withArguments: [value.materializationDocument, asError]), context.exception == nil else {
            context.exception = nil
            throw BaroChartLowLevelError.javaScript("Error: Invalid Rust value")
        }
        return BaroChartCoreValue(javaScriptValue: result, javaScriptContext: context)
    }
}

/// Stable retained callback context. The FFI may move an engine between threads sequentially.
private final class RustHostContext: @unchecked Sendable {}

private func rustZoneResolve(_ context: UnsafeMutableRawPointer?, _ bytes: UnsafePointer<UInt8>?, _ length: Int, _ output: UnsafeMutablePointer<BcBuf>?) -> Int32 {
    guard let bytes, let output, let name = String(bytes: UnsafeBufferPointer(start: bytes, count: length), encoding: .utf8),
          let zone = TimeZone(identifier: name) else {return 1}
    let canonical = Array(zone.identifier.utf8)
    var buffer = BcBuf(ptr: nil, len: 0, cap: 0)
    let status = canonical.withUnsafeBufferPointer {bc_buf_new_copy($0.baseAddress, $0.count, &buffer)}
    guard status == BC_OK else {return 1};output.pointee = buffer;return 0
}

private func rustZoneOffset(_ context: UnsafeMutableRawPointer?, _ bytes: UnsafePointer<UInt8>?, _ length: Int, _ epochMilliseconds: Double, _ output: UnsafeMutablePointer<Int32>?) -> Int32 {
    guard let bytes, let output, let name = String(bytes: UnsafeBufferPointer(start: bytes, count: length), encoding: .utf8),
          let zone = TimeZone(identifier: name), epochMilliseconds.isFinite else {return 1}
    let date = Date(timeIntervalSince1970: epochMilliseconds / 1000)
    output.pointee = Int32(zone.secondsFromGMT(for: date));return 0
}

/// Swift adapter for the common C ABI. Each instance owns one FFI engine and its callback context.
final class BaroChartRustCoreRuntime: BaroChartCoreRuntime {
    let backend = BaroChartRuntimeBackend.rust
    private var engine: OpaquePointer?
    private let unavailableContext = RustHostContext()
    var javaScriptContext: JSContext {preconditionFailure("JavaScript context is unavailable in the Rust backend")}

    init?() {
        let retained = Unmanaged.passRetained(unavailableContext).toOpaque()
        var host = BcHost(context: retained, zone_resolve: rustZoneResolve, zone_offset_seconds: rustZoneOffset, log: nil, release: { pointer in
            guard let pointer else {return}; _ = Unmanaged<RustHostContext>.fromOpaque(pointer).takeRetainedValue()
        })
        var created: OpaquePointer?
        var error = BcBuf(ptr: nil, len: 0, cap: 0)
        let status = withUnsafePointer(to: &host) {bc_engine_new($0, &created, &error)}
        if error.ptr != nil {bc_buf_free(error)}
        guard status == BC_OK else {
            _ = Unmanaged<RustHostContext>.fromOpaque(retained).takeRetainedValue()
            return nil
        }
        engine = created
    }

    deinit {if let engine {bc_engine_free(engine)}}

    func supports(_ name: String) -> Bool {
        guard let engine else {return false}
        let bytes = Array(name.utf8)
        return bytes.withUnsafeBufferPointer {bc_supports(engine, $0.baseAddress, $0.count)}
    }

    func perform(_ name: String, _ arguments: [Any]) -> BaroChartCoreOutcome {
        guard let engine else {return disposedOutcome()}
        if let error = BaroChartArgumentDepth.rejection(for: arguments) {return .rejected(error)}
        guard let values = RustValueRealm.current() else {return .rejected(BaroChartLowLevelError.unavailableContext)}
        do {
            let args = RustJSON.array(try arguments.map(RustJSON.from)).encoded(lossless: true)
            let nameBytes = Array(name.utf8), argBytes = Array(args.utf8)
            var result = BcBuf(ptr: nil, len: 0, cap: 0)
            let status = nameBytes.withUnsafeBufferPointer { n in argBytes.withUnsafeBufferPointer { a in
                bc_call(engine, n.baseAddress, n.count, a.baseAddress, a.count, UInt32(BC_FLAG_LOSSLESS), &result)
            }}
            defer {if result.ptr != nil {bc_buf_free(result)}}
            if status == BC_BUSY || status == BC_CLOSED || status == BC_POISONED {
                return disposedOutcome()
            }
            guard let pointer = result.ptr else {return .rejected(BaroChartLowLevelError.javaScript("Error: Missing Rust response"))}
            let text = String(decoding: UnsafeBufferPointer(start: pointer, count: result.len), as: UTF8.self)
            var parser = RustJSONParser(text)
            let value = try parser.parse()
            let wrapped = try values.materialize(value, asError: status == BC_THROW || status == BC_UNAVAILABLE)
            switch status {
            case BC_OK: return .returned(wrapped)
            case BC_THROW, BC_UNAVAILABLE: return .threw(wrapped)
            default: return .rejected(BaroChartLowLevelError.javaScript("Error: Invalid Rust call"))
            }
        } catch {return .rejected(error)}
    }

    private func disposedOutcome() -> BaroChartCoreOutcome {
        guard let values = RustValueRealm.current() else {return .rejected(BaroChartLowLevelError.unavailableContext)}
        do {return .threw(try values.materialize(.object([("name", .string("Error")), ("message", .string("Chart disposed"))]), asError: true))}
        catch {return .rejected(error)}
    }

    func takeException() -> BaroChartCoreValue? {nil}
    func evaluateBundle(_ source: String) -> BaroChartCoreValue? {nil}
}

extension BaroChartRuntimeFactory {
    static func makeRustEngineRuntime() -> BaroChartCoreRuntime? {
        guard let runtime = BaroChartRustCoreRuntime() else {return nil}
        return traced(runtime)
    }
}
#endif
