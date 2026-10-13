import Foundation

private func nativeStudyJSON(_ text:String)throws->Data {
    try JSONSerialization.data(withJSONObject:JSONSerialization.jsonObject(with:Data(text.utf8)),options:[.sortedKeys])
}
private func nativeStudyObject(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}

/// Small real-feed facade fixture. Mathematical/DST golden cases additionally
/// run in the shared isolated JavaScriptCore helper; they do not reset this VM's
/// live model. The sample module is a close-direction proxy, not bid/ask delta.
func verifyNativeStudies(_ bundleURL:URL)throws->[String:Any] {
    let source=try AsterEngine(bundleURL:bundleURL,count:0,options:["panels":[["id":"price"],["id":"study-volume"]],"series":[]])
    defer{try? source.close()}
    var checks:[String]=[]
    func require(_ value:Bool,_ message:String)throws{guard value else{throw AsterError.javaScript(message)};checks.append(message)}
    let untouched=try nativeStudyObject(source.command("inspect").toDictionary()!)
    let shared=try source.call("nativeStudyVerification").toDictionary()!
    try require((shared["passed"] as? Int ?? 0)>0,"Shared literal/DST study golden cases pass in JavaScriptCore")
    try require(try nativeStudyObject(source.command("inspect").toDictionary()!)==untouched,"Isolated study helper preserves the live native model")
    let names=try source.registerIndicatorModule("aster.volume-direction",version:1)
    try require(names==["aster.volume-direction@1/pressure"],"Swift selector returns canonical module names")
    let date=ISO8601DateFormatter().date(from:"2024-03-11T13:29:00Z")!.timeIntervalSince1970*1000
    let close:[Double]=[10,12,11,11,13,12,14,14],volume:[Double]=[100,200,300,400,500,600,700,800]
    let bars=close.enumerated().map{i,c in AsterBar(time:date+Double(i)*60000,open:c,high:c+1,low:c-1,close:c,volume:volume[i])}
    try source.setData(bars);try source.addSeries(["id":"base-candles","type":"candles","panel":"price"])
    let calendar=String(data:try nativeStudyObject(["timezone":"America/New_York","weekdays":[1,2,3,4,5],"windows":[["open":"09:30","close":"16:00","kind":"regular"]],"exceptions":[:]]),encoding:.utf8)!
    let vwap=try source.addIndicator("ny-vwap","vwap",["calendar":calendar,"deviation":2,"source":"close"])
    guard let outputs=vwap.forProperty("outputs")?.toArray() as? [String] else{throw AsterError.invalidScene}
    try require(outputs.count>=3,"Session VWAP exposes its centre and deviation bands")
    for output in outputs{try source.addSeries(["id":"vwap-"+output,"type":"line","panel":"price","indicator":"ny-vwap","output":output])}
    _=try source.addIndicator("pressure","aster.volume-direction@1/pressure",["factor":0.5,"shift":1])
    for output in ["signed","cumulative"]{try source.addSeries(["id":"pressure-"+output,"type":output=="signed" ? "histogram" : "line","panel":"study-volume","indicator":"pressure","output":output,"label":"Close-direction proxy "+output])}
    let expected:[String:[Double]]=["signed":[0,100,-150,0,250,-300,350,0],"cumulative":[0,100,-50,-50,200,-100,250,250]]
    var callbacks=0;let token=try source.observeChanges{callbacks+=1},revision=source.revision
    for output in ["signed","cumulative"]{for i in bars.indices{
        let raw=try source.indicatorValueAt("pressure",output:output,index:i,options:["mode":"raw","asOfIndex":i])
        try require(raw["value"] as? Double==expected[output]![i]&&raw["sourceIndex"] as? Int==i&&raw["sourceTime"] as? Double==bars[i].time,"\(output) raw sample \(i) and exact source metadata")
    }}
    let plot=try source.indicatorValueAt("pressure",output:"signed",index:3,options:["mode":"plot","asOfIndex":2])
    try require(plot["value"] as? Double == -150&&plot["sourceIndex"] as? Int==2&&plot["sourceTime"] as? Double==bars[2].time,"Plot shift maps to the past raw source sample")
    let future=try source.indicatorValueAt("pressure",output:"signed",index:4,options:["mode":"plot","asOfIndex":2])
    try require(future["value"] is NSNull&&future["sourceIndex"] is NSNull&&future["sourceTime"] is NSNull,"As-of query masks unavailable future value and metadata")
    let saved=try source.saveStudies()
    try require(source.revision==revision&&callbacks==0,"saveStudies and indicatorValueAt preserve revision and observers")
    try source.removeObserver(token)
    let clone=try AsterEngine(bundleURL:bundleURL,count:0,options:["panels":[["id":"price"],["id":"study-volume"]],"series":[]])
    defer{try? clone.close()};try clone.setData(bars);_=try clone.registerIndicatorModule("aster.volume-direction",version:1)
    let imported=try clone.loadStudies(saved)
    try require(imported["indicators"] as? Int==2&&imported["series"] as? Int==outputs.count+2,"Atomic additive study import returns precise definition/series counts")
    try require(try nativeStudyJSON(clone.saveStudies())==nativeStudyJSON(saved),"Saved definitions and study series round-trip structurally")
    for output in ["signed","cumulative"]{for i in bars.indices{
        let a=try source.indicatorValueAt("pressure",output:output,index:i),b=try clone.indicatorValueAt("pressure",output:output,index:i)
        try require(try nativeStudyObject(a)==nativeStudyObject(b),"Imported \(output) sample \(i) is exact")
    }}
    let beforeDuplicate=try clone.saveStudies(),duplicateRevision=clone.revision
    var duplicateRejected=false;do{_=try clone.loadStudies(saved)}catch AsterError.javaScript{duplicateRejected=true}
    let afterDuplicate=try clone.saveStudies()
    try require(duplicateRejected&&clone.revision==duplicateRevision&&afterDuplicate==beforeDuplicate,"Duplicate study import rejects atomically")
    let missingPanel=try AsterEngine(bundleURL:bundleURL,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? missingPanel.close()}
    _=try missingPanel.registerIndicatorModule("aster.volume-direction",version:1);let beforeMissing=try missingPanel.saveStudies();var missingRejected=false
    do{_=try missingPanel.loadStudies(saved)}catch AsterError.javaScript{missingRejected=true}
    let afterMissing=try missingPanel.saveStudies()
    try require(missingRejected&&afterMissing==beforeMissing,"Missing layout panel rejects without partial study installation")
    return ["schema":"aster.native.studies","passed":checks.count,"checks":checks,"shared":shared,"inputBars":bars.count,"savedUTF8Bytes":saved.utf8.count,"imported":imported,"asOf":future,"proxy":"OHLCV close-direction volume proxy, not bid/ask delta","boundary":"Public Swift SDK + real JavaScriptCore; no OS touch or performance measurement"]
}

/// One demo action: session setup, public JSON save and atomic fresh-container
/// reload into the same data/layout. It never overwrites an existing user file.
func nativeAnalysisSession(_ engine:AsterEngine)throws->[String:Any] {
    guard var report=try engine.call("nativeAnalysisDemo").toDictionary() as? [String:Any],report["schema"] as? String=="aster.analysis-demo" else{throw AsterError.invalidScene}
    let saved=try engine.saveStudies()
    guard let imported=try engine.call("nativeAnalysisReload",[saved]).toDictionary() as? [String:Any] else{throw AsterError.invalidScene}
    guard try nativeStudyJSON(engine.saveStudies())==nativeStudyJSON(saved) else{throw AsterError.javaScript("Demo study round-trip differs")}
    report["roundTrip"]=imported;report["savedUTF8Bytes"]=saved.utf8.count
    try engine.fit();return report
}

func nativeAnalysisCaption(_ report:[String:Any])->String {
    let packet=report["asOf"] as? [String:Any],sample=(packet?["value"] as? NSNumber).map{String(format:"%.3f",$0.doubleValue)} ?? "gap"
    return "NY regular-session VWAP ±2σ · studies saved/reloaded. As-of VWAP "+sample+". Volume is a close-direction proxy, not bid/ask delta."
}

/// Validates a demo already installed by the actual host button. The constant
/// layout probe supplies bounded numerical fixture inputs; no user source eval.
func verifyNativeAnalysisView(_ engine:AsterEngine,width:Double,height:Double)throws->[String:Any] {
    guard width.isFinite,height.isFinite,width>=100,height>=80 else{throw AsterError.invalidScene}
    var checks:[String]=[]
    func require(_ value:Bool,_ reason:String)throws{guard value else{throw AsterError.javaScript("Native study view: "+reason)};checks.append(reason)}
    let state=try engine.command("inspect").toDictionary()!,series=state["series"] as? [[String:Any]] ?? []
    try require(state["storedBars"] as? Int==1200,"Demo includes two 600-minute feeds across the New York DST weekend")
    try require(series.filter{$0["indicator"] as? String=="analysis-vwap"}.count==3&&series.contains{$0["indicator"] as? String=="analysis-pressure"},"Session VWAP bands and volume proxy are visible study series")
    let saved=try engine.saveStudies(),revision=engine.revision
    let raw=try engine.indicatorValueAt("analysis-pressure",output:"signed",index:152,options:["mode":"raw","asOfIndex":152])
    try require(raw["sourceIndex"] as? Int==152&&raw["value"] is NSNumber,"Public scalar proxy query is available with source metadata")
    let future=try engine.indicatorValueAt("analysis-vwap",output:"value",index:151,options:["mode":"raw","asOfIndex":150])
    try require(future["value"] is NSNull&&future["sourceIndex"] is NSNull&&future["sourceTime"] is NSNull,"Demo future as-of query hides value and timestamp")
    let beforeBad=try nativeStudyObject(engine.command("inspect").toDictionary()!)
    var rejected=false;do{_=try engine.call("nativeAnalysisReload",["invalid studies"])}catch AsterError.javaScript{rejected=true}
    let afterBad=try nativeStudyObject(engine.command("inspect").toDictionary()!)
    try require(rejected&&beforeBad==afterBad,"Invalid saved setup keeps the displayed chart atomically")
    _=try engine.scene(width:width,height:height)
    func point(_ index:Int)throws->[String:Double] {
        let expression="(()=>{const l=Aster.createLayout(nativeModel,\(width),\(height)),p=l.panels[0];return {x:l.x(\(index)),y:(p.top+p.bottom)/2};})()"
        guard let result=engine.context.evaluateScript(expression)?.toDictionary() as? [String:Double] else{throw AsterError.invalidScene}
        if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Study point")};return result
    }
    try engine.command("setVisibleRange",[140,170])
    let hoverRevision=engine.revision
    var texts:[String]=[]
    for index in [150,151] {
        let p=try point(index);_=try engine.call("nativePointer",["move",0,p["x"]!,p["y"]!]);_=try engine.scene(width:width,height:height)
        guard let summary=try engine.call("nativeAccessibility",[true]).toDictionary() as? [String:Any],let text=try engine.call("nativeAccessibilityText",[true,"uikit"]).toString(),let panels=summary["panels"] as? [[String:Any]],let bars=summary["bars"] as? Int,let readout=summary["readout"] as? String,let selection=summary["selection"] as? String,let tool=summary["tool"] as? String else{throw AsterError.invalidScene}
        let legacy=["\(bars) bars",panels.compactMap{$0["title"] as? String}.joined(separator:"; "),readout,selection,"tool "+tool].filter{!$0.isEmpty}.joined(separator:"; ")
        try require(text==legacy,"Single-string accessibility helper preserves exact legacy text at index \(index)");texts.append(text)
    }
    try require(texts[0] != texts[1]&&engine.revision==hoverRevision,"Hover text refreshes without relying on unchanged Swift mutation revision")
    try require(try engine.saveStudies()==saved,"Scalar/accessibility reads preserve saved definitions and series")
    return ["schema":"aster.native.study-view","passed":checks.count,"checks":checks,"query":raw,"futureAsOf":future,"revisionBeforeReads":revision,"hoverRevision":hoverRevision,"accessibilityText":texts.last!,"boundary":"Real JavaScriptCore and native raster host; controller hover is programmatic, not OS/physical touch"]
}
