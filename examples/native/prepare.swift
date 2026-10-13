import Foundation
import JavaScriptCore

private let prepareNames=["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]
private let prepareFields=["time","open","high","low","close","volume"]
private func prepareClock()->Double {ProcessInfo.processInfo.systemUptime}
private func prepareJSON(_ object:Any)throws->String {String(data:try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.fragmentsAllowed]),encoding:.utf8)!}
private func prepareRead(_ engine:AsterEngine,_ source:String)throws->JSValue {
    guard let value=engine.context.evaluateScript(source) else{throw AsterError.invalidScene}
    if let error=engine.context.exception {engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Prepare fixture error")};return value
}
private func prepareState(_ engine:AsterEngine)throws->String {try prepareJSON(engine.command("inspect").toDictionary()!)}
private func prepareConfigured(_ url:URL,count:Int=0)throws->AsterEngine {
    let engine=try AsterEngine(bundleURL:url,count:count,options:["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]])
    for name in prepareNames {_=try engine.call("nativeIndicator",[name,name,[:],"price"])};return engine
}
private func prepareDecorate(_ engine:AsterEngine)throws {
    _=try engine.addDrawing(["id":"prepare-note","type":"text","points":[["time":1700000000000.0,"price":100]],"text":"original", "style":["font":"18px monospace","color":"#abcdef"]])
    try engine.editDrawing("prepare-note",["text":"second"]);try engine.undo();try engine.selectDrawing("prepare-note");try engine.setTool("text");try engine.setText("한국 🚀")
}
private func prepareLatest(_ engine:AsterEngine)throws {try engine.setTheme(["background":"#152535"]);try engine.editDrawing("prepare-note",["text":"latest"]);try engine.setPanel("price",["label":"Prepared data","inverted":true]);try engine.setSeries("ema-value",["width":2,"color":"#aabbcc"])}
private func prepareHeavyUI(_ engine:AsterEngine)throws {
    // Trusted fixture data generation, never source evaluation from a feed.
    _=try prepareRead(engine,"for(let d=0;d<100;d++){const points=Array.from({length:1000},(_,i)=>({time:1700000000000+i*60000,price:100+d/100+i/10000}));nativeAPI.addDrawing({id:'heavy-'+d,type:'freehand',points});}nativeAPI.editDrawing('heavy-99',{text:'edited history'});nativeAPI.undo();nativeAPI.selectDrawing('prepare-note');true")
}
private func prepareTextUI(_ engine:AsterEngine,_ name:String)throws {
    let text=String(repeating:name=="max-text-ui" ? "\0" : name=="unicode-text-ui" ? "가" : "\n",count:2000)
    for i in 0..<64{_=try engine.addDrawing(["id":"text-limit-\(i)","type":"text","points":[["time":1700000000000.0,"price":100.0]],"text":text])}
    try engine.editDrawing("text-limit-63",["text":"alternate history"]);try engine.undo();try engine.selectDrawing("prepare-note")
}
private let prepareTextCases=["text-ui","max-text-ui","unicode-text-ui","text-ui-cancel","text-ui-stale"]
private func prepareInput(_ count:Int,seed:UInt32=42)throws->AsterColumns {
    var state=seed,price=100.0,time=[Double](repeating:0,count:count),open=time,high=time,low=time,close=time,volume=time
    func random()->Double {state=state &* 1664525 &+ 1013904223;return Double(state)/4294967296}
    for i in 0..<count {let previous=price,delta=(random()-0.497)*1.2;price=max(0.1,price+delta);time[i]=1700000000000+Double(i)*60000;open[i]=previous;close[i]=price;high[i]=max(previous,price)+random()*0.6;low[i]=max(0.01,min(previous,price)-random()*0.6);volume[i]=floor(100+random()*9900)}
    return try AsterColumns(time:time,open:open,high:high,low:low,close:close,volume:volume)
}
private func prepareDictionary(_ c:AsterColumns)->[String:[Double]] { ["time":c.time,"open":c.open,"high":c.high,"low":c.low,"close":c.close,"volume":c.volume] }
private func prepareBytes(_ engine:AsterEngine,_ expression:String,_ offset:Int,_ count:Int)throws->Data {
    let value=try prepareRead(engine,"(\(expression)).subarray(\(offset),\(offset+count))"),ctx=engine.context.jsGlobalContextRef!;var exception:JSValueRef?
    guard JSValueGetTypedArrayType(ctx,value.jsValueRef,&exception)==kJSTypedArrayTypeFloat64Array,let object=JSValueToObject(ctx,value.jsValueRef,&exception) else{throw AsterError.invalidScene}
    let size=JSObjectGetTypedArrayByteLength(ctx,object,&exception),at=JSObjectGetTypedArrayByteOffset(ctx,object,&exception)
    guard size==count*8,exception==nil,let base=JSObjectGetTypedArrayBytesPtr(ctx,object,&exception),exception==nil else{throw AsterError.invalidScene};return Data(bytes:base.advanced(by:at),count:size)
}
private func prepareParity(_ source:AsterEngine,_ expected:AsterEngine,_ count:Int)throws {
    for field in prepareFields {for at in stride(from:0,to:count,by:4096) {let n=min(4096,count-at),expr="nativeModel.store.columns[\(try prepareJSON(field))]";guard try prepareBytes(source,expr,at,n)==prepareBytes(expected,expr,at,n) else{throw AsterError.javaScript("Raw column mismatch \(field) \(at)")}}}
    for name in prepareNames {
        let outputs=try prepareRead(source,"Object.keys(nativeModel.indicators.get(\(try prepareJSON(name))).outputs)").toArray() as! [String]
        for output in outputs {for at in stride(from:0,to:count,by:4096) {let n=min(4096,count-at),expr="nativeModel.indicators.get(\(try prepareJSON(name))).outputs[\(try prepareJSON(output))]";guard try prepareBytes(source,expr,at,n)==prepareBytes(expected,expr,at,n) else{throw AsterError.javaScript("Prepared vector mismatch \(name).\(output) \(at)")}}}
    }
}
private func prepareScene(_ engine:AsterEngine)throws->String {
    let text=try engine.call("nativeSceneJSON",[1200,700]).toString()!,bytes=text.data(using:.utf8)!
    return try prepareJSON(JSONSerialization.jsonObject(with:bytes))
}
private func prepareDrawing(_ engine:AsterEngine)throws->String {try prepareJSON(JSONSerialization.jsonObject(with:engine.saveDrawings().data(using:.utf8)!))}
private func prepareMetrics(_ m:AsterAsyncMetrics)->[String:Any] { ["wallMs":m.totalMs,"retainedInputBytes":m.retainedInputBytes,"inputOwnershipMs":m.inputOwnershipMs,"copiedBytes":m.copiedBytes,"maximumChunkBytes":m.maximumChunkBytes,"beginMs":m.beginMs,"workerInitMs":m.workerInitMs,"hostCopyMs":m.targetCopyMs,"ownerCaptureMs":m.captureMs,"queueWaitMs":m.queueWaitMs,"calculateValidateIndexMs":m.computeMs,"ownerUIStateMs":m.uiStateMs,"uiChunkCount":m.uiChunkCount,"uiTransferBytes":m.uiTransferBytes,"maximumUIChunkBytes":m.maximumUIChunkBytes,"workerUIImportMs":m.workerUIImportMs,"finishMs":m.finishMs,"commitMs":m.commitMs,"sampledPeakResidentBytes":m.peakResidentBytes,"baselineResidentBytes":m.baselineResidentBytes,"progressCallbackErrors":m.progressCallbackErrors] }
private final class PrepareWeak {weak var object:AnyObject?;let kind:String;init(_ object:AnyObject?,_ kind:String){self.object=object;self.kind=kind}}

func verifyNativePrepare(_ url:URL,count:Int=8192,status:((String)->Void)?=nil,completion:@escaping(Result<[String:Any],Error>)->Void) {PrepareFixture(url,count,status,completion).next()}
private final class PrepareFixture {
    let url:URL,count:Int,status:((String)->Void)?,completion:(Result<[String:Any],Error>)->Void
    let cases=["columns","seeded","cow","columns-offset","follow-false","empty","tiny","heavy-ui","heavy-ui-cancel","heavy-ui-stale","text-ui","max-text-ui","unicode-text-ui","text-ui-cancel","text-ui-stale","ui-import-error","cancel-before","cancel-copy","cancel-validate","cancel-generate","cancel-calculate","stale-data","stale-config","source-reinit","close","deallocated","malformed-time","malformed-envelope","shape-options","worker-create","target-type","compute-error","timeout","timeout-running","busy","unsupported-factory","borrowed-series","gesture","formatter","wrong-owner","progress-throws","reuse","retained-closed"]
    var offset=0,checks:[String]=[],rows:[[String:Any]]=[],engine:AsterEngine?,job:AsterAsyncJob?,history:[AsterAsyncJob]=[],retainedClosed:[AsterEngine]=[],released:[PrepareWeak]=[],retired:[PrepareWeak]=[],heartbeat:PrepareHeartbeat?
    init(_ url:URL,_ count:Int,_ status:((String)->Void)?,_ completion:@escaping(Result<[String:Any],Error>)->Void) {self.url=url;self.count=min(4194304,max(512,count));self.status=status;self.completion=completion}
    func check(_ value:Bool,_ name:String)throws {if !value {throw AsterError.javaScript(name)};checks.append(name)}
    func fail(_ error:Error){job?.cancel();if let pulse=heartbeat{_=pulse.end()};heartbeat=nil;engine=nil;job=nil;let name=cases[min(offset,cases.count-1)];completion(.failure(AsterError.javaScript("Prepare fixture [\(name)]: \(error)")))}
    func next() {
        if offset==cases.count {
            DispatchQueue.main.asyncAfter(deadline:.now()+0.3) { [self] in
                do {
                    for handle in history {let held=handle._terminalRetentionProbe();try check(held.inputBytes==0&&held.callbacks==0&&held.contexts==0,"Retained terminal handle releases payload/callback/context")}
                    try check(retired.allSatisfy {$0.object==nil},"Closed retained engine creation runtime retired")
                    try check(released.allSatisfy {$0.object==nil},"Dropped engine/context/VM/runtime weak probes released")
                    completion(.success(["passed":checks.count,"checks":checks,"cases":rows,"storedBars":count,"outputs":15,"seed":42,"host":"owned Swift arrays + isolated JavaScriptCore","retainedTerminalHandles":history.count,"weakProbes":released.count,"retainedClosedEngines":retainedClosed.count,"physicalDevice":false]))
                }catch{fail(error)}
            };return
        }
        let name=cases[offset];status?(name)
        do {
            let originalURL:URL
            var suffix:String?
            switch name {
            case "worker-create":suffix="globalThis.nativePrepareCreate=()=>{throw Error('fixture prepare create')};"
            case "target-type":suffix="globalThis.nativeAsyncTargetBuffer=()=>new Uint8Array(8);"
            case "compute-error":suffix="globalThis.nativeAsyncStep=()=>{throw Error('fixture prepare compute')};"
            case "ui-import-error":suffix="globalThis.nativeAsyncUIImportChunk=()=>{throw Error('fixture UI import')};"
            case "timeout-running":suffix="{const step=nativeAsyncStep;globalThis.nativeAsyncStep=n=>{const end=Date.now()+150;while(Date.now()<end){};return step(n);};}"
            case "cancel-validate","cancel-generate","cancel-calculate","progress-throws":
                // Trusted fixture-only pacing makes each requested phase
                // observable by coalesced main progress, without changing core.
                suffix="{const step=nativeAsyncStep;globalThis.nativeAsyncStep=n=>{const end=Date.now()+2;while(Date.now()<end){};return step(Math.min(n,256));};}"
            default:suffix=nil
            }
            if let suffix=suffix {originalURL=FileManager.default.temporaryDirectory.appendingPathComponent("aster-prepare-"+UUID().uuidString+".js");try (String(contentsOf:url,encoding:.utf8)+"\n"+suffix).write(to:originalURL,atomically:true,encoding:.utf8)} else{originalURL=url}
            let source:AsterEngine;do{source=try prepareConfigured(originalURL,count:name=="follow-false" ? 128 : 0)}catch{if suffix != nil{try? FileManager.default.removeItem(at:originalURL)};throw error};if suffix != nil{try FileManager.default.removeItem(at:originalURL)}
            engine=source;try prepareDecorate(source)
            if name.hasPrefix("heavy-ui"){try prepareHeavyUI(source)}
            if prepareTextCases.contains(name){try prepareTextUI(source,name)}
            let old=PrepareWeak(source.context,"context")
            if name=="follow-false" {_=try source.command("setVisibleRange",[30,90])}
            var size=name=="empty" ? 0 : name=="tiny" ? 3 : name=="columns-offset" ? 262149 : ["columns","seeded"].contains(name) ? count : min(count,8192)
            var input=try prepareInput(size),acted=false,latest=false,terminals=0
            if name=="tiny" {input=try AsterColumns(time:[1700000000123,1700000000124,1700000000125],open:[1e-12,1e-12,1e-12],high:[2e-12,2e-12,2e-12],low:[1e-13,1e-13,1e-13],close:[1.234567890123e-12,1.5e-12,1.8e-12],volume:[0,1,2])}
            if name=="malformed-time" {var time=input.time;time[1]=time[0];input=try AsterColumns(time:time,open:input.open,high:input.high,low:input.low,close:input.close,volume:input.volume)}
            if name=="malformed-envelope" {var high=input.high;high[1]=0;input=try AsterColumns(time:input.time,open:input.open,high:high,low:input.low,close:input.close,volume:input.volume)}
            if name=="unsupported-factory" {try source.registerIndicatorSource("extra","()=>({outputs:['value'],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}}}})");try source.addIndicator("extra","extra")}
            if name=="borrowed-series" {try source.addSeries(["id":"borrowed","type":"line","panel":"price","values":[Double]()])}
            if name=="gesture" {_=try source.call("nativePointer",["down",1,100,100])}
            if name=="formatter" {_=try prepareRead(source,"nativeModel.panels[0].formatter=()=> 'trusted';true")}
            var expectedState=try prepareState(source)
            if name=="shape-options" {
                var shape=false,options=false;do{_=try AsterColumns(time:[1],open:[],high:[],low:[],close:[],volume:[])}catch{shape=true};do{_=try source.prepareColumnsAsync(input,visibleBars:0){_ in}}catch{options=true}
                try check(shape&&options&&expectedState==prepareState(source),"Cheap shape/options reject unchanged source");rows.append(["case":name,"preflightRejected":true]);engine=nil;offset += 1;DispatchQueue.main.async {self.next()};return
            }
            if name=="wrong-owner" {
                let done=DispatchSemaphore(value:0);var wrong=false
                Thread {do{_=try source.prepareColumnsAsync(input){_ in}}catch AsterError.wrongThread{wrong=true}catch{};done.signal()}.start();done.wait();try check(wrong,"Prepare original owner guard");rows.append(["case":name,"wrongThreadRejected":true]);engine=nil;offset += 1;DispatchQueue.main.async {self.next()};return
            }
            let heldInput=input,progress:((AsterAsyncProgress)throws->Void)={ [self] p in
                guard Thread.isMainThread else{throw AsterError.wrongThread};status?("\(name): \(p.phase) \(p.done)/\(p.total)")
                if name=="progress-throws" {throw AsterError.javaScript("Trusted progress exception")}
                if name=="timeout-running"&&p.phase != "capture" {acted=true}
                guard let source=engine else{return}
                if name=="columns" && !latest {try prepareLatest(source);latest=true}
                if acted{return}
                switch name {
                case "heavy-ui-cancel" where p.phase=="ui-copy"&&p.done>0:acted=true;job?.cancel()
                case "heavy-ui-stale" where p.phase=="ui-copy"&&p.done>0:acted=true;try source.editDrawing("prepare-note",["text":"UI changed during transfer"])
                case "text-ui-cancel" where p.phase=="ui-copy"&&p.done>0:acted=true;job?.cancel()
                case "text-ui-stale" where p.phase=="ui-copy"&&p.done>0:acted=true;try source.editDrawing("prepare-note",["text":"UI changed during transfer"])
                case "cancel-copy" where p.phase=="capture":acted=true;job?.cancel()
                case "cancel-validate" where p.phase=="validate":acted=true;job?.cancel()
                case "cancel-generate" where p.phase=="generate":acted=true;job?.cancel()
                case "cancel-calculate" where p.phase=="calculate":acted=true;job?.cancel()
                case "stale-data":acted=true;try source.setColumns(["time":[1700000000000],"open":[1],"high":[2],"low":[0],"close":[1],"volume":[1]]);expectedState=try prepareState(source)
                case "stale-config":acted=true;try source.addIndicator("extra-rsi","rsi");expectedState=try prepareState(source)
                case "source-reinit":acted=true;_=try source.call("nativeInit",[10]);expectedState=try prepareState(source)
                case "close":acted=true;try source.close()
                default:break
                }
            }
            let seeded=["seeded","cancel-generate"].contains(name)
            let callback:(Result<AsterAsyncMetrics,Error>)->Void={ [self,weak source] result in
                do {
                    terminals += 1;try check(Thread.isMainThread&&terminals==1,"\(name) exactly one owner terminal")
                    var telemetry:[String:Any]=["storedBars":size];if let pulse=heartbeat{telemetry.merge(pulse.end()){_,new in new}};heartbeat=nil
                    if (name=="heavy-ui-stale"||name=="text-ui-stale")&&acted {
                        // Update the independent pre-operation expected state
                        // after heartbeat stops. Large inspect/save/reference
                        // conversions are correctness work, not UI transfer.
                        var expected=try JSONSerialization.jsonObject(with:expectedState.data(using:.utf8)!) as! [String:Any],drawings=expected["drawings"] as! [[String:Any]]
                        guard let note=drawings.firstIndex(where:{$0["id"] as? String=="prepare-note"}) else{throw AsterError.invalidScene};drawings[note]["text"]="UI changed during transfer";expected["drawings"]=drawings;expectedState=try prepareJSON(expected)
                    }
                    let success=["columns","seeded","cow","columns-offset","follow-false","empty","tiny","heavy-ui","text-ui","max-text-ui","unicode-text-ui","busy","progress-throws","reuse","retained-closed"].contains(name)
                    if success {
                        guard let source=source else{throw AsterError.invalidScene};let metrics=try result.get()
                        try check(source.context !== old.object,"\(name) prepared context installed")
                        try check(metrics.copiedBytes==(seeded ? 0 : size*48)&&metrics.maximumChunkBytes<=2097152,"\(name) only new input copied")
                        if name=="columns-offset" {try check(metrics.maximumChunkBytes==2097152&&metrics.copiedBytes>6*2097152,"Nonzero target byteOffset chunk copied exactly")}
                        if name=="progress-throws" {try check(metrics.progressCallbackErrors>0,"Throwing progress isolated")}
                        let reference=try prepareConfigured(url);try prepareDecorate(reference);try reference.setColumns(prepareDictionary(heldInput))
                        if name=="heavy-ui"{try prepareHeavyUI(reference);try check(metrics.uiTransferBytes>3000000&&metrics.maximumUIChunkBytes<=1048576&&metrics.uiChunkCount>1,"100x1000 freehand history uses bounded staged UI")}
                        if prepareTextCases.contains(name){try prepareTextUI(reference,name);try check(metrics.uiTransferBytes>262144&&metrics.maximumUIChunkBytes<=1048576&&metrics.uiChunkCount>1,"\(name) accepted64 max texts/history use bounded chunks");if name != "unicode-text-ui"{try check(metrics.maximumUIChunkBytes<=262144,"\(name) escaped ASCII chunk text bound")}}
                        // Sync setColumns fits the entire store. The opt-in
                        // prepare contract uses ChartModel's initial last-200
                        // view (including its empty/small-data forward space).
                        _=try prepareRead(reference,"nativeModel.view={from:\(max(-0.5,Double(size)-200.5)),to:\(max(199.5,Double(size)-0.5))};nativeModel.follow=true;true")
                        if latest{try prepareLatest(reference)};if name=="follow-false"{_=try reference.command("setVisibleRange",[30,90])}
                        _=try reference.scene(width:1200,height:700)
                        try prepareParity(source,reference,size)
                        try check(prepareState(source)==prepareState(reference),"\(name) exact latest UI/raw data")
                        try check(prepareScene(source)==prepareScene(reference),"\(name) exact ready scene/ranges")
                        try source.undo();try reference.undo();try check(prepareDrawing(source)==prepareDrawing(reference),"\(name) undo history");try source.redo();try reference.redo();try check(prepareDrawing(source)==prepareDrawing(reference),"\(name) redo history")
                        var row=prepareMetrics(metrics);row.merge(telemetry){_,new in new};row["case"]=name;row["exactRawAndVectors"]=true;rows.append(row)
                    }else{
                        if case .success=result{throw AsterError.javaScript("\(name) unexpectedly committed")}
                        if let source=source {try check(source.context===old.object,"\(name) retains source context");if name != "close"{try check(prepareState(source)==expectedState,"\(name) source unchanged")}}else{try check(name=="deallocated","Only deallocated source missing")}
                        if name.hasPrefix("cancel-")&&name != "cancel-before"{try check(acted,"\(name) requested phase reached")}
                        if name=="timeout-running"{try check(acted,"Timeout observed running JS step before terminal")}
                        if name=="heavy-ui-cancel"||name=="heavy-ui-stale"||name=="text-ui-cancel"||name=="text-ui-stale"{try check(acted,"\(name) mutated after first imported UI chunk")}
                        telemetry["case"]=name;telemetry["error"]=String(describing:result);rows.append(telemetry)
                    }
                    if let job=job {let held=job._terminalRetentionProbe();try check(held.inputBytes==0&&held.callbacks==0&&held.contexts==0,"\(name) terminal fields cleared");history.append(job)}
                    if let source=source {
                        let runtime=PrepareWeak(source._asyncRuntimeLifetimeProbe(),"runtime")
                        if name=="retained-closed" {
                            let lease=NSObject();released.append(PrepareWeak(lease,"observer capture"))
                            _=try source.observeChanges { _=lease;_=source };source.onObserverError={ _ in _=lease }
                            retired.append(runtime);retainedClosed.append(source)
                        }else{
                            released.append(PrepareWeak(source,"engine"));released.append(PrepareWeak(source.context,"context"));released.append(PrepareWeak(source.context.virtualMachine,"vm"));if runtime.object != nil{released.append(runtime)}
                        }
                        try source.close();try source.close()
                    }
                    job=nil;engine=nil;offset += 1;DispatchQueue.main.async {self.next()}
                }catch{fail(error)}
            }
            let timeout=name=="timeout" ? 0.000001 : name=="timeout-running" ? 0.1 : 120
            let pulse=PrepareHeartbeat();heartbeat=pulse;pulse.begin()
            if name=="reuse" {
                job=try source.prepareColumnsAsync(input) { [self,weak source] result in
                    do {if case .success=result{throw AsterError.javaScript("Reuse precursor should cancel")};guard let source=source,let oldJob=job else{throw AsterError.invalidScene};let held=oldJob._terminalRetentionProbe();try check(held.inputBytes==0&&held.callbacks==0,"Cancelled handle cleared before same-engine retry");history.append(oldJob);job=try source.prepareColumnsAsync(heldInput,progress:progress,completion:callback)}catch{fail(error)}
                };job?.cancel();return
            }
            let submitted=try seeded ? source.prepareSeededAsync(count:size,timeout:timeout,progress:progress,completion:callback) : source.prepareColumnsAsync(input,timeout:timeout,progress:progress,completion:callback)
            job=submitted
            if name=="cow" {var callerTime=input.time,callerClose=input.close;callerTime[0]=0;callerClose[0]=999999;input=try AsterColumns(time:callerTime,open:input.open,high:input.high,low:input.low,close:callerClose,volume:input.volume);size=heldInput.length}
            if name=="cancel-before"{submitted.cancel()}
            if name=="busy" {var rejected=false;do{_=try source.prepareSeededAsync(count:10){_ in}}catch AsterAsyncError.busy{rejected=true};try check(rejected,"Prepare shares max1 job with existing lifecycle")}
            if name=="deallocated"{engine=nil}
        }catch{fail(error)}
    }
}

private func prepareProcess()->(rss:UInt64,cpu:Double) {
    var basic=mach_task_basic_info(),n=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<natural_t>.size)
    let a=withUnsafeMutablePointer(to:&basic) {$0.withMemoryRebound(to:integer_t.self,capacity:Int(n)) {task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&n)}}
    var live=task_thread_times_info();n=mach_msg_type_number_t(MemoryLayout<task_thread_times_info>.size/MemoryLayout<natural_t>.size)
    let b=withUnsafeMutablePointer(to:&live) {$0.withMemoryRebound(to:integer_t.self,capacity:Int(n)) {task_info(mach_task_self_,task_flavor_t(TASK_THREAD_TIMES_INFO),$0,&n)}}
    func seconds(_ t:time_value_t)->Double {Double(t.seconds)+Double(t.microseconds)/1000000}
    // SDK task_info.h: basic CPU covers terminated threads; live CPU covers
    // existing threads. The two reads are sampled, not an atomic CPU snapshot.
    return (a==KERN_SUCCESS ? UInt64(basic.resident_size) : 0,a==KERN_SUCCESS&&b==KERN_SUCCESS ? seconds(basic.user_time)+seconds(basic.system_time)+seconds(live.user_time)+seconds(live.system_time) : -1)
}
private final class PrepareProcessSampler {
    private let queue=DispatchQueue(label:"Aster prepare process sampler",qos:.utility),lock=NSLock()
    private var timer:DispatchSourceTimer?,active=false,start=0.0,lastTrend=0.0,lastCPU=0.0,initialCPU=0.0,baseline:UInt64=0,peak:UInt64=0,samples=0,trend:[[String:Any]]=[]
    func begin() {
        precondition(Thread.isMainThread);let now=prepareClock(),p=prepareProcess();start=now;lastTrend=now;lastCPU=p.cpu;initialCPU=p.cpu;baseline=p.rss;peak=p.rss;samples=0;trend=[["elapsedSeconds":0,"residentBytes":p.rss,"processCPUSeconds":p.cpu,"processCPUPercent":0]];active=true
        let timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now(),repeating:.milliseconds(5),leeway:.milliseconds(1));timer.setEventHandler { [weak self] in self?.sample() };self.timer=timer;timer.resume()
    }
    private func sample() {
        let now=prepareClock(),p=prepareProcess();lock.lock();defer{lock.unlock()};guard active else{return};peak=max(peak,p.rss);samples += 1
        if now-lastTrend>=2 {let elapsed=max(0.000001,now-lastTrend);trend.append(["elapsedSeconds":now-start,"residentBytes":p.rss,"processCPUSeconds":p.cpu,"processCPUPercent":p.cpu>=0&&lastCPU>=0 ? max(0,p.cpu-lastCPU)/elapsed*100 : -1]);lastTrend=now;lastCPU=p.cpu}
    }
    func end()->[String:Any] {
        precondition(Thread.isMainThread);timer?.cancel();timer=nil;queue.sync{sample()};let p=prepareProcess();lock.lock();active=false;peak=max(peak,p.rss);let row:[String:Any]=["baselineResidentBytes":baseline,"sampledPeakResidentBytes":peak,"sampledPeakDeltaBytes":peak>=baseline ? peak-baseline : 0,"endResidentBytes":p.rss,"processCPUSecondsDelta":p.cpu>=0&&initialCPU>=0 ? max(0,p.cpu-initialCPU) : -1,"rssSamples":samples,"rssSampleIntervalMs":5,"rssSamplingLowerBound":true,"processTrend":trend];lock.unlock();return row
    }
    deinit{timer?.cancel()}
}
private final class PrepareHeartbeat {
    private var timer:DispatchSourceTimer?,last=0.0,maximum=0.0,beats=0,over50=0,foregroundMaximum=0.0,foregroundOver50=0,suspended=false
    func begin() {precondition(Thread.isMainThread);last=prepareClock();let timer=DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now(),repeating:.milliseconds(8));timer.setEventHandler { [weak self] in self?.beat() };self.timer=timer;timer.resume()}
    private func beat() {let now=prepareClock(),gap=(now-last)*1000;last=now;maximum=max(maximum,gap);beats += 1;if gap>=50{over50 += 1};if !suspended{foregroundMaximum=max(foregroundMaximum,gap);if gap>=50{foregroundOver50 += 1}}}
    func backgrounded(){beat();suspended=true}
    func foregrounded(){beat();suspended=false}
    func end()->[String:Any] {precondition(Thread.isMainThread);beat();timer?.cancel();timer=nil;return ["heartbeatIntervalMs":8,"heartbeatCountIncludingFinalInterval":beats,"maximumHeartbeatGapMs":maximum,"heartbeatGapsOver50Ms":over50,"foregroundMaximumHeartbeatGapMs":foregroundMaximum,"foregroundHeartbeatGapsOver50Ms":foregroundOver50]}
    deinit{timer?.cancel()}
}

/// Fresh empty engines, one sample per input/mode. The normal synchronous
/// columns facade includes its Swift/Objective-C/JS array bridge cost. Seeded
/// sync uses the exposed generator with a same-store reset, keeping revision,
/// view and configuration identical to prepare instead of replacing nativeInit.
func benchmarkNativePrepare(_ url:URL,count:Int=1000000,status:((String)->Void)?=nil,completion:@escaping(Result<[String:Any],Error>)->Void) {PrepareBenchmark(url,count,status,completion).begin()}
private final class PrepareBenchmark {
    let url:URL,count:Int,status:((String)->Void)?,completion:(Result<[String:Any],Error>)->Void
    let matrix=[("columns","sync"),("columns","async"),("seeded","sync"),("seeded","async")]
    var input:AsterColumns?,inputGenerationMs=0.0,offset=0,rows:[[String:Any]]=[],references:[String:String]=[:],engine:AsterEngine?,job:AsterAsyncJob?,sampler:PrepareProcessSampler?,heartbeat:PrepareHeartbeat?
    init(_ url:URL,_ count:Int,_ status:((String)->Void)?,_ completion:@escaping(Result<[String:Any],Error>)->Void) {self.url=url;self.count=count;self.status=status;self.completion=completion}
    func begin() {
        guard Thread.isMainThread,count>=512,count<=4194304 else{completion(.failure(AsterAsyncError.invalidProtocol("Prepare benchmark main/count")));return}
        status?("Owned input generation (excluded)")
        DispatchQueue.global(qos:.userInitiated).async { [self] in
            let start=prepareClock();let result=Result{try prepareInput(count)};let elapsed=(prepareClock()-start)*1000
            DispatchQueue.main.async {do{self.input=try result.get();self.inputGenerationMs=elapsed;self.next()}catch{self.fail(error)}}
        }
    }
    func fail(_ error:Error) {job?.cancel();if let sampler=sampler{_=sampler.end()};if let heartbeat=heartbeat{_=heartbeat.end()};sampler=nil;heartbeat=nil;try? engine?.close();engine=nil;job=nil;input=nil;completion(.failure(error))}
    func next() {
        if offset==matrix.count {input=nil;completion(.success(["passed":rows.count,"rows":rows,"storedBars":count,"seed":42,"indicators":prepareNames,"outputs":15,"width":1200,"height":700,"samplesPerInputMode":1,"inputGenerationMsExcluded":inputGenerationMs,"method":"Fresh empty engine + 8 builtins configured before each sample. Columns use identical owned Swift values; sync public setColumns includes array bridge/copies. Seeded sync same-store reset uses Aster.seededColumns; async generates in worker. Generation/validation/store tree/8 indicators/15 output indexes and scene JSON/decode included. Input generation for columns, empty configuration and post-measurement digest excluded. COW ownership time is separate; no eager Swift array copy. No quantiles or display FPS claim.","digestMethod":"Two full Float64-output bit hashes and canonical scene layout/raw last bar; exact 6-column and 15-output vectors independently checked by small prepare fixture. Same-store reset yields matching timeVersion; geometry key is compared without normalization.","memoryMethod":"Independent 5ms whole-process Mach RSS samples, 2s process CPU/RSS trend; peak is a sampling lower bound including retained caller input, idle demo engine and allocator caches.","environment":ProcessInfo.processInfo.operatingSystemVersionString,"physicalDevice":false]));return}
        let (kind,mode)=matrix[offset];status?("\(kind) \(mode) empty setup")
        do {
            let setup=prepareClock(),current=try autoreleasepool{try prepareConfigured(url)};engine=current;let setupMs=(prepareClock()-setup)*1000
            let memory=PrepareProcessSampler(),pulse=PrepareHeartbeat();sampler=memory;heartbeat=pulse;memory.begin();pulse.begin()
            DispatchQueue.main.asyncAfter(deadline:.now()+0.016) { [self] in
                let start=prepareClock();status?("\(kind) \(mode) prepare")
                do {
                    if mode=="sync" {
                        try autoreleasepool {
                            if kind=="columns" {try current.setColumns(prepareDictionary(input!))}else{_=try prepareRead(current,"nativeAPI.setColumns(Aster.seededColumns(\(count),42));true")}
                            _=try current.command("setVisibleRange",[Double(count)-200.5,Double(count)-0.5])
                            let ready=prepareClock();_=try current.scene(width:1200,height:700);collect(kind,mode,current,start,setupMs,(prepareClock()-ready)*1000,nil)
                        }
                    }else{
                        let callback:(Result<AsterAsyncMetrics,Error>)->Void={ [self] result in
                            do {let metrics=try result.get();try autoreleasepool{let ready=prepareClock();_=try current.scene(width:1200,height:700);collect(kind,mode,current,start,setupMs,(prepareClock()-ready)*1000,metrics)}}catch{fail(error)}
                        }
                        let progress:((AsterAsyncProgress)throws->Void)={ [weak self] p in self?.status?("\(kind) async \(p.phase) \(p.done)/\(p.total)") }
                        job=try kind=="columns" ? current.prepareColumnsAsync(input!,timeout:120,progress:progress,completion:callback) : current.prepareSeededAsync(count:count,timeout:120,progress:progress,completion:callback)
                    }
                }catch{fail(error)}
            }
        }catch{fail(error)}
    }
    func collect(_ kind:String,_ mode:String,_ current:AsterEngine,_ start:Double,_ setupMs:Double,_ readyMs:Double,_ metrics:AsterAsyncMetrics?) {
        var row:[String:Any]=["input":kind,"mode":mode,"prepareToReadySceneMs":(prepareClock()-start)*1000,"emptySetupMsExcluded":setupMs,"readySceneJSONDecodeMs":readyMs,"samples":1,"callerInputBytes":input?.retainedBytes ?? 0]
        if let pulse=heartbeat{row.merge(pulse.end()){_,new in new}};if let memory=sampler{row.merge(memory.end()){_,new in new}};heartbeat=nil;sampler=nil
        if let metrics=metrics{row["async"]=prepareMetrics(metrics)}
        do {
            guard let text=try current.call("nativeBenchmarkDigest").toString(),let data=text.data(using:.utf8),let digest=try JSONSerialization.jsonObject(with:data) as? [String:Any],digest["length"] as? Int==count,digest["outputs"] as? Int==15 else{throw AsterError.invalidScene}
            let canonical=try prepareJSON(digest)
            if let expected=references[kind]{guard canonical==expected else{throw AsterError.javaScript("Prepare \(kind) digest/layout/raw-bar mismatch")};row["digestMatchesSync"]=true}else{references[kind]=canonical}
            row["digest"]=digest;row["storeVersion"]=try prepareRead(current,"nativeModel.store.version").toInt32();row["timeVersion"]=try prepareRead(current,"nativeModel.store.timeVersion").toInt32();rows.append(row)
            if let job=job{let held=job._terminalRetentionProbe();guard held.inputBytes==0&&held.callbacks==0&&held.contexts==0 else{throw AsterError.javaScript("Benchmark terminal retention")}}
            try current.close();job=nil;engine=nil;offset += 1;DispatchQueue.main.asyncAfter(deadline:.now()+0.15){self.next()}
        }catch{fail(error)}
    }
}

/// Bounded native operating harness. UI hosts attach/remove real chart views
/// through onEngine before close/drop, so intentional view ownership is absent
/// from the final ARC probes. Background/foreground are external lifecycle
/// events, not simulated sleep; the report distinguishes their heartbeat gaps.
func startNativePrepareSoak(_ url:URL,seconds:Double=180,bars:Int=20000,charts:Int=2,
    status:((String)->Void)?=nil,onEngine:((Int,AsterEngine?)->Void)?=nil,onResize:((Int,Double,Double)->Void)?=nil,
    completion:@escaping(Result<[String:Any],Error>)->Void)->AsterPrepareSoak {
    let harness=AsterPrepareSoak(url,seconds,bars,charts,status,onEngine,onResize,completion);harness.begin();return harness
}
final class AsterPrepareSoak {
    private final class Slot {var engine:AsterEngine?,job:AsterAsyncJob?,operations=0,generation=0}
    private let url:URL,seconds:Double,bars:Int,chartCount:Int,status:((String)->Void)?,onEngine:((Int,AsterEngine?)->Void)?,onResize:((Int,Double,Double)->Void)?,completion:(Result<[String:Any],Error>)->Void
    private var slots:[Slot]=[],input:AsterColumns?,timer:DispatchSourceTimer?,sampler:PrepareProcessSampler?,heartbeat:PrepareHeartbeat?,start=0.0,lastTrend=0.0,ended=false,paused=false,draining=false,drainDeadline=0.0,rotation=0,nextJob=0
    private var jobs:[Int:AsterAsyncJob]=[:],lifecycleCancelled=Set<Int>(),history:[AsterAsyncJob]=[],weakObjects:[PrepareWeak]=[],weakTrend:[[String:Any]]=[],errors:[String]=[],counts:[String:Int]=[:],events:[[String:Any]]=[]
    init(_ url:URL,_ seconds:Double,_ bars:Int,_ charts:Int,_ status:((String)->Void)?,_ onEngine:((Int,AsterEngine?)->Void)?,_ onResize:((Int,Double,Double)->Void)?,_ completion:@escaping(Result<[String:Any],Error>)->Void) {self.url=url;self.seconds=seconds;self.bars=bars;chartCount=charts;self.status=status;self.onEngine=onEngine;self.onResize=onResize;self.completion=completion}
    private func add(_ name:String){counts[name,default:0] += 1}
    private func probe(_ object:AnyObject?,_ kind:String) {guard let object=object,!weakObjects.contains(where:{$0.kind==kind&&$0.object===object}) else{return};weakObjects.append(PrepareWeak(object,kind))}
    private func probe(_ engine:AsterEngine) {probe(engine,"engine");probe(engine.context,"context");probe(engine.context.virtualMachine,"vm");probe(engine._asyncRuntimeLifetimeProbe(),"runtime")}
    private func alive()->[String:Int] {var value:[String:Int]=[:];for p in weakObjects where p.object != nil{value[p.kind,default:0] += 1};return value}
    func begin() {
        precondition(Thread.isMainThread)
        guard seconds.isFinite,seconds>=1,seconds<=3600,bars>=512,bars<=262144,chartCount>=1,chartCount<=4 else{completion(.failure(AsterAsyncError.invalidProtocol("Soak duration/bars/charts")));return}
        status?("Soak input setup")
        DispatchQueue.global(qos:.userInitiated).async { [self] in
            let result=Result{try prepareInput(bars)}
            DispatchQueue.main.async { [self] in
                do {input=try result.get();slots=(0..<chartCount).map{_ in Slot()};start=prepareClock();lastTrend=start;let memory=PrepareProcessSampler(),pulse=PrepareHeartbeat();sampler=memory;heartbeat=pulse;memory.begin();pulse.begin()
                    for i in slots.indices{try recreate(i);try submit(i,"seeded")}
                    let timer=DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now()+0.1,repeating:.milliseconds(100),leeway:.milliseconds(5));timer.setEventHandler { [weak self] in self?.tick() };self.timer=timer;timer.resume()
                }catch{fail(error)}
            }
        }
    }
    private func recreate(_ index:Int)throws {
        let slot=slots[index];retire(index);slot.generation += 1;slot.operations=0
        let source=try autoreleasepool{try prepareConfigured(url)};slot.engine=source;probe(source);onEngine?(index,source);add("engineCreated")
    }
    private func retire(_ index:Int) {
        let slot=slots[index];slot.job?.cancel();slot.job=nil
        // Detach UIKit/AppKit view first; its strong engine field is expected.
        onEngine?(index,nil)
        if let engine=slot.engine {probe(engine);do{try engine.close();try engine.close()}catch{errors.append(String(describing:error))};add("engineClosed")}
        slot.engine=nil
    }
    private func submit(_ index:Int,_ kind:String)throws {
        let slot=slots[index];guard let source=slot.engine,slot.job==nil else{return};probe(source);let generation=slot.generation,id=nextJob;nextJob += 1;var acted=false,terminals=0
        let expectedFailure=["cancel","stale","close"].contains(kind)
        let progress:((AsterAsyncProgress)throws->Void)={ [weak self,weak source] p in
            guard let self=self else{return};guard Thread.isMainThread else{throw AsterError.wrongThread};if let source=source{self.probe(source)}
            self.status?("Soak chart \(index) \(kind) \(p.phase) \(p.done)/\(p.total)")
            if !acted,let source=source {
                if kind=="cancel" {acted=true;self.jobs[id]?.cancel();self.add("cancelRequested")}
                if kind=="stale" {acted=true;let n=Int(try prepareRead(source,"nativeModel.store.length").toInt32());if n>0 {let event=try source.call("nativeBenchmarkEvent",[n-1]).toDictionary() as! [String:Any];try source.applyDataEvent(event)}else{try source.addPanel(["id":"stale-\(id)","weight":1])};self.add("staleRequested")}
            }
        }
        let callback:(Result<AsterAsyncMetrics,Error>)->Void={ [weak self,weak source] result in
            guard let self=self else{return};terminals += 1
            if !Thread.isMainThread||terminals != 1{self.errors.append("Soak terminal owner/count")}
            if let handle=self.jobs.removeValue(forKey:id) {let held=handle._terminalRetentionProbe();if held.inputBytes != 0||held.callbacks != 0||held.contexts != 0{self.errors.append("Completed handle retains payload/callback/context")};self.history.append(handle);if self.history.count>128{self.history.removeFirst()}}
            if slot.generation==generation{slot.job=nil}
            let lifecycleCancelled=self.lifecycleCancelled.remove(id) != nil
            switch result {
            case .success(let metrics):
                self.add("jobSuccess");if expectedFailure{self.errors.append("\(kind) unexpectedly succeeded")}
                if metrics.maximumChunkBytes>2097152{self.errors.append("Soak oversized transfer chunk")}
                if let source=source {self.probe(source);do{_=try source.scene(width:600,height:300);self.add("readyScene")}catch{self.errors.append(String(describing:error))}}
            case .failure(let error):self.add("jobFailure");if !expectedFailure && !lifecycleCancelled && !self.paused && !self.draining{self.errors.append("\(kind): \(error)")}
            }
        }
        let handle:AsterAsyncJob
        if kind=="correction" {
            let n=Int(try prepareRead(source,"nativeModel.store.length").toInt32());guard n>0 else{return};let event=try source.call("nativeBenchmarkEvent",[n/2]).toDictionary() as! [String:Any]
            handle=try source.applyDataEventAsync(event,timeout:120,progress:progress,completion:callback)
        }else if kind=="columns"||kind=="stale" {handle=try source.prepareColumnsAsync(input!,timeout:120,progress:progress,completion:callback)}
        else {handle=try source.prepareSeededAsync(count:bars,timeout:120,progress:progress,completion:callback)}
        slot.job=handle;jobs[id]=handle;add("jobSubmitted")
        if kind=="close"{retire(index)}
    }
    private func append(_ source:AsterEngine)throws {
        guard let last=try source.command("inspect").forProperty("lastBar").toDictionary(),let time=last["time"] as? Double,let close=last["close"] as? Double else{return}
        let next=close+0.01;try source.applyDataEvent(["kind":"append","bar":["time":time+60000,"open":close,"high":max(close,next)+0.1,"low":min(close,next)-0.1,"close":next,"volume":100]]);add("streamAppend")
    }
    private func tick() {
        guard !ended else{return};if draining{pollDrain();return};if prepareClock()-start>=seconds{stop();return};if paused{return}
        do {try autoreleasepool{
            let index=rotation%slots.count;rotation += 1;let slot=slots[index]
            if slot.engine==nil {try recreate(index);try submit(index,"seeded");return}
            guard slot.job==nil,let source=slot.engine else{return};slot.operations += 1
            switch slot.operations%14 {
            case 1:try submit(index,"seeded")
            case 2:try append(source)
            case 3:try submit(index,"correction")
            case 4:
                let id="soak-\(slot.generation)-\(slot.operations)";_=try source.addDrawing(["id":id,"type":"text","points":[["time":1700000000000.0,"price":100]],"text":"Soak 한국"]);try source.editDrawing(id,["text":"changed"]);try source.selectDrawing(id);try source.undo();try source.redo();add("drawingEditUndoRedo")
            case 5:try submit(index,"columns")
            case 6:let n=Int(try prepareRead(source,"nativeModel.store.length").toInt32());if n>0{try source.applyDataEvent(source.call("nativeBenchmarkEvent",[n/2]).toDictionary() as! [String:Any]);add("syncCorrection")}
            case 7:let width=Double(slot.generation%2==0 ? 620 : 540);_=try source.call("nativeResize",[width,300]);onResize?(index,width,300);add("resize")
            case 8:try submit(index,"cancel")
            case 9:
                let drawings=try source.command("inspect").forProperty("drawings").toArray() as? [[String:Any]] ?? [];if let id=drawings.first?["id"] as? String{_=try source.deleteDrawing(id);try source.undo();try source.redo();add("drawingDeleteUndoRedo")}
            case 10:try submit(index,"stale")
            case 11:_=try source.command("zoom",[0.95,0.5]);_=try source.command("pan",[-1]);try source.setTheme(["background":slot.operations%2==0 ? "#152535" : "#0c1320"]);add("panZoomTheme")
            case 12:try append(source);let saved=try source.saveDrawings();try source.loadDrawings(saved);add("drawingSaveLoad")
            case 13:try submit(index,"close")
            default:try recreate(index);try submit(index,"seeded")
            }
            if slot.engine===source,slot.job==nil {let scene=try source.scene(width:600,height:300);guard let context=CGContext(data:nil,width:600,height:300,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{throw AsterError.invalidScene};context.translateBy(x:0,y:300);context.scaleBy(x:1,y:-1);AsterCoreGraphicsRenderer.render(scene,in:context);add("coreGraphicsScene")}
        }}catch{errors.append(String(describing:error));add("operationError")}
        if prepareClock()-lastTrend>=2{lastTrend=prepareClock();weakTrend.append(["elapsedSeconds":lastTrend-start,"aliveARCWeakObjects":alive(),"activeJobs":jobs.count,"operations":counts]);status?("Soak \(Int(lastTrend-start))/\(Int(seconds))s charts \(chartCount)")}
    }
    func backgrounded() {precondition(Thread.isMainThread);guard !ended,!paused else{return};paused=true;heartbeat?.backgrounded();events.append(["event":"background","elapsedSeconds":prepareClock()-start]);add("backgroundEvents");for (id,job) in jobs{lifecycleCancelled.insert(id);job.cancel()}}
    func foregrounded() {precondition(Thread.isMainThread);guard !ended,paused else{return};heartbeat?.foregrounded();paused=false;events.append(["event":"foreground","elapsedSeconds":prepareClock()-start]);add("foregroundEvents")}
    func stop() {
        precondition(Thread.isMainThread);guard !ended,!draining else{return};draining=true;drainDeadline=prepareClock()+5
        for i in slots.indices{retire(i)};input=nil;pollDrain()
    }
    private func pollDrain() {
        guard !ended else{return}
        if jobs.isEmpty&&alive().isEmpty || prepareClock()>=drainDeadline {finish();return}
    }
    private func finish() {
        ended=true;timer?.cancel();timer=nil;var row:[String:Any]=["configuredDurationSeconds":seconds,"elapsedSecondsIncludingDrain":prepareClock()-start,"barsPerPrepare":bars,"charts":chartCount,"seed":42,"operations":counts,"errors":errors,"activeJobsAtEnd":jobs.count,"retainedTerminalHandles":history.count,"weakProbes":weakObjects.count,"aliveARCWeakObjectsAtEnd":alive(),"weakLifetimePass":alive().isEmpty&&jobs.isEmpty,"failed":!errors.isEmpty || !alive().isEmpty || !jobs.isEmpty,"weakLifetimeTrend":weakTrend,"lifecycleEvents":events,"nativeViewHostAttached":onEngine != nil,"method":"100ms rotating chart operations, repeated owned-columns/seeded prepare, append/corrections, cooperative cancellation/stale/close/recreate, drawing edits/history, pan/zoom/theme, resize and CoreGraphics scenes. Actual UI host attaches/removes native views. 8ms main heartbeat records final interval, 5ms independent process RSS and 2s process CPU trend. Weak ARC probes of engine/JSContext/JSVirtualMachine/runtime after close+drop, retaining completed job handles. Nonoptional context retained by an intentionally retained closed engine is separately fixture-tested. CPU samples combine live+terminated thread times and may exceed100%. RSS allocator/GC cache plateau does not establish ARC leakage or return-to-baseline. Actual background/foreground events are supplied by scene lifecycle, never invented.","environment":ProcessInfo.processInfo.operatingSystemVersionString,"physicalDevice":false]
        for handle in history {let held=handle._terminalRetentionProbe();if held.inputBytes != 0||held.callbacks != 0||held.contexts != 0{row["failed"]=true;row["terminalRetentionFailure"]=true}}
        if let memory=sampler{row.merge(memory.end()){_,new in new}};if let pulse=heartbeat{row.merge(pulse.end()){_,new in new}};sampler=nil;heartbeat=nil;completion(.success(row))
    }
    private func fail(_ error:Error) {if ended{return};ended=true;timer?.cancel();timer=nil;for i in slots.indices{retire(i)};if let memory=sampler{_=memory.end()};if let pulse=heartbeat{_=pulse.end()};sampler=nil;heartbeat=nil;input=nil;completion(.failure(error))}
}
