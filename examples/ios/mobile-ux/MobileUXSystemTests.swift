import XCTest

@MainActor final class MobileUXSystemTests:XCTestCase {
    let app=XCUIApplication(bundleIdentifier:"dev.aster.charts.mobileux")
    override func setUpWithError()throws{continueAfterFailure=false;app.launch();XCTAssertTrue(app.buttons["ux-reset"].waitForExistence(timeout:10))}
    func state()throws->[String:Any]{let text=app.staticTexts["ux-state"].label;return try JSONSerialization.jsonObject(with:Data(text.utf8)) as! [String:Any]}
    func viewSpan()throws->Double{let view=try state()["view"] as! [String:Double];return view["to"]!-view["from"]!}
    var chart:XCUIElement{app.otherElements["aster-chart"]}
    func coordinate(_ p:[Double])->XCUICoordinate {chart.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0)).withOffset(CGVector(dx:p[0],dy:p[1]))}
    func testBaselineContracts()throws {
        app.buttons["ux-checks"].tap();let s=try state();XCTAssertEqual((s["failures"] as! [String]).count,0,"Native contract baseline failures: \(s["failures"]!)")
    }
    func testBaselineBackgroundCancellation()throws {
        app.buttons["ux-pending"].tap();XCTAssertEqual(try state()["pointers"] as? Int,1)
        XCUIDevice.shared.press(.home);app.activate();XCTAssertEqual(try state()["pointers"] as? Int,0,"Scene/app resign must cancel unfinished native controller input")
    }
    func testReentrantDispose()throws {
        app.terminate();app.launchArguments=["--reentry"];app.launch();XCTAssertTrue(app.buttons["ux-reset"].waitForExistence(timeout:10));XCTAssertEqual((try state()["failures"] as! [String]).count,0,"Reentrant disposal contract")
    }
    func testBatchCallbackCancellation()throws {
        for kind in ["batch-dispose","batch-font","batch-resize"]{try verifyBatch(kind)}
    }
    func testBatchAccessibleCancel()throws {try verifyBatch("batch-cancel")}
    func testAccessibleEscapeSemantics()throws {
        app.terminate();app.launchArguments=["--cancel-semantics"];app.launch();XCTAssertTrue(app.buttons["ux-reset"].waitForExistence(timeout:10));XCTAssertEqual((try state()["failures"] as! [String]).count,0)
    }
    func verifyBatch(_ kind:String)throws {
        app.terminate();app.launchArguments=["--"+kind];app.launch();XCTAssertTrue(app.buttons["ux-reset"].waitForExistence(timeout:10));chart.pinch(withScale:1.4,velocity:1)
        let s=try state(),events=s["batchTouchEvents"] as! [[String:Any]],record=events.last!;XCTAssertEqual(record["kind"] as? String,kind);XCTAssertEqual(record["beganTouches"] as? Int,2);XCTAssertEqual(record["chartTargetBegans"] as? Int,2);XCTAssertEqual(record["pointerIDsAfterDispatch"] as? Int,0);XCTAssertEqual(record["corePointersAfterDispatch"] as? Int,0)
    }
    func testNativeSystemInputAndUX()throws {
        app.buttons["ux-reset"].tap();let initial=try viewSpan()
        chart.pinch(withScale:1.5,velocity:1);XCTAssertLessThan(try viewSpan(),initial);XCTAssertEqual(try state()["pointers"] as? Int,0)
        let origin=chart.coordinate(withNormalizedOffset:CGVector(dx:0.6,dy:0.65)),end=chart.coordinate(withNormalizedOffset:CGVector(dx:0.4,dy:0.65));let before=try state()["view"] as! [String:Double];origin.press(forDuration:0.1,thenDragTo:end);let after=try state()["view"] as! [String:Double];XCTAssertNotEqual(before["from"],after["from"]);XCTAssertFalse((try state()["crosshair"] as! [String:Any]).isEmpty)
        app.buttons["ux-reset"].tap();var s=try state();var line=s["linePoint"] as! [Double];line[1]+=18;coordinate(line).tap();XCTAssertEqual(try state()["selected"] as? String,"line","44pt touch target selects drawing 18pt from thin line")
        app.buttons["ux-reset"].tap();s=try state();let handle=s["handlePoint"] as! [Double];coordinate(handle).press(forDuration:0.1,thenDragTo:coordinate([handle[0]+12,handle[1]+18]));let drawings=try state()["drawings"] as! [[String:Any]],trend=drawings.first{$0["id"] as? String=="trend"}!;XCTAssertNotEqual((trend["points"] as! [[String:Double]])[0]["price"],108)
        app.buttons["ux-draw"].tap();coordinate([chart.frame.width*0.65,chart.frame.height*0.35]).tap();XCTAssertEqual((try state()["drawings"] as! [Any]).count,3)
        app.buttons["ux-select"].tap();app.buttons["ux-pending"].tap();XCTAssertEqual(try state()["pointers"] as? Int,1);XCUIDevice.shared.press(.home);app.activate();XCTAssertEqual(try state()["pointers"] as? Int,0);XCTAssertTrue(try state()["gesture"] is NSNull)
        for key in ["enable-touch","disable-touch","trait-touch","font-touch","resize-touch"]{
            let button=app.buttons["ux-"+key];XCTAssertTrue(button.exists&&button.isEnabled);let nativeFrames=try state()["buttonFrames"] as! [String:[Double]],native=nativeFrames[key]!
            // app.activate can return while the system's foreground window
            // presentation is still scaled. Wait for full native control bounds
            // before sending the next genuine system touch.
            let settled=XCTNSPredicateExpectation(predicate:NSPredicate{_,_ in let f=button.frame;return abs(f.minX-native[0])<=1&&abs(f.minY-native[1])<=1&&abs(f.width-native[2])<=1&&abs(f.height-native[3])<=1},object:nil)
            XCTAssertEqual(XCTWaiter.wait(for:[settled],timeout:8),.completed)
            print("UIKit control \(key): XCUI=\(button.frame), nativeWindow=\(native)")
            app.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0)).withOffset(CGVector(dx:native[0]+native[2]/2,dy:native[1]+native[3]/2)).tap();XCTAssertEqual(try state()["lastAction"] as? String,key)
            let p=try state()["linePoint"] as! [Double];coordinate(p).press(forDuration:0.1,thenDragTo:coordinate([p[0]+10,p[1]+14]));let record=(try state()["interruptions"] as! [[String:Any]]).last!;XCTAssertEqual(record["kind"] as? String,key)
            XCTAssertEqual(record["pointerIDsBefore"] as? Int,1);XCTAssertEqual(record["pointerIDsAfter"] as? Int,0);XCTAssertEqual(record["nativePointersAfter"] as? Int,0)
            XCTAssertEqual(try JSONSerialization.data(withJSONObject:record["anchorsBefore"]!,options:[.sortedKeys]),try JSONSerialization.data(withJSONObject:record["anchorsAfter"]!,options:[.sortedKeys]));XCTAssertEqual(try state()["pointers"] as? Int,0)
        }
        XCUIDevice.shared.orientation = .landscapeLeft;let rotated=try state()["bounds"] as! [Double];XCTAssertGreaterThan(rotated[0],rotated[1]);XCTAssertEqual(try state()["pointers"] as? Int,0)
        XCUIDevice.shared.orientation = .portrait;app.buttons["ux-large"].tap();XCTAssertGreaterThan(try state()["fontSize"] as! Double,18)
        app.buttons["ux-checks"].tap();XCTAssertEqual((try state()["failures"] as! [String]).count,0);XCTAssertEqual(try state()["viewReleased"] as? Bool,true)
        let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="uikit-mobile-ux-system-input";attachment.lifetime = .keepAlways;add(attachment)
        app.buttons["ux-finish"].tap();XCTAssertTrue(app.staticTexts["ux-state"].label.contains("finished"))
    }
}
