import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const bundle=await buildNativeBundle();
function fixture(t){const c=vm.createContext({});vm.runInContext(bundle,c);c.nativeInit(4);t.after(()=>vm.runInContext('nativeModel.dispose()',c));return c;}
const run=(c,s)=>vm.runInContext(s,c);
const plain=v=>JSON.parse(JSON.stringify(v));
test('dedicated native unchanged batch keeps source version, held columns/index and invalidation',t=>{
 const c=fixture(t);run(c,`globalThis.before=nativeModel.store.version;globalThis.columns=nativeModel.store.columns;globalThis.index=nativeModel.store.index;globalThis.invalidates=0;nativeAPI.invalidate=()=>invalidates++;globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}];`);
 const receipt=plain(run(c,'nativeApplyUnchangedDataEvents(events)'));
 assert.equal(receipt.schema,'aster.native-data-batch');assert.equal(receipt.version,1);assert.equal(receipt.unchanged,true);assert.equal(receipt.beforeVersion,receipt.afterVersion);assert.equal(receipt.receipt.unchanged,true);
 assert.equal(run(c,'nativeModel.store.version===before&&nativeModel.store.columns===columns&&nativeModel.store.index===index&&invalidates===0'),true);
});
test('changed native batch publishes once; append cannot be skipped',t=>{
 const c=fixture(t);run(c,`globalThis.invalidates=0;nativeAPI.invalidate=()=>invalidates++;`);
 for(const expression of ["[{kind:'update',bar:{...nativeModel.store.at(3),close:nativeModel.store.at(3).high}}]","[{kind:'append',bar:{...nativeModel.store.at(3),time:nativeModel.store.at(3).time+60000}}]"]){const r=plain(run(c,`nativeApplyUnchangedDataEvents(${expression})`));assert.equal(r.unchanged,false);assert.equal(r.receipt.unchanged,false);assert.equal(r.afterVersion,r.beforeVersion+1);}
 assert.equal(run(c,'invalidates'),2);
});
test('signed zero changes once; final identical values skip only after whole-batch validation',t=>{
 const c=fixture(t);run(c,`const b={time:1000,open:1,high:1,low:1,close:1,volume:0};nativeModel.store.setData([b]);globalThis.call=events=>nativeApplyUnchangedDataEvents(events);`);
 let r=plain(run(c,"call([{kind:'update',bar:{...nativeModel.store.at(0),volume:-0}}])"));assert.equal(r.unchanged,false);assert.equal(run(c,'Object.is(nativeModel.store.columns.volume[0],-0)'),true);
 r=plain(run(c,"call([{kind:'update',bar:{...nativeModel.store.at(0),volume:1}},{kind:'update',bar:{...nativeModel.store.at(0),volume:-0}}])"));assert.equal(r.unchanged,true);
 const before=run(c,'nativeModel.store.version');assert.throws(()=>run(c,"call([{kind:'update',bar:{...nativeModel.store.at(0),high:0}},{kind:'update',bar:nativeModel.store.at(0)}])"));assert.equal(run(c,'nativeModel.store.version'),before);
});
test('no-op receipt validation adds no accessor calls beyond existing core and rejects inconsistent fields',t=>{
 const c=fixture(t);run(c,`globalThis.calls=0;globalThis.original=nativeModel.store.applyEvents;globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}];`);
 for(const [key,value]of [['unchanged',"'true'"],['events','1.5'],['appended','1'],['version','NaN'],['length','0'],['capacity','3'],['bytes','1'],['from','-1'],['to','0']]){run(c,`nativeModel.store.applyEvents=function(...args){return {...original.apply(this,args),${key}:${value}}}`);assert.throws(()=>run(c,'nativeApplyUnchangedDataEvents(events)'));}
 run(c,`nativeModel.store.applyEvents=function(...args){const r={...original.apply(this,args)};Object.defineProperty(r,'unchanged',{get(){calls++;return true}});return r}`);assert.throws(()=>run(c,'nativeApplyUnchangedDataEvents(events)'),/own data/);assert.equal(run(c,'calls'),1); // Existing ChartAPI reads unchanged once; endpoint descriptor checks add zero.

});
test('no-op source and owner replacement reject, while postcommit extra mutation retains changed receipt',t=>{
 const c=fixture(t);run(c,`globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}];globalThis.original=nativeModel.store.applyEvents;nativeModel.store.applyEvents=function(...args){const r=original.apply(this,args);this.columns={...this.columns};return r}`);assert.throws(()=>run(c,'nativeApplyUnchangedDataEvents(events)'),/owner/);
 run(c,`nativeModel.store.applyEvents=original;globalThis.stop=nativeModel.store.subscribe(()=>{stop();const b=nativeModel.store.at(0);nativeModel.store.update(0,{...b,volume:b.volume+1})});`);
 const r=plain(run(c,"nativeApplyUnchangedDataEvents([{kind:'update',bar:{...nativeModel.store.at(3),volume:123}}])"));assert.equal(r.unchanged,false);assert.equal(r.afterVersion,r.beforeVersion+2);
 run(c,`nativeAPI.model=new Aster.ChartModel()`);assert.throws(()=>run(c,'nativeApplyUnchangedDataEvents(events)'),/owner/);run(c,'nativeAPI.model.dispose()');
});
test('legacy one-argument JSON command still publishes and rejects extra options',t=>{
 const c=fixture(t);run(c,`globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}];globalThis.version=nativeModel.store.version;globalThis.invalidates=0;nativeAPI.invalidate=()=>invalidates++;`);
 const r=plain(run(c,"nativeCommand('applyDataEvents',[events])"));assert.equal(Object.hasOwn(r,'unchanged'),false);assert.equal(run(c,'nativeModel.store.version===version+1&&invalidates===1'),true);assert.throws(()=>run(c,"nativeCommand('applyDataEvents',[events,{skipUnchanged:true}])"),/argument count/);
});
test('dedicated true endpoint uses captured canonical API while legacy override remains available',t=>{
 const c=fixture(t);run(c,`globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}];nativeAPI.applyDataEvents=()=>{throw Error('legacy override')}`);
 assert.equal(plain(run(c,'nativeApplyUnchangedDataEvents(events)')).unchanged,true);assert.throws(()=>run(c,"nativeCommand('applyDataEvents',[events])"),/legacy override/);
});
test('overflow-before-revert is atomic and timestamp signed zero remains a real change',t=>{
 const c=fixture(t);run(c,`nativeModel.store.setData([{time:0,open:1,high:1,low:1,close:1,volume:1e308},{time:1,open:1,high:1,low:1,close:1,volume:0}]);globalThis.before=nativeModel.store.version;globalThis.columns=nativeModel.store.columns;globalThis.index=nativeModel.store.index;globalThis.notices=0;nativeModel.store.subscribe(()=>notices++);`);
 assert.throws(()=>run(c,"nativeApplyUnchangedDataEvents([{kind:'update',bar:{...nativeModel.store.at(1),volume:1e308}},{kind:'update',bar:nativeModel.store.at(1)}])"),/overflow/i);
 assert.equal(run(c,'nativeModel.store.version===before&&nativeModel.store.columns===columns&&nativeModel.store.index===index&&nativeModel.store.at(1).volume===0&&notices===0'),true);
 const r=plain(run(c,"nativeApplyUnchangedDataEvents([{kind:'correction',bar:{...nativeModel.store.at(0),time:-0}}])"));assert.equal(r.unchanged,false);assert.equal(run(c,'Object.is(nativeModel.store.columns.time[0],-0)&&notices===1'),true);
});
test('unchanged batch preserves pending params capture; changed batch follows existing stale policy',t=>{
 const c=fixture(t);run(c,`globalThis.job=nativeParamsSourceBegin('ema',{period:9},0,805306368,1);globalThis.events=[{kind:'update',bar:nativeModel.store.at(3)}]`);
 assert.equal(plain(run(c,'nativeApplyUnchangedDataEvents(events)')).unchanged,true);assert.equal(c.nativeParamsSourceCheck(c.job.ticket,0),true);c.nativeParamsSourceAbort(1);
 run(c,"globalThis.job=nativeParamsSourceBegin('ema',{period:9},0,805306368,2)");assert.equal(plain(run(c,"nativeApplyUnchangedDataEvents([{kind:'update',bar:{...nativeModel.store.at(3),volume:123}}])")).unchanged,false);assert.throws(()=>c.nativeParamsSourceCheck(c.job.ticket,0),/changed|stale/i);assert.equal(c.nativeParamsSourceStatus(2).status,'failed');
});
