import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,FIELDS} from '../src/core/data.mjs';
import {ChartModel,ChartAPI} from '../src/core/index.mjs';
import {safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';

// This artifact is intended to be installed as test/batch-staging-reuse.test.mjs.
// The bounded Map instrumentation is synchronous and restored in finally; the
// allocation assertion is structural, not a timing or memory benchmark.
const T=1700000000000,STEP=60000,TREE_FIELDS=['min','max','sum'];
const flat=(i,price=1,volume=1)=>({time:T+i*STEP,open:price,high:price,low:price,close:price,volume});
const bar=(i,price=1,volume=1)=>({time:T+i*STEP,open:price-.125,high:price+.5,low:price-.75,close:price+.25,volume});
const inputRows=n=>Array.from({length:n},(_,i)=>bar(i,(i-8)/10,i%3===0?1e15+.5:(i+1)/10));
function scalar(store,events){
 for(const event of events){
  if(event.kind==='append')store.append(event.bar);
  else store.update(event.kind==='update'?store.length-1:store.lowerBound(event.bar.time),event.bar);
 }
}
function data(store){return {columns:Object.fromEntries(FIELDS.map(k=>[k,store.columns[k].slice()])),tree:Object.fromEntries(TREE_FIELDS.map(k=>[k,store.index[k].slice()]))};}
function exact(actual,expected){
 assert.equal(actual.length,expected.length);assert.equal(actual.capacity,expected.capacity);assert.equal(actual.index.size,expected.index.size);
 for(const k of FIELDS)assert.deepEqual(actual.columns[k],expected.columns[k],'complete Float64 '+k+' including unused slots and signed zero');
 for(const k of TREE_FIELDS)assert.deepEqual(actual.index[k],expected.index[k],'complete Float64 tree '+k+' in scalar merge order');
}
function snapshot(store){return {data:data(store),columns:store.columns,columnRefs:FIELDS.map(k=>store.columns[k]),index:store.index,treeRefs:TREE_FIELDS.map(k=>store.index[k]),length:store.length,capacity:store.capacity,version:store.version,timeVersion:store.timeVersion,bytes:store.bytes,pendingChanges:store.pendingChanges,pending:store.pendingChanges.slice(),listenerErrors:store.listenerErrors,errors:store.listenerErrors.slice(),notifying:store.notifying};}
function unchanged(store,before){
 assert.equal(store.columns,before.columns);assert.equal(store.index,before.index);
 FIELDS.forEach((k,i)=>assert.equal(store.columns[k],before.columnRefs[i]));TREE_FIELDS.forEach((k,i)=>assert.equal(store.index[k],before.treeRefs[i]));
 for(const k of ['length','capacity','version','timeVersion','bytes','notifying'])assert.equal(store[k],before[k],k+' unchanged');
 assert.equal(store.pendingChanges,before.pendingChanges);assert.deepEqual(store.pendingChanges,before.pending);
 assert.equal(store.listenerErrors,before.listenerErrors);assert.deepEqual(store.listenerErrors,before.errors);assert.deepEqual(data(store),before.data);
}
function repeated(last,count=4096,tail=15){
 const volumes=[0,-0,.1,.2,1e15+.5,.3,1e-12];
 const events=Array.from({length:count},(_,i)=>({kind:i%2?'correction':'update',bar:i%5===0?flat(tail,i%10===0?-0:0,volumes[i%volumes.length]):bar(tail,(i%17-8)/10,volumes[i%volumes.length])}));
 events[count-1]={kind:'correction',bar:last};return events;
}
function observeNodeSets(run,onNode=null){
 const original=Map.prototype.set,records=new Set(),positions=new Set(),maps=new Set();let sets=0;
 Map.prototype.set=function(key,value){
  if(value&&typeof value==='object'&&Object.keys(value).length===3&&Object.hasOwn(value,'min')&&Object.hasOwn(value,'max')&&Object.hasOwn(value,'sum')){
   sets++;records.add(value);positions.add(key);maps.add(this);onNode?.(key,value);
  }
  return original.call(this,key,value);
 };
 try{return {result:run(),records,positions,maps,get sets(){return sets;}};}finally{Map.prototype.set=original;}
}
const pending=api=>safeCheckpointParse(api.saveDataIngestion()).pending;
function fixture(t,rows,patch={}){
 const model=new ChartModel({store:new BarStore(rows)}),api=new ChartAPI(model);t.after(()=>model.dispose());
 api.configureDataIngestion({streamId:'staging-reuse',generation:1,firstSequence:100,maxQueuedEvents:16,maxQueuedBytes:16*49,maxBatchEvents:4,...patch});return {model,api};
}
const packet=(events,firstSequence=100)=>({streamId:'staging-reuse',generation:1,firstSequence,events});
function conserved(stats){assert.equal(stats.accepted,stats.applied+stats.cancelled+stats.pendingEvents);assert.equal(stats.nextSequence,100+stats.accepted);assert.equal(stats.pendingBytes,49*stats.pendingEvents);}

for(const [label,last] of [['negative zero',flat(15,-0,-0)],['positive zero',flat(15,0,0)],['fractional values',bar(15,-.375,.1)]])test('4096 same-timestamp updates/corrections retain exact scalar columns and tree: '+label,()=>{
 const rows=inputRows(16),store=new BarStore(rows),reference=new BarStore(rows),events=repeated(last),version=store.version,timeVersion=store.timeVersion,changes=[];
 store.subscribe(change=>changes.push(change));scalar(reference,events);const receipt=store.applyEvents(events);
 exact(store,reference);assert.equal(receipt.events,4096);assert.equal(receipt.appended,0);assert.equal(receipt.from,15);assert.equal(receipt.to,16);
 assert.equal(store.version,version+1);assert.equal(store.timeVersion,timeVersion);assert.deepEqual(changes,[{from:15,kind:'batch',version:version+1,appended:0,to:16}]);
 assert.ok(Object.is(store.columns.volume[15],last.volume));assert.ok(Object.is(store.index.sum[31],last.volume));
 for(let a=0;a<=16;a++)for(let b=a;b<=16;b++)assert.deepEqual(store.index.query(a,b),reference.index.query(a,b));
});

test('capacity-16 repeated-leaf staging owns exactly five distinct node records',()=>{
 const store=new BarStore(inputRows(16)),reference=new BarStore(inputRows(16)),events=repeated(bar(15,4.125,.7),64),before=snapshot(store),originalSet=Map.prototype.set;
 scalar(reference,events);
 const observed=observeNodeSets(()=>store.applyEvents(events),()=>unchanged(store,before));
 assert.equal(Map.prototype.set,originalSet);assert.equal(observed.maps.size,1,'only the staged tree Map is counted');
 assert.deepEqual([...observed.positions].sort((a,b)=>a-b),[1,3,7,15,31]);
 assert.equal(observed.records.size,5,'one owned min/max/sum record per distinct touched tree node, even for repeated events');
 assert.ok(observed.sets>=5&&observed.sets<=64*5,'bounded structural observation');exact(store,reference);
});

test('mixed old/new corrections cross two growth boundaries with exact scalar tree order',()=>{
 const rows=inputRows(15),store=new BarStore(rows),reference=new BarStore(rows),before=snapshot(store),changes=[];
 const events=[{kind:'correction',bar:flat(0,-0,-0)},{kind:'update',bar:bar(14,2.125,.7)}];
 for(let i=15;i<55;i++){
  events.push({kind:'append',bar:bar(i,i/10,i%4===0?1e15+.5:.1)});
  if(i%3===0)events.push({kind:'update',bar:flat(i,i%2?-0:0,i%2?-0:.3)});
  if(i%5===0)events.push({kind:'correction',bar:bar(3,-i/10,.2)},{kind:'correction',bar:bar(15,i/100,.1)});
 }
 events.push({kind:'correction',bar:flat(16,-0,-0)},{kind:'correction',bar:bar(54,-.25,.3)});
 store.subscribe(change=>changes.push(change));scalar(reference,events);const receipt=store.applyEvents(events);exact(store,reference);
 assert.equal(receipt.events,events.length);assert.equal(receipt.appended,40);assert.equal(receipt.capacity,64);assert.equal(receipt.length,55);
 assert.equal(receipt.from,0);assert.equal(receipt.to,55);assert.equal(store.version,before.version+1);assert.equal(store.timeVersion,before.timeVersion+1);assert.equal(changes.length,1);
 assert.notEqual(store.columns,before.columns);assert.notEqual(store.index,before.index);
 for(const k of FIELDS)assert.deepEqual(before.columns[k],before.data.columns[k],'old '+k+' buffer remains intact after growth');
 for(const k of TREE_FIELDS)assert.deepEqual(before.index[k],before.data.tree[k],'old '+k+' tree remains intact after growth');
});

test('reused staged records cannot hide intermediate overflow followed by a finite final state',()=>{
 const store=new BarStore([flat(0,1,0),flat(1,2,0)]),before=snapshot(store),changes=[];store.subscribe(c=>changes.push(c));
 const events=[{kind:'correction',bar:flat(0,3,.1)},{kind:'correction',bar:flat(0,4,Number.MAX_VALUE)},{kind:'update',bar:flat(1,5,Number.MAX_VALUE)},{kind:'update',bar:flat(1,6,0)},{kind:'correction',bar:flat(0,7,0)}];
 assert.throws(()=>store.applyEvents(events),/Volume sum overflow/);unchanged(store,before);assert.deepEqual(changes,[]);
});

test('append root-sum guard remains separate from a finite leaf-path sum',()=>{
 const unit=2**971,large=Number.MAX_VALUE-unit,sibling=3*(2**969),volume=2**970;
 assert.equal((large+sibling)+volume,Infinity);assert.equal((volume+sibling)+large,Number.MAX_VALUE,'fixture distinguishes append precheck from update guard');
 const rows=[flat(0,1,large),flat(1,2,0),flat(2,3,sibling)],store=new BarStore(rows),reference=new BarStore(rows),before=snapshot(store),event={kind:'append',bar:flat(3,4,volume)};
 assert.throws(()=>reference.append(event.bar),/Volume sum overflow/);
 assert.throws(()=>store.applyEvents([event,{kind:'update',bar:flat(3,5,0)}]),/Volume sum overflow/);unchanged(store,before);
});

test('late overflow after growth leaves all original buffers and pending publication intact',()=>{
 const store=new BarStore(Array.from({length:16},(_,i)=>flat(i,i,0))),before=snapshot(store);let notified=0;store.subscribe(()=>notified++);
 const events=[{kind:'correction',bar:flat(0,-0,-0)},{kind:'append',bar:bar(16,2,.1)},{kind:'update',bar:bar(16,3,Number.MAX_VALUE)},{kind:'append',bar:bar(17,4,Number.MAX_VALUE)},{kind:'update',bar:bar(17,5,0)}];
 assert.throws(()=>store.applyEvents(events),/Volume sum overflow/);unchanged(store,before);assert.equal(notified,0);
});

for(const field of FIELDS)test('late NaN '+field+' rejects before any source publication',()=>{
 const store=new BarStore(inputRows(16)),before=snapshot(store),invalid={...bar(16,2,.3),[field]:NaN};let notified=0;store.subscribe(()=>notified++);
 assert.throws(()=>store.applyEvents([{kind:'update',bar:flat(15,-0,-0)},{kind:'append',bar:bar(16,1,.2)},{kind:'update',bar:invalid}]),/finite|Time/);
 unchanged(store,before);assert.equal(notified,0);
});

test('prepend remains an explicit boundary and existing prepended timestamps can be corrected',()=>{
 const rows=[bar(2,2,.2),bar(3,3,.3)],store=new BarStore(rows),reference=new BarStore(rows),prefix=[flat(0,-0,-0),bar(1,1,.1)];
 store.prepend(prefix);reference.prepend(prefix);const before=snapshot(store);
 for(const event of [{kind:'prepend',bar:bar(-1,1,.1)},{kind:'append',bar:bar(-1,1,.1)},{kind:'correction',bar:bar(-1,1,.1)}]){
  assert.throws(()=>store.applyEvents([{kind:'correction',bar:bar(0,4,.4)},event]));unchanged(store,before);
 }
 const events=[{kind:'correction',bar:bar(0,-.125,.7)},{kind:'correction',bar:flat(1,-0,-0)},{kind:'update',bar:bar(3,3.5,.6)},{kind:'append',bar:bar(4,4.5,.9)}];
 scalar(reference,events);store.applyEvents(events);exact(store,reference);assert.equal(store.timeVersion,before.timeVersion+1);
});

test('input snapshot still rejects descriptor reentry after a newer same-leaf mutation',()=>{
 const store=new BarStore(inputRows(16)),reference=new BarStore(inputRows(16)),replacement=bar(15,99,.75),version=store.version,changes=[];let armed=true;
 store.subscribe(c=>changes.push(c));const target={kind:'update',bar:bar(15,22,.5)};
 const event=new Proxy(target,{getOwnPropertyDescriptor(object,key){if(armed&&key==='kind'){armed=false;store.update(15,replacement);}return Reflect.getOwnPropertyDescriptor(object,key);}});
 assert.throws(()=>store.applyEvents([{kind:'correction',bar:bar(0,42,.2)},event]),/source|stale|changed/i);
 reference.update(15,replacement);exact(store,reference);assert.equal(store.version,version+1);assert.deepEqual(changes,[{from:15,kind:'update',version:version+1}]);
});

test('observers see complete owned commits and retain FIFO subscriber snapshots under reentry',()=>{
 const rows=inputRows(16),store=new BarStore(rows),outerReference=new BarStore(rows),nestedReference=new BarStore(rows),events=repeated(flat(15,-0,-0),32),nested=[{kind:'correction',bar:bar(0,12,.25)},{kind:'update',bar:bar(15,8,.75)}];
 scalar(outerReference,events);scalar(nestedReference,events);scalar(nestedReference,nested);
 const version=store.version,seen=[],captures=[];let stopSecond,nestedReceipt;
 store.subscribe(change=>{
  seen.push('first:'+change.version);captures.push(data(store));
  if(change.version===version+1){
   exact(store,outerReference);stopSecond();store.subscribe(next=>seen.push('new:'+next.version));
   events.at(-1).bar.volume=123;events.at(-1).bar.close=456;
   nestedReceipt=store.applyEvents(nested);exact(store,nestedReference);
  }
 });
 stopSecond=store.subscribe(change=>{seen.push('second:'+change.version);exact(store,nestedReference);});
 const receipt=store.applyEvents(events);
 assert.deepEqual(seen,['first:'+(version+1),'second:'+(version+1),'first:'+(version+2),'new:'+(version+2)]);
 assert.deepEqual(captures[0],data(outerReference));assert.deepEqual(captures[1],data(nestedReference));
 assert.equal(receipt.version,version+1);assert.equal(nestedReceipt.version,version+2);assert.equal(receipt.events,32);
 assert.equal(store.pendingChanges.length,0);assert.equal(store.notifying,false);assert.deepEqual(store.listenerErrors,[]);exact(store,nestedReference);
});

test('ingestion keeps every same-leaf event and publishes its exact prefix ledger before observers',t=>{
 const rows=[flat(0,1,0)],{model,api}=fixture(t,rows),reference=new BarStore(rows),events=repeated(bar(0,6,.6),6,0),owned=events.map(e=>({kind:e.kind,bar:{...e.bar}})),extra={kind:'update',bar:flat(0,-0,-0)};
 api.enqueueDataEvents(packet(events));events[0].bar.volume=999;const notices=[];
 model.store.subscribe(change=>{
  const stats=api.dataIngestionStats();conserved(stats);notices.push({change:{...change},applied:stats.applied,pending:stats.pendingEvents,data:data(model.store)});
  if(notices.length===1){
   assert.equal(stats.applied,4);assert.equal(stats.pendingEvents,2);assert.equal(stats.lastAppliedSequence,103);
   assert.deepEqual(pending(api),{firstSequence:104,events:owned.slice(4)});
   assert.throws(()=>api.drainDataEvents(),e=>e.code==='BUSY');api.enqueueDataEvents(packet([extra],106));
   const detached=pending(api);detached.events[0].bar.volume=4321;
  }
 });
 scalar(reference,owned.slice(0,4));const first=api.drainDataEvents();exact(model.store,reference);
 assert.equal(first.events,4);assert.equal(first.firstSequence,100);assert.equal(first.lastSequence,103);assert.equal(notices.length,1);
 assert.deepEqual(pending(api),{firstSequence:104,events:[...owned.slice(4),extra]});
 scalar(reference,owned.slice(4));const second=api.drainDataEvents(2);exact(model.store,reference);
 assert.equal(second.events,2);assert.equal(second.firstSequence,104);assert.equal(second.lastSequence,105);assert.deepEqual(pending(api),{firstSequence:106,events:[extra]});
 scalar(reference,[extra]);const third=api.drainDataEvents();exact(model.store,reference);
 assert.equal(third.events,1);assert.equal(third.firstSequence,106);assert.equal(third.lastSequence,106);
 const stats=api.dataIngestionStats();conserved(stats);assert.equal(stats.accepted,7);assert.equal(stats.applied,7);assert.equal(stats.pendingEvents,0);assert.equal(stats.failedDrains,0);
 assert.deepEqual(notices.map(n=>[n.applied,n.pending]),[[4,2],[6,1],[7,0]]);assert.deepEqual(model.store.listenerErrors,[]);
});

test('failed ingestion drain retains the entire repeated-event prefix, suffix and cursors',t=>{
 const {model,api}=fixture(t,[flat(0,1,0),flat(1,2,0)],{maxBatchEvents:3}),events=[{kind:'correction',bar:flat(0,3,Number.MAX_VALUE)},{kind:'update',bar:flat(1,4,Number.MAX_VALUE)},{kind:'update',bar:flat(1,5,0)},{kind:'correction',bar:flat(0,6,0)}];
 api.enqueueDataEvents(packet(events));const before=snapshot(model.store),beforePending=pending(api),beforeStats=api.dataIngestionStats();let notified=0;model.store.subscribe(()=>notified++);
 assert.throws(()=>api.drainDataEvents(),e=>e.code==='DRAIN_FAILED'&&/Volume sum overflow/.test(e.message));unchanged(model.store,before);
 assert.deepEqual(pending(api),beforePending);const stats=api.dataIngestionStats();conserved(stats);
 for(const key of ['accepted','applied','cancelled','nextSequence','lastAppliedSequence','pendingEvents','pendingBytes'])assert.equal(stats[key],beforeStats[key],key+' unchanged on failed prefix');
 assert.equal(stats.failedDrains,1);assert.equal(stats.state,'paused');assert.equal(notified,0);
 assert.deepEqual(api.cancelDataEvents(),{events:4,firstSequence:100,lastSequence:103});conserved(api.dataIngestionStats());
});

test('a prior prepend while queued preserves the prefix until explicit source revalidation',t=>{
 const {model,api}=fixture(t,[bar(2,2,.2),bar(3,3,.3)]),events=[{kind:'correction',bar:bar(2,4,.4)},{kind:'update',bar:flat(3,-0,-0)}];
 api.enqueueDataEvents(packet(events));const beforePending=pending(api);model.store.prepend([flat(0,-0,-0),bar(1,1,.1)]);
 const before=snapshot(model.store);assert.throws(()=>api.drainDataEvents(),e=>e.code==='SOURCE_CHANGED');unchanged(model.store,before);assert.deepEqual(pending(api),beforePending);
 assert.equal(api.dataIngestionStats().applied,0);assert.equal(api.dataIngestionStats().pendingEvents,2);
 const reference=new BarStore(Array.from({length:model.store.length},(_,i)=>model.store.at(i)));scalar(reference,events);
 api.resumeDataIngestion();const receipt=api.drainDataEvents();exact(model.store,reference);assert.equal(receipt.events,2);assert.equal(receipt.firstSequence,100);assert.equal(receipt.lastSequence,101);conserved(api.dataIngestionStats());
});
