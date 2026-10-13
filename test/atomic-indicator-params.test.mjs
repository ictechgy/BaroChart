import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/index.mjs';
import {SceneCache} from '../src/core/frame-cache.mjs';
import {configurationKey} from '../src/web/worker-state.mjs';

function bars(n=530) {
 return Array.from({length:n},(_,i)=>{const close=100+i*.027+Math.sin(i*.73)*8+Math.cos(i*.17)*3;return {time:1700000000000+i*60000,open:close-.5,high:close+2,low:close-2,close,volume:10+i%19};});
}
function setup(t, source=bars()) {
 const model=new A.ChartModel();let invalidations=0;
 const controller=new A.InteractionController(model,()=>({width:900,height:500}));
 const api=new A.ChartAPI(model,{controller,invalidate:()=>invalidations++});
 api.setData(source);t.after(()=>model.dispose());
 return {model,api,controller,notifications:()=>invalidations};
}
function requireFeature(api) {assert.equal(typeof api.setIndicatorParams,'function','ChartAPI.setIndicatorParams must exist');}
function approximately(actual,expected,message='output') {
 assert.equal(actual.length,expected.length,message+' length');
 for(let i=0;i<expected.length;i++) {
  if(expected[i]===null||Number.isNaN(expected[i]))assert.ok(actual[i]===null||Number.isNaN(actual[i]),`${message}[${i}] warmup`);
  else assert.ok(typeof actual[i]==='number'&&Math.abs(actual[i]-expected[i])<=1e-10*Math.max(1,Math.abs(expected[i])),`${message}[${i}]: ${actual[i]} != ${expected[i]}`);
 }
}
function emaOracle(source,p,field='close') {
 let sum=0,value;return source.map((b,i)=>{if(i<p){sum+=b[field];if(i===p-1)value=sum/p;}else value+=2/(p+1)*(b[field]-value);return value??null;});
}
function rsiOracle(source,p) {
 let gain=0,loss=0;return source.map((b,i)=>{if(!i)return null;const delta=b.close-source[i-1].close,g=Math.max(0,delta),l=Math.max(0,-delta);if(i<=p){gain+=g/p;loss+=l/p;}else {gain+=(g-gain)/p;loss+=(l-loss)/p;}return i<p?null:gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);});
}
function freshValues(t,name,params,source) {const {api}=setup(t,source);api.addIndicator('fresh',name,params);return api.indicatorValues('fresh');}
function rawEntryState(model,id) {
 const entry=model.indicators.entries.get(id);return {entry,arrays:entry.arrays.slice(),arrayValues:entry.arrays.map(a=>Array.from(a)),params:structuredClone(entry.params),def:entry.def,checkpoints:entry.checkpoints,checkpointValues:structuredClone([...entry.checkpoints]),dirty:entry.dirty,dirtyTo:entry.dirtyTo,length:entry.length,revision:entry.revision,invalidated:entry.invalidated};
}
function assertEntryUnchanged(model,id,before) {
 const current=model.indicators.entries.get(id);assert.strictEqual(current,before.entry);assert.strictEqual(current.def,before.def);assert.deepEqual(current.params,before.params);assert.strictEqual(current.checkpoints,before.checkpoints);assert.deepEqual([...current.checkpoints],before.checkpointValues);
 assert.equal(current.arrays.length,before.arrays.length);for(let i=0;i<current.arrays.length;i++){assert.strictEqual(current.arrays[i],before.arrays[i]);assert.deepEqual(Array.from(current.arrays[i]),before.arrayValues[i]);}
 for(const key of ['dirty','dirtyTo','length','revision','invalidated'])assert.equal(current[key],before[key],key);
}
function definition({outputs=['value'],plotOffsets={},factor=1,stepHook=null,outputHook=null}={}) {
 return {outputs,plotOffsets,create(){let count=0;return {step(bar,i){stepHook?.(bar,i);count++;return outputHook?outputHook(bar,i):outputs.map((_,j)=>bar.close*factor+j);},snapshot:()=>count,restore:value=>{count=value;}};}};
}
function addBound(api,id='e',name='ema',params={period:5}) {api.addIndicator(id,name,params);api.addSeries({id:'line-'+id,type:'line',panel:'price',indicator:id,output:'value'});}

// 1. Public JSON bridge and facade notification contract.
test('setIndicatorParams returns addIndicator metadata, dispatches, and invalidates exactly once',t=>{
 const {api,model,notifications}=setup(t);requireFeature(api);api.addIndicator('e','ema',{period:5});const before=notifications();
 assert.deepEqual(api.dispatch('setIndicatorParams',['e',{period:11}]),{outputs:['value'],plotOffsets:{}});
 assert.equal(notifications(),before+1);assert.deepEqual(model.indicators.entries.get('e').params,{period:11});
 assert.throws(()=>api.dispatch('setIndicatorParams',['e',{period:7},'extra']));assert.equal(notifications(),before+1);
 api.addIndicator('noop','ema',{source:'close',period:7});api.addSeries({id:'noop-line',type:'line',panel:'price',indicator:'noop'});const series=model.series[0];model.seriesData(series);
 const state=rawEntryState(model,'noop'),index=series.rangeIndex,notify=notifications();const metadata=api.setIndicatorParams('noop',{period:7,source:'close'});
 assertEntryUnchanged(model,'noop',state);assert.strictEqual(series.rangeIndex,index);assert.equal(notifications(),notify+1);metadata.outputs.push('fake');metadata.plotOffsets.value=999;assert.deepEqual(model.indicators.entries.get('noop').def.outputs,['value']);assert.equal(model.indicators.entries.get('noop').def.plotOffsets.value,undefined);
 api.registerIndicator('signed-zero',({x=0})=>definition({factor:Object.is(x,-0)?-1:1}));api.addIndicator('zero','signed-zero',{x:0});const positive=model.indicators.entries.get('zero');
 api.setIndicatorParams('zero',{x:-0});assert.notStrictEqual(model.indicators.entries.get('zero'),positive);assert.ok(Object.is(model.indicators.entries.get('zero').params.x,-0));assert.equal(api.indicatorValues('zero')[0],-model.store.at(0).close);
 const negative=rawEntryState(model,'zero');api.setIndicatorParams('zero',{x:-0});assertEntryUnchanged(model,'zero',negative);
});

// 2-3. Independent formulas plus fresh-engine parity across checkpoint boundaries.
for(const [name,oracle] of [['ema',emaOracle],['rsi',rsiOracle]])test(`${name} replacement matches an independent fresh oracle and subsequent update/append/correction`,t=>{
 const source=bars(),{api,model}=setup(t,source);requireFeature(api);api.addIndicator('study',name,{period:7});api.setIndicatorParams('study',{period:19});
 const verify=()=>{approximately(api.indicatorValues('study'),oracle(source,19),name+' independent');approximately(api.indicatorValues('study'),freshValues(t,name,{period:19},source),name+' fresh engine');};verify();
 source[source.length-1]={...source.at(-1),close:source.at(-1).close+1.25,high:source.at(-1).high+2};api.applyDataEvent({kind:'update',bar:source.at(-1)});verify();
 source.push({...source.at(-1),time:source.at(-1).time+60000,close:source.at(-1).close-.8});api.applyDataEvent({kind:'append',bar:source.at(-1)});verify();
 source[255]={...source[255],close:source[255].close+1.7};api.applyDataEvent({kind:'correction',bar:source[255]});verify();
 assert.equal(model.indicators.entries.size,1);
});

// 4. Omitted properties return to factory defaults, rather than retaining old params.
test('params are a full replacement, including removal of the previous source',t=>{
 const source=bars(64),{api,model}=setup(t,source);requireFeature(api);api.addIndicator('e','ema',{period:3,source:'high'});api.setIndicatorParams('e',{period:9});
 assert.deepEqual(model.indicators.entries.get('e').params,{period:9});approximately(api.indicatorValues('e'),emaOracle(source,9));
 api.setIndicatorParams('e',{});assert.deepEqual(model.indicators.entries.get('e').params,{});approximately(api.indicatorValues('e'),emaOracle(source,20));
});

// 5. Custom closures must not retain the caller's mutable object.
test('caller params are detached before factory use and remain detached on later recalculation',t=>{
 const source=bars(30),{api,model}=setup(t,source);requireFeature(api);let received;
 api.registerIndicator('retains-params',params=>{received=params;return definition({outputHook:b=>[b.close*params.factor]});});
 api.addIndicator('custom','retains-params',{factor:1});const params={factor:2};api.setIndicatorParams('custom',params);
 assert.notStrictEqual(received,params);params.factor=17;assert.deepEqual(model.indicators.entries.get('custom').params,{factor:2});
 source[source.length-1]={...source.at(-1),close:source.at(-1).close+.25};api.applyDataEvent({kind:'update',bar:source.at(-1)});
 approximately(api.indicatorValues('custom'),source.map(b=>b.close*2));
});

// 6. Accessor rejection must not execute user getters.
test('invalid primitive params and periods leave arrays, indexes, history, view and notifications unchanged',t=>{
 const {api,model,notifications}=setup(t);requireFeature(api);addBound(api);const s=model.series[0];model.seriesData(s);
 api.addDrawing({id:'note',type:'text',panel:'price',seriesId:s.id,points:[{time:model.store.at(20).time,price:100}],text:'keep'});
 let getterCalls=0;const getter={};Object.defineProperty(getter,'period',{enumerable:true,get(){getterCalls++;return 3;}});
 const hidden={period:3};Object.defineProperty(hidden,'secret',{value:4});
 const bad=[null,[],{period:0},{period:1.5},{period:10001},{period:Infinity},{x:NaN},{x:true},{x:{}},{x:'x'.repeat(257)},{[Symbol('x')]:3},hidden,getter];
 for(const params of bad){const before=rawEntryState(model,'e'),inspection=api.inspect(),index=s.rangeIndex,undo=model.drawings.undoStack,notify=notifications();assert.throws(()=>api.setIndicatorParams('e',params));assertEntryUnchanged(model,'e',before);assert.deepEqual(api.inspect(),inspection);assert.strictEqual(s.rangeIndex,index);assert.strictEqual(model.drawings.undoStack,undo);assert.equal(notifications(),notify);}
 assert.equal(getterCalls,0);
});

// 7. Failures after many candidate writes still leave the committed entry intact.
test('throwing factories, create/snapshot callbacks and late malformed outputs roll back atomically',t=>{
 const {api,model,notifications}=setup(t);requireFeature(api);
 api.registerIndicator('fallible',({mode='ok',factor=1})=>{
  if(mode==='factory')throw new Error('factory failure');
  if(mode==='create')return {outputs:['value'],create(){throw new Error('create failure');}};
  if(mode==='snapshot')return {outputs:['value'],create(){return {snapshot(){throw new Error('snapshot failure');},restore(){},step:b=>[b.close]};}};
  return definition({factor,outputHook:(b,i)=>i===270?(mode==='arity'?[]:mode==='infinity'?[Infinity]:mode==='string'?['bad']:mode==='step'?(()=>{throw new Error('step failure');})():[b.close*factor]):[b.close*factor]});
 });
 addBound(api,'custom','fallible',{factor:1});const s=model.series[0],oldView=model.indicators.get('custom').outputs.value,oldValues=Array.from(oldView);model.seriesData(s);
 for(const mode of ['factory','create','snapshot','arity','infinity','string','step']){const before=rawEntryState(model,'custom'),index=s.rangeIndex,notify=notifications();assert.throws(()=>api.setIndicatorParams('custom',{mode,factor:4}));assertEntryUnchanged(model,'custom',before);assert.deepEqual(Array.from(oldView),oldValues);assert.strictEqual(s.rangeIndex,index);assert.equal(notifications(),notify);assert.deepEqual(api.indicatorValues('custom'),oldValues);}
});

// 8. Schema matching is ordered, and applies even with no attached series.
test('changing custom output names, order, count or duplicate names rejects without publication',t=>{
 const {api,model}=setup(t,bars(20));requireFeature(api);
 api.registerIndicator('schema',({schema=0})=>definition({outputs:[['a','b'],['b','a'],['a','renamed'],['a'],['a','a']][schema]}));api.addIndicator('c','schema',{schema:0});
 for(const schema of [1,2,3,4]){const before=rawEntryState(model,'c');assert.throws(()=>api.setIndicatorParams('c',{schema}));assertEntryUnchanged(model,'c',before);}
 assert.equal(model.series.length,0);
});

// 9. Explicitly overridden series offsets do not authorize redefining plot offsets.
test('effective per-output plot offset changes reject even when unbound or explicitly overridden',t=>{
 const {api,model}=setup(t,bars(40));requireFeature(api);
 api.registerIndicator('offsets',({shift=0,zero=0})=>definition({plotOffsets:zero?{value:0}:shift?{value:shift}:{}}));api.addIndicator('c','offsets',{});
 api.setIndicatorParams('c',{zero:1});assert.equal(model.indicators.entries.get('c').def.plotOffsets.value,0);
 api.setIndicatorParams('c',{});for(const shift of [-3,3]){const before=rawEntryState(model,'c');assert.throws(()=>api.setIndicatorParams('c',{shift}));assertEntryUnchanged(model,'c',before);}
 api.addSeries({id:'explicit',type:'line',panel:'price',indicator:'c',offset:42});const before=rawEntryState(model,'c');assert.throws(()=>api.setIndicatorParams('c',{shift:5}));assertEntryUnchanged(model,'c',before);assert.equal(model.series[0].offset,42);
 api.addIndicator('cloud','ichimoku',{conversion:3,base:5,span:7,displacement:4});const cloud=rawEntryState(model,'cloud');assert.throws(()=>api.setIndicatorParams('cloud',{conversion:4,base:6,span:8,displacement:9}));assertEntryUnchanged(model,'cloud',cloud);
});

// 10. Replacement consumes no additional persistent indicator slot.
test('replacement succeeds at maxIndicators=128 and preserves indicator ordering and other entries',t=>{
 const {api,model}=setup(t,bars(24));requireFeature(api);assert.equal(A.RESOURCE_LIMITS.maxIndicators,128);
 for(let i=0;i<128;i++)api.addIndicator('i'+i,'ema',{period:3});const ids=[...model.indicators.entries.keys()],other=model.indicators.entries.get('i63'),otherArray=other.arrays[0];
 assert.deepEqual(api.setIndicatorParams('i64',{period:9}),{outputs:['value'],plotOffsets:{}});assert.equal(model.indicators.entries.size,128);assert.deepEqual([...model.indicators.entries.keys()],ids);assert.strictEqual(model.indicators.entries.get('i63'),other);assert.strictEqual(other.arrays[0],otherArray);
 approximately(api.indicatorValues('i64'),emaOracle(bars(24),9));
});

// 11. Binding identity and active drawing state survive; only dependent indexes clear.
test('series styles, axis, drawings, history, gesture target and viewport survive selective cache invalidation',t=>{
 const {api,model,controller,notifications}=setup(t,bars(80));requireFeature(api);
 api.addAxis({id:'study-axis',panel:'price',side:'left',range:[80,130]});api.addIndicator('e','ema',{period:3});api.addIndicator('r','rsi',{period:7});
 api.addSeries({id:'e-line',type:'line',panel:'price',axisId:'study-axis',indicator:'e',color:'#fa0',width:4,offset:2});
 api.addSeries({id:'r-line',type:'line',panel:'price',indicator:'r',visible:false});api.addSeries({id:'raw',type:'line',panel:'price',source:'high'});
 for(const s of model.series)model.seriesData(s);api.setVisibleRange(10,55);api.setDrawingTarget({panel:'price',axisId:'study-axis',seriesId:'e-line'});
 api.addDrawing({id:'bound',type:'text',panel:'price',seriesId:'e-line',points:[{time:model.store.at(20).time,price:110}],text:'v1'});api.editDrawing('bound',{text:'v2'});api.undo();
 const cache=new SceneCache();cache.frame(model,900,500);assert.equal(cache.frame(model,900,500).baseChanged,false);
 model.drawings.begin();const before=api.inspect(),series=model.series.slice(),axis=model.axes[0],view=model.view,transaction=model.drawings.transaction,items=model.drawings.items,undo=model.drawings.undoStack,redo=model.drawings.redoStack,target=controller.drawingTarget,rIndex=series[1].rangeIndex,rawIndex=series[2].rangeIndex,oldDependent=series[0].rangeIndex,notify=notifications();
 api.setIndicatorParams('e',{period:15});assert.equal(notifications(),notify+1);assert.deepEqual(api.inspect(),before);assert.strictEqual(model.view,view);assert.strictEqual(model.axes[0],axis);
 for(let i=0;i<series.length;i++)assert.strictEqual(model.series[i],series[i]);assert.strictEqual(model.drawings.items,items);assert.strictEqual(model.drawings.transaction,transaction);assert.strictEqual(model.drawings.undoStack,undo);assert.strictEqual(model.drawings.redoStack,redo);assert.strictEqual(controller.drawingTarget,target);
 assert.ok(!series[0].rangeIndex,'dependent derived index is cleared');assert.strictEqual(series[1].rangeIndex,rIndex);assert.strictEqual(series[2].rangeIndex,rawIndex);
 assert.equal(cache.frame(model,900,500).baseChanged,true);assert.notStrictEqual(series[0].rangeIndex,oldDependent);assert.equal(cache.frame(model,900,500).baseChanged,false);approximately(model.seriesData(series[0]).values,emaOracle(bars(80),15));
 model.drawings.cancel();assert.equal(model.drawings.redo(),true);assert.equal(model.drawings.items[0].text,'v2');
});

// 12. Do not eagerly recompute the old entry just to stage a rejected replacement.
test('failed replacement leaves already-dirty old arrays and checkpoint history untouched',t=>{
 const source=bars(),{api,model}=setup(t,source);requireFeature(api);api.addIndicator('e','ema',{period:5});
 const view=model.indicators.get('e').outputs.value,values=Array.from(view);source[257]={...source[257],close:source[257].close+1};api.applyDataEvent({kind:'correction',bar:source[257]});
 const before=rawEntryState(model,'e');assert.ok(before.dirty<model.store.length);assert.throws(()=>api.setIndicatorParams('e',{period:0}));assertEntryUnchanged(model,'e',before);assert.deepEqual(Array.from(view),values);approximately(api.indicatorValues('e'),emaOracle(source,5));
});

// 13. Replacement is not an alternate creation API.
test('missing, removed, duplicate and disposed cases cannot create or resurrect an entry',t=>{
 const {api,model,notifications}=setup(t,bars(10));requireFeature(api);const notify=notifications();assert.throws(()=>api.setIndicatorParams('missing',{period:3}));assert.equal(model.indicators.entries.size,0);assert.equal(notifications(),notify);
 api.addIndicator('e','ema',{period:3});const before=rawEntryState(model,'e');assert.throws(()=>api.addIndicator('e','rsi',{period:3}));assertEntryUnchanged(model,'e',before);api.removeIndicator('e');assert.throws(()=>api.setIndicatorParams('e',{period:4}));assert.equal(model.indicators.entries.size,0);
 api.addIndicator('last','ema',{period:3});model.dispose();const after=notifications();assert.throws(()=>api.setIndicatorParams('last',{period:4}),/disposed|missing/i);assert.equal(model.indicators.entries.size,0);assert.equal(notifications(),after);
});

// 14. Read-only reentry must observe the old committed entry throughout staging.
test('custom factory and step read reentry see the committed indicator until candidate commit',t=>{
 const {api,model}=setup(t,bars(25));requireFeature(api);let check=null,observed=0;
 api.registerIndicator('reads-live',({factor=1})=>{check?.();return definition({factor,stepHook:(_,i)=>{if(i===10)check?.();}});});api.addIndicator('c','reads-live',{factor:1});
 const old=model.indicators.entries.get('c'),values=api.indicatorValues('c');check=()=>{observed++;assert.strictEqual(model.indicators.entries.get('c'),old);assert.deepEqual(api.indicatorValues('c'),values);};
 api.setIndicatorParams('c',{factor:2});assert.equal(observed,2);assert.deepEqual(api.indicatorValues('c'),values.map(x=>x*2));
});

// 15. Reentrant source mutations remain, and must make the candidate stale.
test('store update from a candidate callback is preserved while stale replacement rejects',t=>{
 const source=bars(40),{api,model,notifications}=setup(t,source);requireFeature(api);let trigger=false;
 api.registerIndicator('updates-store',({factor=1})=>definition({factor,stepHook:(_,i)=>{if(trigger&&i===10){trigger=false;source[39]={...source[39],close:source[39].close+1};api.applyDataEvent({kind:'update',bar:source[39]});}}}));api.addIndicator('c','updates-store',{factor:1});
 const old=model.indicators.entries.get('c'),version=model.store.version,notify=notifications();trigger=true;assert.throws(()=>api.setIndicatorParams('c',{factor:2}),/stale|changed|source/i);
 assert.strictEqual(model.indicators.entries.get('c'),old);assert.deepEqual(old.params,{factor:1});assert.equal(model.store.version,version+1);assert.equal(model.store.at(39).close,source[39].close);assert.equal(notifications(),notify+1);approximately(api.indicatorValues('c'),source.map(b=>b.close));
});

// 16. An inner successful replacement wins; the outer transaction cannot overwrite it.
test('nested successful parameter replacement is preserved and outer candidate becomes stale',t=>{
 const {api,model,notifications}=setup(t,bars(30));requireFeature(api);let nested=false,innerResult;
 api.registerIndicator('nested',({factor=1})=>{if(nested&&factor===2){nested=false;innerResult=api.setIndicatorParams('c',{factor:3});}return definition({factor});});api.addIndicator('c','nested',{factor:1});
 const notify=notifications();nested=true;assert.throws(()=>api.setIndicatorParams('c',{factor:2}),/stale|changed|source/i);assert.deepEqual(innerResult,{outputs:['value'],plotOffsets:{}});assert.deepEqual(model.indicators.entries.get('c').params,{factor:3});assert.equal(notifications(),notify+1);approximately(api.indicatorValues('c'),bars(30).map(b=>b.close*3));
});

// 17. Both bound-series and registry configuration changes must survive stale rejection.
test('callback series or registry changes are preserved and reject the staged configuration',t=>{
 for(const kind of ['series','registry']){
  const {api,model,notifications}=setup(t,bars(20));requireFeature(api);let trigger=false;
  api.registerIndicator('changes-config',({factor=1})=>{if(trigger){trigger=false;if(kind==='series')api.setSeries('line-c',{color:'#123456',width:5});else api.registerIndicator('added-during-callback',()=>definition());}return definition({factor});});addBound(api,'c','changes-config',{factor:1});
  const old=model.indicators.entries.get('c'),notify=notifications();trigger=true;assert.throws(()=>api.setIndicatorParams('c',{factor:2}),/stale|changed|source/i);assert.strictEqual(model.indicators.entries.get('c'),old);assert.deepEqual(old.params,{factor:1});assert.equal(notifications(),notify+1);
  if(kind==='series'){assert.equal(model.series[0].color,'#123456ff');assert.equal(model.series[0].width,5);}else assert.ok(model.indicators.registry.has('added-during-callback'));
 }
});

// 18. Teardown/removal is never rolled back by the surrounding transaction.
test('callback removal or disposal cannot resurrect entries or dependent caches',t=>{
 for(const kind of ['remove','dispose']){
  const {api,model,notifications}=setup(t,bars(20));requireFeature(api);let trigger=false;
  api.registerIndicator('tears-down',({factor=1})=>definition({factor,stepHook:(_,i)=>{if(trigger&&i===7){trigger=false;if(kind==='remove')api.removeIndicator('c');else model.dispose();}}}));addBound(api,'c','tears-down',{factor:1});const originalSeries=model.series[0];model.seriesData(originalSeries);
  const notify=notifications();trigger=true;assert.throws(()=>api.setIndicatorParams('c',{factor:2}),/stale|changed|source|disposed|missing/i);assert.equal(model.indicators.entries.has('c'),false);assert.equal(notifications(),notify+(kind==='remove'?1:0));
  if(kind==='remove')assert.equal(model.series.length,0);else {assert.equal(model.disposed,true);assert.equal(originalSeries.rangeIndex,null);}
 }
});

// 19. An owner swap during a callback remains a swap, never a commit into either owner.
test('callback indicator-engine ownership swap rejects without altering the new owner',t=>{
 const {api,model}=setup(t,bars(20));requireFeature(api);const original=model.indicators;let replacement,trigger=false;
 t.after(()=>{original.dispose();replacement?.dispose();});
 api.registerIndicator('swaps-owner',({factor=1})=>{if(trigger){trigger=false;replacement=new A.IndicatorEngine(model.store);replacement.add('replacement','rsi',{period:3});model.indicators=replacement;}return definition({factor});});api.addIndicator('c','swaps-owner',{factor:1});const old=original.entries.get('c');
 trigger=true;assert.throws(()=>api.setIndicatorParams('c',{factor:2}),/stale|changed|source/i);assert.strictEqual(model.indicators,replacement);assert.deepEqual([...replacement.entries.keys()],['replacement']);assert.strictEqual(original.entries.get('c'),old);assert.deepEqual(old.params,{factor:1});
});

// 20. Persisted studies and configuration signatures describe the new committed params.
test('success updates study persistence and stale-result configuration keys without touching retained old views',t=>{
 const source=bars(50),{api,model}=setup(t,source);requireFeature(api);addBound(api);const oldView=model.indicators.get('e').outputs.value,oldValues=Array.from(oldView),key=configurationKey(model),version=model.store.version;
 api.setIndicatorParams('e',{period:13});assert.notEqual(configurationKey(model),key);assert.equal(model.store.version,version);assert.deepEqual(Array.from(oldView),oldValues);
 const saved=JSON.parse(api.saveStudies());assert.deepEqual(saved.indicators,[{id:'e',name:'ema',params:{period:13}}]);assert.equal(saved.series[0].indicator,'e');
 const restored=setup(t,source);restored.api.loadStudies(api.saveStudies());approximately(restored.api.indicatorValues('e'),emaOracle(source,13));
 const signature=configurationKey(model);assert.throws(()=>api.setIndicatorParams('e',{period:-1}));assert.equal(configurationKey(model),signature);
 const empty=setup(t,[]);empty.api.addIndicator('empty','ema',{period:3});assert.deepEqual(empty.api.setIndicatorParams('empty',{period:1}),{outputs:['value'],plotOffsets:{}});assert.deepEqual(empty.api.indicatorValues('empty'),[]);empty.api.applyDataEvent({kind:'append',bar:source[0]});assert.deepEqual(empty.api.indicatorValues('empty'),[source[0].close]);
});
