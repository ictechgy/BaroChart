import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel} from '../src/core/index.mjs';
const bar=(time,close=1,volume=1)=>({time,open:1,high:4,low:0,close,volume});
function state(store){return {length:store.length,version:store.version,timeVersion:store.timeVersion,columns:store.columns,index:store.index,rows:Array.from({length:store.length},(_,i)=>store.at(i)),rootVolume:store.index.sum[1],logicalVolume:store.index.query(0,store.length).sum};}
function same(store,before){assert.deepEqual(state(store),before);assert.strictEqual(store.columns,before.columns);assert.strictEqual(store.index,before.index);}
const actions={
 shrink(s){s.setData([bar(7,2)]);return 0;},
 empty(s){s.setData([]);return 0;},
 sameLengthReset(s){s.setData([bar(10,3),bar(20,4)]);return 20;},
 reentrantUpdate(s){s.update(0,bar(10,3,5));return 20;},
 reentrantAppend(s){s.append(bar(30,3));return 20;},
 reindex(s){s.reindex();return 20;}
};
for(const [name,action] of Object.entries(actions))test(`update rejects stale ${name} source and preserves the inner operation`,t=>{
 const store=new BarStore([bar(10),bar(20)]),model=new ChartModel({store});model.indicators.add('close','sma',{period:1});t.after(()=>model.dispose());
 const notices=[];store.subscribe(change=>notices.push({...change}));let reads=0,innerState,innerNotices;
 const input={...bar(20,2,99),get time(){reads++;const time=action(store);innerState=state(store);innerNotices=notices.length;return time;}};
 assert.throws(()=>store.update(1,input),/changed during update snapshot/);assert.equal(reads,1);same(store,innerState);assert.equal(notices.length,innerNotices);assert.equal(store.index.sum[1],store.index.query(0,store.length).sum);
 assert.deepEqual([...model.indicators.get('close').outputs.value],innerState.rows.map(row=>row.close));
 const time=store.length?store.at(store.length-1).time+1:1;store.append(bar(time,2,1));assert.equal(store.at(store.length-1).time,time);assert.equal(store.index.sum[1],store.index.query(0,store.length).sum);assert.equal(notices.length,innerNotices+1);
 assert.deepEqual([...model.indicators.get('close').outputs.value],Array.from({length:store.length},(_,i)=>store.at(i).close));
});
test('rejected stale update cannot leave a ghost volume that rejects a later valid append',()=>{
 const store=new BarStore([bar(10),bar(20)]),notices=[];store.subscribe(e=>notices.push(e.kind));
 const input={...bar(0,1,7e307),get time(){store.setData([bar(7,1,1e308)]);return 0;}};
 assert.throws(()=>store.update(1,input),/changed during update snapshot/);assert.equal(store.length,1);assert.equal(store.index.sum[1],1e308);assert.equal(store.columns.volume[1],0);assert.deepEqual(notices,['reset']);
 store.append(bar(8,1,1e307));assert.equal(store.length,2);assert.equal(store.index.sum[1],1e308+1e307);assert.deepEqual(notices,['reset','append']);
});
test('valid scalar updates still read each allowed field once and publish one notification',()=>{
 const store=new BarStore([bar(10)]),input={},counts={};for(const [field,value] of Object.entries(bar(10,3,2)))Object.defineProperty(input,field,{get(){counts[field]=(counts[field]??0)+1;return value;}});let notices=0;store.subscribe(()=>notices++);
 store.update(0,input);assert.deepEqual(store.at(0),bar(10,3,2));assert.equal(store.index.sum[1],2);assert.deepEqual(Object.values(counts),[1,1,1,1,1,1]);assert.equal(notices,1);
});
test('invalid original index still rejects before reading any bar getter',()=>{
 const store=new BarStore([bar(10)]);let calls=0;assert.throws(()=>store.update(1,{get time(){calls++;return 10;}}),/Bar index/);assert.equal(calls,0);assert.deepEqual(store.at(0),bar(10));
});
