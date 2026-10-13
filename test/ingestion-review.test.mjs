import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI} from '../src/core/index.mjs';
import {AsyncCapture} from '../src/core/async-state.mjs';
import {PrepareCapture} from '../src/core/prepare-state.mjs';
const bar=(time,close=10)=>({time,open:close,high:close,low:close,close,volume:1});
const fixture=()=>{const model=new ChartModel({store:new BarStore([bar(1)])});return {model,api:new ChartAPI(model)};};
test('reflection cannot truncate an originally two-event packet into a successful prefix',()=>{
 for(const mode of ['batch','enqueue']){const {model,api}=fixture();try{if(mode==='enqueue')api.configureDataIngestion({streamId:'A',generation:1});const events=[{kind:'update',bar:bar(1,20)},{kind:'append',bar:bar(2)}];events[0]=new Proxy(events[0],{ownKeys(target){events.length=1;return Reflect.ownKeys(target);}});const version=model.store.version;assert.throws(()=>mode==='batch'?api.applyDataEvents(events):api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events}));assert.equal(model.store.version,version);assert.equal(model.store.at(0).close,10);if(mode==='enqueue'){assert.equal(api.dataIngestionStats().accepted,0);assert.equal(api.dataIngestionStats().nextSequence,0);}}finally{model.dispose();}}
});
test('readonly stats and save reflect pending source replacement as paused without changing counters',()=>{
 const {model,api}=fixture();try{api.configureDataIngestion({streamId:'A',generation:1});api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events:[{kind:'update',bar:bar(1,20)}]});api.setData([bar(1,30)]);const stats=api.dataIngestionStats();assert.equal(stats.state,'paused');assert.equal(stats.lastError.code,'SOURCE_CHANGED');const doc=JSON.parse(api.saveDataIngestion());assert.equal(doc.state,'paused');assert.equal(doc.lastError.code,'SOURCE_CHANGED');assert.equal(stats.accepted,1);assert.equal(stats.applied,0);assert.equal(stats.pendingEvents,1);api.resumeDataIngestion();api.drainDataEvents();assert.equal(model.store.at(0).close,20);}finally{model.dispose();}
});
test('restoration rejects impossible last cursors and zero historical peak atomically',()=>{
 const a=fixture(),b=fixture();try{a.api.configureDataIngestion({streamId:'A',generation:1});a.api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events:[{kind:'update',bar:bar(1,20)}]});a.api.drainDataEvents();a.api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:1,events:[{kind:'update',bar:bar(1,30)}]});b.api.configureDataIngestion({streamId:'B',generation:0});const before=b.api.saveDataIngestion(),doc=JSON.parse(a.api.saveDataIngestion());for(const patch of [{lastAppliedSequence:1},{lastAppliedSequence:null},{peakPendingEvents:0,peakPendingBytes:0}]){const bad={...doc,counters:{...doc.counters,...patch}};assert.throws(()=>b.api.loadDataIngestion(JSON.stringify(bad)));assert.equal(b.api.saveDataIngestion(),before);}}finally{a.model.dispose();b.model.dispose();}
});
test('unconfigured model captures fence configure and load until their terminal release',()=>{
 for(const kind of ['async','prepare']){const {model,api}=fixture(),backup=fixture();try{backup.api.configureDataIngestion({streamId:'B',generation:1});const capture=kind==='async'?new AsyncCapture(model,{kind:'update',bar:bar(1)}):new PrepareCapture(model,{kind:'seeded',count:16});assert.throws(()=>api.configureDataIngestion({streamId:'A',generation:1}),e=>e.code==='BUSY');assert.throws(()=>api.loadDataIngestion(backup.api.saveDataIngestion()),e=>e.code==='BUSY');capture.release();api.configureDataIngestion({streamId:'A',generation:1});assert.equal(api.dataIngestionStats().state,'running');}finally{model.dispose();backup.model.dispose();}}
});
