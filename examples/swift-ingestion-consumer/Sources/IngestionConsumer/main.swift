import Foundation
import AsterNative

// An independent public SwiftPM client: no SDK sources, private globals or raw
// context access. Optional URL selects the separately compiled local resource.
var checks=[String]()
enum ConsumerError:Error{case failed(String)}
func check(_ condition:Bool,_ message:String)throws{guard condition else{throw ConsumerError.failed(message)};checks.append(message)}
func event(_ kind:String,_ index:Int,_ close:Double)->[String:Any]{["kind":kind,"bar":["time":1700000000000.0+Double(index)*60000,"open":close,"high":close+1,"low":close-1,"close":close,"volume":Double(index+1)]]}
func ledger(_ stats:[String:Any])->Bool{(stats["accepted"] as! Int)==(stats["applied"] as! Int)+(stats["cancelled"] as! Int)+(stats["pendingEvents"] as! Int)&&(stats["pendingBytes"] as! Int)==49*(stats["pendingEvents"] as! Int)}
do{
    let resource=CommandLine.arguments.dropFirst().first.map{URL(fileURLWithPath:$0)},source:AsterEngine
    if let resource=resource{source=try AsterEngine(bundleURL:resource,count:0,options:["series":[]])}else{source=try AsterEngine(count:0,options:["series":[]])};defer{try? source.close()}
    try check(Thread.isMainThread,"Public client starts on main owner")
    let bars=(0..<8).map{i -> AsterBar in let close=Double(i)+100;return AsterBar(time:1700000000000.0+Double(i)*60000,open:close,high:close+1,low:close-1,close:close,volume:Double(i+1))};try source.setData(bars)
    let module=try source.registerIndicatorModule(resource==nil ? "aster.volume-direction":"local.volume-balance",version:1)[0];_=try source.addIndicator("consumer-module",module,resource==nil ? ["factor":1,"shift":0]:["period":2,"shift":0]);_=try source.addIndicator("ema","ema",["period":3])
    let batch=try source.applyDataEvents([event("update",7,110)]);try check(batch["events"] as? Int==1&&batch["appended"] as? Int==0,"Named atomic burst publishes one valid update")
    let policy:[String:Any]=["streamId":"spm-ingestion","generation":3,"firstSequence":20,"maxQueuedEvents":4,"maxQueuedBytes":196,"maxBatchEvents":2,"maxStoredBars":16,"maxStoreBytes":96*1024]
    let configured=try source.configureDataIngestion(policy);try check(configured["state"] as? String=="running"&&ledger(configured),"Named configuration starts bounded conserved session")
    let caller=NSMutableDictionary(dictionary:event("update",7,111)["bar"] as! [String:Any]);let admitted=try source.enqueueDataEvents(["streamId":"spm-ingestion","generation":3,"firstSequence":20,"events":[["kind":"update","bar":caller],event("append",8,112)]])
    caller["close"]=999.0;caller["high"]=1000.0;try check(admitted["events"] as? Int==2&&admitted["pendingBytes"] as? Int==98,"Whole packet owns its six-column input")
    let document=try source.saveDataIngestion();let cancelled=try source.cancelDataEvents();try check(cancelled["events"] as? Int==2&&cancelled["firstSequence"] as? Int==20&&cancelled["lastSequence"] as? Int==21,"Named cancellation accounts exact accepted sequence")
    _=try source.pauseDataIngestion();var paused=false;do{_=try source.enqueueDataEvents(["streamId":"spm-ingestion","generation":3,"firstSequence":22,"events":[event("update",7,113)]])}catch let error as AsterIngestionError{paused=error.code=="PAUSED" && !error.message.isEmpty};try check(paused,"Public typed IngestionError preserves stable code/message");_=try source.resumeDataIngestion()
    let restored=try source.loadDataIngestion(document);try check(restored["pendingEvents"] as? Int==2&&restored["nextSequence"] as? Int==22&&restored["cancelled"] as? Int==0&&ledger(restored),"Pending save/restore preserves cursor and owned ledger")
    let drain=try source.drainDataEvents(1),last=try source.command("inspect").forProperty("lastBar").toDictionary()!
    try check(drain["events"] as? Int==1&&drain["firstSequence"] as? Int==20&&last["close"] as? Double==111,"Partial prefix applies immutable value despite caller mutation")
    _=try source.cancelDataEvents();let before=try source.dataIngestionStats();try check(before["accepted"] as? Int==2&&before["applied"] as? Int==1&&before["cancelled"] as? Int==1&&ledger(before),"Cancelled suffix conserves final empty session")
    var callbacks=0;let observer=try source.observeChanges{callbacks+=1},revision=source.revision;_=try source.dataIngestionStats();_=try source.saveDataIngestion();try source.removeObserver(observer);try check(callbacks==0&&revision==source.revision,"Named stats/save remain public read-only calls")
    var result:Result<AsterAsyncMetrics,Error>?,terminals=0,owner=true
    let handle=try source.applyDataEventAsync(event("correction",0,140),progress:{_ in owner=owner&&Thread.isMainThread}){value in terminals+=1;owner=owner&&Thread.isMainThread;result=value}
    var busy=false;do{_=try source.pauseDataIngestion()}catch let error as AsterIngestionError{busy=error.code=="BUSY"};try check(busy&&result==nil,"Returned async handle owns deferred ingestion BUSY gap")
    let until=ProcessInfo.processInfo.systemUptime+30;while result==nil&&ProcessInfo.processInfo.systemUptime<until{_=RunLoop.current.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))};guard let result=result else{throw ConsumerError.failed("Async completion timeout")};_=try result.get();_=handle
    let after=try source.dataIngestionStats();try check(owner&&terminals==1&&after["state"] as? String=="running"&&after["nextSequence"] as? Int==22&&ledger(after),"One original-owner VM handoff preserves policy/cursors/counters")
    let beforePolicy=try JSONSerialization.data(withJSONObject:before["policy"]!,options:[.sortedKeys]),afterPolicy=try JSONSerialization.data(withJSONObject:after["policy"]!,options:[.sortedKeys]);try check(beforePolicy==afterPolicy&&after["accepted"] as? Int==2&&after["applied"] as? Int==1&&after["cancelled"] as? Int==1,"Handoff retains exact bounded policy and accepted payload accounting")
    let values=try source.command("indicatorValues",["ema","value"]).toArray()!;try check(abs((values[2] as! Double)-(140+101+102)/3.0)<1e-12,"Worker correction keeps independently expected EMA seed")
    try source.close();var closed=false;do{_=try source.dataIngestionStats()}catch AsterAsyncError.engineClosed{closed=true};try check(closed,"Public named queue read retains closed-engine priority")
    let report:[String:Any]=["schema":"aster.swiftpm.ingestion-consumer","passed":checks.count,"checks":checks,"module":module,"localResource":resource != nil,"sdkSourcesInClient":false,"privateContextAccess":false,"session":after,"scope":"Independent public SwiftPM import/named ingestion/actual isolated JSC worker; no UI or performance measurement"]
    print(String(data:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
}catch{fputs("Ingestion consumer failed: \(error)\n",stderr);exit(1)}
