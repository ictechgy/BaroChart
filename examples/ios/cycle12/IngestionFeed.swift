import Foundation
import JavaScriptCore
import CryptoKit

// Test-only host scheduler. The producer owns immutable scalar messages and
// never calls JSC. One fixed ring and one main timer bound pending host work.
final class Cycle12Feed {
    struct Message {
        let serial:Int,created:Double,kind:String,bar:AsterBar
        var event:[String:Any]{["kind":kind,"bar":["time":bar.time,"open":bar.open,"high":bar.high,"low":bar.low,"close":bar.close,"volume":bar.volume]]}
    }
    private let lock=NSLock(),producer=DispatchQueue(label:"Cycle12 immutable producer",qos:.userInitiated)
    private var ring=[Message?](repeating:nil,count:4096),head=0,count=0,generation=0,stopped=true,updateOnly=false
    private var producerTimer:DispatchSourceTimer?,ownerTimer:DispatchSourceTimer?
    private var serial=0,producerTail:AsterBar?,initialTail:AsterBar?,initialCount=0,rate=100,appendEvery=500
    private var corrections=0,hostCreated=0,hostRejected=0,hostCancelled=0,hostHighwater=0,hostAccepted=0
    private var historyStarted=0.0,historyInterval=300.0,historyRows=0
    private var pending:[Message]=[],applied:[Message]=[],nextSequence=0
    private(set) var epochs:[[String:Any]]=[],drains=[[String:Any]](),failures=[String](),queueAgesMs=[Double]()
    private(set) var appliedDuringOSInput=0,budgetFailures=0
    weak var engine:AsterEngine?
    var duringOSInput:(()->Bool)?,onFailure:((Error)->Void)?
    let traceLimit=180000
    func start(_ engine:AsterEngine,initialCount:Int,tail:AsterBar,rate:Int=100,appendEvery:Int=500)throws {
        precondition(Thread.isMainThread);precondition(rate>0&&rate<=1000&&appendEvery>0)
        self.engine=engine;self.initialCount=initialCount;self.rate=rate;self.appendEvery=appendEvery;initialTail=tail;producerTail=tail
        _=try engine.configureDataIngestion(["streamId":"ios-cycle12","generation":1,"maxQueuedEvents":4096,"maxQueuedBytes":49*4096,"maxBatchEvents":64,"maxStoredBars":initialCount+32,"maxStoreBytes":96*262144])
        lock.lock();stopped=false;generation+=1;let epoch=generation;lock.unlock()
        let timer=DispatchSource.makeTimerSource(queue:producer);timer.schedule(deadline:.now(),repeating:.nanoseconds(1_000_000_000/rate));timer.setEventHandler{[weak self] in self?.produce(epoch)};producerTimer=timer;timer.resume()
        let owner=DispatchSource.makeTimerSource(queue:.main);owner.schedule(deadline:.now() + .milliseconds(8),repeating:.milliseconds(8));owner.setEventHandler{[weak self] in self?.tick(epoch)};ownerTimer=owner;owner.resume()
    }
    private func produce(_ epoch:Int){lock.lock();defer{lock.unlock()};guard !stopped,generation==epoch,let start=initialTail,let old=producerTail else{return}
        let s=serial;serial+=1;hostCreated+=1
        let bucket=s/appendEvery,append = !updateOnly&&s>0&&s%appendEvery==0
        let close=start.close+Double(s%100)*0.001,tailTime=updateOnly ? old.time:start.time+Double(bucket)*60000
        let now=ProcessInfo.processInfo.systemUptime
        let historical=updateOnly&&historyStarted>0&&corrections<2&&now-historyStarted>=Double(corrections+1)*historyInterval
        let bar:AsterBar,kind:String
        if historical{corrections+=1;let index=corrections==1 ? 0:historyRows/2,value=100.0+Double(corrections);bar=AsterBar(time:1700000000000+Double(index)*60000,open:value,high:value+1,low:value-1,close:value,volume:100);kind="correction"}
        else{bar=AsterBar(time:tailTime,open:start.close,high:start.close+0.1,low:start.close,close:close,volume:Double(s%500+1));kind=append ? "append":"update";producerTail=bar}
        let message=Message(serial:s,created:ProcessInfo.processInfo.systemUptime,kind:kind,bar:bar)
        guard count<ring.count else{hostRejected+=1;stopped=true;DispatchQueue.main.async{[weak self] in self?.onFailure?(AsterIngestionError(code:"HOST_QUEUE_BUDGET",message:"Producer paused after explicit host-ring rejection"))};return};ring[(head+count)%ring.count]=message;count+=1;hostHighwater=max(hostHighwater,count)
    }
    private func pop(_ maximum:Int)->[Message]{lock.lock();defer{lock.unlock()};var rows:[Message]=[];for _ in 0..<min(count,maximum){rows.append(ring[head]!);ring[head]=nil;head=(head+1)%ring.count;count-=1};return rows}
    private func tick(_ epoch:Int){precondition(Thread.isMainThread);lock.lock();let live = !stopped&&epoch==generation;lock.unlock();guard live,let engine=engine else{return}
        let messages=pop(64);guard !messages.isEmpty else{return}
        let start=ProcessInfo.processInfo.systemUptime;var admitted=false
        do{
            let receipt=try engine.enqueueDataEvents(["streamId":"ios-cycle12","generation":1,"firstSequence":nextSequence,"events":messages.map{$0.event}]);guard receipt["events"] as? Int==messages.count else{throw AsterError.invalidScene};pending.append(contentsOf:messages);nextSequence+=messages.count;hostAccepted+=messages.count;admitted=true
            for message in messages{guard queueAgesMs.count<traceLimit else{throw AsterError.javaScript("Host queue trace limit")};queueAgesMs.append((start-message.created)*1000)}
            do{
                let drainStart=ProcessInfo.processInfo.systemUptime,receipt=try engine.drainDataEvents(),n=receipt["events"] as! Int
                guard n<=pending.count,applied.count+n<traceLimit else{throw AsterError.javaScript("Applied event trace limit")}
                applied.append(contentsOf:pending.prefix(n));pending.removeFirst(n)
                for message in applied.suffix(n) where message.kind=="correction"{epochs.append(["kind":"historical-correction","index":Int((message.bar.time-1700000000000)/60000),"historyRows":historyRows,"createdAfterMeasurementSeconds":message.created-historyStarted,"appliedAfterMeasurementSeconds":ProcessInfo.processInfo.systemUptime-historyStarted])}
                if duringOSInput?()==true{appliedDuringOSInput+=n}
                drains.append(["start":start,"drainStart":drainStart,"end":ProcessInfo.processInfo.systemUptime,"events":n,"firstSequence":receipt["firstSequence"]!,"lastSequence":receipt["lastSequence"]!,"appliedDuringOSInput":duringOSInput?()==true,"revision":engine.revision])
            }catch let error as AsterIngestionError where error.code=="DRAIN_FAILED"{
                let before=try engine.dataIngestionStats();guard before["state"] as? String=="paused",before["pendingEvents"] as? Int==pending.count,before["storedBars"] as? Int==initialCount+32 else{throw AsterError.javaScript("Failed prefix not fully retained")}
                budgetFailures+=1;let cancel=try engine.cancelDataEvents();guard cancel["events"] as? Int==pending.count else{throw AsterError.invalidScene};pending.removeAll(keepingCapacity:true);_=try engine.resumeDataIngestion()
                guard let value=try engine.command("inspect").forProperty("lastBar").toDictionary() else{throw AsterError.invalidScene};let tail=Cycle12Oracle.bar(value)
                lock.lock();let discarded=count;hostCancelled+=discarded;for i in ring.indices{ring[i]=nil};count=0;head=0;updateOnly=true;producerTail=tail;historyRows=before["storedBars"] as! Int;lock.unlock()
                epochs.append(["kind":"store-budget-explicit-cancel-resume","at":ProcessInfo.processInfo.systemUptime,"before":before,"cancel":cancel,"hostCancelled":discarded,"after":try engine.dataIngestionStats()])
            }
        }catch{if !admitted{lock.lock();hostRejected+=messages.count;lock.unlock()};failures.append(String(describing:error));onFailure?(error);stopProducer()}
    }
    private func stopProducer(){producerTimer?.cancel();producerTimer=nil;ownerTimer?.cancel();ownerTimer=nil;lock.lock();stopped=true;generation+=1;lock.unlock();producer.sync{}}
    func beginHistoryClock(interval:Double){precondition(Thread.isMainThread);precondition(interval>0);lock.lock();historyStarted=ProcessInfo.processInfo.systemUptime;historyInterval=interval;lock.unlock()}
    func stop()throws->[String:Any]{precondition(Thread.isMainThread);stopProducer();lock.lock();hostCancelled+=count;for i in ring.indices{ring[i]=nil};count=0;lock.unlock()
        var final:[String:Any]=[:];if let engine=engine{let before=try engine.dataIngestionStats();let cancelled=try engine.cancelDataEvents();guard cancelled["events"] as? Int==pending.count else{throw AsterError.invalidScene};pending.removeAll();final=try engine.dataIngestionStats();epochs.append(["kind":"stop-explicit-cancel","before":before,"cancel":cancelled,"after":final])}
        return ["schema":"aster.cycle12.ios-feed","rateHz":rate,"appendEveryMessages":appendEvery,"historyCorrectionIntervalSeconds":historyInterval,"hostCreated":hostCreated,"hostAccepted":hostAccepted,"hostRejected":hostRejected,"hostCancelled":hostCancelled,"hostLedgerConserved":hostCreated==hostAccepted+hostRejected+hostCancelled,"hostHighwater":hostHighwater,"hostCapacity":4096,"maxAdmissionAndDrain":64,"maximumRawRowsPerTrace":traceLimit,"omittedRawRows":0,"appliedEvents":applied.count,"appliedDuringOSInput":appliedDuringOSInput,"budgetFailures":budgetFailures,"failures":failures,"epochs":epochs,"rawDrains":drains,"hostQueueAgeMs":queueAgesMs,"session":final,"historyNeverResetOrEvicted":true,"boundary":"One fixed Swift producer ring, one8ms main owner timer; core49-byte ring separately bounded; payload copied at admission"]
    }
    func messages()->[Message]{precondition(Thread.isMainThread);return applied}
    func writeAppliedTrace(_ url:URL)throws->[String:Any]{precondition(Thread.isMainThread);guard FileManager.default.createFile(atPath:url.path,contents:nil) else{throw AsterError.javaScript("Cannot create applied trace")};let file=try FileHandle(forWritingTo:url);defer{try? file.close()};var digest=SHA256(),block=Data();block.reserveCapacity(65*4096)
        func append(_ value:UInt64){var little=value.littleEndian;withUnsafeBytes(of:&little){block.append(contentsOf:$0)}}
        for(index,message) in applied.enumerated(){append(UInt64(message.serial));append(message.created.bitPattern);block.append(message.kind=="append" ? 1:message.kind=="update" ? 2:3);for value in [message.bar.time,message.bar.open,message.bar.high,message.bar.low,message.bar.close,message.bar.volume]{append(value.bitPattern)};if (index+1)%4096==0{digest.update(data:block);try file.write(contentsOf:block);block.removeAll(keepingCapacity:true)}}
        if !block.isEmpty{digest.update(data:block);try file.write(contentsOf:block)};let indices=applied.filter{$0.kind=="correction"}.map{Int(($0.bar.time-1700000000000)/60000)};return ["file":url.lastPathComponent,"sha256":digest.finalize().map{String(format:"%02x",$0)}.joined(),"rows":applied.count,"recordBytes":65,"bytes":applied.count*65,"littleEndian":true,"format":"UInt64 producerSerial,Float64 createdSystemUptime,UInt8kind(append1/update2/correction3),Float64time/open/high/low/close/volume","performedAfterMeasurement":true,"historicalCorrections":indices.count,"historicalIndices":indices]
    }
    deinit{producerTimer?.cancel();ownerTimer?.cancel()}
}

enum Cycle12Oracle {
    static let names=["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]
    static func bar(_ value:[AnyHashable:Any])->AsterBar{AsterBar(time:value["time"] as! Double,open:value["open"] as! Double,high:value["high"] as! Double,low:value["low"] as! Double,close:value["close"] as! Double,volume:value["volume"] as! Double)}
    static func indicators(_ engine:AsterEngine,series:Bool)throws {
        for name in names{let definition=try engine.addIndicator(name,name);if series{guard let outputs=definition.forProperty("outputs")?.toArray() as? [String] else{throw AsterError.invalidScene};for output in outputs{try engine.addSeries(["id":name+"-"+output,"type":"line","panel":"price","indicator":name,"output":output])}}}
        let calendar="{\"timezone\":\"America/New_York\",\"weekdays\":[1,2,3,4,5],\"windows\":[{\"open\":\"09:30\",\"close\":\"16:00\",\"kind\":\"regular\"}],\"exceptions\":{}}"
        _=try engine.addIndicator("session-vwap","vwap",["calendar":calendar,"deviation":2]);_=try engine.registerIndicatorModule("aster.volume-direction",version:1);_=try engine.addIndicator("pressure","aster.volume-direction@1/pressure",["factor":1,"shift":0])
        if series{for output in ["value","upper","lower"]{try engine.addSeries(["id":"vwap-"+output,"type":"line","panel":"price","indicator":"session-vwap","output":output])};try engine.addSeries(["id":"pressure-signed","type":"histogram","panel":"volume","indicator":"pressure","output":"signed"])}
    }
    static func json(_ value:Any)throws->String{String(data:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]),encoding:.utf8)!}
    static func read(_ engine:AsterEngine,_ expression:String)throws->JSValue{guard let value=engine.context.evaluateScript(expression) else{throw AsterError.invalidScene};if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Oracle JS error")};return value}
    static func bytes(_ engine:AsterEngine,_ value:JSValue,_ count:Int)throws->Data{var error:JSValueRef?;let ctx=engine.context.jsGlobalContextRef!;guard count>0,count<=4096,JSValueGetTypedArrayType(ctx,value.jsValueRef,&error)==kJSTypedArrayTypeFloat64Array,let object=JSValueToObject(ctx,value.jsValueRef,&error) else{throw AsterError.invalidScene};let length=JSObjectGetTypedArrayLength(ctx,object,&error),size=JSObjectGetTypedArrayByteLength(ctx,object,&error),offset=JSObjectGetTypedArrayByteOffset(ctx,object,&error);guard let buffer=JSObjectGetTypedArrayBuffer(ctx,object,&error) else{throw AsterError.invalidScene};let total=JSObjectGetArrayBufferByteLength(ctx,buffer,&error);guard error==nil,length==count,size==count*8,offset%8==0,offset<=total,size<=total-offset,let pointer=JSObjectGetTypedArrayBytesPtr(ctx,object,&error),error==nil else{throw AsterError.invalidScene};return Data(bytes:pointer.advanced(by:offset),count:size)}
    static func equal(_ source:AsterEngine,_ reference:AsterEngine,count:Int)throws->[String:Any]{var vectors=0,compared=0
        for name in ["time","open","high","low","close","volume"]{for at in stride(from:0,to:count,by:4096){let n=min(4096,count-at),expression="nativeModel.store.columns[\(try json(name))].subarray(\(at),\(at+n))",a=try read(source,expression),b=try read(reference,expression);guard try bytes(source,a,n)==bytes(reference,b,n) else{throw AsterError.javaScript("Oracle column \(name) at \(at)")};compared+=n*8}}
        for id in names+["session-vwap","pressure"]{guard let outputs=try read(source,"Object.keys(nativeModel.indicators.get(\(try json(id))).outputs)").toArray() as? [String] else{throw AsterError.invalidScene};for output in outputs{vectors+=1;for at in stride(from:0,to:count,by:4096){let n=min(4096,count-at),a=try source.call("nativeIndicatorBuffer",[id,output,at,n]),b=try reference.call("nativeIndicatorBuffer",[id,output,at,n]);guard try bytes(source,a,n)==bytes(reference,b,n) else{throw AsterError.javaScript("Oracle vector \(id).\(output) at \(at)")};compared+=n*8}}}
        return ["equal":true,"columns":6,"outputVectors":vectors,"bars":count,"comparedBytes":compared,"chunkRows":4096,"reference":"Fresh seed42 engine + explicitly ordered successful events via scalar facade; allFloat64bits includingNaN/sign checked","performedAfterMeasurement":true]
    }
}
