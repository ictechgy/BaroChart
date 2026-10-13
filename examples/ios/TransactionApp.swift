import UIKit

@main final class TransactionAppDelegate:UIResponder,UIApplicationDelegate {
    var window:UIWindow?,engine:AsterEngine?,chart:AsterChartView?,job:AsterAsyncJob?,buttons:[String:UIButton]=[:],controlError:Error?
    func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?=nil)->Bool{true}
    func application(_ application:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration{let c=UISceneConfiguration(name:"Transactions",sessionRole:session.role);c.delegateClass=TransactionSceneDelegate.self;return c}
    func start(_ scene:UIWindowScene){do{
        let engine=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:0);self.engine=engine
        let window=UIWindow(windowScene:scene),controller=UIViewController(),view=AsterChartView(engine:engine),controls=UIStackView();controller.view.backgroundColor = .black;chart=view
        controls.axis = .horizontal;controls.distribution = .fillEqually
        for (title,key) in [("Rebind B50","rebind"),("Undo","undo"),("Redo","redo")]{let b=UIButton(type:.system);b.setTitle(title,for:.normal);b.accessibilityIdentifier="transaction-"+key;b.addTarget(self,action:#selector(action(_:)),for:.touchUpInside);buttons[key]=b;controls.addArrangedSubview(b)}
        let stack=UIStackView(arrangedSubviews:[controls,view]);stack.axis = .vertical;stack.translatesAutoresizingMaskIntoConstraints=false;controller.view.addSubview(stack)
        NSLayoutConstraint.activate([controls.heightAnchor.constraint(equalToConstant:44),stack.leadingAnchor.constraint(equalTo:controller.view.leadingAnchor),stack.trailingAnchor.constraint(equalTo:controller.view.trailingAnchor),stack.topAnchor.constraint(equalTo:controller.view.safeAreaLayoutGuide.topAnchor),stack.bottomAnchor.constraint(equalTo:controller.view.safeAreaLayoutGuide.bottomAnchor)])
        window.rootViewController=controller;self.window=window;window.makeKeyAndVisible();DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in self?.run()}
    }catch{fail(error)}}
    @objc func action(_ button:UIButton){guard let engine=engine,let key=buttons.first(where:{$0.value===button})?.key else{return};do{switch key{case "rebind":_=try engine.command("editDrawing",["d",["axisId":"B","points":[["time":1700000120000.0,"price":50.0]]]]);case "undo":try engine.undo();default:try engine.redo()};controlError=nil}catch{controlError=error}}
    func send(_ kind:String,_ x:Double,_ y:Double)throws{guard let engine=engine,let chart=chart else{throw AsterError.invalidScene};_=try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);_=try engine.call("nativePointer",[kind,1,x,y]);chart.setNeedsDisplay()}
    func run(){guard let engine=engine,let chart=chart else{return};do{
        window?.rootViewController?.view.layoutIfNeeded();let width=chart.bounds.width,height=chart.bounds.height
        var report=try verifyNativeTransactions(engine,width:width,height:height,inputKind:"UIKit view + programmatic nativePointer controller (not UITouch)",send:send)
        report["controls"]=try verifyNativeTransactionControls(engine,width:width,height:height,send:send,perform:{key in self.buttons[key]!.sendActions(for:.touchUpInside);if let error=self.controlError{throw error}})
        chart.setNeedsDisplay();let image=UIGraphicsImageRenderer(bounds:chart.bounds).image{_ in chart.drawHierarchy(in:chart.bounds,afterScreenUpdates:true)},png=image.pngData()!
        guard chart.lastError==nil,png.count>1000 else{throw AsterError.invalidScene};try png.write(to:documents.appendingPathComponent("ios-transactions.png"))
        report["commonAPI"]=try verifyTransactionCommonAPI(engine);let axes=try verifyNativeAxes(engine,width:width,height:height)
        report["source"]=try JSONSerialization.jsonObject(with:Data(contentsOf:Bundle.main.url(forResource:"build-manifest",withExtension:"json")!));report["host"]="UIKit UIView + JavaScriptCore + CoreGraphics";report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=window != nil;report["nativePointerController"]=true
        job=try verifyNativeAxesHandoff(engine,width:width,height:height){[weak self] result in guard let self=self else{return};do{report["legacyAxes"]=nativeAxesCombinedReport(axes,try result.get());self.job=nil;self.chart?.removeFromSuperview();self.chart=nil;try engine.close();self.engine=nil;report["engineClosed"]=true;self.write(report)}catch{self.fail(error)}}
    }catch{fail(error)}}
    var documents:URL{FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0]}
    func write(_ report:[String:Any]){do{try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:documents.appendingPathComponent("ios-transactions.json"))}catch{print("Transaction report write FAILED: \(error)")}}
    func fail(_ error:Error){job?.cancel();job=nil;chart?.removeFromSuperview();chart=nil;try? engine?.close();write(["failed":true,"error":String(describing:error)])}
    func close(){job?.cancel();chart?.removeFromSuperview();chart=nil;try? engine?.close();engine=nil}
}
final class TransactionSceneDelegate:UIResponder,UIWindowSceneDelegate {
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions){guard let s=scene as? UIWindowScene,let app=UIApplication.shared.delegate as? TransactionAppDelegate else{return};app.start(s)}
    func sceneDidDisconnect(_ scene:UIScene){(UIApplication.shared.delegate as? TransactionAppDelegate)?.close()}
}
