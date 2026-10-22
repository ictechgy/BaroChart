import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var engine: AsterEngine!
    var chart: AsterChartView!
    var checks:[String]=[]
    var asyncJob:AsterAsyncJob?
    var soak:AsterPrepareSoak?,soakContainer:UIStackView?,soakViews:[Int:AsterChartView]=[:],soakWidths:[Int:NSLayoutConstraint]=[:]
    let asyncStatus=UILabel()
    let comparisonReadout=UILabel();var comparisonButtons:[String:UIButton]=[:],comparisonActive=false,savedComparison:String?,analysisCaption:String?;let analysisButton=UIButton(type:.system)
    private var dataReadout:UITextView?,dataActionGeneration=0,dataControlsMount=0,dataControlsClosed=false
    // Opt-in controls keep existing chart keys, gestures and default layout intact.
    private func addDataControls(_ stack:UIStackView){
        dataControlsMount += 1;let mount=dataControlsMount
        let scroll=UIScrollView(),row=UIStackView();row.axis = .horizontal;row.spacing=8;row.translatesAutoresizingMaskIntoConstraints=false;scroll.addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo:scroll.contentLayoutGuide.leadingAnchor),row.trailingAnchor.constraint(equalTo:scroll.contentLayoutGuide.trailingAnchor),row.topAnchor.constraint(equalTo:scroll.contentLayoutGuide.topAnchor),row.bottomAnchor.constraint(equalTo:scroll.contentLayoutGuide.bottomAnchor),row.heightAnchor.constraint(equalTo:scroll.frameLayoutGuide.heightAnchor),scroll.heightAnchor.constraint(equalToConstant:44)])
        for (title,key) in [("Explore on","on"),("Explore off","off"),("Previous bar","ArrowLeft"),("Next bar","ArrowRight"),("Previous series","ArrowUp"),("Next series","ArrowDown"),("Refresh selection","refresh"),("Read values","read")]{let button=UIButton(type:.system);button.setTitle(title,for:.normal);button.accessibilityLabel=title;button.accessibilityIdentifier="data-"+key;button.addAction(UIAction{[weak self] _ in self?.dataAction(key,mount:mount)},for:.touchUpInside);button.widthAnchor.constraint(greaterThanOrEqualToConstant:110).isActive=true;row.addArrangedSubview(button)}
        let output=UITextView();output.isEditable=false;output.isSelectable=true;output.textColor = .white;output.backgroundColor=UIColor(red:12/255,green:19/255,blue:32/255,alpha:1);output.text="Exploration OFF. Read values may calculate dirty indicators synchronously. Results update only on explicit actions.";output.accessibilityLabel="Last explicit data exploration result";output.heightAnchor.constraint(equalToConstant:88).isActive=true;dataReadout=output
        stack.insertArrangedSubview(scroll,at:stack.arrangedSubviews.count-1);stack.insertArrangedSubview(output,at:stack.arrangedSubviews.count-1)
    }
    private func dataAction(_ key:String,mount:Int){
        guard !dataControlsClosed,mount==dataControlsMount,let owner=engine,let output=dataReadout,output.window != nil else{return};dataActionGeneration += 1;let generation=dataActionGeneration
        let text:String
        do{
            let result:[String:Any]
                switch key{case "on":result=try owner.setDataExploration(true);case "off":result=try owner.setDataExploration(false);case "refresh":result=try owner.refreshDataExploration();case "read":result=try owner.readDataExploration();default:result=try owner.navigateDataExploration(key)}
                let value=result["text"] as? String ?? "";text=value.isEmpty ? "Exploration OFF" : "Last explicit result: "+value
        }catch{text="Action error: \(error). No automatic retry."}
        guard !dataControlsClosed,mount==dataControlsMount,output.window != nil,engine===owner,dataReadout===output,generation==dataActionGeneration else{return};output.text=String(text.prefix(4096))
    }
    func stopDataControls(){dataControlsClosed=true;dataControlsMount += 1;dataActionGeneration += 1;dataReadout=nil}
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey:Any]? = nil) -> Bool {
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name:"Aster",sessionRole:session.role);configuration.delegateClass = AsterSceneDelegate.self;return configuration
    }
    func start(_ windowScene: UIWindowScene) {
        stopDataControls();dataControlsClosed=false
        do {
            let args=ProcessInfo.processInfo.arguments,prepareDemo=args.contains("--prepare-demo"),validationMode=["--study-test","--study-ui-test","--closed-observer-test","--self-test","--async-test","--async-bench","--prepare-test","--prepare-bench","--soak-test"].contains(where:args.contains),empty=(!validationMode && !prepareDemo)||["--study-test","--study-ui-test","--closed-observer-test","--async-test","--async-bench","--prepare-test","--prepare-bench","--soak-test","--prepare-demo"].contains(where:args.contains)
            engine = try AsterEngine(bundleURL: Bundle.main.url(forResource: "aster-core", withExtension: "js")!, count:empty ? 0 : 10000,options:prepareDemo ? ["panels":[["id":"price","weight":3]],"series":[["id":"price","type":"candles","panel":"price"]]] : nil)
            if prepareDemo{for name in ["sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"]{_=try engine.call("nativeIndicator",[name,name,[:],"price"])}}
            let window = UIWindow(windowScene:windowScene), controller = UIViewController(); controller.view.backgroundColor = .black
            let toolScroll=UIScrollView(),toolbar = UIStackView();toolbar.axis = .horizontal;toolbar.spacing=8;toolbar.translatesAutoresizingMaskIntoConstraints=false;toolScroll.addSubview(toolbar)
            NSLayoutConstraint.activate([toolbar.leadingAnchor.constraint(equalTo:toolScroll.contentLayoutGuide.leadingAnchor),toolbar.trailingAnchor.constraint(equalTo:toolScroll.contentLayoutGuide.trailingAnchor),toolbar.topAnchor.constraint(equalTo:toolScroll.contentLayoutGuide.topAnchor),toolbar.bottomAnchor.constraint(equalTo:toolScroll.contentLayoutGuide.bottomAnchor),toolbar.heightAnchor.constraint(equalTo:toolScroll.frameLayoutGuide.heightAnchor)])
            for title in ["Select","Line","Freehand","Channel","Fib","Undo","Redo"] {let button = UIButton(type:.system); button.setTitle(title,for:.normal);button.setContentCompressionResistancePriority(.required,for:.horizontal);button.widthAnchor.constraint(greaterThanOrEqualToConstant:60).isActive=true;button.addTarget(self,action:#selector(action(_:)),for:.touchUpInside);toolbar.addArrangedSubview(button)}
            let asyncBar=UIStackView();asyncBar.axis = .horizontal;asyncBar.spacing=8
            for title in ["Async","Prepare1m","Cancel"] {let button=UIButton(type:.system);button.setTitle(title,for:.normal);button.addTarget(self,action:#selector(asyncAction(_:)),for:.touchUpInside);button.widthAnchor.constraint(equalToConstant:76).isActive=true;asyncBar.addArrangedSubview(button)}
            asyncStatus.text="Async ready";asyncStatus.textColor = .white;asyncStatus.font = .monospacedSystemFont(ofSize:12,weight:.regular);asyncStatus.accessibilityLabel="Calculation progress";asyncBar.addArrangedSubview(asyncStatus);asyncBar.heightAnchor.constraint(equalToConstant:44).isActive=true
            let compareScroll=UIScrollView(),compareBar=UIStackView();compareBar.axis = .horizontal;compareBar.spacing=4;compareBar.translatesAutoresizingMaskIntoConstraints=false;compareScroll.addSubview(compareBar);NSLayoutConstraint.activate([compareBar.leadingAnchor.constraint(equalTo:compareScroll.contentLayoutGuide.leadingAnchor),compareBar.trailingAnchor.constraint(equalTo:compareScroll.contentLayoutGuide.trailingAnchor),compareBar.topAnchor.constraint(equalTo:compareScroll.contentLayoutGuide.topAnchor),compareBar.bottomAnchor.constraint(equalTo:compareScroll.contentLayoutGuide.bottomAnchor),compareBar.heightAnchor.constraint(equalTo:compareScroll.frameLayoutGuide.heightAnchor)]);compareScroll.heightAnchor.constraint(equalToConstant:40).isActive=true
            for (title,action) in [("Compare","setup"),("Hide B labels","hide-axis"),("Scale B","scale"),("B series","series"),("Add B line","drawing"),("Save B","save"),("Load B","load"),("Primary draw","primary"),("Range B","range"),("Digits B","precision")]{let button=UIButton(type:.system);button.setTitle(title,for:.normal);button.accessibilityIdentifier="comparison-"+action;button.addTarget(self,action:#selector(comparisonAction(_:)),for:.touchUpInside);comparisonButtons[action]=button;compareBar.addArrangedSubview(button);button.widthAnchor.constraint(greaterThanOrEqualToConstant:86).isActive=true}
            analysisButton.setTitle("Session VWAP",for:.normal);analysisButton.accessibilityIdentifier="analysis-session";analysisButton.addTarget(self,action:#selector(analysisAction),for:.touchUpInside);analysisButton.widthAnchor.constraint(greaterThanOrEqualToConstant:116).isActive=true;compareBar.insertArrangedSubview(analysisButton,at:0)
            comparisonReadout.textColor = .white;comparisonReadout.font = .monospacedSystemFont(ofSize:11,weight:.regular);comparisonReadout.numberOfLines=3;comparisonReadout.accessibilityIdentifier="comparison-readout";comparisonReadout.heightAnchor.constraint(equalToConstant:52).isActive=true
            chart = AsterChartView(engine: engine);chart.onInteraction={ [weak self] in self?.refreshComparison() }; let stack = UIStackView(arrangedSubviews:[toolScroll,asyncBar,compareScroll,comparisonReadout,chart]); stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false; toolScroll.heightAnchor.constraint(equalToConstant:44).isActive = true
            if args.contains("--data-controls") && !validationMode{addDataControls(stack)}
            controller.view.addSubview(stack); NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:controller.view.leadingAnchor),stack.trailingAnchor.constraint(equalTo:controller.view.trailingAnchor),stack.topAnchor.constraint(equalTo:controller.view.safeAreaLayoutGuide.topAnchor),stack.bottomAnchor.constraint(equalTo:controller.view.safeAreaLayoutGuide.bottomAnchor)])
            window.rootViewController = controller; self.window = window; window.makeKeyAndVisible()
            if !validationMode && !prepareDemo{_=try nativeComparisonAction(engine,"setup",width:390,height:600);comparisonActive=true};refreshComparison()
            if args.contains("--study-test")||args.contains("--closed-observer-test"){DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in
                guard let self=self else{return};let closed=args.contains("--closed-observer-test"),name=closed ? "ios-closed-observer-validation.json" : "ios-studies-validation.json"
                do{var report=try closed ? verifyNativeClosedSubscriptions(Bundle.main.url(forResource:"aster-core",withExtension:"js")!) : verifyNativeStudies(Bundle.main.url(forResource:"aster-core",withExtension:"js")!);report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=self.window != nil;self.write(name,report)}catch{self.write(name,["failed":true,"error":String(describing:error)])}
            }}
            if args.contains("--study-ui-test"){DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in self?.verifyStudyUI()}}
            if args.contains("--axes-test"){DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in self?.verifyAxesUI()}}
            if args.contains("--prepare-demo"){DispatchQueue.main.async{[weak self] in self?.prepareDemo()}}
            if args.contains("--prepare-test")||args.contains("--prepare-bench") {DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in
                guard let self=self else{return};let benchmark=args.contains("--prepare-bench"),count=self.argument("--prepare-bars",benchmark ? 1000000 : 8192),name=benchmark ? "ios-prepare-benchmark.json" : "ios-prepare-validation.json"
                let callback:(Result<[String:Any],Error>)->Void={ [weak self] result in switch result{case .success(var report):report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=self?.window != nil;report["host"]="UIKit + CoreGraphics + JavaScriptCore";self?.write(name,report);case .failure(let error):self?.write(name,["failed":true,"error":String(describing:error)])} }
                if benchmark{benchmarkNativePrepare(Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:count,status:{[weak self] text in self?.asyncStatus.text=text},completion:callback)}else{verifyNativePrepare(Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:count,status:{[weak self] text in self?.asyncStatus.text=text},completion:callback)}
            }}
            if args.contains("--soak-test") {
                stack.removeArrangedSubview(chart);chart.removeFromSuperview();let container=UIStackView();container.axis = .vertical;container.alignment = .center;container.distribution = .fillEqually;container.spacing=4;soakContainer=container;stack.addArrangedSubview(container)
                DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[weak self] in
                    guard let self=self else{return}
                    self.soak=startNativePrepareSoak(Bundle.main.url(forResource:"aster-core",withExtension:"js")!,seconds:Double(self.argument("--soak-seconds",180)),bars:self.argument("--soak-bars",20000),charts:self.argument("--soak-charts",3),status:{[weak self] text in self?.asyncStatus.text=text},onEngine:{[weak self] index,source in
                        guard let self=self else{return};if let old=self.soakViews.removeValue(forKey:index){self.soakWidths.removeValue(forKey:index)?.isActive=false;self.soakContainer?.removeArrangedSubview(old);old.removeFromSuperview()}
                        if let source=source{let view=AsterChartView(engine:source);self.soakViews[index]=view;self.soakContainer?.addArrangedSubview(view);let width=view.widthAnchor.constraint(equalToConstant:min(600,self.window?.bounds.width ?? 390));width.isActive=true;self.soakWidths[index]=width}
                    },onResize:{[weak self] index,width,_ in guard let self=self else{return};let available=self.window?.bounds.width ?? 390;self.soakWidths[index]?.constant=min(available,width*(available<500 ? 0.5 : 1));self.soakContainer?.layoutIfNeeded();self.soakViews[index]?.setNeedsDisplay()}){[weak self] result in
                        switch result{case .success(var report):report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=self?.window != nil;report["host"]="UIKit + CoreGraphics + JavaScriptCore";self?.write("ios-soak-validation.json",report);case .failure(let error):self?.write("ios-soak-validation.json",["failed":true,"error":String(describing:error)])};self?.soak=nil
                    }
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--async-bench") {DispatchQueue.main.asyncAfter(deadline:.now()+0.5){ [weak self] in
                let args=ProcessInfo.processInfo.arguments,index=args.firstIndex(of:"--async-bars"),count=index.flatMap {$0+1<args.count ? Int(args[$0+1]) : nil} ?? 1000000
                benchmarkNativeCorrections(Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:count,status:{ [weak self] text in self?.asyncStatus.text=text }) { [weak self] result in
                    switch result {case .success(var report):report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=self?.window != nil;self?.write("ios-async-benchmark.json",report);case .failure(let error):self?.write("ios-async-benchmark.json",["failed":true,"error":String(describing:error)])}
                }
            }}
            if ProcessInfo.processInfo.arguments.contains("--async-test") {DispatchQueue.main.asyncAfter(deadline:.now()+0.5){ [weak self] in
                let args=ProcessInfo.processInfo.arguments,index=args.firstIndex(of:"--async-bars"),count=index.flatMap {$0+1<args.count ? Int(args[$0+1]) : nil} ?? 8192
                verifyNativeAsync(Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:count,status:{ [weak self] text in self?.asyncStatus.text=text }) { [weak self] result in
                    switch result {case .success(var report):report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=self?.window != nil;self?.write("ios-async-validation.json",report);case .failure(let error):self?.write("ios-async-validation.json",["failed":true,"error":String(describing:error)])}
                }
            }}
            if ProcessInfo.processInfo.arguments.contains("--self-test") {DispatchQueue.main.asyncAfter(deadline:.now()+1){self.verify()}}
        } catch {write("ios-validation.json",["failed":true,"error":"\(error)"])}
    }
    @objc func asyncAction(_ sender:UIButton) {
        if sender.title(for:.normal)=="Cancel" {asyncJob?.cancel();return}
        if sender.title(for:.normal)=="Prepare1m" {prepareDemo();return}
        do {
            let event:[String:Any]=["kind":"correction","bar":["time":1700000000000.0,"open":100,"high":1000,"low":0,"close":1000,"volume":123]]
            asyncJob=try engine.applyDataEventAsync(event,progress:{ [weak self] value in self?.asyncStatus.text="\(value.phase) \(value.done)/\(value.total)" }) { [weak self] result in
                self?.asyncJob=nil
                switch result {case .success(let metrics):self?.asyncStatus.text=String(format:"Done %.0f ms",metrics.totalMs);case .failure(let error):self?.asyncStatus.text=String(describing:error)}
                self?.refreshComparison()
            }
        } catch {asyncStatus.text=String(describing:error)}
    }
    func cancelAsync() {asyncJob?.cancel()}
    func refreshComparison(){if let caption=analysisCaption{comparisonReadout.text=caption;for (action,button) in comparisonButtons{button.isEnabled=action=="setup"};return};for (action,button) in comparisonButtons{button.isEnabled=action=="setup"||comparisonActive};guard comparisonActive else{comparisonReadout.text="Primary OHLCV · Compare opens synthetic B";return};do{comparisonReadout.text=try nativeComparisonLabel(nativeComparisonPacket(engine,width:max(100,chart.bounds.width),height:max(80,chart.bounds.height)));let state=try engine.command("inspect").toDictionary()!,axes=state["axes"] as? [[String:Any]] ?? [],axis=axes.first{$0["id"] as? String=="comparison-B"},series=state["series"] as? [[String:Any]] ?? [];comparisonButtons["hide-axis"]?.setTitle((axis?["visible"] as? Bool)==false ? "Show B labels" : "Hide B labels",for:.normal);comparisonButtons["scale"]?.setTitle("B "+(axis?["scale"] as? String ?? "linear"),for:.normal);comparisonButtons["drawing"]?.isEnabled=series.contains{$0["id"] as? String=="comparison-B-line"};comparisonButtons["load"]?.isEnabled=savedComparison != nil}catch{comparisonReadout.text=String(describing:error)}}
    @objc func analysisAction(){
        guard asyncJob==nil else{asyncStatus.text="Cancel calculation first";return}
        do{let report=try nativeAnalysisSession(engine);analysisCaption=nativeAnalysisCaption(report);comparisonActive=false;savedComparison=nil;refreshComparison();chart.setNeedsDisplay()}catch{comparisonReadout.text=String(describing:error)}
    }
    func verifyStudyUI(){do{
        window?.rootViewController?.view.layoutIfNeeded();analysisButton.sendActions(for:.touchUpInside)
        guard analysisCaption != nil else{throw AsterError.javaScript("Session VWAP button did not install the study demo")}
        let width=max(100,chart.bounds.width),height=max(80,chart.bounds.height);var report=try verifyNativeAnalysisView(engine,width:width,height:height)
        chart.setNeedsDisplay();chart.layoutIfNeeded();let image=UIGraphicsImageRenderer(bounds:chart.bounds).image{_ in chart.drawHierarchy(in:chart.bounds,afterScreenUpdates:true)}
        guard chart.lastError==nil,let png=image.pngData(),png.count>10000 else{throw AsterError.invalidScene}
        let expected=try engine.call("nativeAccessibilityText",[true,"uikit"]).toString()
        guard chart.accessibilityValue==expected else{throw AsterError.javaScript("UIKit accessibility value did not follow the current rendered hover")}
        report["host"]="UIKit + CoreGraphics + JavaScriptCore";report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=window != nil;report["uiControlActions"]=true;report["nativePointerController"]=true;report["nativeUITouchInjected"]=false;report["physicalDevice"]=false;report["accessibilityValueExact"]=true;report["snapshotBytes"]=png.count
        try png.write(to:FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("ios-study-ui.png"));write("ios-studies-ui-validation.json",report)
    }catch{write("ios-studies-ui-validation.json",["failed":true,"error":String(describing:error)])}}
    @objc func comparisonAction(_ sender:UIButton){
        guard let action=comparisonButtons.first(where:{$0.value===sender})?.key else{return}
        do{
            if action=="range"||action=="precision"{
                let axes=try engine.command("inspect").forProperty("axes").toArray() as? [[String:Any]] ?? []
                guard let axis=axes.first(where:{$0["id"] as? String=="comparison-B"}) else{throw AsterError.javaScript("Missing comparison axis")}
                var patch:[String:Any]=[:]
                if action=="range"{patch["range"]=(axis["range"] as? [Any]) == nil ? [2000,2240] as Any : NSNull()}
                else{patch["precision"]=(axis["precision"] as? Int)==0 ? 3 : 0}
                _=try engine.command("setAxis",["comparison-B",patch])
            }else{
                let result=try nativeComparisonAction(engine,action,width:max(100,chart.bounds.width),height:max(80,chart.bounds.height),saved:action=="load" ? savedComparison : nil)
                if action=="save"{savedComparison=result["savedDocument"] as? String}
                if action=="setup"{comparisonActive=true;savedComparison=nil;analysisCaption=nil}
            }
            refreshComparison();chart.setNeedsDisplay()
        }catch{comparisonReadout.text=String(describing:error)}
    }
    func verifyAxesUI(){do{
        window?.rootViewController?.view.layoutIfNeeded();let width=max(100,chart.bounds.width),height=max(80,chart.bounds.height);var report=try verifyNativeAxes(engine,width:width,height:height),uiChecks:[String]=[];comparisonActive=true;refreshComparison()
        func check(_ value:Bool,_ reason:String)throws{guard value else{throw AsterError.javaScript(reason)};uiChecks.append(reason)}
        func pointer(_ index:Int)throws{let point=try nativeAxisPoint(engine,index:index,width:width,height:height);_=try engine.call("nativeResize",[width,height]);_=try engine.call("nativePointer",["move",0,point["x"]!,point["y"]!]);refreshComparison()}
        try pointer(2);try check(comparisonReadout.text?.contains("C 103.00")==true&&comparisonReadout.text?.contains("SYNTH:B 2020.000")==true,"UIKit readout separates primary/B")
        try pointer(3);try check(comparisonReadout.text?.contains("C 104.00")==true&&comparisonReadout.text?.contains("SYNTH:B gap")==true,"UIKit readout keeps exact UTC gap")
        comparisonButtons["drawing"]!.sendActions(for:.touchUpInside);comparisonButtons["save"]!.sendActions(for:.touchUpInside);let saved=try engine.saveDrawings();try engine.undo();try engine.redo();try check(try engine.saveDrawings()==saved,"UIKit bound undo/redo exact")
        for name in ["scale","scale","range","precision","hide-axis","series","series","load","primary"]{comparisonButtons[name]!.sendActions(for:.touchUpInside)}
        try check(try engine.saveDrawings()==saved,"UIKit controls reconnect/load bound document");try check(try engine.command("inspect").forProperty("drawingTarget").isNull,"UIKit primary target control")
        let axis=(try engine.command("inspect").forProperty("axes").toArray() as! [[String:Any]])[0]
        try check(axis["scale"] as? String=="percent"&&axis["precision"] as? Int==0&&axis["visible"] as? Bool==false&&(axis["range"] as? [Int])==[2000,2240],"UIKit scale/range/precision/visibility controls")
        chart.setNeedsDisplay();chart.layoutIfNeeded();let image=UIGraphicsImageRenderer(bounds:chart.bounds).image{_ in chart.drawHierarchy(in:chart.bounds,afterScreenUpdates:true)},bytes=image.pngData()!;try check(chart.lastError==nil&&bytes.count>10000,"UIKit independent axes raster");try bytes.write(to:FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("ios-native-axes.png"))
        report["uiPassed"]=uiChecks.count;report["uiChecks"]=uiChecks;report["host"]="UIKit + CoreGraphics + JavaScriptCore";report["ios"]=UIDevice.current.systemVersion;report["nativeWindow"]=window != nil;report["uiControlActions"]=true;report["nativePointerController"]=true;report["nativeUITouchInjected"]=false
        asyncJob=try verifyNativeAxesHandoff(engine,width:width,height:height){[weak self] result in do{let final=nativeAxesCombinedReport(report,try result.get());self?.asyncJob=nil;self?.refreshComparison();self?.write("ios-axes-validation.json",final)}catch{self?.write("ios-axes-validation.json",["failed":true,"error":String(describing:error)])}}
    }catch{write("ios-axes-validation.json",["failed":true,"error":String(describing:error)])}}
    func argument(_ flag:String,_ fallback:Int)->Int {let args=ProcessInfo.processInfo.arguments;guard let i=args.firstIndex(of:flag),i+1<args.count,let n=Int(args[i+1]) else{return fallback};return n}
    func prepareDemo(){do{asyncJob=try engine.prepareSeededAsync(count:1000000,timeout:120,progress:{[weak self] p in self?.asyncStatus.text="\(p.phase) \(p.done)/\(p.total)"}){[weak self] result in self?.asyncJob=nil;switch result{case .success(let m):self?.asyncStatus.text=String(format:"Prepared %.0fms",m.totalMs);case .failure(let error):self?.asyncStatus.text=String(describing:error)}}}catch{asyncStatus.text=String(describing:error)}}
    @objc func action(_ sender: UIButton) {
        let name = sender.title(for:.normal) ?? "Select"
        do {if ["Undo","Redo"].contains(name) {try engine.call("nativeKey",["z",true,name=="Redo"]);chart.setNeedsDisplay()}
            else {chart.setTool(["Select":"select","Line":"trendline","Freehand":"freehand","Channel":"channel","Fib":"fibextension"][name]!)}
        } catch {print(error)}
    }
    func write(_ name:String,_ report:[String:Any]) {do {let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent(name))}catch{print(error)}}
    func require(_ value:Bool,_ message:String)throws{if !value {throw AsterError.javaScript(message)};checks.append(message)}
    func verify() {
        do {
            let core = try JSONSerialization.jsonObject(with: engine.call("nativeSelfTest").toString()!.data(using:.utf8)!) as! [String:Any]
            let extended = try JSONSerialization.jsonObject(with: engine.call("nativeExtendedSelfTest").toString()!.data(using:.utf8)!) as! [String:Any]
            try require(core["passed"] as? Int == 5,"shared core checks")
            try require(extended["passed"] as? Int == 6,"extended core checks")
            var apiTests = try verifyCommonAPI(engine)
            let smallInk = try nativeTextInk("12px monospace"),largeInk = try nativeTextInk("bold 36px monospace")
            try require(apiTests["passed"] as? Int == 12 && largeInk > smallInk*2,"Common Swift facade and native font raster")
            apiTests["passed"] = 13;apiTests["fontSmallInk"] = smallInk;apiTests["fontLargeInk"] = largeInk
            try engine.call("nativeResize",[chart.bounds.width,chart.bounds.height]);try engine.call("nativeTool",["channel"])
            try engine.call("nativePointer",["down",1,120,150]);try engine.call("nativePointer",["move",1,240,200]);try engine.call("nativePointer",["up",1,0,0])
            let saved = try engine.saveDrawings();try require(saved.contains("channel"),"channel anchors")
            try engine.call("nativeKey",["z",true,false]);try require(engine.saveDrawings().contains("\"drawings\":[]"),"undo")
            try engine.call("nativeKey",["z",true,true]);try require(engine.saveDrawings()==saved,"redo exact restoration")
            let added = ["dema","tema","hma","keltner","supertrend","ichimoku","trix","ppo","stochRSI","adl","chaikin","forceIndex","volumeOscillator","vortex","pivots","parabolicSAR"]
            for name in added {try engine.call("nativeIndicator",["test-"+name,name,[:],"price"])}
            let scene = try engine.scene(width:chart.bounds.width,height:chart.bounds.height);try require(scene.stats["storedBars"]==10000,"scene data")
            chart.setNeedsDisplay();chart.layoutIfNeeded();let image = UIGraphicsImageRenderer(bounds:chart.bounds).image{_ in chart.drawHierarchy(in:chart.bounds,afterScreenUpdates:true)}
            let data=image.pngData()!;try require(data.count>10000,"UIKit chart raster")
            try data.write(to:FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("ios-native.png"))
            var report: [String:Any] = ["checks":checks,"core":core,"extended":extended,"api":apiTests,"host":"UIKit + CoreGraphics + JavaScriptCore (no WebView)","ios":UIDevice.current.systemVersion,"nativeWindow":window != nil,"undoRedoExact":true,"addedIndicators":added.count,"snapshotBytes":data.count,"nativeUITouchInjected":false,"physicalDevice":false]
            var rows:[[String:Any]]=[]
            for count in [10000,100000] {
                let begin=CFAbsoluteTimeGetCurrent();try engine.call("nativeInit",[count]);let load=(CFAbsoluteTimeGetCurrent()-begin)*1000
                var samples:[Double]=[],stats:[String:Int]=[:];let format=UIGraphicsImageRendererFormat();format.scale=1
                let renderer=UIGraphicsImageRenderer(size:CGSize(width:1200,height:700),format:format)
                for i in 0..<70 {let start=CFAbsoluteTimeGetCurrent(),scene=try engine.scene(width:1200,height:700);stats=scene.stats;_ = renderer.image{ctx in AsterCoreGraphicsRenderer.render(scene,in:ctx.cgContext)};if i>=10{samples.append((CFAbsoluteTimeGetCurrent()-start)*1000)}}
                samples.sort();rows.append(["storedBars":count,"stats":stats,"loadGenerateCopyEMAms":load,"sceneJSONDecodeCoreGraphicsImageMs":["p50":samples[29],"p95":samples[56],"p99":samples[58]]])
            }
            write("ios-benchmark.json",["seed":42,"warmup":10,"samples":60,"width":1200,"height":700,"dpr":1,"rows":rows]);try engine.call("nativeInit",[10000]);chart.setNeedsDisplay()
            // Prior frames finish before an engine-only mutation. No manual
            // setNeedsDisplay/drawHierarchy occurs between mutation and check.
            DispatchQueue.main.asyncAfter(deadline:.now()+0.15) {
                do {let before=self.chart.renderedRevision;try self.engine.setTheme(["background":"#152535"]);let expected=self.engine.revision
                    DispatchQueue.main.asyncAfter(deadline:.now()+0.2) {
                        do {try self.require(self.chart.lastError == nil && self.chart.renderedRevision == expected && expected > before,"Engine commands automatically redraw UIKit view");report["passed"]=self.checks.count;report["checks"]=self.checks;report["automaticRedraw"]=true;self.write("ios-validation.json",report)}
                        catch {self.write("ios-validation.json",["failed":true,"error":"\(error)"])}
                    }
                } catch {self.write("ios-validation.json",["failed":true,"error":"\(error)"])}
            }
        } catch {write("ios-validation.json",["failed":true,"error":"\(error)"])}
    }
}
final class AsterSceneDelegate: UIResponder, UIWindowSceneDelegate {
    func sceneWillResignActive(_ scene:UIScene) {(UIApplication.shared.delegate as? AppDelegate)?.cancelAsync()}
    func sceneDidEnterBackground(_ scene:UIScene) {(UIApplication.shared.delegate as? AppDelegate)?.soak?.backgrounded()}
    func sceneDidBecomeActive(_ scene:UIScene) {(UIApplication.shared.delegate as? AppDelegate)?.soak?.foregrounded()}
    func sceneDidDisconnect(_ scene:UIScene) {let delegate=UIApplication.shared.delegate as? AppDelegate;delegate?.stopDataControls();delegate?.cancelAsync();delegate?.soak?.stop();try? delegate?.engine?.close()}
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene=scene as? UIWindowScene,let delegate=UIApplication.shared.delegate as? AppDelegate else{return};delegate.start(windowScene)
    }
}
