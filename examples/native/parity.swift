import Foundation
import CoreGraphics

/// Host-level regression checks: real Swift values cross JSCore, rather than
/// calling only a JavaScript self-test. The same helper runs on macOS and iOS.
func verifyCommonAPI(_ engine: AsterEngine) throws -> [String: Any] {
    var checks: [String] = [], notified = 0
    func check(_ value: Bool, _ name: String) throws {if !value {throw AsterError.javaScript(name)};checks.append(name)}
    let token = try engine.observeChanges {notified += 1}; defer {try? engine.removeObserver(token)}
    try engine.call("nativeInit", [0])
    let t = 1700000000123.0
    func row(_ time: Double, _ close: Double = 1.345678901234e-12) -> [String: Any] {return ["time":time,"open":1.2e-12,"high":2e-12,"low":1e-12,"close":close,"volume":7]}
    try engine.setData([AsterBar(time:t,open:1.2e-12,high:2e-12,low:1e-12,close:1.345678901234e-12,volume:7)])
    try check(engine.command("inspect").forProperty("lastBar").forProperty("close").toDouble() == 1.345678901234e-12,"Swift external OHLCV Float64 injection")
    try engine.applyDataEvent(["kind":"append","bar":row(t+60000)])
    try engine.applyDataEvent(["kind":"update","bar":row(t+60000,1.8e-12)])
    try engine.applyDataEvent(["kind":"correction","bar":row(t,1.6e-12)])
    try engine.applyDataEvent(["kind":"prepend","bars":[row(t-60000)]])
    try check(engine.command("inspect").forProperty("storedBars").toInt32() == 3,"Swift append/update/correction/prepend")
    try engine.addPanel(["id":"momentum","weight":1]);try engine.setPanel("momentum",["range":[0,100],"precision":3])
    let indicator = try engine.addIndicator("r","rsi",["period":2])
    try check(indicator.forProperty("outputs").toArray() as? [String] == ["value"],"Indicator output selection metadata")
    try engine.addSeries(["id":"r-line","type":"line","panel":"momentum","indicator":"r","output":"value","color":"rgba(255,0,0,0.5)"])
    try engine.setSeries("r-line",["visible":false,"width":3]);try engine.removeIndicator("r")
    try check(engine.command("inspect").forProperty("series").toArray()?.count == 3,"Remove indicator cleans only its plotted series")
    try engine.registerIndicatorSource("double","() => ({outputs:['value'],create(){return {step:b=>[b.close*2],snapshot:()=>0,restore:()=>{}}}})")
    try engine.addIndicator("custom","double")
    try check(engine.command("indicatorValues",["custom","value"]).toArray()?.last as? Double == 3.6e-12,"Trusted custom indicator source in JSCore")
    try engine.addSeries(["id":"values","type":"line","panel":"price","values":[NSNull(),1e-12,2e-12]])
    try engine.setSeriesValues("values",[nil,1.2e-12,1.7e-12]);try engine.removeSeries("values")
    try engine.setTheme(["background":"#123","font":"italic bold 20px sans-serif","up":"lime"])
    try engine.setSymbol(["id":"TINY","exchange":"SYNTH","timezone":"America/New_York","currency":"USD","priceDecimals":15,"tickSize":1e-15,"volumeUnit":"units","adjustment":"raw"])
    let scene = try engine.scene(width:1200,height:700)
    try check(scene.background == "#112233ff" && scene.commands.contains {$0.font == "italic bold 20px sans-serif"},"Portable theme and font reach native scene")
    let id = try engine.addDrawing(["type":"text","points":[["time":t,"price":1.6e-12]],"text":"한국 🚀","style":["font":"bold 18px serif","color":"#abc"]])
    try engine.editDrawing(id,["locked":true]);try check(engine.deleteDrawing(id) == false,"Programmatic drawing lock")
    try engine.editDrawing(id,["locked":false]);try engine.editDrawing(id,["text":"edited 🚀"]);try engine.selectDrawing(id)
    let saved = try engine.saveDrawings();try engine.undo();try engine.redo();try check(engine.saveDrawings() == saved,"Common undo/redo restores exact drawing")
    try engine.deleteDrawing(id);try engine.loadDrawings(saved);try check(engine.saveDrawings() == saved,"Common drawing storage roundtrip")
    let before = notified;_ = try engine.command("inspect");_ = try engine.command("indicatorValues",["custom"])
    var rejected = false;do {try engine.setTheme(["font":"invalid"])} catch {rejected=true}
    try check(rejected && before == notified,"Failed mutations and reads do not notify native view")
    var wrongThread = false
    let finished = DispatchSemaphore(value:0)
    Thread {do {try engine.command("inspect")} catch AsterError.wrongThread {wrongThread=true} catch {};finished.signal()}.start()
    finished.wait()
    try check(wrongThread,"Swift engine owner-thread guard")
    // Typed column input also crosses the public facade.
    try engine.setColumns(["time":[t],"open":[1.2e-12],"high":[2e-12],"low":[1e-12],"close":[1.345678901234e-12],"volume":[7]])
    try check(engine.command("inspect").forProperty("storedBars").toInt32() == 1 && notified > 20,"Column input and mutation observers")
    var afterFailure=0
    let failing=try engine.observeChanges {throw AsterError.javaScript("observer failure")},following=try engine.observeChanges {afterFailure += 1}
    try engine.setTheme(["background":"#123"])
    guard afterFailure==1 && engine.observerErrors.count==1 else {throw AsterError.javaScript("Observer failure interrupted delivery")}
    try engine.removeObserver(failing);try engine.removeObserver(following)
    let hardening=try engine.call("nativeHardeningSelfTest").toDictionary() ?? [:]
    guard hardening["passed"] as? Int == 8 else {throw AsterError.javaScript("Native hardening checks failed")}
    try engine.call("nativeInit",[10000])
    return ["passed":checks.count,"checks":checks,"mutationNotifications":notified,"observerFailureIsolated":true,"hardening":hardening]
}

func nativeTextInk(_ font: String) throws -> Int {
    let json: [String: Any] = ["width":240,"height":100,"background":"#000000","stats":[:],"commands":[["op":"text","x":10,"y":80,"text":"MMMM","color":"#ffffff","font":font]]]
    let scene = try JSONDecoder().decode(AsterScene.self,from:JSONSerialization.data(withJSONObject:json))
    let context = CGContext(data:nil,width:240,height:100,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.translateBy(x:0,y:100);context.scaleBy(x:1,y:-1);AsterCoreGraphicsRenderer.render(scene,in:context)
    let bytes=context.data!.assumingMemoryBound(to:UInt8.self)
    var ink=0;for y in 0..<100 {for x in 0..<240 {let offset=y*context.bytesPerRow+x*4;if UInt16(bytes[offset])+UInt16(bytes[offset+1])+UInt16(bytes[offset+2]) > 100 {ink += 1}}};return ink
}
