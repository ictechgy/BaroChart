import Foundation
import JavaScriptCore
import CoreGraphics
import CoreText

// Common macOS JSC/JSONDecoder/software CGContext boundary, no native View,
// compositor, physical input, display FPS, PNG encode or file I/O in samples.
func labelProfile(bundle:URL,output:URL,instrumented:Bool) throws {
    func now()->Double {ProcessInfo.processInfo.systemUptime}
    func stats(_ values:[Double])->[String:Any] {let a=values.sorted();return ["samples":a.count,"p50":a[a.count/2],"p95":a[min(a.count-1,Int(Double(a.count)*0.95))],"max":a.last ?? 0]}
    func cleanupCount(_ engine:AsterEngine)->Int {for child in Mirror(reflecting:engine).children where child.label=="frameCleanup" {if let entries=child.value as? [UUID:()->Void] {return entries.count}};return -1}
    let resolved=CTFontCreateWithName("Menlo-Regular" as CFString,12,nil)
    var cases:[[String:Any]]=[]
    for lines in [1,32] {for full in [false,true] {for scale in [1.0,2.0] {
        let engine=try AsterEngine(bundleURL:bundle,count:100000,options:["panels":[["id":"price"]],"series":[["id":"p","type":"candles","panel":"price"]]])
        let clock:@convention(block) ()->Double={ProcessInfo.processInfo.systemUptime};engine.context.setObject(clock,forKeyedSubscript:"__nativeProfileNow" as NSString)
        engine.context.evaluateScript("for(let i=0;i<\(lines);i++)nativeModel.addSeries({id:'l'+i,type:'line',panel:'price',values:Float64Array.from(nativeModel.store.columns.close.subarray(0,100000),v=>v+i*.1)});\(full ? "nativeModel.fit();" : "")")
        if let error=engine.context.exception {engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Fixture setup")}
        let pixelWidth=Int(1200*scale),pixelHeight=Int(700*scale)
        guard let ctx=CGContext(data:nil,width:pixelWidth,height:pixelHeight,bitsPerComponent:8,bytesPerRow:((pixelWidth*4+63)/64)*64,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw AsterError.invalidScene}
        ctx.translateBy(x:0,y:Double(pixelHeight));ctx.scaleBy(x:scale,y:-scale)
        let budget=AsterNativeCacheBudget(maxBytes:134217728),renderer=AsterFrameRenderer(engine:engine,budget:budget)
        var raw:[[String:Double]]=[],lastStats:[String:Int]=[:],descriptionBytes=0,baseRedraws=0,drawingRedraws=0,pixelChecksum:UInt64=0
        for i in 0..<100 {try autoreleasepool {
            let start=now()
            _=try engine.call("nativePointer",["move",99,80+(i*37)%1020,60+(i*29)%580])
            let afterInput=now()
            lastStats=try renderer.render(width:1200,height:700,scale:scale,in:ctx)
            guard ctx.makeImage() != nil else {throw AsterError.invalidScene}
            pixelChecksum &+= UInt64(ctx.data!.assumingMemoryBound(to:UInt8.self)[0])
            let afterRender=now()
            let accessibility=try engine.call("nativeAccessibility",[true])
            let afterAccessibility=now()
            guard let summary=accessibility.toDictionary() as? [String:Any] else {throw AsterError.invalidScene}
            let afterFoundation=now()
            let description=summary["readout"] as? String ?? "\(summary["bars"] ?? 0) bars; close \(summary["close"] ?? "No data"); \(summary["selection"] ?? "No selection")"
            descriptionBytes=description.utf8.count
            let afterDescription=now()
            if i>=20 {
                var row=renderer.metrics
                row["rasterAndImageMs"]=(afterRender-afterInput)*1000-(row["sceneJSONMs"] ?? 0)-(row["decodeMs"] ?? 0)
                row["inputMs"]=(afterInput-start)*1000;row["totalMs"]=(afterRender-start)*1000
                row["accessibilityJSMs"]=(afterAccessibility-afterRender)*1000;row["accessibilityFoundationMs"]=(afterFoundation-afterAccessibility)*1000;row["hostDescriptionMs"]=(afterDescription-afterFoundation)*1000
                row["accessibilityTotalMs"]=(afterDescription-afterRender)*1000;row["totalWithAccessibilityMs"]=(afterDescription-start)*1000;row["descriptionUtf8Bytes"]=Double(descriptionBytes)
                if instrumented {guard let phases=try engine.call("__nativeProfilePhases").toDictionary() as? [String:Any] else {throw AsterError.invalidScene};for key in ["coreFrameMs","jsonSerializeMs","coreCalls","jsonCalls"] {row[key]=(phases[key] as? NSNumber)?.doubleValue ?? 0};row["sceneCallResidualMs"]=(row["sceneJSONMs"] ?? 0)-(row["coreFrameMs"] ?? 0)-(row["jsonSerializeMs"] ?? 0)}
                raw.append(row);baseRedraws+=Int(row["baseRedrawn"] ?? 0);drawingRedraws+=Int(row["drawingRedrawn"] ?? 0)
            }
        }}
        guard let digest=try engine.call("__nativeProfileDigest").toDictionary() as? [String:Any] else {throw AsterError.invalidScene}
        let ownedBeforeClose=renderer.cachedBytes,budgetBeforeClose=budget.usedBytes,handlesBeforeClose=try engine.call("__nativeProfileFrameHandles").toInt32()
        let engineCleanupBeforeClose=cleanupCount(engine)
        try engine.close()
        let engineCleanupAfterClose=cleanupCount(engine)
        let handlesAfterClose=engine.context.objectForKeyedSubscript("__nativeProfileFrameHandles")!.call(withArguments:[])!.toInt32()
        var closedRejected=false
        do {_=try renderer.render(width:1200,height:700,scale:scale,in:ctx)}catch AsterAsyncError.engineClosed {closedRejected=true}
        guard renderer.cachedBytes==0,budget.usedBytes==0,handlesAfterClose==0,engineCleanupAfterClose==0,closedRejected else {throw AsterError.javaScript("Close cache capacity/handle regression")}
        renderer.release()
        let keys=Array(Set(raw.flatMap{$0.keys})).sorted()
        cases.append(["lines":lines,"range":full ? "full100k":"recent200","dpr":scale,"raw":raw,"summary":Dictionary(uniqueKeysWithValues:keys.map{key in (key,stats(raw.compactMap{$0[key]}))}),"stats":lastStats,"fixtureProof":digest,"measuredBaseRedraws":baseRedraws,"measuredDrawingRedraws":drawingRedraws,"destinationBitmapBytes":ctx.bytesPerRow*pixelHeight,"cachedOwnedBytesBeforeClose":ownedBeforeClose,"budgetOwnedBytesBeforeClose":budgetBeforeClose,"frameEntriesBeforeClose":handlesBeforeClose,"cachedOwnedBytesAfterClose":renderer.cachedBytes,"budgetOwnedBytesAfterClose":budget.usedBytes,"frameEntriesAfterClose":handlesAfterClose,"engineFrameCleanupHandlesBeforeClose":engineCleanupBeforeClose,"engineFrameCleanupHandlesAfterClose":engineCleanupAfterClose,"closedRendererRejected":closedRejected,"completionPixelChecksum":pixelChecksum,"descriptionUtf8Bytes":descriptionBytes])
        print("prepared sample case lines=\(lines) range=\(full ? "full100k":"recent200") DPR=\(scale)")
    }}}
    let report:[String:Any]=["schema":"aster.cycle10.native-label-hover","platform":ProcessInfo.processInfo.operatingSystemVersionString,"host":"macOS JavaScriptCore + JSONDecoder + software CGBitmapContext","ownerMainThread":Thread.isMainThread,"bundle":bundle.path,"width":1200,"height":700,"storedBars":100000,"seed":42,"warmup":20,"samples":80,"cached":true,"instrumented":instrumented,"resolvedFont":["css":"12px monospace","postScriptName":CTFontCopyPostScriptName(resolved) as String,"ascent":CTFontGetAscent(resolved),"descent":CTFontGetDescent(resolved)],"cases":cases,"scope":"Injected nativePointer; offscreen software raster + makeImage/1-byte completion, no native View/compositor/physical device FPS. Source/VM/columns/range-index first preparation, disk/PNG, untimed digest/diagnostic collection excluded. sceneJSONMs is clean aggregate JSC core+JSON+host string conversion. Optional coreFrame/jsonSerialize are instrumented estimates including Swift clock crossings, not pure uninstrumented core cost. Owned bitmap/entry counters do not assert RSS/GPU/long-term leak freedom."]
    try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output)
    print(output.path)
}
