// Compact predicate fixture. Core rows/vectors/queue receipts are real64-bar
// computations; browser/input/worker clocks below are declared synthetic data.
// It requires no excluded benchmark raw evidence and launches no worker/browser.
import * as A from '../../src/core/index.mjs';
import {createIngestionFixture,dispatchIngestionPacket,commitIngestionPacketReference,configureIngestionFixture,ingestionPacket,enqueueIngestionPacket,drainIngestionFixture,ingestionLedger,cancelIngestionFixture,queryIngestionFixture,verifyIngestionFixture,disposeIngestionFixture} from '../../benchmarks/ingestion.mjs';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const sourcePaths=['src/index.mjs','src/core/data.mjs','src/core/model.mjs','src/core/indicators.mjs','src/core/ingestion.mjs','src/renderers/canvas.mjs','src/web/worker.mjs','src/web/worker-state.mjs','src/web/compute-worker.mjs','package.json','native/Resources/aster-core.js'];
const harnessPaths=['../benchmarks/ingestion.mjs','../benchmarks/browser-ingestion.mjs','../benchmarks/browser-soak.mjs','../scripts/cdp.mjs','./cycle12-ingestion-browser.mjs'];
function baseReport(){
 const fixture=createIngestionFixture(A,{bars:64,lineSeries:1});
 configureIngestionFixture(fixture,{maxStoredBars:576});
 const packetSamples=[],drawingChecks=[];
 for(const [symbol,o]of fixture.owners.entries()){
  o.api.addDrawing({id:'retained-anchor',type:'horizontal',panel:'price',locked:true,points:[{time:o.original[32].time,price:o.original[32].close}],style:{color:'#ffd000'}});
  const document=o.api.saveDrawings();o.api.undo();o.api.redo();
  drawingChecks.push({symbol:o.symbol.id,document,unchanged:o.api.saveDrawings()===document,undoRedo:true});
  for(let ordinal=0;ordinal<2;ordinal++){
  const first=ordinal*8,packet=ingestionPacket(fixture,'current-update',symbol,first,8,{reference:true});
  const accepted=enqueueIngestionPacket(fixture,packet);
  packetSamples.push({symbol,kind:packet.kind,status:'accepted',firstSequence:first,events:8,receipt:accepted,at:packetSamples.length+1,coreSubmitMs:.1});
  const applied=drainIngestionFixture(fixture,symbol,8);queryIngestionFixture(fixture,symbol);
  packetSamples.push({symbol,status:'applied',receipt:applied,at:packetSamples.length+1,coreAndQueryMs:.1});
  }
 }
 const owner=fixture.owners[0];
 owner.api.applyDataEvent({kind:'update',bar:owner.store.at(owner.store.length-1)});
 for(const key of ['attempted','completed','sourceEvents','sourcePublications'])owner.stats[key]++;
 const observerPacket=ingestionPacket(fixture,'current-update',0,16,8,{reference:true});
 enqueueIngestionPacket(fixture,observerPacket);const cancelled=cancelIngestionFixture(fixture,0);
 const transitions=[
  {type:'abort-job',result:'AbortError',rejected:'BUSY',sequenceUnchanged:true,durationMs:1,stats:ingestionLedger(owner.api)},
  {type:'success-worker-committed-observer',resolved:true,observerAbortedAfterCommit:true,callback:{enqueueAllowed:true,pauseCancelAllowed:true,cancelled,stats:ingestionLedger(owner.api)}},
  {type:'unconfigured-worker-fence',busyCode:'BUSY',terminal:'AbortError',configureAfterTerminalAllowed:true},
  {type:'temporary-fence-fixture-cleanup',models:[{symbol:'SYNTH:A',listeners:0,pendingChanges:0,modelDisposed:true},{symbol:'SYNTH:B',listeners:0,pendingChanges:0,modelDisposed:true}]}
 ];
 const queues=fixture.owners.map(o=>ingestionLedger(o.api)),proof=verifyIngestionFixture(fixture),models=disposeIngestionFixture(fixture);
 const files=Object.fromEntries(sourcePaths.map(p=>[p,hash(p)]));
 return {schema:'aster.cycle12.browser-ingestion',timestamp:'2026-10-12T00:00:00.000Z',sourceRoot:'/synthetic-fixture',source:{files,sha256:hash(JSON.stringify(files))},harness:Object.fromEntries(harnessPaths.map(p=>[p,hash(p)])),measurementRan:true,conditions:{verifyOnly:false,durationSeconds:900,bars:64,lineSeries:1,strategy:'queued',renderer:'canvas',dpr:1,burst:8,tickMs:100,drainEveryFrames:1,pressure:true,epochSeconds:60,maxStoredExtra:512,maxRawSamples:131072,verifyPackets:4},protocol:{exceptions:[],crashes:[],externalRequests:[]},samples:[],final:{measurementRan:true,status:'pass',conditions:null,errors:[],primaryElapsedSeconds:900,producer:{produced:32,accepted:32,producerCancelled:0,pendingProducerEvents:0,hostPackets:0,hostPacketPeak:1,retryAttempts:0,sequenceGaps:0,omittedSamples:0,targetPackets:null,scheduledBacklogPeak:1},queues,proof,drawingChecks,packetSamples,transitions,epochs:[],inputSamples:[],renderSamples:[],heartbeat:[],appendDisabled:[false,false],cleanup:{canvases:0,workersLive:0,workersCreated:3,workersTerminated:3,rafPending:false,heartbeatPending:false,inputListeners:0,models,charts:[0,1].map(()=>({disposed:true,listeners:0,frame:null,canvasWidth:0,canvasHeight:0,cachedPixelBytes:0})),queueRingKnownBytes:[0,0]}}};
}
const base=baseReport();
export function healthyBrowserIngestionReport({duration=900,measured=true}={}){
 const r=structuredClone(base),f=r.final;
 r.measurementRan=f.measurementRan=measured;r.conditions.durationSeconds=duration;r.conditions.verifyOnly=!measured;
 f.conditions={...r.conditions};f.primaryElapsedSeconds=measured?duration:0;
 if(measured){
  f.heartbeat=Array.from({length:duration},()=>({gapMs:1000,final:false}));f.heartbeat.push({gapMs:0,final:true});
  const start=1000;
  f.renderSamples=f.proof.map(p=>[{at:10,cpuSubmitMs:1,storedBars:p.length,version:2},{at:duration*1000,cpuSubmitMs:1,storedBars:p.length,version:p.version}]);
  for(const symbol of [0,1])for(const [i,type]of ['pointermove','wheel','pointerdown','pointerup'].entries()){
   const at=i===0?10:duration*1000;
   const version=i===0?2:f.proof[symbol].version;
   f.inputSamples.push({symbol,type,isTrusted:true,pointerType:type==='wheel'?null:'mouse',buttons:type==='pointerdown'?1:0,eventAt:start+at-2,handlerAt:start+at-1,renderAt:start+at,inputToNextRenderMs:2,handlerToNextRenderMs:1,version});
  }
  f.inputSamples.sort((a,b)=>a.eventAt-b.eventAt);
  f.epochs=Array.from({length:Math.floor(duration/r.conditions.epochSeconds)},(_,i)=>({epoch:i+1,producer:{...f.producer},queues:structuredClone(f.queues),source:f.proof.map((p,symbol)=>({symbol:p.symbol,length:p.length,capacity:p.capacity,version:p.version,first:{time:1772461800000,open:100,high:101,low:99,close:100,volume:1},last:{time:1772465580000,open:100,high:101,low:99,close:100,volume:1},outputCapacityBytes:p.logicalMemory.outputCapacityBytes})),sourceReset:false,sourceEviction:false}));
 }else{
  f.heartbeat=[];f.renderSamples=[[],[]];f.epochs=[];
  f.inputSamples=[0,1].flatMap(symbol=>['pointermove','wheel','pointerdown','pointerup'].map(type=>({symbol,type,isTrusted:true,pointerType:type==='wheel'?null:'mouse',buttons:type==='pointerdown'?1:0})));
  for(const p of f.packetSamples){delete p.at;delete p.coreSubmitMs;delete p.coreAndQueryMs;}
  delete f.transitions[0].durationMs;
 }
 return r;
}

export function directBrowserIngestionReport(strategy){
 const r=healthyBrowserIngestionReport({duration:3}),f=r.final,fixture=createIngestionFixture(A,{bars:64,lineSeries:1});
 r.conditions.strategy=strategy;r.conditions.pressure=false;r.conditions.tickMs=1000;f.conditions={...r.conditions};
 f.packetSamples=[];f.transitions=[];f.queues=null;f.drawingChecks=[];
 for(const o of fixture.owners){
  o.api.addDrawing({id:'retained-anchor',type:'horizontal',panel:'price',locked:true,points:[{time:o.original[32].time,price:o.original[32].close}],style:{color:'#ffd000'}});
  const document=o.api.saveDrawings();o.api.undo();o.api.redo();f.drawingChecks.push({symbol:o.symbol.id,document,unchanged:o.api.saveDrawings()===document,undoRedo:true});
 }
 for(let ordinal=0;ordinal<3;ordinal++){
  const symbol=ordinal%2,o=fixture.owners[symbol],first=o.stats.lastSequence,packet=ingestionPacket(fixture,'current-update',symbol,first,8);
  const receipt=dispatchIngestionPacket(fixture,packet,{strategy});commitIngestionPacketReference(fixture,packet);queryIngestionFixture(fixture,symbol);
  f.packetSamples.push({symbol,kind:packet.kind,status:'accepted',firstSequence:first,events:8,receipt,at:ordinal+1,coreSubmitMs:.1});
 }
 f.proof=verifyIngestionFixture(fixture);f.cleanup.models=disposeIngestionFixture(fixture);f.cleanup.workersCreated=f.cleanup.workersTerminated=0;
 f.producer.produced=f.producer.accepted=24;f.producer.targetPackets=3;
 for(const [symbol,rows]of f.renderSamples.entries())for(const row of rows)row.version=f.proof[symbol].version;
 for(const input of f.inputSamples)input.version=f.proof[input.symbol].version;
 return r;
}
