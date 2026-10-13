import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,FIELDS,seededColumns} from '../src/core/data.mjs';
import {IndicatorEngine,builtinIndicators} from '../src/core/indicators.mjs';

const T=1700000000000;
const bar=(time,close,volume=1)=>({time,open:close,high:close,low:close,close,volume});
const rows=store=>Array.from({length:store.length},(_,i)=>store.at(i));
function apply(store,events,limits){assert.equal(typeof store.applyEvents,'function','public ordered data transaction is required');return store.applyEvents(events,limits);}
function scalar(store,events){for(const event of events){if(event.kind==='append')store.append(event.bar);else{const index=event.kind==='update'?store.length-1:store.lowerBound(event.bar.time);store.update(index,event.bar);}}}
function snapshot(store){return {length:store.length,capacity:store.capacity,version:store.version,timeVersion:store.timeVersion,bytes:store.bytes,columns:store.columns,index:store.index,data:rows(store),columnData:FIELDS.map(k=>Array.from(store.columns[k])),tree:[...['min','max','sum'].map(k=>Array.from(store.index[k]))],pending:store.pendingChanges.slice(),errors:store.listenerErrors.slice()};}
function unchanged(store,before){assert.deepEqual(snapshot(store),before);}
function assertVectors(actual,expected){assert.deepEqual(Object.keys(actual),Object.keys(expected));for(const key of Object.keys(actual)){assert.equal(actual[key].length,expected[key].length);for(let i=0;i<actual[key].length;i++){const a=actual[key][i],e=expected[key][i];assert.ok(Number.isNaN(a)&&Number.isNaN(e)||Math.abs(a-e)<=1e-11*Math.max(1,Math.abs(a),Math.abs(e)),`${key}[${i}] ${a} != ${e}`);}}}

test('ordered mixed batch publishes one exact receipt, all rows and range sums',()=>{
 const input=[bar(T,10,1),bar(T+60000,20,2),bar(T+180000,30,3)],store=new BarStore(input),reference=new BarStore(input),changes=[];
 const events=[{kind:'update',bar:bar(T+180000,31,4)},{kind:'append',bar:bar(T+240000,40,5)},{kind:'update',bar:bar(T+240000,41,6)},{kind:'correction',bar:bar(T,11,7)},{kind:'append',bar:bar(T+600000,50,8)}];
 const version=store.version,timeVersion=store.timeVersion,columns=store.columns,index=store.index;store.subscribe(change=>changes.push(change));
 const receipt=apply(store,events);scalar(reference,events);
 assert.deepEqual(rows(store),[bar(T,11,7),bar(T+60000,20,2),bar(T+180000,31,4),bar(T+240000,41,6),bar(T+600000,50,8)]);
 assert.deepEqual(rows(store),rows(reference));assert.equal(store.columns,columns);assert.equal(store.index,index);
 assert.deepEqual(receipt,{events:5,appended:2,from:0,to:5,version:version+1,length:5,capacity:16,bytes:1536});
 assert.equal(store.version,version+1);assert.equal(store.timeVersion,timeVersion+1);assert.deepEqual(changes,[{from:0,kind:'batch',version:version+1,appended:2,to:5}]);
 for(let a=0;a<=5;a++)for(let b=a;b<=5;b++){assert.deepEqual(store.index.query(a,b),reference.index.query(a,b));const subset=rows(store).slice(a,b);assert.deepEqual(store.index.query(a,b),{min:subset.length?Math.min(...subset.map(b=>b.low)):Infinity,max:subset.length?Math.max(...subset.map(b=>b.high)):-Infinity,sum:subset.reduce((s,b)=>s+b.volume,0)});}
});

test('repeated updates and corrections keep input order and timeVersion',()=>{
 const store=new BarStore([bar(T,10),bar(T+60000,20)]),version=store.version,timeVersion=store.timeVersion;
 const first=bar(T+60000,21,3),last=bar(T+60000,22,4),events=[{kind:'update',bar:first},{kind:'correction',bar:bar(T,9,5)},{kind:'update',bar:last}];
 assert.deepEqual(apply(store,events),{events:3,appended:0,from:0,to:2,version:version+1,length:2,capacity:16,bytes:1536});
 first.close=900;last.volume=900;assert.deepEqual(rows(store),[bar(T,9,5),bar(T+60000,22,4)]);assert.equal(store.timeVersion,timeVersion);
});

test('newly appended timestamps can be corrected in the same ordered transaction',()=>{
 const store=new BarStore(),timeVersion=store.timeVersion;
 const receipt=apply(store,[{kind:'append',bar:bar(T,1,1)},{kind:'append',bar:bar(T+60000,2,2)},{kind:'correction',bar:bar(T,3,3)},{kind:'update',bar:bar(T+60000,4,4)}]);
 assert.deepEqual(rows(store),[bar(T,3,3),bar(T+60000,4,4)]);assert.equal(receipt.appended,2);assert.equal(receipt.from,0);assert.equal(receipt.to,2);assert.equal(store.timeVersion,timeVersion+1);
});

for(const [label,last] of [
 ['reset',{kind:'reset',bar:bar(T+120000,1)}],['prepend',{kind:'prepend',bar:bar(T-60000,1)}],
 ['unsorted append',{kind:'append',bar:bar(T+60000,1)}],['duplicate append',{kind:'append',bar:bar(T+120000,1)}],
 ['old current update',{kind:'update',bar:bar(T+60000,1)}],['missing correction',{kind:'correction',bar:bar(T+90000,1)}],
 ['invalid OHLC',{kind:'update',bar:{...bar(T+120000,1),high:0}}],['nonfinite bar',{kind:'update',bar:bar(T+120000,NaN)}]
])test('late '+label+' rejects the entire transaction',()=>{
 const store=new BarStore([bar(T,10),bar(T+60000,20)]),before=snapshot(store);let notified=0;store.subscribe(()=>notified++);
 assert.throws(()=>apply(store,[{kind:'correction',bar:bar(T,11)},{kind:'append',bar:bar(T+120000,30)},last]));unchanged(store,before);assert.equal(notified,0);
});

test('every intermediate volume sum must be finite, even when the final sum would fit',()=>{
 const store=new BarStore([bar(T,1,0),bar(T+60000,1,0)]),before=snapshot(store);
 assert.throws(()=>apply(store,[{kind:'correction',bar:bar(T,1,Number.MAX_VALUE)},{kind:'update',bar:bar(T+60000,1,Number.MAX_VALUE)},{kind:'update',bar:bar(T+60000,1,0)}]),/Volume sum overflow/);unchanged(store,before);
});

test('late overflow after staged growth preserves the old buffers and capacity',()=>{
 const store=new BarStore(Array.from({length:16},(_,i)=>bar(T+i*60000,1,0))),before=snapshot(store);let notified=0;store.subscribe(()=>notified++);
 assert.throws(()=>apply(store,[{kind:'append',bar:bar(T+16*60000,2,Number.MAX_VALUE)},{kind:'append',bar:bar(T+17*60000,3,Number.MAX_VALUE)},{kind:'update',bar:bar(T+17*60000,4,0)}]),/Volume sum overflow/);
 unchanged(store,before);assert.equal(notified,0);
});

test('budgets use final rows and power-of-two store capacity before publication',()=>{
 const store=new BarStore(Array.from({length:16},(_,i)=>bar(T+i*60000,i+1)),{maxBars:32}),before=snapshot(store),event={kind:'append',bar:bar(T+16*60000,17)};
 assert.throws(()=>apply(store,[event],{maxBars:16}),/limit|budget/i);unchanged(store,before);
 assert.throws(()=>apply(store,[event],{maxStoreBytes:16*96}),/byte|budget/i);unchanged(store,before);
 assert.throws(()=>apply(store,[{kind:'update',bar:store.at(15)}],{maxStoreBytes:16*96-1}),/byte|budget/i);unchanged(store,before);
 const receipt=apply(store,[event],{maxBars:17,maxStoreBytes:32*96});assert.equal(receipt.capacity,32);assert.equal(receipt.bytes,32*96);assert.equal(store.bytes,receipt.bytes);
});

test('growth stages one final capacity and keeps old arrays/index unchanged',()=>{
 const input=Array.from({length:16},(_,i)=>bar(T+i*60000,i+1,i+1)),store=new BarStore(input),reference=new BarStore(input),old=snapshot(store);
 const events=Array.from({length:40},(_,i)=>({kind:'append',bar:bar(T+(16+i)*60000,17+i,17+i)}));events.push({kind:'correction',bar:bar(T+20*60000,100,5)});
 const receipt=apply(store,events);scalar(reference,events);assert.equal(receipt.capacity,64);assert.equal(receipt.appended,40);assert.equal(receipt.events,41);assert.deepEqual(rows(store),rows(reference));
 assert.notEqual(store.columns,old.columns);assert.notEqual(store.index,old.index);assert.deepEqual(FIELDS.map(k=>Array.from(old.columns[k])),old.columnData);assert.deepEqual(['min','max','sum'].map(k=>Array.from(old.index[k])),old.tree);
 for(let a=0;a<56;a+=3)for(let b=a+1;b<=56;b+=5)assert.deepEqual(store.index.query(a,b),reference.index.query(a,b));
});

test('the 1..4096 event count is explicit and does not deduplicate repeats',()=>{
 const store=new BarStore([bar(T,1)]),before=snapshot(store),event={kind:'update',bar:bar(T,2)};
 assert.throws(()=>apply(store,[]),/count|1|4096/);assert.throws(()=>apply(store,Array(4097).fill(event)),/count|4096/);unchanged(store,before);
 const receipt=apply(store,Array(4096).fill(event));assert.equal(receipt.events,4096);assert.equal(receipt.appended,0);assert.equal(store.at(0).close,2);
});

test('records reject getters/functions and sparse/accessor arrays without invoking getters',()=>{
 const store=new BarStore([bar(T,1)]),before=snapshot(store);let calls=0;
 const accessorBar={...bar(T,2)};Object.defineProperty(accessorBar,'volume',{get(){calls++;return 1;},enumerable:true});
 const accessorEvent={bar:bar(T,2)};Object.defineProperty(accessorEvent,'kind',{get(){calls++;return 'update';},enumerable:true});
 const accessorArray=[];Object.defineProperty(accessorArray,'0',{get(){calls++;return {kind:'update',bar:bar(T,2)};},enumerable:true});
 const accessorOptions={};Object.defineProperty(accessorOptions,'maxBars',{get(){calls++;return 16;},enumerable:true});
 for(const events of [[{kind:'update',bar:accessorBar}],[accessorEvent],accessorArray,Array(1),[{kind:'update',bar:()=>bar(T,2)}],[{kind:'update',bar:bar(T,2),callback(){}}]]){assert.throws(()=>apply(store,events),/data|property|record|array|field|bar|object|OHLCV/i);unchanged(store,before);}
 assert.throws(()=>apply(store,[{kind:'update',bar:bar(T,2)}],accessorOptions),/data|property|accessor/i);assert.equal(calls,0);unchanged(store,before);
 assert.throws(()=>apply(store,[{kind:'update',bar:bar(T,2)}],{beforeNotify(){calls++;}}),/field|option/i);assert.equal(calls,0);unchanged(store,before);
});

test('malformed options/hidden fields/symbols reject without source publication',()=>{
 const store=new BarStore([bar(T,1)]),before=snapshot(store),event={kind:'update',bar:bar(T,2)};
 for(const options of [null,[],()=>{}, {maxBars:-1},{maxBars:Infinity},{maxBars:.5},{maxBars:()=>1},{maxBars:store.maxBars+1},{maxStoreBytes:-1},{maxStoreBytes:NaN},{maxStoreBytes:'1536'}]){assert.throws(()=>apply(store,[event],options));unchanged(store,before);}
 for(const item of [{...event,[Symbol('data')]:1},Object.defineProperty({...event},'hidden',{value:1}),Object.assign(Object.create({kind:'update'}),{bar:bar(T,2)})]){assert.throws(()=>apply(store,[item]));unchanged(store,before);}
});

test('F64 raw values preserve tiny prices and negative zero exactly',()=>{
 const store=new BarStore([bar(T,1)]);apply(store,[{kind:'update',bar:bar(T,-0,-0)},{kind:'append',bar:bar(T+60000,1e-12,.1)}]);
 assert.ok(Object.is(store.columns.close[0],-0));assert.ok(Object.is(store.columns.volume[0],-0));assert.ok(Object.is(store.index.sum[store.capacity],-0));assert.equal(store.columns.close[1],1e-12);
});

test('descriptor reflection reentry discards the batch and preserves newer source mutation',()=>{
 const store=new BarStore([bar(T,1,1)]),version=store.version;let armed=true;const notifications=[];store.subscribe(change=>notifications.push(change.kind));
 const input=new Proxy({kind:'update',bar:bar(T,2,1234)},{getOwnPropertyDescriptor(target,key){if(armed&&key==='kind'){armed=false;store.update(0,bar(T,3,4321));}return Reflect.getOwnPropertyDescriptor(target,key);}});
 assert.throws(()=>apply(store,[input]),/source|stale|changed/i);assert.deepEqual(store.at(0),bar(T,3,4321));assert.equal(store.version,version+1);assert.deepEqual(notifications,['update']);
});

test('same-version source index replacement is also a stale transaction',()=>{
 const store=new BarStore([bar(T,1)]),version=store.version;let armed=true;
 const input=new Proxy({kind:'update',bar:bar(T,2)},{ownKeys(target){if(armed){armed=false;store.reindex();}return Reflect.ownKeys(target);}});
 const oldIndex=store.index;assert.throws(()=>apply(store,[input]),/source|stale|changed/i);assert.equal(store.version,version);assert.notEqual(store.index,oldIndex);assert.equal(store.at(0).close,1);
});

test('internal ledger seam sees committed data before public notification',()=>{
 const store=new BarStore([bar(T,1)]);assert.equal(typeof store._applyEvents,'function');let ledger=false,called=0;
 store.subscribe(change=>{assert.equal(ledger,true);assert.equal(change.kind,'batch');assert.equal(store.at(0).close,2);});
 const receipt=store._applyEvents([{kind:'update',bar:bar(T,2)}],{},result=>{called++;assert.equal(store.at(0).close,2);assert.equal(result.version,store.version+1);ledger=true;});
 assert.equal(called,1);assert.equal(receipt.version,store.version);assert.equal(store.listenerErrors.length,0);
});

test('batch observers preserve FIFO snapshots and reentrant commits',()=>{
 const store=new BarStore([bar(T,1)]),events=[];let stop;
 store.subscribe(change=>{events.push('a'+change.version);if(change.version===2){stop();store.subscribe(next=>events.push('new'+next.version));apply(store,[{kind:'update',bar:bar(T,3)}]);}});
 stop=store.subscribe(change=>events.push('b'+change.version));const receipt=apply(store,[{kind:'update',bar:bar(T,2)}]);
 assert.deepEqual(events,['a2','b2','a3','new3']);assert.equal(receipt.version,2);assert.equal(store.version,3);assert.equal(store.at(0).close,3);assert.equal(store.pendingChanges.length,0);
});

test('observer/reporting faults retain committed data and latest indicator readout',()=>{
 const store=new BarStore([bar(T,10),bar(T+60000,20)]),reported=[];store.onListenerError=(error,change)=>{reported.push({message:error.message,version:change.version});throw new Error('report failed');};
 store.subscribe(()=>{throw new Error('first observer');});const engine=new IndicatorEngine(store);engine.add('e','ema',{period:2});let observed;
 store.subscribe(()=>{observed=engine.get('e').outputs.value[1];});store.subscribe(()=>{throw new Error('last observer');});
 try{const receipt=apply(store,[{kind:'update',bar:bar(T+60000,30)}]);assert.equal(receipt.version,store.version);assert.equal(store.at(1).close,30);assert.equal(observed,20);assert.equal(engine.get('e').outputs.value[1],20);assert.equal(store.listenerErrors.length,4);assert.deepEqual(reported,[{message:'first observer',version:receipt.version},{message:'last observer',version:receipt.version}]);}finally{engine.dispose();}
});

test('literal recursive/cumulative references survive append batches',()=>{
 const store=new BarStore([bar(T,10,1),bar(T+60000,20,2)]),engine=new IndicatorEngine(store);
 try{for(const name of ['ema','rsi','obv','vwap'])engine.add(name,name,{period:2});engine.add('pressure','aster.volume-direction@1/pressure');
  apply(store,[{kind:'append',bar:bar(T+120000,10,3)},{kind:'append',bar:bar(T+180000,20,4)}]);
  assertVectors(engine.get('ema').outputs,{value:[NaN,15,35/3,155/9]});assertVectors(engine.get('rsi').outputs,{value:[NaN,NaN,50,75]});assertVectors(engine.get('obv').outputs,{value:[0,2,-1,3]});assertVectors(engine.get('vwap').outputs,{value:[10,50/3,40/3,16]});assertVectors(engine.get('pressure').outputs,{signed:[0,2,-3,4],cumulative:[0,2,-1,3]});
 }finally{engine.dispose();}
});

test('batch dirty range reaches later corrections before checkpoint convergence',()=>{
 const store=new BarStore(Array.from({length:3000},(_,i)=>bar(T+i*60000,10))),engine=new IndicatorEngine(store);
 try{engine.add('s','sma',{period:2});apply(store,[{kind:'correction',bar:bar(T,10,9)},{kind:'correction',bar:bar(T+2000*60000,20)}]);
  assert.equal(engine.entries.get('s').dirty,0);assert.equal(engine.entries.get('s').dirtyTo,2001);
  const data=engine.get('s');assert.equal(data.outputs.value[2000],15);assert.equal(data.outputs.value[2001],15);assert.equal(data.outputs.value[2002],10);assert.ok(data.computedUntil>=2001);
  const fresh=new IndicatorEngine(store);try{assertVectors(data.outputs,fresh.add('s','sma',{period:2}).outputs);}finally{fresh.dispose();}
 }finally{engine.dispose();}
});

test('multiple pending batches union the farthest correction bound',()=>{
 const store=new BarStore(Array.from({length:3000},(_,i)=>bar(T+i*60000,10))),engine=new IndicatorEngine(store);
 try{engine.add('s','sma',{period:2});apply(store,[{kind:'correction',bar:bar(T+2800*60000,20)}]);apply(store,[{kind:'correction',bar:bar(T,10,9)},{kind:'correction',bar:bar(T+256*60000,30)}]);
  assert.equal(engine.entries.get('s').dirty,0);assert.equal(engine.entries.get('s').dirtyTo,2801);const data=engine.get('s');assert.equal(data.outputs.value[256],20);assert.equal(data.outputs.value[2800],15);
  const fresh=new IndicatorEngine(store);try{assertVectors(data.outputs,fresh.add('s','sma',{period:2}).outputs);}finally{fresh.dispose();}
 }finally{engine.dispose();}
});

test('sparse merges retain scalar floating-point tree results for noninteger volumes',()=>{
 const input=Array.from({length:31},(_,i)=>bar(T+i*60000,(i+1)/10,i%3===0?1e15:(i+1)/10)),store=new BarStore(input),reference=new BarStore(input);
 const events=[{kind:'correction',bar:bar(T+2*60000,.4,.7)},{kind:'update',bar:bar(T+30*60000,3.2,1e15+.5)},{kind:'append',bar:bar(T+31*60000,3.3,.9)},{kind:'correction',bar:bar(T+8*60000,.9,1e15+1)}];
 apply(store,events);scalar(reference,events);assert.deepEqual(['min','max','sum'].map(k=>Array.from(store.index[k])),['min','max','sum'].map(k=>Array.from(reference.index[k])));
});

test('35 builtins and linked module match scalar and fresh full vectors after irregular corrections',()=>{
 const columns=seededColumns(600,123);for(let i=0;i<600;i++)columns.time[i]=T+i*60000+(i>=200?3600000:0)+(i>=400?86400000:0);
 const store=new BarStore(),reference=new BarStore();store.setColumns(columns);reference.setColumns(columns);const batchEngine=new IndicatorEngine(store),scalarEngine=new IndicatorEngine(reference),params={period:5,fast:3,slow:7,signal:4,smoothK:2,smoothD:2,conversion:3,base:5,span:7,displacement:2};
 const names=[...builtinIndicators.keys(),'aster.volume-direction@1/pressure'];
 try{for(const name of names){const input=name.includes('@')?{factor:.5,shift:-2}:params;batchEngine.add(name,name,input);scalarEngine.add(name,name,input);}
  const changed=(i,v)=>({...store.at(i),open:v,high:v+1,low:v-1,close:v,volume:i+5});
  const tail=store.at(599),events=[{kind:'correction',bar:changed(0,110)},{kind:'correction',bar:changed(256,90)},{kind:'correction',bar:changed(512,120)},{kind:'update',bar:changed(599,115)},{kind:'append',bar:bar(tail.time+120000,116,9)},{kind:'update',bar:bar(tail.time+120000,117,11)},{kind:'correction',bar:changed(257,95)}];
  apply(store,events);scalar(reference,events);assert.deepEqual(rows(store),rows(reference));
  const fresh=new IndicatorEngine(store);try{for(const name of names){const input=name.includes('@')?{factor:.5,shift:-2}:params;const data=batchEngine.get(name);assertVectors(data.outputs,scalarEngine.get(name).outputs);assertVectors(data.outputs,fresh.add(name,name,input).outputs);assert.deepEqual(data.plotOffsets,scalarEngine.get(name).plotOffsets);}}finally{fresh.dispose();}
 }finally{batchEngine.dispose();scalarEngine.dispose();}
});

test('index-dependent custom state and offsets keep original history indices',()=>{
 const store=new BarStore(Array.from({length:400},(_,i)=>bar(T+i*60000+(i>=200?3600000:0),i%7+1))),engine=new IndicatorEngine(store);
 engine.register('indexed',()=>({outputs:['index','weighted'],plotOffsets:{index:-3,weighted:2},create(){let weighted=0;return {step(b,i){weighted+=i*b.close;return [i,weighted];},snapshot:()=>weighted,restore:value=>{weighted=value;}};}}));
 try{engine.add('i','indexed');const tail=store.at(399);apply(store,[{kind:'correction',bar:bar(store.at(255).time,10)},{kind:'correction',bar:bar(store.at(257).time,20)},{kind:'append',bar:bar(tail.time+120000,30)}]);
  const data=engine.get('i');let weighted=0;for(let i=0;i<store.length;i++){weighted+=i*store.at(i).close;assert.equal(data.outputs.index[i],i);assert.equal(data.outputs.weighted[i],weighted);}assert.deepEqual(data.plotOffsets,{index:-3,weighted:2});assert.equal(store.at(0).time,T);assert.equal(store.length,401);
 }finally{engine.dispose();}
});

test('lazy custom calculation error after commit does not roll back data',()=>{
 const store=new BarStore([bar(T,1)]),engine=new IndicatorEngine(store);
 engine.register('fault',()=>({outputs:['value'],create(){return {step(b){if(b.close===7)throw new Error('trusted calculation failed');return [b.close];},snapshot:()=>0,restore(){}};}}));
 try{engine.add('f','fault');const receipt=apply(store,[{kind:'update',bar:bar(T,7)}]);assert.throws(()=>engine.get('f'),/trusted calculation failed/);assert.equal(store.at(0).close,7);assert.equal(store.version,receipt.version);assert.equal(store.pendingChanges.length,0);}finally{engine.dispose();}
});
