import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel,ChartAPI,defineIndicatorModule} from '../src/core/index.mjs';
import {safeCheckpointStringify,safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';
import {AsyncCapture} from '../src/core/async-state.mjs';

const moduleId='oracle.study-save-zero-sign',canonical=moduleId+'@1/close';
defineIndicatorModule({id:moduleId,version:1,stateVersion:1,indicators:{close:{
 causal:true,
 factory({sign=0}={}) {
  return {outputs:['value'],create(){return {step:bar=>[Object.is(sign,-0)?bar.close:-bar.close],snapshot:()=>0,restore(){}};}};
 },
 validateCheckpoint(_params,state){if(state!==0)throw new TypeError('Only stateless checkpoint0 is supported');},
}}});
const bars=[10,20,30].map((close,i)=>({time:1700000000000+i*60000,open:close,high:close,low:close,close,volume:1}));
function fixture(t,sign) {
 const model=new ChartModel();let invalidations=0;
 const api=new ChartAPI(model,{invalidate:()=>invalidations++});t.after(()=>model.dispose());
 api.setData(bars);api.registerIndicatorModule(moduleId,1);api.addIndicator('z',canonical,{sign});
 return {model,api,invalidations:()=>invalidations};
}
function target(t) {
 const model=new ChartModel(),api=new ChartAPI(model);t.after(()=>model.dispose());api.setData(bars);
 return {model,api};
}

test('existing bounded checkpoint codec keeps negative zero and other finite doubles (passing control)',()=>{
 const input={sign:-0,positiveZero:0,subnormal:Number.MIN_VALUE,tiny:1e-300,negative:-1.25};
 const text=safeCheckpointStringify(input),restored=safeCheckpointParse(text);
 assert.ok(text.includes('"$asterNumber":"-0"'));
 for(const key of Object.keys(input))assert.ok(Object.is(restored[key],input[key]),'existing codec preserves '+key);
});

test('existing async metadata keeps the same module negative-zero parameter (passing control)',t=>{
 const f=fixture(t,-0),capture=new AsyncCapture(f.model,{kind:'correction',bar:{...bars[0],close:11,high:11}});
 const metadata=safeCheckpointParse(capture.metadataJSON);
 assert.ok(capture.metadataJSON.includes('"$asterNumber":"-0"'));
 const definition=metadata.indicators.find(row=>row.id==='z');
 assert.ok(Object.is(definition.params.sign,-0));assert.deepEqual(f.api.indicatorValues('z','value'),[10,20,30]);
});

test('study save uses number semantics compatible with the existing negative-zero reader codec',t=>{
 const f=fixture(t,-0),revision=f.model.store.version,listeners=[...f.model.store.listeners],invalidations=f.invalidations();
 const text=f.api.saveStudies(),definition=safeCheckpointParse(text).indicators.find(row=>row.id==='z');
 assert.ok(Object.is(definition.params.sign,-0),'successful study save must preserve a finite negative-zero parameter');
 assert.equal(f.model.store.version,revision);assert.deepEqual([...f.model.store.listeners],listeners);assert.equal(f.invalidations(),invalidations);
 assert.ok(Object.is(f.model.indicators.entries.get('z').params.sign,-0));assert.deepEqual(f.api.indicatorValues('z','value'),[10,20,30]);
});

test('same linked factory and version retain negative-zero behavior and complete output vector after study roundtrip',t=>{
 const f=fixture(t,-0),receiver=target(t),before=f.api.indicatorValues('z','value'),text=f.api.saveStudies();
 assert.deepEqual(before,[10,20,30]);assert.deepEqual(receiver.api.loadStudies(text),{indicators:1,series:0});
 assert.deepEqual(receiver.api.indicatorValues('z','value'),before,'same registered factory must compute the same vector after save/load');
 assert.ok(Object.is(receiver.model.indicators.entries.get('z').params.sign,-0));
 assert.ok(Object.is(f.model.indicators.entries.get('z').params.sign,-0));assert.deepEqual(f.api.indicatorValues('z','value'),before);
});

test('ordinary positive-zero and finite module params remain roundtrippable (existing passing control)',t=>{
 for(const sign of [0,1,-1,Number.MIN_VALUE]) {
  const f=fixture(t,sign),receiver=target(t),text=f.api.saveStudies();receiver.api.loadStudies(text);
  assert.ok(Object.is(receiver.model.indicators.entries.get('z').params.sign,sign));
  assert.deepEqual(receiver.api.indicatorValues('z','value'),[-10,-20,-30]);
 }
});
