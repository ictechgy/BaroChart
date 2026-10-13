import Foundation

private final class SubscriptionCapture {}
private final class WeakSubscriptionCapture {
    weak var value:SubscriptionCapture?
    init(_ value:SubscriptionCapture){self.value=value}
}
private final class SubscriptionCounter {var calls=0}
private final class SubscriptionThreadResult {
    let lock=NSLock()
    private var wrongThread=false
    func set(_ value:Bool){lock.lock();wrongThread=value;lock.unlock()}
    func get()->Bool{lock.lock();defer{lock.unlock()};return wrongThread}
}

@inline(never) private func captureSubscription(_ engine:AsterEngine,_ counter:SubscriptionCounter)throws->(UUID,WeakSubscriptionCapture) {
    let capture=SubscriptionCapture(),reference=WeakSubscriptionCapture(capture)
    let token=try engine.observeChanges{[capture,counter] in _=capture;counter.calls+=1}
    return(token,reference)
}
@inline(never) private func captureClosedSubscription(_ engine:AsterEngine)->(UUID?,WeakSubscriptionCapture,Bool) {
    let capture=SubscriptionCapture(),reference=WeakSubscriptionCapture(capture)
    do{return(try engine.observeChanges{[capture] in _=capture},reference,false)}
    catch AsterAsyncError.engineClosed{return(nil,reference,true)}
    catch{return(nil,reference,false)}
}

/// Public API regression with a retained closed engine. No raw context access,
/// simulator, benchmark timing or inference of whole-process leak freedom.
func verifyNativeClosedSubscriptions(_ bundleURL:URL)throws->[String:Any] {
    let source=try AsterEngine(bundleURL:bundleURL,count:0),counter=SubscriptionCounter()
    var checks:[String]=[],failures:[String]=[]
    func require(_ value:Bool,_ name:String){if value{checks.append(name)}else{failures.append(name)}}
    let (openToken,openCapture)=try autoreleasepool{try captureSubscription(source,counter)}
    require(openCapture.value != nil,"Open engine retains an active observer capture")
    try source.setTheme(["grid":"#123456"])
    require(counter.calls==1,"Open owner mutation delivers exactly one observer callback")
    try source.close()
    require(openCapture.value==nil,"First close releases the open observer capture")
    try source.close();try source.removeObserver(openToken)
    require(true,"Repeated close and owner unsubscribe remain idempotent")
    let (closedToken,closedCapture,engineClosed)=autoreleasepool{captureClosedSubscription(source)}
    let releasedAfterRegistration=closedCapture.value==nil
    try source.close()
    let releasedAfterRepeatedClose=closedCapture.value==nil
    require(closedToken==nil&&engineClosed,"Closed owner registration throws engineClosed without a token")
    require(releasedAfterRegistration,"Rejected closed registration releases its callback capture")
    require(releasedAfterRepeatedClose,"Retaining and repeatedly closing the closed engine keeps no new capture")
    if let token=closedToken{try source.removeObserver(token)} // Clean the red baseline too.
    require(closedCapture.value==nil,"Owner cleanup after close releases any baseline capture")
    let thread=SubscriptionThreadResult(),finished=DispatchSemaphore(value:0)
    DispatchQueue.global(qos:.userInitiated).async{
        do{_=try source.observeChanges{}}catch AsterError.wrongThread{thread.set(true)}catch{}
        finished.signal()
    }
    guard finished.wait(timeout:.now()+2) == .success else{throw AsterError.javaScript("Wrong-thread subscription probe timed out")}
    require(thread.get(),"Original wrongThread guard precedes the closed-state guard")
    return ["schema":"aster.native.closed-subscriptions","passed":checks.count,"checks":checks,"failures":failures,"failed":!failures.isEmpty,"openCallbacks":counter.calls,"postCloseRegistrationAccepted":closedToken != nil,"rejectionEngineClosed":engineClosed,"captureReleasedAfterRegistration":releasedAfterRegistration,"captureReleasedAfterRepeatedClose":releasedAfterRepeatedClose,"captureReleasedAfterCleanup":closedCapture.value==nil,"boundary":"Public Swift SDK APIs; original owner/main thread; closed engine retained; wrong-thread rejection checked separately"]
}
