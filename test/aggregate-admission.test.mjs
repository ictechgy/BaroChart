import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore} from '../src/core/data.mjs';

const bars=[10,20,30].map((close,index)=>({time:index+1,open:close,high:close+1,low:close-1,close,volume:1}));

test('aggregate requires a positive bucket count even for an empty range',()=>{
 for(const store of [new BarStore(),new BarStore(bars)])for(const count of [0,-1,NaN,Infinity,1.5,undefined]){
  assert.throws(()=>store.aggregate(0,0,count),/Positive bucket count/);
 }
});

test('aggregate rejects NaN bounds before allocation without changing the source',()=>{
 const store=new BarStore(bars),before={columns:store.columns,index:store.index,version:store.version};
 for(const [start,end] of [[NaN,3],[0,NaN]])assert.throws(()=>store.aggregate(start,end,2),/Aggregate bounds/);
 assert.deepEqual({columns:store.columns,index:store.index,version:store.version},before);
});

test('aggregate retains unbounded clamping, empty ranges and fractional bounds',()=>{
 const store=new BarStore(bars);
 assert.deepEqual(new BarStore().aggregate(-Infinity,Infinity,2),[]);
 assert.deepEqual(store.aggregate(5,7,2),[]);
 const all=store.aggregate(-Infinity,Infinity,1);
 assert.equal(all.length,1);assert.deepEqual([all[0].open,all[0].close,all[0].low,all[0].high,all[0].volume],[10,30,9,31,3]);
 assert.deepEqual(store.aggregate(.2,1.2,1).map(row=>[row.start,row.end,row.open,row.close]),[[0,2,10,20]]);
});
