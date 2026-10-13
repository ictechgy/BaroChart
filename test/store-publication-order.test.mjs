import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,IndicatorEngine} from '../src/core/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {installRecomputed,modelRequest} from '../src/web/worker-state.mjs';
const T=1700000000000,bars=()=>Array.from({length:32},(_,i)=>({time:T+i*60000,open:100,high:120,low:90,close:110,volume:1}));
for(const kind of ['reset','prepend','correction'])for(const worker of [false,true])test(`early public observer viewport survives ${kind} through ${worker?'prepared packet':'synchronous API'}`,async()=>{
 const store=new BarStore(bars());let api,armed=false;const stop=store.subscribe(()=>{if(armed){armed=false;api.setVisibleRange(4,14);}});const model=new ChartModel({store});api=new ChartAPI(model);
 try{const event=kind==='reset'?{kind,bars:bars()}:kind==='prepend'?{kind,bars:[{...store.at(0),time:T-60000}]}:{kind,bar:{...store.at(0),volume:999}};armed=true;
  if(worker){const options=modelRequest(model),packet=await computeRequest({columns:store.columns,length:32,options,event});installRecomputed(model,packet,event,options);}else api.applyDataEvent(event);
  assert.deepEqual(model.view,{from:4,to:14});assert.equal(model.follow,false);assert.equal(store.listenerErrors.length,0);
 }finally{stop();model.dispose();assert.equal(store.listeners.size,0);}
});
test('early public observer reads current indicator and external series ranges',()=>{
 const store=new BarStore(bars());let model,api,seen;const stop=store.subscribe(()=>{seen={ema:model.indicators.get('ema').outputs.value[1],range:model.seriesData(model.series[0]).index.query(0,32)};});model=new ChartModel({store});api=new ChartAPI(model);model.indicators.add('ema','ema',{period:2});api.addSeries({id:'close',type:'line',panel:'price',source:'close'});model.seriesData(model.series[0]);
 try{const replacement=bars().map(b=>({...b,open:200,high:240,low:180,close:220}));api.applyDataEvent({kind:'reset',bars:replacement});const fresh=new IndicatorEngine(store);try{assert.equal(seen.ema,fresh.add('ema','ema',{period:2}).outputs.value[1]);assert.equal(seen.range.min,220);assert.equal(seen.range.max,220);}finally{fresh.dispose();}}
 finally{stop();model.dispose();}
});
test('reentrant data mutation completes internal state before a later explicit viewport',()=>{
 const store=new BarStore(bars());let api,armed=true;const versions=[],stop=store.subscribe(change=>{versions.push(change.version);if(armed){armed=false;api.applyDataEvent({kind:'reset',bars:bars()});api.setVisibleRange(4,14);}});const model=new ChartModel({store});api=new ChartAPI(model);
 try{api.applyDataEvent({kind:'prepend',bars:[{...store.at(0),time:T-60000}]});assert.deepEqual(model.view,{from:4,to:14});assert.equal(model.follow,false);assert.deepEqual(versions,[2,3]);assert.equal(store.listenerErrors.length,0);}finally{stop();model.dispose();}
});
