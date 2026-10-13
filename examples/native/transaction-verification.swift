import Foundation
import JavaScriptCore

/// Only this fixture evaluates trusted, fixed probes. Production input remains
/// the public Swift command facade and nativePointer bridge; no user source is
/// evaluated. State probes preserve rollback/history/input for atomic checks.
private func transactionProbe(_ engine:AsterEngine,_ source:String)throws->JSValue {
    guard let value=engine.context.evaluateScript(source) else{throw AsterError.javaScript("Transaction probe failed")}
    if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Transaction probe exception")}
    return value
}
private func transactionState(_ engine:AsterEngine)throws->[String:Any] {
    let source="(()=>{const d=nativeModel.drawings;return {items:d.items,transaction:d.transaction,undo:d.undoStack,redo:d.redoStack,gesture:nativeInput.gesture,pointers:[...nativeInput.pointers],selected:d.selected,target:nativeInput.drawingTarget,axes:nativeModel.axes,panels:nativeModel.panels,view:nativeModel.view,follow:nativeModel.follow,crosshair:nativeModel.crosshair};})()"
    guard let value=try transactionProbe(engine,source).toDictionary() as? [String:Any] else{throw AsterError.invalidScene};return value
}
private func transactionJSON(_ state:[String:Any])throws->Data {try JSONSerialization.data(withJSONObject:state,options:[.sortedKeys])}
private let transactionTime=1700000000000.0
private func transactionAnchor(_ price:Double)->[String:Double] {["time":transactionTime+120000,"price":price]}
private func transactionPoint(_ engine:AsterEngine,axis:String="A",price:Double=3000,width:Double,height:Double)throws->(Double,Double) {
    guard ["A","B","C"].contains(axis),price.isFinite,width.isFinite,height.isFinite,width>=100,height>=80,width<=8192,height<=8192 else{throw AsterError.invalidScene}
    let expression="Aster.createLayout(nativeModel,\(width),\(height)).toScreen({time:1700000120000,price:\(price)},'price','\(axis)')"
    guard let p=try transactionProbe(engine,expression).toDictionary() as? [String:Double],let x=p["x"],let y=p["y"],x.isFinite,y.isFinite else{throw AsterError.invalidScene};return(x,y)
}
private func transactionSetup(_ engine:AsterEngine,width:Double,height:Double)throws {
    let options:[String:Any]=["panels":[["id":"price","range":[80,120],"padding":0],["id":"other","range":[0,100],"axisSide":"left"]],"axes":[["id":"A","panel":"price","range":[1000,5000],"padding":0],["id":"B","panel":"price","range":[0,100],"padding":0]],"series":[]]
    _=try engine.call("nativeInit",[0,options])
    let bars=(0..<12).map{i in ["time":transactionTime+Double(i)*60000,"open":100.0,"high":120.0,"low":90.0,"close":110.0,"volume":1.0]}
    _=try engine.command("setData",[bars]);_=try engine.command("setVisibleRange",[0,12]);_=try engine.call("nativeResize",[width,height])
    _=try engine.command("addDrawing",[["id":"d","type":"horizontal","panel":"price","axisId":"A","points":[transactionAnchor(3000)]]])
    _=try transactionProbe(engine,"nativeModel.drawings.undoStack=[];nativeModel.drawings.redoStack=[];true")
}
private func transactionDrawing(_ state:[String:Any])->[String:Any] {(state["items"] as! [[String:Any]])[0]}
private func transactionPrice(_ state:[String:Any])->Double {(transactionDrawing(state)["points"] as! [[String:Any]])[0]["price"] as! Double}
private func transactionIdle(_ state:[String:Any])->Bool {state["gesture"] is NSNull && state["transaction"] is NSNull && (state["pointers"] as! [Any]).isEmpty}

/// AppKit passes real NSView event handlers; UIKit explicitly passes the
/// programmatic nativePointer controller because public UITouch construction
/// is unavailable. The report records that distinction instead of certifying
/// system/physical touch input.
func verifyNativeTransactions(_ engine:AsterEngine,width:Double,height:Double,inputKind:String,send:(String,Double,Double)throws->Void)throws->[String:Any] {
    var checks:[String]=[],cases:[String]=[]
    func require(_ value:Bool,_ label:String)throws {guard value else{throw AsterError.javaScript("Native transaction: \(label)")};checks.append(label)}
    func start(_ label:String)throws->(Double,Double) {
        cases.append(label);try transactionSetup(engine,width:width,height:height);let p=try transactionPoint(engine,width:width,height:height);try send("down",p.0,p.1)
        let s=try transactionState(engine);try require((s["gesture"] as? [String:Any])?["kind"] as? String=="edit" && !(s["transaction"] is NSNull),label+" starts actual controller edit");return p
    }
    func rejects(_ label:String,_ action:()throws->Void)throws {
        let before=try transactionJSON(transactionState(engine)),revision=engine.revision;var notifications=0,rejected=false
        let observer=try engine.observeChanges{notifications+=1};defer{try? engine.removeObserver(observer)}
        do{try action()}catch{rejected=true}
        try require(rejected && before==transactionJSON(transactionState(engine)) && revision==engine.revision && notifications==0,label+" rejects atomically with unchanged revision/observers")
    }

    let p=try start("public rebind");try send("move",p.0,p.1+10)
    try require(abs(try transactionPrice(transactionState(engine))-3000)>1,"live A drag changes raw A price")
    _=try engine.command("editDrawing",["d",["axisId":"B","points":[transactionAnchor(50)]]])
    var state=try transactionState(engine)
    try require(transactionIdle(state)&&transactionDrawing(state)["axisId"] as? String=="B"&&transactionPrice(state)==50,"valid A3000 to B50 rebind ends pointer/rollback transaction")
    try send("move",p.0,p.1);try send("cancel",0,0);state=try transactionState(engine)
    try require(transactionDrawing(state)["axisId"] as? String=="B"&&transactionPrice(state)==50&&(state["undo"] as! [Any]).count==1,"old pointer/cancel cannot erase independent B rebind")
    _=try engine.command("undo");state=try transactionState(engine);try require(transactionDrawing(state)["axisId"] as? String=="A"&&transactionPrice(state)==3000,"rebind undo restores A3000")
    _=try engine.command("redo");state=try transactionState(engine);try require(transactionDrawing(state)["axisId"] as? String=="B"&&transactionPrice(state)==50,"rebind redo restores B50")
    try rejects("referenced history axis removal"){_=try engine.command("removeAxis",["A"])}
    let saved=try engine.saveDrawings();try engine.loadDrawings(saved);try require(try engine.saveDrawings()==saved,"committed bound v2 document remains loadable")

    let invalid:[(String,[String:Any])]=[("missing binding",["axisId":"missing"]),("invalid anchor",["axisId":"B","points":[transactionAnchor(.nan)]]),("invalid style",["axisId":"B","style":["width":99]]),("invalid type",["type":"rectangle"])]
    for (label,patch) in invalid {
        let q=try start(label);try send("move",q.0,q.1+8);try rejects(label){_=try engine.command("editDrawing",["d",patch])}
        try send("move",q.0,q.1);try require((try transactionState(engine)["gesture"] as? [String:Any])?["kind"] as? String=="edit",label+" retains usable old pointer")
        try send("cancel",0,0);let s=try transactionState(engine);try require(transactionPrice(s)==3000&&(s["undo"] as! [Any]).isEmpty,label+" cancel restores original anchor/history")
    }

    cases.append("rollback-only axis reference");try transactionSetup(engine,width:width,height:height)
    _=try transactionProbe(engine,"nativeModel.drawings.begin();nativeModel.drawings.edit('d',{axisId:'B',points:[{time:1700000120000,price:50}]});true")
    try rejects("rollback-only A axis removal"){_=try engine.command("removeAxis",["A"])}
    try rejects("rollback-only A projection"){_=try engine.command("setAxis",["A",["range":[0,100]]])}
    _=try transactionProbe(engine,"nativeModel.drawings.cancel();true")
    try require(try transactionPrice(transactionState(engine))==3000,"low-level rollback restores referenced A axis/anchor")

    let projectionPoint=try start("affected projections")
    try rejects("active A range"){_=try engine.command("setAxis",["A",["range":[0,100]]])}
    try rejects("active A visibility"){_=try engine.command("setAxis",["A",["visible":false]])}
    try rejects("active price panel padding"){_=try engine.command("setPanel",["price",["padding":0.2]])}
    try rejects("other panel reflow weight"){_=try engine.command("setPanel",["other",["weight":5]])}
    let marginMutations:[(String,()throws->Void)]=[
        ("unreferenced B width",{_=try engine.command("setAxis",["B",["width":123]])}),
        ("unreferenced B side",{_=try engine.command("setAxis",["B",["side":"left"]])}),
        ("unreferenced B visibility",{_=try engine.command("setAxis",["B",["visible":false]])}),
        ("unreferenced B removal",{_=try engine.command("removeAxis",["B"])}),
        ("new axis addition",{_=try engine.command("addAxis",[["id":"C","panel":"price","range":[10,20]]])}),
        ("other panel axis visibility",{_=try engine.command("setPanel",["other",["axisVisible":false]])})]
    for(label,mutation) in marginMutations {
        try rejects(label,mutation);try send("move",projectionPoint.0,projectionPoint.1)
        let s=try transactionState(engine),anchor=(transactionDrawing(s)["points"] as! [[String:Any]])[0]
        try require(anchor["time"] as? Double==1700000120000&&abs(transactionPrice(s)-3000)<1e-8&&(s["gesture"] as? [String:Any])?["kind"] as? String=="edit",label+" preserves same pointer raw time/price")
    }
    _=try engine.command("setAxis",["A",["precision":7,"label":"Active A"]]);_=try engine.command("setAxis",["B",["range":[0,200]]])
    state=try transactionState(engine);try require((state["gesture"] as? [String:Any])?["kind"] as? String=="edit"&&state["selected"] as? String=="d"&&(state["pointers"] as! [Any]).count==1,"nonprojection labels/unrelated B range mutation retain active A edit")
    try send("cancel",0,0);try require(try transactionPrice(transactionState(engine))==3000,"unrelated mutation cancellation retains A3000")

    let viewportPoint=try start("external viewport");try send("move",viewportPoint.0,viewportPoint.1+8)
    let previousView=try transactionJSON(["view":transactionState(engine)["view"]!]);_=try engine.command("zoom",[0.9])
    let zoomedView=try transactionJSON(["view":transactionState(engine)["view"]!])
    try require(previousView != zoomedView&&(try transactionState(engine)["gesture"] as? [String:Any])?["kind"] as? String=="edit","external API zoom remains allowed before next pointer")
    try send("move",viewportPoint.0,viewportPoint.1);state=try transactionState(engine)
    let restored=(transactionDrawing(state)["points"] as! [[String:Any]])[0]
    try require(transactionIdle(state)&&restored["time"] as? Double==1700000120000&&abs(transactionPrice(state)-3000)<1e-8,"changed projection cancels old pointer and restores committed time/price")
    try require(zoomedView==transactionJSON(["view":state["view"]!]),"projection cancellation preserves requested new viewport")
    try require((state["undo"] as! [Any]).isEmpty,"projection cancellation creates no undo step")

    let stylePoint=try start("external style");try send("move",stylePoint.0,stylePoint.1+8);_=try engine.command("editDrawing",["d",["style":["color":"#123456"]]])
    try send("move",stylePoint.0,stylePoint.1+12);try send("cancel",0,0);state=try transactionState(engine)
    try require(transactionIdle(state)&&transactionPrice(state)==3000&&(transactionDrawing(state)["style"] as! [String:Any])["color"] as? String=="#123456ff"&&(state["undo"] as! [Any]).count==1,"external style is independent of old pointer/cancel")

    let addPoint=try start("independent add");try send("move",addPoint.0,addPoint.1+8)
    _=try engine.command("addDrawing",[["id":"new","type":"horizontal","panel":"price","axisId":"B","points":[transactionAnchor(50)]]]);try send("cancel",0,0);state=try transactionState(engine)
    try require((state["items"] as! [[String:Any]]).map{$0["id"] as! String}==["d","new"]&&transactionPrice(state)==3000&&(state["undo"] as! [Any]).count==1,"add during edit commits separately from pointer rollback")
    _=try engine.command("undo");try require((try transactionState(engine)["items"] as! [Any]).count==1,"independent add undo retains original drawing")

    _=try start("missing delete");let unchanged=try transactionJSON(transactionState(engine));let removed=try engine.command("deleteDrawing",["missing"]).toBool()
    try require(!removed&&unchanged==transactionJSON(transactionState(engine)),"missing delete does not cancel another active edit");try send("cancel",0,0)

    cases.append("tentative creation");try transactionSetup(engine,width:width,height:height);_=try engine.command("setTool",["horizontal"]);_=try engine.command("setDrawingTarget",[["panel":"price","axisId":"B"]])
    let createPoint=try transactionPoint(engine,axis:"B",price:50,width:width,height:height);try send("down",createPoint.0,createPoint.1)
    let tentative=((try transactionState(engine)["gesture"] as! [String:Any])["id"] as! String)
    try rejects("uncommitted creation edit"){_=try engine.command("editDrawing",[tentative,["axisId":"A","points":[transactionAnchor(3000)]]])}
    let deleted=try engine.command("deleteDrawing",[tentative]).toBool();state=try transactionState(engine)
    try require(!deleted&&transactionIdle(state)&&(state["items"] as! [Any]).count==1,"explicit tentative delete cancels creation without history")

    let rawPoint=try start("low-level binding change")
    _=try transactionProbe(engine,"nativeModel.drawings.edit('d',{axisId:'B',points:[{time:1700000120000,price:50}]});true")
    try send("move",rawPoint.0,rawPoint.1);state=try transactionState(engine)
    try require(transactionIdle(state)&&transactionDrawing(state)["axisId"] as? String=="A"&&transactionPrice(state)==3000,"low-level binding mismatch cannot reuse cached pointer coordinates")

    cases.append("explicit manual group");try transactionSetup(engine,width:width,height:height);_=try transactionProbe(engine,"nativeModel.drawings.begin();true")
    _=try engine.command("editDrawing",["d",["points":[transactionAnchor(3100)]]]);_=try engine.command("editDrawing",["d",["style":["color":"#123456"]]])
    state=try transactionState(engine);try require(!(state["transaction"] is NSNull)&&(state["undo"] as! [Any]).isEmpty,"nonpointer explicit transaction retains API grouping")
    _=try transactionProbe(engine,"nativeModel.drawings.commit();true");_=try engine.command("undo");try require(try transactionPrice(transactionState(engine))==3000,"manual grouped undo restores A3000")
    _=try engine.command("redo");try require(try transactionPrice(transactionState(engine))==3100,"manual grouped redo restores A3100")

    cases.append("unrelated target");try transactionSetup(engine,width:width,height:height)
    _=try engine.command("addAxis",[["id":"C","panel":"price","range":[10,20],"padding":0]]);_=try engine.command("addSeries",[["id":"b-series","type":"line","panel":"price","axisId":"B"]]);_=try engine.command("setDrawingTarget",[["panel":"price","axisId":"C"]])
    let targetPoint=try transactionPoint(engine,width:width,height:height);try send("down",targetPoint.0,targetPoint.1)
    _=try engine.command("removeSeries",["b-series"]);state=try transactionState(engine)
    try require((state["target"] as? [String:Any])?["axisId"] as? String=="C"&&(state["gesture"] as? [String:Any])?["kind"] as? String=="edit"&&state["selected"] as? String=="d","unrelated B series removal retains C target and active A selection")
    try rejects("C target active A margin removal"){_=try engine.command("removeAxis",["B"])}
    try send("cancel",0,0);_=try engine.command("removeAxis",["B"])
    try require((try transactionState(engine)["target"] as? [String:Any])?["axisId"] as? String=="C","inactive unrelated B axis removal retains C target")
    _=try engine.command("addAxis",[["id":"B","panel":"price","range":[0,100],"padding":0]]);_=try engine.command("addSeries",[["id":"b-series","type":"line","panel":"price","axisId":"B"]])
    try require((try transactionState(engine)["target"] as? [String:Any])?["axisId"] as? String=="C","B restoration does not replace C target")
    _=try engine.command("setTool",["horizontal"]);let c=try transactionPoint(engine,axis:"C",price:15,width:width,height:height);try send("down",c.0,c.1);try send("up",c.0,c.1)
    let latest=(try transactionState(engine)["items"] as! [[String:Any]]).last!
    try require(latest["axisId"] as? String=="C"&&abs((latest["points"] as! [[String:Any]])[0]["price"] as! Double - 15)<1e-8,"future native drawing uses preserved C raw domain")
    cases.append("comparison demo target")
    let demo=try verifyNativeComparisonTargetPolicy(engine,width:width,height:height,send:send);checks.append(contentsOf:demo["checks"] as! [String])
    return ["passed":checks.count,"checks":checks,"cases":cases,"inputKind":inputKind,"runtime":"JavaScriptCore","nativeUITouchInjected":false,"physicalDevice":false]
}

func verifyNativeComparisonTargetPolicy(_ engine:AsterEngine,width:Double,height:Double,send:(String,Double,Double)throws->Void)throws->[String:Any] {
    var checks:[String]=[]
    func check(_ value:Bool,_ label:String)throws{guard value else{throw AsterError.javaScript("Native transaction: \(label)")};checks.append(label)}
    _=try engine.call("nativeComparisonDemo");_=try engine.command("addAxis",[["id":"C","panel":"price","range":[10,20],"padding":0]])
    _=try engine.command("setDrawingTarget",[["panel":"price","axisId":"C"]]);_=try engine.call("nativeComparisonAction",["series",width,height])
    try check((try transactionState(engine)["target"] as? [String:Any])?["axisId"] as? String=="C","comparison helper removes B without replacing C target")
    _=try engine.call("nativeComparisonAction",["series",width,height])
    try check((try transactionState(engine)["target"] as? [String:Any])?["axisId"] as? String=="C","comparison helper restores B without replacing C target")
    _=try engine.command("setTool",["horizontal"]);let c=try transactionPoint(engine,axis:"C",price:15,width:width,height:height);try send("down",c.0,c.1);try send("up",c.0,c.1)
    let drawing=(try transactionState(engine)["items"] as! [[String:Any]]).last!
    try check(drawing["axisId"] as? String=="C"&&abs((drawing["points"] as! [[String:Any]])[0]["price"] as! Double - 15)<1e-8,"comparison helper preserves future C raw15 native drawing")
    _=try engine.command("setDrawingTarget",[["panel":"price","seriesId":"comparison-B-line"]]);_=try engine.call("nativeComparisonAction",["series",width,height])
    try check(try transactionState(engine)["target"] is NSNull,"comparison helper active B removal falls back to primary")
    _=try engine.call("nativeComparisonAction",["series",width,height])
    try check(try transactionState(engine)["target"] is NSNull,"comparison helper B restore preserves primary fallback")
    return ["passed":checks.count,"checks":checks]
}

func verifyNativeTransactionControls(_ engine:AsterEngine,width:Double,height:Double,send:(String,Double,Double)throws->Void,perform:(String)throws->Void)throws->[String:Any] {
    var checks:[String]=[]
    func check(_ value:Bool,_ label:String)throws{guard value else{throw AsterError.javaScript("Native transaction controls: \(label)")};checks.append(label)}
    try transactionSetup(engine,width:width,height:height);let p=try transactionPoint(engine,width:width,height:height)
    try send("down",p.0,p.1);try send("move",p.0,p.1+10);try perform("rebind")
    var state=try transactionState(engine)
    try check(transactionIdle(state)&&transactionDrawing(state)["axisId"] as? String=="B"&&transactionPrice(state)==50,"native Rebind B control ends active A edit at B50")
    try send("move",p.0,p.1);try send("cancel",0,0);let saved=try engine.saveDrawings()
    try check(try transactionPrice(transactionState(engine))==50,"native control result survives old input/cancel")
    try perform("undo");state=try transactionState(engine);try check(transactionDrawing(state)["axisId"] as? String=="A"&&transactionPrice(state)==3000,"native Undo control restores A3000")
    try perform("redo");state=try transactionState(engine);try check(transactionDrawing(state)["axisId"] as? String=="B"&&transactionPrice(state)==50&&saved==engine.saveDrawings(),"native Redo control restores exact B50 bound document")
    return ["passed":checks.count,"checks":checks,"uiControlActions":true]
}

func verifyTransactionCommonAPI(_ engine:AsterEngine)throws->[String:Any] {
    var result=try verifyCommonAPI(engine);let small=try nativeTextInk("12px monospace"),large=try nativeTextInk("bold 36px monospace")
    guard large>small*2 else{throw AsterError.javaScript("Common API native font sizing regression")}
    var checks=result["checks"] as! [String];checks.append("Native font size changes raster coverage");result["checks"]=checks;result["passed"]=checks.count;result["fontSmallInk"]=small;result["fontLargeInk"]=large;return result
}
