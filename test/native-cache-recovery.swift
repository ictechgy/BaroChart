import Foundation
import CoreGraphics
// The runner inserts a one-shot nil at bitmap() entry in a temporary derivative;
// this fixture also injects one partial JavaScript frame failure. This is an
// allocation/cleanup contract test, not an actual OS OOM or physical input.
enum CacheFault {static var armed=false;static var attempts=0}
let arguments=CommandLine.arguments,bundle=URL(fileURLWithPath:arguments[1]),output=URL(fileURLWithPath:arguments[2])
let engine=try AsterEngine(bundleURL:bundle,count:4096)
_ = engine.context.evaluateScript("""
globalThis.__releaseFrameCalls = 0;
const __originalReleaseFrameCache = globalThis.nativeReleaseFrameCache;
globalThis.nativeReleaseFrameCache = function(token) {
  globalThis.__releaseFrameCalls += 1;
  return __originalReleaseFrameCache(token);
};
""")
let budget=AsterNativeCacheBudget(maxBytes:8388608),renderer=AsterFrameRenderer(engine:engine,budget:budget)
func bitmap()->CGContext {let c=CGContext(data:nil,width:400,height:300,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!;c.translateBy(x:0,y:300);c.scaleBy(x:1,y:-1);return c}
var rows:[[String:Any]]=[],checks=0
func render(_ stage:String,_ cached:Bool)throws {let c=bitmap(),ref=bitmap();_=try renderer.render(width:400,height:300,in:c);AsterCoreGraphicsRenderer.render(try engine.scene(width:400,height:300),in:ref);let x=c.data!.assumingMemoryBound(to:UInt8.self),y=ref.data!.assumingMemoryBound(to:UInt8.self);var differences=0;for i in 0..<(c.bytesPerRow*300){if x[i] != y[i]{differences+=1}};guard differences==0,(renderer.cachedBytes>0)==cached else{throw AsterError.javaScript("\(stage): pixels=\(differences) cached=\(renderer.cachedBytes)")};checks+=1;rows.append(["stage":stage,"cachedBytes":renderer.cachedBytes,"budgetBytes":budget.usedBytes,"attempts":CacheFault.attempts,"pixelByteDifferences":differences])}
func releaseCalls()->Int {Int(engine.context.evaluateScript("globalThis.__releaseFrameCalls")?.toInt32() ?? -1)}
budget.setLimit(0)
let uncachedCalls=releaseCalls()
try render("uncached frame one",false)
try render("uncached frame two",false)
try render("uncached frame three",false)
guard releaseCalls()==uncachedCalls else{throw AsterError.javaScript("Unowned uncached frame invoked nativeReleaseFrameCache")};checks+=1
budget.setLimit(8388608)
CacheFault.armed=true
try render("one-shot nil injected",false)
let attempts=CacheFault.attempts
try render("same geometry fallback without retry storm",false)
guard CacheFault.attempts==attempts else{throw AsterError.javaScript("Unrequested retry storm")};checks+=1
budget.setLimit(0);budget.setLimit(8388608)
try render("same geometry budget-generation recovery",true)
_ = engine.context.evaluateScript("""
globalThis.__partialFrameFailure = true;
const __originalRenderFrameJSON = globalThis.nativeRenderFrameJSON;
globalThis.nativeRenderFrameJSON = function(token, width, height, force) {
  const result = __originalRenderFrameJSON(token, width, height, force);
  if (globalThis.__partialFrameFailure) {
    globalThis.__partialFrameFailure = false;
    throw new Error('partial frame failure');
  }
  return result;
};
""")
let partialFailureCalls=releaseCalls()
do {
    _ = try renderer.render(width:400,height:300,in:bitmap())
    throw AsterError.javaScript("Partial frame failure was not raised")
} catch let error as AsterError {
    guard case .javaScript(let message)=error,message.contains("partial frame failure") else{throw error}
}
guard releaseCalls()==partialFailureCalls+1 else{throw AsterError.javaScript("Partial JS frame failure skipped native cache release")};checks+=1
try render("partial JS failure recovery",true)
budget.purge()
guard budget.maxBytes==8388608&&budget.usedBytes==0 else{throw AsterError.javaScript("Memory purge changed configured cache limit")}
try render("memory pressure cooldown",false)
guard budget.usedBytes==0 else{throw AsterError.javaScript("Memory purge immediately re-admitted cache")}
try render("memory pressure recovery",true)
renderer.release();CacheFault.armed=true;try render("second injected nil",false)
renderer.invalidate();try render("explicit invalidate recovery",true)
renderer.release();CacheFault.armed=true;try render("third injected nil",false)
renderer.release();try render("explicit release recovery",true)
try engine.close();guard renderer.cachedBytes==0&&budget.usedBytes==0 else{throw AsterError.javaScript("Close retained bitmap capacity")};checks+=1
let data=try JSONSerialization.data(withJSONObject:["passed":checks,"rows":rows,"scope":"Actual macOS JavaScriptCore/CoreGraphics; one-shot bitmap nil and partial JS frame failure injections. No OS OOM, physical input or display timing."],options:[.prettyPrinted,.sortedKeys]);try data.write(to:output);print("\(checks) recovery checks passed")
