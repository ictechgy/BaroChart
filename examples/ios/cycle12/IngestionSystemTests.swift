import XCTest

// Genuine public XCUI Automation on the runner's own Simulator. No generated
// UITouch, direct controller call or synthetic NSEvent substitutes this path.
@MainActor final class Cycle12SystemTests:XCTestCase {
    func testSystemInputWhileTwoSymbolsReceiveData()throws {
        continueAfterFailure=false;executionTimeAllowance=1500
        let env=ProcessInfo.processInfo.environment,seconds=Double(env["CYCLE12_SECONDS"] ?? "900") ?? 900
        let app=XCUIApplication(bundleIdentifier:"dev.aster.cycle12.apple");app.launchArguments=["--enable-cycle12-runtime"]
        for name in ["CYCLE12_SECONDS","CYCLE12_BARS","CYCLE12_WARMUP","CYCLE12_FUNCTIONAL_PILOT"]{if let value=env[name]{app.launchEnvironment[name]=value}}
        app.launch();let status=app.staticTexts["cycle12-status"]
        func wait(_ value:String,_ timeout:Double){let expectation=XCTNSPredicateExpectation(predicate:NSPredicate(format:"label == %@ OR label == 'FAILED'",value),object:status);XCTAssertEqual(XCTWaiter.wait(for:[expectation],timeout:timeout),.completed,"Expected"+value+", actual"+status.label);XCTAssertEqual(status.label,value)}
        wait("READY",180);let chart=app.otherElements["cycle12-chart"];XCTAssertTrue(chart.exists)
        let a=chart.coordinate(withNormalizedOffset:CGVector(dx:0.66,dy:0.30)),b=chart.coordinate(withNormalizedOffset:CGVector(dx:0.36,dy:0.42)),c=chart.coordinate(withNormalizedOffset:CGVector(dx:0.41,dy:0.44))
        app.buttons["cycle12-arm"].tap();wait("MEASURING",40)
        let started=ProcessInfo.processInfo.systemUptime;var gestures=0
        while ProcessInfo.processInfo.systemUptime-started<max(1,seconds-3){
            a.press(forDuration:0.05,thenDragTo:b,withVelocity:XCUIGestureVelocity(rawValue:80),thenHoldForDuration:0.05);gestures+=1
            // Exercise both directions even in the short functional pilot.
            // Public XCTest requires negative velocity for scale below1.
            if gestures%4==0||gestures==1{chart.pinch(withScale:1.15,velocity:1);chart.pinch(withScale:1/1.15,velocity:-1);print("SYSTEM_PINCH_PAIR gesture=\(gestures) scale1.15 velocity+1 / scale0.869565 velocity-1 completed")}
            if gestures%8==0||seconds<60&&gestures==1{app.buttons["cycle12-line"].tap();a.press(forDuration:0.05,thenDragTo:b);app.buttons["cycle12-select"].tap();b.press(forDuration:0.05,thenDragTo:c);app.buttons["cycle12-cancel"].tap()}
        }
        wait("FINISHED",180);print("Actual public XCUI slow-drag calls:"+String(gestures))
        let close=app.buttons["cycle12-close"],nativeFrame=close.frame;XCUIDevice.shared.press(.home);app.activate();XCTAssertTrue(chart.exists)
        let settled=XCTNSPredicateExpectation(predicate:NSPredicate{_,_ in let frame=close.frame;return abs(frame.minX-nativeFrame.minX)<=1&&abs(frame.minY-nativeFrame.minY)<=1&&abs(frame.width-nativeFrame.width)<=1&&abs(frame.height-nativeFrame.height)<=1},object:nil)
        XCTAssertEqual(XCTWaiter.wait(for:[settled],timeout:8),.completed);close.tap();wait("CLOSED",8)
        // The runner separately verifies delivered native touch events, feed
        // interleaving, all raw vectors, bounded ledgers and post-event weak ARC.
    }
}
