import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel, ChartAPI, seededColumns} from '../src/core/index.mjs';

function fixture() {
 const model=new ChartModel();model.store.setColumns(seededColumns(8));let calls=0,armed=false,notifications=0;
 const failure=new Error('target calculation must not run');
 model.indicators.register('removal-probe',()=>({outputs:['value'],create(){calls++;if(armed)throw failure;return {step:b=>{calls++;if(armed)throw failure;return [b.close];},snapshot:()=>{calls++;if(armed)throw failure;return 0;},restore:()=>{calls++;if(armed)throw failure;}};}}));
 const api=new ChartAPI(model,{invalidate:()=>notifications++});api.addIndicator('target','removal-probe');api.addSeries({id:'line',type:'line',panel:'price',indicator:'target'});
 return {model,api,failure,arm(){armed=true;calls=0;},calls:()=>calls,notifications:()=>notifications};
}
test('removing a dirty failing indicator does not calculate or alter held output',()=>{
 const f=fixture(),{model,api}=f;try {
 const held=model.indicators.get('target').outputs.value,copy=held.slice();
 model.store.update(7,{...model.store.at(7),close:model.store.at(7).open});f.arm();
 const version=model.store.version,n=f.notifications();api.removeIndicator('target');
 assert.equal(f.calls(),0);assert.equal(f.notifications(),n+1);assert.equal(model.store.version,version);
 assert.equal(model.indicators.entries.has('target'),false);assert.equal(model.series.length,0);assert.deepEqual(held,copy);
 }finally{model.dispose();}
});
for(const phase of ['cancel','target'])test(`removal preserves replacement entry after ${phase} reentry`,()=>{
 const f=fixture(),{model,api}=f;try {
 const old=model.indicators.entries.get('target');let replacement;
 const replace=()=>{replacement={...old};model.indicators.entries.set('target',replacement);};
 const drawing={id:'drawing',seriesId:'line'};model.drawings.items.push(drawing);
 api.controller={gesture:phase==='cancel'?{id:'drawing'}:null,drawingTarget:{seriesId:'line'},cancel:replace,setDrawingTarget:replace};
 const n=f.notifications();assert.throws(()=>api.removeIndicator('target'),{name:'StaleSourceError'});
 assert.equal(model.indicators.entries.get('target'),replacement);assert.equal(model.series.length,1);assert.equal(f.notifications(),n);
 }finally{model.dispose();}
});
test('removal preserves missing-id coercion and original lookup errors',()=>{
 const {model,api}=fixture();try {
 assert.throws(()=>api.removeIndicator('missing'),{message:'Missing indicator: missing'});
 assert.throws(()=>api.removeIndicator(Symbol('missing')),TypeError);
 const error={sentinel:true};assert.throws(()=>api.removeIndicator({toString(){throw error;}}),x=>x===error);
 const entries=model.indicators.entries;entries.get=()=>{throw error;};assert.throws(()=>api.removeIndicator('target'),x=>x===error);
 }finally{model.dispose();}
});
test('lookup returning a replaced entry fails before controller cleanup',()=>{
 const {model,api}=fixture();try {
 const entries=model.indicators.entries,old=entries.get('target'),replacement={...old};let cleanup=0;
 entries.get=function(id){Map.prototype.set.call(this,id,replacement);return old;};
 api.controller={gesture:null,drawingTarget:{seriesId:'line'},setDrawingTarget(){cleanup++;}};
 assert.throws(()=>api.removeIndicator('target'),{name:'StaleSourceError'});assert.equal(cleanup,0);
 assert.equal(Map.prototype.get.call(entries,'target'),replacement);assert.equal(model.series.length,1);
 }finally{model.dispose();}
});

test('controller failure keeps entry and original thrown value',()=>{
 const {model,api}=fixture();try {
 const old=model.indicators.entries.get('target'),error={reason:'controller failure'};
 api.controller={drawingTarget:{seriesId:'line'},setDrawingTarget(){throw error;}};
 assert.throws(()=>api.removeIndicator('target'),x=>x===error);
 assert.equal(model.indicators.entries.get('target'),old);assert.equal(model.series.length,1);
 }finally{model.dispose();}
});
test('removal during its own active step stops the calculation without resurrection',()=>{
 const model=new ChartModel(),api=new ChartAPI(model);let armed=false;
 try {
 model.store.setColumns(seededColumns(8));
 model.indicators.register('self-remove',()=>({outputs:['value'],create:()=>({step:b=>{if(armed)api.removeIndicator('target');return [b.close];},snapshot:()=>0,restore(){}})}));
 api.addIndicator('target','self-remove');model.store.update(7,{...model.store.at(7),close:model.store.at(7).open});armed=true;
 assert.throws(()=>model.indicators.get('target'),{name:'StaleSourceError'});
 assert.equal(model.indicators.entries.has('target'),false);
 }finally{model.dispose();}
});
test('removal leaves shared-store listeners and another model live',()=>{
 const {model,api}=fixture(),other=new ChartModel({store:model.store});try {
 other.indicators.add('other','ema',{period:2});const listeners=model.store.listeners.size;
 api.removeIndicator('target');assert.equal(model.store.listeners.size,listeners);
 model.store.update(7,{...model.store.at(7),close:model.store.at(7).open});
 const fresh=new ChartModel({store:model.store});try {
 assert.deepEqual(other.indicators.get('other').outputs,fresh.indicators.add('other','ema',{period:2}).outputs);
 }finally{fresh.dispose();}
 }finally{model.dispose();other.dispose();}
});

import {NativeCheckpointBudget,NativeCheckpointEntries,NativeCheckpointMap} from '../src/core/native-checkpoints.mjs';
test('native checkpoint retirement releases only target ledger without recalculation',()=>{
 const model=new ChartModel(),api=new ChartAPI(model),budget=new NativeCheckpointBudget();
 try {
 model.indicators.entries=new NativeCheckpointEntries();
 for(const id of ['target','keep']){
  api.addIndicator(id,'ema',{period:2});const entry=model.indicators.entries.get(id);
  entry.checkpoints=new NativeCheckpointMap('ema',{period:2},{budget,block:model.indicators.checkpointSize});
  model.indicators.entries.set(id,entry);
 }
 model.store.setColumns(seededColumns(300));
 const held=model.indicators.get('target').outputs.value,copy=held.slice();model.indicators.get('keep');
 const target=model.indicators.entries.get('target'),keep=model.indicators.entries.get('keep');
 const remaining=keep.checkpoints.encodedBytes;assert.ok(budget.usedBytes>remaining);
 model.store.update(299,{...model.store.at(299),close:model.store.at(299).open});
 target.def.create=()=>{throw new Error('deletion calculated');};
 api.removeIndicator('target');assert.equal(budget.usedBytes,remaining);assert.deepEqual(held,copy);
 assert.equal(model.indicators.entries.get('keep'),keep);assert.throws(()=>target.checkpoints.get(0));
 }finally{model.dispose();assert.equal(budget.usedBytes,0);}
});
test('remove method accessor cannot replace the entry before deletion',()=>{
 const {model,api}=fixture();try {
 const engine=model.indicators,old=engine.entries.get('target'),replacement={...old};let called=0;
 Object.defineProperty(engine,'remove',{get(){engine.entries.set('target',replacement);return ()=>called++;}});
 assert.throws(()=>api.removeIndicator('target'),{name:'StaleSourceError'});
 assert.equal(called,0);assert.equal(engine.entries.get('target'),replacement);assert.equal(model.series.length,1);
 }finally{model.dispose();}
});
for(const action of ['dispose','model','entries'])test(`controller ${action} change cannot delete from a different owner`,()=>{
 const {model,api}=fixture();let other;try {
 const old=model.indicators.entries.get('target');
 api.controller={drawingTarget:{seriesId:'line'},setDrawingTarget(){
  if(action==='dispose')model.dispose();
  if(action==='model'){other=new ChartModel();api.model=other;}
  if(action==='entries')model.indicators.entries=new Map([['target',{...old}]]);
 }};
 assert.throws(()=>api.removeIndicator('target'),action==='dispose'?{message:'Chart disposed'}:{name:'StaleSourceError'});
 if(action!=='dispose'){assert.ok(model.indicators.entries.has('target'));assert.equal(model.series.length,1);}
 }finally{model.dispose();other?.dispose();}
});
test('managed source updates during gesture cleanup do not prevent deletion of the same entry',()=>{
 const {model,api}=fixture();try {
 api.controller={drawingTarget:{seriesId:'line'},setDrawingTarget(){model.store.update(7,{...model.store.at(7),close:model.store.at(7).open});}};
 api.removeIndicator('target');assert.equal(model.indicators.entries.has('target'),false);
 }finally{model.dispose();}
});
for(const method of ['cancel','setDrawingTarget'])test(`${method} accessor replacement is guarded before method invocation`,()=>{
 const {model,api}=fixture();try {
 const old=model.indicators.entries.get('target'),replacement={...old};let called=0;
 model.drawings.items.push({id:'drawing',seriesId:'line'});
 const controller={gesture:method==='cancel'?{id:'drawing'}:null,drawingTarget:{seriesId:'line'}};
 Object.defineProperty(controller,method,{get(){model.indicators.entries.set('target',replacement);return ()=>called++;}});api.controller=controller;
 assert.throws(()=>api.removeIndicator('target'),{name:'StaleSourceError'});assert.equal(called,0);
 assert.equal(model.indicators.entries.get('target'),replacement);assert.equal(model.series.length,1);
 }finally{model.dispose();}
});
test('remove accessor unrelated-series addition is not overwritten by an older series snapshot',()=>{
 const {model,api}=fixture();try {
 const engine=model.indicators,remove=engine.remove;
 Object.defineProperty(engine,'remove',{get(){api.addSeries({id:'keep',type:'line',panel:'price',source:'close'});return remove;}});
 api.removeIndicator('target');assert.deepEqual(model.series.map(s=>s.id),['keep']);assert.equal(engine.entries.has('target'),false);
 }finally{model.dispose();}
});
