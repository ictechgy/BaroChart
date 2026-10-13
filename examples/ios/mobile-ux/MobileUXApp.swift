import UIKit
import JavaScriptCore

private final class WeakChartReference {
    weak var value:AsterChartView?
    init(_ value:AsterChartView){self.value=value}
}
final class MobileUXWindow:UIWindow {
    var afterTouchEvent:((Int,[ObjectIdentifier?])->Void)?
    override func sendEvent(_ event:UIEvent){let began=event.allTouches?.filter{$0.phase == .began} ?? [],ids=began.map{$0.view.map(ObjectIdentifier.init)};super.sendEvent(event);if event.type == .touches{afterTouchEvent?(began.count,ids)}}
}

@main final class MobileUXApp:UIResponder,UIApplicationDelegate {
    var window:UIWindow?
    func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?=nil)->Bool{true}
    func application(_ application:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration{let config=UISceneConfiguration(name:"Mobile UX",sessionRole:session.role);config.delegateClass=MobileUXScene.self;return config}
}
final class MobileUXScene:UIResponder,UIWindowSceneDelegate {
    var window:UIWindow?,controller:MobileUXController?
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions){guard let scene=scene as? UIWindowScene else{return};let window=MobileUXWindow(windowScene:scene),controller=MobileUXController();window.rootViewController=controller;window.afterTouchEvent = {[weak controller] count,ids in controller?.afterTouchEvent(count,ids:ids)};self.window=window;self.controller=controller;window.makeKeyAndVisible()}
    func sceneDidBecomeActive(_ scene:UIScene){controller?.recordLifecycle("active");DispatchQueue.main.async{[weak self] in self?.controller?.runActiveLaunchCase()}}
    func sceneWillResignActive(_ scene:UIScene){controller?.recordLifecycle("resign")}
    func sceneDidEnterBackground(_ scene:UIScene){controller?.recordLifecycle("background")}
    func sceneDidDisconnect(_ scene:UIScene){controller?.finish()}
}
final class MobileUXController:UIViewController {
    var engine:AsterEngine!,chart:AsterChartView!,chartHost=UIViewController(),status=UILabel(),report:[String:Any]=[:],checks:[String]=[],failures:[String]=[],lifecycle:[String]=[],interruptOnNextInput:String?,interruptions:[[String:Any]]=[],pendingBatchRecord=false,batchEvents:[[String:Any]]=[],buttons:[String:UIButton]=[:],lastAction="startup",didRunActiveLaunchCase=false
    let time=1700000000000.0
    var documents:URL{FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0]}
    override func viewDidLoad(){super.viewDidLoad();view.backgroundColor = .black
        if let data=try? Data(contentsOf:documents.appendingPathComponent("ios-mobile-batch.json")),let previous=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let events=previous["batchTouchEvents"] as? [[String:Any]]{batchEvents=events}
        do{engine=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:0);try reset()}catch{failures.append(String(describing:error));report["startupError"]=String(describing:error);write();return}
        addChild(chartHost);chartHost.didMove(toParent:self);chart=AsterChartView(engine:engine);chart.accessibilityIdentifier="aster-chart";chart.translatesAutoresizingMaskIntoConstraints=false;chartHost.view.addSubview(chart)
        NSLayoutConstraint.activate([chart.leadingAnchor.constraint(equalTo:chartHost.view.leadingAnchor),chart.trailingAnchor.constraint(equalTo:chartHost.view.trailingAnchor),chart.topAnchor.constraint(equalTo:chartHost.view.topAnchor),chart.bottomAnchor.constraint(equalTo:chartHost.view.bottomAnchor)])
        chart.onInteraction = {[weak self] in self?.interaction()}
        let rows=[[("Reset","reset"),("Draw","draw"),("Select","select"),("Pending","pending")],[("Enable","enable-touch"),("Disable","disable-touch"),("Trait","trait-touch"),("Font","font-touch")],[("Resize","resize-touch"),("Checks","checks"),("Large","large"),("Finish","finish")]]
        var arranged:[UIView]=[]
        for row in rows{let stack=UIStackView();stack.axis = .horizontal;stack.distribution = .fillEqually;for(title,key) in row{let b=UIButton(type:.system);b.setTitle(title,for:.normal);b.accessibilityIdentifier="ux-"+key;b.addAction(UIAction{[weak self] _ in self?.perform(key)},for:.touchUpInside);buttons[key]=b;stack.addArrangedSubview(b)};stack.heightAnchor.constraint(equalToConstant:44).isActive=true;arranged.append(stack)}
        status.accessibilityIdentifier="ux-state";status.font = .monospacedSystemFont(ofSize:8,weight:.regular);status.textColor = .white;status.numberOfLines=2;status.heightAnchor.constraint(equalToConstant:32).isActive=true
        arranged += [chartHost.view,status];let stack=UIStackView(arrangedSubviews:arranged);stack.axis = .vertical;stack.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.leadingAnchor),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor),stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),stack.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor)])
        DispatchQueue.main.async{[weak self] in if ProcessInfo.processInfo.arguments.contains("--reentry"){self?.perform("reentry")}else if let batch=ProcessInfo.processInfo.arguments.first(where:{$0.hasPrefix("--batch-")}){self?.perform(String(batch.dropFirst(2)))}else{self?.publish()}}
    }
    func runActiveLaunchCase(){guard !didRunActiveLaunchCase,ProcessInfo.processInfo.arguments.contains("--cancel-semantics") else{return};didRunActiveLaunchCase=true;perform("cancel-semantics")}
    func probe(_ source:String)throws->JSValue {guard let value=engine.context.evaluateScript(source) else{throw AsterError.invalidScene};if let exception=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(exception.toString() ?? "Probe")};return value}
    func state()throws->[String:Any]{try engine.command("inspect").toDictionary() as? [String:Any] ?? [:]}
    func observerCount()->Int {Mirror(reflecting:engine!).children.first{$0.label=="observers"}.map{Mirror(reflecting:$0.value).children.count} ?? -1}
    func reset()throws {
        _=try engine.call("nativeInit",[0,["panels":[["id":"price","range":[80,120],"padding":0],["id":"volume","range":[0,1000],"weight":0.4]],"series":[["id":"a","type":"candles","panel":"price"],["id":"v","type":"histogram","panel":"volume","source":"volume"]]]])
        var bars:[[String:Double]]=[]
        for i in 0..<240{let delta=Double(i)*0.02;bars.append(["time":time+Double(i)*60000,"open":100+delta,"high":102+delta,"low":98+delta,"close":101+delta,"volume":500+Double(i%20)*10])}
        _=try engine.command("setData",[bars]);_=try engine.command("setVisibleRange",[100,124]);_=try engine.command("addDrawing",[["id":"line","type":"horizontal","panel":"price","points":[["time":time+112*60000,"price":100]]]]);_=try engine.command("addDrawing",[["id":"trend","type":"trendline","panel":"price","points":[["time":time+106*60000,"price":108],["time":time+117*60000,"price":112]]]])
        _=try probe("nativeModel.drawings.undoStack=[];nativeModel.drawings.redoStack=[];true")
        chart?.setNeedsDisplay()
    }
    func enableScale(_ enabled:Bool){let setter=NSSelectorFromString("setAdjustsFontForContentSizeCategory:");if chart.responds(to:setter){chart.setValue(enabled,forKey:"adjustsFontForContentSizeCategory")}}
    func setCategory(_ category:UIContentSizeCategory){chartHost.traitOverrides.preferredContentSizeCategory=category;chartHost.view.layoutIfNeeded();chart.setNeedsDisplay()}
    func fontSize()throws->Double {let theme=try state()["theme"] as! [String:Any],font=theme["font"] as! String;return Double(font.split(separator:" ").first(where:{$0.hasSuffix("px")})!.dropLast(2))!}
    func require(_ condition:Bool,_ label:String){if condition{checks.append(label)}else{failures.append(label)}}
    func pointerIDCount()->Int{Mirror(reflecting:chart!).children.first{$0.label=="pointerIDs"}.map{Mirror(reflecting:$0.value).children.count} ?? -1}
    func interaction(){do{if let kind=interruptOnNextInput,pointerIDCount()>0 {
        interruptOnNextInput=nil;let before=pointerIDCount(),anchors=try state()["drawings"] as! [[String:Any]]
        switch kind{case "enable-touch":enableScale(true);case "disable-touch":enableScale(false);case "trait-touch":setCategory(.large);case "font-touch":_=try engine.command("setTheme",[["font":"20px monospace"]]);
        #if ASTER_MOBILE_UX_CURRENT
        case "batch-dispose":chart.dispose();pendingBatchRecord=true
        case "batch-font":_=try engine.command("setTheme",[["font":"20px monospace"]]);pendingBatchRecord=true
        case "batch-cancel":if let action=chart.accessibilityCustomActions?.first(where:{$0.name=="Cancel interaction"}),let handler=action.actionHandler{_=handler(action)};pendingBatchRecord=true
        case "batch-resize":let bounds=chart.bounds;chart.bounds.size.width-=20;chart.setNeedsLayout();chart.layoutIfNeeded();chart.bounds=bounds;chart.setNeedsLayout();chart.layoutIfNeeded();pendingBatchRecord=true
        #endif
        default:let bounds=chart.bounds;chart.bounds.size.width-=20;chart.setNeedsLayout();chart.layoutIfNeeded();chart.bounds=bounds;chart.setNeedsLayout();chart.layoutIfNeeded()}
        let s=try state();interruptions.append(["kind":kind,"pointerIDsBefore":before,"pointerIDsAfter":pointerIDCount(),"nativePointersAfter":s["pointers"]!,"anchorsBefore":anchors,"anchorsAfter":s["drawings"]!,"boundary":"Real XCTest UITouch DOWN, programmatic font/trait/bounds change inside onInteraction, then real OS drag/up"])
    };publish()}catch{failures.append(String(describing:error));publish()}}
    func afterTouchEvent(_ began:Int,ids:[ObjectIdentifier?]){
        #if ASTER_MOBILE_UX_CURRENT
        guard pendingBatchRecord else{return};pendingBatchRecord=false;do{let targets=ids.filter{$0==ObjectIdentifier(chart!)},pointers=try state()["pointers"] as? Int ?? -1;let record:[String:Any]=["kind":interruptions.last?["kind"] ?? "unknown","beganTouches":began,"chartTargetBegans":targets.count,"pointerIDsAfterDispatch":pointerIDCount(),"corePointersAfterDispatch":pointers,"disposed":chart.isDisposed,"boundary":"Public UIWindow.sendEvent before/after genuine XCUITest pinch DOWN dispatch"]
        batchEvents.append(record);report["batchTouchEvents"]=batchEvents;publish();try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:documents.appendingPathComponent("ios-mobile-batch.json"))}catch{failures.append(String(describing:error));publish()}
        #endif
    }
    func perform(_ key:String){lastAction=key;do{switch key{
        case "reset":try reset()
        case "draw":try engine.setTool("horizontal")
        case "select":try engine.setTool("select")
        case "pending":let p=try point(time:time+112*60000,price:100);_=try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);_=try engine.call("nativePointer",["down",99,p[0],p[1]]);_=try engine.call("nativePointer",["move",99,p[0],p[1]+10])
        case "large":enableScale(true);setCategory(.accessibilityExtraExtraExtraLarge)
        case "normal":setCategory(.large)
        case "enable-touch","disable-touch","trait-touch","font-touch","resize-touch","batch-dispose","batch-font","batch-cancel","batch-resize":
            try reset();enableScale(false);_=try engine.command("setTheme",[["font":"12px monospace"]]);setCategory(.accessibilityExtraExtraExtraLarge)
            if ["disable-touch","trait-touch","font-touch","batch-font"].contains(key){enableScale(true)}
            interruptOnNextInput=key
        case "checks":try nativeChecks()
        #if ASTER_MOBILE_UX_CURRENT
        case "reentry":try checkReentrantDisposal()
        case "cancel-semantics":try checkAccessibleEscape()
        #endif
        default:finish();return
        };publish()}catch{failures.append(String(describing:error));publish()}}
    func point(time:Double,price:Double)throws->[Double] {let w=max(100,chart.bounds.width),h=max(80,chart.bounds.height);let p=try probe("Aster.createLayout(nativeModel,\(w),\(h)).toScreen({time:\(time),price:\(price)},'price')").toDictionary() as! [String:Double];return[p["x"]!,p["y"]!]}
    #if ASTER_MOBILE_UX_CURRENT
    func checkAccessibleEscape()throws {
        try reset();let p=try point(time:time+112*60000,price:100);_=try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);_=try engine.call("nativePointer",["down",77,p[0],p[1]]);_=try engine.call("nativePointer",["move",77,p[0],p[1]])
        let before=try state(),hadCrosshair=try probe("nativeModel.crosshair!==null").toBool()
        guard let action=chart.accessibilityCustomActions?.first(where:{$0.name=="Cancel interaction"}),let handler=action.actionHandler else{throw AsterError.invalidScene};let accepted=handler(action)
        let after=try state(),crosshairCleared=try probe("nativeModel.crosshair===null").toBool()
        require(before["selected"] as? String=="line"&&hadCrosshair,"Accessible Escape fixture begins with selected drawing and crosshair")
        require(UIApplication.shared.applicationState == .active&&accepted,"Accessible Escape is accepted by an active UIKit view")
        require(after["pointers"] as? Int==0&&after["selected"] is NSNull&&crosshairCleared,"Accessible Cancel preserves Escape pointer, selection and crosshair clearing")
        report["accessibleEscape"]=["selectedBefore":before["selected"]!,"selectedAfter":after["selected"]!,"crosshairBefore":hadCrosshair,"crosshairCleared":crosshairCleared,"pointersAfter":after["pointers"]!,"accepted":accepted,"appActive":UIApplication.shared.applicationState == .active,"boundary":"Programmatic UIKit custom action handler on pending controller edit"]
    }
    func checkReentrantDisposal()throws {
        let borrowed=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:24),target=AsterChartView(engine:borrowed,frame:chartHost.view.bounds),weakTarget=WeakChartReference(target)
        chartHost.view.addSubview(target);target.adjustsFontForContentSizeCategory=true;target.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge;target.layoutIfNeeded()
        let beforeFont=try borrowed.call("nativeThemeFont").toString()!;var callbacks=0,observerCalls=0
        target.onInteraction={callbacks+=1;if callbacks<2{weakTarget.value?.dispose()}}
        let observer=try borrowed.observeChanges{observerCalls+=1;if observerCalls<=2{weakTarget.value?.dispose()}}
        _=try borrowed.call("nativeResize",[target.bounds.width,target.bounds.height]);_=try borrowed.call("nativePointer",["down",71,200,100]);target.dispose()
        try borrowed.removeObserver(observer);let afterFont=try borrowed.call("nativeThemeFont").toString()!
        let pointers=(try borrowed.command("inspect").toDictionary()?["pointers"] as? Int) ?? -1
        require(callbacks==0,"Dispose suppresses interaction callbacks before reentrant client code")
        require(pointers==0,"Reentrant dispose still cancels actual core pointers")
        require(observerCalls==1&&afterFont=="12px monospace"&&beforeFont != afterFont,"Font restore observer reentry finishes once with caller base restored")
        _=try borrowed.scene(width:402,height:600);require(true,"Reentrant disposal preserves borrowed engine")
        report["reentrantDisposal"]=["callbacks":callbacks,"corePointersAfter":pointers,"boundedCallbackLimit":2,"restoreObserverReentries":observerCalls,"beforeFont":beforeFont,"afterFont":afterFont]
        target.removeFromSuperview();try borrowed.close()
    }
    @inline(never) private func replaceDisposedChart()throws->WeakChartReference {
        let previous=chart!,weakReference=WeakChartReference(previous)
        previous.dispose();previous.dispose();require(previous.isDisposed,"Public dispose is idempotent and marks view disposed")
        require(observerCount()==0,"Dispose removes engine subscriptions while view remains retained")
        _=try engine.scene(width:402,height:600);require(true,"Disposed view keeps borrowed engine usable")
        previous.removeFromSuperview();chart=nil
        chart=AsterChartView(engine:engine,frame:chartHost.view.bounds);chart.accessibilityIdentifier="aster-chart";chartHost.view.addSubview(chart);chart.onInteraction = {[weak self] in self?.interaction()};require(observerCount()==1,"Replacement view owns one subscription")
        return weakReference
    }
    #endif
    func nativeChecks()throws {
        enableScale(true);setCategory(.large);let original=try fontSize();setCategory(.accessibilityExtraExtraExtraLarge);let enlarged=try fontSize();require(enlarged>original*1.5,"Dynamic Type scales logical font from original font")
        setCategory(.accessibilityExtraExtraExtraLarge);require(try fontSize()==enlarged,"Repeated category does not compound scaling")
        func pending()throws{_=try engine.command("setTool",["select"]);let p=try point(time:time+112*60000,price:100);_=try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);_=try engine.call("nativePointer",["down",97,p[0],p[1]])}
        try pending();_=try engine.command("setTheme",[["font":"18px monospace"]]);require(try state()["pointers"] as? Int==0,"Caller font change immediately cancels pending pointer")
        try pending();setCategory(.large);require(try state()["pointers"] as? Int==0,"Trait font change immediately cancels pending pointer")
        setCategory(.accessibilityExtraExtraExtraLarge)
        _=try engine.command("setTheme",[["font":"20px monospace"]]);require(try fontSize()>20,"Caller font replacement becomes unscaled Dynamic Type base")
        try pending();enableScale(false);require(try fontSize()==20,"Disabling Dynamic Type restores caller base font");require(try state()["pointers"] as? Int==0,"Disabling Dynamic Type immediately cancels pending pointer")
        require(chart.accessibilityTraits.contains(.adjustable),"Chart exposes adjustable accessibility trait")
        _=try engine.command("selectDrawing",[NSNull()]);let before=try state()["view"] as! [String:Double];chart.accessibilityIncrement();let after=try state()["view"] as! [String:Double];require(after["to"]!-after["from"]!<before["to"]!-before["from"]!,"Accessibility increment zooms chart")
        let names=chart.accessibilityCustomActions?.map{$0.name} ?? [];require(names.contains("Cancel interaction")&&names.contains("Next drawing")&&names.contains("Delete selected drawing"),"Chart provides drawing and cancel accessible actions")
        if let next=chart.accessibilityCustomActions?.first(where:{$0.name=="Next drawing"}),let handler=next.actionHandler {require(handler(next),"Native custom action handler selects drawing");require(try state()["selected"] is String,"Accessible selection updates model")}
        func accessible(_ name:String){guard let action=chart.accessibilityCustomActions?.first(where:{$0.name==name}),let handler=action.actionHandler else{failures.append("Missing accessible "+name);return};require(handler(action),"Accessible "+name+" executes")}
        let drawingCount=(try state()["drawings"] as! [Any]).count
        accessible("Delete selected drawing");require((try state()["drawings"] as! [Any]).count==drawingCount-1,"Accessible delete removes selected drawing")
        accessible("Undo");require((try state()["drawings"] as! [Any]).count==drawingCount,"Accessible undo restores drawing")
        accessible("Redo");require((try state()["drawings"] as! [Any]).count==drawingCount-1,"Accessible redo removes drawing")
        accessible("Undo");let panBefore=try state()["view"] as! [String:Double],panAnchors=try engine.saveDrawings();accessible("Pan earlier");let panAfter=try state()["view"] as! [String:Double],panRestored=try engine.saveDrawings();require(panAfter["from"]!<panBefore["from"]!&&panRestored==panAnchors,"Accessible pan changes viewport without editing selected drawing")
        try pending();accessible("Cancel interaction");require(try state()["pointers"] as? Int==0,"Accessible cancel clears pending controller input")
        require(observerCount()==1,"Attached view owns one engine subscription")
        let p=try point(time:time+112*60000,price:100);_=try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);_=try engine.call("nativePointer",["down",98,p[0],p[1]])
        chart.removeFromSuperview();require(observerCount()==0,"Detached view releases engine subscription");require(try state()["pointers"] as? Int==0,"Detach cancels controller pointers")
        chartHost.view.addSubview(chart);chart.frame=chartHost.view.bounds;chart.translatesAutoresizingMaskIntoConstraints=true;require(observerCount()==1,"Reattach restores exactly one subscription")
        chart.layoutIfNeeded();_=try engine.command("setTheme",[["font":"12px monospace"]]);try pending();chart.setNeedsLayout();chart.layoutIfNeeded();require(try state()["pointers"] as? Int==1,"Same bounds layout preserves active controller input")
        let previousBounds=chart.bounds;chart.bounds.size.width-=10;chart.setNeedsLayout();chart.layoutIfNeeded();require(try state()["pointers"] as? Int==0,"Bounds change cancels controller before resize");chart.bounds=previousBounds;chart.setNeedsLayout();chart.layoutIfNeeded()
        weak var weakView:AsterChartView?
        autoreleasepool{let transient=AsterChartView(engine:engine,frame:chartHost.view.bounds);weakView=transient}
        require(weakView==nil&&observerCount()==1,"Unattached view deallocates without retained subscriptions")
        #if ASTER_MOBILE_UX_CURRENT
            let weakDisposed=try autoreleasepool{try replaceDisposedChart()},aliveInsideAction=weakDisposed.value != nil
            // UIKit's enclosing event/autorelease scope may still own the old
            // responder. Probe after the UIControl action has returned, without
            // retaining the chart or demanding an immediate ARC release.
            DispatchQueue.main.asyncAfter(deadline:.now()+0.02){[weak self,weakDisposed] in
                guard let self=self else{return};let released=weakDisposed.value==nil
                self.require(released,"Disposed view weak lifetime releases after UIKit event scope")
                self.report["viewLifetime"]=["retainedInsideUIControlAction":aliveInsideAction,"weakNilAfterMainQueue":released,"fenceRequestedDelayMs":20,"boundary":"Weak-only probe after outer UIKit UIControl event scope; no RSS or leak-free claim"]
                var result=self.report["nativeChecks"] as? [String:Any] ?? [:];result["passed"]=self.checks.count;result["checks"]=self.checks;result["failures"]=self.failures;self.report["nativeChecks"]=result;self.publish()
            }
            try checkReentrantDisposal()
            try checkAccessibleEscape()
        #endif
        try reset();_=try engine.command("setTheme",[["font":"12px monospace"]]);setCategory(.large)
        report["nativeChecks"]=["passed":checks.count,"checks":checks,"failures":failures,"dynamicTypeFonts":["base":original,"enlarged":enlarged],"input":"UIKit APIs / programmatic native controller, not system touch"]
        report["glyphMatrix"]=try verifyUIKitGlyphMatrix(engine,documents:documents);try reset()
        let publication=try engine.call("nativePublicationOrderSelfTest").toDictionary()!;require(publication["passed"] as? Int==4,"JSC data publication reset/prepend/correction/nested retain latest view and EMA");report["publicationOrder"]=publication
        report["nativeChecks"]=["passed":checks.count,"checks":checks,"failures":failures,"dynamicTypeFonts":["base":original,"enlarged":enlarged],"input":"UIKit APIs / programmatic native controller, not system touch"]
    }
    func recordLifecycle(_ value:String){lifecycle.append(value);DispatchQueue.main.async{[weak self] in self?.publish()}}
    func publish(){guard engine != nil,chart != nil else{return};do{var s=try state();s["fontSize"]=try fontSize();s["bounds"]=[chart.bounds.width,chart.bounds.height];s["linePoint"]=try point(time:time+112*60000,price:100);s["handlePoint"]=try point(time:time+106*60000,price:108);s["crosshair"]=try probe("nativeModel.crosshair").toDictionary() ?? [:];s["lifecycle"]=lifecycle;s["failures"]=failures;s["checks"]=checks.count
            s["interruptions"]=interruptions;s["batchTouchEvents"]=batchEvents
            s["lastAction"]=lastAction;s["buttonFrames"]=buttons.mapValues{button in let r=button.convert(button.bounds,to:nil);return[r.minX,r.minY,r.width,r.height]}
            if let lifetime=report["viewLifetime"] as? [String:Any]{s["viewReleased"]=lifetime["weakNilAfterMainQueue"]}
            let json=String(data:try JSONSerialization.data(withJSONObject:s,options:[.sortedKeys]),encoding:.utf8)!;status.text="\(checks.count) passed; \(failures.count) failed";status.accessibilityLabel=json
            report["state"]=s;report["inputInterruptions"]=interruptions;write()
        }catch{status.accessibilityLabel="{\"error\":\"State probe failed\"}"}}
    func write(){do{report["schema"]="aster.uikit.mobile-ux";report["source"]=try JSONSerialization.jsonObject(with:Data(contentsOf:Bundle.main.url(forResource:"build-manifest",withExtension:"json")!));report["physicalDevice"]=false;report["ios"]=UIDevice.current.systemVersion;try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:documents.appendingPathComponent("ios-mobile-ux.json"))}catch{print("Mobile UX report: \(error)")}}
    func finish(){guard engine != nil else{return};publish();chart?.removeFromSuperview();chart=nil;report["engineSubscriptionsAfterDetach"]=observerCount();try? engine.close();engine=nil;report["engineClosed"]=true;write();status.accessibilityLabel="{\"finished\":true}"}
}
