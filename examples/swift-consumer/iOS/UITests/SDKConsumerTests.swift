import XCTest

final class SDKConsumerTests:XCTestCase {
    func testIndependentPackageResourceExternalFeedDrawingAsyncAndBorrowedLifetime(){
        continueAfterFailure=false
        let app=XCUIApplication();app.launchArguments=["--sdk-xcui"];app.launch();let status=app.staticTexts["sdk.status"]
        func wait(_ text:String){let ready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"label CONTAINS %@",text),object:status);XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:40),.completed,"Expected \(text), actual \(status.label)")}
        wait("Ready");XCTAssertTrue(app.otherElements["sdk.chart"].exists)
        app.buttons["sdk.prepare"].tap();wait("Prepared512")
        let chart=app.otherElements["sdk.chart"]
        chart.coordinate(withNormalizedOffset:CGVector(dx:0.35,dy:0.2)).press(forDuration:0.05,thenDragTo:chart.coordinate(withNormalizedOffset:CGVector(dx:0.65,dy:0.2)))
        app.buttons["sdk.drawings"].tap();wait("Drawings verified")
        app.buttons["sdk.correct"].tap();wait("Correction verified")
        let rendered=XCTAttachment(screenshot:app.screenshot());rendered.name="Independent SwiftPM UIKit chart after async correction";rendered.lifetime = .keepAlways;add(rendered)
        app.buttons["sdk.dispose"].tap();wait("borrowed engine alive");XCTAssertFalse(app.otherElements["sdk.chart"].exists)
        app.buttons["sdk.close"].tap();wait("SDK consumer passed")
        let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.name="Independent SwiftPM consumer completed";screenshot.lifetime = .keepAlways;add(screenshot)
    }
}
