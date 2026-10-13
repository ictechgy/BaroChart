import Foundation

private func correctionClock() -> Double {ProcessInfo.processInfo.systemUptime}
private func correctionRSS() -> UInt64 {
    var info=mach_task_basic_info(),count=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<natural_t>.size)
    let code=withUnsafeMutablePointer(to:&info) {pointer in pointer.withMemoryRebound(to:integer_t.self,capacity:Int(count)) {task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&count)}}
    return code == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}
private func correctionCanonical(_ object:Any)throws->String {String(data:try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]),encoding:.utf8)!}

// This sampler runs independently of the UI queue, including while synchronous
// JavaScript blocks it. It samples process RSS, not one VM; 5ms is a lower bound
// on the actual peak and includes the demo's idle engine and runtime caches.
private final class CorrectionRSSSampler {
    private let queue=DispatchQueue(label:"Aster benchmark process RSS",qos:.utility),lock=NSLock()
    private var timer:DispatchSourceTimer?,active=false,baseline:UInt64=0,peak:UInt64=0,samples=0
    func start() {
        precondition(Thread.isMainThread)
        baseline=correctionRSS();peak=baseline;samples=1;active=true
        let timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now(),repeating:.milliseconds(5),leeway:.milliseconds(1));timer.setEventHandler { [weak self] in self?.sample() };self.timer=timer;timer.resume()
    }
    private func sample() {let rss=correctionRSS();lock.lock();if active {peak=max(peak,rss);samples += 1};lock.unlock()}
    func stop()->[String:Any] {
        precondition(Thread.isMainThread)
        timer?.cancel();timer=nil;queue.sync {sample()}
        let end=correctionRSS();lock.lock();active=false;peak=max(peak,end);let baseline=baseline,peak=peak,samples=samples;lock.unlock()
        return ["baselineResidentBytes":baseline,"sampledPeakResidentBytes":peak,"sampledPeakDeltaBytes":peak-baseline,"endResidentBytes":end,"rssSamples":samples,"rssSampleIntervalMs":5,"rssAvailable":baseline>0,"rssSamplingLowerBound":true]
    }
    deinit {timer?.cancel()}
}
private final class CorrectionHeartbeat {
    private var timer:DispatchSourceTimer?,last=0.0,gaps:[Double]=[],beats=0
    func start() {precondition(Thread.isMainThread);last=correctionClock();gaps=[];beats=0
        let timer=DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now(),repeating:.milliseconds(8));timer.setEventHandler { [weak self] in
            guard let self=self else{return};let now=correctionClock();self.gaps.append((now-self.last)*1000);self.last=now;self.beats += 1
        };self.timer=timer;timer.resume()
    }
    func stop()->[String:Any] {precondition(Thread.isMainThread)
        // Record the final interval even if a long synchronous operation ends
        // before the delayed timer callback can execute.
        gaps.append((correctionClock()-last)*1000);timer?.cancel();timer=nil
        return ["heartbeatIntervalMs":8,"heartbeatCount":beats,"maximumHeartbeatGapMs":gaps.max() ?? 0,"heartbeatGapsOver50Ms":gaps.filter {$0>=50}.count]
    }
    deinit {timer?.cancel()}
}

/// One sample per mode/position. The 1m full-vector hash comparison supplements
/// the separate small-fixture exact byte comparison; hashes are not a proof of
/// exact equality and this benchmark does not measure display FPS.
func benchmarkNativeCorrections(_ bundleURL:URL,count:Int=1000000,status:((String)->Void)?=nil,completion:@escaping(Result<[String:Any],Error>)->Void) {
    CorrectionBenchmark(bundleURL,count,status,completion).run()
}
private final class CorrectionBenchmark {
    let url:URL,count:Int,status:((String)->Void)?,completion:(Result<[String:Any],Error>)->Void
    let names=["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]
    let matrix=[("first","sync"),("first","async"),("middle","sync"),("middle","async"),("tail","sync"),("tail","async")]
    var offset=0,rows:[[String:Any]]=[],reference:[String:String]=[:],engine:AsterEngine?,job:AsterAsyncJob?,sampler:CorrectionRSSSampler?,heartbeat:CorrectionHeartbeat?
    init(_ url:URL,_ count:Int,_ status:((String)->Void)?,_ completion:@escaping(Result<[String:Any],Error>)->Void) {self.url=url;self.count=count;self.status=status;self.completion=completion}
    func run() {guard Thread.isMainThread,count>=512,count<=4194304 else{completion(.failure(AsterAsyncError.invalidProtocol("Benchmark main owner/count")));return};next()}
    func failure(_ error:Error) {job?.cancel();if let heartbeat=heartbeat {_=heartbeat.stop()};if let sampler=sampler {_=sampler.stop()};heartbeat=nil;sampler=nil;job=nil;engine=nil;completion(.failure(error))}
    func next() {
        if offset==matrix.count {
            completion(.success(["passed":rows.count,"parityPairs":reference.count,"rows":rows,"storedBars":count,"seed":42,"indicators":names,"outputs":15,"width":1200,"height":700,"samplesPerPositionMode":1,"method":"Fresh engine and identical synthetic data/indicators/position per row. Initial data+indicator+range setup, digest/reference verification and100ms inter-row retirement gap excluded. Sync apply+scene JSON/decode versus async capture+isolated computation+owner handoff+same scene JSON/decode. No quantiles, display FPS, confidence interval or physical-device claim.","digestMethod":"Two noncryptographic32-bit hashes of every output Float64 bit, plus canonical JSON scene layout/last bar and corrected raw bar. Exact full vectors separately tested in native async fixture.","memoryMethod":"Independent background5ms process Mach RSS sampler including idle demo engine/runtime caches. Sampled peak is a lower bound; no isolated VM footprint claim.","environment":ProcessInfo.processInfo.operatingSystemVersionString,"physicalDevice":false]));return
        }
        let (position,mode)=matrix[offset],index=position=="first" ? 0 : position=="middle" ? count/2 : count-1
        status?("\(position) \(mode): setup")
        do {
            let setup=correctionClock()
            let current=try AsterEngine(bundleURL:url,count:count,options:["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]])
            for name in names {_=try current.call("nativeIndicator",[name,name,[:],"price"])}
            _=try current.scene(width:1200,height:700)
            let setupMs=(correctionClock()-setup)*1000
            guard let event=try current.call("nativeBenchmarkEvent",[index]).toDictionary() as? [String:Any] else{throw AsterError.invalidScene}
            engine=current
            let memory=CorrectionRSSSampler(),pulse=CorrectionHeartbeat();sampler=memory;heartbeat=pulse;memory.start();pulse.start()
            // Allow pre-operation heartbeats without including this delay in wall
            // time. Both modes use the same timer/independent memory sampler.
            DispatchQueue.main.asyncAfter(deadline:.now()+0.016) { [self] in
                let start=correctionClock();status?("\(position) \(mode): correction")
                do {
                    if mode=="sync" {
                        try current.applyDataEvent(event)
                        let readyStart=correctionClock();_=try current.scene(width:1200,height:700);let readyMs=(correctionClock()-readyStart)*1000
                        collect(current,position,mode,index,event,setupMs,start,readyMs,nil)
                    } else {
                        job=try current.applyDataEventAsync(event,timeout:120,progress:{ [weak self] value in self?.status?("\(position) async: \(value.phase) \(value.done)/\(value.total)") }) { [self] result in
                            do {guard Thread.isMainThread else{throw AsterError.wrongThread};let metrics=try result.get(),readyStart=correctionClock();_=try current.scene(width:1200,height:700);let readyMs=(correctionClock()-readyStart)*1000;collect(current,position,mode,index,event,setupMs,start,readyMs,metrics)} catch{failure(error)}
                        }
                    }
                } catch{failure(error)}
            }
        } catch{failure(error)}
    }
    func collect(_ current:AsterEngine,_ position:String,_ mode:String,_ index:Int,_ event:[String:Any],_ setupMs:Double,_ start:Double,_ readyMs:Double,_ metrics:AsterAsyncMetrics?) {
        let wallMs=(correctionClock()-start)*1000
        var row:[String:Any]=["position":position,"mode":mode,"index":index,"setupMsExcluded":setupMs,"correctionToReadySceneMs":wallMs,"readySceneJSONDecodeMs":readyMs,"event":event,"samples":1]
        if let heartbeat=heartbeat {row.merge(heartbeat.stop()){_,new in new}};if let sampler=sampler {row.merge(sampler.stop()){_,new in new}};heartbeat=nil;sampler=nil
        if let metrics=metrics {
            let attributed=metrics.beginMs+metrics.workerInitMs+metrics.captureMs+metrics.targetCopyMs+metrics.queueWaitMs+metrics.computeMs+metrics.uiStateMs+metrics.finishMs+metrics.commitMs
            row["async"]=["wallToCallbackMs":metrics.totalMs,"beginMs":metrics.beginMs,"workerInitMs":metrics.workerInitMs,"captureMs":metrics.captureMs,"targetCopyAndCheckpointImportMs":metrics.targetCopyMs,"queueWaitMs":metrics.queueWaitMs,"calculateAndIndicesMs":metrics.computeMs,"ownerUIStateMs":metrics.uiStateMs,"ownerFinishMs":metrics.finishMs,"ownerCommitAndCleanupMs":metrics.commitMs,"unattributedWallMs":max(0,metrics.totalMs-attributed),"copiedBytes":metrics.copiedBytes,"checkpointJSONBytes":metrics.checkpointJSONBytes,"maximumChunkBytes":metrics.maximumChunkBytes,"boundarySampledPeakResidentBytes":metrics.peakResidentBytes,"boundaryBaselineResidentBytes":metrics.baselineResidentBytes,"progressCallbackErrors":metrics.progressCallbackErrors]
        }
        do {
            guard let text=try current.call("nativeBenchmarkDigest").toString(),let bytes=text.data(using:.utf8),let digest=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],digest["outputs"] as? Int==15,digest["length"] as? Int==count,let corrected=try current.call("nativeBenchmarkEvent",[index]).forProperty("bar").toDictionary() else{throw AsterError.invalidScene}
            let canonical=try correctionCanonical(["digest":digest,"correctedBar":corrected])
            if let reference=reference[position] {guard canonical==reference else{throw AsterError.javaScript("Correction digest/layout/raw-bar mismatch at \(position)")};row["digestMatchesSync"]=true} else {reference[position]=canonical}
            row["digest"]=digest;row["correctedBar"]=corrected;rows.append(row)
            job=nil;engine=nil;offset += 1
            DispatchQueue.main.asyncAfter(deadline:.now()+0.1) {self.next()}
        } catch{failure(error)}
    }
}
