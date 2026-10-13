import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIndicatorParams} from '../src/core/indicator-params.mjs';
test('portable params preserve primitives and bound calendar text without getters',()=>{
 const valid={period:20,calendar:' '.repeat(1000)};assert.equal(validateIndicatorParams(valid),valid);
 for(const bad of [{x:true},{x:Infinity},{x:{}},{x:' '.repeat(257)},{calendar:' '.repeat(65537)},Object.fromEntries(Array.from({length:33},(_,i)=>['p'+i,i]))])assert.throws(()=>validateIndicatorParams(bad));
 let calls=0;const getter={};Object.defineProperty(getter,'period',{enumerable:true,get(){calls++;return 20;}});assert.throws(()=>validateIndicatorParams(getter));assert.equal(calls,0);
 const hidden={};Object.defineProperty(hidden,'hidden',{value:20});assert.throws(()=>validateIndicatorParams(hidden));assert.throws(()=>validateIndicatorParams({[Symbol('x')]:20}));
});
