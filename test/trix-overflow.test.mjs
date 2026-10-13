import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,IndicatorEngine,builtinIndicators,seededColumns} from '../src/core/index.mjs';
const bar=(index,close)=>({time:1700000000000+index*60000,open:close,high:close,low:close,close,volume:1});
const sameVector=(actual,expected)=>{assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)assert.ok(Object.is(actual[i],expected[i]),`TRIX differs at ${i}: ${actual[i]} vs ${expected[i]}`);};

test('TRIX overflow is a NaN gap and long-decay corrections do not interrupt calculation',()=>{
 const store=new BarStore(Array.from({length:8192},(_,i)=>bar(i,0))),engine=new IndicatorEngine(store);
 engine.add('t','trix');
 for(const i of [0,7900])store.update(i,{...store.at(i),close:1000,high:1000});
 let corrected;assert.doesNotThrow(()=>{corrected=engine.get('t').outputs.value;});
 assert.ok(Number.isNaN(corrected[7900]),'unrepresentable percentage is a gap');
 assert.ok(Number.isFinite(corrected[7901]),'following finite percentages recover');
 assert.ok(corrected.every(v=>Number.isFinite(v)||Number.isNaN(v)));
 const batch=new IndicatorEngine(store);sameVector(corrected,batch.add('t','trix').outputs.value);
 const stream=builtinIndicators.get('trix')().create(),streamed=Float64Array.from(Array.from({length:store.length},(_,i)=>stream.step(store.at(i),i)[0]));sameVector(corrected,streamed);
 engine.dispose();batch.dispose();
});

test('TRIX zero denominator and division/percentage overflow produce gaps with subsequent recovery',()=>{
 const cases=[{values:[0,0,1,0,0],expected:[NaN,NaN,NaN,-100,NaN]},
  {values:[Number.MIN_VALUE,1,1],expected:[NaN,NaN,0]},
  {values:[1,1e307,1e307],expected:[NaN,NaN,0]}];
 for(const {values,expected} of cases){const store=new BarStore(values.map((v,i)=>bar(i,v))),engine=new IndicatorEngine(store);let output;assert.doesNotThrow(()=>{output=engine.add('t','trix',{period:1}).outputs.value;});sameVector(output,expected);engine.dispose();}
});

test('TRIX ordinary finite percentage retains its formula and checkpoint/stream parity',()=>{
 const values=[1,2,3,1,4],store=new BarStore(values.map((v,i)=>bar(i,v))),engine=new IndicatorEngine(store);sameVector(engine.add('t','trix',{period:1}).outputs.value,[NaN,100,50,(1/3-1)*100,300]);engine.dispose();
 const data=new BarStore();data.setColumns(seededColumns(2048,42));const batch=new IndicatorEngine(data),output=batch.add('t','trix').outputs.value,stream=builtinIndicators.get('trix')().create(),expected=Float64Array.from(Array.from({length:data.length},(_,i)=>stream.step(data.at(i),i)[0]));sameVector(output,expected);batch.dispose();
});
