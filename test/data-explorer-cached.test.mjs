import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI,ChartModel,IndicatorEngine,builtinIndicators,defineIndicatorModule} from '../src/core/index.mjs';

const rows=(length=18)=>Array.from({length},(_,i)=>({time:1700000000000+i*60000,open:20+i,high:23+i,low:19+i,close:21+i,volume:100+i}));
function fixture(length=18){const model=new ChartModel(),api=new ChartAPI(model),bars=rows(length);api.setData(bars);return {model,api,store:model.store,bars};}
function line(api,extra={}){api.addSeries({id:'line',type:'line',panel:'price',...extra});}
function custom(f,{name='cached-custom',outputs=['value'],step=bar=>[bar.close]}={}){f.api.registerIndicator(name,()=>({outputs,plotOffsets:{},create:()=>({step,snapshot:()=>({}),restore(){}})}));f.api.addIndicator('custom',name);}
function entryState(entry){return {dirty:entry.dirty,dirtyTo:entry.dirtyTo,invalidated:entry.invalidated,length:entry.length,revision:entry.revision,arrays:entry.arrays,vectors:[...entry.arrays],values:entry.arrays.map(a=>[...a])};}

test('all 35 canonical builtins match warm calculate results for finite values and gaps',()=>{
 const f=fixture(700);try{assert.equal(builtinIndicators.size,35);for(const [name] of builtinIndicators){const id='i-'+name;f.api.addIndicator(id,name,{});const outputs=f.model.indicators.entries.get(id).def.outputs;for(const output of outputs)line(f.api,{id:id+'-'+output,indicator:id,output});}for(const index of [0,699]){const calculated=f.api.dataAt({index}),cached=f.api.dataAt({index},{indicatorMode:'cached'});assert.deepEqual(cached,calculated);assert.ok(cached.series.every(row=>row.causality==='canonical-builtin'));assert.ok(cached.series.some(row=>row.status==='non-finite')||index===699);}}
 finally{f.model.dispose();}
});

test('cached and explicit calculate modes preserve exact selection, offsets and hidden canonical rows',()=>{
 const f=fixture(32);f.api.addIndicator('m','macd',{fast:3,slow:6,signal:2});line(f.api,{id:'macd',indicator:'m',output:'macd',offset:1});line(f.api,{id:'signal',indicator:'m',output:'signal',offset:-1});line(f.api,{id:'hidden',indicator:'m',output:'histogram',visible:false});
 try{const query={time:f.bars[12].time,match:'exact'},expected=f.api.dataAt(query,{indicatorMode:'calculate',includeHidden:true}),actual=f.api.dataAt(query,{indicatorMode:'cached',includeHidden:true});assert.deepEqual(actual,expected);assert.equal(actual.series[0].sourceIndex,11);assert.equal(actual.series[1].sourceIndex,13);assert.equal(actual.series[2].visible,false);}
 finally{f.model.dispose();}
});

for(const mutation of ['update','append','reset','compact','suspended'])test('canonical '+mutation+' cache is pending without lazy work or state mutation',()=>{
 const f=fixture(mutation==='compact'?32:18);f.api.addIndicator('s','sma',{period:3});line(f.api,{indicator:'s'});const entry=f.model.indicators.entries.get('s');let task,index=3;
 if(mutation==='update')f.store.update(0,{...f.store.at(0),close:30,high:30});
 if(mutation==='append'){const last=f.store.at(f.store.length-1);f.store.append({...last,time:last.time+60000,open:last.open+1,high:last.high+1,low:last.low+1,close:last.close+1,volume:last.volume+1});index=f.store.length-1;}
 if(mutation==='reset')f.api.setData(rows(18).map((bar,i)=>({...bar,open:bar.open+i,high:bar.high+i,low:bar.low+i,close:bar.close+i})));
 if(mutation==='compact')f.api.compactData({keepLastBars:8,studyHistory:'restart'});
 if(mutation==='suspended'){f.store.update(0,{...f.store.at(0),close:30,high:30});task=f.model.indicators.calculate('s',2);assert.equal(task.next().done,false);index=10;}
 const before=entryState(entry),version=f.store.version,view=f.model.view,viewValue={...view},originalGet=IndicatorEngine.prototype.get,originalCalculate=IndicatorEngine.prototype.calculate;
 try{IndicatorEngine.prototype.get=()=>{throw new Error('cached get executed');};IndicatorEngine.prototype.calculate=function*(){throw new Error('cached calculate executed');};const row=f.api.dataAt({index},{indicatorMode:'cached'}).series[0];assert.equal(row.status,'pending');assert.equal(row.value,null);assert.equal(row.sourceIndex,index);assert.equal(row.sourceTime,f.store.columns.time[index]);assert.deepEqual(entryState(entry),before);assert.equal(f.store.version,version);assert.strictEqual(f.model.view,view);assert.deepEqual(f.model.view,viewValue);}
 finally{IndicatorEngine.prototype.get=originalGet;IndicatorEngine.prototype.calculate=originalCalculate;task?.return();f.model.dispose();}
});

test('status precedence remains outside, cutoff, causality, cache support, then pending',()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{id:'outside',indicator:'s',offset:10});line(f.api,{id:'after',indicator:'s',offset:-2});line(f.api,{id:'pending',indicator:'s'});custom(f);line(f.api,{id:'custom-line',indicator:'custom'});f.store.update(0,{...f.store.at(0),close:30,high:30});
 try{const canonical=f.api.dataAt({index:4},{asOfIndex:4,indicatorMode:'cached'}).series.slice(0,3);assert.deepEqual(canonical.map(row=>row.status),['outside-source','after-cutoff','pending']);assert.equal(canonical[2].sourceIndex,4);assert.equal(f.api.dataAt({index:4},{asOfIndex:4,indicatorMode:'cached'}).series[3].status,'unsupported-causality');const current=f.api.dataAt({index:7},{indicatorMode:'cached'}).series[3];assert.equal(current.status,'unsupported-cache');assert.equal(current.value,null);assert.equal(current.sourceIndex,7);assert.equal(current.sourceTime,f.bars[7].time);}
 finally{f.model.dispose();}
});

test('clean and dirty custom caches are unsupported and execute no indicator code',()=>{
 const f=fixture(8);let calls=0,armed=false;custom(f,{step:bar=>{calls++;if(armed)throw new Error('custom executed');return[bar.close];}});line(f.api,{indicator:'custom'});calls=0;const originalGet=IndicatorEngine.prototype.get,originalCalculate=IndicatorEngine.prototype.calculate;
 try{armed=true;IndicatorEngine.prototype.get=()=>{throw new Error('get executed');};IndicatorEngine.prototype.calculate=function*(){throw new Error('calculate executed');};for(const dirty of [false,true]){if(dirty)f.store.update(0,{...f.store.at(0),close:30,high:30});const row=f.api.dataAt({index:7},{indicatorMode:'cached'}).series[0];assert.equal(row.status,'unsupported-cache');assert.equal(row.value,null);assert.equal(row.sourceIndex,7);assert.equal(calls,0);}IndicatorEngine.prototype.get=originalGet;IndicatorEngine.prototype.calculate=originalCalculate;armed=false;assert.equal(f.api.dataAt({index:0}).series[0].value,30);assert.ok(calls>0);}
 finally{IndicatorEngine.prototype.get=originalGet;IndicatorEngine.prototype.calculate=originalCalculate;armed=false;f.model.dispose();}
});

test('unsupported custom cache internals are not inspected or invoked',()=>{
 const f=fixture(8);custom(f);line(f.api,{indicator:'custom'});const entry=f.model.indicators.entries.get('custom');let reads=0;Object.defineProperty(entry,'dirty',{configurable:true,get(){reads++;throw new Error('dirty getter');}});Object.defineProperty(entry,'arrays',{configurable:true,get(){reads++;throw new Error('arrays getter');}});
 try{const row=f.api.dataAt({index:7},{indicatorMode:'cached'}).series[0];assert.equal(row.status,'unsupported-cache');assert.equal(row.sourceIndex,7);assert.equal(reads,0);}
 finally{f.model.dispose();}
});

test('retained custom output aliases and linked studies stay unsupported in cached mode',()=>{
 const outputs=['price','volume'],f=fixture(8);custom(f,{outputs,step:bar=>[bar.close,bar.volume]});line(f.api,{indicator:'custom',output:'price'});
 const linkedOutputs=['price','volume'],moduleId='test.cached-unsupported';const [{name}]=defineIndicatorModule({id:moduleId,version:1,stateVersion:1,indicators:{pair:{causal:true,validateCheckpoint:()=>true,factory:()=>({outputs:linkedOutputs,plotOffsets:{},create:()=>({step:bar=>[bar.close,bar.volume],snapshot:()=>({}),restore(){}})})}}});f.api.registerIndicatorModule(moduleId,1);f.api.addIndicator('linked',name);line(f.api,{id:'linked-line',indicator:'linked',output:'price'});
 try{outputs.reverse();for(const index of [3,7]){const result=f.api.dataAt({index},{indicatorMode:'cached'}).series;assert.ok(result.every(row=>row.status==='unsupported-cache'));assert.ok(result.every(row=>row.sourceIndex===index));}assert.equal(f.api.dataAt({index:3}).series[0].value,f.bars[3].volume);}
 finally{f.model.dispose();}
});

for(const alteration of ['create','outputs','offsets','registry'])test('altered canonical '+alteration+' definition is unsupported in cached mode',()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});const entry=f.model.indicators.entries.get('s');if(alteration==='create')entry.def.create=()=>({step:bar=>[bar.close],snapshot:()=>({}),restore(){}});if(alteration==='outputs')entry.def.outputs=['other'];if(alteration==='offsets')entry.def.plotOffsets.value=1;if(alteration==='registry')f.model.indicators.registry.set('sma',()=>entry.def);
 try{const row=f.api.dataAt({index:7},{indicatorMode:'cached'}).series[0];assert.equal(row.causality,'unverified-study');assert.equal(row.status,'unsupported-cache');assert.equal(row.sourceIndex,7);}
 finally{f.model.dispose();}
});

test('checkpoint convergence below length remains a canonical cache hit',()=>{
 const f=fixture(600);f.api.addIndicator('s','sma',{period:3});line(f.api,{indicator:'s'});f.store.update(0,{...f.store.at(0)});f.model.indicators.get('s');
 try{const entry=f.model.indicators.entries.get('s');assert.ok(entry.computedUntil<f.store.length);assert.equal(entry.dirty,f.store.length);assert.equal(entry.dirtyTo,0);assert.equal(entry.invalidated,false);assert.deepEqual(f.api.dataAt({index:500},{indicatorMode:'cached'}).series[0],f.api.dataAt({index:500}).series[0]);}
 finally{f.model.dispose();}
});

test('validated worker hydration is immediately readable for canonical caches',async()=>{
 const f=fixture(32);f.api.addIndicator('s','sma',{period:3});line(f.api,{indicator:'s'});const {packModel,modelRequest,hydrateModel,validatePreparedPacketAsync}=await import('../src/web/worker-state.mjs');let restored;
 try{const options=modelRequest(f.model),packet=structuredClone(packModel(f.model)),validation=await validatePreparedPacketAsync(packet,options,{yieldTask:()=>Promise.resolve()});restored=hydrateModel(packet,options,validation);assert.deepEqual(new ChartAPI(restored).dataAt({index:12},{indicatorMode:'cached'}),new ChartAPI(restored).dataAt({index:12}));}
 finally{restored?.dispose();f.model.dispose();}
});

test('validated async parameter replacement is immediately readable for canonical caches',async()=>{
 const f=fixture(32);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});const {setIndicatorParamsAsync}=await import('../src/web/indicator-params-async.mjs'),{computeIndicatorParamsRequest}=await import('../src/web/indicator-params-worker.mjs');const workerFactory=()=>({onmessage:null,onerror:null,postMessage(request,transfer){const packet=computeIndicatorParamsRequest(structuredClone(request,{transfer}));queueMicrotask(()=>this.onmessage?.({data:packet}));},terminate(){}});
 try{await setIndicatorParamsAsync(f.api,'s',{period:3},{workerFactory});assert.deepEqual(f.api.dataAt({index:12},{indicatorMode:'cached'}),f.api.dataAt({index:12}));}
 finally{f.model.dispose();}
});

test('validated native parameter import is immediately readable for canonical caches',async()=>{
 const f=fixture(32);f.api.addIndicator('s','sma',{period:3});line(f.api,{indicator:'s'});const [{NativeParamsTarget},{NativeParamsImport},{safeCheckpointStringify},{prepareNativeEntryCommit},{FIELDS}]=await Promise.all([import('../src/core/native-params-target.mjs'),import('../src/core/native-params-import.mjs'),import('../src/core/checkpoint-validation.mjs'),import('../src/core/native-checkpoints.mjs'),import('../src/core/data.mjs')]),entry=f.model.indicators.entries.get('s'),binding={schema:'aster.native-params-target',version:1,registration:1,id:'s',name:'sma',params:{period:3},length:f.store.length,capacity:f.store.capacity,outputs:[...entry.def.outputs],plotOffsets:{...entry.def.plotOffsets},maxBytes:805306368},target=new NativeParamsTarget(safeCheckpointStringify(binding));let stage;
 try{for(let j=0;j<FIELDS.length;j++)target.target(j,0,f.store.length).set(f.store.columns[FIELDS[j]].subarray(0,f.store.length));target.start();while(!target.step(256).complete){}stage=new NativeParamsImport(safeCheckpointStringify(target.descriptor()),binding,entry.def);for(let j=0;j<binding.outputs.length;j++)for(let at=0;at<binding.capacity;at+=17){const count=Math.min(17,binding.capacity-at);stage.target(j,at,count).set(target.outputBuffer(j,at,count));}for(let i=0;i<target.descriptor().checkpointCount;i++){const checkpoint=target.checkpoint(i);stage.checkpoint(checkpoint.index,checkpoint.text);}stage.start();while(!stage.step(31).complete){}prepareNativeEntryCommit(f.model.indicators.entries,'s',entry,stage.readyEntry())();stage.releasePublished();assert.deepEqual(f.api.dataAt({index:12},{indicatorMode:'cached'}),f.api.dataAt({index:12}));}
 finally{stage?.dispose();target.dispose();f.model.dispose();}
});

test('cached canonical reads invoke no layout formatter and preserve source, cache, history and view',()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});f.model.panels[0].formatter=()=>{throw new Error('formatter executed');};f.api.addAxis({id:'right',panel:'price',formatter:()=>{throw new Error('axis formatter executed');}});f.api.addDrawing({id:'d',type:'horizontal',points:[{time:f.bars[0].time,price:20}]});const entry=f.model.indicators.entries.get('s'),before=entryState(entry),view=f.model.view,viewValue={...view},version=f.store.version,drawings=f.api.saveDrawings(),undo=JSON.stringify(f.model.drawings.undoStack),originalGet=IndicatorEngine.prototype.get,originalCalculate=IndicatorEngine.prototype.calculate;
 try{IndicatorEngine.prototype.get=()=>{throw new Error('get executed');};IndicatorEngine.prototype.calculate=function*(){throw new Error('calculate executed');};assert.equal(f.api.dataAt({index:3},{indicatorMode:'cached'}).series[0].status,'value');assert.deepEqual(entryState(entry),before);assert.equal(f.store.version,version);assert.strictEqual(f.model.view,view);assert.deepEqual(f.model.view,viewValue);assert.equal(f.api.saveDrawings(),drawings);assert.equal(JSON.stringify(f.model.drawings.undoStack),undo);}
 finally{IndicatorEngine.prototype.get=originalGet;IndicatorEngine.prototype.calculate=originalCalculate;f.model.dispose();}
});

test('cached option and managed cache accessors reject without invoking getters',()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});const entry=f.model.indicators.entries.get('s');let reads=0;
 try{assert.throws(()=>f.api.dataAt({index:2},{get indicatorMode(){reads++;return'cached';}}),/own data/);assert.equal(reads,0);const dirty=entry.dirty;Object.defineProperty(entry,'dirty',{configurable:true,get(){reads++;return dirty;}});assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),/own data/);assert.equal(reads,0);Object.defineProperty(entry,'dirty',{value:dirty,writable:true,configurable:true,enumerable:true});const arrays=entry.arrays;Object.defineProperty(entry,'arrays',{configurable:true,get(){reads++;return arrays;}});assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),/own data/);assert.equal(reads,0);Object.defineProperty(entry,'arrays',{value:arrays,writable:true,configurable:true,enumerable:true});const value=arrays[0];Object.defineProperty(arrays,'0',{configurable:true,get(){reads++;return value;}});assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),/own data/);assert.equal(reads,0);Object.defineProperty(arrays,'0',{value,writable:true,configurable:true,enumerable:true});}
 finally{f.model.dispose();}
});

test('intrinsic cached vector slots ignore disguises and reject shared backing',()=>{
 for(const mode of ['own-length','shared']){const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});let reads=0;try{const entry=f.model.indicators.entries.get('s');if(mode==='own-length')Object.defineProperty(entry.arrays[0],'length',{get(){reads++;return 0;}});else{const shared=new Float64Array(new SharedArrayBuffer(f.store.capacity*8));Object.defineProperty(shared,'buffer',{get(){reads++;return new ArrayBuffer(8);}});entry.arrays[0]=shared;}if(mode==='own-length')assert.equal(f.api.dataAt({index:2},{indicatorMode:'cached'}).series[0].status,'value');else assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),/Shared/);assert.equal(reads,0);}finally{f.model.dispose();}}
});

for(const state of ['missing-arrays','missing-vector','short-vector'])test('unready canonical '+state+' returns positioned pending',()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});const entry=f.model.indicators.entries.get('s');if(state==='missing-arrays')entry.arrays=[];if(state==='missing-vector')entry.arrays[0]=undefined;if(state==='short-vector')entry.arrays[0]=new Float64Array(f.store.capacity-1);
 try{const row=f.api.dataAt({index:6},{indicatorMode:'cached'}).series[0];assert.equal(row.status,'pending');assert.equal(row.value,null);assert.equal(row.sourceIndex,6);}
 finally{f.model.dispose();}
});

for(const corruption of ['sparse','extra','wrong-count','wrong-type'])test('canonical cache shape corruption rejects: '+corruption,()=>{
 const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});const entry=f.model.indicators.entries.get('s');if(corruption==='sparse')delete entry.arrays[0];if(corruption==='extra')entry.arrays.extra=1;if(corruption==='wrong-count')entry.arrays.push(new Float64Array(f.store.capacity));if(corruption==='wrong-type')entry.arrays[0]=new Uint8Array(f.store.capacity);
 try{assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),/cached|shape|own data|limit/i);}
 finally{f.model.dispose();}
});

test('missing indicator and output metadata still fail before cache support status',()=>{
 for(const missing of ['indicator','output']){const f=fixture(8);f.api.addIndicator('s','sma',{period:2});line(f.api,{indicator:'s'});try{if(missing==='indicator')f.model.series[0].indicator='absent';else f.model.series[0].output='absent';assert.throws(()=>f.api.dataAt({index:2},{indicatorMode:'cached'}),missing==='indicator'?/Missing indicator/:/Missing indicator output/);}finally{f.model.dispose();}}
});

for(const value of [null,'cached ',false,0,{},[]])test('invalid cached mode rejects strictly: '+String(value),()=>{const f=fixture(1);try{assert.throws(()=>f.api.dataAt({index:0},{indicatorMode:value}),/indicator mode/);}finally{f.model.dispose();}});
