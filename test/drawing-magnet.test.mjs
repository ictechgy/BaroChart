// Real DOM-free controller tests. Literal fixture geometry: plot [12,812] x
// [12,412], 20 bars, x(i)=32+40*i, linear y(p)=412-4*p. No browser input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController} from '../src/core/index.mjs';

const T=1700000000000, x=i=>32+40*i, y=p=>412-4*p;
const row=(i,patch={})=>({time:T+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1,...patch});
function fixture(t,{bars=Array.from({length:20},(_,i)=>row(i)),panel={},series=true}={}){
 const model=new ChartModel({store:new BarStore(bars),visibleBars:20,panels:[{id:'price',range:[0,100],padding:0,...panel}]});
 if(series)model.addSeries({id:'p',type:'candles',panel:'price'});
 let notices=0;const controller=new InteractionController(model,()=>({width:894,height:446}),()=>notices++),api=new ChartAPI(model,{controller,invalidate:()=>notices++});
 t.after(()=>model.dispose());return {model,controller,api,get notices(){return notices;}};
}
function place(c,sx,sy,tool='horizontal'){c.setTool(tool);c.down(1,sx,sy);c.up(1);return c.model.drawings.items.at(-1);}
function expected(i,price){return {time:row(i).time,price};}

test('magnet is off by default and preserves unsnapped interpolation exactly',t=>{
 const {controller:c}=fixture(t);assert.deepEqual(c.drawingMagnet,{mode:'off',radiusPx:8});
 assert.deepEqual(place(c,x(4)+3,y(60)+4).points[0],c.layout().fromScreen(x(4)+3,y(60)+4,'price'));
});
for(const mode of ['weak','strong'])test(`${mode} stores exact irregular source time and OHLC on down and move`,t=>{
 const {model,controller:c}=fixture(t);c.setDrawingMagnet({mode});c.setTool('trendline');c.down(1,x(4)+3,y(60)+4);c.move(1,x(8)+2,y(80)+3);c.up(1);
 assert.deepEqual(model.drawings.items[0].points,[expected(4,60),expected(8,80)]);
 assert.equal(model.drawings.undoStack.length,1);assert.equal(model.drawings.undo(),true);assert.equal(model.drawings.items.length,0);assert.equal(model.drawings.redo(),true);
 assert.deepEqual(model.drawings.items[0].points,[expected(4,60),expected(8,80)]);
});
for(const [radius,snaps]of [[5,true],[4.999,false],[1,false],[32,true]])test(`weak Euclidean radius ${radius} inclusive threshold`,t=>{
 const {controller:c}=fixture(t);c.setDrawingMagnet({mode:'weak',radiusPx:radius});const point=place(c,x(4)+3,y(60)+4).points[0];
 assert.deepEqual(point,snaps?expected(4,60):c.layout().fromScreen(x(4)+3,y(60)+4,'price'));
});
test('strong ignores radius and prioritizes nearest X bar over globally nearest 2D point',t=>{
 const bars=Array.from({length:20},(_,i)=>row(i,i===4?{open:20,high:30,low:10,close:25}:{open:60,high:70,low:50,close:65}));
 const {controller:c}=fixture(t,{bars});c.setDrawingMagnet({mode:'strong',radiusPx:1});
 assert.deepEqual(place(c,x(4)+19,y(70)).points[0],expected(4,30));
 assert.deepEqual(place(c,x(4)+21,y(70)).points[0],expected(5,70));
});
test('exact X midpoint chooses earlier bar; exact OHLC Y tie chooses open before close',t=>{
 const {controller:c}=fixture(t);c.setDrawingMagnet({mode:'strong'});
 assert.deepEqual(place(c,(x(2)+x(3))/2,y(50)).points[0],expected(2,40));
});
for(const scale of ['linear','log','percent'])for(const inverted of [false,true])test(`${scale}, inverted=${inverted}, selects in screen space and saves raw price`,t=>{
 const bars=Array.from({length:20},(_,i)=>row(i,{open:10,high:100,low:1,close:90}));
 const {controller:c}=fixture(t,{bars,panel:{scale,inverted,base:25,range:[1,100]}});c.setDrawingMagnet({mode:'strong'});
 const fraction=scale==='log'?Math.log(35)/Math.log(100):(35-1)/99,sy=12+400*(inverted?fraction:1-fraction);
 assert.deepEqual(place(c,x(4)+2,sy).points[0],expected(4,scale==='log'?90:10));
});
test('independent log/inverted axis requires its own OHLC binding and uses its own projection',t=>{
 const {model,controller:c}=fixture(t);model.addAxis({id:'B',panel:'price',side:'left',range:[1,100],scale:'log',inverted:true,padding:0});
 model.addSeries({id:'b',type:'ohlc',panel:'price',axisId:'B'});c.setDrawingTarget({panel:'price',seriesId:'b'});c.setDrawingMagnet({mode:'strong'});
 const sx=94+4.5/20*718,sy=12+Math.log(55)/Math.log(100)*400;
 const d=place(c,sx+2,sy);assert.equal(d.axisId,'B');assert.equal(d.seriesId,'b');assert.deepEqual(d.points[0],expected(4,60));
});
for(const kind of ['external','indicator','volume','offset'])test(`explicit ${kind} series target never borrows same-axis candle prices`,t=>{
 const {model,controller:c}=fixture(t);if(kind==='indicator')model.indicators.add('e','ema',{period:2});
 model.addSeries({id:'other',panel:'price',type:'line',...(kind==='external'?{values:new Float64Array(20).fill(50),symbolId:'FOREIGN'}:kind==='indicator'?{indicator:'e'}:kind==='volume'?{source:'volume'}:{source:'close',offset:1})});
 c.setDrawingTarget({panel:'price',seriesId:'other'});c.setDrawingMagnet({mode:'strong'});const l=c.layout();
 assert.deepEqual(place(c,x(4)+3,y(60)+4).points[0],l.fromScreen(x(4)+3,y(60)+4,'price'));
});
for(const state of ['absent','hidden','removed','wrong-axis','wrong-panel'])test(`no snapping with ${state} OHLC binding`,t=>{
 const {model,controller:c}=fixture(t,{series:state!=='absent'});
 if(state==='hidden')model.series[0].visible=false;if(state==='removed')model.removeSeries('p');
 if(state==='wrong-axis'){model.addAxis({id:'B',panel:'price',range:[0,100]});c.setDrawingTarget({panel:'price',axisId:'B'});}
 if(state==='wrong-panel'){model.addPanel({id:'osc',range:[0,100]});c.setDrawingTarget({panel:'osc'});}
 c.setDrawingMagnet({mode:'strong'});const l=c.layout(),target=c.drawingTarget??{panel:'price'},axis=l.axis(target.panel,target.axisId),sx=l.x(4)+3,sy=axis.y(60)+4;
 assert.deepEqual(place(c,sx,sy).points[0],l.fromScreen(sx,sy,target.panel,target.axisId));
});
test('empty store and single bar preserve safe fallback or exact data-edge snap',t=>{
 for(const bars of [[],[row(0)]]){const {controller:c}=fixture(t,{bars});c.setDrawingMagnet({mode:'strong'});const l=c.layout(),sx=l.x(0)+3,sy=y(60)+4;
 assert.deepEqual(place(c,sx,sy).points[0],bars.length?expected(0,60):l.fromScreen(sx,sy,'price'));}
});
test('visible first/last centers bound candidates; future whitespace clamps to last visible bar',t=>{
 const {model,controller:c}=fixture(t);model.setVisibleRange(3.2,13.2);c.setDrawingMagnet({mode:'strong'});let l=c.layout();
 assert.deepEqual(place(c,l.axis('price').left,y(60)).points[0],expected(4,60));
 assert.deepEqual(place(c,l.axis('price').right,y(60)).points[0],expected(13,60));
 const {controller:d}=fixture(t,{bars:[row(0)]});d.setDrawingMagnet({mode:'strong'});l=d.layout();
 assert.deepEqual(place(d,l.x(15),y(60)).points[0],expected(0,60));
});
test('all candles outside viewport, all OHLC offscreen, or pointer outside plot keeps free point',t=>{
 for(const scenario of ['time','price','pointer']){const {model,controller:c}=fixture(t);if(scenario==='time')model.view={from:30,to:50};if(scenario==='price')model.setPanel('price',{range:[41,59]});c.setDrawingMagnet({mode:'strong'});c.setTool('horizontal');let l=c.layout();c.down(1,l.x(scenario==='time'?34:4),l.axis('price').y(scenario==='price'?50:60));
 const sx=scenario==='pointer'?l.axis('price').right+1:l.x(scenario==='time'?34:4)+3,sy=scenario==='price'?l.axis('price').y(50):y(60)+4;c.move(1,sx,sy);c.up(1);
 assert.deepEqual(model.drawings.items[0].points[0],l.fromScreen(sx,sy,'price'));}
});
test('nonpositive visible OHLC retains the existing explicit log-domain rejection',t=>{
 const {model,controller:c}=fixture(t,{bars:Array.from({length:20},(_,i)=>row(i,{low:0})),panel:{scale:'log',range:[1,100]}});c.setDrawingMagnet({mode:'strong'});c.setTool('horizontal');
 assert.throws(()=>c.down(1,x(4),y(60)),/Log scale requires strictly positive visible data/);assert.equal(model.drawings.items.length,0);assert.equal(model.drawings.transaction,null);c.cancel();
});
test('handle edits snap and undo/redo retain exact anchors',t=>{
 const {model,controller:c}=fixture(t);const id=model.drawings.add({type:'trendline',points:[expected(3,35),expected(9,65)]});c.setDrawingMagnet({mode:'strong'});
 c.down(1,x(3),y(35));assert.equal(c.gesture.handle,0);c.move(1,x(4)+3,y(60)+4);c.up(1);assert.deepEqual(model.drawings.items[0].points,[expected(4,60),expected(9,65)]);
 model.drawings.undo();assert.deepEqual(model.drawings.items[0].points,[expected(3,35),expected(9,65)]);model.drawings.redo();assert.deepEqual(model.drawings.items[0].points[0],expected(4,60));assert.equal(model.drawings.items[0].id,id);
});
test('body translation and keyboard nudges remain unsnapped pixel translations',t=>{
 const {model,controller:c}=fixture(t);model.drawings.add({type:'trendline',points:[expected(3,35),expected(9,65)]});c.setDrawingMagnet({mode:'strong'});const l=c.layout();
 c.down(1,x(6),y(50));assert.equal(c.gesture.handle,-1);c.move(1,x(6)+3,y(50)+4);c.up(1);
 assert.deepEqual(model.drawings.items[0].points,[l.fromScreen(x(3)+3,y(35)+4,'price'),l.fromScreen(x(9)+3,y(65)+4,'price')]);
 const before=model.drawings.items[0].points.map(p=>l.toScreen(p,'price'));c.key('ArrowRight');assert.deepEqual(model.drawings.items[0].points,before.map(p=>l.fromScreen(p.x+1,p.y,'price')));
});
test('freehand creation and handle editing remain identical with magnet on and off',t=>{
 const results=[];for(const mode of ['off','strong']){const {model,controller:c}=fixture(t);c.setDrawingMagnet({mode});c.setTool('freehand');c.down(1,x(4)+3,y(60)+4);c.move(1,x(5)+2,y(80)+3);c.up(1);c.setTool('select');const p=c.layout().toScreen(model.drawings.items[0].points[0],'price');c.down(1,p.x,p.y);assert.equal(c.gesture.handle,0);c.move(1,x(7)+3,y(60)+4);c.up(1);results.push(model.drawings.items[0].points);}
 assert.deepEqual(results[0],results[1]);
});
for(const type of ['channel','fibextension'])test(`${type} generated third point is free; explicit third-handle edit snaps`,t=>{
 const {model,controller:c}=fixture(t);c.setDrawingMagnet({mode:'strong'});c.setTool(type);c.down(1,x(3)+3,y(40)+4);c.move(1,x(8)+3,y(60)+4);c.up(1);
 const l=c.layout(),d=model.drawings.items[0];assert.deepEqual(d.points,[expected(3,40),expected(8,60),l.fromScreen(x(8),y(60)+40,'price')]);
 c.setTool('select');const p=l.toScreen(d.points[2],'price');c.down(1,p.x,p.y);assert.equal(c.gesture.handle,2);c.move(1,x(9)+3,y(80)+4);c.up(1);assert.deepEqual(model.drawings.items[0].points[2],expected(9,80));
});
test('cancel rolls back snapped draft and configuration changes cancel only the local owner',t=>{
 const {model,controller:a}=fixture(t),b=new InteractionController(model,()=>({width:894,height:446}));a.setTool('trendline');a.down(1,x(3),y(40));const transaction=model.drawings.transaction;
 b.setDrawingMagnet({mode:'strong'});assert.equal(model.drawings.transaction,transaction);assert.equal(a.gesture.transaction,transaction);
 a.setDrawingMagnet({mode:'weak'});assert.equal(model.drawings.items.length,0);assert.equal(model.drawings.transaction,null);assert.equal(a.pointers.size,0);assert.equal(b.drawingMagnet.mode,'strong');
 a.down(1,x(4)+3,y(60)+4);a.cancel();assert.equal(model.drawings.items.length,0);assert.equal(model.drawings.undoStack.length,0);
});
test('same configuration preserves active draft; stale controller cannot cancel replacement owner',t=>{
 const {model,controller:a}=fixture(t),b=new InteractionController(model,()=>({width:894,height:446}));a.setTool('trendline');a.setDrawingMagnet({mode:'weak'});a.down(1,x(4),y(60));const original=model.drawings.transaction;
 a.setDrawingMagnet({mode:'weak',radiusPx:8});assert.equal(model.drawings.transaction,original);assert.equal(a.pointers.size,1);
 model.drawings.cancel();b.setTool('horizontal');b.down(2,x(7),y(40));const replacement=model.drawings.transaction;a.setDrawingMagnet({mode:'strong'});assert.equal(model.drawings.transaction,replacement);b.up(2);assert.deepEqual(model.drawings.items[0].points[0],expected(7,40));
});
test('configuration copies/freezes values, validates atomically, and requires controller in API',t=>{
 const f=fixture(t),{model,controller:c,api}=f,options={mode:'weak',radiusPx:12};api.dispatch('setDrawingMagnet',[options]);options.mode='off';assert.deepEqual(c.drawingMagnet,{mode:'weak',radiusPx:12});assert.ok(Object.isFrozen(c.drawingMagnet));
 c.setTool('trendline');c.down(1,x(4),y(60));const transaction=model.drawings.transaction,notices=f.notices;
 for(const bad of [null,[],{},'strong',{mode:'bad'},{mode:'weak',radiusPx:0},{mode:'weak',radiusPx:33},{mode:'weak',radiusPx:Infinity},{mode:'weak',radiusPx:NaN},{mode:'weak',radiusPx:'8'},{mode:'weak',radiusPx:null},{mode:'off',extra:1}]){assert.throws(()=>api.setDrawingMagnet(bad));assert.equal(model.drawings.transaction,transaction);assert.equal(f.notices,notices);assert.deepEqual(c.drawingMagnet,{mode:'weak',radiusPx:12});}
 assert.throws(()=>api.dispatch('setDrawingMagnet',[{mode:'off'},{}]),/argument count/);assert.throws(()=>new ChartAPI(model).setDrawingMagnet({mode:'off'}),/controller required/);c.cancel();
});
test('magnet selection reads only the selected bar OHLC, independent of history length',t=>{
 const {model,controller:c}=fixture(t,{bars:Array.from({length:100000},(_,i)=>row(i))});c.setDrawingMagnet({mode:'strong'});const l=c.layout();c.layout=()=>l;
 const columns=model.store.columns,reads=[];model.store.columns=new Proxy(columns,{get(target,key){if(['open','high','low','close','time'].includes(key))return new Proxy(target[key],{get(column,index){if(/^\d+$/.test(String(index)))reads.push([key,Number(index)]);return Reflect.get(column,index,column);}});return target[key];}});
 try{const sx=l.x(99995)+2,sy=y(60)+3;assert.deepEqual(place(c,sx,sy).points[0],expected(99995,60));assert.ok(reads.length<20);assert.deepEqual(reads.filter(([key])=>key!=='time'),['open','high','low','close'].map(key=>[key,99995]));}finally{model.store.columns=columns;}
});
