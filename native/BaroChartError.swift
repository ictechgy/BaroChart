import Foundation

/// The single error type thrown by the BaroChart typed API and reported by chart views.
///
/// Low-level dictionary APIs keep their original error types; typed API methods convert
/// them with ``wrap(_:)`` so an app can handle every failure with one `catch` pattern.
/// `message` states the cause and `recovery` suggests what to do next.
public struct BaroChartError: Error, CustomStringConvertible, Sendable {
    /// Stable failure categories. Raw values are safe to log and compare.
    public enum Code: String, Sendable, CaseIterable {
        case engineClosed, wrongThread, invalidArgument, javaScript,
             invalidScene, budgetExceeded, cancelled, cleanupPending, unavailable
    }

    /// Failure category.
    public let code: Code
    /// Human-readable cause, in English.
    public let message: String
    /// Suggested next step, in English.
    public let recovery: String
    /// Description of the low-level error this one was converted from, kept for diagnostics.
    public let underlyingDescription: String?

    /// Creates an error. `recovery` defaults to the standard advice for `code`.
    public init(code: Code, message: String, recovery: String? = nil, underlyingDescription: String? = nil) {
        self.code = code
        self.message = message
        self.recovery = recovery ?? code.defaultRecovery
        self.underlyingDescription = underlyingDescription
    }

    /// A one-line description with the code, message and recovery advice.
    public var description: String { "BaroChartError.\(code.rawValue): \(message) — \(recovery)" }
}

extension BaroChartError.Code {
    /// 코드별 기본 해결 방향(외부 개발자에게 노출되므로 영어)
    var defaultRecovery: String {
        switch self {
        case .engineClosed: return "Create a new BaroChartEngine; a closed engine cannot be reused."
        case .wrongThread: return "Call the engine from the thread that created it; engines attached to a view must be created on the main thread."
        case .invalidArgument: return "Check the value against the documented range and current chart state, then retry."
        case .javaScript: return "The chart core rejected the operation; check the message and the operation order."
        case .invalidScene: return "Resize the view to a positive size and redraw."
        case .budgetExceeded: return "Reduce the data or request size, or raise the documented resource budget."
        case .cancelled: return "The operation was cancelled or timed out; retry if the result is still needed."
        case .cleanupPending: return "Wait for the pending cleanup to finish or retry cleanup before starting another job."
        case .unavailable: return "The engine cannot run this now; retry after the active job finishes or recreate the engine."
        }
    }
}

extension BaroChartError {
    /// Converts any error thrown by BaroChart (or Swift concurrency cancellation) to a `BaroChartError`.
    public static func wrap(_ error: any Error) -> BaroChartError {
        if let typed = error as? BaroChartError { return typed }
        let underlying = String(describing: error)
        let (code, message) = classify(error)
        return BaroChartError(code: code, message: message, underlyingDescription: underlying)
    }

    /// body가 던지는 모든 오류를 BaroChartError로 바꿔 다시 던진다(타입 API 공통 진입점)
    @discardableResult static func mapping<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch { throw wrap(error) }
    }

    /// 저수준 오류 종류별 코드와 메시지
    private static func classify(_ error: any Error) -> (Code, String) {
        switch error {
        case let low as BaroChartLowLevelError: return classifyLowLevel(low)
        case let async as BaroChartAsyncError: return classifyAsync(async)
        case let ingestion as BaroChartIngestionError:
            let isBudget = ingestion.code.range(of: "budget|limit|full", options: .regularExpression) != nil
            return (isBudget ? .budgetExceeded : .invalidArgument, "Ingestion \(ingestion.code): \(ingestion.message)")
        case is BaroChartWorkspaceError: return (.cleanupPending, "A previous workspace restore still owns runtime cleanup.")
        case is BaroChartParamsError: return (.cleanupPending, "A previous indicator parameter job still owns runtime cleanup.")
        case is CancellationError: return (.cancelled, "The task was cancelled.")
        // JSONEncoder는 NaN·무한대 같은 유한하지 않은 값을 인코딩하지 못한다. 데이터 문제이므로 잘못된 인수다(Android JSONException과 같은 코드)
        case let encoding as EncodingError: return (.invalidArgument, "Every bar field must be a finite number (\(encoding.localizedDescription)).")
        default: return (.unavailable, String(describing: error))
        }
    }

    /// JavaScriptCore 예외 문자열("TypeError: …" 등)을 코드로 나눈다
    private static func classifyLowLevel(_ error: BaroChartLowLevelError) -> (Code, String) {
        switch error {
        case .wrongThread: return (.wrongThread, "The engine was called from a thread that does not own it.")
        case .invalidScene: return (.invalidScene, "The chart scene could not be produced for the current size.")
        case .unavailableContext: return (.unavailable, "The JavaScript context is unavailable.")
        case .javaScript(let text): return classifyScript(text)
        }
    }

    private static func classifyScript(_ text: String) -> (Code, String) {
        if text.hasPrefix("UnavailableError: ") { return (.unavailable, String(text.dropFirst(18))) }
        // TypeError는 형식·길이 검증("string limit 128" 포함)이라 항상 잘못된 인수다.
        if text.hasPrefix("TypeError: ") { return (.invalidArgument, String(text.dropFirst(11))) }
        // RangeError 중 sizeLimit(": limit N")·예산 메시지만 자원 한도 초과로 본다.
        if text.hasPrefix("RangeError: ") {
            let message = String(text.dropFirst(12))
            let isBudget = message.range(of: #": limit \d+$|budget|exceeds"#, options: [.regularExpression, .caseInsensitive]) != nil
            return (isBudget ? .budgetExceeded : .invalidArgument, message)
        }
        // JSON 문서 파싱 실패(loadDrawings 등)는 호출자가 넘긴 문서가 잘못된 것이다
        if text.hasPrefix("SyntaxError: ") { return (.invalidArgument, String(text.dropFirst(13))) }
        // 일괄 이벤트(applyDataEvents)는 코어 IngestionError로 실패한다. 예산 문구만 자원 한도, 나머지는 잘못된 입력이다
        if text.hasPrefix("IngestionError: ") {
            let message = String(text.dropFirst(16))
            let isBudget = message.range(of: "budget|limit|full", options: [.regularExpression, .caseInsensitive]) != nil
            return (isBudget ? .budgetExceeded : .invalidArgument, message)
        }
        let message = text.hasPrefix("Error: ") ? String(text.dropFirst(7)) : text
        return (message == "Chart disposed" ? .engineClosed : .javaScript, message)
    }

    private static func classifyAsync(_ error: BaroChartAsyncError) -> (Code, String) {
        switch error {
        case .engineClosed: return (.engineClosed, "The engine is closed.")
        case .mainOwnerRequired: return (.wrongThread, "This operation requires the main-thread owner.")
        case .cancelled: return (.cancelled, "The job was cancelled.")
        case .timedOut: return (.cancelled, "The job exceeded its deadline.")
        case .busy: return (.unavailable, "Another asynchronous job is already active on this engine.")
        case .sourceDeallocated: return (.unavailable, "The source engine was released before the job finished.")
        case .invalidProtocol(let detail): return (.invalidArgument, detail)
        }
    }
}
