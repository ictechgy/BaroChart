import Foundation
import JavaScriptCore

// Independent lifetime diagnostic deliberately inspects retained raw context
// AFTER close. Application raw-context access afterclose remains unsupported.
// This measures owned ring references, not GC completion or process RSS.
@main struct ClosedIngestionCLI {
    static func main()throws{
        let args=CommandLine.arguments;guard args.count==3 else{throw AsterError.invalidScene}
        let engine=try AsterEngine(bundleURL:URL(fileURLWithPath:args[1]),count:8,options:["panels":[["id":"price"]],"series":[]])
        _=try engine.configureDataIngestion(["streamId":"retained-close","generation":1,"maxQueuedEvents":4096,"maxQueuedBytes":49*4096])
        let bar:[String:Any]=["time":1700000000000.0+7*60000,"open":100.0,"high":101.0,"low":99.0,"close":100.0,"volume":1.0]
        _=try engine.enqueueDataEvents(["streamId":"retained-close","generation":1,"firstSequence":0,"events":[["kind":"update","bar":bar]]])
        guard engine.context.evaluateScript("globalThis.closedRingProbe=nativeModel.dataIngestion") != nil else{throw AsterError.invalidScene}
        func snapshot()throws->[String:Any]{guard let value=engine.context.evaluateScript("({closed:closedRingProbe.closed,count:closedRingProbe.count,firstPendingSequence:closedRingProbe.firstPendingSequence,columns:Object.keys(closedRingProbe.columns).length,kindsNull:closedRingProbe.kinds===null,modelNull:closedRingProbe.model===null,counters:closedRingProbe.counters,storeRows:nativeModel.store.length})"),engine.context.exception==nil,let object=value.toDictionary() as? [String:Any] else{throw AsterError.invalidScene};return object}
        let before=try snapshot();var callbacks=0;_=try engine.observeChanges{callbacks+=1};try engine.close();let after=try snapshot();try engine.close();let repeated=try snapshot()
        let counters=after["counters"] as! [String:Any],unchanged=try JSONSerialization.data(withJSONObject:after,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:repeated,options:[.sortedKeys])
        let passed=after["closed"] as? Bool==true&&after["count"] as? Int==0&&after["columns"] as? Int==0&&after["kindsNull"] as? Bool==true&&after["modelNull"] as? Bool==true&&after["storeRows"] as? Int==8&&callbacks==0&&counters["accepted"] as? Int==1&&counters["cancelled"] as? Int==1&&counters["lastCancelledSequence"] as? Int==0&&after["firstPendingSequence"] as? Int==1&&unchanged
        let async=try asyncClose(URL(fileURLWithPath:args[1]))
        let report:[String:Any]=["schema":"aster.cycle12.closed-ingestion","passed":passed,"before":before,"after":after,"repeat":repeated,"repeatIdempotent":unchanged,"observerCallbacks":callbacks,"async":async,"retainedClosedEngine":true,"rawContextInspection":"Test-only unsupported application access","boundary":"Logical ring/model ownership, not RSS or GC timing"]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[2]));if !passed{throw AsterError.javaScript("Closed engine retains ingestion ring/payload")}
    }
    private static func asyncClose(_ url:URL)throws->[String:Any]{let engine=try AsterEngine(bundleURL:url,count:32,options:["panels":[["id":"price"]],"series":[]]);_=try engine.configureDataIngestion(["streamId":"close-worker","generation":1]);var terminal=0,closedError=false,owner=true,closedDuringProgress=false
        let handle=try engine.prepareSeededAsync(count:8192,timeout:30,progress:{value in if !closedDuringProgress&&value.phase=="generate"{closedDuringProgress=true;try engine.close()}}){result in terminal+=1;owner=owner&&Thread.isMainThread;if case .failure(AsterAsyncError.engineClosed)=result{closedError=true}}
        let deadline=ProcessInfo.processInfo.systemUptime+35;while terminal==0&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}}
        let retained=handle._terminalRetentionProbe();guard closedDuringProgress,terminal==1,closedError,owner,retained.inputBytes==0,retained.callbacks==0,retained.contexts==0 else{throw AsterError.javaScript("Worker close terminal/retention regression")}
        let ring=engine.context.evaluateScript("({closed:nativeModel.dataIngestion.closed,count:nativeModel.dataIngestion.count,columns:Object.keys(nativeModel.dataIngestion.columns).length,kindsNull:nativeModel.dataIngestion.kinds===null})")!.toDictionary()!
        guard ring["closed"] as? Bool==true,ring["count"] as? Int==0,ring["columns"] as? Int==0,ring["kindsNull"] as? Bool==true else{throw AsterError.javaScript("Worker-close ring retained")}
        try engine.close();return ["terminalCount":terminal,"closedDuringWorkerGenerate":closedDuringProgress,"engineClosedError":closedError,"ownerCompletion":owner,"retainedHandleReleased":true,"ring":ring]
    }
}
