import Foundation
import JavaScriptCore

private let ingestionNames=["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]
private let ingestionFields=["time","open","high","low","close","volume"]
private func ingestionJSON(_ value:Any)throws->String {String(data:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]),encoding:.utf8)!}
private func ingestionObject(_ engine:AsterEngine,_ operation:String,_ args:[Any]=[])throws->[String:Any] {
    switch operation {
    case "applyDataEvents": return try engine.applyDataEvents(args[0] as! [[String:Any]])
    case "configureDataIngestion": return try engine.configureDataIngestion(args[0] as! [String:Any])
    case "enqueueDataEvents": return try engine.enqueueDataEvents(args[0] as! [String:Any])
    case "drainDataEvents": return try engine.drainDataEvents(args.first as? Int)
    case "pauseDataIngestion": return try engine.pauseDataIngestion()
    case "resumeDataIngestion": return try engine.resumeDataIngestion()
    case "cancelDataEvents": return try engine.cancelDataEvents()
    case "loadDataIngestion": return try engine.loadDataIngestion(args[0] as! String)
    case "dataIngestionStats": return try engine.dataIngestionStats()
    default: throw AsterError.javaScript("Unknown fixture operation "+operation)
    }
}
private func ingestionRead(_ engine:AsterEngine,_ expression:String)throws->JSValue {
    guard let value=engine.context.evaluateScript(expression) else{throw AsterError.invalidScene};if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Ingestion fixture")};return value
}
private func ingestionBytes(_ engine:AsterEngine,_ value:JSValue,_ count:Int)throws->Data {
    var error:JSValueRef?;let context=engine.context.jsGlobalContextRef!
    guard count>0,count<=262144,JSValueGetTypedArrayType(context,value.jsValueRef,&error)==kJSTypedArrayTypeFloat64Array,let object=JSValueToObject(context,value.jsValueRef,&error) else{throw AsterError.invalidScene}
    let n=JSObjectGetTypedArrayLength(context,object,&error),size=JSObjectGetTypedArrayByteLength(context,object,&error),at=JSObjectGetTypedArrayByteOffset(context,object,&error)
    guard let buffer=JSObjectGetTypedArrayBuffer(context,object,&error) else{throw AsterError.invalidScene};let capacity=JSObjectGetArrayBufferByteLength(context,buffer,&error)
    guard error==nil,n==count,size==count*8,at<=capacity,size<=capacity-at,at%8==0 else{throw AsterError.invalidScene}
    guard let base=JSObjectGetTypedArrayBytesPtr(context,object,&error),error==nil else{throw AsterError.invalidScene}
    // No JavaScriptCore calls after acquiring the temporary backing pointer.
    return Data(bytes:base.advanced(by:at),count:size)
}
private func ingestionConfigured(_ url:URL,_ count:Int)throws->AsterEngine {
    let engine=try AsterEngine(bundleURL:url,count:count,options:["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]])
    for name in ingestionNames{_=try engine.call("nativeIndicator",[name,name,[:],"price"])};return engine
}
private func ingestionFullEqual(_ a:AsterEngine,_ b:AsterEngine,_ count:Int)throws->Int {
    var vectors=0
    for field in ingestionFields{for at in stride(from:0,to:count,by:4096){let n=min(4096,count-at),expression="nativeModel.store.columns[\(try ingestionJSON(field))].subarray(\(at),\(at+n))"
        let av=try ingestionRead(a,expression),bv=try ingestionRead(b,expression);guard try ingestionBytes(a,av,n)==ingestionBytes(b,bv,n) else{throw AsterError.javaScript("Column bytes "+field+" at \(at)")}
    }}
    for id in ingestionNames{guard let outputs=try ingestionRead(a,"Object.keys(nativeModel.indicators.get(\(try ingestionJSON(id))).outputs)").toArray() as? [String] else{throw AsterError.invalidScene}
        for output in outputs{vectors+=1;for at in stride(from:0,to:count,by:4096){let n=min(4096,count-at),av=try a.call("nativeIndicatorBuffer",[id,output,at,n]),bv=try b.call("nativeIndicatorBuffer",[id,output,at,n]);guard try ingestionBytes(a,av,n)==ingestionBytes(b,bv,n) else{throw AsterError.javaScript("Vector bytes \(id).\(output) at \(at)")}}}
    };return vectors
}
private func ingestionBar(_ index:Int,_ close:Double)->[String:Any] {["time":1700000000000.0+Double(index)*60000,"open":close,"high":close+1,"low":close-1,"close":close,"volume":Double(index+100)]}
private func ingestionEvent(_ kind:String,_ index:Int,_ close:Double)->[String:Any] {["kind":kind,"bar":ingestionBar(index,close)]}
private func ingestionLedger(_ stats:[String:Any])->Bool {
    guard let accepted=stats["accepted"] as? Int,let applied=stats["applied"] as? Int,let cancelled=stats["cancelled"] as? Int,let pending=stats["pendingEvents"] as? Int,let bytes=stats["pendingBytes"] as? Int else{return false}
    return accepted==applied+cancelled+pending&&bytes==49*pending
}

/// Test-first facade fixture: its generic-command form compiled and failed on
/// the pinned 0.2.11 core. These final checks use the named Swift facade members.
/// Core/generic data publication and Swift command observer delivery are distinct.
func verifyNativeIngestion(_ url:URL)throws->[String:Any] {
    var checks:[String]=[]
    func require(_ value:Bool,_ reason:String)throws{guard value else{throw AsterError.javaScript("Ingestion: "+reason)};checks.append(reason)}
    let source=try AsterEngine(bundleURL:url,count:8,options:["panels":[["id":"price"]],"series":[]]);defer{try? source.close()}
    let policy:[String:Any]=["streamId":"swift-fixture","generation":7,"firstSequence":40,"maxQueuedEvents":8,"maxQueuedBytes":392,"maxBatchEvents":3,"maxStoredBars":12,"maxStoreBytes":1536]
    let configured=try ingestionObject(source,"configureDataIngestion",[policy])
    try require(configured["state"] as? String=="running"&&ingestionLedger(configured),"Empty session starts with conserved zero ledger")
    let events=[ingestionEvent("update",7,111),ingestionEvent("append",8,112),ingestionEvent("update",8,113)]
    let accepted=try ingestionObject(source,"enqueueDataEvents",[["streamId":"swift-fixture","generation":7,"firstSequence":40,"events":events]])
    try require(accepted["events"] as? Int==3&&accepted["nextSequence"] as? Int==43&&accepted["pendingBytes"] as? Int==147,"Whole owned packet accepts exactly3 events/147 typed bytes")
    let sourceBefore=try ingestionJSON(source.command("inspect").toDictionary()!)
    var rejected=false;do{_=try ingestionObject(source,"enqueueDataEvents",[["streamId":"swift-fixture","generation":7,"firstSequence":40,"events":events]])}catch let error as AsterIngestionError{rejected = !error.code.isEmpty}
    let statsRejected=try ingestionObject(source,"dataIngestionStats")
    try require(rejected&&statsRejected["nextSequence"] as? Int==43&&ingestionLedger(statsRejected),"Duplicate sequence rejects without implicit payload loss")
    try require(try ingestionJSON(source.command("inspect").toDictionary()!)==sourceBefore,"Enqueue/rejection preserves actual data/viewport/drawings")
    let drained=try ingestionObject(source,"drainDataEvents",[2]),afterDrain=try ingestionObject(source,"dataIngestionStats")
    try require(drained["events"] as? Int==2&&drained["appended"] as? Int==1&&drained["firstSequence"] as? Int==40&&drained["lastSequence"] as? Int==41,"Drain receipt reports one atomic prefix and exact source sequence range")
    try require(afterDrain["applied"] as? Int==2&&afterDrain["pendingEvents"] as? Int==1&&ingestionLedger(afterDrain),"Successful drain removes its prefix and conserves queued suffix")
    _=try ingestionObject(source,"pauseDataIngestion");var pausedRejected=false
    do{_=try ingestionObject(source,"enqueueDataEvents",[["streamId":"swift-fixture","generation":7,"firstSequence":43,"events":[ingestionEvent("update",8,114)]]])}catch let error as AsterIngestionError{pausedRejected=error.code=="PAUSED"}
    try require(pausedRejected,"Paused producer packet explicitly rejects")
    _=try ingestionObject(source,"resumeDataIngestion")
    var observed=0;let token=try source.observeChanges{observed+=1},revision=source.revision
    _=try ingestionObject(source,"dataIngestionStats");let saved=try source.saveDataIngestion()
    try source.removeObserver(token)
    try require(observed==0&&revision==source.revision,"Stats/save are read-only for native mutation revision and observers")
    let cancelled=try ingestionObject(source,"cancelDataEvents"),afterCancel=try ingestionObject(source,"dataIngestionStats")
    try require(cancelled["events"] as? Int==1&&cancelled["firstSequence"] as? Int==42&&cancelled["lastSequence"] as? Int==42&&ingestionLedger(afterCancel),"Cancel explicitly accounts for the pending sequence without rewinding accepted cursor")
    _=try ingestionObject(source,"loadDataIngestion",[saved]);let restored=try ingestionObject(source,"dataIngestionStats")
    try require(restored["pendingEvents"] as? Int==1&&restored["nextSequence"] as? Int==43&&ingestionLedger(restored),"Bounded save/load restores pending data and cursor/counters atomically")
    _=try source.cancelDataEvents()
    let beforeBadLoad=try source.saveDataIngestion();var badLoad=false
    do{_=try ingestionObject(source,"loadDataIngestion",["{\"schema\":\"aster.ingestion\",\"version\":999}"])}catch let error as AsterIngestionError{badLoad=error.code=="INVALID_DOCUMENT"}
    let afterBadLoad=try source.saveDataIngestion()
    try require(badLoad&&afterBadLoad==beforeBadLoad,"Malformed restore rejects unchanged active session")
    _=try source.loadDataIngestion(saved);_=try ingestionObject(source,"drainDataEvents");let beforeBadBatch=try ingestionJSON(source.command("inspect").toDictionary()!),badRevision=source.revision;var atomicRejected=false
    do{_=try ingestionObject(source,"applyDataEvents",[[ingestionEvent("update",8,115),ingestionEvent("update",10,116)]])}catch AsterError.javaScript{atomicRejected=true}
    let afterBadBatch=try ingestionJSON(source.command("inspect").toDictionary()!)
    try require(atomicRejected&&source.revision==badRevision&&afterBadBatch==beforeBadBatch,"Invalid intermediate tail event preserves data and native notifications atomically")
    let pendingAgain=[ingestionEvent("update",8,120)]
    _=try ingestionObject(source,"enqueueDataEvents",[["streamId":"swift-fixture","generation":7,"firstSequence":43,"events":pendingAgain]])
    try source.applyDataEvent(ingestionEvent("update",8,121));var sourceRejected=false
    do{_=try source.drainDataEvents()}catch let error as AsterIngestionError{sourceRejected=error.code=="SOURCE_CHANGED"}
    let changed=try ingestionObject(source,"dataIngestionStats")
    try require(sourceRejected&&changed["state"] as? String=="paused"&&(changed["lastError"] as? [String:Any])?["code"] as? String=="SOURCE_CHANGED"&&ingestionLedger(changed),"Legacy source mutation pauses pending ingress without data loss")
    _=try ingestionObject(source,"resumeDataIngestion");_=try ingestionObject(source,"drainDataEvents")
    _=try source.configureDataIngestion(["streamId":"hard-limit","generation":10,"maxQueuedEvents":8,"maxQueuedBytes":49,"maxBatchEvents":3,"maxStoredBars":9,"maxStoreBytes":1536])
    let limitStats=try source.dataIngestionStats();try require(limitStats["ownedBytes"] as? Int==49,"Owned ring allocation respects typed-byte capacity separately from logical pending bytes")
    var queueBudget=false
    do{_=try source.enqueueDataEvents(["streamId":"hard-limit","generation":10,"firstSequence":0,"events":[ingestionEvent("update",8,122),ingestionEvent("append",9,123)]])}catch let error as AsterIngestionError{queueBudget=error.code=="QUEUE_BUDGET"}
    let budgetAfter=try source.dataIngestionStats();try require(queueBudget&&budgetAfter["accepted"] as? Int==0&&budgetAfter["nextSequence"] as? Int==0,"Oversized whole packet rejects with stable QUEUE_BUDGET without advancing cursor")
    _=try source.enqueueDataEvents(["streamId":"hard-limit","generation":10,"firstSequence":0,"events":[ingestionEvent("append",9,123)]])
    let hardBefore=try ingestionJSON(source.command("inspect").toDictionary()!);var failedDrain=false
    do{_=try source.drainDataEvents()}catch let error as AsterIngestionError{failedDrain=error.code=="DRAIN_FAILED"}
    let failedStats=try source.dataIngestionStats(),hardAfter=try ingestionJSON(source.command("inspect").toDictionary()!)
    try require(failedDrain&&hardBefore==hardAfter&&failedStats["pendingEvents"] as? Int==1&&failedStats["failedDrains"] as? Int==1&&failedStats["state"] as? String=="paused"&&ingestionLedger(failedStats),"Finite history admission rejects append, retains complete paused prefix, and never evicts old rows")
    let explicitCancel=try source.cancelDataEvents();_=try source.resumeDataIngestion()
    let afterExplicitCancel=try source.dataIngestionStats()
    try require(explicitCancel["events"] as? Int==1&&ingestionLedger(afterExplicitCancel),"Explicit cancel/resume accounts for failed prefix instead of resetting history")
    let callerBar=NSMutableDictionary(dictionary:ingestionBar(8,124))
    _=try source.enqueueDataEvents(["streamId":"hard-limit","generation":10,"firstSequence":1,"events":[["kind":"update","bar":callerBar]]])
    callerBar["close"]=Double(999);callerBar["high"]=Double(1000)
    _=try source.drainDataEvents();let ownedLast=try source.command("inspect").forProperty("lastBar").toDictionary()!
    let afterOwnedDrain=try source.dataIngestionStats()
    try require(ownedLast["close"] as? Double==124&&ingestionLedger(afterOwnedDrain),"Caller mutation after enqueue cannot alter owned queued OHLCV")
    var callbackArmed=true,callbackSawCommit=false,callbackError:Error?
    let committedObserver=try source.observeChanges{
        guard callbackArmed else{return};callbackArmed=false
        do{let current=try source.dataIngestionStats(),last=try source.command("inspect").forProperty("lastBar").toDictionary()!;callbackSawCommit=current["pendingEvents"] as? Int==0&&last["close"] as? Double==125&&ingestionLedger(current)
            _=try source.enqueueDataEvents(["streamId":"hard-limit","generation":10,"firstSequence":3,"events":[ingestionEvent("update",8,126)]]);_=try source.cancelDataEvents()
        }catch{callbackError=error}
    }
    // Arm only after admission: queue commands use existing Swift mutation
    // notification semantics, while store data publication occurs at drain.
    callbackArmed=false;_=try source.enqueueDataEvents(["streamId":"hard-limit","generation":10,"firstSequence":2,"events":[ingestionEvent("update",8,125)]]);callbackArmed=true
    _=try source.drainDataEvents();try source.removeObserver(committedObserver);if let error=callbackError{throw error}
    let observerLedger=try source.dataIngestionStats();try require(callbackSawCommit&&observerLedger["cancelled"] as? Int==2&&ingestionLedger(observerLedger),"Swift post-commit observer sees dequeued data and safely enqueue/cancels the next payload")
    let vectorSource=try ingestionConfigured(url,512),reference=try ingestionConfigured(url,512);defer{try? vectorSource.close();try? reference.close()}
    for engine in [vectorSource,reference]{try engine.command("setVisibleRange",[7,150]);_=try engine.addDrawing(["id":"ingestion-note","type":"text","points":[["time":1700000060000.0,"price":100.0]],"text":"original"]);try engine.editDrawing("ingestion-note",["text":"edited"]);try engine.undo()}
    let view=try ingestionJSON(vectorSource.command("inspect").forProperty("view").toDictionary()!),drawing=try vectorSource.saveDrawings()
    let batch=[ingestionEvent("correction",0,150),ingestionEvent("update",511,151),ingestionEvent("append",512,152),ingestionEvent("update",512,153),ingestionEvent("append",513,154)]
    let receipt=try ingestionObject(vectorSource,"applyDataEvents",[batch]);for event in batch{try reference.applyDataEvent(event)}
    let outputs=try ingestionFullEqual(vectorSource,reference,514)
    try require(receipt["events"] as? Int==5&&outputs==15,"Atomic append/update/old correction equals scalar full6columns and all15 Float64 output vectors")
    try require(try ingestionJSON(vectorSource.command("inspect").forProperty("view").toDictionary()!)==view,"Non-following viewport survives final-tail publication")
    try require(try vectorSource.saveDrawings()==drawing,"Raw time/price anchors and redo document survive batch")
    try vectorSource.redo();try reference.redo()
    let actualRedo=try vectorSource.saveDrawings(),expectedRedo=try reference.saveDrawings()
    let redoA=try ingestionJSON(JSONSerialization.jsonObject(with:Data(actualRedo.utf8))),redoB=try ingestionJSON(JSONSerialization.jsonObject(with:Data(expectedRedo.utf8)))
    if actualRedo != expectedRedo{print("Independent NSDictionary drawing key order differs; structural equality=\(redoA==redoB)")}
    try require(redoA==redoB,"Redo restores exact raw drawing document after ingestion")
    return ["schema":"aster.native.ingestion","passed":checks.count,"checks":checks,"fullColumns":6,"fullOutputVectors":outputs,"vectorBars":514,"receipt":receipt,"ledger":try ingestionObject(source,"dataIngestionStats"),"scope":"Actual JavaScriptCore generic/typed Swift facade; no OS input or performance measurement"]
}

/// Independent native codec/selector gates: no helper rewrites, no user source.
func verifyNativeIngestionStudyCodecs(_ url:URL)throws->[String:Any] {
    var checks:[String]=[]
    func require(_ value:Bool,_ reason:String)throws{guard value else{throw AsterError.javaScript("Ingestion study codec: "+reason)};checks.append(reason)}
    let source=try AsterEngine(bundleURL:url,count:0,options:["panels":[["id":"price"]],"series":[]]),target=try AsterEngine(bundleURL:url,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? source.close();try? target.close()}
    let bars:[AsterBar]=(0..<8).map{i -> AsterBar in let close=Double(i)+10.0;let time=1700000000000.0+Double(i)*60000.0;return AsterBar(time:time,open:close,high:close+1,low:close-1,close:close,volume:Double(i)+1)}
    for engine in [source,target]{try engine.setData(bars);_=try engine.registerIndicatorModule("aster.volume-direction",version:1)}
    _=try source.addIndicator("zero-pressure","aster.volume-direction@1/pressure",["factor":-Double.zero,"shift":0])
    try require(try ingestionRead(source,"Object.is(nativeModel.indicators.entries.get('zero-pressure').params.factor,-0)").toBool(),"Swift Double negative-zero reaches the linked factory without normalization")
    let saved=try source.saveStudies(),decoded=try JSONSerialization.jsonObject(with:Data(saved.utf8)) as! [String:Any],definitions=decoded["indicators"] as! [[String:Any]],params=definitions[0]["params"] as! [String:Any]
    try require((params["factor"] as? [String:String])?["$asterNumber"]=="-0","Study writer uses the bounded negative-zero reader codec")
    _=try target.loadStudies(saved)
    try require(try ingestionRead(target,"Object.is(nativeModel.indicators.entries.get('zero-pressure').params.factor,-0)").toBool(),"Same linked module and configuration restore exact parameter sign")
    let original=try source.call("nativeIndicatorBuffer",["zero-pressure","signed",0,8]),restored=try target.call("nativeIndicatorBuffer",["zero-pressure","signed",0,8])
    try require(try ingestionBytes(source,original,8)==ingestionBytes(target,restored,8),"Restored module keeps all eight signed-zero Float64 output bits")
    let zone=try AsterEngine(bundleURL:url,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? zone.close()}
    let times=["2026-03-06T14:30:00Z","2026-03-09T13:30:00Z","2026-03-09T20:00:00Z"].map{ISO8601DateFormatter().date(from:$0)!.timeIntervalSince1970*1000}
    try zone.setData(times.enumerated().map{i,t in AsterBar(time:t,open:Double(10+i),high:Double(10+i),low:Double(10+i),close:Double(10+i),volume:1)})
    let calendar=try ingestionJSON(["timezone":"aMeRiCa/NeW_yOrK","weekdays":[1,2,3,4,5],"windows":[["open":"09:30","close":"16:00"]],"exceptions":[:]])
    _=try zone.addIndicator("mixed-zone","vwap",["calendar":calendar,"source":"close"])
    let a=try zone.indicatorValueAt("mixed-zone",output:"value",index:0),b=try zone.indicatorValueAt("mixed-zone",output:"value",index:1),c=try zone.indicatorValueAt("mixed-zone",output:"value",index:2)
    try require(a["value"] as? Double==10&&b["value"] as? Double==11&&c["value"] is NSNull,"Mixed-case named time zone keeps literal pre/post-DST opens and half-open close in JSC")
    let budget=try AsterEngine(bundleURL:url,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? budget.close()}
    var exceptions:[String:Any]=[:];let formatter=ISO8601DateFormatter(),first=formatter.date(from:"2020-01-01T00:00:00Z")!
    for i in 0..<512{let date=String(formatter.string(from:first.addingTimeInterval(Double(i)*86400)).prefix(10));exceptions[date]=[["open":"09:30","close":"16:00","kind":"regular"+String(repeating:".",count:55)]]}
    let largeCalendar=try ingestionJSON(["timezone":"UTC","weekdays":[1,2,3,4,5],"windows":[["open":"09:30","close":"16:00"]],"exceptions":exceptions])
    for i in 0..<128{_=try budget.addIndicator("large-calendar-\(i)","vwap",["calendar":largeCalendar,"source":"close"])}
    let revision=budget.revision;var callbacks=0;let token=try budget.observeChanges{callbacks+=1};var withinBudget:String?,budgetRejected=false
    do{withinBudget=try budget.saveStudies()}catch AsterError.javaScript(let message){budgetRejected=message.contains("limit")||message.contains("budget")}
    try budget.removeObserver(token)
    if let document=withinBudget{let imported=try AsterEngine(bundleURL:url,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? imported.close()};let counts=try imported.loadStudies(document);try require(counts["indicators"] as? Int==128,"Successful large-calendar save is readable by the same public loader")}
    else{try require(budgetRejected,"Oversized aggregate study document explicitly rejects before returning unreadable text")}
    try require(revision==budget.revision&&callbacks==0,"Document-budget rejection/save preserves source revision and observers")
    return ["schema":"aster.native.ingestion-study-codecs","passed":checks.count,"checks":checks,"module":"aster.volume-direction@1/pressure","literalDSTTimes":times,"calendarUTF8Bytes":largeCalendar.utf8.count,"budgetRejected":budgetRejected,"scope":"Real JavaScriptCore and public named Swift APIs; no input or timing measurement"]
}

func verifyNativeIngestionAsync(_ url:URL,completion:@escaping(Result<[String:Any],Error>)->Void) {NativeIngestionAsyncFixture(url,completion).next()}
private final class NativeIngestionAsyncFixture {
    let url:URL,completion:(Result<[String:Any],Error>)->Void
    let cases=["pending","store-budget","success","committed-observer","cancel","close","wrong-owner"]
    var offset=0,checks:[String]=[],rows:[[String:Any]]=[],source:AsterEngine?,job:AsterAsyncJob?,history:[AsterAsyncJob]=[]
    init(_ url:URL,_ completion:@escaping(Result<[String:Any],Error>)->Void){self.url=url;self.completion=completion}
    func require(_ value:Bool,_ reason:String)throws{guard value else{throw AsterError.javaScript("Async ingestion: "+reason)};checks.append(reason)}
    func next(){
        if offset==cases.count{completion(.success(["schema":"aster.native.ingestion-async","passed":checks.count,"checks":checks,"cases":rows,"retainedTerminalHandles":history.count,"boundary":"Main-owner Swift/JSC isolated contexts; no OS input or performance measurement"]));return}
        let name=cases[offset]
        do{
            let engine=try ingestionConfigured(url,32);source=engine
            let policy:[String:Any]=["streamId":"async-swift","generation":9,"firstSequence":70,"maxQueuedEvents":8,"maxQueuedBytes":392,"maxBatchEvents":3,"maxStoredBars":name=="store-budget" ? 32:4096,"maxStoreBytes":96*8192]
            _=try engine.configureDataIngestion(policy)
            if name=="wrong-owner"{
                let done=DispatchSemaphore(value:0),lock=NSLock();var wrong=false
                DispatchQueue.global(qos:.userInitiated).async{do{_=try engine.dataIngestionStats()}catch AsterError.wrongThread{lock.lock();wrong=true;lock.unlock()}catch{};done.signal()}
                guard done.wait(timeout:.now()+2) == .success else{throw AsterError.javaScript("Wrong-owner ingestion timeout")}
                lock.lock();let caught=wrong;lock.unlock();try require(caught,"Named queue facade keeps original wrongThread priority");try engine.close();source=nil;rows.append(["case":name]);offset+=1;DispatchQueue.main.async{self.next()};return
            }
            if name=="pending"{_=try engine.enqueueDataEvents(["streamId":"async-swift","generation":9,"firstSequence":70,"events":[ingestionEvent("update",31,120)]])}
            let before=try engine.dataIngestionStats(),saved=try engine.saveDataIngestion();var terminal=0,progressOnOwner=true,observerArmed=name=="committed-observer",observerResult:[String:Any]=[:],observerError:Error?
            var observer:UUID?
            if observerArmed{observer=try engine.observeChanges{[weak self,weak engine] in guard let self=self,let engine=engine,observerArmed else{return};observerArmed=false
                do{self.job?.cancel();let state=try engine.dataIngestionStats();try self.require(state["storedBars"] as? Int==512&&state["state"] as? String=="running","Committed observer sees restored current ingestion session")
                    _=try engine.enqueueDataEvents(["streamId":"async-swift","generation":9,"firstSequence":70,"events":[ingestionEvent("update",511,130)]])
                    _=try engine.pauseDataIngestion();let cancel=try engine.cancelDataEvents();_=try engine.resumeDataIngestion();observerResult=try engine.dataIngestionStats()
                    try self.require(cancel["events"] as? Int==1&&observerResult["accepted"] as? Int==1&&observerResult["cancelled"] as? Int==1&&ingestionLedger(observerResult),"Committed observer queue actions conserve payload while async handle is still active")
                }catch{observerError=error}
            }}
            let callback:(Result<AsterAsyncMetrics,Error>)->Void = {[self,weak engine] result in
                terminal+=1
                do{guard let engine=engine else{throw AsterAsyncError.sourceDeallocated};try require(Thread.isMainThread&&progressOnOwner&&terminal==1,"One async terminal and progress remain on original main owner [\(name)]")
                    if let observer=observer{try engine.removeObserver(observer)};if let error=observerError{throw error}
                    switch name{
                    case "store-budget":
                        guard case .failure(let error)=result,let ingressError=error as? AsterIngestionError,ingressError.code=="STORE_BUDGET" else{throw AsterError.javaScript("Async batch did not reject with STORE_BUDGET: \(result)")}
                        let after=try engine.dataIngestionStats();try require(try ingestionJSON(after)==ingestionJSON(before),"Async oversized batch preserves every source row, session counter, and releases lease")
                    case "pending":
                        guard case .failure(let error)=result,let ingressError=error as? AsterIngestionError,ingressError.code=="PENDING_DATA" else{throw AsterError.javaScript("Pending ingress did not reject with terminalPENDING_DATA: \(result)")}
                        let after=try engine.dataIngestionStats();try require(try ingestionJSON(after)==ingestionJSON(before),"Pending async failure preserves owned payload/counters/configuration and returns no lingering lease")
                        _=try engine.cancelDataEvents();_=try engine.resumeDataIngestion()
                    case "cancel":
                        guard case .failure(AsterAsyncError.cancelled)=result else{throw AsterError.javaScript("Cancellation outcome \(result)")};let after=try engine.dataIngestionStats();try require(after["state"] as? String=="running"&&ingestionLedger(after),"Cancellation releases empty-session lease and host busy state")
                    case "close":
                        guard case .failure(AsterAsyncError.engineClosed)=result else{throw AsterError.javaScript("Close outcome \(result)")};var closed=false;do{_=try engine.dataIngestionStats()}catch AsterAsyncError.engineClosed{closed=true};try require(closed,"Close terminal rejects subsequent named queue reads")
                    default:
                        _=try result.get();let after=try engine.dataIngestionStats();try require(after["state"] as? String=="running"&&after["nextSequence"] as? Int==70+(name=="committed-observer" ? 1:0)&&ingestionLedger(after),"Successful VM handoff preserves empty policy/cursors/counters")
                        let reference=try ingestionConfigured(url,512);defer{try? reference.close()};let outputs=try ingestionFullEqual(engine,reference,512);try require(outputs==15,"Async prepared6columns/15vectors remain exact after restored ingestion [\(name)]")
                    }
                    if let handle=job{history.append(handle);let retained=handle._terminalRetentionProbe();try require(retained.inputBytes==0&&retained.callbacks==0&&retained.contexts==0,"Retained terminal handle releases owned payload/callback/context [\(name)]")}
                    rows.append(["case":name,"terminalCount":terminal,"committedObserver":observerResult]);try engine.close();source=nil;job=nil;offset+=1;DispatchQueue.main.async{self.next()}
                }catch{try? engine?.close();source=nil;job=nil;completion(.failure(AsterError.javaScript("Async ingestion [\(name)]: \(error)")))}
            }
            let progress:(AsterAsyncProgress)->Void={value in _=value;progressOnOwner=progressOnOwner&&Thread.isMainThread}
            if name=="store-budget"{job=try engine.applyDataEventAsync(["kind":"batch","events":[ingestionEvent("append",32,130)]],timeout:30,progress:progress,completion:callback)}
            else{job=try engine.prepareSeededAsync(count:512,visibleBars:64,timeout:30,progress:progress,completion:callback)}
            try require(terminal==0,"Async API preserves deferred completion/returned handle [\(name)]")
            if name != "close"{
                var busy=0
                for action in 0..<7{do{switch action{case 0:_=try engine.configureDataIngestion(policy);case 1:_=try engine.enqueueDataEvents(["streamId":"async-swift","generation":9,"firstSequence":70,"events":[ingestionEvent("update",31,120)]]);case 2:_=try engine.drainDataEvents();case 3:_=try engine.pauseDataIngestion();case 4:_=try engine.resumeDataIngestion();case 5:_=try engine.cancelDataEvents();default:_=try engine.loadDataIngestion(saved)}}catch let error as AsterIngestionError{if error.code=="BUSY"{busy+=1}}}
                try require(busy==7,"All seven queue mutators reject before deferred JS begin [\(name)]")
                _=try engine.dataIngestionStats();_=try engine.saveDataIngestion()
            }
            if name=="cancel"{job?.cancel()};if name=="close"{try engine.close()}
        }catch{job?.cancel();try? source?.close();source=nil;job=nil;completion(.failure(AsterError.javaScript("Async ingestion [\(name)]: \(error)")))}
    }
}
