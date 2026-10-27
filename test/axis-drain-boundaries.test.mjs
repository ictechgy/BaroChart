import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController} from '../src/core/index.mjs';

const rows=Array.from({length:4},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10+i}));
function axisFixture(t){
 const model=new ChartModel({store:new BarStore(rows),axes:[{id:'free',panel:'price'}]});
 const controller=new InteractionController(model,()=>({width:800,height:500}));let invalidations=0;
 const api=new ChartAPI(model,{controller,invalidate:()=>invalidations++});t.after(()=>model.dispose());
 return {model,controller,api,invalidations:()=>invalidations};
}
function ingestionFixture(t){
 const model=new ChartModel({store:new BarStore(rows)});let invalidations=0;
 const api=new ChartAPI(model,{invalidate:()=>invalidations++});t.after(()=>model.dispose());
 api.configureDataIngestion({streamId:'axis-drain-test',generation:1,maxQueuedEvents:4,maxQueuedBytes:196,maxBatchEvents:4});
 return {model,api,invalidations:()=>invalidations};
}
const event=()=>({kind:'append',bar:{time:1700000240000,open:104,high:106,low:103,close:105,volume:14}});

test('drain receipt stays committed and skips late invalidation after publication disposal',t=>{
 const f=ingestionFixture(t),session=f.model.dataIngestion;f.api.enqueueDataEvents({streamId:'axis-drain-test',generation:1,firstSequence:0,events:[event()]});
 let publications=0;f.model.store.subscribe(()=>{publications++;f.model.dispose();});
 const receipt=f.api.drainDataEvents();
 assert.equal(receipt.events,1);assert.equal(receipt.lastSequence,0);assert.equal(publications,1);assert.equal(session.count,0);assert.equal(session.counters.applied,1);assert.equal(f.invalidations(),0);
});

test('empty drains are silent',t=>{
 const f=ingestionFixture(t),before=f.model.store;const receipt=f.api.drainDataEvents();assert.equal(receipt.events,0);assert.equal(receipt.length,rows.length);assert.equal(receipt.version,before.version);assert.equal(f.invalidations(),0);
});

test('removeAxis preflights API and target accessors before changing model state',t=>{
 const cases=[
  ['API controller accessor',f=>Object.defineProperty(f.api,'controller',{configurable:true,get(){throw new Error('controller getter');}})],
  ['controller drawingTarget accessor',f=>Object.defineProperty(f.controller,'drawingTarget',{configurable:true,get(){throw new Error('target getter');}})],
  ['target axisId accessor',f=>{const target={panel:'price'};Object.defineProperty(target,'axisId',{configurable:true,get(){throw new Error('axis getter');}});Object.defineProperty(f.controller,'drawingTarget',{configurable:true,writable:true,value:target});}],
  ['non-writable matching target',f=>{const target=Object.freeze({panel:'price',axisId:'free'});Object.defineProperty(f.controller,'drawingTarget',{configurable:true,writable:false,value:target});}]
 ];
 for(const [label,prepare] of cases){
  const f=axisFixture(t),axes=f.model.axes,history=f.model.drawings.undoStack;prepare(f);
  assert.throws(()=>f.api.removeAxis('free'),label);assert.equal(f.model.axes,axes,label+' preserves axes owner');assert.equal(f.model.axes.some(axis=>axis.id==='free'),true,label+' preserves axis');assert.equal(f.model.drawings.undoStack,history,label+' preserves history');assert.equal(f.invalidations(),0,label+' does not invalidate');
 }
});

test('removeAxis clears the captured writable target directly and invalidates once',t=>{
 const f=axisFixture(t),target={panel:'price',axisId:'free'};let setterCalls=0;
 f.controller.setDrawingTarget=()=>{setterCalls++;throw new Error('overridable setter called');};Object.defineProperty(f.controller,'drawingTarget',{configurable:true,writable:true,value:target});
 f.api.removeAxis('free');assert.equal(f.model.axes.some(axis=>axis.id==='free'),false);assert.equal(f.controller.drawingTarget,null);assert.equal(setterCalls,0);assert.equal(f.invalidations(),1);
});

test('removeAxis rejects active gestures and disposed owners without journal mutation',t=>{
 const f=axisFixture(t),before=f.model.axes,history=f.model.drawings.undoStack;f.controller.gesture={kind:'pan'};assert.throws(()=>f.api.removeAxis('free'),/gesture/);assert.equal(f.model.axes,before);assert.equal(f.model.drawings.undoStack,history);f.controller.gesture=null;f.model.dispose();assert.throws(()=>f.api.removeAxis('free'),/disposed/i);
});

test('removeAxis rejects collection replacement during its final owner guards',t=>{
 {
  const f=axisFixture(t),axes=f.model.axes;let reflections=0;
  f.model.axes=new Proxy(axes,{getOwnPropertyDescriptor(target,key){if(key==='length'&&++reflections===2)f.model.axes=[...target,{id:'newer',panel:'price',side:'right',visible:true,tickFormat:'fixed',scale:'linear',inverted:false,padding:.08}];return Reflect.getOwnPropertyDescriptor(target,key);}});
  assert.throws(()=>f.api.removeAxis('free'),/owner changed/);assert.deepEqual(f.model.axes.map(axis=>axis.id),['free','newer']);assert.equal(f.invalidations(),0);
 }
 {
  const f=axisFixture(t);f.api.addSeries({id:'line',type:'line',panel:'price',source:'close'});const series=f.model.series;let reflections=0;
  f.model.series=new Proxy(series,{getOwnPropertyDescriptor(target,key){if(key==='length'&&++reflections===2)f.model.series=[...target];return Reflect.getOwnPropertyDescriptor(target,key);}});
  const n=f.invalidations();assert.throws(()=>f.api.removeAxis('free'),/owner changed/);assert.equal(f.model.series[0],series[0]);assert.equal(f.invalidations(),n);
 }
 {
  const f=axisFixture(t),drawings=f.model.drawings,replacement=new drawings.constructor();
  f.model.drawings=new Proxy(drawings,{getOwnPropertyDescriptor(target,key){if(key==='items')f.model.drawings=replacement;return Reflect.getOwnPropertyDescriptor(target,key);}});
  assert.throws(()=>f.api.removeAxis('free'),/owner changed/);assert.equal(f.model.drawings,replacement);assert.equal(f.invalidations(),0);
 }
});

test('direct setSeriesValues rejects a disposed model',t=>{
 const model=new ChartModel({store:new BarStore(rows)});model.addSeries({id:'line',type:'line',panel:'price',source:'close'});model.dispose();assert.throws(()=>model.setSeriesValues('line',new Float64Array(rows.length)),/disposed/i);
});
