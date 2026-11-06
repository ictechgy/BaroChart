import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,IngestionError} from '../src/core/index.mjs';
const bar=(time,close=10,volume=1)=>({time,open:close,high:close,low:close,close,volume});
const fixture=()=>{const model=new ChartModel({store:new BarStore([bar(1)])});return {model,api:new ChartAPI(model)};};
test('owned ingestion preserves ordered packet accounting through commit and observer enqueue',()=>{
 const {model,api}=fixture();try{
  assert.equal(typeof api.configureDataIngestion,'function');
  api.configureDataIngestion({streamId:'A',generation:2,maxBatchEvents:2,maxQueuedEvents:3});
  const p={streamId:'A',generation:2,firstSequence:0,events:[{kind:'update',bar:bar(1,11)},{kind:'append',bar:bar(2,12)}]};
  api.enqueueDataEvents(p);p.events[1].bar.close=999;
  const stop=model.store.subscribe(()=>{const s=api.dataIngestionStats();assert.equal(s.applied,2);assert.equal(s.pendingEvents,0);api.enqueueDataEvents({streamId:'A',generation:2,firstSequence:2,events:[{kind:'update',bar:bar(2,13)}]});});
  assert.equal(api.drainDataEvents().events,2);stop();
  assert.equal(model.store.at(1).close,12);assert.equal(api.dataIngestionStats().pendingEvents,1);
  assert.equal(api.cancelDataEvents().events,1);
  const s=api.dataIngestionStats();assert.equal(s.accepted,s.applied+s.cancelled+s.pendingEvents);assert.equal(s.nextSequence,3);
 }finally{model.dispose();}
});
test('rejection and failed drain retain ownership without silently losing history',()=>{
 const {model,api}=fixture();try{
  api.configureDataIngestion({streamId:'A',generation:0,maxStoredBars:1});
  api.enqueueDataEvents({streamId:'A',generation:0,firstSequence:0,events:[{kind:'append',bar:bar(2)}]});
  assert.throws(()=>api.drainDataEvents(),e=>e.name==='IngestionError'&&e.code==='DRAIN_FAILED');
  assert.equal(model.store.length,1);assert.equal(api.dataIngestionStats().pendingEvents,1);assert.equal(api.dataIngestionStats().state,'paused');
  assert.throws(()=>api.enqueueDataEvents({streamId:'A',generation:0,firstSequence:1,events:[{kind:'update',bar:bar(1)}]}),e=>e.code==='PAUSED');
  api.cancelDataEvents();api.resumeDataIngestion();
  assert.throws(()=>api.enqueueDataEvents({streamId:'B',generation:0,firstSequence:1,events:[{kind:'update',bar:bar(1)}]}),e=>e.code==='STREAM_MISMATCH');
  assert.equal(api.dataIngestionStats().nextSequence,1);
 }finally{model.dispose();}
});
test('hostile packet failures stay bounded ingestion errors and do not poison the session',()=>{
 const {model,api}=fixture();try{
  api.configureDataIngestion({streamId:'A',generation:0});
  const hostileMessage=new Error('untrusted');Object.defineProperty(hostileMessage,'message',{configurable:true,get(){throw undefined;}});
  const failures=[
   {thrown:null,message:'Invalid ingestion input'},
   {thrown:undefined,message:'Invalid ingestion input'},
   {thrown:'bad packet',message:'bad packet'},
   {thrown:hostileMessage,message:'Invalid ingestion input'},
  ];
  for(const [index,{thrown,message}] of failures.entries()){
   const packet=new Proxy({}, {ownKeys(){throw thrown;}});let observed;
   assert.throws(()=>api.enqueueDataEvents(packet),error=>{observed=error;return error instanceof IngestionError&&error.code==='INVALID_INPUT';});
   assert.equal(observed.message,message);assert.equal(observed.cause,thrown);
   const rejected=api.dataIngestionStats();assert.equal(rejected.rejectedPackets,index+1);assert.equal(rejected.rejectedEvents,0);assert.equal(rejected.accepted,index);
   api.enqueueDataEvents({streamId:'A',generation:0,firstSequence:index,events:[{kind:'update',bar:bar(1,20+index)}]});
  }
  const original=new IngestionError('SOURCE_CHANGED','owned error');const packet=new Proxy({}, {ownKeys(){throw original;}});
  assert.throws(()=>api.enqueueDataEvents(packet),error=>error===original);
  const afterOriginal=api.dataIngestionStats();assert.equal(afterOriginal.rejectedPackets,5);assert.equal(afterOriginal.rejectedEvents,0);assert.equal(afterOriginal.accepted,4);assert.equal(afterOriginal.pendingEvents,4);
  api.enqueueDataEvents({streamId:'A',generation:0,firstSequence:4,events:[{kind:'update',bar:bar(1,99)}]});
  assert.equal(api.dataIngestionStats().accepted,5);assert.equal(api.drainDataEvents().events,5);assert.equal(model.store.at(0).close,99);
 }finally{model.dispose();}
});
test('ingestion document restores owned pending values and strict cursor atomically',()=>{
 const a=fixture(),b=fixture();try{
  a.api.configureDataIngestion({streamId:'A',generation:1});a.api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events:[{kind:'update',bar:bar(1,-0)}]});
  const doc=a.api.saveDataIngestion();b.api.loadDataIngestion(doc);assert.equal(b.api.saveDataIngestion(),doc);
  assert.equal(b.api.drainDataEvents().events,1);assert(Object.is(b.model.store.at(0).close,-0));
  const before=b.api.saveDataIngestion();assert.throws(()=>b.api.loadDataIngestion(doc.replace('"version":1','"version":2')));assert.equal(b.api.saveDataIngestion(),before);
 }finally{a.model.dispose();b.model.dispose();}
});
test('retained retired session releases its ring and records explicit teardown cancellation once',()=>{
 const {model,api}=fixture();api.configureDataIngestion({streamId:'A',generation:1});api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events:[{kind:'update',bar:bar(1)}]});const session=model.dataIngestion;model.dispose();model.dispose();assert.equal(session.count,0);assert.equal(session.kinds,null);assert.deepEqual(session.columns,{});assert.equal(session.model,null);assert.equal(session.counters.cancelled,1);assert.equal(session.counters.lastCancelledSequence,0);assert.equal(session.firstPendingSequence,1);
});
