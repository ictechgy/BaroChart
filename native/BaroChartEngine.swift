import Foundation
import JavaScriptCore
import CoreGraphics
import CoreText

/// Low-level errors thrown by the dictionary API and the core bridge: a JavaScript exception, an unavailable JavaScript context, a scene that cannot be produced, or a call from a thread that does not own the engine.
///
/// Typed API methods convert these to ``BaroChartError``.
public enum BaroChartLowLevelError: Error { case javaScript(String), unavailableContext, invalidScene, wrongThread }
/// Stable queue/admission error from the shared ingestion contract. Original
/// owner/closed-engine failures keep their existing BaroChartLowLevelError/BaroChartAsyncError.
public struct BaroChartIngestionError: Error, CustomStringConvertible {
    /// Stable ingestion error code from the shared ingestion contract.
    public let code: String
    /// Human-readable detail for ``code``.
    public let message: String
    /// Creates an ingestion error from a stable `code` and a human-readable `message`.
    public init(code: String, message: String) {self.code=code;self.message=message}
    /// A one-line description containing the code and message.
    public var description: String {"IngestionError[\(code)]: \(message)"}
}
/// One OHLCV bar. `time` is a UTC epoch timestamp in milliseconds.
public struct BaroChartBar: Codable, Equatable, Sendable {
    /// Bar time (UTC epoch milliseconds), then open, high, low and close prices, and volume.
    public let time, open, high, low, close, volume: Double
    /// Creates a bar from its time (UTC epoch milliseconds), prices and volume.
    public init(time: Double, open: Double, high: Double, low: Double, close: Double, volume: Double) {
        self.time = time; self.open = open; self.high = high; self.low = low; self.close = close; self.volume = volume
    }
}
/// One drawing primitive of a ``BaroChartScene``, decoded from the core's scene JSON.
///
/// `op` selects the primitive; only the fields that primitive uses are set.
public struct BaroChartCommand: Decodable {
    /// Primitive name: `lines`, `rects`, `path`, `box`, `ellipse` or `text`. ``BaroChartCoreGraphicsRenderer`` skips any other name.
    public let op: String
    /// Numeric arrays. `coords` holds groups of four numbers (line segment endpoints for `lines`; x, y, width, height for `rects`). `points` is a flat x, y polyline for `path`. `clip` is an x, y, width, height clip rectangle. `dash` is a line-dash length pattern.
    public let coords, points, clip, dash: [Double]?
    /// Geometry in scene pixels: `x`, `y`, `w` and `h` for `box`, `ellipse` and `text` positions; `width` is the stroke width (1 when absent); `baseline` is the y coordinate that closes a filled `path`.
    public let x, y, w, h, width, baseline: Double?
    /// Stroke or text color, fill color, label text and CSS-style font (for example `12px monospace`). Colors are CSS hex strings.
    public let color, fill, text, font: String?
    /// Optional label semantics from the shared core. Older scene bundles omit
    /// these fields; raw data/anchors remain separate from display commands.
    public let role, fullText, panelId, axisId: String?
    /// Label bounds reported by the core for label commands. Absent in older scene bundles.
    public let labelBounds: [Double]?
}
/// A drawable chart frame decoded from the core: canvas size, background color and the ordered drawing commands.
///
/// Render it with ``BaroChartCoreGraphicsRenderer``.
public struct BaroChartScene: Decodable {
    /// Scene width and height in logical (CSS) pixels.
    public let width, height: Double
    /// Background color as a CSS hex string.
    public let background: String
    /// Drawing commands in paint order.
    public let commands: [BaroChartCommand]
    /// Frame statistics reported by the core, as named integer counters.
    public let stats: [String: Int]
}

/// Errors from owner checks and opt-in asynchronous jobs: wrong owner, a busy engine, cancellation, a missed deadline, a closed or released engine, or a protocol violation.
///
/// Typed API methods convert these to ``BaroChartError``.
public enum BaroChartAsyncError: Error {
    case mainOwnerRequired, busy, cancelled, timedOut, engineClosed, sourceDeallocated
    case invalidProtocol(String)
}
/// Progress snapshot delivered to an asynchronous job's progress callback.
public struct BaroChartAsyncProgress {
    /// Name of the job phase being reported.
    public let phase: String
    /// Units completed and total units for the reported phase.
    public let done, total: Int
}
/// Timing and memory measurements of a finished asynchronous job. Durations are milliseconds; byte counts are logical sizes, not process footprint.
public struct BaroChartAsyncMetrics {
    /// Logical six-column input bytes retained during preparation. Swift COW
    /// aliases may use less physical storage; this is not a process footprint.
    public internal(set) var retainedInputBytes = 0, inputOwnershipMs = 0.0
    /// Bytes copied for the job, bytes of checkpoint JSON, and the largest single chunk in bytes.
    public internal(set) var copiedBytes = 0, checkpointJSONBytes = 0, maximumChunkBytes = 0
    /// Durations in milliseconds of the capture, target copy, compute and worker initialization phases.
    public internal(set) var captureMs = 0.0, targetCopyMs = 0.0, computeMs = 0.0, workerInitMs = 0.0
    /// Durations in milliseconds of the begin phase, time spent waiting for the owner queue, and the commit phase.
    public internal(set) var beginMs = 0.0, queueWaitMs = 0.0, commitMs = 0.0
    /// Durations in milliseconds of the UI state phase, the finish phase and the whole job.
    public internal(set) var uiStateMs = 0.0, finishMs = 0.0, totalMs = 0.0
    /// UI state transfer counters: chunk count, total bytes, largest chunk in bytes, and worker import time in milliseconds.
    public internal(set) var uiChunkCount = 0, uiTransferBytes = 0, maximumUIChunkBytes = 0, workerUIImportMs = 0.0
    /// Process resident memory in bytes sampled when the job started, and the peak sampled during the job.
    public internal(set) var baselineResidentBytes: UInt64 = 0, peakResidentBytes: UInt64 = 0
    /// Number of times the progress callback threw an error.
    public internal(set) var progressCallbackErrors = 0
}

private func asterClock() -> Double { ProcessInfo.processInfo.systemUptime }
private func asterResidentBytes() -> UInt64 {
    var info = mach_task_basic_info(), count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let code = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return code == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}
/// 코어 함수를 한 번 부른다. 본문(JSC 호출, 예외 검사, 오류 문구)은 이음새 BaroChartCoreRuntime.invoke로 옮겼고,
/// 이 이름은 작업·정리 경로의 호출 자리를 그대로 두려고 남긴다.
private func asterInvoke(_ runtime: BaroChartCoreRuntime, _ name: String, _ args: [Any] = []) throws -> BaroChartCoreValue {
    try runtime.invoke(name, args)
}
private func asterDictionary(_ value: BaroChartCoreValue) throws -> [String: Any] {
    guard let text=value.toString() else{throw BaroChartAsyncError.invalidProtocol("Expected JSON string")}
    return try asterDictionary(text)
}
private func asterDictionary(_ text:String,maximumBytes:Int=8388608) throws -> [String:Any] {
    guard let bytes = text.data(using: .utf8), bytes.count <= maximumBytes,
          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {throw BaroChartAsyncError.invalidProtocol("Expected bounded JSON object string")}
    return object
}
private func asterInteger(_ value: Any?, _ maximum: Int = Int.max) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= Double(maximum),
          number.doubleValue.rounded(.towardZero) == number.doubleValue else {throw BaroChartAsyncError.invalidProtocol("Invalid integer")}
    return number.intValue
}

private struct BaroChartAsyncBuffer {let slot, length: Int}
private struct BaroChartAsyncCheckpoint {let entry, total, maxRows: Int}
private struct BaroChartAsyncPlan {
    let ticket: Int
    let metadata: String
    let buffers: [BaroChartAsyncBuffer]
    let checkpoints: [BaroChartAsyncCheckpoint]
    init(_ object: [String: Any]) throws {
        ticket = try asterInteger(object["ticket"], 9007199254740991)
        guard let text = object["metadataJSON"] as? String, text.utf8.count <= 8388608,
              let rawBuffers = object["buffers"] as? [[String: Any]], rawBuffers.count <= 8192,
              let rawCheckpoints = object["checkpoints"] as? [[String: Any]], rawCheckpoints.count <= 128 else {throw BaroChartAsyncError.invalidProtocol("Invalid capture descriptor")}
        metadata = text
        var slots = Set<Int>(), entries = Set<Int>(), totalBytes = 0
        buffers = try rawBuffers.map {
            let slot = try asterInteger($0["slot"], 8191), length = try asterInteger($0["length"], 16777216)
            guard slots.insert(slot).inserted, length <= (Int.max - totalBytes) / 8 else {throw BaroChartAsyncError.invalidProtocol("Duplicate or oversized buffer")}
            totalBytes += length * 8
            guard totalBytes <= 4294967296 else {throw BaroChartAsyncError.invalidProtocol("Snapshot exceeds host byte budget")}
            return BaroChartAsyncBuffer(slot: slot, length: length)
        }
        checkpoints = try rawCheckpoints.map {
            let entry = try asterInteger($0["entry"], 127), total = try asterInteger($0["total"], 4194304)
            let maxRows = try $0["maxRows"].map {try asterInteger($0,64)} ?? 64
            guard maxRows >= 1 else {throw BaroChartAsyncError.invalidProtocol("Invalid checkpoint chunk rows")}
            guard entries.insert(entry).inserted else {throw BaroChartAsyncError.invalidProtocol("Duplicate checkpoint entry")}
            return BaroChartAsyncCheckpoint(entry: entry, total: total, maxRows: maxRows)
        }
    }
}

private enum BaroChartAsyncKind {case correction, columns, seeded}

/// Handle cancellation from any thread. It is cooperative at capture/compute
/// chunk boundaries; it never frees a VM while a JS function is running.
public final class BaroChartAsyncJob {
    private let lock = NSLock()
    private var stopped: Error?, terminal = false, committed = false, callbackErrors = 0, progressPending = false
    private var latestProgress: BaroChartAsyncProgress?
    fileprivate weak var engine: BaroChartEngine?
    fileprivate var source: BaroChartCoreRuntime?
    /// 원본 런타임의 백엔드. 작업 스레드가 같은 백엔드로 대상 런타임을 만들 때 읽는다(바뀌지 않는다).
    fileprivate let sourceBackend: BaroChartRuntimeBackend
    private var workspaceSourceRuntime: BaroChartContextRuntime?
    fileprivate var runtime: BaroChartAsyncRuntime?
    fileprivate var ticket: Int?
    fileprivate var plan: BaroChartAsyncPlan?
    fileprivate var kind: BaroChartAsyncKind = .correction
    fileprivate var hostColumns: BaroChartColumns?
    fileprivate var progress: ((BaroChartAsyncProgress) throws -> Void)?
    fileprivate var completion: ((Result<BaroChartAsyncMetrics, Error>) -> Void)?
    fileprivate var metrics = BaroChartAsyncMetrics()
    fileprivate let started = asterClock(), timeout: Double
    fileprivate init(engine: BaroChartEngine, timeout: Double, progress: ((BaroChartAsyncProgress) throws -> Void)?, completion: @escaping (Result<BaroChartAsyncMetrics, Error>) -> Void) {
        let source = engine.coreRuntime
        self.engine = engine; self.source = source; self.sourceBackend = source.backend; self.timeout = timeout;self.progress = progress;self.completion = completion
        if engine.workspaceContextInstalled, let runtime = engine.contextRuntime {
            if runtime.acquireCaptureLease() {workspaceSourceRuntime = runtime}
            else {stopped = BaroChartAsyncError.invalidProtocol("Source runtime is retiring")}
        }
        metrics.baselineResidentBytes = asterResidentBytes();metrics.peakResidentBytes = metrics.baselineResidentBytes
    }
    /// Requests cancellation. Safe from any thread. Cancellation is cooperative at chunk boundaries and has no effect once the result has been committed.
    public func cancel() {stop(BaroChartAsyncError.cancelled)}
    fileprivate var isCommitted: Bool {lock.lock();defer{lock.unlock()};return committed}
    // Internal fixture probe observes actual retained fields. Completed handles
    // can be kept as cancellation history without retaining a feed or callbacks.
    func _terminalRetentionProbe() -> (inputBytes:Int, callbacks:Int, contexts:Int) {
        precondition(Thread.isMainThread)
        return (hostColumns?.retainedBytes ?? 0,(progress == nil ? 0 : 1)+(completion == nil ? 0 : 1),(source == nil ? 0 : 1)+(runtime == nil ? 0 : 1))
    }
    fileprivate func stop(_ error: Error) {lock.lock();if stopped == nil && !terminal && !committed {stopped = error};lock.unlock()}
    fileprivate func check() throws {
        lock.lock();let error = stopped;lock.unlock()
        if let error = error {throw error}
        if asterClock() - started >= timeout {throw BaroChartAsyncError.timedOut}
    }
    // Cancellation and commit have one linearization point. A cancellation
    // accepted before this lock prevents publication; after commit it is inert.
    // No user callbacks execute under this lock.
    fileprivate func commit(_ publish: () throws -> Void) throws {
        lock.lock();defer {lock.unlock()}
        if let error = stopped {throw error}
        guard !terminal && !committed else {throw BaroChartAsyncError.invalidProtocol("Repeated commit")}
        if asterClock()-started >= timeout {throw BaroChartAsyncError.timedOut}
        try publish();committed = true
    }
    fileprivate func sampleMemory() {metrics.peakResidentBytes = max(metrics.peakResidentBytes, asterResidentBytes())}
    fileprivate func report(_ value: BaroChartAsyncProgress) {
        lock.lock();latestProgress = value
        if progressPending || terminal {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress;progressPending = false;let isTerminal = terminal;lock.unlock()
            guard !isTerminal, let value = value, let callback = progress else {return}
            do {try callback(value)} catch {lock.lock();callbackErrors += 1;lock.unlock()}
        }
    }
    fileprivate func ownerSource() throws -> BaroChartCoreRuntime {
        precondition(Thread.isMainThread)
        try check()
        guard let engine = engine else {throw BaroChartAsyncError.sourceDeallocated}
        guard !engine.closed else {throw BaroChartAsyncError.engineClosed}
        guard engine.activeAsync === self, let source = source, engine.coreRuntime === source else {throw BaroChartAsyncError.invalidProtocol("Source context was replaced")}
        if let ticket = ticket {_ = try asterInvoke(source, "nativeAsyncCheck", [ticket])}
        return source
    }
    fileprivate func sourceChunk<T>(_ capture: @escaping (BaroChartCoreRuntime) throws -> T) throws -> T {
        let box = BaroChartCaptureBox<T>(), requestedAt = asterClock()
        DispatchQueue.main.async { [self] in
            let ownerStartedAt = asterClock()
            do {let source = try ownerSource();box.resolve(.success(try capture(source)),startedAt:ownerStartedAt)} catch {box.resolve(.failure(error),startedAt:ownerStartedAt)}
        }
        let reply = try box.wait(self), resumedAt = asterClock()
        // Scheduling latency excludes the actual owner capture/check operation.
        metrics.queueWaitMs += max(0,reply.startedAt-requestedAt)*1000 + max(0,resumedAt-reply.resolvedAt)*1000
        return try reply.result.get()
    }
    fileprivate func finish(_ result: Result<BaroChartAsyncMetrics, Error>) {
        precondition(Thread.isMainThread)
        lock.lock();if terminal {lock.unlock();return};terminal = true;metrics.progressCallbackErrors = callbackErrors;lock.unlock()
        autoreleasepool {if let source = source, let ticket = ticket {_ = try? asterInvoke(source,"nativeAsyncRelease",[ticket])}}
        source = nil;plan = nil;ticket = nil;hostColumns = nil
        let leasedRuntime = workspaceSourceRuntime;workspaceSourceRuntime = nil
        leasedRuntime?.releaseCaptureLease()
        if let engine = engine, engine.activeAsync === self {engine.activeAsync = nil}
        let callback = completion;completion = nil;progress = nil
        runtime = nil
        switch result {
        case .success: metrics.totalMs = (asterClock() - started) * 1000;callback?(.success(metrics))
        case .failure(let error): callback?(.failure(error))
        }
    }
}
private struct BaroChartCaptureReply<T> {let result: Result<T,Error>,startedAt: Double,resolvedAt: Double}
private final class BaroChartCaptureBox<T> {
    private let condition = NSCondition()
    private var reply: BaroChartCaptureReply<T>?
    func resolve(_ value: Result<T, Error>, startedAt: Double) {
        let result = BaroChartCaptureReply(result:value,startedAt:startedAt,resolvedAt:asterClock())
        condition.lock();reply = result;condition.signal();condition.unlock()
    }
    func wait(_ job: BaroChartAsyncJob) throws -> BaroChartCaptureReply<T> {
        condition.lock();defer {condition.unlock()}
        while reply == nil {_ = condition.wait(until: Date(timeIntervalSinceNow:0.02));try job.check()}
        return reply!
    }
}

// Capture leases delay actual creator retirement, not merely object deinit.
private protocol BaroChartContextRuntime: AnyObject {
    func retire()
    func acquireCaptureLease() -> Bool
    func releaseCaptureLease()
    func releaseCaptureLease(afterRetirementIfNeeded: @escaping () -> Void)
}
private final class BaroChartRuntimeRetirement {
    private let lock = NSLock()
    private var requested = false, leases = 0
    private var loop: CFRunLoop?
    private var completions: [() -> Void] = []
    func acquire() -> Bool {
        lock.lock();defer {lock.unlock()}
        guard !requested else {return false};leases += 1;return true
    }
    func release(_ completion: (() -> Void)? = nil) {
        lock.lock();precondition(leases > 0);leases -= 1
        let wait = requested
        if wait, let completion = completion {completions.append(completion)}
        let wake = wait && leases == 0 ? loop : nil;lock.unlock()
        if let wake = wake {CFRunLoopStop(wake);CFRunLoopWakeUp(wake)}
        if !wait {completion?()}
    }
    func retire() {
        lock.lock();requested = true;let wake = leases == 0 ? loop : nil;lock.unlock()
        if let wake = wake {CFRunLoopStop(wake);CFRunLoopWakeUp(wake)}
    }
    var shouldStop: Bool {lock.lock();defer {lock.unlock()};return requested && leases == 0}
    func install(_ value: CFRunLoop?) {lock.lock();loop = value;lock.unlock()}
    func didFinish() {
        // Creator calls only after its context/pool and run loop are cleaned.
        lock.lock();let ready = completions;completions = [];lock.unlock()
        for completion in ready {DispatchQueue.main.async(execute:completion)}
    }
}
/// Reports restoration failure, not successful cleanup. Retry explicitly on main.
public enum BaroChartWorkspaceError: Error {case cleanupPending(registration: Int)}
/// Measurements of a finished workspace restore. Byte counts are logical sizes, not process footprint; `totalMs` is in milliseconds.
public struct BaroChartWorkspaceMetrics {
    /// Bytes copied, logical bytes admitted against the native budget, and the number of times the progress callback threw.
    public internal(set) var copiedBytes = 0, logicalAdmissionBytes = 0, progressCallbackErrors = 0
    /// Total duration of the restore in milliseconds.
    public internal(set) var totalMs = 0.0
}
/// State of one workspace restore whose runtime cleanup is still pending. Read it with ``BaroChartEngine/workspaceCleanupStatus()``.
public struct BaroChartWorkspaceCleanupStatus {
    /// `registration` identifies the restore, `admittedLogicalBytes` is the logical size admitted against the native budget, and `retryFailures` counts failed cleanup attempts.
    public let registration, admittedLogicalBytes, retryFailures: Int
    /// Unadmitted zero bytes means unknown retained cost, bounded by slots only.
    public let admitted, awaitingCreatorCleanup: Bool
}
private let asterWorkspaceMaxBytes = 768 * 1024 * 1024
// Main-owner accounting shared by workspace and entry-only parameter jobs.
// Before descriptor admission only the slot is bounded; zero is unknown cost.
private final class BaroChartNativeAdmissionLease {fileprivate var bytes = 0, admitted = false, released = false}
private enum BaroChartNativeAdmission {
    private static var slots = 0, bytes = 0
    static func reserve() throws -> BaroChartNativeAdmissionLease {
        precondition(Thread.isMainThread)
        guard slots < 2 else {throw BaroChartAsyncError.busy}
        slots += 1;return BaroChartNativeAdmissionLease()
    }
    static func admit(_ lease: BaroChartNativeAdmissionLease, _ cost: Int) throws {
        precondition(Thread.isMainThread)
        guard !lease.released, !lease.admitted, cost > 0, cost <= asterWorkspaceMaxBytes - bytes else {throw BaroChartAsyncError.busy}
        bytes += cost;lease.bytes = cost;lease.admitted = true
    }
    static func release(_ lease: BaroChartNativeAdmissionLease) {
        precondition(Thread.isMainThread)
        if lease.released {return}
        lease.released = true;slots -= 1;bytes -= lease.bytes
    }
}
private func asterWorkspaceObject(_ value: BaroChartCoreValue) throws -> [String: Any] {
    guard value.isObject, let object = value.toDictionary() as? [String: Any] else {throw BaroChartAsyncError.invalidProtocol("Workspace object receipt")}
    return object
}
private func asterWorkspaceBool(_ value: Any?) throws -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {throw BaroChartAsyncError.invalidProtocol("Workspace boolean receipt")}
    return number.boolValue
}
private func asterWorkspaceTrue(_ value: BaroChartCoreValue) throws {
    guard value.isBoolean, value.toBool() else {throw BaroChartAsyncError.invalidProtocol("Workspace true receipt")}
}
// Main-only minimal recovery owner: no Engine/job/Error/client callback fields.
private final class BaroChartWorkspaceSourceRecord {
    let registration: Int
    let admission: BaroChartNativeAdmissionLease
    var context: BaroChartCoreRuntime?
    private var runtime: BaroChartContextRuntime?
    var bytes = 0, admitted = false, pending = false, retrying = false, failures = 0
    var began = false, released = false, detaching = false
    init(registration: Int, context: BaroChartCoreRuntime, runtime: BaroChartContextRuntime?, admission: BaroChartNativeAdmissionLease) throws {
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw BaroChartAsyncError.invalidProtocol("Source runtime is retiring")}
        self.registration = registration;self.context = context;self.runtime = runtime;self.admission = admission
    }
    func abort() throws {
        precondition(Thread.isMainThread)
        if released {return}
        if began {
            try autoreleasepool {
                guard let context = context else {throw BaroChartAsyncError.invalidProtocol("Missing captured source")}
                let value = try asterInvoke(context,"nativeWorkspaceSourceAbort",[registration])
                guard value.isBoolean else {throw BaroChartAsyncError.invalidProtocol("Workspace abort receipt")}
            }
        }
        released = true
    }
    func detach(_ completion: @escaping () -> Void) {
        precondition(Thread.isMainThread && released && !detaching)
        detaching = true;context = nil
        let owner = runtime;runtime = nil
        // Drop every record context alias before releasing the retirement lease.
        // Open source runtimes remain open; retiring ones acknowledge cleanup.
        if let owner = owner {owner.releaseCaptureLease(afterRetirementIfNeeded:completion)} else {completion()}
    }
}
// All operations are main-only: no registry lock encloses JS/ARC/callbacks.
private enum BaroChartWorkspaceRegistry {
    private static var records: [Int: BaroChartWorkspaceSourceRecord] = [:]
    private static var next = 0
    static func reserve(_ context: BaroChartCoreRuntime, _ runtime: BaroChartContextRuntime?) throws -> BaroChartWorkspaceSourceRecord {
        precondition(Thread.isMainThread)
        guard records.count < 2, next < 9007199254740991 else {throw BaroChartAsyncError.busy}
        next += 1
        let admission = try BaroChartNativeAdmission.reserve()
        do {
            let record = try BaroChartWorkspaceSourceRecord(registration:next,context:context,runtime:runtime,admission:admission)
            records[record.registration] = record;return record
        } catch {BaroChartNativeAdmission.release(admission);throw error}
    }
    static func contains(_ registration: Int) -> Bool {precondition(Thread.isMainThread);return records[registration] != nil}
    static func admit(_ record: BaroChartWorkspaceSourceRecord, _ cost: Int) throws {
        precondition(Thread.isMainThread)
        guard records[record.registration] === record, !record.admitted else {throw BaroChartAsyncError.busy}
        try BaroChartNativeAdmission.admit(record.admission,cost)
        record.bytes = cost;record.admitted = true
    }
    static func remove(_ record: BaroChartWorkspaceSourceRecord, completion: @escaping () -> Void = {}) {
        precondition(Thread.isMainThread && record.released)
        guard records[record.registration] === record, !record.detaching else {return}
        record.detach {
            precondition(Thread.isMainThread)
            guard records[record.registration] === record else {return}
            // Actual retired-source creator cleanup precedes reservation release.
            records.removeValue(forKey:record.registration);BaroChartNativeAdmission.release(record.admission)
            completion()
        }
    }
    static func status() -> [BaroChartWorkspaceCleanupStatus] {
        precondition(Thread.isMainThread)
        return records.values.filter{$0.pending}.sorted{$0.registration < $1.registration}.map {
            BaroChartWorkspaceCleanupStatus(registration:$0.registration,admittedLogicalBytes:$0.bytes,retryFailures:$0.failures,admitted:$0.admitted,awaitingCreatorCleanup:$0.detaching)
        }
    }
    static func retry(_ registration: Int? = nil) {
        precondition(Thread.isMainThread)
        let candidates = Array(records.values)
        for record in candidates where record.pending && !record.retrying && !record.detaching && (registration == nil || registration == record.registration) {
            record.retrying = true
            do {try record.abort();record.retrying = false;remove(record)}
            catch {record.retrying = false;record.failures = min(32,record.failures + 1)}
        }
    }
}
private struct BaroChartWorkspaceDescriptor {
    let ticket, length, bytes: Int
    let metadata: String
    init(_ value: [String: Any], ticket: Int) throws {
        guard value["phase"] as? String == "copy", try asterInteger(value["ticket"],9007199254740991) == ticket,
              let metadata = value["metadataJSON"] as? String, metadata.utf16.count <= 8388608,
              let checkpoints = value["checkpoints"] as? [Any], checkpoints.isEmpty,
              let buffers = value["buffers"] as? [[String:Any]], buffers.count == 6,
              let plan = value["plan"] as? [String:Any] else {throw BaroChartAsyncError.invalidProtocol("Workspace descriptor binding")}
        var count: Int?
        for slot in 0..<6 {
            guard try asterInteger(buffers[slot]["slot"],5) == slot else {throw BaroChartAsyncError.invalidProtocol("Workspace source slot order")}
            let n = try asterInteger(buffers[slot]["length"],4194304)
            if let count = count, count != n {throw BaroChartAsyncError.invalidProtocol("Workspace column lengths")};count = n
        }
        let cost = try asterInteger(plan["totalBytes"],asterWorkspaceMaxBytes)
        guard cost > 0 else {throw BaroChartAsyncError.invalidProtocol("Workspace logical bytes")}
        self.ticket = ticket;length = count!;bytes = cost;self.metadata = metadata
    }
}

// A separate VM and creation-thread run loop prevent the source VM lock from
// blocking UI. After handoff this thread performs no JS API calls. Retiring the
// owning context stops its run loop; cached old raw contexts are unsupported.
private final class BaroChartAsyncRuntime: BaroChartContextRuntime {
    private let retirement = BaroChartRuntimeRetirement()
    private var initialJob: BaroChartAsyncJob?
    private let bundle: String
    init(bundle: String, job: BaroChartAsyncJob) {self.bundle = bundle;initialJob = job}
    func start() {let thread = Thread { [self] in run() };thread.name = "Aster isolated JavaScriptCore";thread.qualityOfService = .userInitiated;thread.start()}
    func retire() {retirement.retire()}
    func acquireCaptureLease() -> Bool {retirement.acquire()}
    func releaseCaptureLease() {retirement.release()}
    func releaseCaptureLease(afterRetirementIfNeeded completion: @escaping () -> Void) {retirement.release(completion)}
    private struct Prepared {let context: BaroChartCoreRuntime;let plan: BaroChartAsyncPlan}
    private func run() {
        let port = Port();RunLoop.current.add(port,forMode:.default)
        retirement.install(CFRunLoopGetCurrent())
        performInitialJob()
        while !retirement.shouldStop {_ = RunLoop.current.run(mode:.default,before:.distantFuture)}
        RunLoop.current.remove(port,forMode:.default);port.invalidate();retirement.install(nil);retirement.didFinish()
    }
    private func performInitialJob() {
        let job = initialJob!;initialJob = nil
        var outcome: Result<Prepared, Error>!
        // Drain every worker JSValue/autorelease before owner VM access begins.
        autoreleasepool {do {outcome = .success(try compute(job))} catch {outcome = .failure(error)}}
        switch outcome! {
        case .success(let prepared): handoff(job, prepared)
        case .failure(let error): retire();DispatchQueue.main.async {job.finish(.failure(error))}
        }
        outcome = nil
    }
    private func compute(_ job: BaroChartAsyncJob) throws -> Prepared {
            try job.check()
            let start = asterClock()
            guard let context = BaroChartRuntimeFactory.makeIsolated(like: job.sourceBackend), let plan = job.plan else {throw BaroChartLowLevelError.unavailableContext}
            if let exception = context.evaluateBundle(bundle) {throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Bundle error")}
            _ = try asterInvoke(context,job.kind == .correction ? "nativeAsyncCreate" : "nativePrepareCreate",[plan.metadata]);job.metrics.workerInitMs = (asterClock()-start)*1000;job.sampleMemory()
            if job.kind != .correction {
                guard plan.buffers.isEmpty,plan.checkpoints.isEmpty else {throw BaroChartAsyncError.invalidProtocol("Prepare must not copy source buffers")}
                if job.kind == .columns {
                    guard let columns=job.hostColumns else {throw BaroChartAsyncError.invalidProtocol("Missing owned columns")}
                    var copied=0
                    for slot in 0..<6 {
                        let field=try columns.field(slot);var offset=0
                        while offset<columns.length {
                            try job.check()
                            // Guard the source owner without reading/copying its
                            // old arrays. Only the immutable host input is read.
                            let _:Void=try job.sourceChunk {_ in ()}
                            let at=offset,count=min(262144,columns.length-offset),copyStart=asterClock()
                            try autoreleasepool {
                                try field.withUnsafeBufferPointer {buffer in try context.writeFloat64("nativeAsyncTargetBuffer",[slot,at,count],from:buffer.baseAddress!.advanced(by:at),count:count)}
                            }
                            let bytes=count*8;job.metrics.targetCopyMs += (asterClock()-copyStart)*1000;job.metrics.copiedBytes += bytes;job.metrics.maximumChunkBytes=max(job.metrics.maximumChunkBytes,bytes)
                            copied += bytes;offset += count;job.sampleMemory();job.report(BaroChartAsyncProgress(phase:"capture",done:copied,total:columns.retainedBytes))
                        }
                    }
                }
            }
            let totalBytes = plan.buffers.reduce(0) {$0 + $1.length * 8};var copied = 0
            for buffer in plan.buffers {
                var offset = 0
                while offset < buffer.length {
                    try job.check()
                    let at = offset, count = min(262144,buffer.length-offset)
                    let chunk: (Data,Double) = try job.sourceChunk { source in
                        let begin = asterClock(), bytes = try source.readFloat64Data("nativeAsyncBuffer",[plan.ticket,buffer.slot,at,count],count:count)
                        return (bytes,(asterClock()-begin)*1000)
                    }
                    try job.check()
                    let copyStart = asterClock()
                    try chunk.0.withUnsafeBytes {bytes in try context.writeFloat64("nativeAsyncTargetBuffer",[buffer.slot,at,count],from:bytes.baseAddress!,count:count)}
                    job.metrics.captureMs += chunk.1;job.metrics.targetCopyMs += (asterClock()-copyStart)*1000
                    job.metrics.copiedBytes += chunk.0.count;job.metrics.maximumChunkBytes = max(job.metrics.maximumChunkBytes,chunk.0.count)
                    copied += count * 8;offset += count;job.sampleMemory();job.report(BaroChartAsyncProgress(phase:"capture",done:copied,total:totalBytes))
                }
            }
            let totalCheckpoints = plan.checkpoints.reduce(0) {$0+$1.total};var imported = 0
            for checkpoint in plan.checkpoints {
                var offset = 0
                while offset < checkpoint.total {
                    try job.check()
                    let at = offset, count = min(checkpoint.maxRows,checkpoint.total-offset)
                    let rows: (String,Double) = try job.sourceChunk {source in
                        let begin = asterClock()
                        guard let text = try asterInvoke(source,"nativeAsyncCheckpoint",[plan.ticket,checkpoint.entry,at,count]).toString(),text.utf8.count <= 8388608 else {throw BaroChartAsyncError.invalidProtocol("Oversized checkpoint chunk")}
                        return (text,(asterClock()-begin)*1000)
                    }
                    try job.check();let importStart = asterClock();_ = try asterInvoke(context,"nativeAsyncCheckpointImport",[checkpoint.entry,rows.0])
                    job.metrics.captureMs += rows.1;job.metrics.targetCopyMs += (asterClock()-importStart)*1000;job.metrics.checkpointJSONBytes += rows.0.utf8.count
                    offset += count;imported += count;job.sampleMemory();job.report(BaroChartAsyncProgress(phase:"checkpoints",done:imported,total:totalCheckpoints))
                }
            }
            try job.check();let computeStart = asterClock();_ = try asterInvoke(context,"nativeAsyncStart")
            var lastProgress = 0.0
            while true {
                try job.check()
                let state = try asterDictionary(asterInvoke(context,"nativeAsyncStep",[4096]))
                guard let phase = state["phase"] as? String,["generate","validate","store-index","calculate","indices","ready"].contains(phase),let complete = state["complete"] as? Bool else {throw BaroChartAsyncError.invalidProtocol("Invalid compute progress")}
                let done = try asterInteger(state["done"]),total = try asterInteger(state["total"])
                guard done <= total else {throw BaroChartAsyncError.invalidProtocol("Invalid progress bounds")}
                let now = asterClock();if complete || now-lastProgress >= 0.016 {job.report(BaroChartAsyncProgress(phase:phase,done:done,total:total));lastProgress = now;job.sampleMemory()}
                if complete {break}
            }
            job.metrics.computeMs = (asterClock()-computeStart)*1000;try job.check();job.sampleMemory()
            // UI/history is captured after numeric computation, with one
            // bounded owner response in flight. Restore/validate on the worker
            // before its VM is handed to the owner; no large owner JSON parse.
            let header:(String,Double)=try job.sourceChunk { source in
                let begin=asterClock();guard let text=try asterInvoke(source,"nativeAsyncUIBegin",[plan.ticket]).toString(),text.utf8.count<=1048576 else{throw BaroChartAsyncError.invalidProtocol("Oversized UI header")};return (text,(asterClock()-begin)*1000)
            }
            job.metrics.uiStateMs += header.1;job.metrics.uiTransferBytes += header.0.utf8.count;job.metrics.maximumUIChunkBytes=max(job.metrics.maximumUIChunkBytes,header.0.utf8.count)
            let headerStart=asterClock(),headerObject=try asterDictionary(header.0,maximumBytes:1048576)
            guard let state=headerObject["state"] as? [String:Any],let drawings=state["drawings"] as? [String:Any],let frames=drawings["frameCounts"] as? [Any],frames.count<=20001 else{throw BaroChartAsyncError.invalidProtocol("UI drawing frame counts")}
            var uiTotal=0;for value in frames{let n=try asterInteger(value,10000);guard uiTotal<=5000000-n else{throw BaroChartAsyncError.invalidProtocol("UI reference budget")};uiTotal += n}
            _=try asterInvoke(context,"nativeAsyncUIImportBegin",[header.0]);job.metrics.workerUIImportMs += (asterClock()-headerStart)*1000
            var uiChunks=0,uiReferences=0
            job.report(BaroChartAsyncProgress(phase:"ui-copy",done:0,total:uiTotal))
            while true {
                try job.check()
                let chunk:(String,Double)=try job.sourceChunk { source in
                    let begin=asterClock();guard let text=try asterInvoke(source,"nativeAsyncUINext",[plan.ticket]).toString(),text.utf8.count<=1048576 else{throw BaroChartAsyncError.invalidProtocol("Oversized UI chunk")};return (text,(asterClock()-begin)*1000)
                }
                try job.check();job.metrics.uiStateMs += chunk.1;job.metrics.uiTransferBytes += chunk.0.utf8.count;job.metrics.maximumUIChunkBytes=max(job.metrics.maximumUIChunkBytes,chunk.0.utf8.count)
                let importStart=asterClock(),state=try asterDictionary(chunk.0,maximumBytes:1048576)
                guard let flag=state["complete"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID() else{throw BaroChartAsyncError.invalidProtocol("UI completion boolean")}
                if flag.boolValue{job.metrics.workerUIImportMs += (asterClock()-importStart)*1000;break}
                guard let refs=state["refs"] as? [Any],refs.count>=1,refs.count<=64,uiReferences<=uiTotal-refs.count else{throw BaroChartAsyncError.invalidProtocol("UI reference chunk bounds")}
                try autoreleasepool{_=try asterInvoke(context,"nativeAsyncUIImportChunk",[chunk.0])};job.metrics.workerUIImportMs += (asterClock()-importStart)*1000
                uiChunks += 1;uiReferences += refs.count;job.metrics.uiChunkCount=uiChunks;job.sampleMemory();job.report(BaroChartAsyncProgress(phase:"ui-copy",done:uiReferences,total:uiTotal))
            }
            guard uiReferences==uiTotal else{throw BaroChartAsyncError.invalidProtocol("UI transfer incomplete")}
            try job.check();let endStart=asterClock();_=try asterInvoke(context,"nativeAsyncUIImportEnd");job.metrics.workerUIImportMs += (asterClock()-endStart)*1000
            job.report(BaroChartAsyncProgress(phase:"ui-copy",done:uiReferences,total:uiTotal));try job.check()
            return Prepared(context:context,plan:plan)
    }
    private func handoff(_ job: BaroChartAsyncJob, _ prepared: Prepared) {
        // This is queued only after compute() returned and its autorelease pool
        // drained. The creation run loop stays alive, with no worker JS calls.
        DispatchQueue.main.async { [self] in
            do {
                var source: BaroChartCoreRuntime? = try job.ownerSource();let uiStart = asterClock()
                _=try asterInvoke(source!,"nativeAsyncUICheck",[prepared.plan.ticket]);job.metrics.uiStateMs += (asterClock()-uiStart)*1000
                try job.check();let finishStart = asterClock();_ = try asterInvoke(prepared.context,"nativeAsyncFinish",[""]);job.metrics.finishMs = (asterClock()-finishStart)*1000
                _ = try job.ownerSource();try job.check()
                guard let engine = job.engine else {throw BaroChartAsyncError.sourceDeallocated}
                let commitStart = asterClock()
                try job.commit {
                    _ = try asterInvoke(source!,"nativeAsyncRelease",[prepared.plan.ticket]);job.ticket = nil
                    let previousRuntime = engine.contextRuntime
                    engine.coreRuntime = prepared.context;engine.contextRuntime = self
                    job.source = nil;previousRuntime?.retire()
                }
                source = nil // Release the old context before terminal timing/callback.
                job.metrics.commitMs = (asterClock()-commitStart)*1000
                job.sampleMemory();engine.notifyChanges();job.finish(.success(job.metrics))
            } catch {retire();job.finish(.failure(error))}
        }
    }
}

/// Thread-safe cancellation; all progress, completion and recovery are main-owned.
public final class BaroChartWorkspaceJob {
    private let lock = NSLock()
    private var cancelled = false, terminal = false, committed = false, finishing = false, callbackErrors = 0
    private var progressPending = false, latestProgress: BaroChartAsyncProgress?
    fileprivate weak var engine: BaroChartEngine?
    private var record: BaroChartWorkspaceSourceRecord?
    private var descriptor: BaroChartWorkspaceDescriptor?
    private var document: String?, binding: [String:Any]?
    private var targetRuntime: BaroChartWorkspaceRuntime?
    private var progress: ((BaroChartAsyncProgress) throws -> Void)?
    private var completion: ((Result<BaroChartWorkspaceMetrics,Error>) -> Void)?
    private let sourceRevision: UInt64, timeout: Double, maxBars: Int
    /// 원본 런타임의 백엔드. 복원 작업 스레드가 같은 백엔드로 대상 런타임을 만들 때 읽는다(바뀌지 않는다).
    fileprivate let sourceBackend: BaroChartRuntimeBackend
    private let started = asterClock()
    private var metrics = BaroChartWorkspaceMetrics()
    /// Identifier of this restore. It matches `registration` in ``BaroChartWorkspaceCleanupStatus``.
    public let registration: Int
    fileprivate init(engine: BaroChartEngine, record: BaroChartWorkspaceSourceRecord, document: String, binding: [String:Any], timeout: Double, maxBars: Int,
                     progress: ((BaroChartAsyncProgress) throws -> Void)?, completion: @escaping (Result<BaroChartWorkspaceMetrics,Error>) -> Void) {
        self.engine = engine;self.record = record;self.document = document;self.binding = binding;self.timeout = timeout;self.maxBars = maxBars
        self.progress = progress;self.completion = completion;sourceRevision = engine.revision;registration = record.registration;sourceBackend = engine.coreRuntime.backend
    }
    /// Requests cancellation. Safe from any thread; it has no effect once the restore has committed.
    public func cancel() {lock.lock();if !terminal && !committed {cancelled = true};lock.unlock()}
    /// Whether this restore's runtime cleanup is still pending. Main thread only.
    public var cleanupPending: Bool {precondition(Thread.isMainThread);return BaroChartWorkspaceRegistry.status().contains{$0.registration == registration}}
    fileprivate func check() throws {
        lock.lock();let stopped = cancelled, finished = terminal || finishing;lock.unlock()
        if stopped {throw BaroChartAsyncError.cancelled}
        if finished {throw BaroChartAsyncError.invalidProtocol("Workspace job completed")}
        if asterClock() - started >= timeout {throw BaroChartAsyncError.timedOut}
    }
    private func finalOwner() throws -> BaroChartEngine {
        precondition(Thread.isMainThread)
        guard let engine = engine else {throw BaroChartAsyncError.sourceDeallocated}
        guard !engine.closed && !engine.closing else {throw BaroChartAsyncError.engineClosed}
        guard engine.activeWorkspace === self, engine.revision == sourceRevision,
              let source = record?.context, engine.contextBacking === source else {throw BaroChartAsyncError.invalidProtocol("Workspace source stale")}
        return engine
    }
    private func sourceCall<T>(_ operation: (BaroChartCoreRuntime) throws -> T) throws -> T {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        let result: T = try autoreleasepool {
            guard let source = record?.context else {throw BaroChartAsyncError.invalidProtocol("Missing workspace source")}
            if let ticket = descriptor?.ticket {try asterWorkspaceTrue(asterInvoke(source,"nativeWorkspaceSourceCheck",[ticket,sourceRevision]))}
            return try operation(source)
        }
        try check();_ = try finalOwner();return result
    }
    fileprivate func start(bundle: String) {
        precondition(Thread.isMainThread)
        do {
            try check();_ = try finalOwner()
            guard let record = record, let document = document, let binding = binding else {throw BaroChartAsyncError.invalidProtocol("Missing workspace request")}
            record.began = true // registration can succeed before response fails
            let receipt = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceBegin",[document,binding,sourceRevision,asterWorkspaceMaxBytes,registration]))}
            guard try asterInteger(receipt["registration"],9007199254740991) == registration else {throw BaroChartAsyncError.invalidProtocol("Workspace registration binding")}
            let ticket = try asterInteger(receipt["ticket"],9007199254740991)
            guard ticket > 0 else {throw BaroChartAsyncError.invalidProtocol("Workspace ticket")}
            self.document = nil;self.binding = nil;admit(ticket:ticket,bundle:bundle)
        } catch {fail(error)}
    }
    private func admit(ticket: Int, bundle: String) {
        precondition(Thread.isMainThread)
        do {
            let value = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceStep",[ticket,8,sourceRevision]))}
            let complete = try asterWorkspaceBool(value["complete"]), done = try asterInteger(value["done"],9007199254740991)
            if !complete {
                guard value["phase"] as? String == "admission" else {throw BaroChartAsyncError.invalidProtocol("Workspace admission phase")}
                report(BaroChartAsyncProgress(phase:"admission",done:done,total:done))
                DispatchQueue.main.async { [self] in admit(ticket:ticket,bundle:bundle) };return
            }
            let plan = try BaroChartWorkspaceDescriptor(value,ticket:ticket)
            guard let record = record else {throw BaroChartAsyncError.invalidProtocol("Missing source reservation")}
            try BaroChartWorkspaceRegistry.admit(record,plan.bytes);descriptor = plan;metrics.logicalAdmissionBytes = plan.bytes
            try check();_ = try finalOwner()
            let runtime = BaroChartWorkspaceRuntime(bundle:bundle,job:self,plan:plan,maxBars:maxBars)
            targetRuntime = runtime;runtime.start()
        } catch {fail(error)}
    }
    fileprivate func capture(slot: Int, offset: Int, count: Int) throws -> Data {
        let box = BaroChartWorkspaceCaptureBox<Data>()
        DispatchQueue.main.async { [self] in
            do {
                let data = try sourceCall { source -> Data in
                    guard let ticket = descriptor?.ticket else {throw BaroChartAsyncError.invalidProtocol("Missing workspace descriptor")}
                    return try source.readFloat64Data("nativeAsyncBuffer",[ticket,slot,offset,count],count:count)
                }
                box.resolve(.success(data))
            } catch {box.resolve(.failure(error))}
        }
        return try box.wait(self)
    }
    fileprivate func report(_ value: BaroChartAsyncProgress) {
        lock.lock();if terminal {lock.unlock();return};latestProgress = value
        if progressPending {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress, finished = terminal;progressPending = false;lock.unlock()
            guard !finished, let value = value, let progress = progress else {return}
            do {try progress(value)} catch {lock.lock();callbackErrors = min(32,callbackErrors + 1);lock.unlock()}
        }
    }
    fileprivate func install(_ context: BaroChartCoreRuntime, runtime: BaroChartWorkspaceRuntime, copied: Int) throws -> BaroChartEngine {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        guard let record = record, let plan = descriptor else {throw BaroChartAsyncError.invalidProtocol("Missing workspace handoff")}
        let receipt = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceFinish",[plan.ticket,sourceRevision]))}
        guard receipt["schema"] as? String == "aster.native-workspace-source-finished",
              try asterInteger(receipt["version"],1) == 1, try asterInteger(receipt["ticket"],9007199254740991) == plan.ticket,
              try asterInteger(receipt["revision"],9007199254740991) == Int(sourceRevision) else {throw BaroChartAsyncError.invalidProtocol("Workspace finish binding")}
        record.released = true
        // Strong locals ensure no last ARC context/runtime release inside lock.
        var oldContext = record.context
        var oldRuntime = engine?.contextRuntime
        lock.lock()
        do {
            if cancelled {throw BaroChartAsyncError.cancelled}
            guard !terminal && !committed && !finishing else {throw BaroChartAsyncError.invalidProtocol("Repeated workspace commit")}
            if asterClock() - started >= timeout {throw BaroChartAsyncError.timedOut}
            let owner = try finalOwner() // callback-free property checks only
            owner.contextBacking = context;owner.workspaceContextInstalled = true;owner.contextRuntime = runtime
            committed = true;lock.unlock()
            metrics.copiedBytes = copied;targetRuntime = nil
            withExtendedLifetime(oldContext) {};oldContext = nil
            oldRuntime?.retire();oldRuntime = nil // lease still prevents shutdown
            return owner
        } catch {lock.unlock();withExtendedLifetime(oldContext) {};withExtendedLifetime(oldRuntime) {};throw error}
    }
    fileprivate func succeed(_ owner: BaroChartEngine) {
        precondition(Thread.isMainThread)
        guard let record = record else {preconditionFailure("Committed source reservation missing")}
        // Target delivery aliases have drained. Busy/bytes remain held through
        // retired-source creator acknowledgment, then release before observers.
        BaroChartWorkspaceRegistry.remove(record) { [self] in
            self.record = nil;descriptor = nil;finish(.success(metrics),notify:owner)
        }
    }
    fileprivate func fail(_ error: Error) {
        precondition(Thread.isMainThread)
        lock.lock();let done = terminal || committed || finishing;if !done {finishing = true};lock.unlock();if done {return}
        if let record = record {
            do {
                try record.abort()
                BaroChartWorkspaceRegistry.remove(record) { [self] in
                    self.record = nil;descriptor = nil;targetRuntime = nil
                    finish(.failure(error),notify:nil)
                }
                return
            } catch {
                record.pending = true;record.failures = min(32,record.failures + 1)
                engine?.pendingWorkspaceRegistration = registration
                self.record = nil;descriptor = nil;targetRuntime = nil
                finish(.failure(BaroChartWorkspaceError.cleanupPending(registration:registration)),notify:nil)
                return
            }
        }
        descriptor = nil;targetRuntime = nil;finish(.failure(error),notify:nil)
    }
    private func finish(_ result: Result<BaroChartWorkspaceMetrics,Error>, notify owner: BaroChartEngine?) {
        precondition(Thread.isMainThread)
        lock.lock();if terminal {lock.unlock();return};terminal = true;metrics.progressCallbackErrors = callbackErrors;latestProgress = nil;lock.unlock()
        if let engine = engine, engine.activeWorkspace === self {engine.activeWorkspace = nil}
        document = nil;binding = nil;descriptor = nil
        let callback = completion;completion = nil;progress = nil;metrics.totalMs = (asterClock()-started)*1000
        owner?.notifyChanges()
        switch result {case .success:callback?(.success(metrics));case .failure(let error):callback?(.failure(error))}
    }
}
private final class BaroChartWorkspaceCaptureBox<T> {
    private let condition = NSCondition()
    private var result: Result<T,Error>?
    func resolve(_ value: Result<T,Error>) {condition.lock();result = value;condition.signal();condition.unlock()}
    func wait(_ job: BaroChartWorkspaceJob) throws -> T {
        condition.lock();defer {condition.unlock()}
        while result == nil {_ = condition.wait(until:Date(timeIntervalSinceNow:0.02));try job.check()}
        return try result!.get()
    }
}
// Ownership box is populated on the worker and used only on main after enqueue.
// Its explicit nil removes the delivery alias before observers can close Engine.
private final class BaroChartWorkspaceDelivery {
    var context: BaroChartCoreRuntime?
    init(_ context: BaroChartCoreRuntime?) {self.context = context}
}
private final class BaroChartWorkspaceRuntime: BaroChartContextRuntime {
    private let retirement = BaroChartRuntimeRetirement()
    private let cleanupLock = NSLock()
    private var afterCreatorCleanup: (() -> Void)?
    private var initialJob: BaroChartWorkspaceJob?
    private var initialPlan: BaroChartWorkspaceDescriptor?
    private var ownedContext: BaroChartCoreRuntime? // accessed/cleared only on creator
    private let bundle: String, maxBars: Int
    init(bundle: String, job: BaroChartWorkspaceJob, plan: BaroChartWorkspaceDescriptor, maxBars: Int) {
        self.bundle = bundle;initialJob = job;initialPlan = plan;self.maxBars = maxBars
    }
    func retire() {retirement.retire()}
    private func failAfterCreatorCleanup(_ job: BaroChartWorkspaceJob, _ error: Error) {
        cleanupLock.lock();precondition(afterCreatorCleanup == nil)
        afterCreatorCleanup = {job.fail(error)};cleanupLock.unlock();retire()
    }
    func acquireCaptureLease() -> Bool {retirement.acquire()}
    func releaseCaptureLease() {retirement.release()}
    func releaseCaptureLease(afterRetirementIfNeeded completion: @escaping () -> Void) {retirement.release(completion)}
    func start() {let thread = Thread { [self] in run() };thread.name = "Aster workspace JavaScriptCore";thread.qualityOfService = .userInitiated;thread.start()}
    private func run() {
        let port = Port();RunLoop.current.add(port,forMode:.default);retirement.install(CFRunLoopGetCurrent())
        performInitialJob()
        while !retirement.shouldStop {_ = RunLoop.current.run(mode:.default,before:.distantFuture)}
        autoreleasepool {ownedContext = nil}
        RunLoop.current.remove(port,forMode:.default);port.invalidate();retirement.install(nil);retirement.didFinish()
        cleanupLock.lock();let completion = afterCreatorCleanup;afterCreatorCleanup = nil;cleanupLock.unlock()
        if let completion = completion {DispatchQueue.main.async(execute:completion)}
    }
    private func performInitialJob() {
        guard let job = initialJob, let plan = initialPlan else {retire();return}
        initialJob = nil;initialPlan = nil
        var outcome: Result<Int,Error>!
        autoreleasepool {do {outcome = .success(try compute(job,plan))} catch {outcome = .failure(error)}}
        switch outcome! {
        case .success(let copied):
            let delivery = BaroChartWorkspaceDelivery(ownedContext)
            DispatchQueue.main.async { [self] in
                do {
                    let owner = try autoreleasepool { () throws -> BaroChartEngine in
                        guard let context = delivery.context else {throw BaroChartLowLevelError.unavailableContext}
                        return try job.install(context,runtime:self,copied:copied)
                    }
                    delivery.context = nil;job.succeed(owner)
                } catch {delivery.context = nil;failAfterCreatorCleanup(job,error)}
            }
        case .failure(let error):failAfterCreatorCleanup(job,error)
        }
        outcome = nil
    }
    private func compute(_ job: BaroChartWorkspaceJob, _ plan: BaroChartWorkspaceDescriptor) throws -> Int {
        try job.check()
        guard let context = BaroChartRuntimeFactory.makeIsolated(like: job.sourceBackend) else {throw BaroChartLowLevelError.unavailableContext}
        ownedContext = context
        if let exception = context.evaluateBundle(bundle) {throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Workspace bundle")}
        try job.check();try asterWorkspaceTrue(asterInvoke(context,"nativeWorkspaceTargetCreate",[plan.metadata]))
        var copied = 0
        for slot in 0..<6 {
            var offset = 0
            while offset < plan.length {
                try job.check();let count = min(262144,plan.length-offset)
                let data = try job.capture(slot:slot,offset:offset,count:count);try job.check()
                try autoreleasepool {
                    try data.withUnsafeBytes {bytes in try context.writeFloat64("nativeAsyncTargetBuffer",[slot,offset,count],from:bytes.baseAddress!,count:count)}
                }
                copied += data.count;offset += count;job.report(BaroChartAsyncProgress(phase:"capture",done:copied,total:plan.length*48))
            }
        }
        try job.check();try asterWorkspaceTrue(asterInvoke(context,"nativeAsyncStart"))
        while true {
            try job.check()
            let state = try autoreleasepool {try asterDictionary(asterInvoke(context,"nativeAsyncStep",[maxBars]))}
            guard let phase = state["phase"] as? String, ["validate","store-index","calculate","indices","workspace-checkpoints","workspace-ready"].contains(phase) else {throw BaroChartAsyncError.invalidProtocol("Workspace target phase")}
            let done = try asterInteger(state["done"],9007199254740991), total = try asterInteger(state["total"],9007199254740991)
            let complete = try asterWorkspaceBool(state["complete"])
            guard complete == (phase == "workspace-ready"), done <= total else {throw BaroChartAsyncError.invalidProtocol("Workspace target progress")}
            job.report(BaroChartAsyncProgress(phase:phase,done:done,total:total));if complete {break}
        }
        try job.check()
        let receipt = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeWorkspaceTargetFinish"))}
        guard receipt["schema"] as? String == "aster.native-workspace-target-ready",try asterInteger(receipt["version"],1) == 1,
              receipt["status"] as? String == "target-ready",try asterWorkspaceBool(receipt["hostPublished"]) == false,
              let targetPlan = receipt["plan"] as? [String:Any],try asterInteger(targetPlan["totalBytes"],asterWorkspaceMaxBytes) == plan.bytes else {throw BaroChartAsyncError.invalidProtocol("Workspace target finish binding")}
        try job.check();return copied
    }
}

/// Native JavaScriptCore host; no browser, WKWebView or DOM is involved.
/// Call from one owning thread (normally the UI thread).
/// Publication and cleanup are independent. Unknown is never permission to retry
/// the mutation. Use retryParamsCleanup with the original registration instead.
public enum BaroChartParamsCommitOutcome: String {case notCommitted, committed, unchanged, unknown}
/// Thrown when a parameter job finished but runtime cleanup is still pending. `outcome` tells whether the parameters were published; retry cleanup with the original registration, never the mutation.
public enum BaroChartParamsError: Error {case cleanupPending(registration: Int, outcome: BaroChartParamsCommitOutcome)}
/// State of one parameter job whose runtime cleanup is still pending. Read it with ``BaroChartEngine/paramsCleanupStatus()``.
public struct BaroChartParamsStatus {
    /// `registration` identifies the job, `admittedLogicalBytes` is the logical size admitted against the native budget, and `retryFailures` counts failed cleanup attempts.
    public let registration, admittedLogicalBytes, retryFailures: Int
    /// Whether the parameters were published.
    public let outcome: BaroChartParamsCommitOutcome
    /// `cleanupPending` is true while runtime cleanup has not finished; `awaitingCreatorCleanup` is true while the creating runtime has not yet finished its own cleanup.
    public let cleanupPending, awaitingCreatorCleanup: Bool
}
/// Measurements of a finished parameter job. Byte counts are logical sizes, not process footprint; `totalMs` is in milliseconds.
public struct BaroChartParamsMetrics {
    /// Bytes copied, logical bytes admitted against the native budget, and the number of times the progress callback threw.
    public internal(set) var copiedBytes = 0, logicalAdmissionBytes = 0, progressCallbackErrors = 0
    /// Total duration of the job in milliseconds.
    public internal(set) var totalMs = 0.0
    /// Whether the parameters were published.
    public internal(set) var outcome: BaroChartParamsCommitOutcome = .notCommitted
}
// Main-only minimal recovery owner. Client callbacks and Error are never stored.
private final class BaroChartParamsSourceRecord {
    let registration: Int, id: String, admission: BaroChartNativeAdmissionLease
    var context: BaroChartCoreRuntime?
    private var runtime: BaroChartContextRuntime?
    weak var sourceIdentity: BaroChartCoreRuntime?
    weak var engine: BaroChartEngine?
    weak var job: BaroChartParamsJob?
    var began = false, released = false, pending = false, retrying = false, detaching = false, notified = false
    var failures = 0
    var outcome: BaroChartParamsCommitOutcome = .notCommitted
    init(registration: Int, id: String, engine: BaroChartEngine, context: BaroChartCoreRuntime, runtime: BaroChartContextRuntime?, admission: BaroChartNativeAdmissionLease) throws {
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw BaroChartAsyncError.invalidProtocol("Source runtime is retiring")}
        self.registration = registration;self.id = id;self.engine = engine;self.context = context;sourceIdentity = context
        self.runtime = runtime;self.admission = admission
    }
    func statusValue() -> BaroChartParamsStatus {
        precondition(Thread.isMainThread)
        return BaroChartParamsStatus(registration:registration,admittedLogicalBytes:admission.bytes,retryFailures:failures,outcome:outcome,cleanupPending:pending || detaching,awaitingCreatorCleanup:detaching)
    }
    // Null, malformed, mismatched and evicted receipts remain uncertain.
    @discardableResult func accept(_ value: BaroChartCoreValue) throws -> String {
        precondition(Thread.isMainThread)
        let object = try asterWorkspaceObject(value)
        guard try asterInteger(object["registration"],9007199254740991) == registration,
              let status = object["status"] as? String,
              ["active","committed","unchanged","failed","aborted"].contains(status) else {throw BaroChartAsyncError.invalidProtocol("Params status binding")}
        if status == "committed" || status == "unchanged" {
            guard let receipt = object["receipt"] as? [String:Any], receipt["schema"] as? String == "aster.native-params-published",
                  try asterInteger(receipt["version"],1) == 1,
                  try asterInteger(receipt["registration"],9007199254740991) == registration,
                  receipt["id"] as? String == id, receipt["status"] as? String == status,
                  let outputs = receipt["outputs"] as? [String], !outputs.isEmpty, outputs.count <= 32,
                  Set(outputs).count == outputs.count, outputs.allSatisfy({!$0.isEmpty && $0.utf16.count <= 128}),
                  let offsets = receipt["plotOffsets"] as? [String:Any], offsets.count <= outputs.count else {throw BaroChartAsyncError.invalidProtocol("Params published receipt")}
            for (key,value) in offsets {
                guard outputs.contains(key), let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite, abs(number.doubleValue) <= 10000,
                      number.doubleValue.rounded(.towardZero) == number.doubleValue else {throw BaroChartAsyncError.invalidProtocol("Params offset receipt")}
            }
            outcome = status == "committed" ? .committed : .unchanged;released = true
        } else if status == "failed" || status == "aborted" {outcome = .notCommitted;released = true}
        job?.setOutcome(outcome)
        return status
    }
    func recover() throws {
        precondition(Thread.isMainThread)
        if released {return}
        if !began {released = true;return}
        try autoreleasepool {
            guard let context = context else {throw BaroChartAsyncError.invalidProtocol("Missing params source")}
            let status = try accept(asterInvoke(context,"nativeParamsSourceStatus",[registration]))
            if status == "active" {
                _ = try accept(asterInvoke(context,"nativeParamsSourceAbort",[registration]))
            }
            guard released else {throw BaroChartAsyncError.invalidProtocol("Params release not confirmed")}
        }
    }
    func detach(_ completion: @escaping () -> Void) {
        precondition(Thread.isMainThread && released && !detaching)
        detaching = true;context = nil
        let owner = runtime;runtime = nil
        if let owner = owner {owner.releaseCaptureLease(afterRetirementIfNeeded:completion)} else {completion()}
    }
}
private enum BaroChartParamsRegistry {
    private static var records: [Int:BaroChartParamsSourceRecord] = [:]
    private static var next = 0
    static func reserve(_ engine: BaroChartEngine, _ id: String, _ context: BaroChartCoreRuntime, _ runtime: BaroChartContextRuntime?) throws -> BaroChartParamsSourceRecord {
        precondition(Thread.isMainThread)
        guard next < 9007199254740991 else {throw BaroChartAsyncError.busy}
        let admission = try BaroChartNativeAdmission.reserve();next += 1
        do {
            let record = try BaroChartParamsSourceRecord(registration:next,id:id,engine:engine,context:context,runtime:runtime,admission:admission)
            records[record.registration] = record;return record
        } catch {BaroChartNativeAdmission.release(admission);throw error}
    }
    static func contains(_ registration: Int) -> Bool {precondition(Thread.isMainThread);return records[registration] != nil}
    static func status(_ registration: Int? = nil) -> [BaroChartParamsStatus] {
        precondition(Thread.isMainThread)
        return records.values.filter{registration == nil || $0.registration == registration}.sorted{$0.registration < $1.registration}.map{$0.statusValue()}
    }
    static func remove(_ record: BaroChartParamsSourceRecord, completion: @escaping () -> Void = {}) {
        precondition(Thread.isMainThread && record.released)
        guard records[record.registration] === record, !record.detaching else {return}
        record.detach {
            precondition(Thread.isMainThread)
            guard records[record.registration] === record else {return}
            records.removeValue(forKey:record.registration);BaroChartNativeAdmission.release(record.admission)
            record.detaching = false;record.pending = false
            let owner = record.engine
            if owner?.pendingParamsRegistration == record.registration {owner?.pendingParamsRegistration = nil}
            if owner?.activeParams === record.job {owner?.activeParams = nil}
            record.job?.setOutcome(record.outcome)
            // Both admission and busy are released before any observer reentry.
            if record.outcome == .committed && !record.notified {
                record.notified = true
                let shouldNotify: Bool = autoreleasepool {
                    guard let owner = owner, !owner.closed, !owner.closing, let source = record.sourceIdentity else {return false}
                    return owner.contextBacking === source
                }
                // No temporary source JSContext alias survives into observers.
                if shouldNotify {owner?.notifyChanges()}
            }
            completion()
        }
    }
    // One attempt only; closed Engine is not proof of JSContext destruction.
    static func retry(_ registration: Int? = nil) -> [BaroChartParamsStatus] {
        precondition(Thread.isMainThread)
        var results: [BaroChartParamsStatus] = []
        for record in Array(records.values).sorted(by:{$0.registration < $1.registration}) where record.pending && !record.retrying && !record.detaching && (registration == nil || registration == record.registration) {
            record.retrying = true
            do {try record.recover();record.retrying = false;remove(record)}
            catch {record.retrying = false;record.failures = min(32,record.failures + 1)}
            results.append(record.statusValue())
        }
        return results
    }
}
private struct BaroChartParamsPlan {
    let ticket, length, capacity, bytes: Int
    let metadata: String
    init(_ object: [String:Any], ticket: Int, registration: Int, id: String) throws {
        guard object["phase"] as? String == "copy", let text = object["metadataJSON"] as? String, text.utf16.count <= 131072,
              let plan = object["plan"] as? [String:Any] else {throw BaroChartAsyncError.invalidProtocol("Params admission descriptor")}
        let binding = try asterDictionary(text,maximumBytes:524288)
        guard binding["schema"] as? String == "aster.native-params-target", try asterInteger(binding["version"],1) == 1,
              try asterInteger(binding["registration"],9007199254740991) == registration, binding["id"] as? String == id else {throw BaroChartAsyncError.invalidProtocol("Params metadata binding")}
        length = try asterInteger(binding["length"],4194304);capacity = try asterInteger(binding["capacity"],4194304)
        guard capacity >= max(16,length), capacity & (capacity - 1) == 0 else {throw BaroChartAsyncError.invalidProtocol("Params capacity")}
        bytes = try asterInteger(plan["totalBytes"],asterWorkspaceMaxBytes)
        guard bytes > 0 else {throw BaroChartAsyncError.invalidProtocol("Params admission bytes")}
        self.ticket = ticket;metadata = text
    }
}
private final class BaroChartParamsBox<T> {
    private let condition = NSCondition()
    private var result: Result<T,Error>?
    func resolve(_ result: Result<T,Error>) {condition.lock();if self.result == nil {self.result = result;condition.broadcast()};condition.unlock()}
    func wait(_ job: BaroChartParamsJob) throws -> T {
        condition.lock();defer {condition.unlock()}
        while result == nil {condition.unlock();do {try job.check()} catch {condition.lock();throw error};condition.lock();if result == nil {_ = condition.wait(until:Date(timeIntervalSinceNow:0.02))}}
        return try result!.get()
    }
}
/// Cancellation is thread-safe. Status and explicit recovery are main-owned.
/// cleanupPending is a single completion, not a retryable mutation failure.
public final class BaroChartParamsJob {
    private let lock = NSLock()
    private var cancelled = false, terminal = false, publishing = false, finishing = false
    private var progressPending = false, latestProgress: BaroChartAsyncProgress?, callbackErrors = 0
    private var outcome: BaroChartParamsCommitOutcome = .notCommitted
    fileprivate weak var engine: BaroChartEngine?
    private var record: BaroChartParamsSourceRecord?
    private var params: [String:Any]?
    private var plan: BaroChartParamsPlan?
    private var progress: ((BaroChartAsyncProgress) throws -> Void)?
    private var completion: ((Result<BaroChartParamsMetrics,Error>) -> Void)?
    private let sourceRevision: UInt64, timeout: Double, maxBars: Int
    /// 원본 런타임의 백엔드. params 작업 스레드가 같은 백엔드로 대상 런타임을 만들 때 읽는다(바뀌지 않는다).
    private let sourceBackend: BaroChartRuntimeBackend
    private let started = asterClock()
    private var metrics = BaroChartParamsMetrics()
    /// Identifier of this job. It matches `registration` in ``BaroChartParamsStatus``.
    public let registration: Int
    fileprivate init(engine: BaroChartEngine, record: BaroChartParamsSourceRecord, params: [String:Any], timeout: Double, maxBars: Int,
                     progress: ((BaroChartAsyncProgress) throws -> Void)?, completion: @escaping (Result<BaroChartParamsMetrics,Error>) -> Void) {
        self.engine = engine;self.record = record;self.params = params;self.timeout = timeout;self.maxBars = maxBars
        self.progress = progress;self.completion = completion;sourceRevision = engine.revision;registration = record.registration;sourceBackend = engine.coreRuntime.backend;record.job = self
    }
    /// Requests cancellation. Safe from any thread; it has no effect once publication has started.
    public func cancel() {lock.lock();if !terminal && !publishing {cancelled = true};lock.unlock()}
    /// Whether the parameters were published. Safe to read from any thread.
    public var commitOutcome: BaroChartParamsCommitOutcome {lock.lock();defer {lock.unlock()};return outcome}
    /// Whether this job's runtime cleanup is still pending. Main thread only.
    public var cleanupPending: Bool {precondition(Thread.isMainThread);return BaroChartParamsRegistry.status(registration).contains{$0.cleanupPending}}
    /// Retries this job's cleanup once and returns the resulting statuses. Throws ``BaroChartAsyncError`` (main-owner required) when not called on the main thread.
    @discardableResult public func retryCleanup() throws -> [BaroChartParamsStatus] {
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        return BaroChartParamsRegistry.retry(registration)
    }
    fileprivate func setOutcome(_ value: BaroChartParamsCommitOutcome) {lock.lock();outcome = value;lock.unlock()}
    fileprivate func check() throws {
        lock.lock();let stopped = cancelled, done = terminal || finishing;lock.unlock()
        if stopped {throw BaroChartAsyncError.cancelled}
        if done {throw BaroChartAsyncError.invalidProtocol("Params job completed")}
        if asterClock() - started >= timeout {throw BaroChartAsyncError.timedOut}
    }
    private func finalOwner() throws -> BaroChartEngine {
        precondition(Thread.isMainThread)
        guard let engine = engine else {throw BaroChartAsyncError.sourceDeallocated}
        guard !engine.closed, !engine.closing else {throw BaroChartAsyncError.engineClosed}
        guard engine.activeParams === self, engine.revision == sourceRevision,
              let source = record?.context, engine.contextBacking === source else {throw BaroChartAsyncError.invalidProtocol("Params source stale")}
        return engine
    }
    private func sourceCall<T>(_ operation: (BaroChartCoreRuntime) throws -> T) throws -> T {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        let result: T = try autoreleasepool {
            guard let source = record?.context else {throw BaroChartAsyncError.invalidProtocol("Missing params source")}
            if let ticket = plan?.ticket {try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceCheck",[ticket,sourceRevision]))}
            return try operation(source)
        }
        try check();_ = try finalOwner();return result
    }
    private func onOwner<T>(_ operation: @escaping (BaroChartCoreRuntime) throws -> T) throws -> T {
        let box = BaroChartParamsBox<T>()
        DispatchQueue.main.async { [self] in
            do {box.resolve(.success(try sourceCall(operation)))} catch {box.resolve(.failure(error))}
        }
        return try box.wait(self)
    }
    fileprivate func start(bundle: String) {
        precondition(Thread.isMainThread)
        do {
            try check();_ = try finalOwner()
            guard let record = record, let params = params else {throw BaroChartAsyncError.invalidProtocol("Missing params request")}
            record.began = true
            let begin = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeParamsSourceBegin",[record.id,params,sourceRevision,asterWorkspaceMaxBytes,registration]))}
            guard try asterInteger(begin["registration"],9007199254740991) == registration else {throw BaroChartAsyncError.invalidProtocol("Params registration")}
            let ticket = try asterInteger(begin["ticket"],9007199254740991)
            guard ticket > 0 else {throw BaroChartAsyncError.invalidProtocol("Params ticket")}
            self.params = nil;admit(ticket:ticket,bundle:bundle)
        } catch {settle(error)}
    }
    private func admit(ticket: Int, bundle: String) {
        precondition(Thread.isMainThread)
        do {
            let value = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeParamsSourceStep",[ticket,8,sourceRevision]))}
            guard let record = record else {throw BaroChartAsyncError.invalidProtocol("Missing params reservation")}
            let complete = try asterWorkspaceBool(value["complete"])
            if !complete {
                guard value["phase"] as? String == "admission" else {throw BaroChartAsyncError.invalidProtocol("Params admission phase")}
                DispatchQueue.main.async { [self] in admit(ticket:ticket,bundle:bundle) };return
            }
            if value["phase"] as? String == "noop" {publish(ticket:ticket);return}
            let plan = try BaroChartParamsPlan(value,ticket:ticket,registration:registration,id:record.id)
            try BaroChartNativeAdmission.admit(record.admission,plan.bytes);self.plan = plan;metrics.logicalAdmissionBytes = plan.bytes
            try check();_ = try finalOwner()
            Thread.detachNewThread { [self] in
                // Only owned Swift scalars/Data/String cross the VM boundary.
                // No worker JS alias escapes this entire autorelease pool.
                let result: Result<Int,Error> = autoreleasepool {
                    do {return .success(try compute(bundle:bundle,plan:plan))} catch {return .failure(error)}
                }
                DispatchQueue.main.async { [self] in
                    switch result {
                    case .success(let copied):metrics.copiedBytes = copied;publish(ticket:ticket)
                    case .failure(let error):settle(error)
                    }
                }
            }
        } catch {settle(error)}
    }
    private func report(_ value: BaroChartAsyncProgress) {
        lock.lock();if terminal || publishing || finishing {lock.unlock();return};latestProgress = value
        if progressPending {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress, done = terminal || publishing || finishing;progressPending = false;lock.unlock()
            guard !done, let value = value, let progress = progress else {return}
            do {try progress(value)} catch {lock.lock();callbackErrors = min(32,callbackErrors + 1);lock.unlock()}
        }
    }
    private func compute(bundle: String, plan: BaroChartParamsPlan) throws -> Int {
        try check()
        guard let context = BaroChartRuntimeFactory.makeIsolated(like: sourceBackend) else {throw BaroChartLowLevelError.unavailableContext}
        if let error = context.evaluateBundle(bundle) {throw BaroChartLowLevelError.javaScript(error.toString() ?? "Worker initialization")}
        try check();try asterWorkspaceTrue(asterInvoke(context,"nativeParamsTargetCreate",[plan.metadata]))
        var copied = 0
        for slot in 0..<6 {
            var offset = 0
            while offset < plan.length {
                try check();let count = min(16384,plan.length-offset), at = offset
                let data: Data = try onOwner { source in
                    try source.readFloat64Data("nativeAsyncBuffer",[plan.ticket,slot,at,count],count:count)
                }
                try check()
                try autoreleasepool {
                    try data.withUnsafeBytes { bytes in try context.writeFloat64("nativeAsyncTargetBuffer",[slot,offset,count],from:bytes.baseAddress!,count:count) }
                }
                copied += data.count;offset += count
            }
        }
        try asterWorkspaceTrue(asterInvoke(context,"nativeParamsTargetStart"))
        while true {
            try check()
            let step = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeParamsTargetStep",[maxBars]))}
            let complete = try asterWorkspaceBool(step["complete"])
            guard let phase = step["phase"] as? String, ["validate","calculate","outputs","ready"].contains(phase), complete == (phase == "ready") else {throw BaroChartAsyncError.invalidProtocol("Params target phase")}
            let done = try asterInteger(step["done"],134217728), total = try asterInteger(step["total"],134217728)
            guard done <= total else {throw BaroChartAsyncError.invalidProtocol("Params target progress")}
            if complete {break}
            report(BaroChartAsyncProgress(phase:phase,done:done,total:total))
        }
        let text: String = try autoreleasepool {
            let value = try asterInvoke(context,"nativeParamsTargetDescriptor")
            guard value.isString, let text = value.toString(), text.utf16.count <= 131072 else {throw BaroChartAsyncError.invalidProtocol("Params result descriptor")}
            return text
        }
        let descriptor = try asterDictionary(text,maximumBytes:524288)
        guard descriptor["schema"] as? String == "aster.native-params-result", try asterInteger(descriptor["version"],1) == 1,
              try asterInteger(descriptor["registration"],9007199254740991) == registration,
              try asterInteger(descriptor["length"],4194304) == plan.length, try asterInteger(descriptor["capacity"],4194304) == plan.capacity,
              let outputs = descriptor["outputs"] as? [String], !outputs.isEmpty, outputs.count <= 32,
              plan.capacity * outputs.count * 8 <= 256*1024*1024 else {throw BaroChartAsyncError.invalidProtocol("Params result bounds")}
        let checkpointCount = try asterInteger(descriptor["checkpointCount"],16385)
        guard checkpointCount == (plan.length == 0 ? 0 : plan.length/256+1), try asterInteger(descriptor["checkpointBytes"],32*1024*1024) >= 0 else {throw BaroChartAsyncError.invalidProtocol("Params checkpoint count")}
        let _: Bool = try onOwner { source in try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceReceive",[plan.ticket,text,self.sourceRevision]));return true }
        for slot in outputs.indices {
            var offset = 0
            while offset < plan.capacity {
                try check();let count = min(16384,plan.capacity-offset), at = offset
                let data: Data = try autoreleasepool {
                    try context.readFloat64Data("nativeAsyncBuffer",[registration,slot,at,count],count:count)
                }
                let _: Bool = try onOwner { source in
                    try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceArmWrite",[plan.ticket,slot,at,count,self.sourceRevision]))
                    // Arm and binary write execute in one owner turn; no queued write.
                    try data.withUnsafeBytes { bytes in try source.writeFloat64("nativeAsyncTargetBuffer",[slot,at,count],from:bytes.baseAddress!,count:count) };return true
                }
                copied += data.count;offset += count
            }
        }
        for ordinal in 0..<checkpointCount {
            try check()
            let row = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeParamsTargetCheckpoint",[ordinal]))}
            guard try asterInteger(row["index"],4194304) == ordinal*256, let text = row["text"] as? String, text.utf16.count <= 131072 else {throw BaroChartAsyncError.invalidProtocol("Params checkpoint record")}
            let _: Bool = try onOwner { source in try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceCheckpoint",[plan.ticket,ordinal*256,text,self.sourceRevision]));return true }
        }
        while true {
            try check()
            let complete: Bool = try onOwner { source in
                let value = try asterWorkspaceObject(asterInvoke(source,"nativeParamsSourceValidate",[plan.ticket,16384,self.sourceRevision]))
                let complete = try asterWorkspaceBool(value["complete"])
                guard let phase = value["phase"] as? String, ["validate","ready"].contains(phase), complete == (phase == "ready") else {throw BaroChartAsyncError.invalidProtocol("Params validation phase")}
                return complete
            }
            if complete {break}
        }
        try check();return copied
    }
    private func publish(ticket: Int) {
        precondition(Thread.isMainThread)
        do {
            try sourceCall {try asterWorkspaceTrue(asterInvoke($0,"nativeParamsSourcePrepare",[ticket,sourceRevision]))}
            try check();_ = try finalOwner()
            guard let record = record else {throw BaroChartAsyncError.invalidProtocol("Missing params source")}
            // Linearize cancellation before publication without holding a lock
            // across JS. Later cancellation cannot reverse a confirmed commit.
            lock.lock();let stopped = cancelled;if !stopped {publishing = true};lock.unlock()
            if stopped {throw BaroChartAsyncError.cancelled}
            record.outcome = .unknown;setOutcome(.unknown)
            do {
                _ = try autoreleasepool {
                    guard let source = record.context else {throw BaroChartAsyncError.invalidProtocol("Missing params source")}
                    return try record.accept(asterInvoke(source,"nativeParamsSourcePublish",[ticket,sourceRevision]))
                }
            }
            catch {try record.recover()}
            guard record.released else {throw BaroChartAsyncError.invalidProtocol("Params publication unresolved")}
            settle(nil)
        } catch {settle(error)}
    }
    // Called only before a worker starts or after its autoreleasepool exit ack.
    private func settle(_ error: Error?) {
        precondition(Thread.isMainThread)
        lock.lock();let done = terminal || finishing;if !done {finishing = true};lock.unlock();if done {return}
        guard let record = record else {finish(.failure(error ?? BaroChartAsyncError.invalidProtocol("Missing params source")));return}
        do {
            try record.recover()
            BaroChartParamsRegistry.remove(record) { [self] in
                self.record = nil;plan = nil
                if record.outcome == .committed || record.outcome == .unchanged {metrics.outcome = record.outcome;finish(.success(metrics))}
                else {finish(.failure(error ?? BaroChartAsyncError.invalidProtocol("Params not committed")))}
            }
        } catch {
            record.pending = true;record.failures = min(32,record.failures + 1)
            engine?.pendingParamsRegistration = registration
            self.record = nil;plan = nil
            finish(.failure(BaroChartParamsError.cleanupPending(registration:registration,outcome:record.outcome)))
        }
    }
    private func finish(_ result: Result<BaroChartParamsMetrics,Error>) {
        precondition(Thread.isMainThread)
        lock.lock();if terminal {lock.unlock();return};terminal = true;latestProgress = nil;metrics.progressCallbackErrors = callbackErrors;lock.unlock()
        if let engine = engine, engine.activeParams === self {engine.activeParams = nil}
        params = nil;plan = nil;record = nil
        let callback = completion;completion = nil;progress = nil;metrics.totalMs = (asterClock()-started)*1000
        switch result {case .success:callback?(.success(metrics));case .failure(let error):callback?(.failure(error))}
    }
}

/// A chart engine: the chart core running in a JavaScriptCore context, with its data, series, indicators, drawings and view state.
///
/// An engine belongs to the thread that created it and must be used only there; engines attached to a view must be created on the main thread. The typed methods (``BaroChartBar``, ``BaroChartSeries``, ``BaroChartDrawing`` and related value types) throw only ``BaroChartError``. The dictionary-based methods in this file are an advanced low-level API that may change within 1.x and throw their original error types. Times are UTC epoch milliseconds and indices are bar indices.
///
/// Show an engine with ``BaroChartUIView`` or ``BaroChartView``; a view borrows the engine and never closes it.
public final class BaroChartEngine {
    private static let defaultBackendLock = NSLock()
    private static var storedDefaultBackend = BaroChartBackend.javaScript

    /// The backend selected by legacy initializers. Set this on the main thread; reads are safe from constructors on other threads.
    public static var defaultBackend: BaroChartBackend {
        get { defaultBackendLock.lock(); defer {defaultBackendLock.unlock()}; return storedDefaultBackend }
        set {
            precondition(Thread.isMainThread, "BaroChartEngine.defaultBackend must be changed on the main thread")
            defaultBackendLock.lock(); storedDefaultBackend = newValue; defaultBackendLock.unlock()
        }
    }

    /// The backend selected for this engine. It never changes, including after `close()`.
    public let backend: BaroChartBackend

    /// Opt-in async success replaces this context. Re-read it after completion;
    /// cached raw JSContext/JSValue objects from the retired VM are unsupported.
    public var context: JSContext {coreRuntime.javaScriptContext}
    /// 코어 런타임(이음새). 비공개 경로는 context 대신 이것으로 코어를 부른다. 비동기 결과 게시가 바꿔 끼운다.
    fileprivate var coreRuntime: BaroChartCoreRuntime {
        get {guard let runtime = contextBacking else {preconditionFailure("Raw context after workspace Engine.close is unsupported")};return runtime}
        set {contextBacking = newValue;workspaceContextInstalled = false}
    }
    /// 지금 런타임. 워크스페이스 복원이 설치한 런타임은 close·deinit에서 놓아 nil이 된다(이름은 정적 소유권 검사와 맞춰 그대로 둔다).
    fileprivate var contextBacking: BaroChartCoreRuntime?
    /// Validation-only evidence of the live core runtime. Owner-thread and live-engine checks mirror engine call accessors.
    func validationRuntimeBackend() throws -> BaroChartRuntimeBackend {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed, let runtime = contextBacking else {throw BaroChartAsyncError.engineClosed}
        return runtime.backend
    }
    fileprivate var workspaceContextInstalled = false
    fileprivate var contextRuntime: BaroChartContextRuntime?
    fileprivate var activeWorkspace: BaroChartWorkspaceJob?
    fileprivate var activeParams: BaroChartParamsJob?
    fileprivate var pendingParamsRegistration: Int?
    fileprivate var pendingWorkspaceRegistration: Int?
    fileprivate var closing = false
    fileprivate var activeAsync: BaroChartAsyncJob?
    fileprivate var closed = false
    /// 타입 API(isClosed)용 읽기 전용 상태
    var closedState: Bool { closed }
    private let bundleSource: String
    private let owner = Thread.current
    private var observers: [UUID: () throws -> Void] = [:]
    private var pendingNotifications=0,notifying=false
    private var frameCleanup:[UUID:()->Void]=[:]
    func checkFrameOwner()throws{guard Thread.current===owner else{throw BaroChartLowLevelError.wrongThread};guard !closed else{throw BaroChartAsyncError.engineClosed}}
    func registerFrameCleanup(_ cleanup:@escaping()->Void)throws->UUID{try checkFrameOwner();let token=UUID();frameCleanup[token]=cleanup;return token}
    func removeFrameCleanup(_ token:UUID){frameCleanup.removeValue(forKey:token)}
    /// Errors thrown by observers during the latest notification pass; at most 32 are kept.
    public private(set) var observerErrors: [Error] = []
    /// Called for each error thrown by a change observer, on the engine's owner thread.
    public var onObserverError: ((Error) -> Void)?
    /// Counter that increases (wrapping) each time chart state changes and observers are notified. Compare it with ``BaroChartUIView/renderedRevision`` to see whether a view has drawn the latest state.
    public private(set) var revision: UInt64 = 0
    #if SWIFT_PACKAGE
    /// Creates an engine from the core bundled in the Swift package resources. Available when building as a Swift package.
    ///
    /// - Parameters:
    ///   - count: Number of deterministic demonstration bars (seed 42) to load at start; `0` starts empty.
    ///   - options: Core options dictionary (panels, series, theme), or `nil` for the labeled demonstration layout with price and volume panels.
    public convenience init(count: Int = 0, options: [String: Any]? = nil) throws {
        let selected = Self.defaultBackend
        let source: String?
        if selected == .javaScript {
            guard let url = Bundle.module.url(forResource: "aster-core", withExtension: "js") else {throw BaroChartLowLevelError.invalidScene}
            source = try String(contentsOf: url, encoding: .utf8)
        } else { source = nil }
        try self.init(coreBundleSource: source, count: count, options: options, backend: selected)
    }
    #endif
    /// Creates an engine from the core JavaScript bundle at `bundleURL`. The calling thread becomes the owner thread.
    ///
    /// - Parameters:
    ///   - bundleURL: File URL of the core bundle.
    ///   - count: Number of deterministic demonstration bars (seed 42) to load at start; `0` starts empty.
    ///   - options: Core options dictionary (panels, series, theme), or `nil` for the labeled demonstration layout with price and volume panels.
    /// - Throws: ``BaroChartLowLevelError`` if the JavaScript context cannot be created or the bundle fails to load or initialize. Low-level API; prefer ``init(options:)``.
    public convenience init(bundleURL: URL, count: Int = 0, options: [String: Any]? = nil) throws {
        let selected = Self.defaultBackend
        let source = selected == .javaScript ? try String(contentsOf: bundleURL, encoding: .utf8) : nil
        try self.init(coreBundleSource: source, count: count, options: options, backend: selected)
    }

    private init(coreBundleSource source: String?, count: Int, options: [String: Any]?, backend: BaroChartBackend) throws {
        guard let runtime = BaroChartRuntimeFactory.makeEngineRuntime(like: backend) else {
#if canImport(BaroChartCoreRust)
            throw BaroChartLowLevelError.unavailableContext
#else
            throw backend == .rust ? BaroChartLowLevelError.javaScript("UnavailableError: Rust backend is not included in this build.") : BaroChartLowLevelError.unavailableContext
#endif
        }
        self.contextBacking = runtime
        self.backend = backend
        switch backend {
        case .javaScript:
            guard let source else {throw BaroChartLowLevelError.invalidScene}
            self.bundleSource = source
        case .rust:
            self.bundleSource = ""
        }
        // 스크립트 평가가 만드는 autorelease 임시 JSValue가 컨텍스트를 붙잡지 않도록 바로 비운다(call과 같은 이유)
        try autoreleasepool {
            if backend == .javaScript, let exception = runtime.evaluateBundle(bundleSource) { throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Unknown JS error") }
        }
        _ = try call("nativeInit", [count, options as Any? ?? NSNull()])
    }

    /// Internal backend selector retained for conformance tests and same-backend workers.
    convenience init(options: [String: Any]? = nil, runtimeBackend: BaroChartRuntimeBackend) throws {
        let source: String?
        switch runtimeBackend {
        case .javaScript:
            #if SWIFT_PACKAGE
            guard let bundleURL = Bundle.module.url(forResource: "aster-core", withExtension: "js") else {throw BaroChartLowLevelError.invalidScene}
            source = try String(contentsOf: bundleURL, encoding: .utf8)
            #else
            throw BaroChartLowLevelError.invalidScene
            #endif
        case .rust: source = nil
        }
        try self.init(coreBundleSource: source, count: 0, options: options, backend: runtimeBackend)
    }
    /// Calls a global function of the core bundle by name and returns its JavaScript result. Owner thread only; throws ``BaroChartLowLevelError`` for a wrong thread or a missing function, and ``BaroChartAsyncError`` for a closed engine. Advanced low-level API.
    @discardableResult public func call(_ name: String, _ arguments: [Any] = []) throws -> JSValue {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed else {throw BaroChartAsyncError.engineClosed}
        // JSC가 호출마다 만드는 autorelease 임시 JSValue는 JSContext를 강하게 붙잡는다.
        // 호출자의 풀이 늦게 비워지면(백그라운드 소유 스레드, 한 런루프 턴 안의 반복) 닫힌 엔진의 컨텍스트가 쌓이므로 호출 단위로 비운다.
        return try autoreleasepool {
            switch coreRuntime.perform(name, arguments) {
            case .missing: throw BaroChartLowLevelError.javaScript("Missing function: \(name)")
            case .rejected(let error): throw error
            case .threw(let exception): throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Unknown JS error")
            case .returned(let value): return value.javaScriptValue
            }
        }
    }
    /// 코어가 그 이름의 전역 함수를 갖는지 묻는다(코어를 부르지 않는다). close의 정리 호출과 프레임 렌더러의 캐시 경로 판단이 쓴다.
    /// - Parameter name: 전역 함수 이름
    /// - Returns: 정의돼 있으면 true
    func supports(_ name: String) -> Bool {coreRuntime.supports(name)}
    private func workspaceAvailability() throws {
        guard !closing else {throw BaroChartAsyncError.engineClosed}
        if let pending = pendingWorkspaceRegistration {
            guard !BaroChartWorkspaceRegistry.contains(pending) else {throw BaroChartAsyncError.busy}
            pendingWorkspaceRegistration = nil
        }
        if let pending = pendingParamsRegistration {
            guard !BaroChartParamsRegistry.contains(pending) else {throw BaroChartAsyncError.busy}
            pendingParamsRegistration = nil
        }
        guard activeParams == nil else {throw BaroChartAsyncError.busy}
        guard activeWorkspace == nil else {throw BaroChartAsyncError.busy}
    }
    /// Lists workspace restores whose runtime cleanup is still pending. Main thread only; throws ``BaroChartAsyncError`` otherwise.
    public static func workspaceCleanupStatus() throws -> [BaroChartWorkspaceCleanupStatus] {
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        return BaroChartWorkspaceRegistry.status()
    }
    /// One main-owner attempt per pending record; no completion redelivery.
    public static func retryWorkspaceCleanup() throws -> [BaroChartWorkspaceCleanupStatus] {
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        BaroChartWorkspaceRegistry.retry();return BaroChartWorkspaceRegistry.status()
    }
    /// Lists parameter jobs whose runtime cleanup is still pending. Main thread only; throws ``BaroChartAsyncError`` otherwise.
    public static func paramsCleanupStatus() throws -> [BaroChartParamsStatus] {
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        return BaroChartParamsRegistry.status()
    }
    /// Returns results from this one recovery attempt; never repeats completion.
    @discardableResult public static func retryParamsCleanup(_ registration: Int? = nil) throws -> [BaroChartParamsStatus] {
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        return BaroChartParamsRegistry.retry(registration)
    }
    /// Entry-only replacement in the original context; static linked modules only.
    @discardableResult public func setIndicatorParamsAsync(_ id: String, params: [String:Any], timeout: Double = 30,
        maxBarsPerStep: Int = 4096, progress: ((BaroChartAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<BaroChartParamsMetrics,Error>) -> Void) throws -> BaroChartParamsJob {
        try asyncPreflight(timeout)
        guard !id.isEmpty, id.utf16.count <= 128, maxBarsPerStep >= 1, maxBarsPerStep <= 16384, revision <= 9007199254740991 else {throw BaroChartAsyncError.invalidProtocol("Params request bounds")}
        let source = coreRuntime, capturedRevision = revision
        guard JSONSerialization.isValidJSONObject(params) else {throw BaroChartAsyncError.invalidProtocol("Params request must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:params,options:[.sortedKeys])
        guard data.count <= 131072, let owned = try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw BaroChartAsyncError.invalidProtocol("Params request size")}
        try asyncPreflight(timeout)
        guard contextBacking === source, revision == capturedRevision else {throw BaroChartAsyncError.invalidProtocol("Params source changed during arguments")}
        let record = try BaroChartParamsRegistry.reserve(self,id,source,contextRuntime)
        let job = BaroChartParamsJob(engine:self,record:record,params:owned,timeout:timeout,maxBars:maxBarsPerStep,progress:progress,completion:completion)
        activeParams = job;let bundle = bundleSource
        DispatchQueue.main.async {job.start(bundle:bundle)}
        return job
    }
    /// Workspace contains settings only; dataset binding is a host assertion.
    @discardableResult public func restoreWorkspaceAsync(_ document: String, datasetBinding: [String:Any], timeout: Double = 30,
        maxBarsPerStep: Int = 4096, progress: ((BaroChartAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<BaroChartWorkspaceMetrics,Error>) -> Void) throws -> BaroChartWorkspaceJob {
        try asyncPreflight(timeout)
        guard document.utf16.count <= 2097152, maxBarsPerStep >= 1, maxBarsPerStep <= 16384, revision <= 9007199254740991 else {throw BaroChartAsyncError.invalidProtocol("Workspace request bounds")}
        let source = coreRuntime, capturedRevision = revision
        guard JSONSerialization.isValidJSONObject(datasetBinding) else {throw BaroChartAsyncError.invalidProtocol("Workspace binding must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:datasetBinding,options:[.sortedKeys])
        guard data.count <= 32768, let binding = try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw BaroChartAsyncError.invalidProtocol("Workspace binding bounds")}
        try asyncPreflight(timeout)
        guard contextBacking === source, revision == capturedRevision else {throw BaroChartAsyncError.invalidProtocol("Workspace source changed during arguments")}
        let record = try BaroChartWorkspaceRegistry.reserve(source,contextRuntime)
        let job = BaroChartWorkspaceJob(engine:self,record:record,document:document,binding:binding,timeout:timeout,maxBars:maxBarsPerStep,progress:progress,completion:completion)
        activeWorkspace = job;let bundle = bundleSource
        DispatchQueue.main.async {job.start(bundle:bundle)}
        return job
    }
    /// Optional isolated-context data mutation. The engine must be created on
    /// the main/UI thread. Existing synchronous APIs and owner guard are intact.
    /// Progress/completion always run on main; callbacks can use this engine.
    @discardableResult public func applyDataEventAsync(_ event: [String: Any], timeout: Double = 30,
        progress: ((BaroChartAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<BaroChartAsyncMetrics, Error>) -> Void) throws -> BaroChartAsyncJob {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        guard !closed else {throw BaroChartAsyncError.engineClosed}
        try workspaceAvailability()
        guard activeAsync == nil else {throw BaroChartAsyncError.busy}
        guard timeout.isFinite, timeout > 0, timeout <= 3600 else {throw BaroChartAsyncError.invalidProtocol("Invalid timeout")}
        guard JSONSerialization.isValidJSONObject(event) else {throw BaroChartAsyncError.invalidProtocol("Data event must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:event,options:[.sortedKeys])
        guard data.count <= 8388608,let eventJSON = String(data:data,encoding:.utf8) else {throw BaroChartAsyncError.invalidProtocol("Oversized data event")}
        return startAsync(json:eventJSON,kind:.correction,columns:nil,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:0)
    }
    /// Prepare real OHLCV input in an isolated VM. Array COW is the input
    /// ownership snapshot; safe caller mutations detach. No OHLCV JSON arrays,
    /// borrowed source JS arrays or temporary full Data snapshot are created.
    @discardableResult public func prepareColumnsAsync(_ columns:BaroChartColumns,visibleBars:Int=200,timeout:Double=30,
        progress:((BaroChartAsyncProgress)throws->Void)?=nil,completion:@escaping(Result<BaroChartAsyncMetrics,Error>)->Void) throws -> BaroChartAsyncJob {
        let started=asterClock();try asyncPreflight(timeout)
        guard visibleBars>=1,visibleBars<=4194304 else {throw BaroChartAsyncError.invalidProtocol("Visible bars 1...4194304")}
        let data=try JSONSerialization.data(withJSONObject:["kind":"columns","length":columns.length,"visibleBars":visibleBars],options:[.sortedKeys])
        return startAsync(json:String(data:data,encoding:.utf8)!,kind:.columns,columns:columns,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:(asterClock()-started)*1000)
    }
    /// Demo convenience: deterministic synthetic data is generated incrementally
    /// in the worker. It is separate from real immutable-owned feed input.
    @discardableResult public func prepareSeededAsync(count:Int,seed:UInt32=42,visibleBars:Int=200,timeout:Double=30,
        progress:((BaroChartAsyncProgress)throws->Void)?=nil,completion:@escaping(Result<BaroChartAsyncMetrics,Error>)->Void) throws -> BaroChartAsyncJob {
        try asyncPreflight(timeout)
        guard count>=0,count<=4194304,visibleBars>=1,visibleBars<=4194304 else {throw BaroChartAsyncError.invalidProtocol("Prepare count/visible bars")}
        let data=try JSONSerialization.data(withJSONObject:["kind":"seeded","count":count,"seed":seed,"visibleBars":visibleBars],options:[.sortedKeys])
        return startAsync(json:String(data:data,encoding:.utf8)!,kind:.seeded,columns:nil,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:0)
    }
    private func asyncPreflight(_ timeout:Double) throws {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard Thread.isMainThread else {throw BaroChartAsyncError.mainOwnerRequired}
        guard !closed else {throw BaroChartAsyncError.engineClosed}
        try workspaceAvailability()
        guard activeAsync == nil else {throw BaroChartAsyncError.busy}
        guard timeout.isFinite,timeout>0,timeout<=3600 else {throw BaroChartAsyncError.invalidProtocol("Invalid timeout")}
    }
    private func startAsync(json:String,kind:BaroChartAsyncKind,columns:BaroChartColumns?,timeout:Double,
        progress:((BaroChartAsyncProgress)throws->Void)?,completion:@escaping(Result<BaroChartAsyncMetrics,Error>)->Void,inputOwnershipMs:Double) -> BaroChartAsyncJob {
        let job=BaroChartAsyncJob(engine:self,timeout:timeout,progress:progress,completion:completion)
        let ownership=asterClock();job.kind=kind;job.hostColumns=columns
        job.metrics.retainedInputBytes=columns?.retainedBytes ?? 0;job.metrics.inputOwnershipMs=inputOwnershipMs+(columns==nil ? 0 : (asterClock()-ownership)*1000)
        activeAsync=job
        DispatchQueue.main.async { [weak self,job] in
            do {
                guard let engine=self else {throw BaroChartAsyncError.sourceDeallocated}
                try job.check();let source=try job.ownerSource(),beginStart=asterClock()
                let description=try asterDictionary(asterInvoke(source,kind == .correction ? "nativeAsyncBegin" : "nativePrepareBegin",[json]))
                job.ticket=try asterInteger(description["ticket"],9007199254740991)
                job.plan=try BaroChartAsyncPlan(description);job.metrics.beginMs=(asterClock()-beginStart)*1000
                let runtime=BaroChartAsyncRuntime(bundle:engine.bundleSource,job:job);job.runtime=runtime;runtime.start()
            }catch {job.finish(.failure(error))}
        }
        return job
    }
    // Internal host-fixture diagnostic. Return only to construct a weak probe;
    // retaining this object would deliberately extend the runtime lifetime.
    func _asyncRuntimeLifetimeProbe() -> AnyObject? {
        precondition(Thread.current === owner)
        if let runtime = activeAsync?.runtime {return runtime};return contextRuntime
    }
    /// Close from the original owner; any active async result is discarded.
    /// A closed engine may be retained, but its creation run loop and observers
    /// and opt-in ingestion ring are retired now. Legacy source columns in the
    /// nonoptional raw context live until engine release;
    /// raw JS access after close is unsupported.
    /// Closes the engine on its owner thread. Repeated calls are no-ops. Throws `BaroChartError`.
    public func close() throws {try BaroChartError.mapping {try closeOnOwner()}}
    /// 엔진 정리 본체(저수준 오류를 던진다)
    private func closeOnOwner() throws {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        // 정리 중 JSC가 만든 autorelease 임시 JSValue가 닫힌 엔진의 컨텍스트를 붙잡지 않도록 이 풀 안에서 정리한다.
        // 클로저의 return은 정리 단계만 끝낸다(이전의 함수 return과 같은 의미).
        try autoreleasepool {
            if closing {return};closing = true;defer {closing = false}
            if Thread.isMainThread, let pending = pendingWorkspaceRegistration {BaroChartWorkspaceRegistry.retry(pending)}
            if Thread.isMainThread, let pending = pendingParamsRegistration {_ = BaroChartParamsRegistry.retry(pending)}
            if closed {return}
            activeWorkspace?.cancel();activeParams?.cancel()
            let cleanups = Array(frameCleanup.values);frameCleanup.removeAll();for cleanup in cleanups {cleanup()}
            if supports("nativeReleaseFrameCaches") {_ = try call("nativeReleaseFrameCaches")}
            if supports("nativeReleaseDataIngestion") {_ = try call("nativeReleaseDataIngestion")}
            closed = true;activeAsync?.stop(BaroChartAsyncError.engineClosed)
            if workspaceContextInstalled {contextBacking = nil}
            activeAsync?.runtime?.retire();contextRuntime?.retire();contextRuntime = nil
            observers.removeAll();onObserverError = nil;observerErrors.removeAll();pendingNotifications = 0
        }
    }
    deinit {
        activeWorkspace?.cancel();activeParams?.cancel();activeAsync?.stop(BaroChartAsyncError.sourceDeallocated)
        if workspaceContextInstalled {contextBacking = nil}
        contextRuntime?.retire()
    }
    /// Replaces every bar of the primary series. Low-level form that throws its original error types; the typed `setBars(_:)` throws only ``BaroChartError``.
    public func setData(_ bars: [BaroChartBar]) throws {
        let data = try JSONEncoder().encode(bars)
        let object = try JSONSerialization.jsonObject(with: data)
        try command("setData", [object])
    }
    /// JSON-compatible common commands. Mutation notifications invalidate
    /// attached native views; scene/inspect/value reads do not schedule frames.
    @discardableResult public func command(_ operation: String, _ arguments: [Any] = []) throws -> JSValue {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed else {throw BaroChartAsyncError.engineClosed}
        // The async handle is published before its deferred JavaScript begin.
        // Guard this owner-only gap too; the core lease covers direct JS calls
        // after begin. Existing data mutations keep their stale-result policy.
        if (activeAsync.map{!$0.isCommitted} ?? false) || activeWorkspace != nil || pendingWorkspaceRegistration.map({BaroChartWorkspaceRegistry.contains($0)}) == true || activeParams != nil || pendingParamsRegistration.map({BaroChartParamsRegistry.contains($0)}) == true {
            if ["compactData", "configureDataIngestion", "enqueueDataEvents", "drainDataEvents", "pauseDataIngestion", "resumeDataIngestion", "cancelDataEvents", "loadDataIngestion"].contains(operation) {throw BaroChartIngestionError(code:"BUSY",message:"Native asynchronous job is active")}
        }
        let result:JSValue
        if ["configureDataIngestion", "enqueueDataEvents", "drainDataEvents", "pauseDataIngestion", "resumeDataIngestion", "cancelDataEvents", "dataIngestionStats", "saveDataIngestion", "loadDataIngestion"].contains(operation) {
            let envelope=try call("nativeDataIngestionCommand",[operation,arguments])
            if let error=envelope.forProperty("error"),!error.isUndefined,!error.isNull {
                guard error.forProperty("name")?.toString()=="IngestionError",let code=error.forProperty("code"),code.isString,let codeText=code.toString(),!codeText.isEmpty,codeText.utf16.count<=64,let message=error.forProperty("message"),message.isString,let messageText=message.toString(),messageText.utf16.count<=256 else{throw BaroChartLowLevelError.invalidScene}
                throw BaroChartIngestionError(code:codeText,message:messageText)
            }
            guard let value=envelope.forProperty("result"),!value.isUndefined else{throw BaroChartLowLevelError.invalidScene};result=value
        } else {result=try call("nativeCommand",[operation,arguments])}
        if operation == "compactData" {
            guard result.isObject,let removed=result.forProperty("removed"),removed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=removed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=4194304 else {throw BaroChartLowLevelError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "setPanelOrder" {
            guard result.isBoolean else {throw BaroChartLowLevelError.invalidScene}
            if result.toBool() {notifyChanges()}
        } else if operation == "setIndicatorPlacement" {
            guard result.isObject, let changed=result.forProperty("changed"), changed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=256 else {throw BaroChartLowLevelError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "translateDrawings" {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=128 else {throw BaroChartLowLevelError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "setDrawingsStyle" {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=128 else {throw BaroChartLowLevelError.invalidScene}
            if count>0 {notifyChanges()}
        } else if ["setDrawingVisibility", "setDrawingsVisibility"].contains(operation) {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=changed.toDouble(),maximum=operation == "setDrawingVisibility" ? 1.0 : 128.0
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=maximum else {throw BaroChartLowLevelError.invalidScene}
            if count>0 {notifyChanges()}
        } else if ["duplicateDrawing", "duplicateDrawings"].contains(operation) {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw BaroChartLowLevelError.invalidScene}
            let count=changed.toDouble(),maximum=operation == "duplicateDrawing" ? 1.0 : 128.0
            guard count.isFinite,count.rounded(.towardZero)==count,count>=1,count<=maximum,
                  let created=result.forProperty("created"),created.isArray,let rows=created.toArray() as? [[String: Any]],rows.count==Int(count),
                  let failed=result.forProperty("invalidationFailed"),failed.isBoolean else {throw BaroChartLowLevelError.invalidScene}
            var sources=Set<String>(),ids=Set<String>()
            for row in rows {
                guard row.count==2,let source=row["sourceId"] as? String,let id=row["id"] as? String,
                      !source.isEmpty,source.utf16.count<=128,!id.isEmpty,id.utf16.count<=128,source != id,
                      sources.insert(source).inserted,ids.insert(id).inserted else {throw BaroChartLowLevelError.invalidScene}
            }
            notifyChanges()
        } else if !["inspect", "indicatorValues", "indicatorValueAt", "saveStudies", "saveDrawings", "positionMetrics", "crosshairValues", "crosshairSnapshot", "dataAt", "dataIngestionStats", "saveDataIngestion"].contains(operation) {
            notifyChanges()
        }
        return result
    }
    fileprivate func notifyChanges() {
        revision &+= 1;pendingNotifications += 1;if notifying {return};notifying=true;observerErrors=[];defer{notifying=false}
        while pendingNotifications>0 {pendingNotifications -= 1;for notify in Array(observers.values) {do{try notify()}catch{if observerErrors.count<32{observerErrors.append(error)};onObserverError?(error)}}}
    }
    /// Registers a closure that runs on the owner thread after each change to chart state, and returns a token for ``removeObserver(_:)``. Errors thrown by the closure are recorded in ``observerErrors`` and reported to ``onObserverError``.
    @discardableResult public func observeChanges(_ notify: @escaping () throws -> Void) throws -> UUID {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed else {throw BaroChartAsyncError.engineClosed}
        let token = UUID(); observers[token] = notify; return token
    }
    /// Removes the observer registered under `token`. Owner thread only.
    public func removeObserver(_ token: UUID) throws {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}; observers.removeValue(forKey: token)
    }
    /// Applies one streaming or correction event given as a core event dictionary. The typed `apply(_:)` takes a ``BaroChartDataEvent`` instead.
    public func applyDataEvent(_ event: [String: Any]) throws {try command("applyDataEvent", [event])}
    /// Ordered append/update/correction burst. The core validates the complete
    /// burst before one data publication; it never sorts, merges or evicts rows.
    @discardableResult public func applyDataEvents(_ events: [[String: Any]]) throws -> [String: Any] {
        try ingestionCommand("applyDataEvents",[events])
    }
    /// Opt-in final-value deduplication. False retains the legacy command path.
    /// A true-path response failure does not prove rollback; do not auto-retry.
    @discardableResult public func applyDataEvents(_ events: [[String: Any]], skipUnchanged: Bool) throws -> [String: Any] {
        if !skipUnchanged {return try applyDataEvents(events)}
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed, !closing, let identity = contextBacking.map(ObjectIdentifier.init) else {throw BaroChartAsyncError.engineClosed}
        let beforeRevision = revision
        let outcome: ([String: Any], Bool)
        do {
            outcome = try unchangedDataBatch(events)
            guard !closed, !closing, contextBacking.map(ObjectIdentifier.init) == identity else {throw BaroChartLowLevelError.invalidScene}
        } catch {
            // Source/worker aliases and retirement lease are already released.
            if !closed, !closing, contextBacking.map(ObjectIdentifier.init) == identity {notifyChanges()}
            throw error
        }
        if !outcome.1 || revision != beforeRevision {notifyChanges()}
        return outcome.0
    }
    private func unchangedDataBatch(_ events: [[String: Any]]) throws -> ([String: Any], Bool) {
        let runtime = contextRuntime
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw BaroChartAsyncError.engineClosed}
        defer {runtime?.releaseCaptureLease()}
        return try autoreleasepool { () throws -> ([String: Any], Bool) in
            guard let source = contextBacking else {throw BaroChartAsyncError.engineClosed}
            let value: BaroChartCoreValue
            switch source.perform("nativeApplyUnchangedDataEvents", [events]) {
            case .missing: throw BaroChartLowLevelError.invalidScene
            case .rejected(let error): throw error
            case .threw(let exception): throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Data batch error")
            case .returned(let result): value = result
            }
            let object = value.toDictionary()
            if let exception = source.takeException() {throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Data batch conversion error")}
            guard !closed, !closing, contextBacking === source,
                  let envelope = object as? [String: Any], let receipt = envelope["receipt"] as? [String: Any],
                  envelope["schema"] as? String == "aster.native-data-batch" else {throw BaroChartLowLevelError.invalidScene}
            func integer(_ value: Any?,_ max: Double) throws -> Double {
                guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else {throw BaroChartLowLevelError.invalidScene}
                let d = n.doubleValue;guard d.isFinite,d.rounded(.towardZero)==d,d>=0,d<=max else {throw BaroChartLowLevelError.invalidScene};return d
            }
            func boolean(_ value: Any?) throws -> Bool {
                guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {throw BaroChartLowLevelError.invalidScene};return n.boolValue
            }
            let format = try integer(envelope["version"],1),before = try integer(envelope["beforeVersion"],9007199254740991),after = try integer(envelope["afterVersion"],9007199254740991)
            let unchanged = try boolean(envelope["unchanged"]),same = try boolean(receipt["unchanged"])
            let count = try integer(receipt["events"],4096),appended = try integer(receipt["appended"],4096),from = try integer(receipt["from"],4194304),to = try integer(receipt["to"],4194304),version = try integer(receipt["version"],9007199254740991),length = try integer(receipt["length"],4194304),capacity = try integer(receipt["capacity"],4194304),bytes = try integer(receipt["bytes"],402653184)
            let cap = Int(capacity)
            guard format==1,unchanged==same,count>=1,appended<=count,capacity>=1,capacity>=length,(cap & (cap-1))==0,bytes==96*capacity,from<to,to<=length,after>=before,version>=before,version<=after else {throw BaroChartLowLevelError.invalidScene}
            guard unchanged ? (appended==0 && version==before && after==before) : version==before+1 else {throw BaroChartLowLevelError.invalidScene}
            return (receipt,unchanged)
        }
    }
    /// Synchronous retained-window maintenance with explicit studyHistory:"restart".
    /// Large copies block the owner; pause/drain upstream before this call.
    /// Zero removal produces no host revision/notification. A bridge/receipt
    /// failure after JavaScript execution does not certify source rollback.
    @discardableResult public func compactData(_ options: [String: Any]) throws -> [String: Any] {
        try ingestionCommand("compactData",[options])
    }
    /// One opt-in, model-owned bounded session. Network producers, timers and
    /// main-owner scheduling stay with the host; no background SDK queue starts.
    @discardableResult public func configureDataIngestion(_ options: [String: Any]) throws -> [String: Any] {
        try ingestionCommand("configureDataIngestion",[options])
    }
    /// Whole sequenced packet admission into owned typed buffers. This does not
    /// publish OHLCV. Rejection never advances the accepted sequence cursor.
    @discardableResult public func enqueueDataEvents(_ packet: [String: Any]) throws -> [String: Any] {
        try ingestionCommand("enqueueDataEvents",[packet])
    }
    /// Apply one atomic prefix on the original owner. A failed prefix stays
    /// queued and paused; the host explicitly decides when to resume/cancel.
    @discardableResult public func drainDataEvents(_ maxEvents: Int? = nil) throws -> [String: Any] {
        try ingestionCommand("drainDataEvents",maxEvents.map{[$0 as Any]} ?? [])
    }
    /// Pauses the ingestion queue and returns the core's receipt dictionary. Low-level API.
    @discardableResult public func pauseDataIngestion() throws -> [String: Any] {try ingestionCommand("pauseDataIngestion")}
    /// Resumes the ingestion queue and returns the core's receipt dictionary. Low-level API.
    @discardableResult public func resumeDataIngestion() throws -> [String: Any] {try ingestionCommand("resumeDataIngestion")}
    /// Explicit pending-payload cancellation; accepted cursors remain advanced.
    @discardableResult public func cancelDataEvents() throws -> [String: Any] {try ingestionCommand("cancelDataEvents")}
    /// Fresh policy/cursor/ledger and logical typed-byte counts, not process RSS.
    /// Returns ingestion statistics from the core (policy, cursors, ledger and logical typed-byte counts) as a dictionary.
    public func dataIngestionStats() throws -> [String: Any] {try ingestionCommand("dataIngestionStats")}
    /// Bounded special-number document. Feed data and UI are separately owned;
    /// restore those first. Active asynchronous lease state is never serialized.
    /// Saves the ingestion state as a document string; restore it with ``loadDataIngestion(_:)``.
    public func saveDataIngestion() throws -> String {
        guard let text=try command("saveDataIngestion").toString() else{throw BaroChartLowLevelError.invalidScene};return text
    }
    /// Restores ingestion state from a document made by ``saveDataIngestion()`` and returns the core's receipt dictionary.
    @discardableResult public func loadDataIngestion(_ document: String) throws -> [String: Any] {
        try ingestionCommand("loadDataIngestion",[document])
    }
    private func ingestionCommand(_ operation: String,_ arguments: [Any] = []) throws -> [String: Any] {
        guard let result=try command(operation,arguments).toDictionary() as? [String: Any] else{throw BaroChartLowLevelError.invalidScene};return result
    }
    /// Replaces the primary OHLCV from column arrays keyed by column name (`time`, `open`, `high`, `low`, `close`, `volume`). Low-level API.
    public func setColumns(_ columns: [String: [Double]]) throws {try command("setColumns", [columns])}
    /// Adds a panel from a core options dictionary. Low-level API.
    public func addPanel(_ options: [String: Any]) throws {try command("addPanel", [options])}
    /// Applies a patch dictionary to the panel with `id`. Low-level API.
    public func setPanel(_ id: String, _ patch: [String: Any]) throws {try command("setPanel", [id, patch])}
    /// Adds an explicit value axis from a core options dictionary. Low-level API.
    public func addAxis(_ options: [String: Any]) throws {try command("addAxis", [options])}
    /// Applies a patch dictionary to the axis with `id`. Low-level API.
    public func setAxis(_ id: String, _ patch: [String: Any]) throws {try command("setAxis", [id, patch])}
    /// Removes the axis with `id`. Low-level API.
    public func removeAxis(_ id: String) throws {try command("removeAxis", [id])}
    /// Sets the panel and series that new drawings attach to, as a core target dictionary. `nil` is sent to the core as null. Low-level API.
    public func setDrawingTarget(_ target: [String: Any]?) throws {try command("setDrawingTarget", [target as Any? ?? NSNull()])}
    /// Bounded readout at a stored timestamp/index. May calculate lazy studies;
    /// no layout, rounding or change notification is requested by this read.
    /// Reads the core's data readout for a query dictionary, or `nil` when the core returns none. Low-level API.
    public func dataAt(_ query: [String: Any], options: [String: Any] = [:]) throws -> [String: Any]? {
        let value = try command("dataAt", [query, options])
        if value.isNull {return nil}
        guard let result = value.toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Explicit selection/readout; no chart mutation notification or redraw.
    private func dataExploration(_ action: String, _ argument: Any = NSNull()) throws -> [String: Any] {
        guard Thread.current === owner else {throw BaroChartLowLevelError.wrongThread}
        guard !closed, !closing else {throw BaroChartAsyncError.engineClosed}
        let runtime = contextRuntime
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw BaroChartAsyncError.engineClosed}
        // All JS aliases/autoreleases leave the pool before creator retirement.
        defer {runtime?.releaseCaptureLease()}
        return try autoreleasepool { () throws -> [String: Any] in
            guard let source = contextBacking else {throw BaroChartAsyncError.engineClosed}
            let value: BaroChartCoreValue
            switch source.perform("nativeDataExploration", [action, argument]) {
            case .missing: throw BaroChartLowLevelError.invalidScene
            case .rejected(let error): throw error
            case .threw(let exception): throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Exploration error")
            case .returned(let result): value = result
            }
            let dictionary = value.toDictionary()
            if let exception = source.takeException() {
                throw BaroChartLowLevelError.javaScript(exception.toString() ?? "Exploration conversion error")
            }
            guard !closed, !closing, contextBacking === source else {throw BaroChartLowLevelError.invalidScene}
            guard let result = dictionary as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
            return result
        }
    }
    /// Turns data exploration on or off and returns the core's state dictionary.
    public func setDataExploration(_ active: Bool) throws -> [String: Any] {try dataExploration("setActive", active)}
    /// Sends a navigation key name to data exploration and returns the core's state dictionary.
    public func navigateDataExploration(_ key: String) throws -> [String: Any] {try dataExploration("navigate", key)}
    /// Refreshes data exploration and returns the core's state dictionary.
    public func refreshDataExploration() throws -> [String: Any] {try dataExploration("refresh")}
    /// Explicit read may synchronously calculate all visible dirty studies.
    public func readDataExploration() throws -> [String: Any] {try dataExploration("read")}
    /// Returns the core's crosshair readout for a view of the given size in CSS pixels, or `nil` when there is none. The typed `crosshair(width:height:)` returns ``BaroChartCrosshairValues``.
    public func crosshairValues(width: Double, height: Double) throws -> [String: Any]? {try command("crosshairValues", [width, height]).toDictionary() as? [String: Any]}
    /// Fresh layout may calculate dirty studies; the snapshot contains raw OHLC identity.
    public func crosshairSnapshot(width: Double, height: Double) throws -> [String: Any]? {
        let value = try command("crosshairSnapshot", [width, height])
        if value.isNull {return nil}
        guard let result = value.toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Adds a series from a core options dictionary. Low-level API.
    public func addSeries(_ options: [String: Any]) throws {try command("addSeries", [options])}
    /// Applies a patch dictionary to the series with `id`. Low-level API.
    public func setSeries(_ id: String, _ patch: [String: Any]) throws {try command("setSeries", [id, patch])}
    /// Removes the series with `id`. Removing a missing id does nothing. Throws only ``BaroChartError``.
    public func removeSeries(_ id: String) throws {try BaroChartError.mapping {try command("removeSeries", [id])}}
    /// Sets the values of a general series. `nil` entries are sent to the core as null. Low-level API.
    public func setSeriesValues(_ id: String, _ values: [Double?]) throws {try command("setSeriesValues", [id, values.map { $0.map { $0 as Any } ?? NSNull() }])}
    /// Adds an indicator named `name` (a core indicator name) under `id` and returns the core's JavaScript result. Low-level API.
    @discardableResult public func addIndicator(_ id: String, _ name: String, _ params: [String: Any] = [:]) throws -> JSValue {try command("addIndicator", [id, name, params])}
    /// Replaces parameters of the indicator with `id` synchronously and returns the core's JavaScript result. Low-level API.
    @discardableResult public func setIndicatorParams(_ id: String, _ params: [String: Any]) throws -> JSValue {try command("setIndicatorParams", [id, params])}
    /// Removes the indicator with `id`. Throws only ``BaroChartError``.
    public func removeIndicator(_ id: String) throws {try BaroChartError.mapping {try command("removeIndicator", [id])}}
    /// Select an application-linked module by id/version. This does not fetch
    /// or evaluate source code. Returned names are the canonical factory names.
    public func registerIndicatorModule(_ id: String, version: Int = 1) throws -> [String] {
        guard let names = try command("registerIndicatorModule",[id,version]).toArray() as? [String] else {throw BaroChartLowLevelError.invalidScene}
        return names
    }
    /// Indicator definitions and their series only. Feed data, panels, axes,
    /// theme and drawing history remain owned by the caller's chart.
    public func saveStudies() throws -> String {
        guard let text = try command("saveStudies").toString() else {throw BaroChartLowLevelError.invalidScene}
        return text
    }
    /// Bounded portable metadata only. Synchronous owner-thread read without revision/redraw notification.
    public func saveWorkspace(_ datasetBinding: [String: Any]) throws -> String {
        let result = try call("nativeSaveWorkspace", [datasetBinding])
        guard result.isString, let text = result.toString() else {throw BaroChartLowLevelError.invalidScene}
        return text
    }
    /// Validated-only metadata/source assertion; no calculation, restore, job reservation or context swap.
    public func preflightWorkspace(_ document: String, datasetBinding: [String: Any]) throws -> [String: Any] {
        guard let result = try call("nativePreflightWorkspace", [document, datasetBinding]).toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Atomic additive import; ids must be new and required layout bindings
    /// must already exist. Returns {indicators, series} counts.
    @discardableResult public func loadStudies(_ document: String) throws -> [String: Any] {
        guard let result = try command("loadStudies",[document]).toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Scalar raw/plot query with optional asOfIndex. Unavailable future samples
    /// return JSON null value/sourceIndex/sourceTime; this read does not notify.
    public func indicatorValueAt(_ id: String, output: String? = nil, index: Int, options: [String: Any] = [:]) throws -> [String: Any] {
        guard let result = try command("indicatorValueAt",[id,output as Any? ?? NSNull(),index,options]).toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Registers JavaScript indicator factory source under `name` in the core context and notifies observers. The source is evaluated, so pass only code your app trusts. Synchronous API only.
    public func registerIndicatorSource(_ name: String, _ source: String) throws {try call("nativeRegisterIndicatorSource",[name,source]);notifyChanges()}
    /// Adds a drawing from a core options dictionary and returns its id. Low-level API.
    @discardableResult public func addDrawing(_ options: [String: Any]) throws -> String {try command("addDrawing", [options]).toString() ?? ""}
    /// Raw annotation metrics only; no source data, indicator work or redraw notification.
    public func positionMetrics(_ id: String) throws -> [String: Any] {
        guard let result = try command("positionMetrics", [id]).toDictionary() as? [String: Any] else {throw BaroChartLowLevelError.invalidScene}
        return result
    }
    /// Applies a patch dictionary to the drawing with `id`. Low-level API.
    public func editDrawing(_ id: String, _ patch: [String: Any]) throws {try command("editDrawing", [id, patch])}
    /// Raw-coordinate group edit with one core undo. A zero-change receipt does not notify.
    /// Receipt conversion failure after execution does not imply rollback.
    @discardableResult public func translateDrawings(_ ids: [String], deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("translateDrawings",[ids,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
    /// Deletes the drawing with `id`. Returns `true` if a drawing was removed and `false` if no drawing matched.
    @discardableResult public func deleteDrawing(_ id: String) throws -> Bool {try command("deleteDrawing", [id]).toBool()}
    /// Partial portable style merge, one core undo; zero stored changes do not notify.
    /// Receipt conversion failure after execution does not imply rollback.
    @discardableResult public func setDrawingsStyle(_ ids: [String], patch: [String: Any]) throws -> [String: Any] {
        try ingestionCommand("setDrawingsStyle",[ids,patch])
    }
    /// Visibility is presentation-only, including locked drawings. No-op receipts do not notify.
    @discardableResult public func setDrawingVisibility(_ id: String, visible: Bool) throws -> [String: Any] {
        try ingestionCommand("setDrawingVisibility",[id,visible])
    }
    /// Shows or hides several drawings and returns the core's receipt dictionary. Visibility is presentation-only.
    @discardableResult public func setDrawingsVisibility(_ ids: [String], visible: Bool) throws -> [String: Any] {
        try ingestionCommand("setDrawingsVisibility",[ids,visible])
    }
    /// Chart-local unlocked copies; explicit raw offsets and one atomic core undo.
    @discardableResult public func duplicateDrawing(_ id: String, deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("duplicateDrawing",[id,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
    /// Duplicates several drawings with the given offsets and returns the core's receipt dictionary. `deltaTimeMs` is in milliseconds and `deltaPrice` is in price units.
    @discardableResult public func duplicateDrawings(_ ids: [String], deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("duplicateDrawings",[ids,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
    /// Explicit group deletion, one core undo; empty/missing/locked IDs reject.
    @discardableResult public func deleteDrawings(_ ids: [String]) throws -> [String: Any] {
        try ingestionCommand("deleteDrawings",[ids])
    }
    /// Selects the drawing with `id`. `nil` is sent to the core as null. Throws only ``BaroChartError``.
    public func selectDrawing(_ id: String?) throws {try BaroChartError.mapping {try command("selectDrawing", [id as Any? ?? NSNull()])}}
    /// Applies a theme patch dictionary. The typed overload takes a complete ``BaroChartTheme``.
    public func setTheme(_ patch: [String: Any]) throws {try command("setTheme", [patch])}
    /// Sets instrument metadata from a core symbol dictionary. The typed overload takes a ``BaroChartSymbol``.
    public func setSymbol(_ symbol: [String: Any]) throws {try command("setSymbol", [symbol])}
    /// Sets crosshair snapping from a core options dictionary (`mode` `free`, `close` or `ohlc`, optional `target`).
    public func setCrosshairSnap(_ options: [String: Any]) throws { try command("setCrosshairSnap", [options]) }
    /// Sets drawing magnet behavior from a core options dictionary (`mode` `off`, `weak` or `strong`, optional `radiusPx`).
    public func setDrawingMagnet(_ options: [String: Any]) throws { try command("setDrawingMagnet", [options]) }
    /// Selects the active tool by core name. The typed overload takes a ``BaroChartDrawingTool``.
    public func setTool(_ tool: String) throws {try command("setTool", [tool])}
    /// Sets the text used by the next text drawing the user creates (up to 2000 characters).
    public func setText(_ text: String) throws {try command("setText", [text])}
    /// Undoes the last undoable change. Throws only ``BaroChartError``.
    public func undo() throws {try BaroChartError.mapping {try command("undo")}}
    /// Redoes the last undone change. Throws only ``BaroChartError``.
    public func redo() throws {try BaroChartError.mapping {try command("redo")}}
    /// Fits the visible range to the data. Throws only ``BaroChartError``.
    public func fit() throws {try BaroChartError.mapping {try command("fit")}}
    /// Builds the chart frame for a view of the given size in CSS pixels. Owner thread only. Low-level API that throws its original error types.
    public func scene(width: Double, height: Double) throws -> BaroChartScene {
        let value = try call("nativeSceneJSON", [width, height])
        guard let json = value.toString()?.data(using: .utf8) else { throw BaroChartLowLevelError.invalidScene }
        return try JSONDecoder().decode(BaroChartScene.self, from: json)
    }
    /// Saves the drawings as a document string; restore it with ``loadDrawings(_:)``. Throws only ``BaroChartError``.
    public func saveDrawings() throws -> String {try BaroChartError.mapping {try call("nativeSave").toString() ?? ""}}
    /// Restores drawings from a document made by ``saveDrawings()``. Throws only ``BaroChartError``.
    public func loadDrawings(_ document: String) throws {try BaroChartError.mapping {try command("loadDrawings", [document])}}
}

/// Paints a ``BaroChartScene`` into a Core Graphics context.
public enum BaroChartCoreGraphicsRenderer {
    private static let defaultFont = CTFontCreateWithName("Menlo-Regular" as CFString,12,nil)
    private static let fontPattern = try! NSRegularExpression(pattern: "^((?:(?:bold|italic|normal)\\s+)*)([0-9]+(?:\\.[0-9]+)?)px\\s+(.+)$")
    private static let fontLock = NSLock()
    private static var fonts: [String: CTFont] = [:]
    private static func font(_ css: String?) -> CTFont {
        let css = css ?? "12px monospace"; fontLock.lock(); defer {fontLock.unlock()}
        if let font = fonts[css] {return font}
        let text = css as NSString
        guard let match = fontPattern.firstMatch(in: css,range:NSRange(location:0,length:text.length)),
              let size = Double(text.substring(with: match.range(at:2))), size >= 4, size <= 96 else {return defaultFont}
        let prefix = text.substring(with:match.range(at:1))
        let family = text.substring(with:match.range(at:3)).components(separatedBy:",")[0].trimmingCharacters(in:CharacterSet(charactersIn:" \"'"))
        let name = ["monospace":"Menlo-Regular", "sans-serif":"Helvetica", "serif":"Times-Roman"][family] ?? family
        let base = CTFontCreateWithName(name as CFString,CGFloat(size),nil)
        var traits: CTFontSymbolicTraits = []
        if prefix.contains("bold") {traits.insert(.traitBold)}; if prefix.contains("italic") {traits.insert(.traitItalic)}
        let result = traits.isEmpty ? base : CTFontCreateCopyWithSymbolicTraits(base,CGFloat(size),nil,traits,traits) ?? base
        if fonts.count >= 128 {fonts.removeAll()}; fonts[css] = result; return result
    }
    private static func color(_ hex: String) -> CGColor {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard (s.count == 6 || s.count == 8), let n = UInt64(s, radix: 16) else {return CGColor(red: 1, green: 1, blue: 1, alpha: 1)}
        let rgb = s.count == 8 ? n >> 8 : n, alpha = s.count == 8 ? Double(n & 255) / 255 : 1
        return CGColor(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255, alpha: alpha)
    }
    /// Context coordinates must have top-left origin and downward-positive Y.
    public static func render(_ scene: BaroChartScene, in ctx: CGContext, clear: Bool = true) {
        if clear {ctx.clear(CGRect(x:0,y:0,width:scene.width,height:scene.height));ctx.setFillColor(color(scene.background)); ctx.fill(CGRect(x: 0, y: 0, width: scene.width, height: scene.height))}
        for c in scene.commands {
            ctx.saveGState()
            if let a = c.clip, a.count == 4 {ctx.clip(to: CGRect(x:a[0], y:a[1], width:a[2], height:a[3]))}
            ctx.setStrokeColor(color(c.color ?? "#ffffff")); ctx.setFillColor(color(c.fill ?? c.color ?? "#ffffff")); ctx.setLineWidth(c.width ?? 1)
            if let dash = c.dash {ctx.setLineDash(phase: 0, lengths: dash.map { CGFloat($0) })}
            switch c.op {
            case "lines":
                if let a = c.coords {for i in stride(from: 0, to: a.count - 3, by: 4) {ctx.move(to: CGPoint(x:a[i],y:a[i+1]));ctx.addLine(to:CGPoint(x:a[i+2],y:a[i+3]))};ctx.strokePath()}
            case "rects":
                if let a = c.coords {for i in stride(from:0,to:a.count-3,by:4) {ctx.addRect(CGRect(x:a[i],y:a[i+1],width:a[i+2],height:a[i+3]))};ctx.fillPath()}
            case "path":
                if let a = c.points, a.count >= 2 {
                    let path = CGMutablePath();path.move(to:CGPoint(x:a[0],y:a[1]));for i in stride(from:2,to:a.count-1,by:2) {path.addLine(to:CGPoint(x:a[i],y:a[i+1]))};ctx.addPath(path);ctx.strokePath()
                    if c.fill != nil {path.addLine(to:CGPoint(x:a[a.count-2],y:c.baseline ?? 0));path.addLine(to:CGPoint(x:a[0],y:c.baseline ?? 0));path.closeSubpath();ctx.addPath(path);ctx.fillPath()}
                }
            case "box", "ellipse":
                let rect = CGRect(x:c.x ?? 0,y:c.y ?? 0,width:c.w ?? 0,height:c.h ?? 0)
                if c.op == "box" {ctx.addRect(rect)} else {ctx.addEllipse(in:rect)}
                ctx.drawPath(using:c.fill == nil ? .stroke : .fillStroke)
            case "text":
                let attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String):font(c.font),NSAttributedString.Key(kCTForegroundColorAttributeName as String):color(c.color ?? "#ffffff")]
                let line = CTLineCreateWithAttributedString(NSAttributedString(string:c.text ?? "",attributes:attributes))
                ctx.translateBy(x:c.x ?? 0,y:c.y ?? 0);ctx.scaleBy(x:1,y:-1);ctx.textMatrix = .identity;ctx.textPosition = .zero;CTLineDraw(line,ctx)
            default: break
            }
            ctx.restoreGState()
        }
    }
}
