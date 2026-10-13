import Foundation
import JavaScriptCore
import CryptoKit
var initialHostPhases: [String: Double] = [:]
func profileClock()->Double {ProcessInfo.processInfo.systemUptime}
func profileRSS()->UInt64 {var info=mach_task_basic_info(),count=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<natural_t>.size);let code=withUnsafeMutablePointer(to:&info){p in p.withMemoryRebound(to:integer_t.self,capacity:Int(count)){task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&count)}};return code==KERN_SUCCESS ? UInt64(info.resident_size):0}
final class RSSSampler {let queue=DispatchQueue(label:"Initial RSS",qos:.utility),lock=NSLock();var timer:DispatchSourceTimer?,peak:UInt64=0,baseline:UInt64=0,samples=0;func start(){baseline=profileRSS();peak=baseline;samples=1;let t=DispatchSource.makeTimerSource(queue:queue);t.schedule(deadline:.now(),repeating:.milliseconds(5));t.setEventHandler{[weak self]in guard let self=self else{return};let r=profileRSS();self.lock.lock();self.peak=max(self.peak,r);self.samples+=1;self.lock.unlock()};timer=t;t.resume()};func stop()->[String:Any]{timer?.cancel();timer=nil;queue.sync{};let end=profileRSS();lock.lock();defer{lock.unlock()};peak=max(peak,end);return ["baselineResidentBytes":baseline,"sampledPeakResidentBytes":peak,"sampledPeakDeltaBytes":peak-baseline,"endResidentBytes":end,"rssSamples":samples,"rssIntervalMs":5,"sampledPeakLowerBound":true]}}
final class Heartbeat {var timer:DispatchSourceTimer?,last=0.0,gaps:[Double]=[],beats=0;func start(){last=profileClock();let t=DispatchSource.makeTimerSource(queue:.main);t.schedule(deadline:.now(),repeating:.milliseconds(8));t.setEventHandler{[weak self]in guard let self=self else{return};let now=profileClock();self.gaps.append((now-self.last)*1000);self.last=now;self.beats+=1};timer=t;t.resume()};func stop()->[String:Any]{gaps.append((profileClock()-last)*1000);timer?.cancel();timer=nil;return ["heartbeatIntervalMs":8,"heartbeatCount":beats,"maximumHeartbeatGapMs":gaps.max() ?? 0,"heartbeatGapsOver50Ms":gaps.filter{$0>=50}.count,"includesFinalBlockingInterval":true]}}
guard CommandLine.arguments.count==3 else {fatalError("Usage: initial-prepare OUTPUT_JSON CORE_BUNDLE")}
let path=CommandLine.arguments[1],bundle=URL(fileURLWithPath:CommandLine.arguments[2])
let names=["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"],sampler=RSSSampler(),heartbeat=Heartbeat();var complete=false,failed=false,engine:AsterEngine?,job:AsterAsyncJob?,phases=[[String:Any]]()
func jsonObject(_ text:String)throws->Any {try JSONSerialization.jsonObject(with:Data(text.utf8))}
func fail(_ error:Error){sampler.timer?.cancel();heartbeat.timer?.cancel();try? engine?.close();engine=nil;job=nil;failed=true;complete=true;print("FAIL: \(error)")}
sampler.start();heartbeat.start()
DispatchQueue.main.asyncAfter(deadline:.now()+0.048){
 do {
  let start=profileClock();engine=try AsterEngine(bundleURL:bundle,count:0,options:["panels":[["id":"price","weight":1]],"series":[]]);let initialized=profileClock()
  for name in names {_ = try engine!.call("nativeIndicator",[name,name,[String:Any](),"price"])}
  let configured=profileClock()
  job=try engine!.prepareSeededAsync(count:1000000,seed:42,visibleBars:200,timeout:120,progress:{p in
   if phases.last?["phase"] as? String != p.phase {phases.append(["phase":p.phase,"elapsedMs":(profileClock()-start)*1000])}
  },completion:{result in
   do {
    let metrics=try result.get();guard let engine=engine else{throw AsterError.invalidScene}
    let beginScene=profileClock(),value=try engine.call("nativeSceneJSON",[1200,700]),sceneCallDone=profileClock();guard let text=value.toString() else{throw AsterError.invalidScene};let stringDone=profileClock();let data=Data(text.utf8),dataDone=profileClock();let scene=try JSONDecoder().decode(AsterScene.self,from:data),decoded=profileClock()
    var report:[String:Any]=["timestamp":ISO8601DateFormatter().string(from:Date()),"version":"0.2.4","host":"macOS JavaScriptCore","platform":ProcessInfo.processInfo.operatingSystemVersionString,"bars":1000000,"seed":42,"indicators":names,"outputs":15,"width":1200,"height":700,"freshProcess":true,"wallToFirstDecodedSceneMs":(decoded-start)*1000,"engineInitTotalMs":(initialized-start)*1000,"emptyIndicatorAndSeriesMs":(configured-initialized)*1000,"firstSceneCallMs":(sceneCallDone-beginScene)*1000,"sceneStringBridgeMs":(stringDone-sceneCallDone)*1000,"sceneUTF8Ms":(dataDone-stringDone)*1000,"sceneHostJSONDecodeMs":(decoded-dataDone)*1000,"sceneJSONBytes":data.count,"sceneCommands":scene.commands.count,"sceneStats":scene.stats,"phaseTransitions":phases,"method":"Same initial-baseline fixture: one price panel/weight1, fifteen indicator lines/no candle series, recent200, first decoded scene endpoint. Empty source core init/config and isolated worker create/generate/validate/calculate/index/install included. 8ms owner heartbeat finalinterval; independent5ms whole-process RSS sampler. Fresh app/runtime process; OS caches not flushed; post-timing verification excluded; no display/FPS."]
    report.merge(heartbeat.stop()){_,b in b};report.merge(sampler.stop()){_,b in b}
    report["asyncMetrics"]=["totalMs":metrics.totalMs,"beginMs":metrics.beginMs,"workerInitMs":metrics.workerInitMs,"captureMs":metrics.captureMs,"targetCopyMs":metrics.targetCopyMs,"computeMs":metrics.computeMs,"uiStateMs":metrics.uiStateMs,"finishMs":metrics.finishMs,"commitMs":metrics.commitMs,"queueWaitMs":metrics.queueWaitMs,"retainedInputBytes":metrics.retainedInputBytes,"copiedBytes":metrics.copiedBytes,"maximumChunkBytes":metrics.maximumChunkBytes]
    engine.context.evaluateScript("""
    globalThis.nativeInitialRawRows=function(){return JSON.stringify([0,1,19,255,256,499999,500000,999998,999999].map(i=>({index:i,...nativeModel.store.at(i)})));};
    globalThis.nativeInitialRawHash=function(){let a=2166136261,b=2246822519;for(const k of Aster.FIELDS){const data=nativeModel.store.columns[k],bits=new Uint32Array(data.buffer,data.byteOffset,nativeModel.store.length*2);for(let i=0;i<bits.length;i++){a=Math.imul(a^bits[i],16777619)>>>0;b=(Math.imul(b^bits[i],3266489917)+374761393)>>>0;}}return JSON.stringify({hashes:[a,b],fields:Aster.FIELDS,length:nativeModel.store.length});};
    """)
    if let error=engine.context.exception{throw AsterError.javaScript(error.toString() ?? "Verification helper error")}
    let verify=profileClock();report["outputVectorDigest"]=try jsonObject(engine.call("nativeBenchmarkDigest").toString()!);report["rawVectorDigest"]=try jsonObject(engine.call("nativeInitialRawHash").toString()!);report["rawRows"]=try jsonObject(engine.call("nativeInitialRawRows").toString()!);report["verificationExcludedMs"]=(profileClock()-verify)*1000
    try engine.close();report["closedRetainedEngineRSS"]=profileRSS()
    let output=try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys,.prettyPrinted]);try output.write(to:URL(fileURLWithPath:path));print(String(data:output,encoding:.utf8)!);complete=true;job=nil
   }catch{fail(error)}
  })
 }catch{fail(error)}
}
let deadline=profileClock()+180
while !complete && profileClock()<deadline {_ = RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}
try? engine?.close();engine=nil;job=nil
if failed || !complete {exit(1)}
