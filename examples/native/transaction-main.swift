import AppKit
import JavaScriptCore

private func transactionManifest(_ root:URL)throws->[String:Any] {try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("build-manifest.json"))) as! [String:Any]}
private func transactionWrite(_ report:[String:Any],_ root:URL,_ name:String)throws {try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent(name))}

private final class TransactionView:NSView {
    let engine:AsterEngine
    private lazy var renderer=AsterFrameRenderer(engine:engine)
    private var observer:UUID?
    private(set) var lastError:String?
    override var isFlipped:Bool{true}
    init(engine:AsterEngine,frame:NSRect){self.engine=engine;super.init(frame:frame);observer=try? engine.observeChanges{[weak self] in self?.needsDisplay=true}}
    required init?(coder:NSCoder){return nil}
    func fire(_ kind:String,_ x:Double,_ y:Double)throws{_=try engine.call("nativeResize",[bounds.width,bounds.height]);_=try engine.call("nativePointer",[kind,1,x,y]);needsDisplay=true}
    override func mouseDown(with event:NSEvent){let p=convert(event.locationInWindow,from:nil);do{try fire("down",p.x,p.y)}catch{lastError=String(describing:error)}}
    override func mouseDragged(with event:NSEvent){let p=convert(event.locationInWindow,from:nil);do{try fire("move",p.x,p.y)}catch{lastError=String(describing:error)}}
    override func mouseUp(with event:NSEvent){do{try fire("up",0,0)}catch{lastError=String(describing:error)}}
    func send(_ kind:String,_ x:Double,_ y:Double)throws {
        if kind=="cancel"{try fire("cancel",0,0);return}
        let type:NSEvent.EventType=kind=="down" ? .leftMouseDown : kind=="move" ? .leftMouseDragged : .leftMouseUp
        let p=convert(NSPoint(x:x,y:y),to:nil)
        guard let event=NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window?.windowNumber ?? 0,context:nil,eventNumber:1,clickCount:1,pressure:1) else{throw AsterError.invalidScene}
        switch kind{case "down":mouseDown(with:event);case "move":mouseDragged(with:event);default:mouseUp(with:event)}
        if let error=lastError{throw AsterError.javaScript(error)}
    }
    override func draw(_ dirtyRect:NSRect){guard let context=NSGraphicsContext.current?.cgContext else{return};do{_=try renderer.render(width:bounds.width,height:bounds.height,scale:Double(window?.backingScaleFactor ?? 1),in:context);lastError=nil}catch{lastError=String(describing:error)}}
    func detach(){renderer.release();if let observer=observer{try? engine.removeObserver(observer)};observer=nil;removeFromSuperview()}
}

private final class TransactionWindow:NSObject,NSApplicationDelegate {
    let root:URL,engine:AsterEngine
    var window:NSWindow!,view:TransactionView!,job:AsterAsyncJob?,buttons:[String:NSButton]=[:],controlError:Error?
    init(root:URL)throws{self.root=root;engine=try AsterEngine(bundleURL:root.appendingPathComponent("aster-core.js"),count:0);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1000,height:640),styleMask:[.titled,.closable],backing:.buffered,defer:false);window.title="BaroChart native transaction acceptance"
        let content=NSView(frame:NSRect(x:0,y:0,width:1000,height:640));window.contentView=content
        view=TransactionView(engine:engine,frame:NSRect(x:0,y:0,width:1000,height:580));content.addSubview(view)
        let controls=NSStackView();controls.orientation = .horizontal;controls.spacing=12;controls.frame=NSRect(x:12,y:590,width:980,height:38)
        for (title,key) in [("Rebind B50","rebind"),("Undo","undo"),("Redo","redo")]{let b=NSButton(title:title,target:self,action:#selector(action(_:)));b.identifier=NSUserInterfaceItemIdentifier(key);buttons[key]=b;controls.addArrangedSubview(b)}
        content.addSubview(controls);window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        DispatchQueue.main.asyncAfter(deadline:.now()+0.2){[weak self] in self?.run()}
    }
    @objc func action(_ button:NSButton){do{switch button.identifier?.rawValue{case "rebind":_=try engine.command("editDrawing",["d",["axisId":"B","points":[["time":1700000120000.0,"price":50.0]]]]);case "undo":try engine.undo();default:try engine.redo()};controlError=nil}catch{controlError=error}}
    func run(){do{
        let width=view.bounds.width,height=view.bounds.height
        var report=try verifyNativeTransactions(engine,width:width,height:height,inputKind:"AppKit synthetic NSEvent handlers + cancellation bridge",send:view.send)
        report["controls"]=try verifyNativeTransactionControls(engine,width:width,height:height,send:view.send,perform:{key in self.buttons[key]!.performClick(nil);if let error=self.controlError{throw error}})
        view.needsDisplay=true;view.displayIfNeeded();guard view.lastError==nil,let image=view.bitmapImageRepForCachingDisplay(in:view.bounds) else{throw AsterError.invalidScene};view.cacheDisplay(in:view.bounds,to:image);let png=image.representation(using:.png,properties:[:])!;guard png.count>1000 else{throw AsterError.invalidScene};try png.write(to:root.appendingPathComponent("native-transactions.png"))
        report["commonAPI"]=try verifyTransactionCommonAPI(engine);let axes=try verifyNativeAxes(engine,width:width,height:height)
        report["host"]="AppKit NSWindow/NSView + JavaScriptCore + CoreGraphics";report["syntheticNSEvents"]=true;report["source"]=try transactionManifest(root)
        job=try verifyNativeAxesHandoff(engine,width:width,height:height){[weak self] result in guard let self=self else{return};do{report["legacyAxes"]=nativeAxesCombinedReport(axes,try result.get());self.job=nil;self.view.detach();try self.engine.close();report["engineClosed"]=true;try transactionWrite(report,self.root,"native-transactions-ui.json");print("AppKit transactions passed \(report["passed"]!)");NSApp.terminate(nil)}catch{self.fail(error)}}
    }catch{fail(error)}}
    func fail(_ error:Error){try? transactionWrite(["failed":true,"error":String(describing:error)],root,"native-transactions-ui.json");print("AppKit transactions FAILED: \(error)");job?.cancel();view?.detach();try? engine.close();exit(1)}
    func applicationWillTerminate(_ notification:Notification){job?.cancel();view?.detach();try? engine.close()}
}

@main private struct TransactionMain {
    static func main()throws{
        guard CommandLine.arguments.count>=2 else{print("Usage: aster-transactions BUILD_DIRECTORY [--headless]");exit(64)}
        let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        if CommandLine.arguments.contains("--headless")||CommandLine.arguments.contains("--demo-target-only"){
            let engine=try AsterEngine(bundleURL:root.appendingPathComponent("aster-core.js"),count:0);defer{try? engine.close()}
            do{
                let width=1000.0,height=500.0
                let send:(String,Double,Double)throws->Void={kind,x,y in _=try engine.call("nativeResize",[width,height]);_=try engine.call("nativePointer",[kind,1,x,y])}
                if CommandLine.arguments.contains("--demo-target-only"){let report=try verifyNativeComparisonTargetPolicy(engine,width:width,height:height,send:send);try transactionWrite(report,root,"native-demo-target.json");return}
                var report=try verifyNativeTransactions(engine,width:width,height:height,inputKind:"programmatic nativePointer controller",send:send)
                report["commonAPI"]=try verifyTransactionCommonAPI(engine);let axes=try verifyNativeAxes(engine,width:width,height:height);var done=false,failure:Error?
                let job=try verifyNativeAxesHandoff(engine,width:width,height:height){result in do{report["legacyAxes"]=nativeAxesCombinedReport(axes,try result.get())}catch{failure=error};done=true},deadline=ProcessInfo.processInfo.systemUptime+10
                while !done&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}}
                if let error=failure{throw error};if !done{job.cancel();throw AsterError.javaScript("Headless transaction legacy handoff timeout")}
                try engine.close();report["engineClosed"]=true;report["source"]=try transactionManifest(root);try transactionWrite(report,root,"native-transactions.json");print("JSC transactions passed \(report["passed"]!)")
            }catch{try? transactionWrite(["failed":true,"error":String(describing:error)],root,CommandLine.arguments.contains("--demo-target-only") ? "native-demo-target.json" : "native-transactions.json");print("JSC transactions FAILED: \(error)");exit(1)}
        }else{let app=NSApplication.shared,delegate=try TransactionWindow(root:root);app.delegate=delegate;app.setActivationPolicy(.regular);app.run()}
    }
}
