import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const modules=()=>import('../src/core/indicator-modules.mjs');
function fixtureFactory(){return {outputs:['value'],create(){let n=0;return {step:b=>[b.close+n++*0],snapshot:()=>({n}),restore:s=>{n=s.n;}};}};}
function fixtureCodec(_params,state,index){if(!state||Object.keys(state).length!==1||state.n!==index)throw new TypeError('fixture checkpoint');}

test('startup module catalog exposes immutable canonical metadata and detached maps',async()=>{
 const m=await modules();m.defineIndicatorModule({id:'test.catalog',version:1,stateVersion:1,indicators:{close:{factory:fixtureFactory,validateCheckpoint:fixtureCodec,causal:true}}});
 const name='test.catalog@1/close',metadata=m.indicatorModule(name);
 assert.deepEqual(metadata,{id:'test.catalog',version:1,stateVersion:1,exportName:'close',causal:true});assert.equal(Object.isFrozen(metadata),true);
 assert.equal(m.portableIndicatorFactory(name),fixtureFactory);assert.equal(m.requirePortableIndicator(name,fixtureFactory),metadata);
 const copy=m.portableIndicatorFactories();copy.delete(name);assert.equal(m.portableIndicatorFactory(name),fixtureFactory);
 const records=m.indicatorModuleDefinitions('test.catalog',1);assert.equal(Object.isFrozen(records),true);assert.equal(records[0].name,name);assert.equal(records[0].factory,fixtureFactory);
 assert.throws(()=>m.requirePortableIndicator(name,fixtureFactory.bind(null)),e=>e.name==='UnsupportedIndicatorError');
 assert.throws(()=>m.requirePortableIndicator('alias',fixtureFactory),e=>e.name==='UnsupportedIndicatorError');
 assert.throws(()=>m.indicatorModuleDefinitions('test.catalog',2),e=>e.name==='UnsupportedIndicatorError');
 assert.throws(()=>m.defineIndicatorModule({id:'test.catalog',version:1,stateVersion:1,indicators:{close:{factory:fixtureFactory,validateCheckpoint:fixtureCodec,causal:true}}}),/duplicate|already/i);
});

test('module checkpoint validation applies generic limits before its trusted codec',async()=>{
 const m=await modules(),name='test.catalog@1/close';assert.deepEqual(m.validateModuleCheckpoint(name,{}, {n:2},2),{n:2});
 assert.throws(()=>m.validateModuleCheckpoint(name,{}, {n:3},2),/fixture/);
 assert.throws(()=>m.validateModuleCheckpoint(name,{}, {n:2,fn(){}},2),/unsupported/);
 let deep={n:2};for(let i=0;i<40;i++)deep={nested:deep};assert.throws(()=>m.validateModuleCheckpoint(name,{},deep,2),/limit/);
 assert.throws(()=>m.validateModuleCheckpoint(name,{}, {get n(){throw Error('getter ran');}},2),/accessor/);
});

test('trusted codec cannot repair, mutate or asynchronously approve checkpoint state',async()=>{
 const m=await modules();m.defineIndicatorModule({id:'test.validators',version:1,stateVersion:1,indicators:{
  false:{factory:fixtureFactory,causal:true,validateCheckpoint:()=>false},
  mutate:{factory:fixtureFactory,causal:true,validateCheckpoint(_p,s){s.n=0;return s;}},
  replace:{factory:fixtureFactory,causal:true,validateCheckpoint:()=>({n:0})},
  async:{factory:fixtureFactory,causal:true,validateCheckpoint:async()=>{throw new Error('async codec');}}
 }});
 for(const name of ['false','mutate','replace','async']){const state={n:2};assert.throws(()=>m.validateModuleCheckpoint('test.validators@1/'+name,{},state,2),/checkpoint|synchronous/i);assert.deepEqual(state,{n:2});}
});

test('generic module state preserves nonfinite sentinels, negative zero and Unicode exactly',async()=>{
 const m=await modules();m.defineIndicatorModule({id:'test.numeric',version:1,stateVersion:1,indicators:{state:{factory:fixtureFactory,causal:true,validateCheckpoint(_params,state){assert.equal(Object.is(state.zero,-0),true);assert.equal(Number.isNaN(state.nan),true);assert.equal(state.infinity,Infinity);assert.equal(state.text,'한국 🚀');return state;}}}});
 const state={zero:-0,nan:NaN,infinity:Infinity,text:'한국 🚀'};assert.equal(m.validateModuleCheckpoint('test.numeric@1/state',{},state,0),state);assert.equal(Object.is(state.zero,-0),true);
});

async function runtime(){return {...await import('../src/core/index.mjs'),...await import('../src/core/async-state.mjs'),...await import('../src/core/prepare-state.mjs'),...await import('../src/web/worker-state.mjs'),...await import('../src/web/compute-worker.mjs'),...await import('../src/web/worker.mjs'),...await import('../src/web/checkpoint-codec.mjs')};}
const sample='aster.volume-direction@1/pressure';
function model(r,n=550){const store=new r.BarStore();store.setColumns(r.seededColumns(n,47));const m=new r.ChartModel({store});m.indicators.add('pressure',sample,{factor:.5,shift:-2});for(const output of ['signed','cumulative'])m.addSeries({id:output,type:'line',panel:'price',indicator:'pressure',output});return m;}
const event=m=>({kind:'correction',bar:{...m.store.at(257),volume:4321}});
function captured(r,capture){const target=new r.AsyncPrepared(capture.metadataJSON);for(let slot=0;slot<capture.buffers.length;slot++){const array=capture.buffers[slot];target.target(slot,0,array.length).set(capture.buffer(slot,0,array.length));}for(let entry=0;entry<capture.checkpoints.length;entry++){const row=capture.checkpoints[entry];for(let i=0;i<row.keys.length;i++)target.checkpoint(entry,capture.checkpoint(entry,i,1));}target.start();while(!target.step(31).complete){}return target;}
function fake(r){const previous=globalThis.Worker,workers=[];globalThis.Worker=class{constructor(){this.terminations=0;workers.push(this);}postMessage(request){this.request=structuredClone(request);}terminate(){this.terminations++;}async packet(){return r.computeRequest(this.request);}async complete(){this.onmessage({data:{packet:await this.packet()}});}};return {workers,restore(){globalThis.Worker=previous;}};}

test('static linked sample has exact browser packet and checkpoint roundtrip parity',async()=>{
 const r=await runtime(),source=model(r);let restored;
 try{const options=r.modelRequest(source),packet=await r.computeRequest({columns:source.store.columns,length:550,options});assert.deepEqual(options.indicators[0].module,(await modules()).indicatorModule(sample));restored=r.hydrateModel(packet,options);assert.deepEqual(restored.indicators.get('pressure').outputs,source.indicators.get('pressure').outputs);assert.equal(restored.indicators.entries.get('pressure').checkpoints.cache.size,0);assert.deepEqual(restored.indicators.get('pressure').plotOffsets,{signed:-2,cumulative:-2});}finally{source.dispose();restored?.dispose();}
});

test('native correction import validates module state and preserves full vectors and offsets',async()=>{
 const r=await runtime(),source=model(r),expected=model(r);let target;
 try{const correction=event(source),capture=new r.AsyncCapture(source,correction);assert.deepEqual(JSON.parse(capture.metadataJSON).indicators[0].module,(await modules()).indicatorModule(sample));target=captured(r,capture);const result=target.finish(capture.ui(null,{width:800,height:500})).model;expected.store.update(257,correction.bar);assert.deepEqual(result.indicators.get('pressure').outputs,expected.indicators.get('pressure').outputs);assert.deepEqual(result.series.map(s=>s.offset),[-2,-2]);}finally{source.dispose();expected.dispose();target?.dispose();}
});

test('native fresh preparation resolves the same linked module from declarative definitions',async()=>{
 const r=await runtime(),source=model(r,0),columns=r.seededColumns(550,47),expected=model(r);let target;
 try{const capture=new r.PrepareCapture(source,{kind:'columns',length:550}),meta=JSON.parse(capture.metadataJSON);assert.deepEqual(meta.indicators[0].module,(await modules()).indicatorModule(sample));target=new r.PreparedData(capture.metadataJSON);for(let slot=0;slot<6;slot++)target.target(slot,0,550).set(columns[r.FIELDS[slot]]);target.start();while(!target.step(31).complete){}const result=target.finish(capture.ui(null,{width:800,height:500})).model;assert.deepEqual(result.indicators.get('pressure').outputs,expected.indicators.get('pressure').outputs);}finally{source.dispose();expected.dispose();target?.dispose();}
});

test('module descriptor, missing versions and malformed state reject before publication',async()=>{
 const r=await runtime(),source=model(r),before=source.store.at(257),version=source.store.version,options=r.modelRequest(source),packet=await r.computeRequest({columns:source.store.columns,length:550,options,event:event(source)});
 try{
  for(const change of [p=>p.indicators[0].module.stateVersion++,p=>delete p.indicators[0].module,p=>p.options.indicators[0].module.exportName='other',p=>p.indicators[0].module.extra=true,p=>{const lazy=new r.LazyCheckpoints(p.indicators[0].checkpoints),map=new Map(lazy);map.set(0,{previous:NaN,cumulative:1});p.indicators[0].checkpoints=r.encodeCheckpoints(map);}]){const bad=structuredClone(packet);change(bad);assert.throws(()=>r.installRecomputed(source,bad,event(source),options),/module|checkpoint/i);assert.deepEqual(source.store.at(257),before);assert.equal(source.store.version,version);}
  await assert.rejects(r.prepareChartModel({columns:r.seededColumns(4),options:{indicators:[{id:'missing',name:'aster.volume-direction@2/pressure',params:{}}]}}),e=>e.name==='UnsupportedIndicatorError');
  const capture=new r.PrepareCapture(source,{kind:'seeded',count:550}),meta=JSON.parse(capture.metadataJSON);meta.indicators[0].module.stateVersion++;assert.throws(()=>new r.PreparedData(JSON.stringify(meta)),/module/);
  const asyncMeta=JSON.parse(new r.AsyncCapture(source,event(source)).metadataJSON);asyncMeta.indicators[0].module.version++;assert.throws(()=>new r.AsyncPrepared(JSON.stringify(asyncMeta)),/module/);
 }finally{source.dispose();}
});

test('naked, wrapped, bound and source factories remain explicitly async unsupported',async()=>{
 const r=await runtime(),m=await modules();
 for(const kind of ['naked','wrapped','bound','source']){const source=model(r,0);try{const api=new r.ChartAPI(source),factory=m.portableIndicatorFactory(sample);if(kind==='source')api.registerIndicatorSource('legacy','()=>({outputs:["value"],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}}}})');else source.indicators.register('legacy',kind==='naked'?fixtureFactory:kind==='bound'?factory.bind(null):params=>factory(params));source.indicators.add('legacy','legacy');assert.throws(()=>r.modelRequest(source),e=>e.name==='UnsupportedIndicatorError');assert.throws(()=>new r.PrepareCapture(source,{kind:'seeded',count:4}),e=>e.name==='UnsupportedIndicatorError');}finally{source.dispose();}}
});

test('native correction source ownership includes the store object even at the same version',async()=>{
 const r=await runtime(),source=model(r),capture=new r.AsyncCapture(source,event(source)),replacement=new r.BarStore();replacement.setColumns(r.seededColumns(550,47));assert.equal(replacement.version,source.store.version);
 try{source.store=replacement;assert.throws(()=>capture.check(),/stale/);}finally{source.dispose();}
});

test('module native snapshots use one bounded checkpoint record per import chunk',async()=>{
 const r=await runtime(),source=model(r);try{const capture=new r.AsyncCapture(source,event(source));assert.equal(capture.checkpoints[0].maxRows,1);assert.throws(()=>capture.checkpoint(0,0,2),/slice/);}finally{source.dispose();}
});

test('public browser prepare/recompute accepts linked modules and still rejects owner reentry as stale',async()=>{
 const r=await runtime(),f=fake(r),source=model(r);let prepared;
 try{const request={columns:source.store.columns,length:550,options:r.modelRequest(source)},preparing=r.prepareChartModel(request);await f.workers[0].complete();prepared=await preparing;assert.deepEqual(prepared.indicators.get('pressure').outputs,source.indicators.get('pressure').outputs);
  const corrected=r.recomputeInWorker(source,event(source));await f.workers.at(-1).complete();assert.equal(await corrected,source);assert.equal(source.store.at(257).volume,4321);
  let changed=false;const pending=r.recomputeInWorker(source,event(source),{onProgress:p=>{if(p.phase==='validation'&&!changed){changed=true;source.store.update(258,{...source.store.at(258),volume:9876});}}});await f.workers.at(-1).complete();await assert.rejects(pending,/stale/);assert.equal(source.store.at(258).volume,9876);assert.ok(f.workers.every(w=>w.terminations===1));
 }finally{source.dispose();prepared?.dispose();f.restore();}
});

test('module codec reentry on the owner discards a fully computed worker reply',async()=>{
 const r=await runtime(),m=await modules();let owner,armed=false,changed=false;
 m.defineIndicatorModule({id:'test.reentry',version:1,stateVersion:1,indicators:{close:{factory:fixtureFactory,causal:true,validateCheckpoint(params,state,index){fixtureCodec(params,state,index);if(armed&&!changed){changed=true;owner.store.update(1,{...owner.store.at(1),volume:9876});}}}}});
 owner=new r.ChartModel({store:new r.BarStore()});owner.store.setColumns(r.seededColumns(32));owner.indicators.add('r','test.reentry@1/close');const f=fake(r),before=owner.store.at(0);
 try{const pending=r.recomputeInWorker(owner,{kind:'correction',bar:{...before,volume:4321}}),packet=await f.workers[0].packet();armed=true;f.workers[0].onmessage({data:{packet}});await assert.rejects(pending,/stale/);assert.equal(changed,true);assert.deepEqual(owner.store.at(0),before);assert.equal(owner.store.at(1).volume,9876);assert.equal(f.workers[0].terminations,1);}finally{owner.dispose();f.restore();}
});

test('calendar VWAP/bands and pivots survive browser prepare/correction with NY DST and holiday literals',async()=>{
 const r=await runtime(),{portableSessionCalendar}=await import('../src/core/session-studies.mjs');
 const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}],exceptions:{'2026-03-10':[]}});
 const times=['2026-03-06T14:30:00Z','2026-03-06T14:31:00Z','2026-03-09T13:30:00Z','2026-03-09T13:31:00Z','2026-03-10T13:30:00Z','2026-03-11T13:30:00Z'],prices=[10,14,20,24,30,40],volumes=[1,3,2,2,1,1],bars=times.map((time,i)=>({time:Date.parse(time),open:prices[i],high:prices[i],low:prices[i],close:prices[i],volume:volumes[i]}));
 const options={indicators:[{id:'v',name:'vwap',params:{calendar,source:'close',deviation:2}},{id:'p',name:'pivots',params:{calendar}}],series:[{id:'v',type:'line',panel:'price',indicator:'v'},{id:'p',type:'line',panel:'price',indicator:'p',output:'pivot'}]},f=fake(r);let prepared;
 try{const pending=r.prepareChartModel({bars,options});await f.workers[0].complete();prepared=await pending;const output=prepared.indicators.get('v').outputs,pivots=prepared.indicators.get('p').outputs;
  assert.deepEqual(Array.from(output.value),[10,13,20,22,NaN,40]);assert.deepEqual(Array.from(output.deviation),[0,Math.sqrt(3),0,2,NaN,0]);assert.deepEqual(Array.from(pivots.pivot),[NaN,NaN,38/3,38/3,NaN,68/3]);assert.equal(output.upper[3],26);assert.equal(output.lower[3],18);
  const correction={kind:'correction',bar:{...bars[3],open:28,high:28,low:28,close:28}},updating=r.recomputeInWorker(prepared,correction);await f.workers.at(-1).complete();await updating;assert.equal(prepared.indicators.get('v').outputs.value[3],24);assert.equal(prepared.indicators.get('p').outputs.pivot[5],76/3);assert.ok(f.workers.every(w=>w.terminations===1));
 }finally{prepared?.dispose();f.restore();}
});

test('actual worker entry reports an owner-only static module as unsupported and transports its typed error',async()=>{
 const r=await runtime(),m=await modules();m.defineIndicatorModule({id:'test.worker-owner',version:1,stateVersion:1,indicators:{close:{factory:fixtureFactory,validateCheckpoint:fixtureCodec,causal:true}}});
 const source=new r.ChartModel({store:new r.BarStore()}),directory=await mkdtemp(join(tmpdir(),'aster-module-worker-'));let worker;
 source.store.setColumns(r.seededColumns(4));source.indicators.add('local','test.worker-owner@1/close');const before=source.store.at(0),version=source.store.version;
 try{
  // Node's native Worker supplies a separate realm. Only the test adapter maps
  // its message API; SDK entry/catalog/calculation code remains unchanged.
  await writeFile(join(directory,'environment.mjs'),"import {parentPort} from 'node:worker_threads';\nglobalThis.self={postMessage:packet=>parentPort.postMessage(packet)};\nparentPort.on('message',data=>self.onmessage({data}));\n");
  await writeFile(join(directory,'entry.mjs'),"import './environment.mjs';\nimport "+JSON.stringify(new URL('../src/web/worker-entry.mjs',import.meta.url).href)+";\n");
  worker=new NodeWorker(join(directory,'entry.mjs'));
  const packet=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker entry did not reply')),5000);worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.postMessage({columns:source.store.columns,length:4,options:r.modelRequest(source)});});
  assert.equal(packet.errorName,'UnsupportedIndicatorError');assert.equal(packet.errorCode,'UNSUPPORTED_INDICATOR_MODULE');assert.match(packet.error,/test.worker-owner@1\/close/);assert.equal(packet.packet,undefined);assert.deepEqual(source.store.at(0),before);assert.equal(source.store.version,version);
  const f=fake(r);try{const pending=r.runChartWorker({});f.workers[0].onmessage({data:packet});await assert.rejects(pending,e=>e instanceof m.UnsupportedIndicatorError&&e.code==='UNSUPPORTED_INDICATOR_MODULE');assert.equal(f.workers[0].terminations,1);}finally{f.restore();}
 }finally{await worker?.terminate();source.dispose();await rm(directory,{recursive:true,force:true});}
});
