import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI} from '../src/core/index.mjs';
const bar=time=>({time,open:1,high:4,low:0,close:2,volume:1});
function fixture(t){
 const model=new ChartModel({store:new BarStore([bar(1),bar(2),bar(3)])});let invalidations=0;
 const api=new ChartAPI(model,{invalidate(){invalidations++;}});api.addSeries({id:'existing',type:'line',panel:'price',values:[1,2,3]});model.seriesData(model.series[0]);invalidations=0;t.after(()=>model.dispose());
 const series=model.series,existing=series[0],values=existing.values,rangeIndex=existing.rangeIndex,revision=existing.revision,dirtyFrom=existing.dirtyFrom,storeVersion=model.store.version;
 return {model,api,unchanged(){assert.strictEqual(model.series,series);assert.equal(series.length,1);assert.strictEqual(series[0],existing);assert.strictEqual(existing.values,values);assert.deepEqual([...values],[1,2,3]);assert.strictEqual(existing.rangeIndex,rangeIndex);assert.equal(existing.revision,revision);assert.equal(existing.dirtyFrom,dirtyFrom);assert.equal(model.store.version,storeVersion);assert.equal(invalidations,0);}};
}
const operations={add(api,values){api.addSeries({id:'candidate',type:'line',panel:'price',values});},set(api,values){api.setSeries('existing',{values});},setValues(api,values){api.setSeriesValues('existing',values);}};
for(const [operation,apply] of Object.entries(operations))for(const bad of [Infinity,-Infinity,NaN,'3',undefined,true,3n,Symbol('value')])test(`${operation}: rejects second-pass ${String(bad)} and preserves published series/cache`,t=>{
 const f=fixture(t),input=[1,2,3];let reads=0;Object.defineProperty(input,'0',{enumerable:true,get(){return ++reads===1?1:bad;}});
 assert.throws(()=>apply(f.api,input),/Finite numbers or null gaps/);assert.equal(reads,2);f.unchanged();
});
for(const [operation,apply] of Object.entries(operations))test(`${operation}: second-pass object is rejected before numeric coercion`,t=>{
 const f=fixture(t),input=[1,2,3];let reads=0,coercions=0;const bad={valueOf(){coercions++;return 3;},toString(){coercions++;return '3';}};Object.defineProperty(input,'0',{enumerable:true,get(){return ++reads===1?1:bad;}});
 assert.throws(()=>apply(f.api,input),/Finite numbers or null gaps/);assert.equal(reads,2);assert.equal(coercions,0);f.unchanged();
});
for(const [operation,apply] of Object.entries(operations))test(`${operation}: typed NaN, array null and signed zero remain supported owned values`,t=>{
 const f=fixture(t),input=operation==='set'?new Float64Array([1,NaN,-0]):[1,null,-0];apply(f.api,input);const result=f.model.series.find(s=>s.id===(operation==='add'?'candidate':'existing')).values;
 assert.notStrictEqual(result,input);assert.equal(result[0],1);assert.ok(Number.isNaN(result[1]));assert.ok(Object.is(result[2],-0));input[0]=99;assert.equal(result[0],1);
});
test('supported typed custom iterator retains two accesses and second-pass NaN/null gaps',t=>{
 const f=fixture(t),input=new Float64Array([1,2,3]);let reads=0;Object.defineProperty(input,Symbol.iterator,{get(){const pass=++reads;return function*(){yield* pass===1?[1,2,3]:[NaN,null,-0];};}});
 f.api.setSeriesValues('existing',input);assert.equal(reads,2);const values=f.model.series[0].values;assert.ok(Number.isNaN(values[0]));assert.ok(Number.isNaN(values[1]));assert.ok(Object.is(values[2],-0));
});
test('finite changed getter values retain established second-pass conversion behavior',t=>{
 const f=fixture(t),input=[1,2,3];let reads=0;Object.defineProperty(input,'0',{get(){return ++reads===1?1:7;}});f.api.setSeriesValues('existing',input);assert.equal(reads,2);assert.deepEqual([...f.model.series[0].values],[7,2,3]);
});
test('a second-pass array NaN is still rejected rather than treated as a typed gap',t=>{
 const f=fixture(t);assert.throws(()=>f.api.setSeriesValues('existing',[NaN,2,3]),/Finite numbers/);f.unchanged();
});
