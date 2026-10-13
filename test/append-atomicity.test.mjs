import test from 'node:test';import assert from 'node:assert/strict';
import {BarStore} from '../src/core/data.mjs';
test('append validates the actual tree fold before publishing length or columns',()=>{
 const bar=(time,volume)=>({time,open:1,high:1,low:1,close:1,volume});
 // Floating point regrouping: (MAX+a)+a stays finite while MAX+(a+a)
 // overflows. The preliminary total check is insufficient for this tree path.
 const a=2**969,store=new BarStore([bar(1,Number.MAX_VALUE),bar(2,0),bar(3,a)]),version=store.version,time=store.columns.time[3];
 assert.ok(Number.isFinite(store.index.sum[1]+a));assert.throws(()=>store.append(bar(4,a)),/overflow/);
 assert.equal(store.length,3);assert.equal(store.version,version);assert.equal(store.columns.time[3],time);assert.equal(store.index.sum[1],Number.MAX_VALUE);
});
