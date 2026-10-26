// Modeled DOM/no-op Canvas only: real CanvasChart event routing, scene cache,
// time-cursor ownership and explorer arbitration. No browser, pixels or focus QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel} from '../src/core/index.mjs';
import {CanvasChart,TimeCursorGroup} from '../src/renderers/canvas.mjs';
import {resolveCrosshairSnapshot} from '../src/core/crosshair-snap.mjs';
import {modeledChartDOM} from './helpers/shared-model-dom.mjs';
const T=1700000000000,bars=Array.from({length:20},(_,i)=>({time:T+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1}));
function fixture(t){const dom=modeledChartDOM(),charts=[],models=new Set();
 const element=()=>{const node=document.createElement('div');node.nodeType=1;node.isConnected=true;return node;};
 function make({model=null,layerCaching=true}={}){model??=new ChartModel({store:new BarStore(bars),visibleBars:20,panels:[{id:'price',range:[0,100],padding:0}]});if(!model.series.length)model.addSeries({id:'p',type:'candles',panel:'price'});models.add(model);const host=element();host.clientWidth=894;host.clientHeight=446;dom.root.append(host);const chart=new CanvasChart(host,model,{dpr:()=>1,observeResize:false,layerCaching,rasterCaching:'never',dataExplorer:{readout:element(),live:element()}});charts.push(chart);return chart;}
 function pointer(chart,x=132,y=96){const event=new Event('pointermove');Object.assign(event,{pointerId:1,clientX:x,clientY:y});chart.canvas.dispatchEvent(event);}
 function key(chart,key){const event=new Event('keydown',{cancelable:true});Object.assign(event,{key});chart.canvas.dispatchEvent(event);}
 t.after(()=>{try{for(const chart of charts)chart.destroy();for(const model of models)model.dispose();assert.equal(dom.frames.size,0);}finally{dom.restore();}});return {make,pointer,key,flush:()=>dom.settle()};
}
for(const layerCaching of [true,false])test(`snap midpoint publication uses selected index; remote remains time-only (cache=${layerCaching})`,async t=>{
 const f=fixture(t),a=f.make({layerCaching}),b=f.make({layerCaching}),g=new TimeCursorGroup({match:'exact'});t.after(()=>g.dispose());g.add(a);g.add(b);a.api.setCrosshairSnap({mode:'ohlc'});b.api.setCrosshairSnap({mode:'close'});await f.flush();
 const get=a.model.indicators.get;a.model.indicators.get=()=>assert.fail('Pointer publication must not compute');try{f.pointer(a);assert.equal(b.timeCursor.requestedTime,bars[2].time);assert.equal(b.model.crosshair,null);}finally{a.model.indicators.get=get;}
 await f.flush();const line=b.lastScene.commands.find(c=>c.role==='synced-time-cursor');assert.deepEqual(line.coords,[112,12,112,412]);assert.equal(b.lastScene.commands.some(c=>c.role==='crosshair-price'),false);assert.equal(b.api.crosshairSnapshot(894,446),null);
 assert.equal(a.api.crosshairSnapshot(894,446).index,2);assert.equal(a.api.crosshairValues(894,446).index,2);
});
test('free midpoint retains legacy later rounding; stationary toggle does not rebroadcast time',async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),g=new TimeCursorGroup({match:'exact'});t.after(()=>g.dispose());g.add(a);g.add(b);await f.flush();f.pointer(a);assert.equal(b.timeCursor.requestedTime,bars[3].time);const generation=b.timeCursor.generation;
 a.api.setCrosshairSnap({mode:'ohlc'});await f.flush();assert.equal(a.api.crosshairSnapshot(894,446).index,2);assert.equal(b.timeCursor.requestedTime,bars[3].time);assert.equal(b.timeCursor.generation,generation);
 f.pointer(a);assert.equal(b.timeCursor.requestedTime,bars[2].time);
});
test('remote update never re-snaps or replaces a receiver local pointer, even with another mode',async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),g=new TimeCursorGroup({match:'exact'});t.after(()=>g.dispose());g.add(a);g.add(b);a.api.setCrosshairSnap({mode:'close'});b.api.setCrosshairSnap({mode:'ohlc'});await f.flush();f.pointer(b,195,96);const raw=b.model.crosshair,local=b.api.crosshairSnapshot(894,446);
 f.pointer(a,132,172);assert.equal(b.model.crosshair,raw);assert.deepEqual(b.api.crosshairSnapshot(894,446),local);assert.equal(b.timeCursor.requestedTime,bars[2].time);
});
test('keyboard exploration keeps exact selection and suppresses pointer snap/publication without queries',async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),g=new TimeCursorGroup({match:'exact'});t.after(()=>g.dispose());g.add(a);g.add(b);a.api.setCrosshairSnap({mode:'ohlc'});await f.flush();f.pointer(a,195,96);const raw=a.model.crosshair;a.api.dataAt=()=>assert.fail('Navigation is not a data read');const get=a.model.indicators.get;a.model.indicators.get=()=>assert.fail('Navigation must not calculate');
 try{a.setDataExploration(true);f.key(a,'Home');assert.equal(a.dataExploration.time,bars[0].time);assert.equal(b.timeCursor.kind,'keyboard');f.pointer(a,232,172);assert.equal(a.model.crosshair,raw);assert.equal(b.timeCursor.requestedTime,bars[0].time);a.canvas.dispatchEvent(new Event('pointerleave'));assert.equal(b.timeCursor.requestedTime,bars[0].time);f.key(a,'ArrowRight');assert.equal(b.timeCursor.requestedTime,bars[1].time);}finally{a.model.indicators.get=get;}
});
test('API hover invalidation reuses cached base and drawings and does not invalidate explorer selection',async t=>{
 const f=fixture(t),a=f.make();await f.flush();f.pointer(a,195,176);await f.flush();a.setDataExploration(true);const selected=a.dataExploration;a.api.setCrosshairSnap({mode:'close'});assert.deepEqual(a.dataExploration,selected);await f.flush();
 assert.equal(a.renderMetrics.baseRedrawn,false);assert.equal(a.renderMetrics.drawingsRedrawn,false);assert.equal(a.api.crosshairSnapshot(894,446).price,60);
});
test('shared-model sibling teardown cannot release latest pointer intent; owner teardown releases own only',async t=>{
 const f=fixture(t),a=f.make(),b=f.make({model:a.model});a.api.setCrosshairSnap({mode:'close'});b.api.setCrosshairSnap({mode:'ohlc'});await f.flush();f.pointer(a,195,176);f.pointer(b,195,96);a.destroy();assert.equal(b.api.crosshairSnapshot(894,446).field,'high');const model=b.model,layout=b.controller.layout();b.destroy();assert.deepEqual(model.crosshair,{x:195,y:96});assert.throws(()=>b.controller.layout(),/disposed/i);assert.equal(resolveCrosshairSnapshot(model,layout).mode,'free');
});
test('dirty source blocks stale time publication; next rendered pointer refreshes index and raw price',async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),g=new TimeCursorGroup({match:'exact'});t.after(()=>g.dispose());g.add(a);g.add(b);a.api.setCrosshairSnap({mode:'close'});await f.flush();f.pointer(a);const before=b.timeCursor.generation;a.model.store.update(2,{...bars[2],close:70});f.pointer(a);assert.equal(b.timeCursor.generation,before);await f.flush();assert.equal(a.api.crosshairSnapshot(894,446).price,70);f.pointer(a);assert.ok(b.timeCursor.generation>before);
});
