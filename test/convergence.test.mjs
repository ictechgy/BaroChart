import test from 'node:test';import assert from 'node:assert/strict';
import {BarStore,seededColumns,ChartModel,IndicatorEngine,buildScene} from '../src/index.mjs';
const names=['sma','ema','macd','donchian','stochastic','rsi','atr','bollinger'];
const changed=(store,i)=>{const b=store.at(i);store.update(i,{...b,close:1000,high:Math.max(b.high,1000),low:Math.min(b.low,1000)});};
function expected(store,name){const fresh=new IndicatorEngine(store);try{return fresh.add('x',name);}finally{fresh.dispose();}}
test('builtin future-state convergence reuses only an exactly unchanged tail',()=>{
 const store=new BarStore();store.setColumns(seededColumns(4096));const engine=new IndicatorEngine(store);for(const name of names)engine.add(name,name);changed(store,0);
 for(const name of names){const result=engine.get(name),batch=expected(store,name);assert.deepEqual(result.outputs,batch.outputs,name);if(name==='bollinger')assert.equal(result.computedUntil,store.length);else assert.ok(result.computedUntil<store.length,name+' exact future state should converge');}engine.dispose();
});
test('multiple queued corrections prohibit reuse before the last dirty row',()=>{
 const store=new BarStore();store.setColumns(seededColumns(4096));const engine=new IndicatorEngine(store);for(const name of names)engine.add(name,name);changed(store,0);changed(store,3500);
 for(const name of names){const result=engine.get(name);assert.deepEqual(result.outputs,expected(store,name).outputs,name);assert.ok(result.computedUntil>3500,name+' must process later pending correction');}engine.dispose();
});
test('range cache updates exactly the computed interval and retains its allocation',()=>{
 const store=new BarStore();store.setColumns(seededColumns(8192));const model=new ChartModel({store});model.indicators.add('e','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});buildScene(model,1200,700);const index=model.series[0].rangeIndex;changed(store,0);buildScene(model,1200,700);assert.ok(model.series[0].rangeIndex===index,"range allocation retained");const out=model.indicators.get('e').outputs.value;
 for(const [from,to] of [[0,100],[0,8192],[400,2200],[7900,8192]]){const finite=[...out.subarray(from,to)].filter(Number.isFinite);assert.deepEqual(index.query(from,to),{min:Math.min(...finite),max:Math.max(...finite),sum:0});}model.dispose();
});
test('canonical rolling snapshots exclude expired queue storage without changing future outputs',()=>{
 const store=new BarStore();store.setColumns(seededColumns(4096));const engine=new IndicatorEngine(store);for(const name of ['donchian','stochastic']){engine.add(name,name);const entry=engine.entries.get(name);for(const state of entry.checkpoints.values())for(const q of Object.values(state))if(q&&Array.isArray(q.a)&&Array.isArray(q.a[0])){assert.equal(q.head,0);assert.ok(q.a.length<=20);}}
 changed(store,4095);for(const name of ['donchian','stochastic'])assert.deepEqual(engine.get(name).outputs,expected(store,name).outputs);engine.dispose();
});

test('series range cache covers corrections across unseen indicator revisions',()=>{const store=new BarStore();store.setColumns(seededColumns(10000,42));const model=new ChartModel({store});model.indicators.add('e','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});const series=model.series[0];model.seriesData(series);for(const index of [5000,0]){const b=store.at(index);store.update(index,{...b,close:1000,high:1000,low:Math.min(b.low,1000)});model.indicators.get('e');}const {values,index}=model.seriesData(series);assert.equal(index.query(5000,5001).max,values[5000]);model.dispose();});
