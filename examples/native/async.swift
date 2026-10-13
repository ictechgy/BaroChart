import Foundation
import JavaScriptCore

private final class AsyncWeakContext {weak var value:JSContext?;init(_ value:JSContext){self.value=value}}
private let asyncIndicatorNames = ["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]
private func asyncJSON(_ value: Any) throws -> String {String(data:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]),encoding:.utf8)!}
private func asyncRead(_ engine: AsterEngine, _ source: String) throws -> JSValue {
    guard let value = engine.context.evaluateScript(source) else {throw AsterError.invalidScene}
    if let error = engine.context.exception {engine.context.exception = nil;throw AsterError.javaScript(error.toString() ?? "Fixture error")}
    return value
}
private func asyncConfigured(_ url: URL, _ count: Int) throws -> AsterEngine {
    let engine = try AsterEngine(bundleURL:url,count:count,options:["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]])
    for name in asyncIndicatorNames {_ = try engine.call("nativeIndicator",[name,name,[:],"price"])}
    _ = try engine.scene(width:1200,height:700)
    _ = try engine.addDrawing(["id":"async-note","type":"text","points":[["time":1700000000000.0,"price":100.0]],"text":"before", "style":["font":"18px monospace","color":"#ffffff"]])
    try engine.editDrawing("async-note",["text":"edited"]);try engine.undo();try engine.selectDrawing("async-note");try engine.setTool("text");try engine.setText("한국 🚀")
    return engine
}
private func asyncTextUI(_ engine:AsterEngine,_ name:String)throws {
    let text=String(repeating:name=="max-text-ui" ? "\0" : "\n",count:2000)
    for i in 0..<64{_=try engine.addDrawing(["id":"text-limit-\(i)","type":"text","points":[["time":1700000000000.0,"price":100.0]],"text":text])}
    try engine.editDrawing("text-limit-63",["text":"alternate history"]);try engine.undo();try engine.selectDrawing("async-note")
}
private func asyncTextDocumentsEqual(_ source:AsterEngine,_ expected:AsterEngine)throws->Bool {
    let actual=try JSONSerialization.jsonObject(with:source.saveDrawings().data(using:.utf8)!),reference=try JSONSerialization.jsonObject(with:expected.saveDrawings().data(using:.utf8)!)
    return try asyncJSON(actual)==asyncJSON(reference)
}
// These wrappers are trusted, isolated test faults. They are appended to a
// temporary core bundle; production helpers and source files stay unchanged.
private func asyncFaultBundle(_ original: URL, _ fault: String) throws -> URL? {
    let suffix: String
    switch fault {
    case "worker-create-error": suffix = "globalThis.nativeAsyncCreate=()=>{throw new Error('fixture worker create error')};"
    case "target-type-error": suffix = "globalThis.nativeAsyncTargetBuffer=()=>new Uint8Array(8);"
    case "compute-error": suffix = "globalThis.nativeAsyncStep=()=>{throw new Error('fixture compute error')};"
    case "timeout-running": suffix = "globalThis.fixtureStep=nativeAsyncStep;globalThis.nativeAsyncStep=(...args)=>{const until=Date.now()+250;while(Date.now()<until){};return fixtureStep(...args)};"
    default: return nil
    }
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("aster-async-fault-"+UUID().uuidString+".js")
    try (String(contentsOf:original,encoding:.utf8)+"\n"+suffix).write(to:temporary,atomically:true,encoding:.utf8)
    return temporary
}
private func asyncLatestUI(_ engine: AsterEngine, _ count: Int) throws {
    _ = try engine.command("setVisibleRange",[max(0,count-100),count-1])
    try engine.setTheme(["background":"#152535"]);try engine.editDrawing("async-note",["text":"latest 🚀"])
    try engine.setPanel("price",["label":"Latest panel", "inverted":true]);try engine.setSeries("sma-value",["color":"#aabbcc", "width":2])
}
private func asyncEvent(_ engine: AsterEngine) throws -> [String: Any] {
    let bar = try asyncRead(engine,"({...nativeModel.store.at(0),close:1000,high:1000})").toDictionary()!
    return ["kind":"correction","bar":bar]
}
private func asyncState(_ engine: AsterEngine) throws -> String {try asyncJSON(engine.command("inspect").toDictionary()!)}
private func asyncDrawingDocumentsEqual(_ source: AsterEngine, _ expected: AsterEngine, _ phase: String) throws -> Bool {
    let actual = try source.saveDrawings(), reference = try expected.saveDrawings()
    if actual == reference {return true}
    // Independently bridged NSDictionary key insertion order is unspecified.
    // Preserve every schema/record/style/anchor/value check while canonicalizing
    // JSON object keys only; array order and numeric data remain significant.
    guard let a = actual.data(using:.utf8),let b = reference.data(using:.utf8) else {throw AsterError.invalidScene}
    let equal = try asyncJSON(JSONSerialization.jsonObject(with:a)) == asyncJSON(JSONSerialization.jsonObject(with:b))
    print("Drawing fixture \(phase): literal JSON differs; canonical equality=\(equal); actual=\(actual); expected=\(reference)")
    return equal
}


// Exact Float64 byte comparison, including gaps. Data copies are verification
// only, after measured compute/heartbeat intervals; no JSON-number arrays.
private func asyncArrayBytes(_ engine: AsterEngine, _ id: String, _ output: String, _ offset: Int, _ count: Int) throws -> Data {
    let value = try asyncRead(engine,"nativeModel.indicators.get(\(try asyncJSON(id))).outputs[\(try asyncJSON(output))].subarray(\(offset),\(offset+count))")
    var exception: JSValueRef?
    let ctx = engine.context.jsGlobalContextRef!
    guard JSValueGetTypedArrayType(ctx,value.jsValueRef,&exception) == kJSTypedArrayTypeFloat64Array,let object = JSValueToObject(ctx,value.jsValueRef,&exception) else {throw AsterError.invalidScene}
    let size = JSObjectGetTypedArrayByteLength(ctx,object,&exception), at = JSObjectGetTypedArrayByteOffset(ctx,object,&exception)
    guard size == count * 8, exception == nil, let base = JSObjectGetTypedArrayBytesPtr(ctx,object,&exception),exception == nil else {throw AsterError.invalidScene}
    return Data(bytes:base.advanced(by:at),count:size)
}
private func asyncCheckVectors(_ source: AsterEngine, _ expected: AsterEngine, _ count: Int) throws {
    for id in asyncIndicatorNames {
        let outputs = try asyncRead(source,"Object.keys(nativeModel.indicators.get(\(try asyncJSON(id))).outputs)").toArray() as! [String]
        for output in outputs {for at in stride(from:0,to:count,by:4096) {
            let size = min(4096,count-at),actual = try asyncArrayBytes(source,id,output,at,size),reference = try asyncArrayBytes(expected,id,output,at,size)
            guard actual == reference else {throw AsterError.javaScript("Async vector mismatch \(id).\(output) @ \(at)")}
        }}
    }
}
private func asyncMetrics(_ value: AsterAsyncMetrics) -> [String: Any] {
    ["copiedBytes":value.copiedBytes,"checkpointJSONBytes":value.checkpointJSONBytes,"maximumChunkBytes":value.maximumChunkBytes,"beginMs":value.beginMs,"queueWaitMs":value.queueWaitMs,"commitMs":value.commitMs,"captureMs":value.captureMs,"targetCopyMs":value.targetCopyMs,"computeMs":value.computeMs,"workerInitMs":value.workerInitMs,"uiStateMs":value.uiStateMs,"finishMs":value.finishMs,"wallMs":value.totalMs,"baselineResidentBytes":value.baselineResidentBytes,"sampledPeakResidentBytes":value.peakResidentBytes,"sampledPeakDeltaBytes":value.peakResidentBytes-value.baselineResidentBytes,"progressCallbackErrors":value.progressCallbackErrors]
}

/// Shared real JSC facade fixture for macOS and UIKit. Setup and reference
/// validation occur outside the UI heartbeat/async memory measurement interval.
/// Root schedules actual platform/performance runs; no physical-device claim.
func verifyNativeAsync(_ bundleURL: URL, count: Int = 8192, status: ((String) -> Void)? = nil, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    AsterAsyncFixture(bundleURL,count,status,completion).run()
}
private final class AsterAsyncFixture {
    let url: URL, count: Int, status: ((String) -> Void)?, completion: (Result<[String: Any], Error>) -> Void
    var checks: [String] = [], rows: [[String: Any]] = [], caseIndex = 0, source: AsterEngine?, job: AsterAsyncJob?, observer: UUID?
    var timer: DispatchSourceTimer?, beats = 0, gaps: [Double] = [], lastBeat = 0.0, terminalCount = 0, cancelAt = 0.0
    let cases = ["success","throwing-progress","typed-offset","text-ui","max-text-ui","cancel-before","cancel-background","cancel-capture","cancel-checkpoints","cancel-calculate","timeout","timeout-running","worker-create-error","target-type-error","compute-error","checkpoint-json-error","checkpoint-marker-error","wrong-factory","invalid-event","stale-data","stale-config","source-reinit","unsupported-factory","active-gesture","capture-error","finish-error","close","deallocated","wrong-owner","busy","recreate"]
    init(_ url: URL, _ count: Int, _ status: ((String) -> Void)?, _ completion: @escaping (Result<[String: Any], Error>) -> Void) {self.url = url;self.count = max(512,count);self.status = status;self.completion = completion}
    func require(_ value: Bool, _ name: String) throws {if !value {throw AsterError.javaScript(name)};checks.append(name)}
    func run() {
        guard Thread.isMainThread else {completion(.failure(AsterError.wrongThread));return}
        next()
    }
    func heartbeatStart() {
        beats = 0;gaps = [];lastBeat = ProcessInfo.processInfo.systemUptime
        let timer = DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now(),repeating:.milliseconds(8));timer.setEventHandler { [weak self] in
            guard let self = self else {return};let now = ProcessInfo.processInfo.systemUptime;self.gaps.append((now-self.lastBeat)*1000);self.lastBeat = now;self.beats += 1
        };self.timer = timer;timer.resume()
    }
    func heartbeatStop() {
        if timer != nil {gaps.append((ProcessInfo.processInfo.systemUptime-lastBeat)*1000)}
        timer?.cancel();timer = nil
    }
    func fail(_ error: Error) {heartbeatStop();job?.cancel();source = nil;job = nil;completion(.failure(error))}
    func advance(_ engine: AsterEngine) {
        do {if let token = observer {try engine.removeObserver(token)};observer = nil;source = nil;job = nil;caseIndex += 1;DispatchQueue.main.async {self.next()}} catch {fail(error)}
    }
    func next() {
        if caseIndex == cases.count {
            completion(.success(["passed":checks.count,"checks":checks,"cases":rows,"host":"isolated JavaScriptCore + owner-main context handoff", "storedBars":count,"seed":42,"indicators":8,"outputs":15,"heartbeatIntervalMs":8,"peakMemoryMethod":"sampled process mach_task_basic_info resident_size; excludes reference/setup verification; not isolated VM footprint", "physicalDevice":false]));return
        }
        let name = cases[caseIndex];status?(name)
        do {
            // Large measured fixture once. Failure paths use the same builtin
            // families but 8192 bars to keep regression runs bounded.
            let size = name == "success" ? count : min(count,8192)
            let fault = try asyncFaultBundle(url,name)
            let engine: AsterEngine
            do {engine = try asyncConfigured(fault ?? url,size)} catch {if let fault = fault {try? FileManager.default.removeItem(at:fault)};throw error}
            if let fault = fault {try FileManager.default.removeItem(at:fault)}
            if ["text-ui","max-text-ui"].contains(name){try asyncTextUI(engine,name)}
            source = engine;terminalCount = 0;cancelAt = 0
            let original = AsyncWeakContext(engine.context);let initial = try asyncState(engine)
            var expected = initial, notified = 0, notificationsBeforeHandoff = 0, changedUI = false, acted = false
            observer = try engine.observeChanges {notified += 1}
            var event = try asyncEvent(engine)
            if name == "invalid-event" {event = ["kind":"correction","bar":["time":1700000000000.0,"open":1,"high":0,"low":2,"close":1,"volume":1]]}
            if name == "checkpoint-json-error" {_ = try asyncRead(engine,"globalThis.nativeAsyncCheckpoint=()=> '[';true")}
            if name == "checkpoint-marker-error" {_ = try asyncRead(engine,"globalThis.nativeAsyncCheckpoint=()=> '[[0,{\"$asterNumber\":\"bogus\"}]]';true")}
            if name == "wrong-factory" {
                // All substituted states are valid RSI checkpoints, not merely
                // malformed data. Metadata names the EMA entry as RSI; only
                // the source's final expected request bindings can reject it.
                _ = try asyncRead(engine,"globalThis.fixtureBegin=nativeAsyncBegin;globalThis.fixtureCheckpoint=nativeAsyncCheckpoint;globalThis.nativeAsyncBegin=(event)=>{const plan=JSON.parse(fixtureBegin(event)),meta=JSON.parse(plan.metadataJSON);meta.indicators.find(e=>e.id==='ema').name='rsi';plan.metadataJSON=JSON.stringify(meta);return JSON.stringify(plan)};globalThis.nativeAsyncCheckpoint=(ticket,entry,offset,count)=>fixtureCheckpoint(ticket,entry===1?6:entry,offset,count);true")
            }
            if name == "typed-offset" {
                _ = try asyncRead(engine,"globalThis.fixtureBuffer=nativeAsyncBuffer;globalThis.nativeAsyncBuffer=(...args)=>{const view=fixtureBuffer(...args),padded=new Float64Array(view.length+3);padded.set(view,3);return padded.subarray(3)};true")
            }
            if name == "unsupported-factory" {try engine.registerIndicatorSource("fixture-custom","()=>({outputs:['value'],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}}}})");try engine.addIndicator("custom","fixture-custom");expected = try asyncState(engine)}
            if name == "capture-error" {_ = try asyncRead(engine,"globalThis.nativeAsyncBuffer=()=>{throw new Error('fixture capture error')};true")}
            if name == "wrong-owner" {
                let done = DispatchSemaphore(value:0);var rejected = false, backgroundOwned = false
                Thread {do {_ = try engine.applyDataEventAsync(event) {_ in}} catch AsterError.wrongThread {rejected = true} catch {}
                    do {let other = try AsterEngine(bundleURL:self.url,count:0);_ = try other.applyDataEventAsync(event) {_ in}} catch AsterAsyncError.mainOwnerRequired {backgroundOwned = true} catch {};done.signal()
                }.start();done.wait()
                try require(rejected && backgroundOwned,"Wrong thread and background owner rejected")
                try engine.removeObserver(observer!);source = nil;observer = nil;rows.append(["case":name,"ownerChecks":true]);caseIndex += 1;DispatchQueue.main.async {self.next()};return
            }
            heartbeatStart()
            let started = ProcessInfo.processInfo.systemUptime
            let submitted = try engine.applyDataEventAsync(event, timeout:name == "timeout" ? 0.000001 : name == "timeout-running" ? 1 : 30, progress: { [self] progress in
                guard Thread.isMainThread else {throw AsterError.wrongThread}
                defer {notificationsBeforeHandoff = notified}
                status?("\(name): \(progress.phase) \(progress.done)/\(progress.total)")
                guard let source = source else {return}
                if name == "throwing-progress" {throw AsterError.javaScript("Intentional progress callback failure")}
                if name == "success" && !changedUI {try asyncLatestUI(source,size);changedUI = true}
                if acted {return}
                switch name {
                case "timeout-running" where progress.phase == "calculate": acted = true
                case "cancel-background" where progress.phase == "capture": acted = true;cancelAt = ProcessInfo.processInfo.systemUptime;if let handle = job {Thread {handle.cancel()}.start()}
                case "cancel-capture" where progress.phase == "capture": acted = true;cancelAt = ProcessInfo.processInfo.systemUptime;job?.cancel()
                case "cancel-checkpoints" where progress.phase == "checkpoints": acted = true;cancelAt = ProcessInfo.processInfo.systemUptime;job?.cancel()
                case "cancel-calculate" where ["calculate","indices","ready"].contains(progress.phase): acted = true;cancelAt = ProcessInfo.processInfo.systemUptime;job?.cancel()
                case "stale-data": acted = true;try source.applyDataEvent(["kind":"correction","bar":["time":1700000000000.0,"open":100,"high":2000,"low":99,"close":2000,"volume":4]]);expected = try asyncState(source)
                case "stale-config": acted = true;try source.setSeries("ema-value",["visible":false]);try source.addIndicator("new-indicator","rsi");expected = try asyncState(source)
                case "source-reinit": acted = true;_ = try source.call("nativeInit",[512]);expected = try asyncState(source)
                case "active-gesture": acted = true;_ = try source.call("nativePointer",["down",1,100,100]);expected = try asyncState(source)
                case "finish-error": acted = true;try source.setTheme(["font":"12px monospace"]);_ = try asyncRead(source,"nativeModel.panels[0].formatter=()=> 'trusted formatter';true");expected = try asyncState(source)
                case "close": acted = true;try source.close()
                default: break
                }
            }) { [self, weak engine] result in
                heartbeatStop();terminalCount += 1
                do {
                    try require(Thread.isMainThread && terminalCount == 1,"\(name) exactly one owner terminal")
                    let successCases = ["success","throwing-progress","typed-offset","text-ui","max-text-ui","recreate","busy"]
                    if successCases.contains(name) {
                        guard let engine = engine else {throw AsterError.invalidScene};let metrics = try result.get()
                        try require(engine.context !== original.value && notified > notificationsBeforeHandoff,"\(name) context swap preserves observers")
                        try require(metrics.maximumChunkBytes <= 2097152,"\(name) bounded copy chunks")
                        if name == "throwing-progress" {try require(metrics.progressCallbackErrors > 0,"Throwing progress isolated")}
                        // Reference allocation/correction is intentionally after
                        // stopping heartbeat and sampling job RSS.
                        let reference = try asyncConfigured(url,size);if changedUI {try asyncLatestUI(reference,size)};try reference.applyDataEvent(event)
                        if ["text-ui","max-text-ui"].contains(name){try asyncTextUI(reference,name);try require(metrics.uiTransferBytes>262144&&metrics.maximumUIChunkBytes<=262144&&metrics.uiChunkCount>1,"\(name) accepted64 max texts/history bounded")}
                        try asyncCheckVectors(engine,reference,size)
                        try require(asyncState(engine) == asyncState(reference),"\(name) exact UI/data facade state")
                        try require(engine.call("nativeSceneJSON",[1200,700]).toString() == reference.call("nativeSceneJSON",[1200,700]).toString(),"\(name) exact range/scene")
                        try engine.undo();try reference.undo();let textCase=["text-ui","max-text-ui"].contains(name);try require(textCase ? asyncTextDocumentsEqual(engine,reference) : asyncDrawingDocumentsEqual(engine,reference,"\(name) undo"),"\(name) undo history");try engine.redo();try reference.redo();try require(textCase ? asyncTextDocumentsEqual(engine,reference) : asyncDrawingDocumentsEqual(engine,reference,"\(name) redo"),"\(name) redo history")
                        var row = asyncMetrics(metrics);row["case"] = name;row["heartbeatCount"] = beats;row["maximumHeartbeatGapMs"] = gaps.max() ?? 0;row["heartbeatGapsOver50Ms"] = gaps.filter {$0 >= 50}.count;row["exactVectors"] = true;rows.append(row)
                        if ["text-ui","max-text-ui"].contains(name){rows[rows.count-1]["uiChunkCount"]=metrics.uiChunkCount;rows[rows.count-1]["uiTransferBytes"]=metrics.uiTransferBytes;rows[rows.count-1]["maximumUIChunkBytes"]=metrics.maximumUIChunkBytes}
                    } else {
                        if case .success = result {throw AsterError.javaScript("\(name) unexpectedly committed")}
                        if name == "timeout-running" {
                            try require(acted,"Timeout observed while calculation ran")
                            guard case .failure(AsterAsyncError.timedOut) = result else {throw AsterError.javaScript("Running timeout returned incorrect failure")}
                        }
                        if name == "wrong-factory" {try require(String(describing:result).contains("binding"),"Valid wrong-factory states rejected by expected request binding")}
                        if name == "target-type-error" {try require(String(describing:result).contains("Float64Array"),"Wrong target type rejected before memcpy")}
                        if let engine = engine {
                            try require(engine.context === original.value,"\(name) retains source context")
                            if name != "close" {try require(asyncState(engine) == expected,"\(name) failure leaves source unchanged")}
                            if name == "active-gesture" {_ = try engine.call("nativePointer",["cancel",0,0,0])}
                        } else {try require(name == "deallocated","Only deallocated case loses engine")}
                        if ["cancel-background","cancel-capture","cancel-checkpoints","cancel-calculate"].contains(name) {try require(acted,"\(name) cancellation reached requested phase")}
                        rows.append(["case":name,"wallMs":(ProcessInfo.processInfo.systemUptime-started)*1000,"cancelToTerminalMs":cancelAt > 0 ? (ProcessInfo.processInfo.systemUptime-cancelAt)*1000 : 0,"error":String(describing:result),"sourceContextRetained":engine != nil])
                    }
                    if name == "cancel-before",let engine = engine {
                        let retry = try engine.applyDataEventAsync(event) { [self, weak engine] result in
                            do {
                                _ = try result.get();guard let engine = engine else {throw AsterError.invalidScene}
                                try require(engine.context !== original.value,"Cancelled engine can start a new job after release")
                                advance(engine)
                            } catch {fail(error)}
                        }
                        job = retry;return
                    }
                    if let token = observer,let engine = engine {try engine.removeObserver(token)}
                    observer = nil;source = nil;job = nil;caseIndex += 1;DispatchQueue.main.async {self.next()}
                } catch {fail(error)}
            }
            job = submitted
            if name == "cancel-before" {cancelAt = ProcessInfo.processInfo.systemUptime;submitted.cancel()}
            if name == "busy" {var rejected = false;do {_ = try engine.applyDataEventAsync(event) {_ in}} catch AsterAsyncError.busy {rejected = true};try require(rejected,"At most one active job")}
            if name == "deallocated" {source = nil}
        } catch {fail(error)}
    }
}
