import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/index.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function setup() {
 const model = new A.ChartModel(); let notifications=0;
 const controller = new A.InteractionController(model,()=>({width:1000,height:600}));
 const api = new A.ChartAPI(model,{controller,invalidate:()=>notifications++});
 api.addSeries({id:'price',type:'candles',panel:'price'});
 return {model,controller,api,notifications:()=>notifications};
}
const bar=(time=1700000000123,close=1.345678901234e-12)=>({time,open:1.2e-12,high:2e-12,low:1e-12,close,volume:7});

test('common facade preserves external precision and applies streaming corrections/reset/prepend',()=>{
 const {api,model,notifications}=setup();api.setData([bar()]);
 const before=notifications();api.applyDataEvent({kind:'append',bar:bar(1700000060123)});
 api.applyDataEvent({kind:'update',bar:bar(1700000060123,1.8e-12)});
 api.applyDataEvent({kind:'correction',bar:bar(1700000000123,1.6e-12)});
 api.applyDataEvent({kind:'prepend',bars:[bar(1699999940123)]});
 assert.equal(model.store.length,3);assert.equal(model.store.at(1).close,1.6e-12);
 assert.equal(model.store.at(2).time,1700000060123);assert.equal(notifications()-before,4);
 const version=model.store.version;assert.throws(()=>api.applyDataEvent({kind:'append',bar:bar(1700000060123)}));
 assert.equal(model.store.version,version);
 api.applyDataEvent({kind:'reset',bars:[]});assert.equal(api.inspect().storedBars,0);model.dispose();
});
test('common JSON columns and custom values copy data and retain NaN gaps',()=>{
 const {api,model}=setup();const columns=Object.fromEntries(Object.entries(A.seededColumns(20)).map(([k,v])=>[k,Array.from(v)]));
 api.setColumns(columns);columns.close[0]=0;assert.notEqual(model.store.at(0).close,0);
 api.addSeries({id:'custom',type:'line',panel:'price',values:Array.from({length:20},(_,i)=>i===0?null:i)});
 assert.ok(Number.isNaN(model.series[1].values[0]));
 api.setSeriesValues('custom',Array.from({length:20},()=>4));assert.equal(model.series[1].values[19],4);
 assert.throws(()=>api.setSeriesValues('custom',[1]));model.dispose();
});
test('indicator registration and display are separate; output selection/remove is explicit',()=>{
 const {api,model}=setup();model.store.setColumns(A.seededColumns(300));
 const result=api.addIndicator('st','supertrend',{period:10});
 assert.ok(result.outputs.includes('direction'));assert.equal(model.series.length,1);
 api.addSeries({id:'trend',type:'line',panel:'price',indicator:'st',output:'value'});
 assert.throws(()=>api.addSeries({id:'bad',type:'line',panel:'price',indicator:'st',output:'missing'}));
 api.registerIndicatorSource('double','() => ({outputs:["value"],create(){return {step:b=>[b.close*2],snapshot:()=>0,restore:()=>{}}}})');
 api.addIndicator('c','double');assert.equal(api.indicatorValues('c','value')[299],model.store.at(299).close*2);
 api.removeIndicator('st');assert.equal(model.series.length,1);assert.throws(()=>model.indicators.get('st'));model.dispose();
});
test('series patch preserves ordering and invalid patches are atomic',()=>{
 const {api,model}=setup();model.store.setColumns(A.seededColumns(40));
 api.addSeries({id:'line',type:'line',panel:'price'});api.setSeries('line',{visible:false,color:'rgba(255,0,0,0.5)',width:3});
 assert.deepEqual(model.series.map(s=>s.id),['price','line']);assert.equal(model.series[1].color,'#ff000080');
 const before=api.inspect();assert.throws(()=>api.setSeries('line',{panel:'missing'}));assert.deepEqual(api.inspect(),before);
 api.addIndicator('e','ema');api.setSeries('line',{indicator:'e',output:'value'});const saved=api.inspect();assert.throws(()=>api.setSeries('line',{output:'missing'}));assert.deepEqual(api.inspect(),saved);
 api.setSeries('line',{indicator:null});
 assert.equal(model.series[1].offset,0);assert.equal(model.series[1].indicator,undefined);
 api.setSeries('line',{visible:true,source:'high'});assert.equal(model.seriesData(model.series[1]).values[0],model.store.at(0).high);model.dispose();
});
test('candles and OHLC honor public stroke width and reject ignored indicator/value sources',()=>{
 const {api,model}=setup();model.store.setColumns(A.seededColumns(30));api.setSeries('price',{width:4,upColor:'#0f0'});
 const commands=A.buildScene(model,1000,600).commands;assert.ok(commands.some(c=>c.op==='lines'&&c.color==='#00ff00ff'&&c.width===4));
 api.setSeries('price',{type:'ohlc'});assert.ok(A.buildScene(model,1000,600).commands.some(c=>c.op==='lines'&&c.color==='#00ff00ff'&&c.width===4));
 api.addIndicator('r','rsi');assert.throws(()=>api.addSeries({id:'invalid',type:'candles',panel:'price',indicator:'r'}));
 assert.throws(()=>api.setSeries('price',{values:Array(30).fill(1)}));assert.throws(()=>api.setSeries('price',{source:'volume'}));
 model.dispose();
});
test('programmatic drawing operations share lock, selection, undo/redo and storage semantics',()=>{
 const {api,model,controller}=setup();api.setData([bar()]);
 const id=api.addDrawing({type:'text',points:[{time:bar().time,price:bar().close}],text:'한국 🚀',style:{font:'bold 18px serif',color:'#abc'}});
 assert.equal(api.inspect().selected,id);api.editDrawing(id,{text:'edited'});const saved=api.saveDrawings();
 api.undo();assert.equal(model.drawings.items[0].text,'한국 🚀');api.redo();assert.equal(api.saveDrawings(),saved);
 api.editDrawing(id,{locked:true});assert.equal(api.deleteDrawing(id),false);api.editDrawing(id,{locked:false});assert.equal(api.deleteDrawing(id),true);
 api.loadDrawings(saved);api.selectDrawing(id);assert.equal(model.drawings.selected,id);
 api.setTool('rectangle');controller.down(1,200,200);controller.move(1,400,300);api.undo();controller.move(1,450,350);
 assert.equal(controller.gesture,null);assert.equal(controller.pointers.size,0);assert.equal(model.drawings.items.length,1);model.dispose();
});
test('portable styles and metadata formatting are shared and invalid theme changes do not mutate',()=>{
 const {api,model}=setup();api.setData([bar()]);api.setTheme({background:'#123',font:'italic bold 20px sans-serif',up:'lime'});
 const scene=A.buildScene(model,1000,600);assert.equal(scene.background,'#112233ff');assert.equal(scene.commands.find(c=>c.op==='text').font,'italic bold 20px sans-serif');
 const before={...model.theme};assert.throws(()=>api.setTheme({background:'#fff',font:'bad font'}));assert.deepEqual(model.theme,before);
 api.setSymbol({id:'TINY',exchange:'SYNTH',timezone:'America/New_York',currency:'USD',priceDecimals:15,tickSize:1e-15,volumeUnit:'units',adjustment:'raw'});
 assert.equal(model.priceFormatter(1.234567890123e-12),'0.000000000001235');assert.equal(model.timeFormatter(Date.parse('2026-03-09T13:30:00Z')),'2026-03-09 09:30');
 assert.throws(()=>api.setTheme({grid:'var(--grid)'}));model.dispose();
 assert.throws(()=>api.setTheme({background:null}));assert.throws(()=>api.setTheme('invalid'));assert.throws(()=>api.setTheme({up:'rgb(,,)'}));
});
test('configured native initialization uses explicit series and rejects bad options without replacing previous model',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../native/Resources/aster-core.js',import.meta.url),'utf8'),context);
 vm.runInContext(`nativeInit(0,{panels:[{id:'price'}],series:[{id:'p',type:'candles',panel:'price'}],theme:{background:'#123'}})`,context);
 const state=JSON.parse(vm.runInContext('JSON.stringify(nativeCommand("inspect"))',context));assert.equal(state.series.length,1);assert.equal(state.panels.length,1);assert.equal(state.theme.background,'#112233ff');
 const previous=context.nativeModel;assert.throws(()=>vm.runInContext('nativeInit(0,{series:[{id:"bad",type:"invalid",panel:"price"}]})',context));assert.equal(context.nativeModel,previous);
 context.nativeModel.dispose();
});
test('dispatch only accepts common commands and failed mutations do not notify',()=>{
 const {api,model,notifications}=setup();const before=notifications();
 assert.throws(()=>api.dispatch('__proto__',[]));assert.throws(()=>api.dispatch('constructor',[]));
 assert.throws(()=>api.dispatch('setData',[[bar(),bar()]]));assert.equal(notifications(),before);
 assert.equal(api.dispatch('setData',[[bar()]]),null);assert.equal(api.dispatch('inspect',[]).lastBar.time,bar().time);model.dispose();
});
