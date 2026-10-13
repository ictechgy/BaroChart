import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,seededColumns} from '../src/core/index.mjs';
import {AsyncCapture,AsyncPrepared} from '../src/core/async-state.mjs';
import {PrepareCapture} from '../src/core/prepare-state.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {installRecomputed,modelRequest} from '../src/web/worker-state.mjs';
import {recomputeInWorker} from '../src/web/worker.mjs';
const fixture=()=>{const store=new BarStore();store.setColumns(seededColumns(512));const model=new ChartModel({store}),api=new ChartAPI(model);api.addIndicator('e','ema',{period:20});api.addIndicator('r','rsi',{period:14});api.configureDataIngestion({streamId:'A',generation:1});return {model,api};};
const ev=model=>({kind:'correction',bar:{...model.store.at(0),close:120,high:130}});
const packet=(events,firstSequence=0)=>({streamId:'A',generation:1,firstSequence,events});
test('configured pending ingestion blocks captures without losing ownership',()=>{
 const {model,api}=fixture();try{api.enqueueDataEvents(packet([ev(model)]));for(const factory of [()=>new AsyncCapture(model,ev(model)),()=>new PrepareCapture(model,{kind:'seeded',count:10})])assert.throws(factory,e=>e.code==='PENDING_DATA');assert.equal(api.dataIngestionStats().pendingEvents,1);assert.equal(api.dataIngestionStats().state,'running');}finally{model.dispose();}
});
test('configured admission budgets reject async batch before creating a target or changing source',async()=>{
 const {model,api}=fixture();try{api.configureDataIngestion({streamId:'A',generation:1,maxStoredBars:512});const last=model.store.at(511),event={kind:'batch',events:[{kind:'append',bar:{...last,time:last.time+60000}}]};assert.throws(()=>new AsyncCapture(model,event),e=>e.code==='STORE_BUDGET');await assert.rejects(recomputeInWorker(model,event),e=>e.code==='STORE_BUDGET');assert.equal(model.store.length,512);assert.equal(api.dataIngestionStats().state,'running');}finally{model.dispose();}
});
test('capture lease blocks mutators, releases on constructor failure and terminal release',()=>{
 const {model,api}=fixture();try{assert.throws(()=>new AsyncCapture(model,{kind:'invalid'}));assert.equal(api.dataIngestionStats().state,'running');const capture=new AsyncCapture(model,ev(model));assert.equal(api.dataIngestionStats().state,'busy');for(const action of [()=>api.enqueueDataEvents(packet([ev(model)])),()=>api.drainDataEvents(),()=>api.cancelDataEvents(),()=>api.configureDataIngestion({streamId:'B',generation:2}),()=>api.loadDataIngestion(api.saveDataIngestion())])assert.throws(action,e=>e.code==='BUSY');capture.release();capture.release();assert.equal(api.dataIngestionStats().state,'running');api.enqueueDataEvents(packet([ev(model)]));api.drainDataEvents();assert.equal(api.dataIngestionStats().accepted,1);}finally{model.dispose();}
});
test('native isolated batch preserves all columns/vectors and ingestion ledger across UI restoration',()=>{
 const source=fixture(),scalar=fixture();let prepared;try{
  const events=[ev(source.model),{kind:'correction',bar:{...source.model.store.at(400),close:140,high:150}},{kind:'append',bar:{...source.model.store.at(511),time:source.model.store.at(511).time+60000}}],capture=new AsyncCapture(source.model,{kind:'batch',events});
  assert.throws(()=>source.api.enqueueDataEvents(packet([ev(source.model)])),e=>e.code==='BUSY');
  prepared=new AsyncPrepared(capture.metadataJSON);for(let slot=0;slot<capture.buffers.length;slot++)prepared.target(slot,0,capture.buffers[slot].length).set(capture.buffer(slot,0,capture.buffers[slot].length));for(let entry=0;entry<capture.checkpoints.length;entry++)for(let i=0;i<capture.checkpoints[entry].keys.length;i++)prepared.checkpoint(entry,capture.checkpoint(entry,i,1));
  prepared.start();while(!prepared.step(128).complete){}const done=prepared.finish(capture.ui(null,{width:1200,height:700})).model,api=new ChartAPI(done);scalar.api.applyDataEvents(events);
  for(const key of ['time','open','high','low','close','volume'])assert.deepEqual(done.store.columns[key],scalar.model.store.columns[key]);for(const id of ['e','r'])assert.deepEqual(done.indicators.get(id).outputs,scalar.model.indicators.get(id).outputs);
  assert.equal(api.dataIngestionStats().rejectedPackets,1);assert.equal(api.dataIngestionStats().state,'running');assert.equal(api.saveDataIngestion(),source.api.saveDataIngestion());capture.release();api.enqueueDataEvents(packet([{kind:'update',bar:done.store.at(done.store.length-1)}]));assert.equal(api.drainDataEvents().events,1);
 }finally{source.model.dispose();scalar.model.dispose();prepared?.dispose();}
});
test('worker batch install preserves model session and final-tail notification semantics',async()=>{
 const {model,api}=fixture();try{const last=model.store.at(511),event={kind:'batch',events:[ev(model),{kind:'append',bar:{...last,time:last.time+60000}}]},request=modelRequest(model),reply=await computeRequest({columns:model.store.columns,length:512,event,options:request});const session=model.dataIngestion,changes=[];const stop=model.store.subscribe(c=>changes.push(c));installRecomputed(model,reply,event,request);stop();assert.equal(model.dataIngestion,session);assert.equal(changes.length,1);assert.equal(changes[0].appended,1);assert.equal(model.view.to,512.5);api.enqueueDataEvents(packet([{kind:'update',bar:model.store.at(512)}]));api.drainDataEvents();}finally{model.dispose();}
});
test('worker setup failure and pre-abort release an empty ingestion lease',async()=>{
 const {model,api}=fixture();const Worker=globalThis.Worker;try{globalThis.Worker=class{constructor(){throw new Error('fixture worker setup failure');}};await assert.rejects(recomputeInWorker(model,ev(model)),/setup failure/);assert.equal(api.dataIngestionStats().state,'running');const signal=AbortSignal.abort();await assert.rejects(recomputeInWorker(model,ev(model),{signal}),e=>e.name==='AbortError');assert.equal(api.dataIngestionStats().state,'running');}finally{globalThis.Worker=Worker;model.dispose();}
});
test('worker committed observers may enqueue or configure while committed cancellation stays inert',async()=>{
 const OriginalWorker=globalThis.Worker;
 try{globalThis.Worker=class{postMessage(request){computeRequest(request).then(packet=>this.onmessage?.({data:{packet}}),error=>this.onerror?.({message:error.message}));}terminate(){}};
  for(const configured of [true,false]){const {model,api}=fixture();try{if(!configured){model.dataIngestion.dispose();model.dataIngestion=null;}const controller=new AbortController();let seen=false;const stop=model.store.subscribe(()=>{if(seen)return;seen=true;if(!configured)api.configureDataIngestion({streamId:'A',generation:1});api.enqueueDataEvents(packet([{kind:'update',bar:model.store.at(511)}]));controller.abort();});const result=await recomputeInWorker(model,{kind:'update',bar:model.store.at(511)},{signal:controller.signal});stop();assert.equal(result,model);assert.equal(seen,true);assert.deepEqual(model.store.listenerErrors,[]);assert.equal(api.dataIngestionStats().pendingEvents,1);assert.equal(api.dataIngestionStats().state,'running');assert.equal(api.drainDataEvents().events,1);}finally{model.dispose();}}
 }finally{globalThis.Worker=OriginalWorker;}
});
