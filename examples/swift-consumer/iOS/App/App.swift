import UIKit
import AsterNative

@main final class SDKAppDelegate:UIResponder,UIApplicationDelegate {
    func application(_ application:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration {
        let configuration=UISceneConfiguration(name:"SDK Consumer",sessionRole:session.role);configuration.delegateClass=SDKSceneDelegate.self;return configuration
    }
}
final class SDKSceneDelegate:UIResponder,UIWindowSceneDelegate {
    var window:UIWindow?
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions){guard let scene=scene as? UIWindowScene else{return};let window=UIWindow(windowScene:scene);window.rootViewController=SDKController();self.window=window;window.makeKeyAndVisible()}
    func sceneDidDisconnect(_ scene:UIScene){(window?.rootViewController as? SDKController)?.cleanup()}
}
final class SDKController:UIViewController {
    private var engine:AsterEngine?,chart:AsterChartView?,job:AsterAsyncJob?
    private let status=UILabel(),stack=UIStackView()
    private var checks=[String](),buttons=[UIButton](),saved="",interactionCount=0
    private func require(_ value:Bool,_ name:String)throws {if !value{throw NSError(domain:"SDKConsumer",code:1,userInfo:[NSLocalizedDescriptionKey:name])};checks.append(name)}
    override func viewDidLoad(){super.viewDidLoad();view.backgroundColor = .systemBackground
        stack.axis = .vertical;stack.spacing=8;stack.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:12),stack.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor,constant:-12),stack.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:12),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-12)])
        let title=UILabel();title.text="Independent SwiftPM · AsterNative";title.font = .preferredFont(forTextStyle:.headline);stack.addArrangedSubview(title)
        status.numberOfLines=3;status.accessibilityIdentifier="sdk.status";stack.addArrangedSubview(status)
        for row in [[("Prepare external512","sdk.prepare",#selector(prepareFeed)),("Draw / save / reload","sdk.drawings",#selector(drawings))],[("Async correction","sdk.correct",#selector(correct)),("Dispose borrowed view","sdk.dispose",#selector(disposeView))],[("Close owned engine","sdk.close",#selector(closeEngine))]]{
            let controls=UIStackView();controls.spacing=8;controls.distribution = .fillEqually
            for (title,id,action) in row{let button=UIButton(type:.system);button.setTitle(title,for:.normal);button.accessibilityIdentifier=id;button.addTarget(self,action:action,for:.touchUpInside);button.heightAnchor.constraint(greaterThanOrEqualToConstant:44).isActive=true;controls.addArrangedSubview(button);buttons.append(button)};stack.addArrangedSubview(controls)
        }
        do {let engine=try AsterEngine();self.engine=engine;try require(try engine.scene(width:400,height:300).stats["storedBars"]==0,"Bundle.module default engine starts at0")
            try engine.addIndicator("sdk-ema","ema",["period":3]);try engine.addSeries(["id":"sdk-ema-line","type":"line","panel":"price","indicator":"sdk-ema"])
            let chart=AsterChartView(engine:engine);chart.onInteraction={[weak self] in self?.interactionCount+=1};chart.accessibilityIdentifier="sdk.chart";chart.heightAnchor.constraint(greaterThanOrEqualToConstant:200).isActive=true;stack.addArrangedSubview(chart);self.chart=chart;status.text="Ready · empty engine0 / SDK resource"
        }catch{fail(error)}
    }
    private func columns()throws->AsterColumns {let times=(0..<512).map{1700000000000+Double($0)*60000},close=(0..<512).map{100+Double($0)*0.1};return try AsterColumns(time:times,open:close,high:close.map{$0+1},low:close.map{$0-1},close:close,volume:(0..<512).map{Double(10+$0)})}
    private func busy(_ value:Bool){for button in buttons{button.isEnabled = !value}}
    private func finishRender(_ text:String){let deadline=ProcessInfo.processInfo.systemUptime+5
        func poll(){guard let engine=self.engine,let chart=self.chart else{self.status.text=text;return};if chart.renderedRevision>=engine.revision&&chart.lastError==nil{self.checks.append("UIKit view drew the current engine revision");self.status.text=text;self.busy(false)}else if ProcessInfo.processInfo.systemUptime>=deadline{self.fail(NSError(domain:"SDKConsumer",code:2,userInfo:[NSLocalizedDescriptionKey:"UIKit render did not reach current revision: \(chart.lastError ?? "pending")"]))}else{DispatchQueue.main.asyncAfter(deadline:.now()+0.05,execute:poll)}};poll()
    }
    @objc private func prepareFeed(){guard let engine=engine else{return};do{busy(true);status.text="Preparing external OHLCV…";job=try engine.prepareColumnsAsync(columns(),visibleBars:32,progress:{[weak self] progress in self?.status.text="Preparing \(progress.phase)"}){[weak self] result in guard let self=self else{return};self.job=nil;do{_ = try result.get();try self.require(Thread.isMainThread,"async completion on main/UI owner");try self.require(try engine.scene(width:400,height:300).stats["storedBars"]==512,"external512 OHLC via public SDK async");self.finishRender("Prepared512 · external OHLCV")}catch{self.fail(error)}}}catch{fail(error)}}
    @objc private func drawings(){guard let engine=engine else{return};do{let id=try engine.addDrawing(["id":"sdk-drawing","type":"horizontal","points":[["time":1700000120000.0,"price":101.0]],"text":"SDK앱"]);try require(id=="sdk-drawing","public drawing API");saved=try engine.saveDrawings();try engine.undo();try engine.redo();try engine.loadDrawings(saved);try require(try engine.saveDrawings()==saved,"drawing save/reload and undo/redo");finishRender("Drawings verified · raw anchors preserved")}catch{fail(error)}}
    @objc private func correct(){guard let engine=engine else{return};do{busy(true);job=try engine.applyDataEventAsync(["kind":"correction","bar":["time":1700000000000.0,"open":100.0,"high":1000.0,"low":99.0,"close":1000.0,"volume":10.0]]){[weak self] result in guard let self=self else{return};self.job=nil;do{_ = try result.get();let values=try engine.command("indicatorValues",["sdk-ema","value"]).toArray()!;try self.require(abs((values[2] as! NSNumber).doubleValue-400.1)<1e-9,"async correction updates EMA recurrence");try self.require(try engine.saveDrawings()==self.saved,"async handoff preserves drawing document");self.finishRender("Correction verified · EMA400.1")}catch{self.fail(error)}}}catch{fail(error)}}
    @objc private func disposeView(){guard let engine=engine,let chart=chart else{return};do{
        #if ASTER_SDK_EXPLICIT_VIEW_DISPOSE
        chart.dispose();try require(chart.isDisposed,"public permanent view disposal");chart.dispose()
        #endif
        chart.removeFromSuperview();self.chart=nil
        try require(try engine.scene(width:400,height:300).stats["storedBars"]==512,"view disposal leaves borrowed engine usable")
        // The local strong variable is released after this method returns.
        DispatchQueue.main.async{[weak self,weak chart] in guard let self=self else{return};do{try self.require(chart==nil,"disposed view is released");self.status.text="View disposed · borrowed engine alive"}catch{self.fail(error)}}
    }catch{fail(error)}}
    @objc private func closeEngine(){guard let engine=engine else{return};do{if ProcessInfo.processInfo.arguments.contains("--sdk-xcui"){try require(interactionCount>0,"XCUI drag reaches UIKit onInteraction")};try engine.close();try engine.close();do{_ = try engine.scene(width:400,height:300);throw NSError(domain:"SDKConsumer",code:3)}catch AsterAsyncError.engineClosed{checks.append("owner close repeatable / closed calls rejected")};self.engine=nil;status.text="Closed · SDK consumer passed";write(["passed":checks.count,"checks":checks,"interactionCallbacks":interactionCount,"sourceCopyDemoImport":false,"appSuppliedBundleURL":false,"borrowedEngineClosedByView":false,"host":"independent Xcode app / local SwiftPM product / UIKit / JavaScriptCore / CoreGraphics","ios":UIDevice.current.systemVersion])}catch{fail(error)}}
    func cleanup(){job?.cancel();job=nil
        #if ASTER_SDK_EXPLICIT_VIEW_DISPOSE
        chart?.dispose()
        #endif
        chart?.removeFromSuperview();chart=nil;try? engine?.close();engine=nil
    }
    private func fail(_ error:Error){busy(false);status.text="FAILED: \(error)";write(["failed":true,"error":String(describing:error)]);cleanup()}
    private func write(_ result:[String:Any]){let url=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("sdk-validation.json");try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.prettyPrinted]).write(to:url)}
}
