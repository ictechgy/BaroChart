import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinIndicators} from '../src/core/indicators.mjs';
import {seededColumns} from '../src/core/data.mjs';
import {safeCheckpointParse,safeCheckpointStringify,validateCheckpointState} from '../src/core/checkpoint-validation.mjs';
import {encodeCheckpoints,LazyCheckpoints} from '../src/web/checkpoint-codec.mjs';

test('every built-in initial, warm-up and completed checkpoint validates without changing state',()=>{
 const columns=seededColumns(600),bar={},indices=new Set([0,1,2,9,13,14,19,20,26,52,256,512,600]);
 for(const [name,factory] of builtinIndicators){const instance=factory({}).create();for(let i=0;i<=600;i++){if(indices.has(i)){const state=instance.snapshot();assert.equal(validateCheckpointState(name,{},state,i),state,name+' index '+i);assert.deepEqual(safeCheckpointParse(safeCheckpointStringify(state)),state);}if(i<600){for(const key of Object.keys(columns))bar[key]=columns[key][i];instance.step(bar,i);}}}
});
test('period-one, zero-volume, flat and long warm-up builtin states remain valid',()=>{
 for(const [name,factory] of builtinIndicators){for(const params of [{period:1},{period:10000,conversion:10000,base:10000,span:10000,stochPeriod:10000}]){const instance=factory(params).create();for(let i=0;i<=300;i++){if([0,1,2,256,300].includes(i)){const state=instance.snapshot();assert.equal(validateCheckpointState(name,params,state,i),state,name+' index '+i);}if(i<300)instance.step({time:i*60000,open:0,high:0,low:0,close:0,volume:0},i);}}}
 for(const name of ['vwap','pivots']){const params={sessionMs:1e-300},instance=builtinIndicators.get(name)(params).create();instance.step({time:1e15,open:1,high:1,low:1,close:1,volume:0},0);assert.equal(validateCheckpointState(name,params,instance.snapshot(),1).session,Infinity);}
});
test('builtin payload schema rejects missing, unknown and invalid nested fields',()=>{
 for(const state of [{},{e:{count:20,sum:0,value:1},extra:0},{e:{count:21,sum:0,value:1}},{e:{count:20,sum:0,value:'1'}},{e:{count:1,sum:0,value:1}},{e:{count:20,sum:0,value:Infinity}}])assert.throws(()=>validateCheckpointState('ema',{},state,256));
 assert.throws(()=>validateCheckpointState('donchian',{}, {h:{a:[[255,1]],head:0},l:{a:[[256,1]],head:0}},256));
 assert.throws(()=>validateCheckpointState('stochRSI',{}, {previous:1,valid:1,h:{a:[[1,50]],head:0}},256));
 assert.throws(()=>validateCheckpointState('notBuiltin',{}, {},0));
 assert.throws(()=>validateCheckpointState('ema',{},new Date(),0));
});
test('checkpoint JSON bounds and exact special-number tokens reject damaged state',()=>{
 const valid={v:[NaN,Infinity,-Infinity,-0,0],text:'한국 🚀'};assert.deepEqual(safeCheckpointParse(safeCheckpointStringify(valid)),valid);assert.ok(Object.is(safeCheckpointParse('{"x":{"$asterNumber":"-0"}}').x,-0));
 for(const text of ['{"x":1e309}','{"x":1,"x":2}','{"x":"\\ud800"}','{"x":{"$asterNumber":null}}','{"x":{"$asterNumber":"123"}}','{"x":{"$asterNumber":"NaN","other":1}}','['.repeat(40)+'0'+']'.repeat(40)])assert.throws(()=>safeCheckpointParse(text));
 assert.throws(()=>safeCheckpointStringify({value:undefined}));
 assert.throws(()=>safeCheckpointStringify({value:'\ud800'}));
 assert.throws(()=>safeCheckpointStringify(Object.defineProperty([0],0,{get(){return 0;}})));
 const cycle={};cycle.self=cycle;assert.throws(()=>safeCheckpointStringify(cycle));
 assert.throws(()=>safeCheckpointParse(' '.repeat(8388609)),/limit/);
 assert.throws(()=>safeCheckpointParse('['+'0,'.repeat(250000)+'0]'),/limit/);
});
test('generic compact codec preserves negative zero and reserves only exact number markers',()=>{
 const original={previous:-0,value:0,values:[NaN,-0,0,Infinity,-Infinity]},lazy=new LazyCheckpoints(encodeCheckpoints(new Map([[0,original]])));
 assert.deepEqual(lazy.get(0),original);assert.ok(Object.is(lazy.get(0).previous,-0));assert.ok(Object.is(lazy.get(0).values[1],-0));assert.equal(Object.is(lazy.get(0).value,-0),false);
 assert.throws(()=>safeCheckpointParse('{"value":{"$asterNumber":"-00"}}'));
});
test('context validation checks complete ordered boundaries and leaves the decode cache empty',async()=>{
 const lazy=new LazyCheckpoints(encodeCheckpoints(new Map([[0,{}],[256,{e:{count:20,sum:0,value:100}}],[512,{e:{count:20,sum:0,value:101}}]])));
 assert.equal(lazy.validate(550,256,'ema',{}),lazy);assert.equal(lazy.cache.size,0);
 let yields=0;assert.equal(await lazy.validateAsync(550,256,'ema',{}, {maxRecordsPerSlice:1,yieldTask:async()=>{yields++;}}),lazy);assert.ok(yields>=2);assert.equal(lazy.cache.size,0);
 assert.throws(()=>lazy.validate(511,256,'ema',{}));assert.throws(()=>lazy.validate(550,128,'ema',{}));
 assert.equal(new LazyCheckpoints(encodeCheckpoints(new Map())).validate(0).size,0);
 const controller=new AbortController();controller.abort();await assert.rejects(lazy.validateAsync(550,256,'ema',{}, {signal:controller.signal}),/abort/i);
 const later=new AbortController();await assert.rejects(lazy.validateAsync(550,256,'ema',{}, {signal:later.signal,maxRecordsPerSlice:1,yieldTask:async()=>later.abort()}),/abort/i);assert.equal(lazy.cache.size,0);
});
