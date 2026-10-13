import Foundation
import CoreGraphics
import AsterNative

enum ProbeError: Error {case failed(String)}
var checks = [String]()
func check(_ value: Bool, _ name: String) throws {if !value {throw ProbeError.failed(name)};checks.append(name)}
func wait(_ ready: () -> Bool) throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 30
    while !ready() && ProcessInfo.processInfo.systemUptime < deadline {_ = RunLoop.current.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}
    if !ready() {throw ProbeError.failed("Owner callback did not complete")}
}
func columns(_ count:Int) throws -> AsterColumns {
    let time=(0..<count).map {1700000000000 + Double($0)*60000},close=(0..<count).map {100+Double($0)*0.1}
    return try AsterColumns(time:time,open:close,high:close.map{$0+1},low:close.map{$0-1},close:close,volume:(0..<count).map{Double(10+$0)})
}
func inspect(_ engine:AsterEngine) throws -> [String:Any] {try engine.command("inspect").toDictionary() as? [String:Any] ?? [:]}
do {
    try check(Thread.isMainThread,"consumer owner is the main thread")
    let engine=try AsterEngine() // SDK-owned Bundle.module; no app-side JS URL.
    defer {try? engine.close()}
    let empty=try engine.scene(width:800,height:500)
    try check(empty.stats["storedBars"]==0,"default initializer loads the SwiftPM resource and starts at0")
    if ProcessInfo.processInfo.arguments.contains("--expect-missing-resource") {throw ProbeError.failed("Missing resource unexpectedly loaded")}
    var notifications=0;let observer=try engine.observeChanges{notifications+=1}
    let source=try columns(32),bars=(0..<source.length).map {AsterBar(time:source.time[$0],open:source.open[$0],high:source.high[$0],low:source.low[$0],close:source.close[$0],volume:source.volume[$0])}
    try engine.setData(bars)
    try engine.addIndicator("consumer-ema","ema",["period":3])
    try engine.addSeries(["id":"consumer-ema-line","type":"line","panel":"price","indicator":"consumer-ema"])
    try engine.command("setVisibleRange",[0,20])
    let values=try engine.command("indicatorValues",["consumer-ema","value"]).toArray()!
    try check(values.count==32&&abs((values[2] as! NSNumber).doubleValue-100.1)<1e-10,"external OHLC and public indicator/series API")
    let drawing=try engine.addDrawing(["id":"consumer-drawing","type":"horizontal","points":[["time":source.time[2],"price":101.0]],"text":"SDK 소비자"])
    let saved=try engine.saveDrawings();try engine.undo();try engine.redo();try engine.loadDrawings(saved)
    try check(drawing=="consumer-drawing" && (try engine.saveDrawings())==saved,"drawing save/reload and undo/redo")
    let large=try columns(512);var prepared:Result<AsterAsyncMetrics,Error>?,progressOnMain=true
    let prepareJob=try engine.prepareColumnsAsync(large,visibleBars:32,progress:{_ in progressOnMain=progressOnMain&&Thread.isMainThread}){prepared=$0}
    try wait{prepared != nil};let metrics=try prepared!.get();_ = prepareJob
    try check(progressOnMain&&metrics.retainedInputBytes==512*6*8,"async external columns callback/owned input contract")
    try check((try inspect(engine))["storedBars"] as? Int==512,"async preparation publishes512 actual external bars")
    try check((try engine.saveDrawings())==saved,"async preparation preserves committed raw time/price drawing")
    var corrected:Result<AsterAsyncMetrics,Error>?
    let correction=try engine.applyDataEventAsync(["kind":"correction","bar":["time":large.time[0],"open":100.0,"high":1000.0,"low":99.0,"close":1000.0,"volume":10.0]]){corrected=$0}
    try wait{corrected != nil};_ = try corrected!.get();_ = correction
    let output=try engine.command("indicatorValues",["consumer-ema","value"]).toArray()!
    try check(abs((output[2] as! NSNumber).doubleValue-400.1)<1e-9,"async correction recalculates the public EMA output")
    let scene=try engine.scene(width:800,height:500)
    #if ASTER_SDK_LABEL_METADATA
    let ticks=scene.commands.filter{$0.role=="price-tick"}
    try check(!ticks.isEmpty&&ticks.allSatisfy{!($0.fullText ?? "").isEmpty&&$0.labelBounds?.count==4},"public optional label metadata decodes full text and portable bounds")
    #endif
    guard let context=CGContext(data:nil,width:800,height:500,bitsPerComponent:8,bytesPerRow:3200,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw ProbeError.failed("CG context")}
    AsterCoreGraphicsRenderer.render(scene,in:context)
    try check(scene.stats["storedBars"]==512&&context.makeImage() != nil,"consumer uses public scene and raw CoreGraphics renderer")
    try check(notifications>0,"public observer receives data/style mutations")
    try engine.removeObserver(observer);try engine.close();try engine.close()
    do {_ = try engine.scene(width:800,height:500);throw ProbeError.failed("closed engine accepted scene")}catch AsterAsyncError.engineClosed {checks.append("owner close is repeatable and rejects further scene calls")}
    let report:[String:Any]=["passed":checks.count,"checks":checks,"host":"independent local SwiftPM consumer / JavaScriptCore / CoreGraphics","defaultEngineCount":0,"externalBars":512,"librarySourcesInConsumerTarget":false,"appSuppliedBundleURL":false,"sourceCopyDemoImport":false,"physicalPresentationMeasured":false]
    print(String(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),encoding:.utf8)!)
}catch {
    if ProcessInfo.processInfo.arguments.contains("--expect-missing-resource") {
        if case AsterError.invalidScene=error {print("missing SwiftPM resource rejected");exit(0)}
    }
    fputs("AsterSDKProbe failed: \(error)\n",stderr);exit(1)
}
