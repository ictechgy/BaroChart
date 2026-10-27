import Foundation
import JavaScriptCore
import CoreGraphics
import CoreText

public enum AsterError: Error { case javaScript(String), unavailableContext, invalidScene, wrongThread }
/// Stable queue/admission error from the shared ingestion contract. Original
/// owner/closed-engine failures keep their existing AsterError/AsterAsyncError.
public struct AsterIngestionError: Error, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(code: String, message: String) {self.code=code;self.message=message}
    public var description: String {"IngestionError[\(code)]: \(message)"}
}
public struct AsterBar: Codable {
    public let time, open, high, low, close, volume: Double
    public init(time: Double, open: Double, high: Double, low: Double, close: Double, volume: Double) {
        self.time = time; self.open = open; self.high = high; self.low = low; self.close = close; self.volume = volume
    }
}
public struct AsterCommand: Decodable {
    public let op: String
    public let coords, points, clip, dash: [Double]?
    public let x, y, w, h, width, baseline: Double?
    public let color, fill, text, font: String?
    /// Optional label semantics from the shared core. Older scene bundles omit
    /// these fields; raw data/anchors remain separate from display commands.
    public let role, fullText, panelId, axisId: String?
    public let labelBounds: [Double]?
}
public struct AsterScene: Decodable {
    public let width, height: Double
    public let background: String
    public let commands: [AsterCommand]
    public let stats: [String: Int]
}

public enum AsterAsyncError: Error {
    case mainOwnerRequired, busy, cancelled, timedOut, engineClosed, sourceDeallocated
    case invalidProtocol(String)
}
public struct AsterAsyncProgress {
    public let phase: String
    public let done, total: Int
}
public struct AsterAsyncMetrics {
    /// Logical six-column input bytes retained during preparation. Swift COW
    /// aliases may use less physical storage; this is not a process footprint.
    public internal(set) var retainedInputBytes = 0, inputOwnershipMs = 0.0
    public internal(set) var copiedBytes = 0, checkpointJSONBytes = 0, maximumChunkBytes = 0
    public internal(set) var captureMs = 0.0, targetCopyMs = 0.0, computeMs = 0.0, workerInitMs = 0.0
    public internal(set) var beginMs = 0.0, queueWaitMs = 0.0, commitMs = 0.0
    public internal(set) var uiStateMs = 0.0, finishMs = 0.0, totalMs = 0.0
    public internal(set) var uiChunkCount = 0, uiTransferBytes = 0, maximumUIChunkBytes = 0, workerUIImportMs = 0.0
    public internal(set) var baselineResidentBytes: UInt64 = 0, peakResidentBytes: UInt64 = 0
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
private func asterInvoke(_ context: JSContext, _ name: String, _ args: [Any] = []) throws -> JSValue {
    guard let function = context.objectForKeyedSubscript(name), !function.isUndefined,
          let value = function.call(withArguments: args) else {throw AsterError.javaScript("Missing function: \(name)")}
    if let exception = context.exception {
        context.exception = nil
        // Async begin/lease failures retain the same stable queue error code.
        // Other protocol exceptions preserve the existing generic boundary.
        if exception.forProperty("name")?.toString()=="IngestionError",let code=exception.forProperty("code"),code.isString,let codeText=code.toString(),!codeText.isEmpty,codeText.utf16.count<=64,let message=exception.forProperty("message"),message.isString,let messageText=message.toString(),messageText.utf16.count<=256 {
            throw AsterIngestionError(code:codeText,message:messageText)
        }
        throw AsterError.javaScript(exception.toString() ?? "Unknown JS error")
    }
    return value
}
private func asterDictionary(_ value: JSValue) throws -> [String: Any] {
    guard let text=value.toString() else{throw AsterAsyncError.invalidProtocol("Expected JSON string")}
    return try asterDictionary(text)
}
private func asterDictionary(_ text:String,maximumBytes:Int=8388608) throws -> [String:Any] {
    guard let bytes = text.data(using: .utf8), bytes.count <= maximumBytes,
          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {throw AsterAsyncError.invalidProtocol("Expected bounded JSON object string")}
    return object
}
private func asterInteger(_ value: Any?, _ maximum: Int = Int.max) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= Double(maximum),
          number.doubleValue.rounded(.towardZero) == number.doubleValue else {throw AsterAsyncError.invalidProtocol("Invalid integer")}
    return number.intValue
}

// The pointer is backing-buffer base, NOT view base. Do all JSC API calls before
// obtaining the temporary pointer; do not call JSC again until memcpy completes.
// See WebKit JSTypedArray.cpp and the SDK JSTypedArray.h lifetime contract.
private func asterTypedBytes(_ value: JSValue, _ context: JSContext, count: Int) throws -> UnsafeMutableRawPointer {
    guard count > 0, count <= 262144 else {throw AsterAsyncError.invalidProtocol("Invalid copy count")}
    var exception: JSValueRef?
    let ctx = context.jsGlobalContextRef!
    guard JSValueGetTypedArrayType(ctx, value.jsValueRef, &exception) == kJSTypedArrayTypeFloat64Array,
          let object = JSValueToObject(ctx, value.jsValueRef, &exception) else {throw AsterAsyncError.invalidProtocol("Expected Float64Array")}
    let length = JSObjectGetTypedArrayLength(ctx, object, &exception)
    let byteLength = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
    let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
    guard let buffer = JSObjectGetTypedArrayBuffer(ctx, object, &exception) else {throw AsterAsyncError.invalidProtocol("Missing typed buffer")}
    let total = JSObjectGetArrayBufferByteLength(ctx, buffer, &exception)
    guard exception == nil, length == count, byteLength == count * MemoryLayout<Double>.size,
          offset <= total, byteLength <= total - offset, offset % MemoryLayout<Double>.size == 0 else {throw AsterAsyncError.invalidProtocol("Typed buffer bounds mismatch")}
    guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception), exception == nil else {throw AsterAsyncError.invalidProtocol("Unavailable typed bytes")}
    return pointer.advanced(by: offset)
}

private struct AsterAsyncBuffer {let slot, length: Int}
private struct AsterAsyncCheckpoint {let entry, total, maxRows: Int}
private struct AsterAsyncPlan {
    let ticket: Int
    let metadata: String
    let buffers: [AsterAsyncBuffer]
    let checkpoints: [AsterAsyncCheckpoint]
    init(_ object: [String: Any]) throws {
        ticket = try asterInteger(object["ticket"], 9007199254740991)
        guard let text = object["metadataJSON"] as? String, text.utf8.count <= 8388608,
              let rawBuffers = object["buffers"] as? [[String: Any]], rawBuffers.count <= 8192,
              let rawCheckpoints = object["checkpoints"] as? [[String: Any]], rawCheckpoints.count <= 128 else {throw AsterAsyncError.invalidProtocol("Invalid capture descriptor")}
        metadata = text
        var slots = Set<Int>(), entries = Set<Int>(), totalBytes = 0
        buffers = try rawBuffers.map {
            let slot = try asterInteger($0["slot"], 8191), length = try asterInteger($0["length"], 16777216)
            guard slots.insert(slot).inserted, length <= (Int.max - totalBytes) / 8 else {throw AsterAsyncError.invalidProtocol("Duplicate or oversized buffer")}
            totalBytes += length * 8
            guard totalBytes <= 4294967296 else {throw AsterAsyncError.invalidProtocol("Snapshot exceeds host byte budget")}
            return AsterAsyncBuffer(slot: slot, length: length)
        }
        checkpoints = try rawCheckpoints.map {
            let entry = try asterInteger($0["entry"], 127), total = try asterInteger($0["total"], 4194304)
            let maxRows = try $0["maxRows"].map {try asterInteger($0,64)} ?? 64
            guard maxRows >= 1 else {throw AsterAsyncError.invalidProtocol("Invalid checkpoint chunk rows")}
            guard entries.insert(entry).inserted else {throw AsterAsyncError.invalidProtocol("Duplicate checkpoint entry")}
            return AsterAsyncCheckpoint(entry: entry, total: total, maxRows: maxRows)
        }
    }
}

private enum AsterAsyncKind {case correction, columns, seeded}

/// Handle cancellation from any thread. It is cooperative at capture/compute
/// chunk boundaries; it never frees a VM while a JS function is running.
public final class AsterAsyncJob {
    private let lock = NSLock()
    private var stopped: Error?, terminal = false, committed = false, callbackErrors = 0, progressPending = false
    private var latestProgress: AsterAsyncProgress?
    fileprivate weak var engine: AsterEngine?
    fileprivate var source: JSContext?
    private var workspaceSourceRuntime: AsterContextRuntime?
    fileprivate var runtime: AsterAsyncRuntime?
    fileprivate var ticket: Int?
    fileprivate var plan: AsterAsyncPlan?
    fileprivate var kind: AsterAsyncKind = .correction
    fileprivate var hostColumns: AsterColumns?
    fileprivate var progress: ((AsterAsyncProgress) throws -> Void)?
    fileprivate var completion: ((Result<AsterAsyncMetrics, Error>) -> Void)?
    fileprivate var metrics = AsterAsyncMetrics()
    fileprivate let started = asterClock(), timeout: Double
    fileprivate init(engine: AsterEngine, timeout: Double, progress: ((AsterAsyncProgress) throws -> Void)?, completion: @escaping (Result<AsterAsyncMetrics, Error>) -> Void) {
        self.engine = engine; self.source = engine.context; self.timeout = timeout;self.progress = progress;self.completion = completion
        if engine.workspaceContextInstalled, let runtime = engine.contextRuntime {
            if runtime.acquireCaptureLease() {workspaceSourceRuntime = runtime}
            else {stopped = AsterAsyncError.invalidProtocol("Source runtime is retiring")}
        }
        metrics.baselineResidentBytes = asterResidentBytes();metrics.peakResidentBytes = metrics.baselineResidentBytes
    }
    public func cancel() {stop(AsterAsyncError.cancelled)}
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
        if asterClock() - started >= timeout {throw AsterAsyncError.timedOut}
    }
    // Cancellation and commit have one linearization point. A cancellation
    // accepted before this lock prevents publication; after commit it is inert.
    // No user callbacks execute under this lock.
    fileprivate func commit(_ publish: () throws -> Void) throws {
        lock.lock();defer {lock.unlock()}
        if let error = stopped {throw error}
        guard !terminal && !committed else {throw AsterAsyncError.invalidProtocol("Repeated commit")}
        if asterClock()-started >= timeout {throw AsterAsyncError.timedOut}
        try publish();committed = true
    }
    fileprivate func sampleMemory() {metrics.peakResidentBytes = max(metrics.peakResidentBytes, asterResidentBytes())}
    fileprivate func report(_ value: AsterAsyncProgress) {
        lock.lock();latestProgress = value
        if progressPending || terminal {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress;progressPending = false;let isTerminal = terminal;lock.unlock()
            guard !isTerminal, let value = value, let callback = progress else {return}
            do {try callback(value)} catch {lock.lock();callbackErrors += 1;lock.unlock()}
        }
    }
    fileprivate func ownerSource() throws -> JSContext {
        precondition(Thread.isMainThread)
        try check()
        guard let engine = engine else {throw AsterAsyncError.sourceDeallocated}
        guard !engine.closed else {throw AsterAsyncError.engineClosed}
        guard engine.activeAsync === self, let source = source, engine.context === source else {throw AsterAsyncError.invalidProtocol("Source context was replaced")}
        if let ticket = ticket {_ = try asterInvoke(source, "nativeAsyncCheck", [ticket])}
        return source
    }
    fileprivate func sourceChunk<T>(_ capture: @escaping (JSContext) throws -> T) throws -> T {
        let box = AsterCaptureBox<T>(), requestedAt = asterClock()
        DispatchQueue.main.async { [self] in
            let ownerStartedAt = asterClock()
            do {let source = try ownerSource();box.resolve(.success(try capture(source)),startedAt:ownerStartedAt)} catch {box.resolve(.failure(error),startedAt:ownerStartedAt)}
        }
        let reply = try box.wait(self), resumedAt = asterClock()
        // Scheduling latency excludes the actual owner capture/check operation.
        metrics.queueWaitMs += max(0,reply.startedAt-requestedAt)*1000 + max(0,resumedAt-reply.resolvedAt)*1000
        return try reply.result.get()
    }
    fileprivate func finish(_ result: Result<AsterAsyncMetrics, Error>) {
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
private struct AsterCaptureReply<T> {let result: Result<T,Error>,startedAt: Double,resolvedAt: Double}
private final class AsterCaptureBox<T> {
    private let condition = NSCondition()
    private var reply: AsterCaptureReply<T>?
    func resolve(_ value: Result<T, Error>, startedAt: Double) {
        let result = AsterCaptureReply(result:value,startedAt:startedAt,resolvedAt:asterClock())
        condition.lock();reply = result;condition.signal();condition.unlock()
    }
    func wait(_ job: AsterAsyncJob) throws -> AsterCaptureReply<T> {
        condition.lock();defer {condition.unlock()}
        while reply == nil {_ = condition.wait(until: Date(timeIntervalSinceNow:0.02));try job.check()}
        return reply!
    }
}

// Capture leases delay actual creator retirement, not merely object deinit.
private protocol AsterContextRuntime: AnyObject {
    func retire()
    func acquireCaptureLease() -> Bool
    func releaseCaptureLease()
    func releaseCaptureLease(afterRetirementIfNeeded: @escaping () -> Void)
}
private final class AsterRuntimeRetirement {
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
public enum AsterWorkspaceError: Error {case cleanupPending(registration: Int)}
public struct AsterWorkspaceMetrics {
    public internal(set) var copiedBytes = 0, logicalAdmissionBytes = 0, progressCallbackErrors = 0
    public internal(set) var totalMs = 0.0
}
public struct AsterWorkspaceCleanupStatus {
    public let registration, admittedLogicalBytes, retryFailures: Int
    /// Unadmitted zero bytes means unknown retained cost, bounded by slots only.
    public let admitted, awaitingCreatorCleanup: Bool
}
private let asterWorkspaceMaxBytes = 768 * 1024 * 1024
// Main-owner accounting shared by workspace and entry-only parameter jobs.
// Before descriptor admission only the slot is bounded; zero is unknown cost.
private final class AsterNativeAdmissionLease {fileprivate var bytes = 0, admitted = false, released = false}
private enum AsterNativeAdmission {
    private static var slots = 0, bytes = 0
    static func reserve() throws -> AsterNativeAdmissionLease {
        precondition(Thread.isMainThread)
        guard slots < 2 else {throw AsterAsyncError.busy}
        slots += 1;return AsterNativeAdmissionLease()
    }
    static func admit(_ lease: AsterNativeAdmissionLease, _ cost: Int) throws {
        precondition(Thread.isMainThread)
        guard !lease.released, !lease.admitted, cost > 0, cost <= asterWorkspaceMaxBytes - bytes else {throw AsterAsyncError.busy}
        bytes += cost;lease.bytes = cost;lease.admitted = true
    }
    static func release(_ lease: AsterNativeAdmissionLease) {
        precondition(Thread.isMainThread)
        if lease.released {return}
        lease.released = true;slots -= 1;bytes -= lease.bytes
    }
}
private func asterWorkspaceObject(_ value: JSValue) throws -> [String: Any] {
    guard value.isObject, let object = value.toDictionary() as? [String: Any] else {throw AsterAsyncError.invalidProtocol("Workspace object receipt")}
    return object
}
private func asterWorkspaceBool(_ value: Any?) throws -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {throw AsterAsyncError.invalidProtocol("Workspace boolean receipt")}
    return number.boolValue
}
private func asterWorkspaceTrue(_ value: JSValue) throws {
    guard value.isBoolean, value.toBool() else {throw AsterAsyncError.invalidProtocol("Workspace true receipt")}
}
// Main-only minimal recovery owner: no Engine/job/Error/client callback fields.
private final class AsterWorkspaceSourceRecord {
    let registration: Int
    let admission: AsterNativeAdmissionLease
    var context: JSContext?
    private var runtime: AsterContextRuntime?
    var bytes = 0, admitted = false, pending = false, retrying = false, failures = 0
    var began = false, released = false, detaching = false
    init(registration: Int, context: JSContext, runtime: AsterContextRuntime?, admission: AsterNativeAdmissionLease) throws {
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw AsterAsyncError.invalidProtocol("Source runtime is retiring")}
        self.registration = registration;self.context = context;self.runtime = runtime;self.admission = admission
    }
    func abort() throws {
        precondition(Thread.isMainThread)
        if released {return}
        if began {
            try autoreleasepool {
                guard let context = context else {throw AsterAsyncError.invalidProtocol("Missing captured source")}
                let value = try asterInvoke(context,"nativeWorkspaceSourceAbort",[registration])
                guard value.isBoolean else {throw AsterAsyncError.invalidProtocol("Workspace abort receipt")}
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
private enum AsterWorkspaceRegistry {
    private static var records: [Int: AsterWorkspaceSourceRecord] = [:]
    private static var next = 0
    static func reserve(_ context: JSContext, _ runtime: AsterContextRuntime?) throws -> AsterWorkspaceSourceRecord {
        precondition(Thread.isMainThread)
        guard records.count < 2, next < 9007199254740991 else {throw AsterAsyncError.busy}
        next += 1
        let admission = try AsterNativeAdmission.reserve()
        do {
            let record = try AsterWorkspaceSourceRecord(registration:next,context:context,runtime:runtime,admission:admission)
            records[record.registration] = record;return record
        } catch {AsterNativeAdmission.release(admission);throw error}
    }
    static func contains(_ registration: Int) -> Bool {precondition(Thread.isMainThread);return records[registration] != nil}
    static func admit(_ record: AsterWorkspaceSourceRecord, _ cost: Int) throws {
        precondition(Thread.isMainThread)
        guard records[record.registration] === record, !record.admitted else {throw AsterAsyncError.busy}
        try AsterNativeAdmission.admit(record.admission,cost)
        record.bytes = cost;record.admitted = true
    }
    static func remove(_ record: AsterWorkspaceSourceRecord, completion: @escaping () -> Void = {}) {
        precondition(Thread.isMainThread && record.released)
        guard records[record.registration] === record, !record.detaching else {return}
        record.detach {
            precondition(Thread.isMainThread)
            guard records[record.registration] === record else {return}
            // Actual retired-source creator cleanup precedes reservation release.
            records.removeValue(forKey:record.registration);AsterNativeAdmission.release(record.admission)
            completion()
        }
    }
    static func status() -> [AsterWorkspaceCleanupStatus] {
        precondition(Thread.isMainThread)
        return records.values.filter{$0.pending}.sorted{$0.registration < $1.registration}.map {
            AsterWorkspaceCleanupStatus(registration:$0.registration,admittedLogicalBytes:$0.bytes,retryFailures:$0.failures,admitted:$0.admitted,awaitingCreatorCleanup:$0.detaching)
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
private struct AsterWorkspaceDescriptor {
    let ticket, length, bytes: Int
    let metadata: String
    init(_ value: [String: Any], ticket: Int) throws {
        guard value["phase"] as? String == "copy", try asterInteger(value["ticket"],9007199254740991) == ticket,
              let metadata = value["metadataJSON"] as? String, metadata.utf16.count <= 8388608,
              let checkpoints = value["checkpoints"] as? [Any], checkpoints.isEmpty,
              let buffers = value["buffers"] as? [[String:Any]], buffers.count == 6,
              let plan = value["plan"] as? [String:Any] else {throw AsterAsyncError.invalidProtocol("Workspace descriptor binding")}
        var count: Int?
        for slot in 0..<6 {
            guard try asterInteger(buffers[slot]["slot"],5) == slot else {throw AsterAsyncError.invalidProtocol("Workspace source slot order")}
            let n = try asterInteger(buffers[slot]["length"],4194304)
            if let count = count, count != n {throw AsterAsyncError.invalidProtocol("Workspace column lengths")};count = n
        }
        let cost = try asterInteger(plan["totalBytes"],asterWorkspaceMaxBytes)
        guard cost > 0 else {throw AsterAsyncError.invalidProtocol("Workspace logical bytes")}
        self.ticket = ticket;length = count!;bytes = cost;self.metadata = metadata
    }
}

// A separate VM and creation-thread run loop prevent the source VM lock from
// blocking UI. After handoff this thread performs no JS API calls. Retiring the
// owning context stops its run loop; cached old raw contexts are unsupported.
private final class AsterAsyncRuntime: AsterContextRuntime {
    private let retirement = AsterRuntimeRetirement()
    private var initialJob: AsterAsyncJob?
    private let bundle: String
    init(bundle: String, job: AsterAsyncJob) {self.bundle = bundle;initialJob = job}
    func start() {let thread = Thread { [self] in run() };thread.name = "Aster isolated JavaScriptCore";thread.qualityOfService = .userInitiated;thread.start()}
    func retire() {retirement.retire()}
    func acquireCaptureLease() -> Bool {retirement.acquire()}
    func releaseCaptureLease() {retirement.release()}
    func releaseCaptureLease(afterRetirementIfNeeded completion: @escaping () -> Void) {retirement.release(completion)}
    private struct Prepared {let context: JSContext;let plan: AsterAsyncPlan}
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
    private func compute(_ job: AsterAsyncJob) throws -> Prepared {
            try job.check()
            let start = asterClock()
            guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm), let plan = job.plan else {throw AsterError.unavailableContext}
            context.evaluateScript(bundle)
            if let exception = context.exception {context.exception = nil;throw AsterError.javaScript(exception.toString() ?? "Bundle error")}
            _ = try asterInvoke(context,job.kind == .correction ? "nativeAsyncCreate" : "nativePrepareCreate",[plan.metadata]);job.metrics.workerInitMs = (asterClock()-start)*1000;job.sampleMemory()
            if job.kind != .correction {
                guard plan.buffers.isEmpty,plan.checkpoints.isEmpty else {throw AsterAsyncError.invalidProtocol("Prepare must not copy source buffers")}
                if job.kind == .columns {
                    guard let columns=job.hostColumns else {throw AsterAsyncError.invalidProtocol("Missing owned columns")}
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
                                let target=try asterInvoke(context,"nativeAsyncTargetBuffer",[slot,at,count])
                                let destination=try asterTypedBytes(target,context,count:count)
                                field.withUnsafeBufferPointer {buffer in _=memcpy(destination,buffer.baseAddress!.advanced(by:at),count*8)}
                            }
                            let bytes=count*8;job.metrics.targetCopyMs += (asterClock()-copyStart)*1000;job.metrics.copiedBytes += bytes;job.metrics.maximumChunkBytes=max(job.metrics.maximumChunkBytes,bytes)
                            copied += bytes;offset += count;job.sampleMemory();job.report(AsterAsyncProgress(phase:"capture",done:copied,total:columns.retainedBytes))
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
                        let begin = asterClock(), value = try asterInvoke(source,"nativeAsyncBuffer",[plan.ticket,buffer.slot,at,count])
                        let bytes = Data(bytes:try asterTypedBytes(value,source,count:count),count:count*8)
                        return (bytes,(asterClock()-begin)*1000)
                    }
                    try job.check()
                    let copyStart = asterClock(), target = try asterInvoke(context,"nativeAsyncTargetBuffer",[buffer.slot,at,count])
                    let destination = try asterTypedBytes(target,context,count:count)
                    chunk.0.withUnsafeBytes {bytes in _ = memcpy(destination,bytes.baseAddress!,bytes.count)}
                    job.metrics.captureMs += chunk.1;job.metrics.targetCopyMs += (asterClock()-copyStart)*1000
                    job.metrics.copiedBytes += chunk.0.count;job.metrics.maximumChunkBytes = max(job.metrics.maximumChunkBytes,chunk.0.count)
                    copied += count * 8;offset += count;job.sampleMemory();job.report(AsterAsyncProgress(phase:"capture",done:copied,total:totalBytes))
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
                        guard let text = try asterInvoke(source,"nativeAsyncCheckpoint",[plan.ticket,checkpoint.entry,at,count]).toString(),text.utf8.count <= 8388608 else {throw AsterAsyncError.invalidProtocol("Oversized checkpoint chunk")}
                        return (text,(asterClock()-begin)*1000)
                    }
                    try job.check();let importStart = asterClock();_ = try asterInvoke(context,"nativeAsyncCheckpointImport",[checkpoint.entry,rows.0])
                    job.metrics.captureMs += rows.1;job.metrics.targetCopyMs += (asterClock()-importStart)*1000;job.metrics.checkpointJSONBytes += rows.0.utf8.count
                    offset += count;imported += count;job.sampleMemory();job.report(AsterAsyncProgress(phase:"checkpoints",done:imported,total:totalCheckpoints))
                }
            }
            try job.check();let computeStart = asterClock();_ = try asterInvoke(context,"nativeAsyncStart")
            var lastProgress = 0.0
            while true {
                try job.check()
                let state = try asterDictionary(asterInvoke(context,"nativeAsyncStep",[4096]))
                guard let phase = state["phase"] as? String,["generate","validate","store-index","calculate","indices","ready"].contains(phase),let complete = state["complete"] as? Bool else {throw AsterAsyncError.invalidProtocol("Invalid compute progress")}
                let done = try asterInteger(state["done"]),total = try asterInteger(state["total"])
                guard done <= total else {throw AsterAsyncError.invalidProtocol("Invalid progress bounds")}
                let now = asterClock();if complete || now-lastProgress >= 0.016 {job.report(AsterAsyncProgress(phase:phase,done:done,total:total));lastProgress = now;job.sampleMemory()}
                if complete {break}
            }
            job.metrics.computeMs = (asterClock()-computeStart)*1000;try job.check();job.sampleMemory()
            // UI/history is captured after numeric computation, with one
            // bounded owner response in flight. Restore/validate on the worker
            // before its VM is handed to the owner; no large owner JSON parse.
            let header:(String,Double)=try job.sourceChunk { source in
                let begin=asterClock();guard let text=try asterInvoke(source,"nativeAsyncUIBegin",[plan.ticket]).toString(),text.utf8.count<=1048576 else{throw AsterAsyncError.invalidProtocol("Oversized UI header")};return (text,(asterClock()-begin)*1000)
            }
            job.metrics.uiStateMs += header.1;job.metrics.uiTransferBytes += header.0.utf8.count;job.metrics.maximumUIChunkBytes=max(job.metrics.maximumUIChunkBytes,header.0.utf8.count)
            let headerStart=asterClock(),headerObject=try asterDictionary(header.0,maximumBytes:1048576)
            guard let state=headerObject["state"] as? [String:Any],let drawings=state["drawings"] as? [String:Any],let frames=drawings["frameCounts"] as? [Any],frames.count<=20001 else{throw AsterAsyncError.invalidProtocol("UI drawing frame counts")}
            var uiTotal=0;for value in frames{let n=try asterInteger(value,10000);guard uiTotal<=5000000-n else{throw AsterAsyncError.invalidProtocol("UI reference budget")};uiTotal += n}
            _=try asterInvoke(context,"nativeAsyncUIImportBegin",[header.0]);job.metrics.workerUIImportMs += (asterClock()-headerStart)*1000
            var uiChunks=0,uiReferences=0
            job.report(AsterAsyncProgress(phase:"ui-copy",done:0,total:uiTotal))
            while true {
                try job.check()
                let chunk:(String,Double)=try job.sourceChunk { source in
                    let begin=asterClock();guard let text=try asterInvoke(source,"nativeAsyncUINext",[plan.ticket]).toString(),text.utf8.count<=1048576 else{throw AsterAsyncError.invalidProtocol("Oversized UI chunk")};return (text,(asterClock()-begin)*1000)
                }
                try job.check();job.metrics.uiStateMs += chunk.1;job.metrics.uiTransferBytes += chunk.0.utf8.count;job.metrics.maximumUIChunkBytes=max(job.metrics.maximumUIChunkBytes,chunk.0.utf8.count)
                let importStart=asterClock(),state=try asterDictionary(chunk.0,maximumBytes:1048576)
                guard let flag=state["complete"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID() else{throw AsterAsyncError.invalidProtocol("UI completion boolean")}
                if flag.boolValue{job.metrics.workerUIImportMs += (asterClock()-importStart)*1000;break}
                guard let refs=state["refs"] as? [Any],refs.count>=1,refs.count<=64,uiReferences<=uiTotal-refs.count else{throw AsterAsyncError.invalidProtocol("UI reference chunk bounds")}
                try autoreleasepool{_=try asterInvoke(context,"nativeAsyncUIImportChunk",[chunk.0])};job.metrics.workerUIImportMs += (asterClock()-importStart)*1000
                uiChunks += 1;uiReferences += refs.count;job.metrics.uiChunkCount=uiChunks;job.sampleMemory();job.report(AsterAsyncProgress(phase:"ui-copy",done:uiReferences,total:uiTotal))
            }
            guard uiReferences==uiTotal else{throw AsterAsyncError.invalidProtocol("UI transfer incomplete")}
            try job.check();let endStart=asterClock();_=try asterInvoke(context,"nativeAsyncUIImportEnd");job.metrics.workerUIImportMs += (asterClock()-endStart)*1000
            job.report(AsterAsyncProgress(phase:"ui-copy",done:uiReferences,total:uiTotal));try job.check()
            return Prepared(context:context,plan:plan)
    }
    private func handoff(_ job: AsterAsyncJob, _ prepared: Prepared) {
        // This is queued only after compute() returned and its autorelease pool
        // drained. The creation run loop stays alive, with no worker JS calls.
        DispatchQueue.main.async { [self] in
            do {
                var source: JSContext? = try job.ownerSource();let uiStart = asterClock()
                _=try asterInvoke(source!,"nativeAsyncUICheck",[prepared.plan.ticket]);job.metrics.uiStateMs += (asterClock()-uiStart)*1000
                try job.check();let finishStart = asterClock();_ = try asterInvoke(prepared.context,"nativeAsyncFinish",[""]);job.metrics.finishMs = (asterClock()-finishStart)*1000
                _ = try job.ownerSource();try job.check()
                guard let engine = job.engine else {throw AsterAsyncError.sourceDeallocated}
                let commitStart = asterClock()
                try job.commit {
                    _ = try asterInvoke(source!,"nativeAsyncRelease",[prepared.plan.ticket]);job.ticket = nil
                    let previousRuntime = engine.contextRuntime
                    engine.context = prepared.context;engine.contextRuntime = self
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
public final class AsterWorkspaceJob {
    private let lock = NSLock()
    private var cancelled = false, terminal = false, committed = false, finishing = false, callbackErrors = 0
    private var progressPending = false, latestProgress: AsterAsyncProgress?
    fileprivate weak var engine: AsterEngine?
    private var record: AsterWorkspaceSourceRecord?
    private var descriptor: AsterWorkspaceDescriptor?
    private var document: String?, binding: [String:Any]?
    private var targetRuntime: AsterWorkspaceRuntime?
    private var progress: ((AsterAsyncProgress) throws -> Void)?
    private var completion: ((Result<AsterWorkspaceMetrics,Error>) -> Void)?
    private let sourceRevision: UInt64, timeout: Double, maxBars: Int
    private let started = asterClock()
    private var metrics = AsterWorkspaceMetrics()
    public let registration: Int
    fileprivate init(engine: AsterEngine, record: AsterWorkspaceSourceRecord, document: String, binding: [String:Any], timeout: Double, maxBars: Int,
                     progress: ((AsterAsyncProgress) throws -> Void)?, completion: @escaping (Result<AsterWorkspaceMetrics,Error>) -> Void) {
        self.engine = engine;self.record = record;self.document = document;self.binding = binding;self.timeout = timeout;self.maxBars = maxBars
        self.progress = progress;self.completion = completion;sourceRevision = engine.revision;registration = record.registration
    }
    public func cancel() {lock.lock();if !terminal && !committed {cancelled = true};lock.unlock()}
    public var cleanupPending: Bool {precondition(Thread.isMainThread);return AsterWorkspaceRegistry.status().contains{$0.registration == registration}}
    fileprivate func check() throws {
        lock.lock();let stopped = cancelled, finished = terminal || finishing;lock.unlock()
        if stopped {throw AsterAsyncError.cancelled}
        if finished {throw AsterAsyncError.invalidProtocol("Workspace job completed")}
        if asterClock() - started >= timeout {throw AsterAsyncError.timedOut}
    }
    private func finalOwner() throws -> AsterEngine {
        precondition(Thread.isMainThread)
        guard let engine = engine else {throw AsterAsyncError.sourceDeallocated}
        guard !engine.closed && !engine.closing else {throw AsterAsyncError.engineClosed}
        guard engine.activeWorkspace === self, engine.revision == sourceRevision,
              let source = record?.context, engine.contextBacking === source else {throw AsterAsyncError.invalidProtocol("Workspace source stale")}
        return engine
    }
    private func sourceCall<T>(_ operation: (JSContext) throws -> T) throws -> T {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        let result: T = try autoreleasepool {
            guard let source = record?.context else {throw AsterAsyncError.invalidProtocol("Missing workspace source")}
            if let ticket = descriptor?.ticket {try asterWorkspaceTrue(asterInvoke(source,"nativeWorkspaceSourceCheck",[ticket,sourceRevision]))}
            return try operation(source)
        }
        try check();_ = try finalOwner();return result
    }
    fileprivate func start(bundle: String) {
        precondition(Thread.isMainThread)
        do {
            try check();_ = try finalOwner()
            guard let record = record, let document = document, let binding = binding else {throw AsterAsyncError.invalidProtocol("Missing workspace request")}
            record.began = true // registration can succeed before response fails
            let receipt = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceBegin",[document,binding,sourceRevision,asterWorkspaceMaxBytes,registration]))}
            guard try asterInteger(receipt["registration"],9007199254740991) == registration else {throw AsterAsyncError.invalidProtocol("Workspace registration binding")}
            let ticket = try asterInteger(receipt["ticket"],9007199254740991)
            guard ticket > 0 else {throw AsterAsyncError.invalidProtocol("Workspace ticket")}
            self.document = nil;self.binding = nil;admit(ticket:ticket,bundle:bundle)
        } catch {fail(error)}
    }
    private func admit(ticket: Int, bundle: String) {
        precondition(Thread.isMainThread)
        do {
            let value = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceStep",[ticket,8,sourceRevision]))}
            let complete = try asterWorkspaceBool(value["complete"]), done = try asterInteger(value["done"],9007199254740991)
            if !complete {
                guard value["phase"] as? String == "admission" else {throw AsterAsyncError.invalidProtocol("Workspace admission phase")}
                report(AsterAsyncProgress(phase:"admission",done:done,total:done))
                DispatchQueue.main.async { [self] in admit(ticket:ticket,bundle:bundle) };return
            }
            let plan = try AsterWorkspaceDescriptor(value,ticket:ticket)
            guard let record = record else {throw AsterAsyncError.invalidProtocol("Missing source reservation")}
            try AsterWorkspaceRegistry.admit(record,plan.bytes);descriptor = plan;metrics.logicalAdmissionBytes = plan.bytes
            try check();_ = try finalOwner()
            let runtime = AsterWorkspaceRuntime(bundle:bundle,job:self,plan:plan,maxBars:maxBars)
            targetRuntime = runtime;runtime.start()
        } catch {fail(error)}
    }
    fileprivate func capture(slot: Int, offset: Int, count: Int) throws -> Data {
        let box = AsterWorkspaceCaptureBox<Data>()
        DispatchQueue.main.async { [self] in
            do {
                let data = try sourceCall { source -> Data in
                    guard let ticket = descriptor?.ticket else {throw AsterAsyncError.invalidProtocol("Missing workspace descriptor")}
                    let value = try asterInvoke(source,"nativeAsyncBuffer",[ticket,slot,offset,count])
                    return Data(bytes:try asterTypedBytes(value,source,count:count),count:count*8)
                }
                box.resolve(.success(data))
            } catch {box.resolve(.failure(error))}
        }
        return try box.wait(self)
    }
    fileprivate func report(_ value: AsterAsyncProgress) {
        lock.lock();if terminal {lock.unlock();return};latestProgress = value
        if progressPending {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress, finished = terminal;progressPending = false;lock.unlock()
            guard !finished, let value = value, let progress = progress else {return}
            do {try progress(value)} catch {lock.lock();callbackErrors = min(32,callbackErrors + 1);lock.unlock()}
        }
    }
    fileprivate func install(_ context: JSContext, runtime: AsterWorkspaceRuntime, copied: Int) throws -> AsterEngine {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        guard let record = record, let plan = descriptor else {throw AsterAsyncError.invalidProtocol("Missing workspace handoff")}
        let receipt = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeWorkspaceSourceFinish",[plan.ticket,sourceRevision]))}
        guard receipt["schema"] as? String == "aster.native-workspace-source-finished",
              try asterInteger(receipt["version"],1) == 1, try asterInteger(receipt["ticket"],9007199254740991) == plan.ticket,
              try asterInteger(receipt["revision"],9007199254740991) == Int(sourceRevision) else {throw AsterAsyncError.invalidProtocol("Workspace finish binding")}
        record.released = true
        // Strong locals ensure no last ARC context/runtime release inside lock.
        var oldContext = record.context
        var oldRuntime = engine?.contextRuntime
        lock.lock()
        do {
            if cancelled {throw AsterAsyncError.cancelled}
            guard !terminal && !committed && !finishing else {throw AsterAsyncError.invalidProtocol("Repeated workspace commit")}
            if asterClock() - started >= timeout {throw AsterAsyncError.timedOut}
            let owner = try finalOwner() // callback-free property checks only
            owner.contextBacking = context;owner.workspaceContextInstalled = true;owner.contextRuntime = runtime
            committed = true;lock.unlock()
            metrics.copiedBytes = copied;targetRuntime = nil
            withExtendedLifetime(oldContext) {};oldContext = nil
            oldRuntime?.retire();oldRuntime = nil // lease still prevents shutdown
            return owner
        } catch {lock.unlock();withExtendedLifetime(oldContext) {};withExtendedLifetime(oldRuntime) {};throw error}
    }
    fileprivate func succeed(_ owner: AsterEngine) {
        precondition(Thread.isMainThread)
        guard let record = record else {preconditionFailure("Committed source reservation missing")}
        // Target delivery aliases have drained. Busy/bytes remain held through
        // retired-source creator acknowledgment, then release before observers.
        AsterWorkspaceRegistry.remove(record) { [self] in
            self.record = nil;descriptor = nil;finish(.success(metrics),notify:owner)
        }
    }
    fileprivate func fail(_ error: Error) {
        precondition(Thread.isMainThread)
        lock.lock();let done = terminal || committed || finishing;if !done {finishing = true};lock.unlock();if done {return}
        if let record = record {
            do {
                try record.abort()
                AsterWorkspaceRegistry.remove(record) { [self] in
                    self.record = nil;descriptor = nil;targetRuntime = nil
                    finish(.failure(error),notify:nil)
                }
                return
            } catch {
                record.pending = true;record.failures = min(32,record.failures + 1)
                engine?.pendingWorkspaceRegistration = registration
                self.record = nil;descriptor = nil;targetRuntime = nil
                finish(.failure(AsterWorkspaceError.cleanupPending(registration:registration)),notify:nil)
                return
            }
        }
        descriptor = nil;targetRuntime = nil;finish(.failure(error),notify:nil)
    }
    private func finish(_ result: Result<AsterWorkspaceMetrics,Error>, notify owner: AsterEngine?) {
        precondition(Thread.isMainThread)
        lock.lock();if terminal {lock.unlock();return};terminal = true;metrics.progressCallbackErrors = callbackErrors;latestProgress = nil;lock.unlock()
        if let engine = engine, engine.activeWorkspace === self {engine.activeWorkspace = nil}
        document = nil;binding = nil;descriptor = nil
        let callback = completion;completion = nil;progress = nil;metrics.totalMs = (asterClock()-started)*1000
        owner?.notifyChanges()
        switch result {case .success:callback?(.success(metrics));case .failure(let error):callback?(.failure(error))}
    }
}
private final class AsterWorkspaceCaptureBox<T> {
    private let condition = NSCondition()
    private var result: Result<T,Error>?
    func resolve(_ value: Result<T,Error>) {condition.lock();result = value;condition.signal();condition.unlock()}
    func wait(_ job: AsterWorkspaceJob) throws -> T {
        condition.lock();defer {condition.unlock()}
        while result == nil {_ = condition.wait(until:Date(timeIntervalSinceNow:0.02));try job.check()}
        return try result!.get()
    }
}
// Ownership box is populated on the worker and used only on main after enqueue.
// Its explicit nil removes the delivery alias before observers can close Engine.
private final class AsterWorkspaceDelivery {
    var context: JSContext?
    init(_ context: JSContext?) {self.context = context}
}
private final class AsterWorkspaceRuntime: AsterContextRuntime {
    private let retirement = AsterRuntimeRetirement()
    private let cleanupLock = NSLock()
    private var afterCreatorCleanup: (() -> Void)?
    private var initialJob: AsterWorkspaceJob?
    private var initialPlan: AsterWorkspaceDescriptor?
    private var ownedContext: JSContext? // accessed/cleared only on creator
    private let bundle: String, maxBars: Int
    init(bundle: String, job: AsterWorkspaceJob, plan: AsterWorkspaceDescriptor, maxBars: Int) {
        self.bundle = bundle;initialJob = job;initialPlan = plan;self.maxBars = maxBars
    }
    func retire() {retirement.retire()}
    private func failAfterCreatorCleanup(_ job: AsterWorkspaceJob, _ error: Error) {
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
            let delivery = AsterWorkspaceDelivery(ownedContext)
            DispatchQueue.main.async { [self] in
                do {
                    let owner = try autoreleasepool { () throws -> AsterEngine in
                        guard let context = delivery.context else {throw AsterError.unavailableContext}
                        return try job.install(context,runtime:self,copied:copied)
                    }
                    delivery.context = nil;job.succeed(owner)
                } catch {delivery.context = nil;failAfterCreatorCleanup(job,error)}
            }
        case .failure(let error):failAfterCreatorCleanup(job,error)
        }
        outcome = nil
    }
    private func compute(_ job: AsterWorkspaceJob, _ plan: AsterWorkspaceDescriptor) throws -> Int {
        try job.check()
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine:vm) else {throw AsterError.unavailableContext}
        ownedContext = context;context.evaluateScript(bundle)
        if let exception = context.exception {context.exception = nil;throw AsterError.javaScript(exception.toString() ?? "Workspace bundle")}
        try job.check();try asterWorkspaceTrue(asterInvoke(context,"nativeWorkspaceTargetCreate",[plan.metadata]))
        var copied = 0
        for slot in 0..<6 {
            var offset = 0
            while offset < plan.length {
                try job.check();let count = min(262144,plan.length-offset)
                let data = try job.capture(slot:slot,offset:offset,count:count);try job.check()
                try autoreleasepool {
                    let target = try asterInvoke(context,"nativeAsyncTargetBuffer",[slot,offset,count])
                    let pointer = try asterTypedBytes(target,context,count:count)
                    data.withUnsafeBytes {bytes in _ = memcpy(pointer,bytes.baseAddress!,data.count)}
                }
                copied += data.count;offset += count;job.report(AsterAsyncProgress(phase:"capture",done:copied,total:plan.length*48))
            }
        }
        try job.check();try asterWorkspaceTrue(asterInvoke(context,"nativeAsyncStart"))
        while true {
            try job.check()
            let state = try autoreleasepool {try asterDictionary(asterInvoke(context,"nativeAsyncStep",[maxBars]))}
            guard let phase = state["phase"] as? String, ["validate","store-index","calculate","indices","workspace-checkpoints","workspace-ready"].contains(phase) else {throw AsterAsyncError.invalidProtocol("Workspace target phase")}
            let done = try asterInteger(state["done"],9007199254740991), total = try asterInteger(state["total"],9007199254740991)
            let complete = try asterWorkspaceBool(state["complete"])
            guard complete == (phase == "workspace-ready"), done <= total else {throw AsterAsyncError.invalidProtocol("Workspace target progress")}
            job.report(AsterAsyncProgress(phase:phase,done:done,total:total));if complete {break}
        }
        try job.check()
        let receipt = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeWorkspaceTargetFinish"))}
        guard receipt["schema"] as? String == "aster.native-workspace-target-ready",try asterInteger(receipt["version"],1) == 1,
              receipt["status"] as? String == "target-ready",try asterWorkspaceBool(receipt["hostPublished"]) == false,
              let targetPlan = receipt["plan"] as? [String:Any],try asterInteger(targetPlan["totalBytes"],asterWorkspaceMaxBytes) == plan.bytes else {throw AsterAsyncError.invalidProtocol("Workspace target finish binding")}
        try job.check();return copied
    }
}

/// Native JavaScriptCore host; no browser, WKWebView or DOM is involved.
/// Call from one owning thread (normally the UI thread).
/// Publication and cleanup are independent. Unknown is never permission to retry
/// the mutation. Use retryParamsCleanup with the original registration instead.
public enum AsterParamsCommitOutcome: String {case notCommitted, committed, unchanged, unknown}
public enum AsterParamsError: Error {case cleanupPending(registration: Int, outcome: AsterParamsCommitOutcome)}
public struct AsterParamsStatus {
    public let registration, admittedLogicalBytes, retryFailures: Int
    public let outcome: AsterParamsCommitOutcome
    public let cleanupPending, awaitingCreatorCleanup: Bool
}
public struct AsterParamsMetrics {
    public internal(set) var copiedBytes = 0, logicalAdmissionBytes = 0, progressCallbackErrors = 0
    public internal(set) var totalMs = 0.0
    public internal(set) var outcome: AsterParamsCommitOutcome = .notCommitted
}
// Main-only minimal recovery owner. Client callbacks and Error are never stored.
private final class AsterParamsSourceRecord {
    let registration: Int, id: String, admission: AsterNativeAdmissionLease
    var context: JSContext?
    private var runtime: AsterContextRuntime?
    weak var sourceIdentity: JSContext?
    weak var engine: AsterEngine?
    weak var job: AsterParamsJob?
    var began = false, released = false, pending = false, retrying = false, detaching = false, notified = false
    var failures = 0
    var outcome: AsterParamsCommitOutcome = .notCommitted
    init(registration: Int, id: String, engine: AsterEngine, context: JSContext, runtime: AsterContextRuntime?, admission: AsterNativeAdmissionLease) throws {
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw AsterAsyncError.invalidProtocol("Source runtime is retiring")}
        self.registration = registration;self.id = id;self.engine = engine;self.context = context;sourceIdentity = context
        self.runtime = runtime;self.admission = admission
    }
    func statusValue() -> AsterParamsStatus {
        precondition(Thread.isMainThread)
        return AsterParamsStatus(registration:registration,admittedLogicalBytes:admission.bytes,retryFailures:failures,outcome:outcome,cleanupPending:pending || detaching,awaitingCreatorCleanup:detaching)
    }
    // Null, malformed, mismatched and evicted receipts remain uncertain.
    @discardableResult func accept(_ value: JSValue) throws -> String {
        precondition(Thread.isMainThread)
        let object = try asterWorkspaceObject(value)
        guard try asterInteger(object["registration"],9007199254740991) == registration,
              let status = object["status"] as? String,
              ["active","committed","unchanged","failed","aborted"].contains(status) else {throw AsterAsyncError.invalidProtocol("Params status binding")}
        if status == "committed" || status == "unchanged" {
            guard let receipt = object["receipt"] as? [String:Any], receipt["schema"] as? String == "aster.native-params-published",
                  try asterInteger(receipt["version"],1) == 1,
                  try asterInteger(receipt["registration"],9007199254740991) == registration,
                  receipt["id"] as? String == id, receipt["status"] as? String == status,
                  let outputs = receipt["outputs"] as? [String], !outputs.isEmpty, outputs.count <= 32,
                  Set(outputs).count == outputs.count, outputs.allSatisfy({!$0.isEmpty && $0.utf16.count <= 128}),
                  let offsets = receipt["plotOffsets"] as? [String:Any], offsets.count <= outputs.count else {throw AsterAsyncError.invalidProtocol("Params published receipt")}
            for (key,value) in offsets {
                guard outputs.contains(key), let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite, abs(number.doubleValue) <= 10000,
                      number.doubleValue.rounded(.towardZero) == number.doubleValue else {throw AsterAsyncError.invalidProtocol("Params offset receipt")}
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
            guard let context = context else {throw AsterAsyncError.invalidProtocol("Missing params source")}
            let status = try accept(asterInvoke(context,"nativeParamsSourceStatus",[registration]))
            if status == "active" {
                _ = try accept(asterInvoke(context,"nativeParamsSourceAbort",[registration]))
            }
            guard released else {throw AsterAsyncError.invalidProtocol("Params release not confirmed")}
        }
    }
    func detach(_ completion: @escaping () -> Void) {
        precondition(Thread.isMainThread && released && !detaching)
        detaching = true;context = nil
        let owner = runtime;runtime = nil
        if let owner = owner {owner.releaseCaptureLease(afterRetirementIfNeeded:completion)} else {completion()}
    }
}
private enum AsterParamsRegistry {
    private static var records: [Int:AsterParamsSourceRecord] = [:]
    private static var next = 0
    static func reserve(_ engine: AsterEngine, _ id: String, _ context: JSContext, _ runtime: AsterContextRuntime?) throws -> AsterParamsSourceRecord {
        precondition(Thread.isMainThread)
        guard next < 9007199254740991 else {throw AsterAsyncError.busy}
        let admission = try AsterNativeAdmission.reserve();next += 1
        do {
            let record = try AsterParamsSourceRecord(registration:next,id:id,engine:engine,context:context,runtime:runtime,admission:admission)
            records[record.registration] = record;return record
        } catch {AsterNativeAdmission.release(admission);throw error}
    }
    static func contains(_ registration: Int) -> Bool {precondition(Thread.isMainThread);return records[registration] != nil}
    static func status(_ registration: Int? = nil) -> [AsterParamsStatus] {
        precondition(Thread.isMainThread)
        return records.values.filter{registration == nil || $0.registration == registration}.sorted{$0.registration < $1.registration}.map{$0.statusValue()}
    }
    static func remove(_ record: AsterParamsSourceRecord, completion: @escaping () -> Void = {}) {
        precondition(Thread.isMainThread && record.released)
        guard records[record.registration] === record, !record.detaching else {return}
        record.detach {
            precondition(Thread.isMainThread)
            guard records[record.registration] === record else {return}
            records.removeValue(forKey:record.registration);AsterNativeAdmission.release(record.admission)
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
    static func retry(_ registration: Int? = nil) -> [AsterParamsStatus] {
        precondition(Thread.isMainThread)
        var results: [AsterParamsStatus] = []
        for record in Array(records.values).sorted(by:{$0.registration < $1.registration}) where record.pending && !record.retrying && !record.detaching && (registration == nil || registration == record.registration) {
            record.retrying = true
            do {try record.recover();record.retrying = false;remove(record)}
            catch {record.retrying = false;record.failures = min(32,record.failures + 1)}
            results.append(record.statusValue())
        }
        return results
    }
}
private struct AsterParamsPlan {
    let ticket, length, capacity, bytes: Int
    let metadata: String
    init(_ object: [String:Any], ticket: Int, registration: Int, id: String) throws {
        guard object["phase"] as? String == "copy", let text = object["metadataJSON"] as? String, text.utf16.count <= 131072,
              let plan = object["plan"] as? [String:Any] else {throw AsterAsyncError.invalidProtocol("Params admission descriptor")}
        let binding = try asterDictionary(text,maximumBytes:524288)
        guard binding["schema"] as? String == "aster.native-params-target", try asterInteger(binding["version"],1) == 1,
              try asterInteger(binding["registration"],9007199254740991) == registration, binding["id"] as? String == id else {throw AsterAsyncError.invalidProtocol("Params metadata binding")}
        length = try asterInteger(binding["length"],4194304);capacity = try asterInteger(binding["capacity"],4194304)
        guard capacity >= max(16,length), capacity & (capacity - 1) == 0 else {throw AsterAsyncError.invalidProtocol("Params capacity")}
        bytes = try asterInteger(plan["totalBytes"],asterWorkspaceMaxBytes)
        guard bytes > 0 else {throw AsterAsyncError.invalidProtocol("Params admission bytes")}
        self.ticket = ticket;metadata = text
    }
}
private final class AsterParamsBox<T> {
    private let condition = NSCondition()
    private var result: Result<T,Error>?
    func resolve(_ result: Result<T,Error>) {condition.lock();if self.result == nil {self.result = result;condition.broadcast()};condition.unlock()}
    func wait(_ job: AsterParamsJob) throws -> T {
        condition.lock();defer {condition.unlock()}
        while result == nil {condition.unlock();do {try job.check()} catch {condition.lock();throw error};condition.lock();if result == nil {_ = condition.wait(until:Date(timeIntervalSinceNow:0.02))}}
        return try result!.get()
    }
}
/// Cancellation is thread-safe. Status and explicit recovery are main-owned.
/// cleanupPending is a single completion, not a retryable mutation failure.
public final class AsterParamsJob {
    private let lock = NSLock()
    private var cancelled = false, terminal = false, publishing = false, finishing = false
    private var progressPending = false, latestProgress: AsterAsyncProgress?, callbackErrors = 0
    private var outcome: AsterParamsCommitOutcome = .notCommitted
    fileprivate weak var engine: AsterEngine?
    private var record: AsterParamsSourceRecord?
    private var params: [String:Any]?
    private var plan: AsterParamsPlan?
    private var progress: ((AsterAsyncProgress) throws -> Void)?
    private var completion: ((Result<AsterParamsMetrics,Error>) -> Void)?
    private let sourceRevision: UInt64, timeout: Double, maxBars: Int
    private let started = asterClock()
    private var metrics = AsterParamsMetrics()
    public let registration: Int
    fileprivate init(engine: AsterEngine, record: AsterParamsSourceRecord, params: [String:Any], timeout: Double, maxBars: Int,
                     progress: ((AsterAsyncProgress) throws -> Void)?, completion: @escaping (Result<AsterParamsMetrics,Error>) -> Void) {
        self.engine = engine;self.record = record;self.params = params;self.timeout = timeout;self.maxBars = maxBars
        self.progress = progress;self.completion = completion;sourceRevision = engine.revision;registration = record.registration;record.job = self
    }
    public func cancel() {lock.lock();if !terminal && !publishing {cancelled = true};lock.unlock()}
    public var commitOutcome: AsterParamsCommitOutcome {lock.lock();defer {lock.unlock()};return outcome}
    public var cleanupPending: Bool {precondition(Thread.isMainThread);return AsterParamsRegistry.status(registration).contains{$0.cleanupPending}}
    @discardableResult public func retryCleanup() throws -> [AsterParamsStatus] {
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        return AsterParamsRegistry.retry(registration)
    }
    fileprivate func setOutcome(_ value: AsterParamsCommitOutcome) {lock.lock();outcome = value;lock.unlock()}
    fileprivate func check() throws {
        lock.lock();let stopped = cancelled, done = terminal || finishing;lock.unlock()
        if stopped {throw AsterAsyncError.cancelled}
        if done {throw AsterAsyncError.invalidProtocol("Params job completed")}
        if asterClock() - started >= timeout {throw AsterAsyncError.timedOut}
    }
    private func finalOwner() throws -> AsterEngine {
        precondition(Thread.isMainThread)
        guard let engine = engine else {throw AsterAsyncError.sourceDeallocated}
        guard !engine.closed, !engine.closing else {throw AsterAsyncError.engineClosed}
        guard engine.activeParams === self, engine.revision == sourceRevision,
              let source = record?.context, engine.contextBacking === source else {throw AsterAsyncError.invalidProtocol("Params source stale")}
        return engine
    }
    private func sourceCall<T>(_ operation: (JSContext) throws -> T) throws -> T {
        precondition(Thread.isMainThread)
        try check();_ = try finalOwner()
        let result: T = try autoreleasepool {
            guard let source = record?.context else {throw AsterAsyncError.invalidProtocol("Missing params source")}
            if let ticket = plan?.ticket {try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceCheck",[ticket,sourceRevision]))}
            return try operation(source)
        }
        try check();_ = try finalOwner();return result
    }
    private func onOwner<T>(_ operation: @escaping (JSContext) throws -> T) throws -> T {
        let box = AsterParamsBox<T>()
        DispatchQueue.main.async { [self] in
            do {box.resolve(.success(try sourceCall(operation)))} catch {box.resolve(.failure(error))}
        }
        return try box.wait(self)
    }
    fileprivate func start(bundle: String) {
        precondition(Thread.isMainThread)
        do {
            try check();_ = try finalOwner()
            guard let record = record, let params = params else {throw AsterAsyncError.invalidProtocol("Missing params request")}
            record.began = true
            let begin = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeParamsSourceBegin",[record.id,params,sourceRevision,asterWorkspaceMaxBytes,registration]))}
            guard try asterInteger(begin["registration"],9007199254740991) == registration else {throw AsterAsyncError.invalidProtocol("Params registration")}
            let ticket = try asterInteger(begin["ticket"],9007199254740991)
            guard ticket > 0 else {throw AsterAsyncError.invalidProtocol("Params ticket")}
            self.params = nil;admit(ticket:ticket,bundle:bundle)
        } catch {settle(error)}
    }
    private func admit(ticket: Int, bundle: String) {
        precondition(Thread.isMainThread)
        do {
            let value = try sourceCall {try asterWorkspaceObject(asterInvoke($0,"nativeParamsSourceStep",[ticket,8,sourceRevision]))}
            guard let record = record else {throw AsterAsyncError.invalidProtocol("Missing params reservation")}
            let complete = try asterWorkspaceBool(value["complete"])
            if !complete {
                guard value["phase"] as? String == "admission" else {throw AsterAsyncError.invalidProtocol("Params admission phase")}
                DispatchQueue.main.async { [self] in admit(ticket:ticket,bundle:bundle) };return
            }
            if value["phase"] as? String == "noop" {publish(ticket:ticket);return}
            let plan = try AsterParamsPlan(value,ticket:ticket,registration:registration,id:record.id)
            try AsterNativeAdmission.admit(record.admission,plan.bytes);self.plan = plan;metrics.logicalAdmissionBytes = plan.bytes
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
    private func report(_ value: AsterAsyncProgress) {
        lock.lock();if terminal || publishing || finishing {lock.unlock();return};latestProgress = value
        if progressPending {lock.unlock();return};progressPending = true;lock.unlock()
        DispatchQueue.main.async { [self] in
            lock.lock();let value = latestProgress, done = terminal || publishing || finishing;progressPending = false;lock.unlock()
            guard !done, let value = value, let progress = progress else {return}
            do {try progress(value)} catch {lock.lock();callbackErrors = min(32,callbackErrors + 1);lock.unlock()}
        }
    }
    private func compute(bundle: String, plan: AsterParamsPlan) throws -> Int {
        try check()
        guard let context = JSContext(virtualMachine:JSVirtualMachine()) else {throw AsterError.unavailableContext}
        context.evaluateScript(bundle)
        if let error = context.exception {context.exception = nil;throw AsterError.javaScript(error.toString() ?? "Worker initialization")}
        try check();try asterWorkspaceTrue(asterInvoke(context,"nativeParamsTargetCreate",[plan.metadata]))
        var copied = 0
        for slot in 0..<6 {
            var offset = 0
            while offset < plan.length {
                try check();let count = min(16384,plan.length-offset), at = offset
                let data: Data = try onOwner { source in
                    let value = try asterInvoke(source,"nativeAsyncBuffer",[plan.ticket,slot,at,count])
                    return Data(bytes:try asterTypedBytes(value,source,count:count),count:count*8)
                }
                try check()
                try autoreleasepool {
                    let value = try asterInvoke(context,"nativeAsyncTargetBuffer",[slot,offset,count])
                    let pointer = try asterTypedBytes(value,context,count:count)
                    data.withUnsafeBytes { bytes in pointer.copyMemory(from:bytes.baseAddress!,byteCount:data.count) }
                }
                copied += data.count;offset += count
            }
        }
        try asterWorkspaceTrue(asterInvoke(context,"nativeParamsTargetStart"))
        while true {
            try check()
            let step = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeParamsTargetStep",[maxBars]))}
            let complete = try asterWorkspaceBool(step["complete"])
            guard let phase = step["phase"] as? String, ["validate","calculate","outputs","ready"].contains(phase), complete == (phase == "ready") else {throw AsterAsyncError.invalidProtocol("Params target phase")}
            let done = try asterInteger(step["done"],134217728), total = try asterInteger(step["total"],134217728)
            guard done <= total else {throw AsterAsyncError.invalidProtocol("Params target progress")}
            if complete {break}
            report(AsterAsyncProgress(phase:phase,done:done,total:total))
        }
        let text: String = try autoreleasepool {
            let value = try asterInvoke(context,"nativeParamsTargetDescriptor")
            guard value.isString, let text = value.toString(), text.utf16.count <= 131072 else {throw AsterAsyncError.invalidProtocol("Params result descriptor")}
            return text
        }
        let descriptor = try asterDictionary(text,maximumBytes:524288)
        guard descriptor["schema"] as? String == "aster.native-params-result", try asterInteger(descriptor["version"],1) == 1,
              try asterInteger(descriptor["registration"],9007199254740991) == registration,
              try asterInteger(descriptor["length"],4194304) == plan.length, try asterInteger(descriptor["capacity"],4194304) == plan.capacity,
              let outputs = descriptor["outputs"] as? [String], !outputs.isEmpty, outputs.count <= 32,
              plan.capacity * outputs.count * 8 <= 256*1024*1024 else {throw AsterAsyncError.invalidProtocol("Params result bounds")}
        let checkpointCount = try asterInteger(descriptor["checkpointCount"],16385)
        guard checkpointCount == (plan.length == 0 ? 0 : plan.length/256+1), try asterInteger(descriptor["checkpointBytes"],32*1024*1024) >= 0 else {throw AsterAsyncError.invalidProtocol("Params checkpoint count")}
        let _: Bool = try onOwner { source in try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceReceive",[plan.ticket,text,self.sourceRevision]));return true }
        for slot in outputs.indices {
            var offset = 0
            while offset < plan.capacity {
                try check();let count = min(16384,plan.capacity-offset), at = offset
                let data: Data = try autoreleasepool {
                    let value = try asterInvoke(context,"nativeAsyncBuffer",[registration,slot,at,count])
                    return Data(bytes:try asterTypedBytes(value,context,count:count),count:count*8)
                }
                let _: Bool = try onOwner { source in
                    try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceArmWrite",[plan.ticket,slot,at,count,self.sourceRevision]))
                    // Arm and binary write execute in one owner turn; no queued write.
                    let value = try asterInvoke(source,"nativeAsyncTargetBuffer",[slot,at,count])
                    let pointer = try asterTypedBytes(value,source,count:count)
                    data.withUnsafeBytes { bytes in pointer.copyMemory(from:bytes.baseAddress!,byteCount:data.count) };return true
                }
                copied += data.count;offset += count
            }
        }
        for ordinal in 0..<checkpointCount {
            try check()
            let row = try autoreleasepool {try asterWorkspaceObject(asterInvoke(context,"nativeParamsTargetCheckpoint",[ordinal]))}
            guard try asterInteger(row["index"],4194304) == ordinal*256, let text = row["text"] as? String, text.utf16.count <= 131072 else {throw AsterAsyncError.invalidProtocol("Params checkpoint record")}
            let _: Bool = try onOwner { source in try asterWorkspaceTrue(asterInvoke(source,"nativeParamsSourceCheckpoint",[plan.ticket,ordinal*256,text,self.sourceRevision]));return true }
        }
        while true {
            try check()
            let complete: Bool = try onOwner { source in
                let value = try asterWorkspaceObject(asterInvoke(source,"nativeParamsSourceValidate",[plan.ticket,16384,self.sourceRevision]))
                let complete = try asterWorkspaceBool(value["complete"])
                guard let phase = value["phase"] as? String, ["validate","ready"].contains(phase), complete == (phase == "ready") else {throw AsterAsyncError.invalidProtocol("Params validation phase")}
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
            guard let record = record else {throw AsterAsyncError.invalidProtocol("Missing params source")}
            // Linearize cancellation before publication without holding a lock
            // across JS. Later cancellation cannot reverse a confirmed commit.
            lock.lock();let stopped = cancelled;if !stopped {publishing = true};lock.unlock()
            if stopped {throw AsterAsyncError.cancelled}
            record.outcome = .unknown;setOutcome(.unknown)
            do {
                _ = try autoreleasepool {
                    guard let source = record.context else {throw AsterAsyncError.invalidProtocol("Missing params source")}
                    return try record.accept(asterInvoke(source,"nativeParamsSourcePublish",[ticket,sourceRevision]))
                }
            }
            catch {try record.recover()}
            guard record.released else {throw AsterAsyncError.invalidProtocol("Params publication unresolved")}
            settle(nil)
        } catch {settle(error)}
    }
    // Called only before a worker starts or after its autoreleasepool exit ack.
    private func settle(_ error: Error?) {
        precondition(Thread.isMainThread)
        lock.lock();let done = terminal || finishing;if !done {finishing = true};lock.unlock();if done {return}
        guard let record = record else {finish(.failure(error ?? AsterAsyncError.invalidProtocol("Missing params source")));return}
        do {
            try record.recover()
            AsterParamsRegistry.remove(record) { [self] in
                self.record = nil;plan = nil
                if record.outcome == .committed || record.outcome == .unchanged {metrics.outcome = record.outcome;finish(.success(metrics))}
                else {finish(.failure(error ?? AsterAsyncError.invalidProtocol("Params not committed")))}
            }
        } catch {
            record.pending = true;record.failures = min(32,record.failures + 1)
            engine?.pendingParamsRegistration = registration
            self.record = nil;plan = nil
            finish(.failure(AsterParamsError.cleanupPending(registration:registration,outcome:record.outcome)))
        }
    }
    private func finish(_ result: Result<AsterParamsMetrics,Error>) {
        precondition(Thread.isMainThread)
        lock.lock();if terminal {lock.unlock();return};terminal = true;latestProgress = nil;metrics.progressCallbackErrors = callbackErrors;lock.unlock()
        if let engine = engine, engine.activeParams === self {engine.activeParams = nil}
        params = nil;plan = nil;record = nil
        let callback = completion;completion = nil;progress = nil;metrics.totalMs = (asterClock()-started)*1000
        switch result {case .success:callback?(.success(metrics));case .failure(let error):callback?(.failure(error))}
    }
}

public final class AsterEngine {
    /// Opt-in async success replaces this context. Re-read it after completion;
    /// cached raw JSContext/JSValue objects from the retired VM are unsupported.
    public fileprivate(set) var context: JSContext {
        get {guard let context = contextBacking else {preconditionFailure("Raw context after workspace Engine.close is unsupported")};return context}
        set {contextBacking = newValue;workspaceContextInstalled = false}
    }
    fileprivate var contextBacking: JSContext?
    fileprivate var workspaceContextInstalled = false
    fileprivate var contextRuntime: AsterContextRuntime?
    fileprivate var activeWorkspace: AsterWorkspaceJob?
    fileprivate var activeParams: AsterParamsJob?
    fileprivate var pendingParamsRegistration: Int?
    fileprivate var pendingWorkspaceRegistration: Int?
    fileprivate var closing = false
    fileprivate var activeAsync: AsterAsyncJob?
    fileprivate var closed = false
    private let bundleSource: String
    private let owner = Thread.current
    private var observers: [UUID: () throws -> Void] = [:]
    private var pendingNotifications=0,notifying=false
    private var frameCleanup:[UUID:()->Void]=[:]
    func checkFrameOwner()throws{guard Thread.current===owner else{throw AsterError.wrongThread};guard !closed else{throw AsterAsyncError.engineClosed}}
    func registerFrameCleanup(_ cleanup:@escaping()->Void)throws->UUID{try checkFrameOwner();let token=UUID();frameCleanup[token]=cleanup;return token}
    func removeFrameCleanup(_ token:UUID){frameCleanup.removeValue(forKey:token)}
    public private(set) var observerErrors: [Error] = []
    public var onObserverError: ((Error) -> Void)?
    public private(set) var revision: UInt64 = 0
    #if SWIFT_PACKAGE
    public convenience init(count: Int = 0, options: [String: Any]? = nil) throws {
        guard let url = Bundle.module.url(forResource: "aster-core", withExtension: "js") else {throw AsterError.invalidScene}
        try self.init(bundleURL: url, count: count, options: options)
    }
    #endif
    public init(bundleURL: URL, count: Int = 0, options: [String: Any]? = nil) throws {
        guard let context = JSContext() else { throw AsterError.unavailableContext }
        self.contextBacking = context
        self.bundleSource = try String(contentsOf: bundleURL, encoding: .utf8)
        context.evaluateScript(bundleSource)
        try checkException()
        _ = try call("nativeInit", [count, options as Any? ?? NSNull()])
    }
    private func checkException() throws {
        if let exception = context.exception { context.exception = nil; throw AsterError.javaScript(exception.toString() ?? "Unknown JS error") }
    }
    @discardableResult public func call(_ name: String, _ arguments: [Any] = []) throws -> JSValue {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard !closed else {throw AsterAsyncError.engineClosed}
        guard let function = context.objectForKeyedSubscript(name), !function.isUndefined,
              let value = function.call(withArguments: arguments) else { throw AsterError.javaScript("Missing function: \(name)") }
        try checkException(); return value
    }
    private func workspaceAvailability() throws {
        guard !closing else {throw AsterAsyncError.engineClosed}
        if let pending = pendingWorkspaceRegistration {
            guard !AsterWorkspaceRegistry.contains(pending) else {throw AsterAsyncError.busy}
            pendingWorkspaceRegistration = nil
        }
        if let pending = pendingParamsRegistration {
            guard !AsterParamsRegistry.contains(pending) else {throw AsterAsyncError.busy}
            pendingParamsRegistration = nil
        }
        guard activeParams == nil else {throw AsterAsyncError.busy}
        guard activeWorkspace == nil else {throw AsterAsyncError.busy}
    }
    public static func workspaceCleanupStatus() throws -> [AsterWorkspaceCleanupStatus] {
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        return AsterWorkspaceRegistry.status()
    }
    /// One main-owner attempt per pending record; no completion redelivery.
    public static func retryWorkspaceCleanup() throws -> [AsterWorkspaceCleanupStatus] {
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        AsterWorkspaceRegistry.retry();return AsterWorkspaceRegistry.status()
    }
    public static func paramsCleanupStatus() throws -> [AsterParamsStatus] {
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        return AsterParamsRegistry.status()
    }
    /// Returns results from this one recovery attempt; never repeats completion.
    @discardableResult public static func retryParamsCleanup(_ registration: Int? = nil) throws -> [AsterParamsStatus] {
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        return AsterParamsRegistry.retry(registration)
    }
    /// Entry-only replacement in the original context; static linked modules only.
    @discardableResult public func setIndicatorParamsAsync(_ id: String, params: [String:Any], timeout: Double = 30,
        maxBarsPerStep: Int = 4096, progress: ((AsterAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<AsterParamsMetrics,Error>) -> Void) throws -> AsterParamsJob {
        try asyncPreflight(timeout)
        guard !id.isEmpty, id.utf16.count <= 128, maxBarsPerStep >= 1, maxBarsPerStep <= 16384, revision <= 9007199254740991 else {throw AsterAsyncError.invalidProtocol("Params request bounds")}
        let source = context, capturedRevision = revision
        guard JSONSerialization.isValidJSONObject(params) else {throw AsterAsyncError.invalidProtocol("Params request must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:params,options:[.sortedKeys])
        guard data.count <= 131072, let owned = try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AsterAsyncError.invalidProtocol("Params request size")}
        try asyncPreflight(timeout)
        guard contextBacking === source, revision == capturedRevision else {throw AsterAsyncError.invalidProtocol("Params source changed during arguments")}
        let record = try AsterParamsRegistry.reserve(self,id,source,contextRuntime)
        let job = AsterParamsJob(engine:self,record:record,params:owned,timeout:timeout,maxBars:maxBarsPerStep,progress:progress,completion:completion)
        activeParams = job;let bundle = bundleSource
        DispatchQueue.main.async {job.start(bundle:bundle)}
        return job
    }
    /// Workspace contains settings only; dataset binding is a host assertion.
    @discardableResult public func restoreWorkspaceAsync(_ document: String, datasetBinding: [String:Any], timeout: Double = 30,
        maxBarsPerStep: Int = 4096, progress: ((AsterAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<AsterWorkspaceMetrics,Error>) -> Void) throws -> AsterWorkspaceJob {
        try asyncPreflight(timeout)
        guard document.utf16.count <= 2097152, maxBarsPerStep >= 1, maxBarsPerStep <= 16384, revision <= 9007199254740991 else {throw AsterAsyncError.invalidProtocol("Workspace request bounds")}
        let source = context, capturedRevision = revision
        guard JSONSerialization.isValidJSONObject(datasetBinding) else {throw AsterAsyncError.invalidProtocol("Workspace binding must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:datasetBinding,options:[.sortedKeys])
        guard data.count <= 32768, let binding = try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AsterAsyncError.invalidProtocol("Workspace binding bounds")}
        try asyncPreflight(timeout)
        guard contextBacking === source, revision == capturedRevision else {throw AsterAsyncError.invalidProtocol("Workspace source changed during arguments")}
        let record = try AsterWorkspaceRegistry.reserve(source,contextRuntime)
        let job = AsterWorkspaceJob(engine:self,record:record,document:document,binding:binding,timeout:timeout,maxBars:maxBarsPerStep,progress:progress,completion:completion)
        activeWorkspace = job;let bundle = bundleSource
        DispatchQueue.main.async {job.start(bundle:bundle)}
        return job
    }
    /// Optional isolated-context data mutation. The engine must be created on
    /// the main/UI thread. Existing synchronous APIs and owner guard are intact.
    /// Progress/completion always run on main; callbacks can use this engine.
    @discardableResult public func applyDataEventAsync(_ event: [String: Any], timeout: Double = 30,
        progress: ((AsterAsyncProgress) throws -> Void)? = nil,
        completion: @escaping (Result<AsterAsyncMetrics, Error>) -> Void) throws -> AsterAsyncJob {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        guard !closed else {throw AsterAsyncError.engineClosed}
        try workspaceAvailability()
        guard activeAsync == nil else {throw AsterAsyncError.busy}
        guard timeout.isFinite, timeout > 0, timeout <= 3600 else {throw AsterAsyncError.invalidProtocol("Invalid timeout")}
        guard JSONSerialization.isValidJSONObject(event) else {throw AsterAsyncError.invalidProtocol("Data event must be valid JSON")}
        let data = try JSONSerialization.data(withJSONObject:event,options:[.sortedKeys])
        guard data.count <= 8388608,let eventJSON = String(data:data,encoding:.utf8) else {throw AsterAsyncError.invalidProtocol("Oversized data event")}
        return startAsync(json:eventJSON,kind:.correction,columns:nil,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:0)
    }
    /// Prepare real OHLCV input in an isolated VM. Array COW is the input
    /// ownership snapshot; safe caller mutations detach. No OHLCV JSON arrays,
    /// borrowed source JS arrays or temporary full Data snapshot are created.
    @discardableResult public func prepareColumnsAsync(_ columns:AsterColumns,visibleBars:Int=200,timeout:Double=30,
        progress:((AsterAsyncProgress)throws->Void)?=nil,completion:@escaping(Result<AsterAsyncMetrics,Error>)->Void) throws -> AsterAsyncJob {
        let started=asterClock();try asyncPreflight(timeout)
        guard visibleBars>=1,visibleBars<=4194304 else {throw AsterAsyncError.invalidProtocol("Visible bars 1...4194304")}
        let data=try JSONSerialization.data(withJSONObject:["kind":"columns","length":columns.length,"visibleBars":visibleBars],options:[.sortedKeys])
        return startAsync(json:String(data:data,encoding:.utf8)!,kind:.columns,columns:columns,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:(asterClock()-started)*1000)
    }
    /// Demo convenience: deterministic synthetic data is generated incrementally
    /// in the worker. It is separate from real immutable-owned feed input.
    @discardableResult public func prepareSeededAsync(count:Int,seed:UInt32=42,visibleBars:Int=200,timeout:Double=30,
        progress:((AsterAsyncProgress)throws->Void)?=nil,completion:@escaping(Result<AsterAsyncMetrics,Error>)->Void) throws -> AsterAsyncJob {
        try asyncPreflight(timeout)
        guard count>=0,count<=4194304,visibleBars>=1,visibleBars<=4194304 else {throw AsterAsyncError.invalidProtocol("Prepare count/visible bars")}
        let data=try JSONSerialization.data(withJSONObject:["kind":"seeded","count":count,"seed":seed,"visibleBars":visibleBars],options:[.sortedKeys])
        return startAsync(json:String(data:data,encoding:.utf8)!,kind:.seeded,columns:nil,timeout:timeout,progress:progress,completion:completion,inputOwnershipMs:0)
    }
    private func asyncPreflight(_ timeout:Double) throws {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard Thread.isMainThread else {throw AsterAsyncError.mainOwnerRequired}
        guard !closed else {throw AsterAsyncError.engineClosed}
        try workspaceAvailability()
        guard activeAsync == nil else {throw AsterAsyncError.busy}
        guard timeout.isFinite,timeout>0,timeout<=3600 else {throw AsterAsyncError.invalidProtocol("Invalid timeout")}
    }
    private func startAsync(json:String,kind:AsterAsyncKind,columns:AsterColumns?,timeout:Double,
        progress:((AsterAsyncProgress)throws->Void)?,completion:@escaping(Result<AsterAsyncMetrics,Error>)->Void,inputOwnershipMs:Double) -> AsterAsyncJob {
        let job=AsterAsyncJob(engine:self,timeout:timeout,progress:progress,completion:completion)
        let ownership=asterClock();job.kind=kind;job.hostColumns=columns
        job.metrics.retainedInputBytes=columns?.retainedBytes ?? 0;job.metrics.inputOwnershipMs=inputOwnershipMs+(columns==nil ? 0 : (asterClock()-ownership)*1000)
        activeAsync=job
        DispatchQueue.main.async { [weak self,job] in
            do {
                guard let engine=self else {throw AsterAsyncError.sourceDeallocated}
                try job.check();let source=try job.ownerSource(),beginStart=asterClock()
                let description=try asterDictionary(asterInvoke(source,kind == .correction ? "nativeAsyncBegin" : "nativePrepareBegin",[json]))
                job.ticket=try asterInteger(description["ticket"],9007199254740991)
                job.plan=try AsterAsyncPlan(description);job.metrics.beginMs=(asterClock()-beginStart)*1000
                let runtime=AsterAsyncRuntime(bundle:engine.bundleSource,job:job);job.runtime=runtime;runtime.start()
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
    public func close() throws {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        if closing {return};closing = true;defer {closing = false}
        if Thread.isMainThread, let pending = pendingWorkspaceRegistration {AsterWorkspaceRegistry.retry(pending)}
        if Thread.isMainThread, let pending = pendingParamsRegistration {_ = AsterParamsRegistry.retry(pending)}
        if closed {return}
        activeWorkspace?.cancel();activeParams?.cancel()
        let cleanups = Array(frameCleanup.values);frameCleanup.removeAll();for cleanup in cleanups {cleanup()}
        if context.objectForKeyedSubscript("nativeReleaseFrameCaches")?.isUndefined == false {_ = try call("nativeReleaseFrameCaches")}
        if context.objectForKeyedSubscript("nativeReleaseDataIngestion")?.isUndefined == false {_ = try call("nativeReleaseDataIngestion")}
        closed = true;activeAsync?.stop(AsterAsyncError.engineClosed)
        if workspaceContextInstalled {contextBacking = nil}
        activeAsync?.runtime?.retire();contextRuntime?.retire();contextRuntime = nil
        observers.removeAll();onObserverError = nil;observerErrors.removeAll();pendingNotifications = 0
    }
    deinit {
        activeWorkspace?.cancel();activeParams?.cancel();activeAsync?.stop(AsterAsyncError.sourceDeallocated)
        if workspaceContextInstalled {contextBacking = nil}
        contextRuntime?.retire()
    }
    public func setData(_ bars: [AsterBar]) throws {
        let data = try JSONEncoder().encode(bars)
        let object = try JSONSerialization.jsonObject(with: data)
        try command("setData", [object])
    }
    /// JSON-compatible common commands. Mutation notifications invalidate
    /// attached native views; scene/inspect/value reads do not schedule frames.
    @discardableResult public func command(_ operation: String, _ arguments: [Any] = []) throws -> JSValue {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard !closed else {throw AsterAsyncError.engineClosed}
        // The async handle is published before its deferred JavaScript begin.
        // Guard this owner-only gap too; the core lease covers direct JS calls
        // after begin. Existing data mutations keep their stale-result policy.
        if (activeAsync.map{!$0.isCommitted} ?? false) || activeWorkspace != nil || pendingWorkspaceRegistration.map({AsterWorkspaceRegistry.contains($0)}) == true || activeParams != nil || pendingParamsRegistration.map({AsterParamsRegistry.contains($0)}) == true {
            if ["compactData", "configureDataIngestion", "enqueueDataEvents", "drainDataEvents", "pauseDataIngestion", "resumeDataIngestion", "cancelDataEvents", "loadDataIngestion"].contains(operation) {throw AsterIngestionError(code:"BUSY",message:"Native asynchronous job is active")}
        }
        let result:JSValue
        if ["configureDataIngestion", "enqueueDataEvents", "drainDataEvents", "pauseDataIngestion", "resumeDataIngestion", "cancelDataEvents", "dataIngestionStats", "saveDataIngestion", "loadDataIngestion"].contains(operation) {
            let envelope=try call("nativeDataIngestionCommand",[operation,arguments])
            if let error=envelope.forProperty("error"),!error.isUndefined,!error.isNull {
                guard error.forProperty("name")?.toString()=="IngestionError",let code=error.forProperty("code"),code.isString,let codeText=code.toString(),!codeText.isEmpty,codeText.utf16.count<=64,let message=error.forProperty("message"),message.isString,let messageText=message.toString(),messageText.utf16.count<=256 else{throw AsterError.invalidScene}
                throw AsterIngestionError(code:codeText,message:messageText)
            }
            guard let value=envelope.forProperty("result"),!value.isUndefined else{throw AsterError.invalidScene};result=value
        } else {result=try call("nativeCommand",[operation,arguments])}
        if operation == "compactData" {
            guard result.isObject,let removed=result.forProperty("removed"),removed.isNumber else {throw AsterError.invalidScene}
            let count=removed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=4194304 else {throw AsterError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "setPanelOrder" {
            guard result.isBoolean else {throw AsterError.invalidScene}
            if result.toBool() {notifyChanges()}
        } else if operation == "setIndicatorPlacement" {
            guard result.isObject, let changed=result.forProperty("changed"), changed.isNumber else {throw AsterError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=256 else {throw AsterError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "translateDrawings" {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw AsterError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=128 else {throw AsterError.invalidScene}
            if count>0 {notifyChanges()}
        } else if operation == "setDrawingsStyle" {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw AsterError.invalidScene}
            let count=changed.toDouble()
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=128 else {throw AsterError.invalidScene}
            if count>0 {notifyChanges()}
        } else if ["setDrawingVisibility", "setDrawingsVisibility"].contains(operation) {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw AsterError.invalidScene}
            let count=changed.toDouble(),maximum=operation == "setDrawingVisibility" ? 1.0 : 128.0
            guard count.isFinite,count.rounded(.towardZero)==count,count>=0,count<=maximum else {throw AsterError.invalidScene}
            if count>0 {notifyChanges()}
        } else if ["duplicateDrawing", "duplicateDrawings"].contains(operation) {
            guard result.isObject,let changed=result.forProperty("changed"),changed.isNumber else {throw AsterError.invalidScene}
            let count=changed.toDouble(),maximum=operation == "duplicateDrawing" ? 1.0 : 128.0
            guard count.isFinite,count.rounded(.towardZero)==count,count>=1,count<=maximum,
                  let created=result.forProperty("created"),created.isArray,let rows=created.toArray() as? [[String: Any]],rows.count==Int(count),
                  let failed=result.forProperty("invalidationFailed"),failed.isBoolean else {throw AsterError.invalidScene}
            var sources=Set<String>(),ids=Set<String>()
            for row in rows {
                guard row.count==2,let source=row["sourceId"] as? String,let id=row["id"] as? String,
                      !source.isEmpty,source.utf16.count<=128,!id.isEmpty,id.utf16.count<=128,source != id,
                      sources.insert(source).inserted,ids.insert(id).inserted else {throw AsterError.invalidScene}
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
    @discardableResult public func observeChanges(_ notify: @escaping () throws -> Void) throws -> UUID {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard !closed else {throw AsterAsyncError.engineClosed}
        let token = UUID(); observers[token] = notify; return token
    }
    public func removeObserver(_ token: UUID) throws {
        guard Thread.current === owner else {throw AsterError.wrongThread}; observers.removeValue(forKey: token)
    }
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
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard !closed, !closing, let identity = contextBacking.map(ObjectIdentifier.init) else {throw AsterAsyncError.engineClosed}
        let beforeRevision = revision
        let outcome: ([String: Any], Bool)
        do {
            outcome = try unchangedDataBatch(events)
            guard !closed, !closing, contextBacking.map(ObjectIdentifier.init) == identity else {throw AsterError.invalidScene}
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
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw AsterAsyncError.engineClosed}
        defer {runtime?.releaseCaptureLease()}
        return try autoreleasepool { () throws -> ([String: Any], Bool) in
            guard let source = contextBacking else {throw AsterAsyncError.engineClosed}
            guard let function = source.objectForKeyedSubscript("nativeApplyUnchangedDataEvents"), !function.isUndefined,
                  let value = function.call(withArguments: [events]) else {throw AsterError.invalidScene}
            if let exception = source.exception {source.exception = nil;throw AsterError.javaScript(exception.toString() ?? "Data batch error")}
            let object = value.toDictionary()
            if let exception = source.exception {source.exception = nil;throw AsterError.javaScript(exception.toString() ?? "Data batch conversion error")}
            guard !closed, !closing, contextBacking === source,
                  let envelope = object as? [String: Any], let receipt = envelope["receipt"] as? [String: Any],
                  envelope["schema"] as? String == "aster.native-data-batch" else {throw AsterError.invalidScene}
            func integer(_ value: Any?,_ max: Double) throws -> Double {
                guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else {throw AsterError.invalidScene}
                let d = n.doubleValue;guard d.isFinite,d.rounded(.towardZero)==d,d>=0,d<=max else {throw AsterError.invalidScene};return d
            }
            func boolean(_ value: Any?) throws -> Bool {
                guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {throw AsterError.invalidScene};return n.boolValue
            }
            let format = try integer(envelope["version"],1),before = try integer(envelope["beforeVersion"],9007199254740991),after = try integer(envelope["afterVersion"],9007199254740991)
            let unchanged = try boolean(envelope["unchanged"]),same = try boolean(receipt["unchanged"])
            let count = try integer(receipt["events"],4096),appended = try integer(receipt["appended"],4096),from = try integer(receipt["from"],4194304),to = try integer(receipt["to"],4194304),version = try integer(receipt["version"],9007199254740991),length = try integer(receipt["length"],4194304),capacity = try integer(receipt["capacity"],4194304),bytes = try integer(receipt["bytes"],402653184)
            let cap = Int(capacity)
            guard format==1,unchanged==same,count>=1,appended<=count,capacity>=1,capacity>=length,(cap & (cap-1))==0,bytes==96*capacity,from<to,to<=length,after>=before,version>=before,version<=after else {throw AsterError.invalidScene}
            guard unchanged ? (appended==0 && version==before && after==before) : version==before+1 else {throw AsterError.invalidScene}
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
    @discardableResult public func pauseDataIngestion() throws -> [String: Any] {try ingestionCommand("pauseDataIngestion")}
    @discardableResult public func resumeDataIngestion() throws -> [String: Any] {try ingestionCommand("resumeDataIngestion")}
    /// Explicit pending-payload cancellation; accepted cursors remain advanced.
    @discardableResult public func cancelDataEvents() throws -> [String: Any] {try ingestionCommand("cancelDataEvents")}
    /// Fresh policy/cursor/ledger and logical typed-byte counts, not process RSS.
    public func dataIngestionStats() throws -> [String: Any] {try ingestionCommand("dataIngestionStats")}
    /// Bounded special-number document. Feed data and UI are separately owned;
    /// restore those first. Active asynchronous lease state is never serialized.
    public func saveDataIngestion() throws -> String {
        guard let text=try command("saveDataIngestion").toString() else{throw AsterError.invalidScene};return text
    }
    @discardableResult public func loadDataIngestion(_ document: String) throws -> [String: Any] {
        try ingestionCommand("loadDataIngestion",[document])
    }
    private func ingestionCommand(_ operation: String,_ arguments: [Any] = []) throws -> [String: Any] {
        guard let result=try command(operation,arguments).toDictionary() as? [String: Any] else{throw AsterError.invalidScene};return result
    }
    public func setColumns(_ columns: [String: [Double]]) throws {try command("setColumns", [columns])}
    public func addPanel(_ options: [String: Any]) throws {try command("addPanel", [options])}
    public func setPanel(_ id: String, _ patch: [String: Any]) throws {try command("setPanel", [id, patch])}
    public func addAxis(_ options: [String: Any]) throws {try command("addAxis", [options])}
    public func setAxis(_ id: String, _ patch: [String: Any]) throws {try command("setAxis", [id, patch])}
    public func removeAxis(_ id: String) throws {try command("removeAxis", [id])}
    public func setDrawingTarget(_ target: [String: Any]?) throws {try command("setDrawingTarget", [target as Any? ?? NSNull()])}
    /// Bounded readout at a stored timestamp/index. May calculate lazy studies;
    /// no layout, rounding or change notification is requested by this read.
    public func dataAt(_ query: [String: Any], options: [String: Any] = [:]) throws -> [String: Any]? {
        let value = try command("dataAt", [query, options])
        if value.isNull {return nil}
        guard let result = value.toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    /// Explicit selection/readout; no chart mutation notification or redraw.
    private func dataExploration(_ action: String, _ argument: Any = NSNull()) throws -> [String: Any] {
        guard Thread.current === owner else {throw AsterError.wrongThread}
        guard !closed, !closing else {throw AsterAsyncError.engineClosed}
        let runtime = contextRuntime
        if let runtime = runtime, !runtime.acquireCaptureLease() {throw AsterAsyncError.engineClosed}
        // All JS aliases/autoreleases leave the pool before creator retirement.
        defer {runtime?.releaseCaptureLease()}
        return try autoreleasepool { () throws -> [String: Any] in
            guard let source = contextBacking else {throw AsterAsyncError.engineClosed}
            guard let function = source.objectForKeyedSubscript("nativeDataExploration"), !function.isUndefined,
                  let value = function.call(withArguments: [action, argument]) else {throw AsterError.invalidScene}
            if let exception = source.exception {
                source.exception = nil
                throw AsterError.javaScript(exception.toString() ?? "Exploration error")
            }
            let dictionary = value.toDictionary()
            if let exception = source.exception {
                source.exception = nil
                throw AsterError.javaScript(exception.toString() ?? "Exploration conversion error")
            }
            guard !closed, !closing, contextBacking === source else {throw AsterError.invalidScene}
            guard let result = dictionary as? [String: Any] else {throw AsterError.invalidScene}
            return result
        }
    }
    public func setDataExploration(_ active: Bool) throws -> [String: Any] {try dataExploration("setActive", active)}
    public func navigateDataExploration(_ key: String) throws -> [String: Any] {try dataExploration("navigate", key)}
    public func refreshDataExploration() throws -> [String: Any] {try dataExploration("refresh")}
    /// Explicit read may synchronously calculate all visible dirty studies.
    public func readDataExploration() throws -> [String: Any] {try dataExploration("read")}
    public func crosshairValues(width: Double, height: Double) throws -> [String: Any]? {try command("crosshairValues", [width, height]).toDictionary() as? [String: Any]}
    /// Fresh layout may calculate dirty studies; the snapshot contains raw OHLC identity.
    public func crosshairSnapshot(width: Double, height: Double) throws -> [String: Any]? {
        let value = try command("crosshairSnapshot", [width, height])
        if value.isNull {return nil}
        guard let result = value.toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    public func addSeries(_ options: [String: Any]) throws {try command("addSeries", [options])}
    public func setSeries(_ id: String, _ patch: [String: Any]) throws {try command("setSeries", [id, patch])}
    public func removeSeries(_ id: String) throws {try command("removeSeries", [id])}
    public func setSeriesValues(_ id: String, _ values: [Double?]) throws {try command("setSeriesValues", [id, values.map { $0.map { $0 as Any } ?? NSNull() }])}
    @discardableResult public func addIndicator(_ id: String, _ name: String, _ params: [String: Any] = [:]) throws -> JSValue {try command("addIndicator", [id, name, params])}
    @discardableResult public func setIndicatorParams(_ id: String, _ params: [String: Any]) throws -> JSValue {try command("setIndicatorParams", [id, params])}
    public func removeIndicator(_ id: String) throws {try command("removeIndicator", [id])}
    /// Select an application-linked module by id/version. This does not fetch
    /// or evaluate source code. Returned names are the canonical factory names.
    public func registerIndicatorModule(_ id: String, version: Int = 1) throws -> [String] {
        guard let names = try command("registerIndicatorModule",[id,version]).toArray() as? [String] else {throw AsterError.invalidScene}
        return names
    }
    /// Indicator definitions and their series only. Feed data, panels, axes,
    /// theme and drawing history remain owned by the caller's chart.
    public func saveStudies() throws -> String {
        guard let text = try command("saveStudies").toString() else {throw AsterError.invalidScene}
        return text
    }
    /// Bounded portable metadata only. Synchronous owner-thread read without revision/redraw notification.
    public func saveWorkspace(_ datasetBinding: [String: Any]) throws -> String {
        let result = try call("nativeSaveWorkspace", [datasetBinding])
        guard result.isString, let text = result.toString() else {throw AsterError.invalidScene}
        return text
    }
    /// Validated-only metadata/source assertion; no calculation, restore, job reservation or context swap.
    public func preflightWorkspace(_ document: String, datasetBinding: [String: Any]) throws -> [String: Any] {
        guard let result = try call("nativePreflightWorkspace", [document, datasetBinding]).toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    /// Atomic additive import; ids must be new and required layout bindings
    /// must already exist. Returns {indicators, series} counts.
    @discardableResult public func loadStudies(_ document: String) throws -> [String: Any] {
        guard let result = try command("loadStudies",[document]).toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    /// Scalar raw/plot query with optional asOfIndex. Unavailable future samples
    /// return JSON null value/sourceIndex/sourceTime; this read does not notify.
    public func indicatorValueAt(_ id: String, output: String? = nil, index: Int, options: [String: Any] = [:]) throws -> [String: Any] {
        guard let result = try command("indicatorValueAt",[id,output as Any? ?? NSNull(),index,options]).toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    public func registerIndicatorSource(_ name: String, _ source: String) throws {try call("nativeRegisterIndicatorSource",[name,source]);notifyChanges()}
    @discardableResult public func addDrawing(_ options: [String: Any]) throws -> String {try command("addDrawing", [options]).toString() ?? ""}
    /// Raw annotation metrics only; no source data, indicator work or redraw notification.
    public func positionMetrics(_ id: String) throws -> [String: Any] {
        guard let result = try command("positionMetrics", [id]).toDictionary() as? [String: Any] else {throw AsterError.invalidScene}
        return result
    }
    public func editDrawing(_ id: String, _ patch: [String: Any]) throws {try command("editDrawing", [id, patch])}
    /// Raw-coordinate group edit with one core undo. A zero-change receipt does not notify.
    /// Receipt conversion failure after execution does not imply rollback.
    @discardableResult public func translateDrawings(_ ids: [String], deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("translateDrawings",[ids,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
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
    @discardableResult public func setDrawingsVisibility(_ ids: [String], visible: Bool) throws -> [String: Any] {
        try ingestionCommand("setDrawingsVisibility",[ids,visible])
    }
    /// Chart-local unlocked copies; explicit raw offsets and one atomic core undo.
    @discardableResult public func duplicateDrawing(_ id: String, deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("duplicateDrawing",[id,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
    @discardableResult public func duplicateDrawings(_ ids: [String], deltaTimeMs: Double, deltaPrice: Double) throws -> [String: Any] {
        try ingestionCommand("duplicateDrawings",[ids,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])
    }
    /// Explicit group deletion, one core undo; empty/missing/locked IDs reject.
    @discardableResult public func deleteDrawings(_ ids: [String]) throws -> [String: Any] {
        try ingestionCommand("deleteDrawings",[ids])
    }
    public func selectDrawing(_ id: String?) throws {try command("selectDrawing", [id as Any? ?? NSNull()])}
    public func setTheme(_ patch: [String: Any]) throws {try command("setTheme", [patch])}
    public func setSymbol(_ symbol: [String: Any]) throws {try command("setSymbol", [symbol])}
    public func setCrosshairSnap(_ options: [String: Any]) throws { try command("setCrosshairSnap", [options]) }
    public func setDrawingMagnet(_ options: [String: Any]) throws { try command("setDrawingMagnet", [options]) }
    public func setTool(_ tool: String) throws {try command("setTool", [tool])}
    public func setText(_ text: String) throws {try command("setText", [text])}
    public func undo() throws {try command("undo")}
    public func redo() throws {try command("redo")}
    public func fit() throws {try command("fit")}
    public func scene(width: Double, height: Double) throws -> AsterScene {
        let value = try call("nativeSceneJSON", [width, height])
        guard let json = value.toString()?.data(using: .utf8) else { throw AsterError.invalidScene }
        return try JSONDecoder().decode(AsterScene.self, from: json)
    }
    public func saveDrawings() throws -> String {try call("nativeSave").toString() ?? ""}
    public func loadDrawings(_ document: String) throws {try command("loadDrawings", [document])}
}

public enum AsterCoreGraphicsRenderer {
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
    public static func render(_ scene: AsterScene, in ctx: CGContext, clear: Bool = true) {
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
