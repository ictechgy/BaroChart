import UIKit
import CoreText

private func glyphDataSnapshot(_ engine:AsterEngine)throws->String {
    _=try engine.call("nativeThemeFont") // owner/closed guard before fixed test probe
    let source="(()=>{if(nativeModel.store.length>512)throw new RangeError('Glyph fixture bars');return JSON.stringify(Array.from({length:nativeModel.store.length},(_,i)=>nativeModel.store.at(i)));})()"
    guard let value=engine.context.evaluateScript(source)?.toString() else{throw AsterError.invalidScene}
    if let error=engine.context.exception{engine.context.exception=nil;throw AsterError.javaScript(error.toString() ?? "Glyph data probe")};return value
}

/// Real CoreText advances and glyph ink bounds for the fonts in this fixture.
/// This validates portable label bounds; it does not certify all installed fonts.
func verifyUIKitGlyphMatrix(_ engine:AsterEngine,documents:URL)throws->[String:Any] {
    let before=try engine.command("inspect").toDictionary()!,anchors=try engine.saveDrawings(),beforeData=try glyphDataSnapshot(engine),originalFont=(before["theme"] as! [String:Any])["font"] as! String
    _=try engine.command("addAxis",[["id":"matrix-b","panel":"price","side":"left","label":"比較価格 B","padding":0]])
    let values=(0..<240).map{Double(2000+$0*7)}
    _=try engine.command("addSeries",[["id":"matrix-values","panel":"price","axisId":"matrix-b","type":"line","label":"Aligned comparison B","values":values]])
    try engine.setPanel("price",["label":"Primary OHLCV · 金融価格 / Long readable title"])
    try engine.setPanel("volume",["label":"Volume · 交易量"])
    try engine.setSeries("a",["label":"PRIMARY A OHLCV"])
    _=try engine.addIndicator("matrix-rsi","rsi",["period":14]);try engine.addSeries(["id":"matrix-rsi-series","type":"line","panel":"price","indicator":"matrix-rsi","label":"RSI(14) · Momentum"])
    defer{try? engine.removeSeries("matrix-values");try? engine.removeAxis("matrix-b");try? engine.removeIndicator("matrix-rsi");try? engine.setTheme(["font":originalFont])}
    let sizes:[(Double,Double)]=[(402,700),(320,568),(844,390),(768,1024)],fonts=["12px monospace","24px monospace","36px monospace","bold 36px sans-serif"]
    var rows:[[String:Any]]=[],total=0,violations:[String]=[]
    for (width,height) in sizes {for css in fonts {
        try engine.setTheme(["font":css]);let scene=try engine.scene(width:width,height:height)
        let fontSize=Double(css.split(separator:" ").first{$0.hasSuffix("px")}!.dropLast(2))!,family=css.contains("sans-serif") ? "Helvetica" : "Menlo-Regular",base=CTFontCreateWithName(family as CFString,fontSize,nil)
        let font=css.contains("bold") ? CTFontCreateCopyWithSymbolicTraits(base,fontSize,nil,.traitBold,.traitBold) ?? base : base
        var labels:[[String:Any]]=[],glyphs:[(String,CGRect)]=[]
        for (index,command) in scene.commands.enumerated() {guard let role=command.role,let text=command.text,let bounds=command.labelBounds,let x=command.x,let y=command.y else{continue}
            let attributed=NSAttributedString(string:text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font]),line=CTLineCreateWithAttributedString(attributed)
            var ascent:CGFloat=0,descent:CGFloat=0,leading:CGFloat=0;let advance=CTLineGetTypographicBounds(line,&ascent,&descent,&leading),ink=CTLineGetImageBounds(line,nil)
            let glyph=CGRect(x:x+ink.minX,y:y-ink.maxY,width:ink.width,height:ink.height),logical=CGRect(x:bounds[0],y:bounds[1],width:bounds[2],height:bounds[3])
            let c=command.clip ?? [0,0,width,height],clip=CGRect(x:c[0],y:c[1],width:c[2],height:c[3]),tag="\(width)x\(height)/\(css)/\(role)#\(index)"
            if !logical.insetBy(dx:-1,dy:-1).contains(glyph){violations.append(tag+" glyph outside semantic bounds")}
            if !clip.insetBy(dx:-1,dy:-1).contains(glyph){violations.append(tag+" glyph clipped by assigned area")}
            if !CGRect(x:0,y:0,width:width,height:height).insetBy(dx:-1,dy:-1).contains(glyph){violations.append(tag+" glyph outside image")}
            for(other,rect) in glyphs {if glyph.intersection(rect).width>1&&glyph.intersection(rect).height>1{violations.append(tag+" glyph overlaps "+other)}}
            glyphs.append((tag,glyph));total+=1
            let resolved=(CTLineGetGlyphRuns(line) as! [CTRun]).map{run in CTFontCopyPostScriptName((CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont) as String}
            labels.append(["role":role,"text":text,"fullText":command.fullText ?? "","requestedFont":css,"resolvedFonts":resolved,"advance":advance,"ascent":ascent,"descent":descent,"glyphRect":[glyph.minX,glyph.minY,glyph.width,glyph.height],"labelBounds":bounds,"clip":c])
        }
        if !labels.contains(where:{$0["role"] as? String=="time-tick"}) || !labels.contains(where:{$0["role"] as? String=="panel-title"}) || !labels.contains(where:{$0["role"] as? String=="price-tick"}){violations.append("\(width)x\(height)/\(css) missing label roles")}
        let format=UIGraphicsImageRendererFormat();format.scale=1
        let image=UIGraphicsImageRenderer(size:CGSize(width:width,height:height),format:format).image{ctx in AsterCoreGraphicsRenderer.render(scene,in:ctx.cgContext)}
        let name="glyph-\(Int(width))-\(Int(height))-\(Int(fontSize))-\(css.contains("bold") ? "sans" : "mono").png";try image.pngData()!.write(to:documents.appendingPathComponent(name))
        rows.append(["width":width,"height":height,"font":css,"labels":labels,"png":name,"boundary":"CoreText glyph bounds + renderer scene to offscreen CoreGraphics PNG, DPR1"])
    }}
    let after=try engine.command("inspect").toDictionary()!,sameLast=NSDictionary(dictionary:before["lastBar"] as! [String:Any]).isEqual(to:after["lastBar"] as! [AnyHashable:Any]),afterAnchors=try engine.saveDrawings(),afterData=try glyphDataSnapshot(engine)
    let unchanged=sameLast&&(before["storedBars"] as! Int)==(after["storedBars"] as! Int)&&afterAnchors==anchors&&beforeData==afterData
    guard violations.isEmpty,unchanged,total>0 else{throw AsterError.javaScript("UIKit glyph matrix: \(violations.prefix(6)); raw data/anchors unchanged=\(unchanged)")}
    return ["cases":rows.count,"glyphLabels":total,"violations":violations,"rows":rows,"rawDataAndAnchorsUnchanged":unchanged,"rawBarsCompared":before["storedBars"]!,"dataSnapshotUtf8Bytes":beforeData.utf8.count,"fontsScope":"Menlo-Regular 12/24/36 and bold Helvetica36 with actual CoreText fallback runs; no all-font guarantee"]
}
