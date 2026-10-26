import Foundation
import JavaScriptCore

/// Actual public Swift/JSC command and observer behavior; no device/UI claim.
func verifyNativeLayoutNotifications(_ bundleURL:URL)throws->[String:Any] {
    let engine=try AsterEngine(bundleURL:bundleURL,count:64,options:["panels":[["id":"price","weight":3],["id":"osc","weight":1]],"series":[]])
    defer {try? engine.close()}
    _=try engine.command("addIndicator",["rsi","rsi",["period":4]])
    _=try engine.command("addSeries",[["id":"rsi-line","type":"line","panel":"osc","indicator":"rsi"]])
    var callbacks=0,checks:[String]=[],failures:[String]=[]
    let token=try engine.observeChanges{callbacks+=1}
    defer {try? engine.removeObserver(token)}
    func require(_ ok:Bool,_ name:String){if ok{checks.append(name)}else{failures.append(name)}}
    func perform(_ operation:String,_ arguments:[Any],changed:Bool,_ name:String)throws->JSValue {
        let beforeCallbacks=callbacks,beforeRevision=engine.revision
        let result=try engine.command(operation,arguments)
        require(callbacks==beforeCallbacks+(changed ? 1:0) && engine.revision==beforeRevision+(changed ? 1:0),name)
        return result
    }
    let sameOrder=try perform("setPanelOrder",[["price","osc"]],changed:false,"same panel order does not notify")
    require(sameOrder.isBoolean && !sameOrder.toBool(),"same panel order returns false")
    let newOrder=try perform("setPanelOrder",[["osc","price"]],changed:true,"changed panel order notifies once")
    require(newOrder.isBoolean && newOrder.toBool(),"changed panel order returns true")
    _=try perform("setPanelOrder",[["osc","price"]],changed:false,"repeated changed order becomes a silent no-op")
    let samePlacement=try perform("setIndicatorPlacement",["rsi",["panel":"osc","axisId":NSNull()]],changed:false,"same study placement does not notify")
    require(samePlacement.forProperty("changed")?.toInt32()==0,"same study placement returns zero")
    let moved=try perform("setIndicatorPlacement",["rsi",["panel":"price","axisId":NSNull()]],changed:true,"changed study placement notifies once")
    require(moved.forProperty("changed")?.toInt32()==1,"changed study placement reports its output")
    _=try perform("setIndicatorPlacement",["rsi",["panel":"price","axisId":NSNull()]],changed:false,"repeated study placement is silent")
    let beforeCallbacks=callbacks,beforeRevision=engine.revision
    var rejected=false
    do{_=try engine.command("setIndicatorPlacement",["rsi",["panel":"missing","axisId":NSNull()]])}catch{rejected=true}
    require(rejected && callbacks==beforeCallbacks && engine.revision==beforeRevision,"rejected placement does not notify")
    return ["schema":"barochart.native-layout-notifications","passed":checks.count,"checks":checks,"failures":failures,"failed":!failures.isEmpty,"callbacks":callbacks,"boundary":"Actual public Swift SDK and macOS JavaScriptCore; owner-thread observer/revision contract; no Android/JNI, UI or device evidence"]
}
