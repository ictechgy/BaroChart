import Foundation
import JavaScriptCore
import CoreGraphics

private func axisJSON(_ value:Any)throws->String {String(data:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]),encoding:.utf8)!}
private func axisObject(_ engine:AsterEngine,_ name:String,_ args:[Any]=[])throws->[String:Any] {
    guard let value=try engine.call(name,args).toDictionary() as? [String:Any] else{throw AsterError.javaScript("Axis fixture object: \(name)")};return value
}
/// Constant fixture expression only. Values are bounded numbers, never user
/// supplied JavaScript. Public nativePointer remains the interaction entrypoint.
func nativeAxisPoint(_ engine:AsterEngine,index:Int,price:Double=2100,width:Double,height:Double)throws->[String:Double] {
    guard index>=0,index<24,price.isFinite,width.isFinite,height.isFinite,width>=100,height>=80 else{throw AsterError.invalidScene}
    let expression="(()=>{const l=Aster.createLayout(nativeModel,\(width),\(height)),b=l.axis('price','comparison-B');return {x:l.x(\(index)),y:b.y(\(price)),top:b.top,bottom:b.bottom,primaryMin:l.panels[0].min,primaryMax:l.panels[0].max,min:b.min,max:b.max,drawingCommands:nativeModel.drawings.items.reduce((n,d)=>n+Aster.drawingGeometry(d,l).length,0)};})()"
    guard let raw=engine.context.evaluateScript(expression),let object=raw.toDictionary() as? [String:Double] else{throw AsterError.invalidScene}
    if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Axis probe error")};return object
}
func nativeComparisonLabel(_ packet:[String:Any])->String {
    guard let reading=packet["reading"] as? [String:Any],let primary=reading["primary"] as? [String:Any],let bar=primary["bar"] as? [String:Any] else{return packet["text"] as? String ?? "A OHLCV / B exact price · move cursor"}
    guard let open=(bar["open"] as? NSNumber)?.doubleValue,let high=(bar["high"] as? NSNumber)?.doubleValue,let low=(bar["low"] as? NSNumber)?.doubleValue,let close=(bar["close"] as? NSNumber)?.doubleValue,let volume=(bar["volume"] as? NSNumber)?.doubleValue else{return "Primary OHLCV unavailable"}
    let a=String(format:"A OHLCV · O %.2f H %.2f L %.2f C %.2f V %.0f",open,high,low,close,volume)
    let series=reading["series"] as? [[String:Any]] ?? [],b=series.first{$0["id"] as? String=="comparison-B-line"}
    let value:String;if let b=b{value=(b["value"] as? NSNumber).map{String(format:"%.3f",$0.doubleValue)} ?? "gap"}else{value="removed"}
    let utc=(reading["time"] as? NSNumber)?.stringValue ?? "—"
    return "\(a) / SYNTH:B \(value) / UTC \(utc)"
}
func nativeComparisonPacket(_ engine:AsterEngine,width:Double,height:Double)throws->[String:Any] {try axisObject(engine,"nativeComparisonReadout",[width,height])}
@discardableResult func nativeComparisonAction(_ engine:AsterEngine,_ action:String,width:Double,height:Double,saved:String?=nil)throws->[String:Any] {
    try axisObject(engine,"nativeComparisonAction",[action,width,height,saved as Any? ?? NSNull()])
}
private func axisReading(_ packet:[String:Any])throws->[String:Any] {guard let value=packet["reading"] as? [String:Any] else{throw AsterError.javaScript("Missing comparison readout")};return value}
private func axisSeries(_ reading:[String:Any])throws->[String:Any] {guard let series=(reading["series"] as? [[String:Any]])?.first(where:{$0["id"] as? String=="comparison-B-line"}) else{throw AsterError.javaScript("Missing B readout")};return series}

/// Crosses the real Swift/JSC generic facade. Rendering and actual mouse/touch
/// routing are additionally checked by the corresponding app window fixture.
func verifyNativeAxes(_ engine:AsterEngine,width:Double=800,height:Double=500)throws->[String:Any] {
    var checks:[String]=[]
    func require(_ value:Bool,_ message:String)throws {guard value else{throw AsterError.javaScript("Native axes: \(message)")};checks.append(message)}
    let shared=try axisObject(engine,"nativeAxesSelfTest"),sharedChecks=shared["checks"] as? [String] ?? []
    try require(!sharedChecks.isEmpty&&(shared["passed"] as? Int)==sharedChecks.count,"Shared independent-axis numerical checks")
    let setup=try axisObject(engine,"nativeComparisonDemo")
    try require(setup["bars"] as? Int==24&&setup["matches"] as? Int==12&&setup["gaps"] as? Int==12,"Exact UTC join counts")
    let point=try nativeAxisPoint(engine,index:2,width:width,height:height)
    try require(point["primaryMin"]==99&&point["primaryMax"]==125&&point["min"]==2010&&point["max"]==2220,"Independent raw ranges through JSC")
    _=try engine.call("nativeResize",[width,height]);_=try engine.call("nativePointer",["move",0,point["x"]!,point["y"]!])
    let match=try nativeComparisonPacket(engine,width:width,height:height),reading=try axisReading(match),b=try axisSeries(reading)
    let bar=(reading["primary"] as! [String:Any])["bar"] as! [String:Any]
    try require(bar["open"] as? Double==102&&bar["high"] as? Double==104&&bar["low"] as? Double==101&&bar["close"] as? Double==103&&b["value"] as? Double==2020,"Primary OHLCV stays separate from B price")
    try require(b["symbolId"] as? String=="SYNTH:B"&&b["sourceTime"] as? Double==1700000120000,"B symbol and exact source time")
    let readRevision=engine.revision;var readNotifications=0
    let readObserver=try engine.observeChanges{readNotifications+=1}
    let directRead=try engine.crosshairValues(width:width,height:height),genericRead=try engine.command("crosshairValues",[width,height]).toDictionary() as? [String:Any]
    try engine.removeObserver(readObserver)
    try require(engine.revision==readRevision&&readNotifications==0&&directRead?["index"] as? Int==2&&genericRead?["index"] as? Int==2,"Swift crosshair reads preserve revision and observers")
    let gapPoint=try nativeAxisPoint(engine,index:3,width:width,height:height);_=try engine.call("nativePointer",["move",0,gapPoint["x"]!,gapPoint["y"]!])
    let gap=try nativeComparisonPacket(engine,width:width,height:height),gapReading=try axisReading(gap)
    try require(try axisSeries(gapReading)["value"] is NSNull,"Missing B quote remains gap")
    try require(nativeComparisonLabel(gap).contains("SYNTH:B gap")&&((gapReading["primary"] as! [String:Any])["bar"] as! [String:Any])["close"] as? Double==104,"Gap readout keeps primary OHLCV")
    _=try engine.command("addAxis",[["id":"facade-percent","panel":"price","scale":"percent","base":2000,"range":[2000,4000],"precision":1]])
    _=try engine.command("setAxis",["facade-percent",["visible":false]]);_=try engine.command("removeAxis",["facade-percent"])
    try require((try engine.command("inspect").forProperty("axes").toArray() as? [[String:Any]])?.count==1,"Generic add/set/remove axis ABI")
    _=try engine.command("setAxis",["comparison-B",["scale":"log","range":[100,10000],"padding":0]])
    let log=try nativeAxisPoint(engine,index:2,price:1000,width:width,height:height)
    try require(abs(log["y"]!-(log["top"]!+log["bottom"]!)/2)<1e-8,"Log geometric midpoint")
    _=try engine.command("setAxis",["comparison-B",["scale":"percent","base":2000,"range":[2000,4000],"precision":1]])
    let percent=try nativeAxisPoint(engine,index:2,price:3000,width:width,height:height);_=try engine.call("nativePointer",["move",0,percent["x"]!,percent["y"]!])
    let percentReading=try axisReading(nativeComparisonPacket(engine,width:width,height:height)),formatted=(percentReading["axes"] as? [[String:Any]])?.first{$0["id"] as? String=="comparison-B"}?["formatted"] as? String
    try require(formatted=="B 50.0%","Independent percent base and precision")
    let before=try axisJSON(engine.command("inspect").toDictionary()!);var rejected=false
    do{_=try engine.command("setAxis",["comparison-B",["base":0]])}catch{rejected=true}
    try require(rejected&&before==axisJSON(engine.command("inspect").toDictionary()!),"Zero percent base rejects atomically")
    _=try axisObject(engine,"nativeComparisonDemo");_=try nativeComparisonAction(engine,"drawing",width:width,height:height)
    let savedResult=try nativeComparisonAction(engine,"save",width:width,height:height),saved=savedResult["savedDocument"] as! String,document=try JSONSerialization.jsonObject(with:saved.data(using:.utf8)!) as! [String:Any],drawing=(document["drawings"] as! [[String:Any]])[0]
    try require(document["version"] as? Int==2&&drawing["axisId"] as? String=="comparison-B"&&drawing["seriesId"] as? String=="comparison-B-line","Bound drawing exports v2 schema")
    _=try nativeComparisonAction(engine,"hide-axis",width:width,height:height)
    try require(try nativeAxisPoint(engine,index:2,width:width,height:height)["drawingCommands"]!>0,"Hidden axis retains drawing transform")
    _=try nativeComparisonAction(engine,"series",width:width,height:height)
    try require(try nativeAxisPoint(engine,index:2,width:width,height:height)["drawingCommands"]==0,"Removed B series hides bound drawing")
    let removed=try engine.saveDrawings();rejected=false;do{_=try nativeComparisonAction(engine,"load",width:width,height:height,saved:saved)}catch{rejected=true}
    try require(rejected&&removed==engine.saveDrawings(),"Missing-binding load rejects without mutation")
    _=try nativeComparisonAction(engine,"series",width:width,height:height);_=try nativeComparisonAction(engine,"load",width:width,height:height,saved:saved)
    try require(try engine.saveDrawings()==saved&&nativeAxisPoint(engine,index:2,width:width,height:height)["drawingCommands"]!>0,"Reconnected binding restores exact document")
    let id=drawing["id"] as! String;try engine.editDrawing(id,["points":[["time":1700000000123.0,"price":2025.0],["time":1700001380000.0,"price":2230.0]]]);try engine.undo();try require(try engine.saveDrawings()==saved,"Bound edit undo restores raw anchors");try engine.redo()
    _=try nativeComparisonAction(engine,"primary",width:width,height:height)
    try require(try engine.command("inspect").forProperty("drawingTarget").isNull,"Primary drawing target clears B binding")
    _=try axisObject(engine,"nativeComparisonDemo")
    return ["passed":checks.count,"checks":checks,"shared":shared,"matchedReadout":match,"gapReadout":gap,"rawRanges":["primary":[99,125],"B":[2010,2220]],"externalSeriesIsOHLCV":false,"physicalDevice":false]
}

/// Returns immediately to the UI event loop. Waiting inside a main-queue UI
/// callback would prevent the host's source-capture rendezvous from executing.
@discardableResult func verifyNativeAxesHandoff(_ engine:AsterEngine,width:Double,height:Double,completion:@escaping(Result<[String:Any],Error>)->Void)throws->AsterAsyncJob {
    _=try axisObject(engine,"nativeComparisonDemo")
    _=try nativeComparisonAction(engine,"drawing",width:width,height:height)
    let hostSaved=try nativeComparisonAction(engine,"save",width:width,height:height)["savedDocument"] as! String,originalContext=ObjectIdentifier(engine.context)
    return try engine.applyDataEventAsync(["kind":"correction","bar":["time":1700000000000.0,"open":100.0,"high":106.0,"low":99.0,"close":105.0,"volume":1000.0]],timeout:5){result in
        do{
            _=try result.get();var checks:[String]=[]
            func require(_ value:Bool,_ text:String)throws{guard value else{throw AsterError.javaScript("Native axes: \(text)")};checks.append(text)}
            try require(Thread.isMainThread&&ObjectIdentifier(engine.context) != originalContext,"Comparison correction hands off isolated context on owner")
            _=try nativeComparisonAction(engine,"series",width:width,height:height);_=try nativeComparisonAction(engine,"series",width:width,height:height)
            _=try nativeComparisonAction(engine,"load",width:width,height:height,saved:hostSaved)
            try require(try engine.saveDrawings()==hostSaved,"Host saved B document loads after context replacement")
            let point=try nativeAxisPoint(engine,index:2,width:width,height:height)
            _=try engine.call("nativeResize",[width,height]);_=try engine.call("nativePointer",["move",0,point["x"]!,point["y"]!])
            let reading=try axisReading(nativeComparisonPacket(engine,width:width,height:height))
            try require(try axisSeries(reading)["value"] as? Double==2020,"Reconnected B values survive context replacement")
            _=try axisObject(engine,"nativeComparisonDemo")
            completion(.success(["passed":checks.count,"checks":checks,"asyncContextHandoff":true]))
        }catch{completion(.failure(error))}
    }
}
func nativeAxesCombinedReport(_ base:[String:Any],_ handoff:[String:Any])->[String:Any] {
    var report=base;report["passed"]=(base["passed"] as! Int)+(handoff["passed"] as! Int);report["checks"]=(base["checks"] as! [String])+(handoff["checks"] as! [String]);report["asyncContextHandoff"]=true;return report
}
