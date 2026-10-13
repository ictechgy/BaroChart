import test from 'node:test';
import assert from 'node:assert/strict';
import {BlockRangeIndex} from '../src/core/block-index.mjs';
test('Capacity tail is inactive for extrema even when backing storage is finite',()=>{
 const values=new Float64Array(131072).fill(-1234);values.fill(7,0,65537);
 const index=new BlockRangeIndex(65537,values,131072);
 assert.deepEqual(index.query(65536,65538),{min:7,max:7,sum:0});
 for(const [from,to] of [[65537,65538],[65537,65570],[131060,131072],[65537,65537]])assert.deepEqual(index.query(from,to),{min:Infinity,max:-Infinity,sum:0});
 assert.equal(index.finiteCount(65536,65538),1);assert.equal(index.hasGaps(65536,65538),true);
 assert.deepEqual(index.query(65530,65550),{min:7,max:7,sum:0});
 values[65537]=12;index.update(65537);assert.deepEqual(index.query(65536,65539),{min:7,max:12,sum:0});
});
test('Unaligned logical end and NaN gaps match an independent bounded scan',()=>{
 const values=new Float64Array(128).fill(9999);for(let i=0;i<67;i++)values[i]=i%3?i:NaN;
 const index=new BlockRangeIndex(67,values,128);
 for(let from=0;from<=128;from+=7)for(let to=from;to<=128;to+=11){let min=Infinity,max=-Infinity,count=0;for(let i=from;i<Math.min(67,to);i++)if(Number.isFinite(values[i])){min=Math.min(min,values[i]);max=Math.max(max,values[i]);count++;}assert.deepEqual(index.query(from,to),{min,max,sum:0});assert.equal(index.finiteCount(from,to),count);}
});
