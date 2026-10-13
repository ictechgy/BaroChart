import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,seededColumns} from '../src/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {hydrateModel,modelRequest,installRecomputed,validatePreparedPacketAsync} from '../src/web/worker-state.mjs';
import {prepareChartModel,recomputeInWorker} from '../src/web/worker.mjs';
import {LazyCheckpoints} from '../src/web/checkpoint-codec.mjs';
function fixture(){const store=new BarStore();store.setColumns(seededColumns(550));const model=new ChartModel({store});model.indicators.add('e','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});return model;}
function fake(){const previous=globalThis.Worker,workers=[];class W{constructor(){workers.push(this);}postMessage(request){this.request=structuredClone(request);}terminate(){this.terminated=true;}async complete(packet){this.onmessage({data:{packet:packet??await computeRequest(this.request)}});}}globalThis.Worker=W;return {workers,restore:()=>globalThis.Worker=previous};}
test('request definition mismatch, missing/extra/duplicate IDs and inconsistent options fail before commit',async()=>{
 const model=fixture(),event={kind:'correction',bar:{...model.store.at(0),high:1000,close:1000}},before=model.store.at(0),version=model.store.version;
 const valid=await computeRequest({columns:model.store.columns,length:model.store.length,event,options:modelRequest(model)});
 for(const change of [p=>p.indicators[0].name='rsi',p=>p.indicators[0].params.period=21,p=>p.indicators.pop(),p=>p.indicators.push({...p.indicators[0],id:'extra'}),p=>p.indicators.push(p.indicators[0]),p=>p.options.indicators[0].name='rsi',p=>p.indices.push(p.indices[0]),p=>p.options.series[0].visible=false,p=>p.indicators[0].dirtyTo=1,p=>p.indicators[0].computedUntil=551,p=>p.protocolVersion=0]){const p=structuredClone(valid);change(p);assert.throws(()=>installRecomputed(model,p,event));assert.deepEqual(model.store.at(0),before);assert.equal(model.store.version,version);}
 model.dispose();
});
test('async validation leaves caches lazy and installation does not synchronously reparse payloads',async()=>{
 const original=LazyCheckpoints.prototype.decodeRecord;let calls=0;LazyCheckpoints.prototype.decodeRecord=function(...args){calls++;return original.apply(this,args);};
 try{const model=fixture(),expected=modelRequest(model),packet=await computeRequest({columns:model.store.columns,length:model.store.length,options:expected});const handle=await validatePreparedPacketAsync(packet,expected),validatedCalls=calls;const hydrated=hydrateModel(packet,expected,handle);assert.equal(calls,validatedCalls);assert.equal(hydrated.indicators.entries.get('e').checkpoints.cache.size,0);assert.equal(hydrated.indicators.entries.get('e').invalidated,false);assert.equal(hydrated.indicators.entries.get('e').dirtyTo,0);assert.equal(hydrated.indicators.entries.get('e').computedUntil,550);model.dispose();hydrated.dispose();}finally{LazyCheckpoints.prototype.decodeRecord=original;}
});
test('prepare retains entry request definitions and rejects a fully valid but different calculator reply',async()=>{
 const {workers,restore}=fake();try{const request={columns:seededColumns(550),options:{indicators:[{id:'e',name:'ema',params:{period:20}}],series:[{id:'e',type:'line',panel:'price',indicator:'e'}]}},pending=prepareChartModel(request);request.options.indicators[0].name='rsi';request.options.indicators[0].params.period=14;const forged=structuredClone(workers[0].request);forged.options.indicators[0].name='rsi';forged.options.indicators[0].params.period=14;await workers[0].complete(await computeRequest(forged));await assert.rejects(pending,/definition|binding|requested/i);assert.equal(workers[0].terminated,true);}finally{restore();}
});
test('malformed requested params are rejected without normalizing them into accepted objects',async()=>{
 for(const params of [null,[],1,'20'])await assert.rejects(prepareChartModel({options:{indicators:[{id:'e',name:'ema',params}]}}),/params|object/i);
});
test('abort and a data change during validation preserve previously visible state',async()=>{
 const {workers,restore}=fake();try{for(const mode of ['abort','stale']){const model=fixture(),before=model.store.at(0),controller=new AbortController(),event={kind:'correction',bar:{...before,close:1000,high:1000}},pending=recomputeInWorker(model,event,{signal:controller.signal,onProgress:p=>{if(p.phase==='validation'){if(mode==='abort')controller.abort();else model.store.update(1,{...model.store.at(1),volume:999});}}});await workers.at(-1).complete();await assert.rejects(pending,mode==='abort'?e=>e.name==='AbortError':/stale/);assert.deepEqual(model.store.at(0),before);model.dispose();}}finally{restore();}
});
test('whole-operation timeout during bounded validation preserves recompute data and prevents prepare delivery',async()=>{
 const {workers,restore}=fake();try{
  const model=fixture(),before=model.store.at(0),version=model.store.version,event={kind:'correction',bar:{...before,high:1000,close:1000}},options={timeoutMs:10,maxRecordsPerSlice:1,yieldTask:()=>new Promise(resolve=>setTimeout(resolve,60))};
  const pending=recomputeInWorker(model,event,options);await workers.at(-1).complete();await assert.rejects(pending,e=>e.name==='TimeoutError'&&/timeout/i.test(e.message));assert.deepEqual(model.store.at(0),before);assert.equal(model.store.version,version);assert.equal(workers.at(-1).terminated,true);
  const preparing=prepareChartModel({columns:model.store.columns,length:model.store.length,options:modelRequest(model)},options);await workers.at(-1).complete();await assert.rejects(preparing,e=>e.name==='TimeoutError');model.dispose();
 }finally{restore();}
});
test('public operation timeout is finite, positive and bounded before creating a worker',async()=>{
 const {workers,restore}=fake();try{for(const timeoutMs of [0,-1,NaN,Infinity,'10',null,120001])await assert.rejects(prepareChartModel({options:{}},{timeoutMs}),/timeout/i);assert.equal(workers.length,0);}finally{restore();}
});
test('observer cancellation after the atomic publication point does not reject an already committed result',async()=>{
 const {workers,restore}=fake();try{const model=fixture(),controller=new AbortController(),event={kind:'correction',bar:{...model.store.at(0),high:1000,close:1000}};model.store.subscribe(()=>controller.abort());const pending=recomputeInWorker(model,event,{signal:controller.signal});await workers.at(-1).complete();assert.equal(await pending,model);assert.equal(model.store.at(0).close,1000);assert.equal(controller.signal.aborted,true);model.dispose();}finally{restore();}
});
