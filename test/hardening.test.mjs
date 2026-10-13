import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,DrawingStore,RangeIndex,seededColumns,buildScene} from '../src/index.mjs';
const row=(time=1)=>({time,open:1,high:2,low:0,close:1,volume:1});
test('panel and command schema reject prototype keys, identity changes and wrong types atomically',()=>{
 const model=new ChartModel(),api=new ChartAPI(model),before=api.inspect();
 for(const patch of [JSON.parse('{"__proto__":{"injected":true}}'),{id:'other'},{formatter:'code'},{inverted:'yes'}])assert.throws(()=>api.setPanel('price',patch));
 assert.deepEqual(api.inspect(),before);assert.equal(Object.getPrototypeOf(model.panels[0]),Object.prototype);
 for(const patch of [JSON.parse('{"constructor":{"prototype":{"x":true}}}'),{unknown:'x'},{background:null}])assert.throws(()=>api.setTheme(patch));
 assert.throws(()=>api.dispatch('setData',[[row()],1,2,3]));model.dispose();
});
test('typed column copy ignores overridden helpers and validates the owned snapshot',()=>{
 const columns=seededColumns(4),store=new BarStore();const close=columns.close[0];
 columns.close.subarray=()=>Float64Array.of(NaN,NaN,NaN,NaN);store.setColumns(columns);assert.equal(store.at(0).close,close);
 const before=store.at(0),version=store.version;
 assert.throws(()=>store.setColumns({time:[1],open:[1],high:[2],low:[0],close:[NaN],volume:[1]}));assert.deepEqual(store.at(0),before);assert.equal(store.version,version);
 assert.throws(()=>store.setData({length:1,[Symbol.iterator]:function*(){yield row();},0:row()}));assert.equal(store.version,version);
});
test('bar getters are read once and cannot change values between validation and commit',()=>{
 const store=new BarStore([row()]);let reads=0;const bar={...row(2),get close(){return ++reads===1?1:NaN;}};store.append(bar);
 assert.equal(store.at(1).close,1);assert.equal(reads,1);
});
test('data and range-index bounds reject allocation abuse and volume overflow before mutation',()=>{
 const store=new BarStore([row()],{maxBars:2});store.append(row(2));const before=store.version;
 assert.throws(()=>store.append(row(3)),/limit/i);assert.equal(store.length,2);assert.equal(store.version,before);
 assert.throws(()=>new RangeIndex(Infinity,[],[],null,Infinity));
 const index=new RangeIndex(2,new Float64Array([1,2]));const q=index.query(0,2);assert.throws(()=>index.update(-1,0));assert.throws(()=>index.update(2,0));assert.deepEqual(index.query(0,2),q);
 const overflow=new BarStore([{...row(),volume:1e308}]);assert.throws(()=>overflow.append({...row(2),volume:1e308}));assert.equal(overflow.length,1);
});
test('drawing import schema, aggregate point and payload budgets preserve the prior document on failure',()=>{
 const d=new DrawingStore({maxDrawings:2,maxPoints:4,maxDocumentChars:2048});d.add({type:'trendline',points:[{time:1,price:1},{time:2,price:2}]});const saved=d.save();
 const documents=[{schema:'aster.drawings',version:1,drawings:JSON.parse(saved).drawings,extra:1},JSON.parse(saved)];documents[1].drawings[0].style=JSON.parse('{"__proto__":{"color":"red"}}');
 for(const doc of documents)assert.throws(()=>d.load(JSON.stringify(doc)));assert.equal(d.save(),saved);
 assert.throws(()=>d.load(' '.repeat(2049)),/limit/i);assert.throws(()=>d.add({type:'freehand',points:Array.from({length:3},(_,i)=>({time:i,price:1}))}));assert.equal(d.save(),saved);
});
test('JSON dispatch cannot execute trusted source while the explicit code API remains available',()=>{
 const model=new ChartModel(),api=new ChartAPI(model);globalThis.auditExecuted=false;
 assert.throws(()=>api.dispatch('registerIndicatorSource',['bad','(()=>{globalThis.auditExecuted=true;return ()=>({})})()']));assert.equal(globalThis.auditExecuted,false);
 api.registerIndicatorSource('good','()=>({outputs:["v"],create(){return {step:()=>[1],snapshot:()=>0,restore(){}}}})');api.addIndicator('g','good');model.dispose();delete globalThis.auditExecuted;
});
test('style changes retain the index; source changes invalidate it and outputs are own properties',()=>{
 const model=new ChartModel();model.store.setColumns(seededColumns(100));const api=new ChartAPI(model);api.addSeries({id:'l',type:'line',panel:'price'});buildScene(model,1000,600);const index=model.series[0].rangeIndex;
 api.setSeries('l',{color:'red',width:3,visible:false});api.setSeries('l',{visible:true});buildScene(model,1000,600);assert.equal(model.series[0].rangeIndex,index);
 api.setSeries('l',{source:'high'});buildScene(model,1000,600);assert.notEqual(model.series[0].rangeIndex,index);api.addIndicator('e','ema');assert.throws(()=>api.addSeries({id:'bad',type:'line',panel:'price',indicator:'e',output:'constructor',offset:0}));model.dispose();
});
test('finite extreme prices never yield non-finite display coordinates',()=>{
 const model=new ChartModel({store:new BarStore([{time:1,open:-1e308,high:1e308,low:-1e308,close:1e308,volume:1}])});model.addSeries({id:'p',type:'candles',panel:'price'});
 const scene=buildScene(model,1000,600);for(const c of scene.commands)for(const x of [...(c.coords??[]),...(c.points??[])])assert.ok(Number.isFinite(x));model.dispose();
});
