// Completed WEB fixture evidence only. This is an integrity/coverage gate, not
// authentication of an arbitrary report or certification of physical display FPS.
import {createHash,randomUUID} from 'node:crypto';
const FIELDS=['time','open','high','low','close','volume'];
const SYMBOLS=['SYNTH:A','SYNTH:B'];
// Seed42/43 bar32 literals: drawing history retains the original time/price,
// even when later market corrections or the visible range change.
const ANCHOR_PRICES=[101.33638569804957,97.4927910999313];
const OUTPUTS={ema:['value'],rsi:['value'],vwap:['value','upper','lower','deviation','volume'],module:['signed','cumulative']};
const SOURCE_PATHS=['src/index.mjs','src/core/data.mjs','src/core/model.mjs','src/core/indicators.mjs','src/core/ingestion.mjs','src/renderers/canvas.mjs','src/web/worker.mjs','src/web/worker-state.mjs','src/web/compute-worker.mjs','package.json','native/Resources/aster-core.js'];
const HARNESS_PATHS=['../benchmarks/ingestion.mjs','../benchmarks/browser-ingestion.mjs','../benchmarks/browser-soak.mjs','../scripts/cdp.mjs','./cycle12-ingestion-browser.mjs'];
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw new TypeError(message);};
const need=(condition,message)=>{if(!condition)fail(message);};
const own=(object,key)=>Object.hasOwn(object,key);
const finite=(value,min=0)=>typeof value==='number'&&Number.isFinite(value)&&value>=min;
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function record(value,label){need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,label+' record');return value;}
function array(value,label,length){need(Array.isArray(value)&&(length===undefined||value.length===length),label+' array/count');return value;}
function exactKeys(object,keys,label){record(object,label);need(Object.keys(object).length===keys.length&&keys.every(k=>own(object,k)),label+' keys');}
function number(value,label,min=0){need(finite(value,min),label+' finite number');return value;}
function count(value,label,min=0,max=Number.MAX_SAFE_INTEGER){need(integer(value,min,max),label+' integer');return value;}
function digest(value,label){array(value,label,2).forEach(x=>count(x,label,0,0xffffffff));}
function same(a,b,label){need(JSON.stringify(a)===JSON.stringify(b),label+' mismatch');}
function jsonNumbers(value){
 const pending=[{item:value,exit:false}],seen=new Set(),ancestors=new Set();let nodes=0;
 while(pending.length){const {item,exit}=pending.pop();need(++nodes<=5000000,'Evidence resource bound');
  if(exit){ancestors.delete(item);seen.add(item);continue;}
  if(typeof item==='number')need(Number.isFinite(item),'Nonfinite evidence number');
  else if(item&&typeof item==='object'){
   need(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype,'Evidence plain JSON');
   need(!ancestors.has(item),'Cyclic evidence');if(seen.has(item))continue;ancestors.add(item);pending.push({item,exit:true});
   const descriptors=Object.getOwnPropertyDescriptors(item);
   if(Array.isArray(item)){const keys=Object.keys(item);need(keys.length===item.length&&keys.every((key,i)=>key===String(i)),'Dense evidence array');}
   for(const key of Object.keys(item)){need(own(descriptors[key],'value'),'Evidence accessor');pending.push({item:descriptors[key].value,exit:false});}
  }else need(item===null||['string','boolean'].includes(typeof item),'Evidence JSON value');
 }
}

function fixtureContract(conditions){return {seed:42,symbols:SYMBOLS,fields:FIELDS,outputs:OUTPUTS,bars:conditions.bars,lineSeries:conditions.lineSeries,timezone:'America/New_York',emaPeriod:20,rsiPeriod:14,module:'aster.volume-direction@1/pressure',moduleShift:-2};}
export function browserIngestionExecution(report,runId=randomUUID()){
 return {schema:'aster.browser-ingestion-execution',version:1,runId,timestamp:report.timestamp,sourceSHA256:report.source.sha256,harnessSHA256:sha(report.harness),conditionsSHA256:sha(report.conditions),fixtureSHA256:sha(fixtureContract(report.conditions))};
}
function traceSections(report){const f=report.final;return {proof:f.proof,queues:f.queues,drawingChecks:f.drawingChecks,packetSamples:f.packetSamples,inputSamples:f.inputSamples,renderSamples:f.renderSamples,heartbeat:f.heartbeat,epochs:f.epochs,transitions:f.transitions,cleanup:f.cleanup,cleanupModels:f.cleanup.models,cleanupCharts:f.cleanup.charts,cleanupRings:f.cleanup.queueRingKnownBytes,...(own(report,'execution')?{runnerCleanup:report.runnerCleanup}: {})};}
function tagRows(value,runId){
 if(Array.isArray(value)){for(const row of value)tagRows(row,runId);}
 else if(value&&typeof value==='object'){
  if(own(value,'runId'))need(value.runId===runId,'Captured row belongs to another run');
  else value.runId=runId;
 }
}
export function sealBrowserIngestionEvidence(report){
 same(report.final.execution,report.execution,'Captured execution');
 const traces=traceSections(report);
 for(const rows of Object.values(traces))tagRows(rows,report.execution.runId);
 report.evidenceSeal={runId:report.execution.runId,traces:Object.fromEntries(Object.entries(traces).map(([name,rows])=>[name,{count:Array.isArray(rows)?rows.reduce((n,row)=>n+(Array.isArray(row)?row.length:1),0):1,sha256:sha(rows)}]))};
 return report;
}
function executionBinding(report){
 if(!own(report,'execution')){
  need(!own(report.final,'execution')&&!own(report,'evidenceSeal'),'Partial execution binding');
  for(const rows of Object.values(traceSections(report))){for(const row of Array.isArray(rows)?rows.flat():[rows])if(row&&typeof row==='object')need(!own(row,'runId'),'Partial legacy/run mixture');}
  return 'legacy-source-config-sequence-time-crosschecks';
 }
 const execution=record(report.execution,'Execution');
 need(execution.schema==='aster.browser-ingestion-execution'&&execution.version===1,'Execution schema');
 need(typeof execution.runId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(execution.runId),'Execution UUID');
 same(execution,browserIngestionExecution(report,execution.runId),'Execution source/config/fixture');
 same(report.final.execution,execution,'Runtime execution');
 const cleanup=record(report.runnerCleanup,'Runner cleanup');need(cleanup.completed===true,'Runner cleanup failed/incomplete');
 const resources=['fixture-stop','browser-close','input-stop','server-close'];
 array(cleanup.results,'Runner cleanup resources',resources.length).forEach((r,i)=>need(r.resource===resources[i]&&r.status==='fulfilled'&&!own(r,'error'),'Runner cleanup '+resources[i]));
 if(own(report,'attempt'))need(report.attempt.runId===execution.runId,'Attempt/runtime execution');
 const seal=record(report.evidenceSeal,'Evidence seal');need(seal.runId===execution.runId,'Seal execution');
 const traces=traceSections(report);exactKeys(seal.traces,Object.keys(traces),'Seal trace sections');
 for(const [name,rows]of Object.entries(traces)){
  const expected=seal.traces[name],flatten=Array.isArray(rows)?rows.flat():[rows];
  need(expected.count===flatten.length&&expected.sha256===sha(rows),'Trace coverage '+name);
  for(const row of flatten)if(row&&typeof row==='object')need(row.runId===execution.runId,'Trace run '+name);
 }
 return 'captured-runtime-UUID-source-fixture-config-and-trace-seals';
}
function sourceBinding(report){
 need(report.schema==='aster.cycle12.browser-ingestion','Report schema');
 need(typeof report.timestamp==='string'&&Number.isFinite(Date.parse(report.timestamp)),'Report timestamp');
 const source=record(report.source,'Source');record(source.files,'Source files');
 for(const path of SOURCE_PATHS)need(own(source.files,path),'Source path '+path);
 for(const [path,hash]of Object.entries(source.files))need(typeof path==='string'&&!path.includes('..')&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash),'Source hash');
 need(source.sha256===sha(source.files),'Source manifest hash');record(report.harness,'Harness');
 for(const path of HARNESS_PATHS)need(typeof report.harness[path]==='string'&&/^[a-f0-9]{64}$/.test(report.harness[path]),'Harness hash '+path);
}
function queueLedger(s,config,symbol,{terminal=false}={}){
 record(s,'Queue '+symbol);const p=record(s.policy,'Queue policy');
 need(p.streamId==='fixture-'+symbol&&p.generation===1&&p.firstSequence===0,'Queue stream/generation');
 for(const k of ['maxQueuedEvents','maxQueuedBytes','maxBatchEvents','maxStoredBars','maxStoreBytes'])count(p[k],'Policy '+k,1);
 need(p.maxQueuedEvents===64&&p.maxQueuedBytes===64*49&&p.maxBatchEvents===config.burst,'Fixture queue budget');
 if(config.pressure)need(p.maxStoredBars===config.bars+config.maxStoredExtra,'Fixture store budget');
 for(const k of ['nextSequence','accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','peakPendingEvents','peakPendingBytes','pendingEvents','pendingBytes','ownedBytes','storedBars','storeBytes'])count(s[k],'Queue '+k);
 need(['running','paused','busy'].includes(s.state),'Queue state');
 need(s.accepted===s.applied+s.cancelled+s.pendingEvents&&s.nextSequence===p.firstSequence+s.accepted,'Queue conservation/cursor');
 need(s.pendingBytes===s.pendingEvents*49&&s.pendingEvents<=p.maxQueuedEvents&&s.pendingBytes<=p.maxQueuedBytes,'Queue pending budget');
 need(s.peakPendingEvents<=p.maxQueuedEvents&&s.peakPendingBytes===s.peakPendingEvents*49&&s.peakPendingBytes<=p.maxQueuedBytes&&s.ownedBytes<=p.maxQueuedEvents*49,'Queue peak/owned budget');
 need(s.storedBars>=config.bars&&s.storedBars<=p.maxStoredBars&&s.storeBytes<=p.maxStoreBytes,'Queue stored budget');
 for(const [key,n]of [['lastAppliedSequence',s.applied],['lastCancelledSequence',s.cancelled]])need(n?integer(s[key],0,s.nextSequence-1):s[key]===null,'Queue terminal cursor '+key);
 if(terminal)need(s.pendingEvents===0&&s.pendingBytes===0&&s.state==='running'&&s.lastError===null,'Terminal queue');
}
function producerLedger(p){
 record(p,'Producer');for(const k of ['produced','accepted','producerCancelled','pendingProducerEvents','hostPackets','hostPacketPeak','retryAttempts','sequenceGaps','omittedSamples','scheduledBacklogPeak']){need(own(p,k),'Own producer '+k);count(p[k],'Producer '+k);}
 need(p.produced===p.accepted+p.producerCancelled+p.pendingProducerEvents,'Producer conservation');
 need(p.hostPackets<=1&&p.hostPacketPeak<=1&&p.sequenceGaps===0&&p.omittedSamples===0,'Producer bounds/complete trace');
 need(p.accepted>0,'Positive producer coverage');
}
function proofRows(f,config){
 const proof=array(f.proof,'Full-vector proofs',2);
 for(const [symbol,p]of proof.entries()){
  record(p,'Proof');need(p.symbol===SYMBOLS[symbol],'Proof symbol/order');
  count(p.length,'Proof rows',config.bars);count(p.capacity,'Proof capacity',p.length);count(p.version,'Proof version',1);
  exactKeys(p.sourceDigest,FIELDS,'Six raw columns');for(const k of FIELDS)digest(p.sourceDigest[k],'Raw '+k);
  exactKeys(p.studies,Object.keys(OUTPUTS),'Studies');
  for(const [id,outputs]of Object.entries(OUTPUTS)){
   const s=record(p.studies[id],'Study '+id);exactKeys(s.outputs,outputs,id+' outputs');for(const k of outputs)digest(s.outputs[k],id+'/'+k);
   const checks=record(s.checks,'Oracle '+id);const expected=id==='ema'?p.length-19:id==='rsi'?p.length-14:id==='vwap'?p.length*5:p.length*2;
   need(checks.checked===expected&&expected>0,'Complete finite oracle coverage '+id);
   need(finite(checks.maxRelativeError)&&checks.maxRelativeError<=1e-10,'Accepted oracle error '+id);
   count(s.computedFrom,'Computed from',0,p.length);need(s.computedUntil===p.length,'Computed full history '+id);
   same(s.plotOffsets,id==='module'?{signed:-2,cumulative:-2}:{},'Plot offset '+id);
  }
  const stats=record(p.stats,'Source stats');for(const k of ['attempted','completed','sourceEvents','sourcePublications','cancelled','invalidations','lastSequence','failed','dropped'])count(stats[k],'Stats '+k);
  count(stats.inputRollingFNV,'Input FNV',0,0xffffffff);
  need(stats.failed===0&&stats.dropped===0&&stats.attempted===stats.completed+stats.cancelled&&stats.sourceEvents===stats.attempted,'Source event conservation');
  need(p.version===1+stats.sourcePublications&&stats.sourcePublications>0&&stats.invalidations>=stats.sourcePublications,'Source publication/version');
  array(p.counts,'Notification counts',4).forEach(n=>need(n===stats.sourcePublications,'Notification coverage'));
  array(p.recentNotificationVersions,'Recent listeners',4).forEach(rows=>{array(rows,'Recent versions',Math.min(64,stats.sourcePublications)).forEach((v,i)=>need(v===p.version-rows.length+i+1,'Notification FIFO/version'));});
  need(p.scene.storedBars===p.length&&integer(p.scene.commandCount,1),'Scene proof');
  const m=record(p.logicalMemory,'Logical storage');
  need(m.outputVectors===9&&m.inputCapacityBytes===p.capacity*6*8&&integer(m.outputCapacityBytes,p.length*9*8)&&m.outputCapacityBytes%(9*8)===0&&m.retainedOracleRows===p.length&&m.retainedResetRows===config.bars,'Raw/vector logical coverage');
  count(m.checkpointCount,'Checkpoints',1);count(m.checkpointJSONBytes,'Checkpoint bytes',1);
 }
 return proof;
}
function cleanupAndDrawings(f){
 const c=record(f.cleanup,'Cleanup');
 for(const k of ['canvases','workersLive','inputListeners'])need(c[k]===0,'Owned cleanup '+k);
 need(c.rafPending===false&&c.heartbeatPending===false,'Owned pending tasks');
 count(c.workersCreated,'Workers created');count(c.workersTerminated,'Workers terminated');need(c.workersCreated===c.workersTerminated,'Worker conservation');
 array(c.models,'Model cleanup',2).forEach((m,i)=>need(m.symbol===SYMBOLS[i]&&m.listeners===0&&m.pendingChanges===0&&m.modelDisposed===true,'Model cleanup '+i));
 array(c.charts,'Chart cleanup',2).forEach(x=>need(x.disposed===true&&x.listeners===0&&x.frame===null&&x.canvasWidth===0&&x.canvasHeight===0&&x.cachedPixelBytes===0,'Renderer cleanup'));
 array(c.queueRingKnownBytes,'Ring cleanup',2).forEach(x=>need(x===0,'Owned ring bytes'));
 array(f.drawingChecks,'Drawing proofs',2).forEach((d,i)=>{
  need(d.symbol===SYMBOLS[i]&&d.unchanged===true&&d.undoRedo===true&&typeof d.document==='string','Drawing/history proof');
  const doc=JSON.parse(d.document);need(doc.schema==='aster.drawings'&&doc.version===1,'Drawing document');
  const [a]=array(doc.drawings,'Retained drawings',1);need(a.id==='retained-anchor'&&a.type==='horizontal'&&a.panel==='price'&&a.locked===true,'Retained drawing');
  const [point]=array(a.points,'Drawing anchor',1);need(point.time===1772463720000&&point.price===ANCHOR_PRICES[i],'Raw drawing time/price');
 });
}
function cancellation(receipt,label){record(receipt,label);count(receipt.events,label+' events',1);count(receipt.firstSequence,label+' first');need(receipt.lastSequence===receipt.firstSequence+receipt.events-1,label+' last');return [receipt.firstSequence,receipt.lastSequence+1];}
function transitions(f,config){
 const rows=array(f.transitions,'Transitions'),cancel=[[],[]];let committed=0,abort=0,fence=0,producerCancelled=0;
 for(const t of rows){record(t,'Transition');need(typeof t.type==='string','Transition type');if(own(t,'durationMs'))number(t.durationMs,'Job duration');
  if(t.type==='host-budget-policy'||t.type==='teardown-cancel'){
   count(t.symbol,'Cancel symbol',0,1);cancel[t.symbol].push(cancellation(t.cancelled??t.receipt,'Queue cancel'));
  }else if(t.type==='success-worker-committed-observer'){
   committed++;need(t.resolved===true&&t.observerAbortedAfterCommit===true,'Committed observer');
   const cb=record(t.callback,'Committed callback');need(cb.enqueueAllowed===true&&cb.pauseCancelAllowed===true,'Observer routes');cancel[0].push(cancellation(cb.cancelled,'Observer cancel'));const {runId:_run,...finalQueue}=f.queues[0];same(cb.stats,finalQueue,'Final observer ledger');
  }else if(t.type==='abort-job'){
   abort++;need(t.result==='AbortError'&&t.rejected==='BUSY'&&t.sequenceUnchanged===true,'Abort/lease proof');
  }else if(t.type==='unconfigured-worker-fence'){
   fence++;need(t.busyCode==='BUSY'&&t.terminal==='AbortError'&&t.configureAfterTerminalAllowed===true,'Unconfigured fence');
  }else if(t.type==='temporary-fence-fixture-cleanup'){
   array(t.models,'Temporary models',2).forEach((m,i)=>need(m.symbol===SYMBOLS[i]&&m.listeners===0&&m.pendingChanges===0&&m.modelDisposed===true,'Temporary cleanup'));
  }else if(t.type==='producer-cancel')producerCancelled+=count(t.events,'Producer cancel',1);
  else if(t.type==='pending-document-restore')need(t.restoredSnapshotCounters===true&&t.sourceUnchanged===true&&integer(t.documentBytes,1),'Pending restore proof');
 }
 if(config.strategy==='queued')need(committed===1&&fence===1&&rows.filter(t=>t.type==='temporary-fence-fixture-cleanup').length===1&&abort>=1,'Required async/lease routes');
 need(f.cleanup.workersCreated===committed+fence+abort,'Worker routes/conservation');
 need(producerCancelled===f.producer.producerCancelled,'Producer cancellation trace');
 return {cancel,committed:[committed,0]};
}
function packetTrace(f,config,proof,terminal){
 const rows=array(f.packetSamples,'Packet trace');need(rows.length>0&&rows.length<=config.maxRawSamples,'Packet trace coverage');
 const admitted=[0,0],applied=[0,0],publications=[0,0],versions=[1,1],lengths=[config.bars,config.bars],intervals=[[],[]];let retries=0,lastAt=-Infinity;
 for(const row of rows){record(row,'Packet row');count(row.symbol,'Packet symbol',0,1);const i=row.symbol;
  if(!config.verifyOnly&&row.status!=='retry')need(own(row,'at')&&own(row,row.status==='accepted'?'coreSubmitMs':'coreAndQueryMs'),'Measured packet temporal coverage');
  if(own(row,'at')){number(row.at,'Packet time');need(row.at>=lastAt,'Packet clock order');lastAt=row.at;}
  for(const k of ['coreSubmitMs','coreAndQueryMs'])if(own(row,k))number(row[k],'Packet '+k);
  if(row.status==='retry'){retries++;need(['QUEUE_BUDGET','PAUSED','BUSY','SOURCE_CHANGED'].includes(row.code),'Retry code');need(row.firstSequence===admitted[i],'Retry sequence');count(row.events,'Retry events',1,config.burst);continue;}
  const receipt=record(row.receipt,'Packet receipt');count(receipt.events,'Receipt events',1,config.burst);
  if(row.status==='accepted'){
   need(['current-update','append','correction-first','correction-middle','correction-tail'].includes(row.kind),'Accepted packet kind');
   need(row.firstSequence===admitted[i]&&row.events===receipt.events,'Accepted sequence/events');admitted[i]+=receipt.events;
   if(config.strategy==='queued')need(receipt.firstSequence===row.firstSequence&&receipt.nextSequence===admitted[i]&&integer(receipt.pendingEvents,receipt.events,64)&&receipt.pendingBytes===receipt.pendingEvents*49,'Accepted queue receipt');
   else{const pubs=config.strategy==='scalar'?receipt.events:1;versions[i]+=pubs;publications[i]+=pubs;need(receipt.version===versions[i],'Direct packet version');}
  }else{
   need(row.status==='applied'&&config.strategy==='queued','Packet status');
   need(receipt.version===++versions[i],'Applied publication/version');publications[i]++;applied[i]+=receipt.events;
   const interval=cancellation({events:receipt.events,firstSequence:receipt.firstSequence,lastSequence:receipt.lastSequence},'Applied interval');need(interval[1]<=admitted[i],'Applied accepted prefix');intervals[i].push(interval);
  }
  if(row.status==='applied'||config.strategy!=='queued'){
   count(receipt.length,'Receipt rows',config.bars,proof[i].length);count(receipt.capacity,'Receipt capacity',receipt.length,proof[i].capacity);
   if(own(receipt,'appended')){count(receipt.appended,'Appended',0,receipt.events);need(receipt.length===lengths[i]+receipt.appended,'Retained append history');}
   lengths[i]=receipt.length;
   if(config.strategy!=='scalar'){need(receipt.bytes===receipt.capacity*96,'Receipt store bytes');count(receipt.from,'Receipt from',0,receipt.length-1);count(receipt.to,'Receipt to',receipt.from+1,receipt.length);}
  }
 }
 need(admitted[0]+admitted[1]===f.producer.accepted&&retries===f.producer.retryAttempts,'Full accepted/retry packet coverage');
 for(const i of [0,1]){
  const p=proof[i];need(p.stats.sourcePublications===publications[i]+terminal.committed[i],'Full publication trace');
  if(config.strategy==='queued'){
   const q=f.queues[i],cancel=terminal.cancel[i],cancelled=cancel.reduce((n,[a,b])=>n+b-a,0);
   need(q.applied===applied[i]&&q.cancelled===cancelled&&q.accepted===admitted[i]+(i===0?terminal.committed[0]?f.transitions.find(t=>t.type==='success-worker-committed-observer').callback.cancelled.events:0:0),'Queue trace coverage');
   const covered=intervals[i].concat(cancel).sort((a,b)=>a[0]-b[0]);let cursor=0;for(const [a,b]of covered){need(a===cursor&&b>a,'No missing/duplicate queue interval');cursor=b;}need(cursor===q.nextSequence,'Complete terminal queue cursor');
   need(p.stats.attempted===q.accepted+terminal.committed[i]&&p.stats.completed===q.applied+terminal.committed[i]&&p.stats.cancelled===q.cancelled&&p.stats.lastSequence===q.nextSequence,'Source/queue/worker binding');
   need(q.storedBars===p.length&&q.storeBytes===p.capacity*96,'Queue/store proof binding');
  }else need(p.stats.attempted===admitted[i]&&p.stats.completed===admitted[i]&&p.stats.cancelled===0&&p.stats.lastSequence===admitted[i],'Direct source/packet binding');
  need(lengths[i]===p.length,'Final retained history trace');
 }
}
function barShape(bar,label){record(bar,label);for(const k of FIELDS)need(own(bar,k)&&finite(bar[k],k==='time'?-8640000000000000:k==='volume'?0:-Number.MAX_VALUE),'Finite raw endpoint '+k);need(Number.isSafeInteger(bar.time)&&Math.abs(bar.time)<=8640000000000000&&bar.high>=bar.low&&bar.open>=bar.low&&bar.open<=bar.high&&bar.close>=bar.low&&bar.close<=bar.high,'Raw endpoint envelope');}
function epochTrace(f,config,proof,measured){
 const epochs=array(f.epochs,'Epoch trace');need(epochs.length===(measured?Math.floor(config.durationSeconds/config.epochSeconds):0),'Full epoch coverage');
 epochs.forEach((e,index)=>{need(e.epoch===index+1&&e.sourceReset===false&&e.sourceEviction===false,'Retained epoch/history');producerLedger(e.producer);array(e.source,'Epoch models',2).forEach((s,i)=>{need(s.symbol===SYMBOLS[i]&&integer(s.length,config.bars,proof[i].length)&&integer(s.capacity,s.length,proof[i].capacity)&&integer(s.version,1,proof[i].version),'Epoch source binding');barShape(s.first,'First bar');barShape(s.last,'Last bar');need(s.first.time===1772461800000&&s.last.time>s.first.time&&integer(s.outputCapacityBytes,s.length*9*8,proof[i].logicalMemory.outputCapacityBytes),'Epoch raw/time/vector binding');});if(config.strategy==='queued')array(e.queues,'Epoch queues',2).forEach((q,i)=>{queueLedger(q,config,i);same(q.policy,f.queues[i].policy,'Epoch policy');need(q.accepted<=f.queues[i].accepted&&q.applied<=f.queues[i].applied,'Epoch ledger chronology');});});
}
function matchingRender(rows,at,version){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].at<at-.11)lo=mid+1;else hi=mid;}for(let i=lo;i<rows.length&&rows[i].at<=at+.11;i++)if(rows[i].version===version)return true;return false;}
function temporalTrace(f,config,proof,measured){
 const inputs=array(f.inputSamples,'Trusted input');need(inputs.length>0&&inputs.length<=config.maxRawSamples,'Input coverage');
 const types=new Set(),symbols=new Set();let previous=-Infinity;
 for(const s of inputs){record(s,'Input row');count(s.symbol,'Input symbol',0,1);need(['pointermove','pointerdown','pointerup','wheel'].includes(s.type)&&s.isTrusted===true,'Trusted input route');need(s.pointerType===(s.type==='wheel'?null:'mouse')&&integer(s.buttons,0,31),'Input endpoint shape');types.add(s.type);symbols.add(s.symbol);
  if(measured){for(const k of ['eventAt','handlerAt','renderAt','inputToNextRenderMs','handlerToNextRenderMs'])number(s[k],'Input '+k);count(s.version,'Input version',1,proof[s.symbol].version);need(s.eventAt+.11>=previous,'Input temporal order');previous=s.eventAt;need(s.handlerAt+.11>=s.eventAt&&s.renderAt+.11>=s.handlerAt&&Math.abs(s.renderAt-s.eventAt-s.inputToNextRenderMs)<=.11&&Math.abs(s.renderAt-s.handlerAt-s.handlerToNextRenderMs)<=.11,'Input temporal relations');}
 }
 need(types.size===4&&symbols.size===2,'Both models and mouse/wheel/drag routes');
 const render=array(f.renderSamples,'Render traces',2),heartbeat=array(f.heartbeat,'Heartbeat trace');
 if(!measured){need(heartbeat.length===0&&render.every(a=>Array.isArray(a)&&a.length===0),'Verify-only has no measured traces');return;}
 need(heartbeat.length>1&&heartbeat.length<=config.maxRawSamples,'Full heartbeat trace');let elapsed=0;
 heartbeat.forEach((h,i)=>{record(h,'Heartbeat row');number(h.gapMs,'Heartbeat gap');need(h.final===(i===heartbeat.length-1),'Exactly terminal heartbeat');elapsed+=h.gapMs;});
 need(Number.isFinite(elapsed)&&elapsed+.11>=f.primaryElapsedSeconds*1000,'Heartbeat duration coverage');
 for(const [i,rows]of render.entries()){
  array(rows,'Render model');need(rows.length>0&&rows.length<=config.maxRawSamples,'Both render traces');let at=-Infinity,version=0,length=config.bars;
  for(const row of rows){record(row,'Render row');number(row.at,'Render time');number(row.cpuSubmitMs,'Render CPU');need(row.at>=at&&integer(row.version,version,proof[i].version)&&integer(row.storedBars,length,proof[i].length),'Render chronology/source');at=row.at;version=row.version;length=row.storedBars;}
 }
 // The legacy fixture records absolute input timestamps and relative render at,
 // but no explicit start timestamp. Infer only a common origin that matches all
 // actual render endpoints, with0.11ms tolerance for quantized browser clocks.
 const first=inputs[0],candidates=render[first.symbol].filter(row=>row.version===first.version).map(row=>first.renderAt-row.at);
 need(candidates.some(start=>finite(start)&&inputs.every(s=>matchingRender(render[s.symbol],s.renderAt-start,s.version))),'Input/render run clock binding');
 const firstEvent=inputs[0].eventAt,lastEvent=inputs.at(-1).eventAt;
 need(lastEvent-firstEvent>=Math.max(0,f.primaryElapsedSeconds*1000-1000),'Input start/end coverage');
}
function validate(report){
 jsonNumbers(report);record(report,'Report');need(!own(report,'failure')&&(!own(report,'status')||report.status==='pass'),'Outer runner failure/pending');sourceBinding(report);const f=record(report.final,'Final'),config=record(report.conditions,'Conditions');
 for(const [key,min,max]of [['durationSeconds',1,900],['bars',33,100000],['lineSeries',1,32],['burst',1,128],['tickMs',16,1000],['drainEveryFrames',1,60],['epochSeconds',1,60],['maxStoredExtra',0,100000],['maxRawSamples',1024,131072],['verifyPackets',4,128]])count(config[key],'Condition '+key,min,max);
 need((!config.pressure||config.strategy==='queued')&&['queued','scalar','atomic'].includes(config.strategy)&&['canvas','webgl2'].includes(config.renderer)&&[1,2].includes(config.dpr)&&typeof config.pressure==='boolean'&&typeof config.verifyOnly==='boolean','Fixture mode');
 same(f.conditions,config,'Runtime fixture conditions');need(typeof report.measurementRan==='boolean'&&f.measurementRan===report.measurementRan&&config.verifyOnly===!report.measurementRan,'Measurement mode');
 need(f.status==='pass'&&array(f.errors,'Runtime errors').length===0,'Runtime errors/status');
 const protocol=record(report.protocol,'Protocol');for(const key of ['exceptions','crashes','externalRequests'])need(array(protocol[key],'Protocol '+key).length===0,'Protocol '+key);
 number(f.primaryElapsedSeconds,'Primary duration');if(report.measurementRan)need(f.primaryElapsedSeconds>=config.durationSeconds,'Incomplete primary duration');else need(f.primaryElapsedSeconds===0,'Verify-only duration');
 producerLedger(f.producer);need(f.producer.pendingProducerEvents===0&&f.producer.hostPackets===0&&f.producer.hostPacketPeak===1,'Terminal producer');
 const target=report.measurementRan&&!config.pressure?Math.floor(config.durationSeconds*1000/config.tickMs):null;
 need(f.producer.targetPackets===target,'Configured producer target');
 if(!report.measurementRan)need(f.producer.produced===config.verifyPackets*config.burst,'Verify-only packet completion');
 else if(target!==null)need(f.producer.produced===target*config.burst,'Measured packet completion');
 const proof=proofRows(f,config);if(config.strategy==='queued')array(f.queues,'Terminal queues',2).forEach((q,i)=>queueLedger(q,config,i,{terminal:true}));else need(f.queues===null,'Direct mode queue evidence');
 cleanupAndDrawings(f);const terminal=transitions(f,config);packetTrace(f,config,proof,terminal);epochTrace(f,config,proof,report.measurementRan);temporalTrace(f,config,proof,report.measurementRan);
 return executionBinding(report);
}
export function ingestionBrowserEvidenceVerdict(report){
 let errors=[],binding=null,wants900=false;try{binding=validate(report);wants900=report.measurementRan===true&&report.conditions.durationSeconds===900;}catch(error){errors=[error instanceof Error?error.message:'Invalid completed evidence'];}
 const status=errors.length?'fail':'pass';
 return {status,errors,qualifying900Seconds:wants900&&status==='pass',evidenceBinding:binding,scope:'Completed two-model WEB fixture evidence; finite oracle/trace/cleanup and available run bindings. Legacy reports lack UUID/trace seals, so indistinguishable self-consistent legacy mixes or tiny trace loss cannot be authenticated. No physical display/native input or long-term leak certification'};
}
