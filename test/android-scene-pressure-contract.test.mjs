import test from 'node:test';import assert from 'node:assert/strict';
import {validateSceneTransport} from '../scripts/android-scene-pressure-contract.mjs';
function fixture(transport='f64'){
 const before={enabled:true,ownedBitmapBytes:4096,frameCacheCreated:true,cacheHits:1,baseRebuilds:1,drawingRebuilds:1,fallbacks:0,failure:null,packetAttempts:2,packetFrames:2,packetFailures:0,packetReleaseFailures:0,legacyFrames:0,packetFailure:null,packetNumericBytes:200,packetMetadataChars:50};
 const endBeforeValidation={enabled:true,ownedBitmapBytes:4096,frameCacheCreated:true,cacheHits:2,baseRebuilds:3,drawingRebuilds:1,fallbacks:0,failure:null,packetAttempts:5,packetFrames:5,packetFailures:0,packetReleaseFailures:0,legacyFrames:0,packetFailure:null,packetNumericBytes:500,packetMetadataChars:200};
 return {transport,renderCacheEnabled:true,viewRenderTransport:{before,endBeforeValidation},probe:{drawCount:3,rawInputRows:[{transport}],transportCounts:{json:transport==='json'?3:0,f64:transport==='f64'?3:0},packetTransferredNumericBytes:300,packetMetadataChars:150}};
}
test('typed window has actual packets with no hidden fallback and exact transfer accounting',()=>{const r=fixture();assert.equal(validateSceneTransport(r,'f64'),r);});
test('legacy window proves JSON on the same enabled cache route',()=>{const r=fixture('json');delete r.viewRenderTransport.before.packetFrames;delete r.viewRenderTransport.endBeforeValidation.packetFrames;assert.equal(validateSceneTransport(r,'json'),r);});
test('typed fallback cannot qualify as a clean transport comparison',()=>{const r=fixture();r.viewRenderTransport.endBeforeValidation.packetFailures=1;assert.throws(()=>validateSceneTransport(r,'f64'),/fallback/);});
test('mixed route, empty draw and missing metrics fail closed',()=>{
 for(const change of [r=>{r.probe.transportCounts.json=1;},r=>{r.probe.drawCount=0;},r=>{delete r.viewRenderTransport;},r=>{delete r.probe.transportCounts;},r=>{delete r.viewRenderTransport.endBeforeValidation.packetFrames;}]){const r=fixture();change(r);assert.throws(()=>validateSceneTransport(r,'f64'));}
});
test('cache, transport and numeric transfer differences cannot be silently accepted',()=>{
 for(const change of [r=>{r.renderCacheEnabled=false;},r=>{r.viewRenderTransport.before.enabled=false;},r=>{r.transport='json';},r=>{r.probe.packetTransferredNumericBytes++;},r=>{r.probe.packetMetadataChars++;}]){const r=fixture();change(r);assert.throws(()=>validateSceneTransport(r,'f64'));}
});
test('fractional/negative/nonfinite route counters and unknown mode fail',()=>{
 for(const value of [-1,.5,NaN,Infinity]){const r=fixture();r.probe.transportCounts.f64=value;assert.throws(()=>validateSceneTransport(r,'f64'));}
 assert.throws(()=>validateSceneTransport(fixture(),'binary'));
});
test('enabled flag alone does not prove actual retained bitmap use',()=>{const r=fixture();r.viewRenderTransport.endBeforeValidation.ownedBitmapBytes=0;assert.throws(()=>validateSceneTransport(r,'f64'),/bitmap/);});
test('actual JS frame cache must exist at the measured endpoint',()=>{const r=fixture();r.viewRenderTransport.endBeforeValidation.frameCacheCreated=false;assert.throws(()=>validateSceneTransport(r,'f64'),/frame cache/);});
test('cache hit plus base rebuild delta must cover every measured draw',()=>{const r=fixture();r.viewRenderTransport.endBeforeValidation.cacheHits--;assert.throws(()=>validateSceneTransport(r,'f64'),/cached draw/);});
test('cache fallback makes a sample nonqualifying for a clean cached comparison',()=>{const r=fixture('json');r.viewRenderTransport.endBeforeValidation.fallbacks=1;assert.throws(()=>validateSceneTransport(r,'json'),/cache fallback/);});
test('prior or current typed fallback/release/legacy use is explicitly refused',()=>{
 for(const key of ['packetFailures','packetReleaseFailures','legacyFrames'])for(const position of ['before','endBeforeValidation']){const r=fixture();r.viewRenderTransport[position][key]=1;assert.throws(()=>validateSceneTransport(r,'f64'));}
});
test('prior cache fallback and present error text cannot qualify',()=>{
 for(const change of [r=>{r.viewRenderTransport.before.fallbacks=1;r.viewRenderTransport.endBeforeValidation.fallbacks=1;},r=>{r.viewRenderTransport.endBeforeValidation.failure='cache error';},r=>{r.viewRenderTransport.before.packetFailure='codec error';}]){const r=fixture();change(r);assert.throws(()=>validateSceneTransport(r,'f64'));}
});
test('attempts and matched input row transport must match actual pure route',()=>{
 for(const change of [r=>{r.viewRenderTransport.endBeforeValidation.packetAttempts++;},r=>{delete r.viewRenderTransport.before.packetAttempts;},r=>{r.probe.rawInputRows[0].transport='json';}]){const r=fixture();change(r);assert.throws(()=>validateSceneTransport(r,'f64'));}
});
test('numeric and metadata transfer must actually occur, and drawing cache count is monotonic',()=>{
 for(const change of [r=>{r.viewRenderTransport.endBeforeValidation.packetNumericBytes=200;r.probe.packetTransferredNumericBytes=0;},r=>{r.viewRenderTransport.endBeforeValidation.packetMetadataChars=50;r.probe.packetMetadataChars=0;},r=>{r.viewRenderTransport.endBeforeValidation.drawingRebuilds=0;}]){const r=fixture();change(r);assert.throws(()=>validateSceneTransport(r,'f64'));}
});
