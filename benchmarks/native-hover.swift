import Foundation
import JavaScriptCore
import CoreGraphics

// Actual JSC + JSONDecoder + CoreGraphics submission. Injected nativePointer
// calls; not physical native input, compositor presentation or display FPS.
func profileNativeHover(bundle: URL, output: URL, cached: Bool = false) throws {
    var rows: [[String:Any]] = []
    func stats(_ values:[Double])->[String:Any] {let a=values.sorted();return ["samples":a.count,"p50":a[a.count/2],"p95":a[min(a.count-1,Int(Double(a.count)*0.95))],"max":a.last ?? 0]}
    for lines in [1,32] { for full in [false,true] {
        let engine=try AsterEngine(bundleURL:bundle,count:100000,options:["panels":[["id":"price"]],"series":[["id":"p","type":"candles","panel":"price"]]])
        engine.context.evaluateScript("for(let i=0;i<\(lines);i++)nativeModel.addSeries({id:'l'+i,type:'line',panel:'price',values:Float64Array.from(nativeModel.store.columns.close.subarray(0,100000),v=>v+i*.1)});\(full ? "nativeModel.fit();" : "")")
        if let error=engine.context.exception {throw AsterError.javaScript(error.toString())}
        guard let ctx=CGContext(data:nil,width:1200,height:700,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw AsterError.invalidScene}
        ctx.translateBy(x:0,y:700);ctx.scaleBy(x:1,y:-1)
        var raw:[[String:Double]]=[],lastStats:[String:Int]=[:]
        #if ASTER_FRAME_CACHE
        let frameRenderer=AsterFrameRenderer(engine:engine)
        #endif
        for i in 0..<100 {try autoreleasepool {
            let start=ProcessInfo.processInfo.systemUptime
            _=try engine.call("nativePointer",["move",99,80+(i*37)%1020,60+(i*29)%580])
            let afterInput=ProcessInfo.processInfo.systemUptime
            #if ASTER_FRAME_CACHE
            if cached {
                lastStats=try frameRenderer.render(width:1200,height:700,in:ctx);_=ctx.makeImage()
                let end=ProcessInfo.processInfo.systemUptime
                if i>=20 {var row=frameRenderer.metrics;row["rasterAndImageMs"]=(end-afterInput)*1000-(row["sceneJSONMs"] ?? 0)-(row["decodeMs"] ?? 0);row["inputMs"]=(afterInput-start)*1000;row["totalMs"]=(end-start)*1000;raw.append(row)}
            } else {
                        let text=try engine.call("nativeSceneJSON",[1200,700]).toString()!
            let afterJS=ProcessInfo.processInfo.systemUptime
            let scene=try JSONDecoder().decode(AsterScene.self,from:Data(text.utf8))
            let afterDecode=ProcessInfo.processInfo.systemUptime
            AsterCoreGraphicsRenderer.render(scene,in:ctx);_=ctx.makeImage()
            let end=ProcessInfo.processInfo.systemUptime
            if i>=20 {raw.append(["inputMs":(afterInput-start)*1000,"sceneJSONMs":(afterJS-afterInput)*1000,"decodeMs":(afterDecode-afterJS)*1000,"rasterAndImageMs":(end-afterDecode)*1000,"totalMs":(end-start)*1000,"jsonUtf8Bytes":Double(text.utf8.count)])}
            lastStats=scene.stats
            }
            #else
                        let text=try engine.call("nativeSceneJSON",[1200,700]).toString()!
            let afterJS=ProcessInfo.processInfo.systemUptime
            let scene=try JSONDecoder().decode(AsterScene.self,from:Data(text.utf8))
            let afterDecode=ProcessInfo.processInfo.systemUptime
            AsterCoreGraphicsRenderer.render(scene,in:ctx);_=ctx.makeImage()
            let end=ProcessInfo.processInfo.systemUptime
            if i>=20 {raw.append(["inputMs":(afterInput-start)*1000,"sceneJSONMs":(afterJS-afterInput)*1000,"decodeMs":(afterDecode-afterJS)*1000,"rasterAndImageMs":(end-afterDecode)*1000,"totalMs":(end-start)*1000,"jsonUtf8Bytes":Double(text.utf8.count)])}
            lastStats=scene.stats
            #endif
        }}
        rows.append(["lines":lines,"range":full ? "full100k":"recent200","raw":raw,"summary":Dictionary(uniqueKeysWithValues:["inputMs","sceneJSONMs","decodeMs","rasterAndImageMs","totalMs","jsonUtf8Bytes"].map {key in (key,stats(raw.map{$0[key] ?? 0}))}),"stats":lastStats,"bitmapBytes":1200*700*4])
        #if ASTER_FRAME_CACHE
        frameRenderer.release()
        #endif
        try engine.close()
    }}
    let report:[String:Any]=["platform":ProcessInfo.processInfo.operatingSystemVersionString,"bundle":bundle.path,"width":1200,"height":700,"dpr":1,"storedBars":100000,"seed":42,"warmup":20,"samples":80,"cached":cached,"cases":rows,"scope":"Actual macOS JSC+JSONDecoder+CoreGraphics offscreen; injected nativePointer API, not physical input or UI display time. Reused bitmap; every measured frame makes an image. No RSS/VRAM/leak assertion."]
    try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output)
    print(output.path)
}
