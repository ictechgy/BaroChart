import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/index.mjs';
import {safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';
import {recomputeInWorker} from '../src/web/worker.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';

const T=Date.UTC(2026,2,9,9,30),fields=['time','open','high','low','close','volume'];
const bar=(index,close=20+index*.125+Math.sin(index*.3),volume=3+index%5)=>({time:T+index*60000,open:close-.25,high:close+2,low:close-2,close,volume});
function fixture(t,count=3,scale=1) {
 const model=new A.ChartModel();let invalidations=0;
 const api=new A.ChartAPI(model,{invalidate:()=>invalidations++}),input=Array.from({length:count},(_,i)=>{const b=bar(i);for(const field of ['open','high','low','close'])b[field]*=scale;return b;});
 t.after(()=>model.dispose());api.setData(input);return {model,api,input,invalidations:()=>invalidations};
}
function required(api) {
 for(const name of ['applyDataEvents','configureDataIngestion','enqueueDataEvents','drainDataEvents','dataIngestionStats','cancelDataEvents','pauseDataIngestion','resumeDataIngestion','saveDataIngestion','loadDataIngestion'])assert.equal(typeof api[name],'function','public '+name+' contract required');
}
function configure(f,patch={}) {required(f.api);return f.api.configureDataIngestion({streamId:'feed-A',generation:7,firstSequence:100,maxQueuedEvents:8,maxQueuedBytes:392,maxBatchEvents:2,...patch});}
const packet=(events,firstSequence=100,patch={})=>({streamId:'feed-A',generation:7,firstSequence,events,...patch});
const ingestionError=code=>error=>error.name==='IngestionError'&&error.code===code;
function columns(model) {return Object.fromEntries(fields.map(field=>[field,Float64Array.from(model.store.columns[field].subarray(0,model.store.length))]));}
function sameColumns(model,expected) {assert.equal(model.store.length,expected.time.length);for(const field of fields)assert.deepEqual(model.store.columns[field].subarray(0,model.store.length),expected[field],'complete F64 '+field);}
function ledger(api) {
 const stats=api.dataIngestionStats();assert.equal(stats.accepted,stats.applied+stats.cancelled+stats.pendingEvents,'accepted payload conservation');
 assert.equal(stats.pendingBytes,stats.pendingEvents*49,'logical F64+kind bytes');assert.equal(stats.nextSequence,stats.policy.firstSequence+stats.accepted,'accepted sequence conservation');return stats;
}
function scalarRows(input,events) {
 const rows=input.map(b=>({...b}));for(const event of events){if(event.kind==='append')rows.push({...event.bar});else {const index=rows.findIndex(b=>b.time===event.bar.time);assert.ok(index>=0);rows[index]={...event.bar};}}return rows;
}
function independent(rows) {
 const sma=rows.map((_,i)=>i<4?null:rows.slice(i-4,i+1).reduce((n,b)=>n+b.close,0)/5);
 let previous=NaN,obv=0,ema=NaN;const e=[],o=[];
 for(let i=0;i<rows.length;i++) {if(i===2)ema=(rows[0].close+rows[1].close+rows[2].close)/3;else if(i>2)ema+=(rows[i].close-ema)*.5;e.push(i<2?null:ema);if(i)obv+=Math.sign(rows[i].close-previous)*rows[i].volume;o.push(obv);previous=rows[i].close;}
 const v={value:[],upper:[],lower:[],deviation:[],volume:[]};
 for(let i=0;i<rows.length;i++) {
  const prefix=rows.slice(0,i+1),volume=prefix.reduce((n,b)=>n+b.volume,0),mean=prefix.reduce((n,b)=>n+b.close*b.volume,0)/volume;
  const variance=prefix.reduce((n,b)=>n+b.volume*(b.close-mean)**2,0)/volume,sigma=Math.sqrt(variance);
  v.value.push(mean);v.upper.push(mean+2*sigma);v.lower.push(mean-2*sigma);v.deviation.push(sigma);v.volume.push(volume);
 }
 return {sma:{value:sma},ema:{value:e},obv:{value:o},vwap:v};
}
function indicators(api) {api.addIndicator('sma','sma',{period:5});api.addIndicator('ema','ema',{period:3});api.addIndicator('obv','obv');api.addIndicator('vwap','vwap',{anchorTime:T,source:'close',deviation:2});}
function vectors(api,expected) {
 for(const [id,outputs] of Object.entries(expected))for(const [output,values] of Object.entries(outputs)) {
  const actual=api.indicatorValues(id,output);assert.equal(actual.length,values.length,id+'/'+output+' full vector');
  for(let i=0;i<values.length;i++)if(values[i]===null)assert.equal(actual[i],null,id+'/'+output+' warmup'+i);else {
   assert.notEqual(actual[i],null,id+'/'+output+' finite'+i);
   const tolerance=Math.max(1e-300,Math.abs(values[i]))*2e-10;
   assert.ok(Math.abs(actual[i]-values[i])<=tolerance,`${id}/${output}[${i}] independent oracle: ${actual[i]} vs ${values[i]}`);
  }
 }
}
function snapshot(f) {return {columns:columns(f.model),store:f.model.store,index:f.model.store.index,version:f.model.store.version,timeVersion:f.model.store.timeVersion,capacity:f.model.store.capacity,view:{...f.model.view},drawings:f.api.saveDrawings(),invalidations:f.invalidations()};}
function unchanged(f,before) {sameColumns(f.model,before.columns);assert.equal(f.model.store,before.store);assert.equal(f.model.store.index,before.index);assert.equal(f.model.store.version,before.version);assert.equal(f.model.store.timeVersion,before.timeVersion);assert.equal(f.model.store.capacity,before.capacity);assert.deepEqual(f.model.view,before.view);assert.equal(f.api.saveDrawings(),before.drawings);assert.equal(f.invalidations(),before.invalidations);}

test('mixed ordered batch matches all scalar F64 columns and independent vectors across checkpoints',t=>{
 for(const scale of [1,1e-12]) {
  const f=fixture(t,720,scale),scalar=fixture(t,720,scale);required(f.api);indicators(f.api);indicators(scalar.api);
  const events=[{kind:'correction',bar:bar(253,41*scale)},{kind:'correction',bar:bar(257,12*scale)},{kind:'correction',bar:bar(511,37*scale)},{kind:'update',bar:bar(719,28*scale)},{kind:'append',bar:bar(720,30*scale)},{kind:'update',bar:bar(720,29*scale)},{kind:'append',bar:bar(721,33*scale)}];
  const version=f.model.store.version,timeVersion=f.model.store.timeVersion,notifications=[];
  f.model.store.subscribe(change=>notifications.push(change));const invalidations=f.invalidations();
  const receipt=f.api.applyDataEvents(events);events.forEach(event=>scalar.api.applyDataEvent(event));
  assert.deepEqual(receipt,{events:7,appended:2,from:253,to:722,version:version+1,length:722,capacity:f.model.store.capacity,bytes:96*f.model.store.capacity});
  assert.equal(f.model.store.timeVersion,timeVersion+1);assert.equal(notifications.length,1);assert.equal(notifications[0].kind,'batch');assert.equal(notifications[0].appended,2);assert.equal(notifications[0].to,722);assert.equal(f.invalidations(),invalidations+1);
  sameColumns(f.model,columns(scalar.model));const expected=independent(scalarRows(f.input,events));vectors(f.api,expected);vectors(scalar.api,expected);
 }
});

test('batch follows the final tail once and preserves drawing anchors, undo and redo history',t=>{
 for(const follow of [false,true]) {
  const f=fixture(t,32);required(f.api);if(follow)f.api.fit();else f.api.setVisibleRange(2,15);
  const id=f.api.addDrawing({type:'trendline',points:[{time:T+4*60000,price:23},{time:T+10*60000,price:29}],text:'before'}),original=f.api.saveDrawings();f.api.editDrawing(id,{text:'after'});const saved=f.api.saveDrawings(),view={...f.model.view};
  const version=f.model.store.version,timeVersion=f.model.store.timeVersion;
  f.api.applyDataEvent({kind:'batch',events:[{kind:'correction',bar:bar(4,35)},{kind:'append',bar:bar(32)},{kind:'append',bar:bar(33)}]});
  assert.equal(f.model.store.version,version+1);assert.equal(f.model.store.timeVersion,timeVersion+1);assert.equal(f.api.saveDrawings(),saved);
  if(follow){assert.equal(f.model.view.to,33.5);assert.equal(f.model.view.to-f.model.view.from,view.to-view.from);}else assert.deepEqual(f.model.view,view);
  f.api.undo();assert.equal(f.api.saveDrawings(),original);f.api.redo();assert.equal(f.api.saveDrawings(),saved);
 }
});

test('non-appending batch leaves the time version and invalid input leaves the entire source unchanged',t=>{
 const f=fixture(t,16);required(f.api);const timeVersion=f.model.store.timeVersion;
 f.api.applyDataEvents([{kind:'correction',bar:bar(0,12)},{kind:'update',bar:bar(15,24)}]);assert.equal(f.model.store.timeVersion,timeVersion);
 for(const events of [[{kind:'append',bar:bar(16)},{kind:'append',bar:bar(16)}],[{kind:'update',bar:bar(1)}],[{kind:'correction',bar:bar(50)}],[{kind:'reset',bar:bar(0)}],[]]) {
  const before=snapshot(f);assert.throws(()=>f.api.applyDataEvents(events));unchanged(f,before);
 }
});

test('intermediate volume overflow rejects the ordered transaction even if its final sum would be finite',t=>{
 const f=fixture(t,0);required(f.api);f.api.setData([bar(0,10,8e307),bar(1,11,8e307)]);const before=snapshot(f),changes=[];f.model.store.subscribe(c=>changes.push(c));
 assert.throws(()=>f.api.applyDataEvents([{kind:'correction',bar:bar(0,10,1e308)},{kind:'correction',bar:bar(1,11,1e307)}]),/volume|overflow|finite/i);
 unchanged(f,before);assert.equal(changes.length,0);
});

test('batch admission rejects row and actual capacity-byte growth budgets without partial allocation',t=>{
 const f=fixture(t,16);required(f.api);assert.equal(typeof f.model.store.applyEvents,'function');const before=snapshot(f);
 assert.throws(()=>f.model.store.applyEvents([{kind:'append',bar:bar(16)}],{maxBars:16}));unchanged(f,before);
 assert.throws(()=>f.model.store.applyEvents([{kind:'append',bar:bar(16)}],{maxStoreBytes:96*f.model.store.capacity}));unchanged(f,before);
 const receipt=f.model.store.applyEvents([{kind:'append',bar:bar(16)}],{maxBars:17,maxStoreBytes:96*f.model.store.capacity*2});assert.equal(receipt.length,17);assert.equal(receipt.capacity,32);assert.equal(receipt.bytes,3072);
});

test('batch rejects accessors without invoking them and reflection reentry preserves the newer host source',t=>{
 const f=fixture(t,3);required(f.api);let reads=0;const accessor=Object.defineProperty(bar(3),'close',{enumerable:true,get(){reads++;return 23;}}),before=snapshot(f);
 assert.throws(()=>f.api.applyDataEvents([{kind:'append',bar:accessor}]));assert.equal(reads,0);unchanged(f,before);
 let invoked=false;const proxy=new Proxy(bar(3),{ownKeys(target){if(!invoked){invoked=true;f.api.applyDataEvent({kind:'append',bar:bar(3,55)});}return Reflect.ownKeys(target);}});
 assert.throws(()=>f.api.applyDataEvents([{kind:'append',bar:proxy}]),ingestionError('SOURCE_CHANGED'));assert.equal(invoked,true);assert.equal(f.model.store.length,4);assert.equal(f.model.store.at(3).close,55);
});

test('lazy trusted indicator errors after a valid batch do not retroactively roll back data',t=>{
 const f=fixture(t,3);required(f.api);f.api.registerIndicator('lazy-error',()=>({outputs:['value'],create(){return {step:b=>{if(b.close===99)throw Error('trusted lazy calculation');return [b.close];},snapshot:()=>0,restore(){}};}}));f.api.addIndicator('lazy','lazy-error');
 const version=f.model.store.version;assert.equal(f.api.applyDataEvents([{kind:'append',bar:bar(3,99)}]).length,4);
 assert.throws(()=>f.api.indicatorValues('lazy','value'),/trusted lazy calculation/);assert.equal(f.model.store.length,4);assert.equal(f.model.store.at(3).close,99);assert.equal(f.model.store.version,version+1);
});

test('owned queued packets drain exact prefixes, reject sequence/stream/budget errors and conserve cancellation',t=>{
 const f=fixture(t),stats=configure(f,{maxQueuedEvents:4,maxQueuedBytes:196});assert.equal(stats.state,'running');assert.equal(stats.ownedBytes,196);
 const events=[{kind:'append',bar:bar(3,30)},{kind:'append',bar:bar(4,31)},{kind:'update',bar:bar(4,32)}];
 assert.deepEqual(f.api.enqueueDataEvents(packet(events)),{events:3,firstSequence:100,nextSequence:103,pendingEvents:3,pendingBytes:147});events[0].bar.close=900;events[0].bar.high=901;
 for(const [input,code] of [[packet([{kind:'append',bar:bar(5)}],100),'SEQUENCE_MISMATCH'],[packet([{kind:'append',bar:bar(5)}],104),'SEQUENCE_MISMATCH'],[packet([{kind:'append',bar:bar(5)}],103,{streamId:'feed-B'}),'STREAM_MISMATCH'],[packet([{kind:'append',bar:bar(5)}],103,{generation:8}),'STREAM_MISMATCH'],[packet([{kind:'append',bar:bar(5)},{kind:'append',bar:bar(6)}],103),'QUEUE_BUDGET']])assert.throws(()=>f.api.enqueueDataEvents(input),ingestionError(code));
 let s=ledger(f.api);assert.equal(s.accepted,3);assert.equal(s.nextSequence,103);assert.equal(s.pendingEvents,3);assert.equal(s.rejectedPackets,5);
 const first=f.api.drainDataEvents();assert.equal(first.events,2);assert.equal(first.firstSequence,100);assert.equal(first.lastSequence,101);assert.equal(f.model.store.at(3).close,30);assert.equal(f.model.store.at(4).close,31);
 s=ledger(f.api);assert.equal(s.applied,2);assert.equal(s.pendingEvents,1);assert.equal(s.lastAppliedSequence,101);
 assert.deepEqual(f.api.cancelDataEvents(),{events:1,firstSequence:102,lastSequence:102});s=ledger(f.api);assert.equal(s.cancelled,1);assert.equal(s.nextSequence,103);assert.deepEqual(f.api.cancelDataEvents(),{events:0,firstSequence:null,lastSequence:null});
});

test('same-generation independent symbol models route only their explicit producer and keep distinct full histories',t=>{
 const left=fixture(t,720,1e-12),right=fixture(t,720,10);required(left.api);required(right.api);indicators(left.api);indicators(right.api);
 left.api.setSymbol({id:'TINY',exchange:'SYNTH',timezone:'UTC',currency:'USD',priceDecimals:15,tickSize:1e-15,volumeUnit:'units',adjustment:'raw'});
 right.api.setSymbol({id:'OTHER',exchange:'SYNTH',timezone:'UTC',currency:'USD',priceDecimals:4,tickSize:.0001,volumeUnit:'units',adjustment:'raw'});
 configure(left,{streamId:'tiny',generation:7,maxBatchEvents:8});configure(right,{streamId:'other',generation:7,maxBatchEvents:8});
 const le=[{kind:'correction',bar:bar(257,30e-12)},{kind:'append',bar:bar(720,40e-12)}],re=[{kind:'correction',bar:bar(511,300)},{kind:'append',bar:bar(720,400)}];
 assert.throws(()=>left.api.enqueueDataEvents(packet(re,100,{streamId:'other'})),ingestionError('STREAM_MISMATCH'));
 left.api.enqueueDataEvents(packet(le,100,{streamId:'tiny'}));right.api.enqueueDataEvents(packet(re,100,{streamId:'other'}));left.api.drainDataEvents();right.api.drainDataEvents();
 for(const [f,events] of [[left,le],[right,re]]){const rows=scalarRows(f.input,events);sameColumns(f.model,Object.fromEntries(fields.map(k=>[k,Float64Array.from(rows,b=>b[k])])));vectors(f.api,independent(rows));assert.equal(ledger(f.api).applied,2);}
 assert.equal(left.api.inspect().symbol.id,'TINY');assert.equal(right.api.inspect().symbol.id,'OTHER');assert.notEqual(left.model.store.at(720).close,right.model.store.at(720).close);
});

test('source mutation while pending pauses, preserves payload and requires explicit resume before revalidation',t=>{
 const f=fixture(t);configure(f);f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3,35)}]));f.api.applyDataEvent({kind:'update',bar:bar(2,42)});
 assert.throws(()=>f.api.drainDataEvents(),ingestionError('SOURCE_CHANGED'));let s=ledger(f.api);assert.equal(s.state,'paused');assert.equal(s.lastError.code,'SOURCE_CHANGED');assert.equal(s.pendingEvents,1);assert.equal(s.applied,0);
 assert.throws(()=>f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(4)}],101)),ingestionError('PAUSED'));assert.equal(f.api.resumeDataIngestion().state,'running');assert.equal(f.api.drainDataEvents().events,1);assert.equal(f.model.store.at(2).close,42);assert.equal(f.model.store.at(3).close,35);assert.equal(ledger(f.api).pendingEvents,0);
});

test('failed drain preserves its complete prefix, source and cursor until explicit cancellation',t=>{
 const f=fixture(t,0);required(f.api);f.api.setData([bar(0,10,8e307),bar(1,11,8e307)]);configure(f);const before=snapshot(f);
 f.api.enqueueDataEvents(packet([{kind:'correction',bar:bar(0,10,1e308)},{kind:'correction',bar:bar(1,11,1e307)}]));
 assert.throws(()=>f.api.drainDataEvents(),ingestionError('DRAIN_FAILED'));unchanged(f,before);const s=ledger(f.api);assert.equal(s.state,'paused');assert.equal(s.lastError.code,'DRAIN_FAILED');assert.equal(s.failedDrains,1);assert.equal(s.pendingEvents,2);assert.equal(s.nextSequence,102);
 assert.deepEqual(f.api.cancelDataEvents(),{events:2,firstSequence:100,lastSequence:101});assert.equal(ledger(f.api).cancelled,2);
});

test('queue drain cannot exceed stored-row or actual capacity-byte budgets; legacy direct admission stays independent',t=>{
 for(const policy of [{maxStoredBars:16},{maxStoreBytes:1536}]) {
  const f=fixture(t,16);configure(f,policy);const before=snapshot(f);f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(16)}]));assert.throws(()=>f.api.drainDataEvents(),ingestionError('DRAIN_FAILED'));unchanged(f,before);assert.equal(ledger(f.api).pendingEvents,1);f.api.cancelDataEvents();
  f.api.applyDataEvent({kind:'append',bar:bar(16)});assert.equal(f.model.store.length,17,'legacy API uses its own existing store policy');
 }
});

test('configured admission budgets also govern explicit public batches while legacy append stays independent',t=>{
 for(const policy of [{maxStoredBars:16},{maxStoreBytes:1536}]) {
  const f=fixture(t,16);configure(f,policy);const before=snapshot(f);
  assert.throws(()=>f.api.applyDataEvents([{kind:'append',bar:bar(16)}]),undefined,'explicit batch must honor configured admission');unchanged(f,before);
  f.api.applyDataEvent({kind:'append',bar:bar(16)});assert.equal(f.model.store.length,17);
 }
});

test('length-changing external alignment rejects both batch and queued drain while same-length correction remains valid',t=>{
 const f=fixture(t);required(f.api);f.api.addSeries({id:'external',type:'line',panel:'price',values:[1,2,3]});configure(f);const before=snapshot(f);
 assert.throws(()=>f.api.applyDataEvents([{kind:'append',bar:bar(3)}]),ingestionError('EXTERNAL_ALIGNMENT'));unchanged(f,before);
 f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}]));assert.throws(()=>f.api.drainDataEvents(),ingestionError('DRAIN_FAILED'));unchanged(f,before);assert.equal(ledger(f.api).pendingEvents,1);f.api.cancelDataEvents();f.api.resumeDataIngestion();
 assert.equal(f.api.applyDataEvents([{kind:'correction',bar:bar(0,35)}]).events,1);assert.deepEqual(Array.from(f.model.series[0].values),[1,2,3]);
});

test('safe-integer sequence exhaustion rejects whole packets without advancing accepted sequence',t=>{
 const f=fixture(t);configure(f,{firstSequence:Number.MAX_SAFE_INTEGER-1,maxBatchEvents:1});
 f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}],Number.MAX_SAFE_INTEGER-1));assert.throws(()=>f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(4)}],Number.MAX_SAFE_INTEGER)),ingestionError('SEQUENCE_LIMIT'));
 const s=ledger(f.api);assert.equal(s.accepted,1);assert.equal(s.pendingEvents,1);assert.equal(s.nextSequence,Number.MAX_SAFE_INTEGER);assert.equal(f.api.drainDataEvents().lastSequence,Number.MAX_SAFE_INTEGER-1);
});

test('Proxy reconfiguration and cancellation preserve callback-owned session changes and reject the stale operation',t=>{
 const f=fixture(t);required(f.api);let changed=false;
 const policy=new Proxy({streamId:'outer',generation:1},{ownKeys(target){if(!changed){changed=true;f.api.configureDataIngestion({streamId:'callback',generation:9,firstSequence:700});}return Reflect.ownKeys(target);}});
 assert.throws(()=>f.api.configureDataIngestion(policy),ingestionError('SOURCE_CHANGED'));assert.equal(ledger(f.api).policy.streamId,'callback');assert.equal(ledger(f.api).nextSequence,700);
 f.api.configureDataIngestion({streamId:'feed-A',generation:7,firstSequence:100});f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}]));let cancelled=false;
 const input=new Proxy(packet([{kind:'append',bar:bar(4)}],101),{ownKeys(target){if(!cancelled){cancelled=true;f.api.cancelDataEvents();}return Reflect.ownKeys(target);}});
 assert.throws(()=>f.api.enqueueDataEvents(input),ingestionError('SOURCE_CHANGED'));const s=ledger(f.api);assert.equal(s.accepted,1);assert.equal(s.cancelled,1);assert.equal(s.pendingEvents,0);assert.equal(s.nextSequence,101);
});

for(const action of ['enqueue','cancel','pause'])test(`store observer ${action} sees applied prefix removed and preserves the conserved ledger`,t=>{
 const f=fixture(t);configure(f);f.api.enqueueDataEvents(packet([3,4,5].map(i=>({kind:'append',bar:bar(i)}))));let observed=false;
 const stop=f.model.store.subscribe(()=>{if(observed)return;observed=true;const inside=ledger(f.api);assert.equal(inside.applied,2);assert.equal(inside.pendingEvents,1);assert.equal(inside.state,'busy');assert.throws(()=>f.api.drainDataEvents(),ingestionError('BUSY'));
  if(action==='enqueue')f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(6)}],103));if(action==='cancel')assert.deepEqual(f.api.cancelDataEvents(),{events:1,firstSequence:102,lastSequence:102});if(action==='pause')f.api.pauseDataIngestion();ledger(f.api);
 });
 try {assert.equal(f.api.drainDataEvents().events,2);assert.equal(observed,true);assert.deepEqual(f.model.store.listenerErrors,[],'observer assertions must not be hidden by listener isolation');const after=ledger(f.api);if(action==='enqueue'){assert.equal(after.accepted,4);assert.equal(after.pendingEvents,2);}if(action==='cancel'){assert.equal(after.cancelled,1);assert.equal(after.pendingEvents,0);}if(action==='pause'){assert.equal(after.state,'paused');assert.equal(after.pendingEvents,1);}}finally {stop();}
});

test('ingestion getter rejection executes no accessor and Proxy reflection reentry cannot accept stale payload',t=>{
 const f=fixture(t);configure(f);let reads=0;const input=Object.defineProperty(bar(3),'close',{enumerable:true,get(){reads++;return 35;}}),before=snapshot(f);
 assert.throws(()=>f.api.enqueueDataEvents(packet([{kind:'append',bar:input}])),ingestionError('INVALID_INPUT'));assert.equal(reads,0);unchanged(f,before);assert.equal(ledger(f.api).accepted,0);
 let reentered=false;const proxy=new Proxy(packet([{kind:'append',bar:bar(3)}]),{ownKeys(target){if(!reentered){reentered=true;f.api.applyDataEvent({kind:'append',bar:bar(3,77)});}return Reflect.ownKeys(target);}});
 assert.throws(()=>f.api.enqueueDataEvents(proxy),ingestionError('SOURCE_CHANGED'));assert.equal(f.model.store.length,4);assert.equal(f.model.store.at(3).close,77);const s=ledger(f.api);assert.equal(s.accepted,0);assert.equal(s.nextSequence,100);assert.equal(s.pendingEvents,0);
});

test('ingestion save/load preserves negative-zero pending F64 values, policy, counters and cursors without saving base data',t=>{
 const f=fixture(t),receiver=fixture(t);configure(f);const zero={time:T+3*60000,open:-0,high:1,low:-1,close:-0,volume:-0};
 f.api.enqueueDataEvents(packet([{kind:'append',bar:zero},{kind:'update',bar:{...zero,close:0,open:0}}]));f.api.pauseDataIngestion();const before=ledger(f.api),saved=f.api.saveDataIngestion(),doc=safeCheckpointParse(saved);
 assert.equal(doc.schema,'aster.ingestion');assert.equal(doc.version,1);assert.equal(Object.hasOwn(doc,'columns'),false);assert.ok(Object.is(doc.pending.events[0].bar.close,-0));assert.ok(Object.is(doc.pending.events[0].bar.volume,-0));
 const restored=receiver.api.loadDataIngestion(saved);assert.deepEqual(restored,before);assert.equal(receiver.api.saveDataIngestion(),saved);assert.equal(receiver.model.store.length,3);
 receiver.api.resumeDataIngestion();assert.equal(receiver.api.drainDataEvents(1).events,1);for(const key of ['open','close','volume'])assert.ok(Object.is(receiver.model.store.columns[key][3],-0),'pending '+key+' retains negative zero');
 assert.equal(receiver.api.drainDataEvents(1).events,1);assert.ok(Object.is(receiver.model.store.columns.close[3],0));assert.ok(Object.is(receiver.model.store.columns.volume[3],-0));assert.equal(ledger(receiver.api).lastAppliedSequence,101);
 const snapshot=receiver.api.saveDataIngestion(),bad=safeCheckpointParse(snapshot);bad.nextSequence++;
 assert.throws(()=>receiver.api.loadDataIngestion(JSON.stringify(bad)));assert.equal(receiver.api.saveDataIngestion(),snapshot,'invalid cursor load is atomic');
});

test('forged ingestion documents never replace the current idle owner or its cursor and source',t=>{
 const source=fixture(t),target=fixture(t);configure(source);configure(target,{streamId:'target',generation:8,firstSequence:800});source.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}]));const document=safeCheckpointParse(source.api.saveDataIngestion()),saved=target.api.saveDataIngestion(),before=snapshot(target);
 for(const mutate of [d=>{d.version=2;},d=>{d.state='busy';},d=>{d.nextSequence++;},d=>{d.counters.accepted++;},d=>{d.pending.firstSequence++;},d=>{d.pending.events[0].kind='reset';},d=>{d.pending.events[0].bar.close=Infinity;},d=>{d.policy.maxStoredBars=2;}]) {
  const invalid=structuredClone(document);mutate(invalid);assert.throws(()=>target.api.loadDataIngestion(JSON.stringify(invalid)));assert.equal(target.api.saveDataIngestion(),saved);unchanged(target,before);assert.equal(ledger(target.api).policy.streamId,'target');
 }
});

test('fresh stats/read saves do not mutate state, reconfiguration requires no pending payload, and closed owners reject',t=>{
 const f=fixture(t);required(f.api);assert.throws(()=>f.api.dataIngestionStats(),ingestionError('NOT_CONFIGURED'));configure(f);const version=f.model.store.version,invalidations=f.invalidations(),before=f.api.saveDataIngestion(),first=f.api.dataIngestionStats();first.policy.streamId='caller-mutated';first.accepted=999;
 assert.equal(f.api.saveDataIngestion(),before);assert.equal(ledger(f.api).policy.streamId,'feed-A');assert.equal(f.model.store.version,version);assert.equal(f.invalidations(),invalidations);
 f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}]));assert.throws(()=>f.api.configureDataIngestion({streamId:'next',generation:8}),ingestionError('PENDING_DATA'));assert.equal(ledger(f.api).pendingEvents,1);f.api.cancelDataEvents();const next=f.api.configureDataIngestion({streamId:'next',generation:8,firstSequence:20});assert.equal(next.nextSequence,20);assert.equal(next.accepted,0);
 f.model.dispose();assert.equal(f.model.store.listeners.size,0);assert.throws(()=>f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)}])),/closed|disposed/i);
});

test('readonly stats and saves report a changed pending source without persisting a pause or changing counters',t=>{
 const f=fixture(t);configure(f);f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3,35)}]));const accepted=ledger(f.api);
 f.api.applyDataEvent({kind:'update',bar:bar(2,42)});const before=snapshot(f),saved=f.api.saveDataIngestion();
 for(let i=0;i<3;i++) {
  const s=ledger(f.api);assert.equal(s.state,'paused');assert.equal(s.lastError.code,'SOURCE_CHANGED');
  for(const key of ['accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','pendingEvents','pendingBytes','ownedBytes','nextSequence','peakPendingEvents','peakPendingBytes']) {
   assert.ok(Number.isSafeInteger(s[key])&&s[key]>=0,'bounded readonly '+key);assert.equal(s[key],accepted[key],key+' is not advanced by reads');
  }
  assert.equal(s.lastAppliedSequence,null);assert.equal(s.lastCancelledSequence,null);assert.equal(s.pendingEvents,1);assert.equal(s.ownedBytes,392);
  s.lastError.code='caller-mutated';s.policy.maxQueuedEvents=0;assert.equal(f.api.saveDataIngestion(),saved);
  const document=safeCheckpointParse(saved);assert.equal(document.state,'paused');assert.equal(document.lastError.code,'SOURCE_CHANGED');assert.equal(document.pending.events[0].bar.close,35);unchanged(f,before);
 }
 // A read must not change the first mutator's SOURCE_CHANGED into PAUSED.
 assert.throws(()=>f.api.drainDataEvents(),ingestionError('SOURCE_CHANGED'));unchanged(f,before);
 assert.throws(()=>f.api.enqueueDataEvents(packet([{kind:'append',bar:bar(4)}],101)),ingestionError('PAUSED'));
 assert.equal(f.api.resumeDataIngestion().state,'running');assert.equal(f.api.drainDataEvents().lastSequence,100);assert.equal(f.model.store.at(2).close,42);assert.equal(f.model.store.at(3).close,35);
});

test('restoration rejects impossible completed cursors and rejection histories while accepting a real mixed ledger',t=>{
 const source=fixture(t),target=fixture(t,4),receiver=fixture(t,4);configure(source,{maxBatchEvents:1});configure(target,{streamId:'untouched',generation:8,firstSequence:800});
 source.api.enqueueDataEvents(packet([{kind:'append',bar:bar(3)},{kind:'append',bar:bar(4)}]));source.api.drainDataEvents();source.api.cancelDataEvents();
 source.api.enqueueDataEvents(packet([{kind:'update',bar:bar(3,44)}],102));assert.throws(()=>source.api.enqueueDataEvents(packet([{kind:'update',bar:bar(3,45)}],104)),ingestionError('SEQUENCE_MISMATCH'));
 const valid=source.api.saveDataIngestion(),document=safeCheckpointParse(valid),saved=target.api.saveDataIngestion(),before=snapshot(target);
 assert.equal(document.counters.applied,1);assert.equal(document.counters.cancelled,1);assert.equal(document.counters.lastAppliedSequence,100);assert.equal(document.counters.lastCancelledSequence,101);assert.equal(document.pending.firstSequence,102);
 const variants=[
  ['zero applied with a cursor',d=>{d.counters.applied=0;d.counters.cancelled=2;}],
  ['zero cancelled with a cursor',d=>{d.counters.cancelled=0;d.counters.applied=2;d.counters.lastAppliedSequence=101;}],
  ['applied payload without a cursor',d=>{d.counters.lastAppliedSequence=null;}],
  ['cancelled payload without a cursor',d=>{d.counters.lastCancelledSequence=null;}],
  ['applied cursor into pending payload',d=>{d.counters.lastAppliedSequence=102;}],
  ['cancelled cursor into pending payload',d=>{d.counters.lastCancelledSequence=102;}],
  ['one sequence both applied and cancelled',d=>{d.counters.lastAppliedSequence=101;}],
  ['completed history missing its final sequence',d=>{d.counters.lastCancelledSequence=100;}],
  ['rejected payload without a packet',d=>{d.counters.rejectedPackets=0;}],
  ['more rejected events than any legal packet history',d=>{d.counters.rejectedEvents=4097;}],
  ['accepted payload without a queue peak',d=>{d.counters.peakPendingEvents=0;d.counters.peakPendingBytes=0;}],
  ['noninteger cumulative counter',d=>{d.counters.rejectedPackets=1.5;},'INVALID_INPUT'],
  ['unsafe cumulative counter',d=>{d.counters.failedDrains=Number.MAX_SAFE_INTEGER+1;},'INVALID_INPUT']
 ];
 for(const [label,mutate,code='INVALID_DOCUMENT'] of variants) {
  const invalid=structuredClone(document);mutate(invalid);assert.throws(()=>target.api.loadDataIngestion(JSON.stringify(invalid)),ingestionError(code),label);
  assert.equal(target.api.saveDataIngestion(),saved,label+' does not replace the current owner');unchanged(target,before);
 }
 assert.equal(receiver.api.loadDataIngestion(valid).nextSequence,103);assert.equal(receiver.api.saveDataIngestion(),valid);assert.equal(receiver.api.drainDataEvents().lastSequence,102);assert.equal(receiver.model.store.at(3).close,44);assert.equal(ledger(receiver.api).applied,2);
});

test('public async recompute with real computation and mock transport retains configured batch budgets and releases leases',async t=>{
 const previous=globalThis.Worker,workers=[];
 // Only browser transport is substituted. The public owner, request codec,
 // computation, packet validation and installation use their production paths.
 globalThis.Worker=class {
  constructor(){this.terminations=0;workers.push(this);}
  postMessage(request){this.request=structuredClone(request);Promise.resolve().then(()=>computeRequest(this.request)).then(packet=>this.onmessage({data:{packet}}),error=>this.onmessage({data:{error:String(error.message)}}));}
  terminate(){this.terminations++;}
 };
 try {
  for(const policy of [{maxStoredBars:16},{maxStoreBytes:1536}]) {
   const f=fixture(t,16);indicators(f.api);configure(f,policy);const before=snapshot(f),saved=f.api.saveDataIngestion(),count=workers.length;
   await assert.rejects(recomputeInWorker(f.model,{kind:'batch',events:[{kind:'append',bar:bar(16)}]}),ingestionError('STORE_BUDGET'));
   unchanged(f,before);assert.equal(f.api.saveDataIngestion(),saved);assert.equal(workers.length,count,'oversized batch rejected before worker allocation');assert.equal(ledger(f.api).state,'running');
   const events=[{kind:'correction',bar:bar(2,28)},{kind:'update',bar:bar(15,31)}];
   assert.equal(await recomputeInWorker(f.model,{kind:'batch',events}),f.model);const rows=scalarRows(f.input,events);
   sameColumns(f.model,Object.fromEntries(fields.map(k=>[k,Float64Array.from(rows,b=>b[k])])));vectors(f.api,independent(rows));
   const worker=workers.at(-1);assert.equal(worker.terminations,1);assert.deepEqual(worker.request.batchLimits,{maxBars:policy.maxStoredBars??f.model.store.maxBars,maxStoreBytes:policy.maxStoreBytes??96*4194304});
   assert.equal(f.api.saveDataIngestion(),saved,'successful recompute retains the same producer ledger');assert.equal(ledger(f.api).state,'running');
   f.api.enqueueDataEvents(packet([{kind:'update',bar:bar(15,32)}]));assert.equal(f.api.drainDataEvents().events,1);assert.equal(ledger(f.api).applied,1);
  }
  assert.equal(workers.length,2);for(const worker of workers)assert.equal(worker.terminations,1);
 }finally {globalThis.Worker=previous;}
});
