import Foundation
import CoreGraphics

private struct BaroChartFrame: Decodable {
    let width,height:Double
    let background:String
    let base,drawings:BaroChartScene?
    let hover:BaroChartScene
    let stats:[String:Int]
}
/// Explicit aggregate capacity for two native bitmap contexts per renderer.
/// CGImage COW/allocator/display backing and process peaks are not included.
public final class BaroChartNativeCacheBudget {
    /// Process-wide budget shared by renderers that do not receive their own; 134,217,728 bytes (128 MiB).
    public static let shared=BaroChartNativeCacheBudget(maxBytes:134217728)
    /// Current limit in bytes.
    public private(set) var maxBytes:Int
    /// Bytes currently reserved by renderers.
    public private(set) var usedBytes=0
    fileprivate var generation:UInt64=0
    private var entries:[UUID:(bytes:Int,trim:()->Void)]=[:]
    /// Creates a budget with a limit in bytes. `maxBytes` must not be negative.
    public init(maxBytes:Int){precondition(maxBytes>=0);self.maxBytes=maxBytes}
    /// Changes the limit in bytes and releases renderer caches until usage fits. Main thread only; `bytes` must not be negative.
    public func setLimit(_ bytes:Int){precondition(Thread.isMainThread && bytes>=0);maxBytes=bytes;generation &+= 1;for key in Array(entries.keys){if usedBytes<=bytes{break};if let entry=entries.removeValue(forKey:key){usedBytes-=entry.bytes;entry.trim()}}}
    fileprivate func reserve(_ key:UUID,_ bytes:Int,_ trim:@escaping()->Void)->Bool{let old=entries[key]?.bytes ?? 0;if usedBytes-old+bytes>maxBytes{return false};entries[key]=(bytes,trim);usedBytes+=bytes-old;return true}
    fileprivate func release(_ key:UUID){if let old=entries.removeValue(forKey:key){usedBytes-=old.bytes}}
}
/// Opt-in native frame cache; owner-thread only. Public engine.scene remains full.
public final class BaroChartFrameRenderer {
    private weak var engine:BaroChartEngine?
    private let token=UUID(),budget:BaroChartNativeCacheBudget
    private var cleanupToken:UUID?
    private var base,stable:CGContext?
    private var stableImage:CGImage?
    private var width=0,height=0,ratio=0.0
    private var force=true,failedGeometry:String?
    /// Bytes of bitmap cache this renderer currently holds; 0 when caching is unavailable or released.
    public private(set) var cachedBytes=0
    /// Timings in milliseconds and cache sizes of the most recent ``render(width:height:scale:in:)``. The keys depend on whether the cached path was used.
    public private(set) var metrics:[String:Double]=[:]
    /// Creates a renderer for `engine`. Main thread only. `budget` limits cache memory and defaults to ``BaroChartNativeCacheBudget/shared``.
    public init(engine:BaroChartEngine,budget:BaroChartNativeCacheBudget = .shared){precondition(Thread.isMainThread);self.engine=engine;self.budget=budget;cleanupToken=try? engine.registerFrameCleanup{[weak self] in self?.release()}}
    /// Frees the cached bitmaps and the core's cached frame state. The next render rebuilds them.
    public func release(){release(resetFailure:true)}
    private func release(resetFailure:Bool){if resetFailure{failedGeometry=nil};base=nil;stable=nil;stableImage=nil;cachedBytes=0;width=0;height=0;force=true;budget.release(token);if let engine=engine{_ = try? engine.call("nativeReleaseFrameCache",[token.uuidString])}}
    deinit{if Thread.isMainThread {release();if let token=cleanupToken{engine?.removeFrameCleanup(token)}}else{let token=token,budget=budget,engine=engine,cleanupToken=cleanupToken;DispatchQueue.main.async {budget.release(token);if let id=cleanupToken{engine?.removeFrameCleanup(id)};_ = try? engine?.call("nativeReleaseFrameCache",[token.uuidString])}}}
    /// Marks the cache stale so the next render redraws every layer.
    public func invalidate(){force=true;failedGeometry=nil}
    private func bitmap(_ w:Int,_ h:Int,_ scale:Double)->CGContext?{guard let c=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:((w*4+63)/64)*64,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{return nil};c.translateBy(x:0,y:Double(h));c.scaleBy(x:scale,y:-scale);return c}
    private func copy(_ image:CGImage,in context:CGContext,width:Double,height:Double){context.saveGState();context.setBlendMode(.copy);context.translateBy(x:0,y:height);context.scaleBy(x:1,y:-1);context.draw(image,in:CGRect(x:0,y:0,width:width,height:height));context.restoreGState()}
    /// Renders the chart into `context`, reusing cached layers when possible, and returns the core frame statistics. Main thread only.
    ///
    /// - Parameters:
    ///   - cssWidth: Width in logical pixels; at least 100.
    ///   - cssHeight: Height in logical pixels; at least 80.
    ///   - scale: Pixel scale factor, greater than 0 and at most 8.
    ///   - context: Destination with a top-left origin and downward-positive Y.
    /// - Throws: ``BaroChartLowLevelError`` for invalid or oversized geometry. If the cache cannot be used, the frame is drawn without it.
    @discardableResult public func render(width cssWidth:Double,height cssHeight:Double,scale:Double=1,in context:CGContext)throws->[String:Int]{
        precondition(Thread.isMainThread)
        guard let engine=engine,cssWidth.isFinite,cssHeight.isFinite,scale.isFinite,cssWidth>=100,cssHeight>=80,scale>0,scale<=8 else{throw BaroChartLowLevelError.invalidScene}
        guard cssWidth*scale<=16384,cssHeight*scale<=16384 else{throw BaroChartLowLevelError.invalidScene}
        try engine.checkFrameOwner()
        let w=Int((cssWidth*scale).rounded()),h=Int((cssHeight*scale).rounded());guard w<=16384,h<=16384,w*h<=16777216 else{throw BaroChartLowLevelError.invalidScene}
        let key="\(w)/\(h)/\(scale)/\(budget.maxBytes)/\(budget.generation)",bytes=((w*4+63)/64)*64*h*2
        var available=abs(cssWidth*scale-Double(w))<1e-9 && abs(cssHeight*scale-Double(h))<1e-9 && bytes<=33554432 && failedGeometry != key && engine.context.objectForKeyedSubscript("nativeRenderFrameJSON")?.isUndefined==false
        if width != w || height != h || ratio != scale {release(resetFailure:false);ratio=scale}
        if available {available=budget.reserve(token,bytes,{[weak self] in self?.release()})}
        if available && base==nil {base=bitmap(w,h,scale);stable=bitmap(w,h,scale);if base==nil || stable==nil {failedGeometry=key;release(resetFailure:false);available=false}else{width=w;height=h;cachedBytes=bytes;force=true}}
        if !available {release(resetFailure:false);let start=ProcessInfo.processInfo.systemUptime,scene=try engine.scene(width:cssWidth,height:cssHeight),after=ProcessInfo.processInfo.systemUptime;BaroChartCoreGraphicsRenderer.render(scene,in:context);metrics=["sceneAndDecodeMs":(after-start)*1000,"rasterMs":(ProcessInfo.processInfo.systemUptime-after)*1000,"cachedBytes":0];return scene.stats}
        let start=ProcessInfo.processInfo.systemUptime
        let text=try engine.call("nativeRenderFrameJSON",[token.uuidString,cssWidth,cssHeight,force]).toString()!
        let afterJS=ProcessInfo.processInfo.systemUptime,frame=try JSONDecoder().decode(BaroChartFrame.self,from:Data(text.utf8)),afterDecode=ProcessInfo.processInfo.systemUptime
        if let scene=frame.base {BaroChartCoreGraphicsRenderer.render(scene,in:base!)}
        if let drawings=frame.drawings {guard let image=base!.makeImage() else{release();throw BaroChartLowLevelError.invalidScene};copy(image,in:stable!,width:cssWidth,height:cssHeight);BaroChartCoreGraphicsRenderer.render(drawings,in:stable!,clear:false);stableImage=stable!.makeImage()}
        guard let image=stableImage else{release();throw BaroChartLowLevelError.invalidScene}
        copy(image,in:context,width:cssWidth,height:cssHeight);BaroChartCoreGraphicsRenderer.render(frame.hover,in:context,clear:false);force=false
        metrics=["sceneJSONMs":(afterJS-start)*1000,"decodeMs":(afterDecode-afterJS)*1000,"rasterMs":(ProcessInfo.processInfo.systemUptime-afterDecode)*1000,"cachedBytes":Double(cachedBytes),"baseRedrawn":frame.base==nil ? 0:1,"drawingRedrawn":frame.drawings==nil ? 0:1,"jsonUtf8Bytes":Double(text.utf8.count)]
        return frame.stats
    }
}
