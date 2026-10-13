import AppKit
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let prepareMode=CommandLine.arguments.contains("--prepare-demo")
let comparisonMode = !prepareMode && !["--study-test","--closed-observer-test","--study-ui-test","--publication-test","--self-test","--api-test","--ui-test","--frame-test","--async-test","--async-bench","--prepare-test","--prepare-bench","--soak-test","--snapshot","--bench"].contains(where:CommandLine.arguments.contains)
let emptyStartup=comparisonMode || ["--study-test","--closed-observer-test","--study-ui-test","--publication-test","--axes-test","--frame-test","--async-test","--async-bench","--prepare-test","--prepare-bench","--soak-test","--prepare-demo"].contains(where:CommandLine.arguments.contains)
let engine = try AsterEngine(bundleURL:root.appendingPathComponent("artifacts/aster-core.js"), count: emptyStartup ? 0 : 100000,options:prepareMode ? ["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]] : nil)
if prepareMode {for name in ["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]{_=try engine.call("nativeIndicator",[name,name,[:],"price"])}}
func nativeArgument(_ flag:String,_ fallback:Int)->Int {let args=CommandLine.arguments;guard let i=args.firstIndex(of:flag),i+1<args.count,let value=Int(args[i+1]) else{return fallback};return value}
func nativeFire(_ name: String, _ args: [Any]) {do {_ = try engine.call(name,args)} catch {print(error)}}
func bitmap(_ scene: AsterScene) -> CGContext {
    let ctx = CGContext(data:nil,width:Int(scene.width),height:Int(scene.height),bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x:0,y:scene.height);ctx.scaleBy(x:1,y:-1);return ctx
}
func snapshot(_ file: String) throws {
    let scene = try engine.scene(width:1200,height:700),ctx=bitmap(scene);AsterCoreGraphicsRenderer.render(scene,in:ctx)
    let destination = CGImageDestinationCreateWithURL(root.appendingPathComponent(file) as CFURL,UTType.png.identifier as CFString,1,nil)!
    CGImageDestinationAddImage(destination,ctx.makeImage()!,nil);if !CGImageDestinationFinalize(destination) {throw AsterError.invalidScene};print("Native PNG: \(file)")
}
func percentiles(_ values: [Double]) -> [String: Double] {let a=values.sorted();return ["p50":a[Int(Double(a.count-1)*0.5)],"p95":a[Int(Double(a.count-1)*0.95)],"p99":a[Int(Double(a.count-1)*0.99)]]}
if CommandLine.arguments.contains("--study-test") || CommandLine.arguments.contains("--closed-observer-test") {
    let closed=CommandLine.arguments.contains("--closed-observer-test")
    let report=try closed ? verifyNativeClosedSubscriptions(root.appendingPathComponent("artifacts/aster-core.js")) : verifyNativeStudies(root.appendingPathComponent("artifacts/aster-core.js"))
    let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])
    try data.write(to:root.appendingPathComponent("benchmarks/results/"+(closed ? "cycle11-native-closed-observer.json" : "cycle11-native-studies.json")))
    print(String(data:data,encoding:.utf8)!);try engine.close();if report["failed"] as? Bool==true{exit(1)}
} else if CommandLine.arguments.contains("--axes-test") {
    var report=try verifyNativeAxes(engine),finished=false,failure:Error?
    let job=try verifyNativeAxesHandoff(engine,width:800,height:500){result in do{report=nativeAxesCombinedReport(report,try result.get())}catch{failure=error};finished=true},deadline=ProcessInfo.processInfo.systemUptime+8
    while !finished&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}}
    if let error=failure{throw error};if !finished{job.cancel();throw AsterError.javaScript("Native axes handoff timed out")}
    let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native-axes-validation.json"));print(String(data:data,encoding:.utf8)!)
} else if CommandLine.arguments.contains("--publication-test") {
    let report = try engine.call("nativePublicationOrderSelfTest").toDictionary()!
    let data = try JSONSerialization.data(withJSONObject: report,options: [.prettyPrinted,.sortedKeys])
    try data.write(to: root.appendingPathComponent("benchmarks/results/cycle10-native-publication.json"))
    print(String(data: data,encoding: .utf8)!)
} else if CommandLine.arguments.contains("--frame-test") {
    try verifyNativeFrames(root.appendingPathComponent("artifacts/aster-core.js"),root.appendingPathComponent("benchmarks/results/native-frame-validation.json"))
} else if CommandLine.arguments.contains("--self-test") {
    print(try engine.call("nativeSelfTest").toString()!)
    try snapshot("artifacts/native-verified.png")
} else if CommandLine.arguments.contains("--prepare-test") || CommandLine.arguments.contains("--prepare-bench") {
    let benchmark=CommandLine.arguments.contains("--prepare-bench"),count=nativeArgument("--prepare-bars",benchmark ? 1000000 : 8192)
    var completed=false,failure:Error?;let deadline=ProcessInfo.processInfo.systemUptime+600
    let callback:(Result<[String:Any],Error>)->Void={result in
        do{let report=try result.get(),data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/"+(benchmark ? "native-prepare-benchmark.json" : "native-prepare-tests.json")));print(String(data:data,encoding:.utf8)!)}catch{failure=error};completed=true
    }
    if benchmark{benchmarkNativePrepare(root.appendingPathComponent("artifacts/aster-core.js"),count:count,completion:callback)}else{verifyNativePrepare(root.appendingPathComponent("artifacts/aster-core.js"),count:count,completion:callback)}
    while !completed&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.05))}}
    if let failure=failure{print("Native prepare FAILED: \(failure)");exit(1)};if !completed{print("Native prepare timed out");exit(1)}
} else if CommandLine.arguments.contains("--soak-test") {
    final class SoakChart:NSView {
        var source:AsterEngine?,observer:UUID?
        override var isFlipped:Bool{true}
        init(_ engine:AsterEngine,_ frame:NSRect){source=engine;super.init(frame:frame);observer=try? engine.observeChanges{[weak self] in self?.needsDisplay=true}}
        required init?(coder:NSCoder){return nil}
        func detach(){if let source=source,let observer=observer{try? source.removeObserver(observer)};observer=nil;source=nil;removeFromSuperview()}
        override func draw(_ rect:NSRect){guard let source=source,let context=NSGraphicsContext.current?.cgContext else{return};do{let scene=try source.scene(width:max(100,bounds.width),height:max(80,bounds.height));AsterCoreGraphicsRenderer.render(scene,in:context)}catch{print("Soak draw: \(error)")}}
    }
    let duration=nativeArgument("--soak-seconds",180),bars=nativeArgument("--soak-bars",20000),charts=nativeArgument("--soak-charts",3),app=NSApplication.shared
    app.setActivationPolicy(.regular)
    let window=NSWindow(contentRect:NSRect(x:0,y:0,width:640,height:CGFloat(max(1,min(charts,4)))*310),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
    window.title="BaroChart native prepare soak";window.center();window.makeKeyAndOrderFront(nil);app.activate(ignoringOtherApps:true)
    var views:[Int:SoakChart]=[:],completed=false,failure:Error?;let deadline=ProcessInfo.processInfo.systemUptime+Double(duration)+120
    let harness=startNativePrepareSoak(root.appendingPathComponent("artifacts/aster-core.js"),seconds:Double(duration),bars:bars,charts:charts,onEngine:{index,source in
        views.removeValue(forKey:index)?.detach();if let source=source{let view=SoakChart(source,NSRect(x:0,y:CGFloat(index)*310,width:640,height:300));views[index]=view;window.contentView?.addSubview(view)}
    },onResize:{index,width,height in views[index]?.setFrameSize(NSSize(width:width,height:height));views[index]?.needsDisplay=true}){result in
        do{var report=try result.get();report["host"]="AppKit NSWindow + CoreGraphics + JavaScriptCore";report["nativeWindow"]=true;let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native-soak-validation.json"));print(String(data:data,encoding:.utf8)!);if report["failed"] as? Bool==true{failure=AsterError.javaScript("Native soak checks failed; see report")}}catch{failure=error};completed=true
    }
    while !completed&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.02));while let event=app.nextEvent(matching:.any,until:.distantPast,inMode:.default,dequeue:true){app.sendEvent(event)};for view in views.values{view.displayIfNeeded()};app.updateWindows()}}
    harness.stop();window.close()
    if let failure=failure{print("Native soak FAILED: \(failure)");exit(1)};if !completed{print("Native soak timed out");exit(1)}
} else if CommandLine.arguments.contains("--async-bench") {
    let args=CommandLine.arguments,index=args.firstIndex(of:"--async-bars"),count=index.flatMap {$0+1<args.count ? Int(args[$0+1]) : nil} ?? 1000000
    var completed=false,failure:Error?;let deadline=ProcessInfo.processInfo.systemUptime+600
    benchmarkNativeCorrections(root.appendingPathComponent("artifacts/aster-core.js"),count:count) {result in
        do {let report=try result.get(),data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native-async-benchmark.json"));print(String(data:data,encoding:.utf8)!)} catch {failure=error};completed=true
    }
    while !completed && ProcessInfo.processInfo.systemUptime<deadline {_ = RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.05))}
    if let failure=failure {print("Native correction benchmark FAILED: \(failure)");exit(1)}
    if !completed {print("Native correction benchmark timed out");exit(1)}
} else if CommandLine.arguments.contains("--async-test") {
    let args=CommandLine.arguments,index=args.firstIndex(of:"--async-bars"),count=index.flatMap {$0+1<args.count ? Int(args[$0+1]) : nil} ?? 8192
    var completed=false,failure:Error?;let deadline=ProcessInfo.processInfo.systemUptime+300
    verifyNativeAsync(root.appendingPathComponent("artifacts/aster-core.js"),count:count) {result in
        do {let report=try result.get(),data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native-async-tests.json"));print(String(data:data,encoding:.utf8)!)} catch {failure=error};completed=true
    }
    while !completed && ProcessInfo.processInfo.systemUptime<deadline {_ = RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.05))}
    if let failure=failure {print("Native async test FAILED: \(failure)");exit(1)}
    if !completed {print("Native async test timed out");exit(1)}
} else if CommandLine.arguments.contains("--api-test") {
    var report = try verifyCommonAPI(engine)
    let small = try nativeTextInk("12px monospace"), large = try nativeTextInk("bold 36px monospace")
    guard large > small*2 else {throw AsterError.javaScript("Font sizing was ignored")}
    report["passed"] = 13; report["fontSmallInk"] = small; report["fontLargeInk"] = large;report["fontSizing"] = true
    let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native-api-tests.json"));print(String(data:data,encoding:.utf8)!)
} else if CommandLine.arguments.contains("--snapshot") {
    try snapshot("artifacts/native-verified.png")
} else if CommandLine.arguments.contains("--bench") {
    var result: [[String:Any]]=[]
    for n in [10000,100000,1000000] {
        let start=ProcessInfo.processInfo.systemUptime;try engine.call("nativeInit",[n]);let load=(ProcessInfo.processInfo.systemUptime-start)*1000
        var complete:[Double]=[],render:[Double]=[];var stats:[String:Int]=[:]
        for i in 0..<70 {let begin=ProcessInfo.processInfo.systemUptime;let scene=try engine.scene(width:1200,height:700);let ctx=bitmap(scene);let draw=ProcessInfo.processInfo.systemUptime;AsterCoreGraphicsRenderer.render(scene,in:ctx);_ = ctx.makeImage();let end=ProcessInfo.processInfo.systemUptime;if i>=10 {complete.append((end-begin)*1000);render.append((end-draw)*1000)};stats=scene.stats}
        result.append(["storedBars":n,"visibleSourceBars":stats["visibleSourceBars"] ?? 0,"loadMs":load,"sceneBridgeBitmapDrawMs":percentiles(complete),"coreGraphicsSubmitAndImageMs":percentiles(render),"samples":60,"width":1200,"height":700,"dpr":1])
    }
    let doc:[String:Any]=["environment":ProcessInfo.processInfo.operatingSystemVersionString,"renderer":"CoreGraphics offscreen; not display FPS","results":result]
    let data=try JSONSerialization.data(withJSONObject:doc,options:[.prettyPrinted,.sortedKeys]);try data.write(to:root.appendingPathComponent("benchmarks/results/native.json"));print(String(data:data,encoding:.utf8)!)
} else {
    final class ChartView:NSView {
        private lazy var frameRenderer=AsterFrameRenderer(engine:engine)
        private var chartTracking:NSTrackingArea?
        var onInteraction:(()->Void)?
        override var isFlipped:Bool {true};override var acceptsFirstResponder:Bool {true}
        override func draw(_ dirtyRect:NSRect) {do {if let ctx=NSGraphicsContext.current?.cgContext {_ = try frameRenderer.render(width:max(100,bounds.width),height:max(80,bounds.height),scale:Double(window?.backingScaleFactor ?? 1),in:ctx)}} catch {print(error)}}
        func point(_ event:NSEvent)->NSPoint {nativeFire("nativeResize",[max(100,bounds.width),max(80,bounds.height)]);return convert(event.locationInWindow,from:nil)}
        override func mouseDown(with event:NSEvent) {window?.makeFirstResponder(self);let p=point(event);nativeFire("nativePointer",["down",1,p.x,p.y]);needsDisplay=true;onInteraction?()}
        override func mouseDragged(with event:NSEvent) {let p=point(event);nativeFire("nativePointer",["move",1,p.x,p.y]);needsDisplay=true;onInteraction?()}
        override func mouseUp(with event:NSEvent) {nativeFire("nativePointer",["up",1,0,0]);needsDisplay=true;onInteraction?()}
        override func mouseMoved(with event:NSEvent) {let p=point(event);nativeFire("nativePointer",["move",0,p.x,p.y]);needsDisplay=true;onInteraction?()}
        override func updateTrackingAreas(){if let old=chartTracking{removeTrackingArea(old)};let area=NSTrackingArea(rect:.zero,options:[.mouseMoved,.mouseEnteredAndExited,.activeInKeyWindow,.inVisibleRect],owner:self,userInfo:nil);chartTracking=area;addTrackingArea(area);super.updateTrackingAreas()}
        override func mouseExited(with event:NSEvent){nativeFire("nativeHoverExit",[]);needsDisplay=true;onInteraction?()}
        override func scrollWheel(with event:NSEvent) {nativeFire("nativeWheel",[event.scrollingDeltaY*8,point(event).x]);needsDisplay=true;onInteraction?()}
        override func magnify(with event:NSEvent) {nativeFire("nativeWheel",[-event.magnification*1000,point(event).x]);needsDisplay=true;onInteraction?()}
        override func keyDown(with event:NSEvent) {nativeFire("nativeResize",[max(100,bounds.width),max(80,bounds.height)]);let key=[UInt16(53):"Escape",51:"Delete",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp",116:"PageUp",121:"PageDown",115:"Home",119:"End"][event.keyCode] ?? event.charactersIgnoringModifiers ?? "";nativeFire("nativeKey",[key,event.modifierFlags.contains(.command),event.modifierFlags.contains(.shift)]);needsDisplay=true;onInteraction?()}
        override func viewWillMove(toWindow newWindow:NSWindow?) {if newWindow == nil {frameRenderer.release();nativeFire("nativePointer",["cancel",0,0,0])};super.viewWillMove(toWindow:newWindow)}
    }
    final class DemoDelegate:NSObject,NSApplicationDelegate {
        var window:NSWindow!;let view=ChartView();var asyncJob:AsterAsyncJob?;let asyncStatus=NSTextField(labelWithString:"Async ready");let tools=["select","trendline","horizontal","fibonacci","rectangle","ellipse","text"]
        let comparisonReadout=NSTextField(wrappingLabelWithString:"Synthetic A/B · exact UTC join, B gaps");var comparisonButtons:[String:NSButton]=[:],comparisonActive=false,savedComparison:String?,analysisCaption:String?;let analysisButton=NSButton(title:"Session VWAP",target:nil,action:nil)
        func applicationDidFinishLaunching(_ notification:Notification) {
            window=NSWindow(contentRect:NSRect(x:0,y:0,width:1200,height:860),styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false);window.title="BaroChart · Native CoreGraphics · Synthetic A/B";window.acceptsMouseMovedEvents=true
            let content=NSView(frame:NSRect(x:0,y:0,width:1200,height:860));window.contentView=content;view.frame=NSRect(x:0,y:0,width:1200,height:710);view.autoresizingMask=[.width,.height];content.addSubview(view)
            let bar=NSStackView();bar.orientation = .horizontal;bar.spacing=8;bar.frame=NSRect(x:12,y:716,width:1170,height:34);bar.autoresizingMask=[.width,.minYMargin]
            for (i,tool) in tools.enumerated() {let button=NSButton(title:tool,target:self,action:#selector(setTool(_:)));button.tag=i;bar.addArrangedSubview(button)}
            for (name,action) in [("Undo",#selector(undoAction)),("Redo",#selector(redoAction)),("Save",#selector(saveAction)),("Load",#selector(loadAction))] {bar.addArrangedSubview(NSButton(title:name,target:self,action:action))}
            bar.addArrangedSubview(NSButton(title:"Async",target:self,action:#selector(asyncAction)));bar.addArrangedSubview(NSButton(title:"Cancel",target:self,action:#selector(cancelAsync)))
            bar.addArrangedSubview(NSButton(title:"Prepare1m",target:self,action:#selector(prepareAction)))
            asyncStatus.setContentHuggingPriority(.defaultLow,for:.horizontal);bar.addArrangedSubview(asyncStatus)
            content.addSubview(bar);window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
            let comparisonBar=NSStackView();comparisonBar.orientation = .horizontal;comparisonBar.spacing=6;comparisonBar.frame=NSRect(x:12,y:812,width:1170,height:34);comparisonBar.autoresizingMask=[.width,.minYMargin]
            for (title,action) in [("Compare","setup"),("Hide B labels","hide-axis"),("Scale B","scale"),("B series","series"),("Add B line","drawing"),("Save B","save"),("Load B","load"),("Primary draw","primary"),("Range B","range"),("Digits B","precision")]{let button=NSButton(title:title,target:self,action:#selector(comparisonAction(_:)));button.identifier=NSUserInterfaceItemIdentifier(action);comparisonButtons[action]=button;comparisonBar.addArrangedSubview(button)}
            analysisButton.target=self;analysisButton.action=#selector(analysisAction);analysisButton.identifier=NSUserInterfaceItemIdentifier("analysis-session");comparisonBar.insertArrangedSubview(analysisButton,at:0)
            comparisonReadout.frame=NSRect(x:12,y:762,width:1170,height:42);comparisonReadout.autoresizingMask=[.width,.minYMargin];comparisonReadout.font = .monospacedSystemFont(ofSize:12,weight:.regular);content.addSubview(comparisonReadout);content.addSubview(comparisonBar);view.onInteraction={ [weak self] in self?.refreshComparison() }
            _ = try? engine.observeChanges { [weak view] in view?.needsDisplay = true }
            if comparisonMode{do{_=try nativeComparisonAction(engine,"setup",width:view.bounds.width,height:view.bounds.height);comparisonActive=true;refreshComparison();view.needsDisplay=true}catch{comparisonReadout.stringValue=String(describing:error)}}else{refreshComparison()}
            if CommandLine.arguments.contains("--study-ui-test"){DispatchQueue.main.asyncAfter(deadline:.now()+0.5){self.verifyStudyWindow()}}
            if CommandLine.arguments.contains("--axes-ui-test"){DispatchQueue.main.asyncAfter(deadline:.now()+0.5){self.verifyAxesWindow()}}
            if prepareMode{DispatchQueue.main.async{self.prepareAction()}}
            if CommandLine.arguments.contains("--ui-test") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    do {
                        try engine.call("nativeTool", ["trendline"])
                        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 200, y: 500), modifierFlags: [], timestamp: 0, windowNumber: self.window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
                        let drag = NSEvent.mouseEvent(with: .leftMouseDragged, location: NSPoint(x: 450, y: 450), modifierFlags: [], timestamp: 0.1, windowNumber: self.window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 1)!
                        self.view.mouseDown(with: down); self.view.mouseDragged(with: drag); self.view.mouseUp(with: drag)
                        let saved = try engine.saveDrawings()
                        guard saved.contains("trendline") else { throw AsterError.javaScript("Native mouse gesture failed") }
                        try engine.call("nativeKey", ["z", true, false])
                        guard try engine.saveDrawings().contains("\"drawings\":[]") else { throw AsterError.javaScript("Native undo failed") }
                        try engine.call("nativeKey", ["z", true, true])
                        guard try engine.saveDrawings() == saved else { throw AsterError.javaScript("Native redo did not restore the saved geometry") }
                        self.view.needsDisplay = true; self.view.displayIfNeeded()
                        guard let image = self.view.bitmapImageRepForCachingDisplay(in: self.view.bounds) else { throw AsterError.invalidScene }
                        self.view.cacheDisplay(in: self.view.bounds, to: image)
                        try image.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("artifacts/native-window-verified.png"))
                        let result = "{\"passed\":4,\"host\":\"AppKit NSWindow\",\"nativeMouseGesture\":true,\"undoRedo\":true,\"viewBitmap\":true}"
                        try result.write(to: root.appendingPathComponent("benchmarks/results/native-ui-tests.json"), atomically: true, encoding: .utf8)
                        print(result); NSApp.terminate(nil)
                    } catch { print("Native UI test FAILED: \(error)"); exit(1) }
                }
            }
        }
        @objc func asyncAction() {
            do {
                let event:[String:Any]=["kind":"correction","bar":["time":1700000000000.0,"open":100,"high":1000,"low":0,"close":1000,"volume":123]]
                asyncJob=try engine.applyDataEventAsync(event,progress:{ [weak self] value in self?.asyncStatus.stringValue="\(value.phase) \(value.done)/\(value.total)" }) { [weak self] result in
                    self?.asyncJob=nil
                    switch result {case .success(let metrics):self?.asyncStatus.stringValue=String(format:"Done %.0f ms",metrics.totalMs);case .failure(let error):self?.asyncStatus.stringValue=String(describing:error)}
                    self?.refreshComparison()
                }
            } catch {asyncStatus.stringValue=String(describing:error)}
        }
        @objc func cancelAsync() {asyncJob?.cancel()}
        func refreshComparison(){if let caption=analysisCaption{comparisonReadout.stringValue=caption;for (action,button) in comparisonButtons{button.isEnabled=action=="setup"};return};for (action,button) in comparisonButtons{button.isEnabled=action=="setup"||comparisonActive};guard comparisonActive else{comparisonReadout.stringValue="Primary OHLCV · Compare opens synthetic B";return};do{comparisonReadout.stringValue=try nativeComparisonLabel(nativeComparisonPacket(engine,width:max(100,view.bounds.width),height:max(80,view.bounds.height)));let state=try engine.command("inspect").toDictionary()!,axes=state["axes"] as? [[String:Any]] ?? [],axis=axes.first{$0["id"] as? String=="comparison-B"},series=state["series"] as? [[String:Any]] ?? [];comparisonButtons["hide-axis"]?.title=(axis?["visible"] as? Bool)==false ? "Show B labels" : "Hide B labels";comparisonButtons["scale"]?.title="B "+(axis?["scale"] as? String ?? "linear");comparisonButtons["drawing"]?.isEnabled=series.contains{$0["id"] as? String=="comparison-B-line"};comparisonButtons["load"]?.isEnabled=savedComparison != nil}catch{comparisonReadout.stringValue=String(describing:error)}}
        @objc func analysisAction() {
            guard asyncJob==nil else{asyncStatus.stringValue="Cancel calculation first";return}
            do{let report=try nativeAnalysisSession(engine);analysisCaption=nativeAnalysisCaption(report);comparisonActive=false;savedComparison=nil;refreshComparison();view.needsDisplay=true}catch{comparisonReadout.stringValue=String(describing:error)}
        }
        func verifyStudyWindow(){do{
            analysisButton.performClick(nil)
            guard analysisCaption != nil else{throw AsterError.javaScript("Session VWAP button did not install the study demo")}
            var report=try verifyNativeAnalysisView(engine,width:view.bounds.width,height:view.bounds.height)
            view.needsDisplay=true;view.displayIfNeeded();guard let image=view.bitmapImageRepForCachingDisplay(in:view.bounds) else{throw AsterError.invalidScene};view.cacheDisplay(in:view.bounds,to:image)
            guard let png=image.representation(using:.png,properties:[:]),png.count>10000 else{throw AsterError.invalidScene}
            report["host"]="AppKit NSWindow + CoreGraphics + JavaScriptCore";report["uiControlActions"]=true;report["syntheticControllerHover"]=true;report["physicalInput"]=false;report["snapshotBytes"]=png.count
            try png.write(to:root.appendingPathComponent("artifacts/cycle11-native-studies.png"))
            let bytes=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try bytes.write(to:root.appendingPathComponent("benchmarks/results/cycle11-native-studies-ui.json"));print(String(data:bytes,encoding:.utf8)!);NSApp.terminate(nil)
        }catch{print("Native studies UI FAILED: \(error)");exit(1)}}
        @objc func comparisonAction(_ sender:NSButton){
            guard let action=sender.identifier?.rawValue else{return}
            do{
                if action=="range"||action=="precision"{
                    let axes=try engine.command("inspect").forProperty("axes").toArray() as? [[String:Any]] ?? []
                    guard let axis=axes.first(where:{$0["id"] as? String=="comparison-B"}) else{throw AsterError.javaScript("Missing comparison axis")}
                    var patch:[String:Any]=[:]
                    if action=="range"{patch["range"]=(axis["range"] as? [Any]) == nil ? [2000,2240] as Any : NSNull()}
                    else{patch["precision"]=(axis["precision"] as? Int)==0 ? 3 : 0}
                    _=try engine.command("setAxis",["comparison-B",patch])
                }else{
                    let result=try nativeComparisonAction(engine,action,width:view.bounds.width,height:view.bounds.height,saved:action=="load" ? savedComparison : nil)
                    if action=="save"{savedComparison=result["savedDocument"] as? String}
                    if action=="setup"{comparisonActive=true;savedComparison=nil;analysisCaption=nil}
                }
                refreshComparison();view.needsDisplay=true
            }catch{comparisonReadout.stringValue=String(describing:error)}
        }
        func verifyAxesWindow(){do{
            var report=try verifyNativeAxes(engine,width:view.bounds.width,height:view.bounds.height);comparisonActive=true;refreshComparison();var checks:[String]=[]
            func require(_ value:Bool,_ text:String)throws{guard value else{throw AsterError.javaScript(text)};checks.append(text)}
            func mouse(_ type:NSEvent.EventType,_ point:[String:Double])throws{let p=view.convert(type == .leftMouseUp ? .zero : NSPoint(x:point["x"]!,y:point["y"]!),to:nil);guard let event=NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:1) else{throw AsterError.invalidScene};switch type{case .mouseMoved:view.mouseMoved(with:event);case .leftMouseDown:view.mouseDown(with:event);case .leftMouseDragged:view.mouseDragged(with:event);default:view.mouseUp(with:event)}}
            try mouse(.mouseMoved,nativeAxisPoint(engine,index:2,width:view.bounds.width,height:view.bounds.height));try require(comparisonReadout.stringValue.contains("C 103.00")&&comparisonReadout.stringValue.contains("SYNTH:B 2020.000"),"AppKit mouse readout separates primary/B")
            try mouse(.mouseMoved,nativeAxisPoint(engine,index:3,width:view.bounds.width,height:view.bounds.height));try require(comparisonReadout.stringValue.contains("C 104.00")&&comparisonReadout.stringValue.contains("SYNTH:B gap"),"AppKit mouse readout shows missing B")
            guard let exitEvent=NSEvent.enterExitEvent(with:.mouseExited,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,eventNumber:2,trackingNumber:0,userData:nil) else{throw AsterError.invalidScene};view.mouseExited(with:exitEvent)
            try require(try engine.command("crosshairValues",[view.bounds.width,view.bounds.height]).isNull && !comparisonReadout.stringValue.contains("C 104.00"),"AppKit mouse exit clears stale readout")
            nativeFire("nativeTool",["trendline"]);try mouse(.leftMouseDown,nativeAxisPoint(engine,index:2,price:2080,width:view.bounds.width,height:view.bounds.height));try mouse(.leftMouseDragged,nativeAxisPoint(engine,index:6,price:2160,width:view.bounds.width,height:view.bounds.height));try mouse(.leftMouseUp,[:])
            let doc=try JSONSerialization.jsonObject(with:engine.saveDrawings().data(using:.utf8)!) as! [String:Any],d=(doc["drawings"] as! [[String:Any]])[0],points=d["points"] as! [[String:Double]]
            try require(d["axisId"] as? String=="comparison-B"&&d["seriesId"] as? String=="comparison-B-line"&&abs(points[0]["price"]!-2080)<1e-8&&abs(points[1]["price"]!-2160)<1e-8,"AppKit drawing gesture saves B raw anchors")
            comparisonButtons["save"]!.performClick(nil);let saved=try engine.saveDrawings();undoAction();redoAction();try require(try engine.saveDrawings()==saved,"AppKit undo/redo exact bound document")
            comparisonButtons["scale"]!.performClick(nil);comparisonButtons["scale"]!.performClick(nil);comparisonButtons["range"]!.performClick(nil);comparisonButtons["precision"]!.performClick(nil);comparisonButtons["hide-axis"]!.performClick(nil);comparisonButtons["series"]!.performClick(nil);comparisonButtons["series"]!.performClick(nil);comparisonButtons["load"]!.performClick(nil);try require(try engine.saveDrawings()==saved,"AppKit buttons save/remove/reconnect/load preserve binding")
            let axis=(try engine.command("inspect").forProperty("axes").toArray() as! [[String:Any]])[0]
            try require(axis["scale"] as? String=="percent"&&axis["precision"] as? Int==0&&axis["visible"] as? Bool==false&&(axis["range"] as? [Int])==[2000,2240],"AppKit scale/range/precision/visibility controls")
            view.needsDisplay=true;view.displayIfNeeded();guard let image=view.bitmapImageRepForCachingDisplay(in:view.bounds) else{throw AsterError.invalidScene};view.cacheDisplay(in:view.bounds,to:image);let png=image.representation(using:.png,properties:[:])!;try png.write(to:root.appendingPathComponent("artifacts/native-axes-window.png"));try require(png.count>10000,"AppKit independent axes raster")
            report["uiPassed"]=checks.count;report["uiChecks"]=checks;report["host"]="AppKit NSWindow + CoreGraphics + JavaScriptCore";report["syntheticNSEvents"]=true;report["uiControlActions"]=true
            asyncJob=try verifyNativeAxesHandoff(engine,width:view.bounds.width,height:view.bounds.height){[weak self] result in do{let final=nativeAxesCombinedReport(report,try result.get());self?.asyncJob=nil;self?.refreshComparison();let bytes=try JSONSerialization.data(withJSONObject:final,options:[.prettyPrinted,.sortedKeys]);try bytes.write(to:root.appendingPathComponent("benchmarks/results/native-axes-ui-validation.json"));print(String(data:bytes,encoding:.utf8)!);NSApp.terminate(nil)}catch{print("Native axes UI handoff FAILED: \(error)");exit(1)}}
        }catch{print("Native axes UI FAILED: \(error)");exit(1)}}
        @objc func prepareAction() {
            do{asyncJob=try engine.prepareSeededAsync(count:1000000,timeout:120,progress:{[weak self] p in self?.asyncStatus.stringValue="\(p.phase) \(p.done)/\(p.total)"}){[weak self] result in self?.asyncJob=nil;switch result{case .success(let m):self?.asyncStatus.stringValue=String(format:"Prepared %.0fms",m.totalMs);case .failure(let e):self?.asyncStatus.stringValue=String(describing:e)}}}catch{asyncStatus.stringValue=String(describing:error)}
        }
        func applicationWillTerminate(_ notification:Notification) {asyncJob?.cancel();try? engine.close()}
        @objc func setTool(_ sender:NSButton) {nativeFire("nativeTool",[tools[sender.tag]]);view.needsDisplay=true}
        @objc func undoAction() {nativeFire("nativeKey",["z",true,false]);view.needsDisplay=true}
        @objc func redoAction() {nativeFire("nativeKey",["z",true,true]);view.needsDisplay=true}
        @objc func saveAction() {let panel=NSSavePanel();panel.nameFieldStringValue="aster-drawings.json";if panel.runModal() == .OK,let url=panel.url {do {try engine.saveDrawings().write(to:url,atomically:true,encoding:.utf8)} catch {print(error)}}}
        @objc func loadAction() {let panel=NSOpenPanel();if panel.runModal() == .OK,let url=panel.url {do {try engine.loadDrawings(String(contentsOf:url,encoding:.utf8));view.needsDisplay=true} catch {print(error)}}}
        func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
    }
    let app=NSApplication.shared;let delegate=DemoDelegate();app.delegate=delegate;app.setActivationPolicy(.regular);app.run()
}
