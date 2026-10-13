import UIKit
import QuartzCore

// PRIVATE TEST HARNESS ONLY. Injected into a byte-copied AsterUIKit.swift at
// matching draw locations. It is not a production SDK API. A 900s candidate
// trace is not compared to a shorter baseline and does not measure presentation.
final class Cycle12Probe {
    static weak var current:Cycle12Probe?
    static func clock()->Double {CACurrentMediaTime()}
    static func beginDraw(_ view:AsterChartView)->Double? {guard current?.measuring==true else{return nil};return clock()}
    static func endDraw(_ view:AsterChartView,_ start:Double?) {guard let start=start,let probe=current else{return};probe.draw(view,start:start,end:clock())}
    struct Frame {let start,end:Double,inputEpoch:UInt64,revision:UInt64}
    struct Input {let entered,returned,oldest,newest:Double,epoch:UInt64,count:Int}
    private(set) var frames:[Frame]=[],inputs:[Input]=[],heartbeats:[Double]=[],errors:[String]=[]
    private(set) var measuring=false,start=0.0,end=0.0,inputEpoch:UInt64=0,lastCompletedInput:UInt64=0,supersededInputs=0
    private var heartbeat:DispatchSourceTimer?,lastBeat=0.0
    let recordLimit=180000
    func begin(){precondition(Thread.isMainThread);start=Self.clock();lastBeat=start;measuring=true;Self.current=self
        frames.removeAll(keepingCapacity:true);inputs.removeAll(keepingCapacity:true);heartbeats.removeAll(keepingCapacity:true);errors.removeAll();inputEpoch=0;lastCompletedInput=0;supersededInputs=0
        let timer=DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now() + .milliseconds(8),repeating:.milliseconds(8));timer.setEventHandler{[weak self] in self?.beat()};heartbeat=timer;timer.resume()}
    private func beat(){guard measuring else{return};let now=Self.clock();if heartbeats.count<recordLimit{heartbeats.append((now-lastBeat)*1000)}else if errors.isEmpty{errors.append("Heartbeat trace limit")};lastBeat=now}
    func inputEntered()->UInt64 {guard measuring else{return 0};inputEpoch &+= 1;return inputEpoch}
    func inputReturned(epoch:UInt64,entered:Double,returned:Double,timestamps:[Double]) {guard measuring,epoch>0,!timestamps.isEmpty else{return};guard inputs.count<recordLimit else{errors.append("Input trace limit");return};inputs.append(Input(entered:entered,returned:returned,oldest:timestamps.min()!,newest:timestamps.max()!,epoch:epoch,count:timestamps.count))}
    private func draw(_ view:AsterChartView,start:Double,end:Double){guard measuring else{return};guard frames.count<recordLimit else{errors.append("Frame trace limit");return};if inputEpoch>lastCompletedInput{if inputEpoch>lastCompletedInput+1{supersededInputs+=Int(inputEpoch-lastCompletedInput-1)};lastCompletedInput=inputEpoch};frames.append(Frame(start:start,end:end,inputEpoch:inputEpoch,revision:view.renderedRevision))}
    func stop(){precondition(Thread.isMainThread);if measuring{beat();end=Self.clock()};measuring=false;heartbeat?.cancel();heartbeat=nil;Self.current=nil}
    func report()->[String:Any] {precondition(Thread.isMainThread)
        func stats(_ values:[Double])->[String:Any]{guard !values.isEmpty else{return ["samples":0]};let a=values.sorted();return ["samples":a.count,"p50":a[min(a.count-1,Int(Double(a.count)*0.50))],"p95":a[min(a.count-1,Int(Double(a.count)*0.95))],"p99":a[min(a.count-1,Int(Double(a.count)*0.99))],"max":a.last!]}
        var seen=Set<UInt64>(),latency:[Double]=[];let lookup=Dictionary(uniqueKeysWithValues:inputs.map{($0.epoch,$0.entered)})
        for frame in frames where frame.inputEpoch>0 && !seen.contains(frame.inputEpoch){seen.insert(frame.inputEpoch);if let entered=lookup[frame.inputEpoch]{latency.append((frame.end-entered)*1000)}}
        return ["schema":"aster.cycle12.private-draw-probe","elapsedSeconds":end-start,"inputEvents":inputs.count,"frames":frames.count,"supersededInputs":supersededInputs,"errors":errors,"drawCPUSectionWallMs":stats(frames.map{($0.end-$0.start)*1000}),"osTouchAgeAtDispatchMs":stats(inputs.map{($0.entered-$0.oldest)*1000}),"negativeTouchAgeSamples":inputs.filter{$0.entered<$0.newest}.count,"windowSendEventWallMs":stats(inputs.map{($0.returned-$0.entered)*1000}),"latestInputToCPUSectionCompletionMs":stats(latency),"mainHeartbeatGapMs":stats(heartbeats),"gapsOver50Ms":heartbeats.filter{$0>=50}.count,"rawInput":inputs.map{["entered":$0.entered,"returned":$0.returned,"oldestTouchTimestamp":$0.oldest,"newestTouchTimestamp":$0.newest,"epoch":$0.epoch,"touches":$0.count] as [String:Any]},"rawFrames":frames.map{["start":$0.start,"end":$0.end,"inputEpoch":$0.inputEpoch,"revision":$0.revision] as [String:Any]},"rawHeartbeatMs":heartbeats,"boundary":"Public actual UIWindow delivery + test-only same-location draw hook; CPU-section wall time, not GPU/presentation/physical input; coalesced inputs counted once"]
    }
    deinit{heartbeat?.cancel()}
}
final class Cycle12Window:UIWindow {
    weak var probe:Cycle12Probe?
    private(set) var activeTouchIDs=Set<ObjectIdentifier>()
    override func sendEvent(_ event:UIEvent){let relevant=(event.allTouches ?? []).filter{$0.view is AsterChartView && $0.phase != .stationary};let entered=Cycle12Probe.clock(),epoch=relevant.isEmpty ? 0:probe?.inputEntered() ?? 0
        for touch in relevant where touch.phase == .began{activeTouchIDs.insert(ObjectIdentifier(touch))}
        super.sendEvent(event)
        for touch in relevant where touch.phase == .ended||touch.phase == .cancelled{activeTouchIDs.remove(ObjectIdentifier(touch))}
        probe?.inputReturned(epoch:epoch,entered:entered,returned:Cycle12Probe.clock(),timestamps:relevant.map{$0.timestamp})
    }
}

// Whole-process samples; not per-VM usage or a leak detector. Peak is a lower
// bound. Raw traces/owned input/caches remain part of this process footprint.
final class Cycle12ProcessSampler {
    private let queue=DispatchQueue(label:"Cycle12 process samples",qos:.utility),lock=NSLock()
    private var timer:DispatchSourceTimer?,rows:[[String:Double]]=[]
    static func snapshot()->[String:Double]{var basic=mach_task_basic_info(),n=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<natural_t>.size)
        let a=withUnsafeMutablePointer(to:&basic){$0.withMemoryRebound(to:integer_t.self,capacity:Int(n)){task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&n)}}
        var live=task_thread_times_info();n=mach_msg_type_number_t(MemoryLayout<task_thread_times_info>.size/MemoryLayout<natural_t>.size)
        let b=withUnsafeMutablePointer(to:&live){$0.withMemoryRebound(to:integer_t.self,capacity:Int(n)){task_info(mach_task_self_,task_flavor_t(TASK_THREAD_TIMES_INFO),$0,&n)}}
        func seconds(_ t:time_value_t)->Double{Double(t.seconds)+Double(t.microseconds)/1000000}
        return ["sampledAt":ProcessInfo.processInfo.systemUptime,"residentBytes":a==KERN_SUCCESS ? Double(basic.resident_size) : -1,"processCPUSeconds":a==KERN_SUCCESS&&b==KERN_SUCCESS ? seconds(basic.user_time)+seconds(basic.system_time)+seconds(live.user_time)+seconds(live.system_time) : -1]
    }
    func start(){let timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now(),repeating:.milliseconds(100),leeway:.milliseconds(5));timer.setEventHandler{[weak self] in guard let self=self else{return};let row=Self.snapshot();self.lock.lock();if self.rows.count<18000{self.rows.append(row)};self.lock.unlock()};self.timer=timer;timer.resume()}
    func stop()->[String:Any]{timer?.cancel();timer=nil;queue.sync{};lock.lock();let values=rows;lock.unlock();return ["intervalMs":100,"samples":values,"sampledPeakResidentBytes":values.map{$0["residentBytes"] ?? -1}.max() ?? -1,"peakIsSamplingLowerBound":true,"boundary":"Whole process; live+terminated thread CPU reads are separate/non-atomic;100% can be exceeded"]}
    deinit{timer?.cancel()}
}
