import test from 'node:test';import assert from 'node:assert/strict';
import {ChartModel,BarStore,seededColumns,buildScene} from '../src/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';import {hydrateModel,modelRequest,installRecomputed} from '../src/web/worker-state.mjs';import {recomputeInWorker} from '../src/web/worker.mjs';
function fixture(){const store=new BarStore();store.setColumns(seededColumns(550));const model=new ChartModel({store});for(const [id,name] of [['e','ema'],['b','bollinger'],['r','rsi']]){model.indicators.add(id,name);model.addSeries({id,type:'line',panel:'price',indicator:id});}buildScene(model,1200,700);return model;}
test('prepared model preserves full vectors, checkpoints, warm-up and range-query values',async()=>{
 const m=fixture(),request={columns:m.store.columns,length:m.store.length,options:modelRequest(m)},packet=await computeRequest(request),restored=hydrateModel(packet);
 for(const id of ['e','b','r']){const a=m.indicators.get(id),b=restored.indicators.get(id);for(const key of Object.keys(a.outputs))assert.deepEqual(b.outputs[key],a.outputs[key]);}
 restored.store.update(20,{...restored.store.at(20),close:1000,high:1000});m.store.update(20,{...m.store.at(20),close:1000,high:1000});assert.deepEqual(restored.indicators.get('e').outputs.value,m.indicators.get('e').outputs.value);m.dispose();restored.dispose();
});
test('prepared historical correction installs atomically and preserves viewport/drawings/follow',async()=>{
 const m=fixture();m.setVisibleRange(100,200);const view={...m.view};m.drawings.add({type:'text',points:[{time:m.store.at(100).time,price:10}],text:'keep'});const saved=m.drawings.save(),event={kind:'correction',bar:{...m.store.at(0),close:1000,high:1000}},packet=await computeRequest({columns:m.store.columns,length:m.store.length,options:modelRequest(m),event});
 const revision=m.indicators.entries.get('e').revision;installRecomputed(m,packet,event);assert.equal(m.store.at(0).close,1000);assert.deepEqual(m.view,view);assert.equal(m.drawings.save(),saved);buildScene(m,1200,700);assert.equal(m.indicators.entries.get('e').revision,revision);assert.equal(m.indicators.get('e').computedFrom,0);m.dispose();
});
test('cancelled or stale asynchronous results cannot overwrite newer data',async()=>{
 const previous=globalThis.Worker;let finish;
 class FakeWorker {constructor(){this.terminated=false;}postMessage(request){finish=async()=>{const packet=await computeRequest(request);this.onmessage?.({data:{packet}});};}terminate(){this.terminated=true;}}
 globalThis.Worker=FakeWorker;try {const m=fixture(),event={kind:'correction',bar:{...m.store.at(0),close:1000,high:1000}},controller=new AbortController(),pending=recomputeInWorker(m,event,{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.notEqual(m.store.at(0).close,1000);
 const stale=recomputeInWorker(m,event);m.store.update(1,{...m.store.at(1),volume:999});await finish();await assert.rejects(stale,/stale/);assert.notEqual(m.store.at(0).close,1000);m.dispose();}finally{globalThis.Worker=previous;}
});
