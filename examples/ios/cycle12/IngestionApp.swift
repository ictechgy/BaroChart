import UIKit

@main final class Cycle12AppDelegate:UIResponder,UIApplicationDelegate {
    func application(_ app:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration{let config=UISceneConfiguration(name:"Cycle12",sessionRole:session.role);config.delegateClass=Cycle12SceneDelegate.self;return config}
}
final class Cycle12SceneDelegate:UIResponder,UIWindowSceneDelegate {
    var window:Cycle12Window?,controller:Cycle12Controller?
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions){guard let scene=scene as? UIWindowScene else{return};let controller=Cycle12Controller(),window=Cycle12Window(windowScene:scene);window.probe=controller.probe;window.rootViewController=controller;self.controller=controller;self.window=window;window.makeKeyAndVisible()}
    func sceneWillResignActive(_ scene:UIScene){controller?.backgrounded()}
    func sceneDidDisconnect(_ scene:UIScene){controller?.cleanup()}
}
final class Cycle12Controller:UIViewController {
    let probe=Cycle12Probe()
    private var feeds=[Cycle12Feed](),engines=[AsterEngine](),chart:AsterChartView?,jobs=[AsterAsyncJob](),retainedJobs=[AsterAsyncJob](),sampler=Cycle12ProcessSampler(),status=UILabel()
    private var report:[String:Any]=["schema":"aster.cycle12.ios-pressure","physicalDevice":false,"platformSpeedComparison":false],finished=false,closed=false,armed=false,initialCount=100000,seconds=900.0,warmup=30.0,oracleIndex=0
    private var observerTokens=[UUID](),observerCounts=[Int](repeating:0,count:2),reference:AsterEngine?,replayOffset=0,oracleRows=[[String:Any]]()
    override func viewDidLoad(){super.viewDidLoad();view.backgroundColor = .black
        let env=ProcessInfo.processInfo.environment;initialCount=Int(env["CYCLE12_BARS"] ?? "100000") ?? 100000;seconds=Double(env["CYCLE12_SECONDS"] ?? "900") ?? 900;warmup=Double(env["CYCLE12_WARMUP"] ?? "30") ?? 30
        status.textColor = .white;status.numberOfLines=2;status.accessibilityIdentifier="cycle12-status";status.text="PREPARED_ONLY"
        let controls=UIStackView();controls.spacing=4;controls.distribution = .fillEqually
        for(title,key,selector) in [("Arm","cycle12-arm",#selector(arm)),("Line","cycle12-line",#selector(line)),("Select","cycle12-select",#selector(chooseSelection)),("Cancel","cycle12-cancel",#selector(cancelInput)),("Finish","cycle12-finish",#selector(finish)),("Close","cycle12-close",#selector(closeAction))]{let button=UIButton(type:.system);button.setTitle(title,for:.normal);button.accessibilityIdentifier=key;button.addTarget(self,action:selector,for:.touchUpInside);controls.addArrangedSubview(button)}
        let stack=UIStackView(arrangedSubviews:[status,controls]);stack.axis = .vertical;stack.spacing=4;stack.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(stack);NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.leadingAnchor),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor),stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),stack.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor)]);controls.heightAnchor.constraint(equalToConstant:44).isActive=true
        guard ProcessInfo.processInfo.arguments.contains("--enable-cycle12-runtime") else{return}
        guard (12...900).contains(seconds),(0...30).contains(warmup),(512...100000).contains(initialCount),seconds==900||env["CYCLE12_FUNCTIONAL_PILOT"]=="1" else{fail(AsterError.javaScript("Explicit pilot flag or900s candidate required"));return}
        do{report["buildManifest"]=try JSONSerialization.jsonObject(with:Data(contentsOf:Bundle.main.url(forResource:"build-manifest",withExtension:"json")!));report["studyGolden"]=try makeGolden()
            for i in 0..<2{let engine=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:0,options:["panels":[["id":"price","weight":3],["id":"volume","weight":1]],"series":i==0 ? [["id":"price","type":"candles","panel":"price"]]:[]]);engines.append(engine);_=try engine.command("setSymbol",[["id":i==0 ? "SYNTH:A":"SYNTH:B","exchange":"SYNTHETIC","timezone":"UTC","currency":"USD","volumeUnit":"synthetic","priceDecimals":2,"tickSize":0.01,"adjustment":"raw"]])}
            var completed=0
            for engine in engines{let job=try engine.prepareSeededAsync(count:initialCount,seed:42,timeout:120){[weak self] result in guard let self=self else{return};do{_=try result.get();completed+=1;if completed==2{self.retainedJobs.append(contentsOf:self.jobs);self.jobs.removeAll();try self.ready(stack)}}catch{self.fail(error)}};jobs.append(job)}
            status.text="PREPARING"
        }catch{fail(error)}
    }
    private func ready(_ stack:UIStackView)throws{for(i,engine) in engines.enumerated(){try Cycle12Oracle.indicators(engine,series:i==0);let token=try engine.observeChanges{[weak self] in self?.observerCounts[i]+=1};observerTokens.append(token)}
        let chart=AsterChartView(engine:engines[0]);chart.accessibilityIdentifier="cycle12-chart";stack.addArrangedSubview(chart);self.chart=chart
        let last=Cycle12Oracle.bar(try engines[0].command("inspect").forProperty("lastBar").toDictionary()!);try engines[0].setPanel("price",["range":[last.close-5,last.close+5]]);report["readyProcess"]=Cycle12ProcessSampler.snapshot();report["initialBarsPerSymbol"]=initialCount;report["symbols"]=["A visible UIKit chart","B independent offscreen engine"];status.text="READY"
    }
    @objc private func arm(){guard !armed,!finished,jobs.isEmpty,engines.count==2 else{return};armed=true
        do{for engine in engines{let feed=Cycle12Feed();feed.duringOSInput={[weak self] in guard let window=self?.view.window as? Cycle12Window else{return false};return !window.activeTouchIDs.isEmpty};feed.onFailure={[weak self] error in self?.fail(error)};feeds.append(feed);let tail=Cycle12Oracle.bar(try engine.command("inspect").forProperty("lastBar").toDictionary()!);try feed.start(engine,initialCount:initialCount,tail:tail,appendEvery:seconds==900 ? 500:10)}
            status.text="WARMUP"
            DispatchQueue.main.asyncAfter(deadline:.now()+warmup){[weak self] in guard let self=self,!self.finished else{return};self.report["measureStartProcess"]=Cycle12ProcessSampler.snapshot();self.probe.begin();self.feeds.forEach{$0.beginHistoryClock(interval:self.seconds==900 ? 300:6)};self.sampler.start();self.status.text="MEASURING";DispatchQueue.main.asyncAfter(deadline:.now()+self.seconds){[weak self] in self?.finish()}}
        }catch{fail(error)}
    }
    @objc private func line(){chart?.setTool("trendline")}
    @objc private func chooseSelection(){chart?.setTool("select")}
    @objc private func cancelInput(){_=chart?.accessibilityPerformEscape();report["accessibleCancelActions"]=(report["accessibleCancelActions"] as? Int ?? 0)+1}
    @objc private func finish(){guard !finished,armed else{return};finished=true
        do{var rows:[[String:Any]]=[];for feed in feeds{rows.append(try feed.stop())};probe.stop();report["probe"]=probe.report();report["sampler"]=sampler.stop();report["feed"]=rows;report["measurementEndProcess"]=Cycle12ProcessSampler.snapshot();report["requestedSeconds"]=seconds;report["warmupSeconds"]=warmup;report["nativeDrawHookInstrumented"] = Bundle.main.object(forInfoDictionaryKey:"Cycle12Instrumented") as? Bool ?? false
            let directory=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first!;report["appliedTrace"]=try feeds.enumerated().map{i,feed in try feed.writeAppliedTrace(directory.appendingPathComponent("applied-symbol-\(i).bin"))}
            report["observedChanges"]=observerCounts;status.text="VERIFYING";write();verifyNext()
        }catch{fail(error)}
    }
    private func verifyNext(){guard !closed else{return};do{
        if oracleIndex==engines.count{report["oracle"]=oracleRows;report["allRawAndOutputsEqual"]=true;try drawingChecks();status.text="FINISHED";write();return}
        if reference==nil{let reference=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:initialCount,options:["panels":[["id":"price"],["id":"volume"]],"series":[]]);try Cycle12Oracle.indicators(reference,series:false);self.reference=reference;replayOffset=0}
        let messages=feeds[oracleIndex].messages(),end=min(messages.count,replayOffset+256);for i in replayOffset..<end{try reference!.applyDataEvent(messages[i].event)};replayOffset=end
        if end==messages.count{let source=engines[oracleIndex],count=try source.command("inspect").forProperty("storedBars").toInt32();let row=try Cycle12Oracle.equal(source,reference!,count:Int(count));oracleRows.append(row);try reference!.close();reference=nil;oracleIndex+=1}
        DispatchQueue.main.async{[weak self] in self?.verifyNext()}
    }catch{fail(error)}}
    private func drawingChecks()throws{let engine=engines[0]
        // Saving an active transaction correctly rejects. Capture its immutable
        // committed frame through test-only constant inspection, then exercise
        // the public UIKit cancellation before calling the public writer.
        let before=try Cycle12Oracle.read(engine,"JSON.stringify(nativeModel.drawings.transaction??nativeModel.drawings.items)").toString()!
        _=chart?.accessibilityPerformEscape();let after=try engine.saveDrawings(),document=try JSONSerialization.jsonObject(with:Data(after.utf8)) as! [String:Any],state=try engine.command("inspect").toDictionary()!
        guard try Cycle12Oracle.json(JSONSerialization.jsonObject(with:Data(before.utf8)))==Cycle12Oracle.json(document["drawings"]!),state["pointers"] as? Int==0,state["gesture"] is NSNull else{throw AsterError.javaScript("Escape changed committed anchors or retained input")};report["drawingChecks"]=["accessibleEscapePreservesCommittedDocument":true,"pointersAfter":0,"saved":after,"inputBoundary":"XCUI draw/edit plus UIControl accessibleEscape; cancel control is not a synthetic UITouch.cancel"]}
    private func makeGolden()throws->[String:Any]{let engine=try AsterEngine(bundleURL:Bundle.main.url(forResource:"aster-core",withExtension:"js")!,count:0,options:["panels":[["id":"price"]],"series":[]]);defer{try? engine.close()};try engine.setData([AsterBar(time:1700000000000,open:10,high:10,low:10,close:10,volume:2),AsterBar(time:1700000060000,open:14,high:14,low:14,close:14,volume:3)]);_=try engine.addIndicator("golden","vwap",["source":"close","sessionMs":86400000,"deviation":2]);let value=try engine.indicatorValueAt("golden",output:"value",index:1),deviation=try engine.indicatorValueAt("golden",output:"deviation",index:1);guard abs((value["value"] as! Double)-12.4)<1e-12,abs((deviation["value"] as! Double)-sqrt(3.84))<1e-12 else{throw AsterError.javaScript("Independent VWAP golden")};return ["passed":true,"expectedMean":12.4,"expectedPopulationVariance":3.84,"method":"Literal two-pass weighted population mean/variance separate from scalar consistency oracle"]}
    func backgrounded(){report["backgroundAt"]=Cycle12Probe.clock();if !finished&&armed{report["unexpectedMeasuredBackground"]=true;finish()};write()}
    @objc private func closeAction(){cleanup();status.text="CLOSED"}
    func cleanup(){guard !closed else{return};closed=true;for feed in feeds{_=try? feed.stop()};probe.stop();_=sampler.stop();jobs.forEach{$0.cancel()};let retainedJobs=self.retainedJobs+jobs;jobs.removeAll();self.retainedJobs.removeAll();try? reference?.close();reference=nil
        let weakEngines=engines.map{Cycle12Weak($0)},weakContexts=engines.map{Cycle12Weak($0.context)},weakVMs=engines.map{Cycle12Weak($0.context.virtualMachine)},weakRuntimes=engines.map{Cycle12Weak($0._asyncRuntimeLifetimeProbe())},weakFeeds=feeds.map{Cycle12Weak($0)},weakView=Cycle12Weak(chart)
        report["beforeCloseProcess"]=Cycle12ProcessSampler.snapshot();chart?.dispose();chart?.removeFromSuperview();chart=nil;for engine in engines{try? engine.close()};engines.removeAll();feeds.removeAll();observerTokens.removeAll();report["afterCloseProcess"]=Cycle12ProcessSampler.snapshot()
        DispatchQueue.main.asyncAfter(deadline:.now()+0.05){[weak self] in guard let self=self else{return};let handles=retainedJobs.map{$0._terminalRetentionProbe()};self.report["cleanup"]=["engineNil":weakEngines.allSatisfy{$0.value==nil},"contextNil":weakContexts.allSatisfy{$0.value==nil},"vmNil":weakVMs.allSatisfy{$0.value==nil},"runtimeNil":weakRuntimes.allSatisfy{$0.value==nil},"feedNil":weakFeeds.allSatisfy{$0.value==nil},"viewNil":weakView.value==nil,"retainedCompletedHandles":retainedJobs.count,"retainedJobsReleased":handles.allSatisfy{$0.inputBytes==0&&$0.callbacks==0&&$0.contexts==0},"ownerThread":Thread.isMainThread,"afterEventScope":true];self.report["afterDropProcess"]=Cycle12ProcessSampler.snapshot();self.write()}
    }
    private func fail(_ error:Error){report["failed"]=true;report["error"]=String(describing:error);status.text="FAILED";cleanup();write()}
    private func write(){guard let bytes=try? JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),let directory=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first else{return};try? bytes.write(to:directory.appendingPathComponent("cycle12-apple.json"))}
}
private final class Cycle12Weak{weak var value:AnyObject?;init(_ value:AnyObject?){self.value=value}}
