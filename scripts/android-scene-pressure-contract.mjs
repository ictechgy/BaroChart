import assert from 'node:assert/strict';
const integer=(value,label,min=0)=>assert.ok(Number.isSafeInteger(value)&&value>=min,label+' integer');
/** Additional transport evidence only. The full ingestion/raw-vector/trace
 * validator remains mandatory; this never substitutes a reduced oracle.
 */
export function validateSceneTransport(report,transport){
 assert.ok(transport==='json'||transport==='f64','Selected transport');assert.equal(report.transport,transport,'Actual selected transport');
 assert.equal(report.renderCacheEnabled,true,'Common fixture cache enabled');
 const before=report.viewRenderTransport?.before,end=report.viewRenderTransport?.endBeforeValidation;
 assert.equal(before?.enabled,true,'Cache enabled before window');assert.equal(end?.enabled,true,'Cache enabled at window end');
 const probe=report.probe,counts=probe?.transportCounts;integer(probe?.drawCount,'Actual draw count',1);
 integer(end.ownedBitmapBytes,'Actual owned bitmap bytes',1);assert.equal(end.frameCacheCreated,true,'Actual JS frame cache exists');
 for(const key of ['cacheHits','baseRebuilds','drawingRebuilds','fallbacks']){integer(before[key],'Before '+key);integer(end[key],'End '+key);assert.ok(end[key]>=before[key],'Monotonic '+key);}
 // Both frozen SDK implementations increment exactly one of these counters
 // per successful cached onDraw. Their delta proves use, not just opt-in.
 assert.equal(end.cacheHits+end.baseRebuilds-before.cacheHits-before.baseRebuilds,probe.drawCount,'Complete actual cached draw coverage');
 for(const position of [before,end]){assert.equal(position.fallbacks,0,'No cache fallback in clean comparison');assert.equal(position.failure,null,'No cache failure');}
 integer(counts?.json,'JSON route');integer(counts?.f64,'F64 route');assert.equal(counts.json+counts.f64,probe.drawCount,'Complete route accounting');
 assert.equal(counts[transport],probe.drawCount,'Pure selected transport');assert.equal(counts[transport==='json'?'f64':'json'],0,'No mixed route');
 assert.ok(Array.isArray(probe.rawInputRows)&&probe.rawInputRows.length>0,'Actual matched input rows');for(const row of probe.rawInputRows)assert.equal(row.transport,transport,'Actual input row transport');
 if(transport==='f64'){
  for(const key of ['packetAttempts','packetFrames','packetFailures','packetReleaseFailures','legacyFrames','packetNumericBytes','packetMetadataChars']){integer(before[key],'Before '+key);integer(end[key],'End '+key);assert.ok(end[key]>=before[key],'Monotonic '+key);}
  assert.equal(end.packetFrames-before.packetFrames,probe.drawCount,'Measured typed packets');
  assert.equal(end.packetAttempts-before.packetAttempts,probe.drawCount,'Measured packet attempts');
  for(const position of [before,end]){assert.equal(position.packetFailures,0,'No packet fallback in clean comparison');assert.equal(position.packetReleaseFailures,0,'No frame-cache release failure');assert.equal(position.legacyFrames,0,'No legacy rendering in typed fixture');assert.equal(position.packetFailure,null,'No packet failure');}
  integer(probe.packetTransferredNumericBytes,'Probe numeric bytes',1);integer(probe.packetMetadataChars,'Probe metadata characters',1);
  assert.equal(end.packetNumericBytes-before.packetNumericBytes,probe.packetTransferredNumericBytes,'Typed copy accounting');assert.equal(end.packetMetadataChars-before.packetMetadataChars,probe.packetMetadataChars,'Typed metadata accounting');
 }
 return report;
}
