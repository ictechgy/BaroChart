import Foundation
import CoreGraphics
func verifyNativeFrames(_ bundle:URL,_ output:URL)throws {
    var checks:[String]=[]
    func check(_ value:Bool,_ label:String)throws{if !value{throw AsterError.javaScript(label)};checks.append(label)}
    func bitmap(_ w:Int,_ h:Int,_ scale:Double)->CGContext {let c=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!;c.translateBy(x:0,y:Double(h));c.scaleBy(x:scale,y:-scale);return c}
    let engine=try AsterEngine(bundleURL:bundle,count:4096),budget=AsterNativeCacheBudget(maxBytes:33554432),a=AsterFrameRenderer(engine:engine,budget:budget),b=AsterFrameRenderer(engine:engine,budget:budget)
    var width=800,height=500,scale=1.0
    func compare(_ cache:AsterFrameRenderer,_ label:String)throws {
        let w=Int(Double(width)*scale),h=Int(Double(height)*scale),actual=bitmap(w,h,scale),reference=bitmap(w,h,scale)
        _=try cache.render(width:Double(width),height:Double(height),scale:scale,in:actual)
        AsterCoreGraphicsRenderer.render(try engine.scene(width:Double(width),height:Double(height)),in:reference)
        let x=actual.data!.assumingMemoryBound(to:UInt8.self),y=reference.data!.assumingMemoryBound(to:UInt8.self),bytes=actual.bytesPerRow*h
        var diff=0;for i in 0..<bytes {if x[i] != y[i]{diff+=1}}
        try check(diff==0,"Exact native cached/full pixels: "+label)
    }
    try compare(a,"initial");try compare(b,"second view independent token");width=600;height=360;try compare(b,"independent other view geometry");width=800;height=500;try compare(a,"first view geometry retained")
    for i in 0..<8 {_=try engine.call("nativePointer",["move",99,180+i*30,140+i*13]);try compare(a,"hover\(i)");try check(a.metrics["baseRedrawn"]==0,"hover reuses base\(i)")}
    try engine.setTheme(["background":"#f8fafc","text":"#334455"]);try compare(a,"theme");try compare(b,"other view theme");try engine.setTheme(["background":"#00102080"]);try compare(a,"alpha theme");_=try engine.call("nativeView",[200,500]);try compare(a,"alpha pan");try engine.setTheme(["background":"#f8fafc"]);try compare(a,"opaque restoration")
    _=try engine.call("nativeView",[100,400]);try compare(a,"pan")
    _=try engine.call("nativeWheel",[-120,400]);try compare(a,"zoom")
    try engine.addDrawing(["id":"t","type":"text","panel":"price","points":[["time":1700000000000+380*60000,"price":100]],"text":"관찰"]);try compare(a,"drawing")
    try engine.undo();try compare(a,"undo");try engine.redo();try compare(a,"redo")
    try engine.setPanel("price",["scale":"percent","base":100]);try compare(a,"percent")
    try engine.setPanel("price",["scale":"log","inverted":true,"range":[1,1000]]);try compare(a,"log inverted")
    _=try engine.call("nativeDataEvent",[["kind":"correction","bar":["time":1700000000000+4095*60000,"open":100,"high":110,"low":90,"close":105,"volume":8]]]);try compare(a,"stream correction")
    width=700;height=400;scale=2;try compare(a,"DPI+resize");try check(a.cachedBytes==((Int(Double(width)*scale)*4+63)/64)*64*Int(Double(height)*scale)*2,"native capacity reports two bitmaps")
    budget.setLimit(0);try check(a.cachedBytes==0 && b.cachedBytes==0 && budget.usedBytes==0,"pressure releases all cached owners");try compare(a,"pressure fallback")
    budget.setLimit(33554432);try compare(a,"explicit budget recovery")
    do {_=try a.render(width:1e300,height:500,in:bitmap(100,100,1));throw AsterError.javaScript("oversize accepted")}catch AsterError.invalidScene {checks.append("huge finite width rejected before Int conversion")}
    a.release();b.release();try check(budget.usedBytes==0 && a.cachedBytes==0 && b.cachedBytes==0,"retained renderers release bitmap capacity")
    try check(try engine.call("nativeReleaseFrameCaches").toBool(),"native frame cache clear")
    _=try engine.call("nativeInit",[1000,["panels":[["id":"price"]],"series":[]]])
    engine.context.evaluateScript("nativeModel.addSeries({id:'g',type:'line',panel:'price',color:'#ef38b1',values:Float64Array.from({length:1000},(_,i)=>i%3===2?NaN:100+i%10)});nativeModel.fit();")
    width=300;height=400;scale=1;try compare(a,"periodic NaN dense LOD")
    let gapScene=try engine.scene(width:300,height:400),finitePoints=gapScene.commands.filter{$0.color=="#ef38b1"}.reduce(0){$0+($1.points?.count ?? 0)/2+($1.coords?.count ?? 0)/4}
    try check(finitePoints==667,"native JSC preserves all667 finite samples without gaps")
    try compare(a,"before close");try compare(b,"other retained renderer before close");try engine.close();try check(budget.usedBytes==0 && a.cachedBytes==0 && b.cachedBytes==0,"close releases retained renderer capacity");do {_=try a.render(width:300,height:400,in:bitmap(300,400,1));throw AsterError.javaScript("closed frame accepted")}catch AsterAsyncError.engineClosed{try check(budget.usedBytes==0,"closed renderer rejects before allocating")}
    let report:[String:Any]=["passed":checks.count,"checks":checks,"host":"macOS JSC/CoreGraphics; cached versus full RGBA bitmap, DPR1/2; no display FPS","physicalDevice":false]
    try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output);print("Native frame checks: \(checks.count)")
}
