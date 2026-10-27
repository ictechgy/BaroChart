import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartAPI,ChartModel,seededColumns} from '../src/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {installRecomputed,modelRequest,validatePreparedPacketAsync} from '../src/web/worker-state.mjs';
import {recomputeInWorker} from '../src/web/worker.mjs';

function fixture(length=16){
 const store=new BarStore();store.setColumns(seededColumns(length));
 const model=new ChartModel({store});model.indicators.add('e','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});model.seriesData(model.series[0]);
 return {model,api:new ChartAPI(model)};
}
function appendEvent(model){
 const source=model.store.length?model.store.at(model.store.length-1):Object.fromEntries(Object.entries(seededColumns(1)).map(([key,value])=>[key,value[0]]));
 return {kind:'append',bar:{...source,time:source.time+(model.store.length?60000:0)}};
}
function prependEvent(model,count=1){
 const source=model.store.at(0),bars=[];for(let i=count;i>0;i--)bars.push({...source,time:source.time-i*60000});return {kind:'prepend',bars};
}
function state(model,api){
 const entry=model.indicators.entries.get('e');
 return {length:model.store.length,version:model.store.version,timeVersion:model.store.timeVersion,view:{...model.view},columns:{...model.store.columns},rows:Object.fromEntries(Object.entries(model.store.columns).map(([key,value])=>[key,Array.from(value.subarray(0,model.store.length))])),entries:model.indicators.entries,entry,arrays:entry.arrays.slice(),outputs:entry.arrays.map(value=>Array.from(value)),series:model.series.slice(),seriesState:model.series.map(value=>({value,index:value.rangeIndex,values:value.values,revision:value.revision,dirtyFrom:value.dirtyFrom})),admission:api.dataIngestionStats()};
}
function unchanged(model,api,before){
 assert.equal(model.store.length,before.length);assert.equal(model.store.version,before.version);assert.equal(model.store.timeVersion,before.timeVersion);assert.deepEqual(model.view,before.view);assert.equal(model.indicators.entries,before.entries);assert.equal(model.indicators.entries.get('e'),before.entry);assert.deepEqual(model.series,before.series);
 for(const [key,value] of Object.entries(before.columns)){assert.equal(model.store.columns[key],value,key+' column reference');assert.deepEqual(Array.from(model.store.columns[key].subarray(0,model.store.length)),before.rows[key],key+' column values');}
 const entry=model.indicators.entries.get('e');for(let i=0;i<before.arrays.length;i++){assert.equal(entry.arrays[i],before.arrays[i]);assert.deepEqual(Array.from(entry.arrays[i]),before.outputs[i]);}
 for(let i=0;i<before.seriesState.length;i++){const expected=before.seriesState[i],actual=model.series[i];assert.equal(actual,expected.value);assert.equal(actual.rangeIndex,expected.index);assert.equal(actual.values,expected.values);assert.equal(actual.revision,expected.revision);assert.equal(actual.dirtyFrom,expected.dirtyFrom);}
 assert.deepEqual(api.dataIngestionStats(),before.admission);
}
async function packetFor(model,event){
 const expected=modelRequest(model),request={columns:model.store.columns,length:model.store.length,options:expected,...(event===undefined?{}:{event})},packet=await computeRequest(request),validation=await validatePreparedPacketAsync(packet,expected,{yieldTask:async()=>{}});return {expected,packet,validation};
}

test('validated worker packets with event-inconsistent row counts fail before any publication',async()=>{
 for(const scenario of [
  {name:'append old 16 plus packet 16',event:model=>appendEvent(model),packetEvent:()=>undefined},
  {name:'prepend one plus packet 16',event:model=>prependEvent(model),packetEvent:()=>undefined},
  {name:'update old 16 plus packet 17',event:model=>({kind:'update',bar:{...model.store.at(model.store.length-1),volume:model.store.at(model.store.length-1).volume+1}}),packetEvent:model=>appendEvent(model)},
  {name:'correction old 16 plus packet 17',event:model=>({kind:'correction',bar:{...model.store.at(0),volume:model.store.at(0).volume+1}}),packetEvent:model=>appendEvent(model)}
 ]){
  const {model,api}=fixture();api.configureDataIngestion({streamId:'integrity',generation:1});
  try{const before=state(model,api),event=scenario.event(model),prepared=await packetFor(model,scenario.packetEvent(model));let notified=0,publishCalls=0;const stop=model.store.subscribe(()=>notified++);
   assert.throws(()=>installRecomputed(model,prepared.packet,event,prepared.expected,prepared.validation,()=>publishCalls++),/count|length/i,scenario.name);stop();assert.equal(publishCalls,0,scenario.name+' beforePublish');assert.equal(notified,0,scenario.name+' notifications');unchanged(model,api,before);
  }finally{model.dispose();}
 }
});

test('validated worker packets with event-inconsistent append or prepend timestamps fail atomically',async()=>{
 for(const scenario of [
  {name:'append timestamp',event:model=>appendEvent(model),packetEvent:(_model,event)=>({kind:'append',bar:{...event.bar,time:event.bar.time+60000}})},
  {name:'every prepend prefix timestamp',event:model=>prependEvent(model,2),packetEvent:(_model,event)=>({kind:'prepend',bars:event.bars.map((bar,index)=>index?{...bar,time:bar.time+30000}:{...bar})})}
 ]){
  const {model,api}=fixture();api.configureDataIngestion({streamId:'integrity',generation:1});
  try{const before=state(model,api),event=scenario.event(model),prepared=await packetFor(model,scenario.packetEvent(model,event));let notified=0,publishCalls=0;const stop=model.store.subscribe(()=>notified++);
   assert.throws(()=>installRecomputed(model,prepared.packet,event,prepared.expected,prepared.validation,()=>publishCalls++),/timestamp|binding/i,scenario.name);stop();assert.equal(publishCalls,0,scenario.name+' beforePublish');assert.equal(notified,0,scenario.name+' notifications');unchanged(model,api,before);
  }finally{model.dispose();}
 }
});

test('timestamp guards reject accessors without executing event getters',async()=>{
 for(const kind of ['append','prepend']){const {model,api}=fixture();api.configureDataIngestion({streamId:'integrity',generation:1});try{const plain=kind==='append'?appendEvent(model):prependEvent(model),prepared=await packetFor(model,plain),before=state(model,api),event=structuredClone(plain),bar=kind==='append'?event.bar:event.bars[0];let reads=0,publishCalls=0;Object.defineProperty(bar,'time',{enumerable:true,configurable:true,get(){reads++;throw new Error('must not execute');}});
  assert.throws(()=>installRecomputed(model,prepared.packet,event,prepared.expected,prepared.validation,()=>publishCalls++),/data property/i);assert.equal(reads,0);assert.equal(publishCalls,0);unchanged(model,api,before);
 }finally{model.dispose();}}
});

test('public recompute rejects a custom worker reply with the wrong append count atomically',async()=>{
 const previous=globalThis.Worker,workers=[];
 class WorkerFixture{constructor(url,options){this.url=url;this.options=options;this.terminated=false;workers.push(this);}postMessage(request){this.request=structuredClone(request);}terminate(){this.terminated=true;}complete(packet){this.onmessage?.({data:{packet}});}}
 globalThis.Worker=WorkerFixture;const {model,api}=fixture();api.configureDataIngestion({streamId:'integrity',generation:1});
 try{const before=state(model,api),event=appendEvent(model);let notified=0;const stop=model.store.subscribe(()=>notified++),pending=recomputeInWorker(model,event,{workerURL:'fixture://wrong-count'}),worker=workers[0];assert.equal(worker.url,'fixture://wrong-count');const request={...worker.request};delete request.event;worker.complete(await computeRequest(request));await assert.rejects(pending,/count|length/i);stop();assert.equal(worker.terminated,true);assert.equal(notified,0);unchanged(model,api,before);
 }finally{model.dispose();globalThis.Worker=previous;}
});

test('public recompute rejects custom worker append and prepend timestamp mismatches atomically',async()=>{
 const previous=globalThis.Worker,workers=[];
 class WorkerFixture{constructor(url,options){this.url=url;this.options=options;this.terminated=false;workers.push(this);}postMessage(request){this.request=structuredClone(request);}terminate(){this.terminated=true;}complete(packet){this.onmessage?.({data:{packet}});}}
 globalThis.Worker=WorkerFixture;
 try{for(const scenario of [
  {name:'append',event:model=>appendEvent(model),packetEvent:event=>({kind:'append',bar:{...event.bar,time:event.bar.time+60000}})},
  {name:'prepend',event:model=>prependEvent(model,2),packetEvent:event=>({kind:'prepend',bars:event.bars.map((bar,index)=>index?{...bar,time:bar.time+30000}:{...bar})})}
 ]){const {model,api}=fixture();api.configureDataIngestion({streamId:'integrity',generation:1});try{const before=state(model,api),event=scenario.event(model);let notified=0;const stop=model.store.subscribe(()=>notified++),pending=recomputeInWorker(model,event,{workerURL:'fixture://wrong-'+scenario.name+'-timestamp'}),worker=workers.at(-1),request={...worker.request,event:scenario.packetEvent(worker.request.event)};worker.complete(await computeRequest(request));await assert.rejects(pending,/timestamp|binding/i);stop();assert.equal(worker.terminated,true);assert.equal(notified,0);unchanged(model,api,before);}finally{model.dispose();}}
 }finally{globalThis.Worker=previous;}
});

test('exact row-count guard preserves valid reset, update, correction, append, prepend and batch publication',async()=>{
 const cases=[
  {name:'append from empty',length:0,event:model=>appendEvent(model),expectedLength:1},
  {name:'reset to any valid length',length:16,event:()=>({kind:'reset',columns:seededColumns(3),length:3}),expectedLength:3},
  {name:'update',length:16,event:model=>({kind:'update',bar:{...model.store.at(15),volume:model.store.at(15).volume+1}}),expectedLength:16},
  {name:'correction',length:16,event:model=>({kind:'correction',bar:{...model.store.at(0),volume:model.store.at(0).volume+1}}),expectedLength:16,notificationKind:'update'},
  {name:'append',length:16,event:model=>appendEvent(model),expectedLength:17},
  {name:'prepend',length:16,event:model=>prependEvent(model,2),expectedLength:18,added:2},
  {name:'batch',length:16,event:model=>({kind:'batch',events:[{kind:'update',bar:{...model.store.at(15),volume:model.store.at(15).volume+1}},appendEvent(model)]}),expectedLength:17,appended:1}
 ];
 for(const scenario of cases){const {model}=fixture(scenario.length);try{const event=scenario.event(model),prepared=await packetFor(model,event),changes=[];model.store.subscribe(change=>changes.push(change));let publishCalls=0;installRecomputed(model,prepared.packet,event,prepared.expected,prepared.validation,()=>publishCalls++);assert.equal(publishCalls,1,scenario.name);assert.equal(model.store.length,scenario.expectedLength,scenario.name);assert.equal(changes.length,1,scenario.name);assert.equal(changes[0].kind,scenario.notificationKind??event.kind,scenario.name);if(scenario.added!==undefined)assert.equal(changes[0].added,scenario.added);if(scenario.appended!==undefined)assert.equal(changes[0].appended,scenario.appended);}finally{model.dispose();}}
});
