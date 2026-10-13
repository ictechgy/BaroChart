import Foundation
import AsterNative

let resource=CommandLine.arguments.dropFirst().first.map{URL(fileURLWithPath:$0)}
func engine()throws->AsterEngine {if let url=resource{return try AsterEngine(bundleURL:url,count:0,options:["series":[]])};return try AsterEngine(count:0,options:["series":[]])}
var checks:[String]=[]
func check(_ value:Bool,_ label:String)throws{if !value{throw NSError(domain:label,code:1)};checks.append(label)}
func wait(_ ready:()->Bool)throws{let until=ProcessInfo.processInfo.systemUptime+15;while !ready()&&ProcessInfo.processInfo.systemUptime<until{_ = RunLoop.current.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))};try check(ready(),"Owned asynchronous completion arrived")}
do{
 let source=try engine(),restored=try engine();defer{try? source.close();try? restored.close()}
 let local=resource != nil,id=local ? "local.volume-balance":"aster.volume-direction",name=try source.registerIndicatorModule(id,version:1)[0],output=local ? "value":"signed"
 let bars=[10.0,11,11,9].enumerated().map{i,p in AsterBar(time:1700000000000+Double(i)*60000,open:p,high:p,low:p,close:p,volume:[5.0,7,8,9][i])}
 try source.setData(bars);try restored.setData(bars);_ = try source.addIndicator("study",name,local ? ["period":2,"shift":-2]:["factor":1,"shift":-2]);try source.addSeries(["id":"study-line","type":"line","panel":"price","indicator":"study","output":output])
 let expected=local ? [0.0,14/3.0,14/9.0,-148/27.0]:[0,7,0,-9]
 for i in 0..<4{let point=try source.indicatorValueAt("study",output:output,index:i,options:["asOfIndex":i]);try check(abs((point["value"] as! NSNumber).doubleValue-expected[i])<1e-12,"Independent raw output \(i)")}
 let future=try source.indicatorValueAt("study",output:output,index:0,options:["mode":"plot","asOfIndex":0]);try check(future["value"] is NSNull&&future["sourceIndex"] is NSNull&&future["sourceTime"] is NSNull,"Shift hides future values and metadata")
 let saved=try source.saveStudies(),counts=try restored.loadStudies(saved);try check(counts["indicators"] as? Int==1&&counts["series"] as? Int==1,"Exact module setup imports into matching SDK resource container");try check(try restored.saveStudies()==saved,"Default style/module document roundtrip")
 var result:Result<AsterAsyncMetrics,Error>?;let job=try source.applyDataEventAsync(["kind":"correction","bar":["time":bars[1].time,"open":12.0,"high":12.0,"low":12.0,"close":12.0,"volume":7.0]]){result=$0};try wait{result != nil};_ = try result!.get();_ = job
 let corrected=try source.indicatorValueAt("study",output:output,index:2);try check(abs((corrected["value"] as! NSNumber).doubleValue-(local ? -34/9.0:-8))<1e-12,"Isolated native worker uses the same linked factory and codec")
 try source.close();var rejected=false;do{_ = try source.observeChanges{}}catch AsterAsyncError.engineClosed{rejected=true};try check(rejected,"Packaged closed engine rejects observer registration")
 let report:[String:Any]=["passed":checks.count,"checks":checks,"module":name,"customLocalResource":local,"scope":"Fresh SwiftPM consumer; local/default resource, public typed API and actual isolated JSC async correction. No UI or latency measurement."]
 print(String(data:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
}catch{fputs("Study consumer failed: \(error)\n",stderr);exit(1)}
