import Foundation
import JavaScriptCore
import CryptoKit
import Darwin

// macOS JSC + Foundation consumption of the exact UIKit value. No UIKit,
// raster/compositor or timed-method hooks. Load the unmodified frozen resource.
private func cycle11ReadoutClock() -> Double {ProcessInfo.processInfo.systemUptime}
private func digest(_ text: String) -> String {SHA256.hash(data: Data(text.utf8)).map {String(format: "%02x",$0)}.joined()}
private func residentBytes() -> UInt64 {
    var info = mach_task_basic_info(), count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let code = withUnsafeMutablePointer(to: &info) {p in p.withMemoryRebound(to: integer_t.self,capacity: Int(count)) {task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&count)}}
    return code == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}
private func distribution(_ values: [Double]) -> [String: Double] {
    let a = values.sorted();return ["samples":Double(a.count),"p50":a[a.count/2],"p95":a[min(a.count-1,Int(Double(a.count)*0.95))],"max":a.last!]
}
private func ledger(_ engine: AsterEngine,_ field: String) -> Int? {
    guard let value = Mirror(reflecting: engine).children.first(where: {$0.label == field})?.value else {return nil}
    let mirror = Mirror(reflecting: value);return mirror.displayStyle == .dictionary ? mirror.children.count : nil
}
private func require(_ condition: Bool,_ message: String) throws {if !condition {throw NSError(domain:"AsterCycle11Readout",code:1,userInfo:[NSLocalizedDescriptionKey:message])}}
private func originalUIKitValue(_ summary: [AnyHashable: Any]) -> String {
    let panels = (summary["panels"] as? [[String: Any]] ?? []).compactMap {$0["title"] as? String}.joined(separator:"; ")
    let reading = summary["readout"] as? String ?? "close \(summary["close"] ?? "No data")"
    return ["\(summary["bars"] ?? 0) bars",panels,reading,"\(summary["selection"] ?? "No selection")","tool \(summary["tool"] ?? "select")"].filter {!$0.isEmpty}.joined(separator:"; ")
}
private let proofSource = """
globalThis.__cycle11ReadoutProof=function(){
 const vectors={},c=nativeModel.store.columns,n=nativeModel.store.length;
 function bits(a){let h=2166136261,g=2166136261;const words=new Uint32Array(a.buffer,a.byteOffset,n*2);for(const x of words){h=Math.imul(h^x,16777619)>>>0;g=Math.imul(g^(x>>>16)^x,2246822519)>>>0;}return [h,g];}
 for(const [k,a] of Object.entries(c))vectors[k]=bits(a);
 for(const s of nativeModel.series)if(s.values instanceof Float64Array)vectors[s.id]=bits(s.values);
 return {vectors,length:n,view:{...nativeModel.view},document:nativeModel.drawings.save(),raw:[0,1,42,50000,n-1].filter(i=>i<n).map(i=>({index:i,bar:nativeModel.store.at(i)})),crosshair:nativeAPI.crosshairValues(1200,700),listenerLedger:nativeModel.store.listeners.size};
};
globalThis.__cycle11ReadoutDispose=function(){nativeInput.cancel();nativeModel.dispose();return nativeModel.store.listeners.size;};
"""

@main struct Cycle11Readout {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 5,args[3] == "legacy" || args[3] == "text",args[4] == "--isolated" else {
            throw NSError(domain:"AsterCycle11Readout",code:2,userInfo:[NSLocalizedDescriptionKey:"readout <frozen-resource.js> <output.json> <legacy|text> --isolated; no execution before quietGO"])
        }
        let bundle = URL(fileURLWithPath:args[1]),output = URL(fileURLWithPath:args[2]),mode = args[3]
        var cases: [[String: Any]] = [],failure: String?
        var report: [String: Any] = ["schema":"aster.cycle11.native-readout","mode":mode,"timestamp":ISO8601DateFormatter().string(from:Date()),"measurementRan":true,"ownerMainThread":Thread.isMainThread,"platform":ProcessInfo.processInfo.operatingSystemVersionString,"warmup":15,"samples":60,"bars":100000,"seed":42,"cssSize":[1200,700],"resourceSHA256":digest(try String(contentsOf:bundle,encoding:.utf8)),"scope":"Original resource/SDK; injected hover and frame preparation are outside readout timer. Timed JSC + Foundation old UIKit value assembly vs text.toString, no UIView/raster/display FPS. Untimed extra rich read checks every value; no method hooks. RSS endpoints include retained data and do not prove peak/leak freedom."]
        report["sceneMemoryScope"] = "Process RSS endpoints include source/JSC, data/line Float64 buffers, indexes and untimed SceneCache preparation. They are not AX-only allocated bytes, operation peak, UIKit/raster memory or leak proof. Zero resident reading means task_info unavailable."
        for lines in [1,32] {for range in ["recent200","full100k"] {
            if failure != nil {break}
            var raw: [[String: Double]] = [],valueHashes: [String] = []
            weak var weakEngine: AsterEngine?
            do {
                let result = try autoreleasepool {() throws -> [String: Any] in
                    let memoryBefore = residentBytes()
                    let engine = try AsterEngine(bundleURL:bundle,count:100000,options:["panels":[["id":"price","weight":3,"label":"price"]],"series":[["id":"p","type":"candles","panel":"price"]],"visibleBars":200,"theme":["font":"12px monospace"]])
                    weakEngine = engine
                    engine.context.evaluateScript(proofSource)
                    if let exception = engine.context.exception {throw AsterError.javaScript(exception.toString() ?? "Proof installation")}
                    engine.context.evaluateScript("for(let i=0;i<\(lines);i++)nativeModel.addSeries({id:'l'+i,type:'line',panel:'price',values:Float64Array.from(nativeModel.store.columns.close.subarray(0,100000),v=>v+i*.1)});"+(range == "full100k" ? "nativeModel.fit();" : ""))
                    if let exception = engine.context.exception {throw AsterError.javaScript(exception.toString() ?? "Fixture installation")}
                    _ = try engine.observeChanges {}
                    let token = "cycle11-readout",memoryReady = residentBytes()
                    var memoryAfterWarmup: UInt64 = 0,lastValueBytes = 0,measuredBaseRedraws = 0
                    defer {try? engine.close()}
                    for i in 0..<75 {try autoreleasepool {
                        _ = try engine.call("nativePointer",["move",99,80+(i*37)%1020,60+(i*29)%580])
                        guard let frameText = try engine.call("nativeRenderFrameJSON",[token,1200,700,i == 0]).toString(),let data = frameText.data(using:.utf8),let frame = try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AsterError.invalidScene}
                        if i >= 15,frame["base"] != nil,!(frame["base"] is NSNull) {measuredBaseRedraws += 1}
                        let began = cycle11ReadoutClock(),value: String,afterJS: Double,afterBridge: Double,finished: Double
                        if mode == "legacy" {
                            let snapshot = try engine.call("nativeAccessibility",[true]);afterJS = cycle11ReadoutClock()
                            guard let summary = snapshot.toDictionary() else {throw AsterError.invalidScene};afterBridge = cycle11ReadoutClock()
                            value = originalUIKitValue(summary);finished = cycle11ReadoutClock()
                        } else {
                            let text = try engine.call("nativeAccessibilityText",[true,"uikit"]);afterJS = cycle11ReadoutClock()
                            guard text.isString,let converted = text.toString() else {throw AsterError.invalidScene}
                            value = converted;afterBridge = cycle11ReadoutClock();finished = afterBridge
                        }
                        // Correctness outside the timer: source API stays rich and the
                        // candidate text must exactly equal old Foundation assembly.
                        guard let rich = try engine.call("nativeAccessibility",[true]).toDictionary() else {throw AsterError.invalidScene}
                        try require(value == originalUIKitValue(rich),"Every-hover exact UIKit value")
                        let valueHash = digest(value);valueHashes.append(valueHash);lastValueBytes = value.utf8.count
                        if i == 14 {memoryAfterWarmup = residentBytes()}
                        if i >= 15 {raw.append(["jsUs":(afterJS-began)*1e6,"hostConsumptionUs":(afterBridge-afterJS)*1e6,"hostAssemblyUs":(finished-afterBridge)*1e6,"totalUs":(finished-began)*1e6,"valueUTF8Bytes":Double(lastValueBytes)])}
                    }}
                    let memoryAfterMeasured = residentBytes()
                    guard let proof = try engine.call("__cycle11ReadoutProof").toDictionary() else {throw AsterError.invalidScene}
                    let coreLedger = try engine.call("__cycle11ReadoutDispose").toInt32()
                    try require(coreLedger == 0,"Explicit model dispose listener ledger")
                    try engine.close()
                    let observers = ledger(engine,"observers"),handles = ledger(engine,"frameCleanup")
                    try require(observers == 0 && handles == 0,"Closed host owner ledgers")
                    var rejectsClosed = false
                    do {_ = try engine.call("nativeAccessibility",[true])} catch AsterAsyncError.engineClosed {rejectsClosed = true}
                    try require(rejectsClosed,"Closed engine call rejects")
                    try require(measuredBaseRedraws == 0,"Every measured hover has prepared cached base")
                    let stats = Dictionary(uniqueKeysWithValues:["jsUs","hostConsumptionUs","hostAssemblyUs","totalUs"].map {key in (key,distribution(raw.map {$0[key]!}))})
                    return ["lines":lines,"range":range,"raw":raw,"summary":stats,"everyHoverValueSHA256":valueHashes,"finalValueUTF8Bytes":lastValueBytes,"proof":proof,"measuredBaseRedraws":measuredBaseRedraws,"coreListenerLedgerAfterExplicitDispose":Int(coreLedger),"hostObserversAfterClose":observers!,"hostFrameCleanupAfterClose":handles!,"closedCallRejected":rejectsClosed,"privateFrameMapCount":NSNull(),"privateFrameMapScope":"Original resource, private Map not instrumented. SDK close calls nativeReleaseFrameCaches; no automatic VM release claim.","memoryResidentBytes":["beforeFixture":memoryBefore,"ready":memoryReady,"afterWarmup":memoryAfterWarmup,"afterMeasured":memoryAfterMeasured,"afterCloseWhileEngineRetained":residentBytes()]]
                }
                try require(weakEngine == nil,"Engine released after case autoreleasepool")
                var complete = result;complete["weakEngineNilAfterScope"] = true;cases.append(complete)
            } catch {
                failure = String(describing:error);cases.append(["lines":lines,"range":range,"raw":raw,"everyHoverValueSHA256":valueHashes,"failure":failure!])
            }
        }}
        report["cases"] = cases
        if let failure = failure {report["failure"] = failure}
        try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output)
        if let failure = failure {throw NSError(domain:"AsterCycle11Readout",code:3,userInfo:[NSLocalizedDescriptionKey:failure])}
        print(output.path)
    }
}
