import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,seededColumns} from '../src/core/index.mjs';

const bits=values=>Buffer.from(new Uint8Array(values.buffer,values.byteOffset,values.byteLength));
function storeWith(length){const store=new BarStore();store.setColumns(seededColumns(length));return store;}

for(const length of [0,1024,65536])test(`dispose drops derived indices but preserves source/settings at ${length} rows`,()=>{
 const store=storeWith(length),model=new ChartModel({store}),external=Float64Array.from({length},(_,i)=>i%3?i*.123456789012345:-0);
 model.indicators.add('ema','ema',{period:20});
 model.addSeries({id:'indicator',type:'line',panel:'price',indicator:'ema'});
 model.addSeries({id:'source',type:'line',panel:'price',source:'close'});
 model.addSeries({id:'external',type:'histogram',panel:'price',values:external,baseline:-1});
 for(const series of model.series)model.seriesData(series);
 const series=model.series,settings=series.map(({rangeIndex,...rest})=>({...rest})),columns=store.columns,index=store.index;
 const source=Object.fromEntries(Object.entries(columns).map(([k,v])=>[k,bits(v)])),outside=bits(external);
 assert(series.every(s=>s.rangeIndex));model.dispose();
 assert.equal(model.disposed,true);assert.equal(model.series,series);assert.equal(model.indicators.entries.size,0);assert.equal(store.listeners.size,0);
 assert(series.every(s=>!s.rangeIndex),'Retained disposed model must not retain private range indices');
 assert.deepEqual(series.map(({rangeIndex,...rest})=>({...rest})),settings);
 assert.equal(series[2].values,external);assert.deepEqual(bits(external),outside);
 assert.equal(store.columns,columns);assert.equal(store.index,index);assert.equal(store.length,length);
 for(const [key,value] of Object.entries(source))assert.deepEqual(bits(columns[key]),value);
 model.dispose();assert(series.every(s=>!s.rangeIndex),'Repeated disposal must remain released');
});

test('disposing one model preserves a shared live model and caller-retained index views',()=>{
 const store=storeWith(1000),a=new ChartModel({store}),b=new ChartModel({store});
 for(const model of [a,b]){model.indicators.add('ema','ema',{period:20});model.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema'});}
 const held=a.seriesData(a.series[0]),heldBits=bits(held.values),other=b.seriesData(b.series[0]);
 a.dispose();assert.equal(store.listeners.size,2);assert.equal(a.series[0].rangeIndex,null);
 assert.deepEqual(bits(held.values),heldBits,'Caller-held views are not zeroed or detached');
 assert.equal(b.seriesData(b.series[0]).index,other.index);
 const last=store.at(999);store.update(999,{...last,close:last.high});
 const fresh=new ChartModel({store});fresh.indicators.add('ema','ema',{period:20});
 assert.deepEqual(b.indicators.get('ema').outputs.value,fresh.indicators.get('ema').outputs.value);
 b.dispose();fresh.dispose();assert.equal(store.listeners.size,0);
});

test('disposed raw/external series cannot rebuild derived caches',()=>{
 const model=new ChartModel({store:storeWith(100)});
 model.addSeries({id:'raw',type:'line',panel:'price',source:'close'});
 model.addSeries({id:'external',type:'line',panel:'price',values:new Float64Array(100).fill(7)});
 model.dispose();for(const series of model.series){assert.throws(()=>model.seriesData(series),/disposed/i);assert(!series.rangeIndex);}
});

for(const callback of ['create','restore','snapshot','step'])test(`indicator ${callback} disposal cannot reattach a derived index`,()=>{
 const store=storeWith(65536),model=new ChartModel({store});let armed=false,triggered=0;
 const maybeDispose=name=>{if(armed&&name===callback&&!triggered++){model.dispose();}};
 model.indicators.register('lifetime',()=>({outputs:['value'],create:()=>{
  maybeDispose('create');return {step:bar=>{maybeDispose('step');return [bar.close];},snapshot:()=>{maybeDispose('snapshot');return 0;},restore:()=>{maybeDispose('restore');}};
 }}));
 model.indicators.add('lifetime','lifetime');model.addSeries({id:'lifetime',type:'line',panel:'price',indicator:'lifetime'});
 model.seriesData(model.series[0]);const columns=store.columns;armed=true;
 const bar=store.at(512);store.update(512,{...bar,close:bar.high});
 assert.throws(()=>model.seriesData(model.series[0]),/disposed/i);
 assert(triggered>0,callback+' callback reached');assert.equal(model.disposed,true);
 assert.equal(model.indicators.entries.size,0);assert.equal(store.listeners.size,0);
 assert(!model.series[0].rangeIndex,'In-flight indicator completion must not republish its range cache');
 assert.equal(store.columns,columns);assert.equal(store.length,65536);
});
