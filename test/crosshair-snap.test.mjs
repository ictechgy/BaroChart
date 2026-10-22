// Real core, literal 894x446 geometry: plot [12,812]x[12,412], x(i)=32+40*i,
// y(price)=412-4*price. These are not actual browser/native pointer tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController,createLayout} from '../src/core/index.mjs';
import {resolveCrosshairSnapshot} from '../src/core/crosshair-snap.mjs';
import {createCrosshairCommands,crosshairValuesAt} from '../src/core/scene-parts.mjs';
import {SceneCache} from '../src/core/frame-cache.mjs';
const T=1700000000000,x=i=>32+40*i,y=p=>412-4*p;
const row=(i,patch={})=>({time:T+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1,...patch});
function fixture(t,{bars=Array.from({length:20},(_,i)=>row(i)),panel={}}={}){
 const model=new ChartModel({store:new BarStore(bars),visibleBars:20,panels:[{id:'price',range:[0,100],padding:0,...panel}]});model.addSeries({id:'p',type:'candles',panel:'price'});
 const notifications=[],c=new InteractionController(model,()=>({width:894,height:446}),kind=>notifications.push(kind)),api=new ChartAPI(model,{controller:c,invalidate:kind=>notifications.push(kind)});t.after(()=>model.dispose());
 return {model,c,api,notifications,snapshot:()=>api.crosshairSnapshot(894,446)};
}
function noSnap(snapshot,mode,reason=mode==='free'?'free':'no-eligible'){
 assert.equal(snapshot.mode,mode);assert.equal(snapshot.snapped,false);assert.equal(snapshot.reason,reason);assert.deepEqual(snapshot.raw,snapshot.resolved);
 for(const key of ['index','time','field','price','axisId','seriesId','storeVersion'])assert.equal(snapshot[key],null,key);
}
function snapped(snapshot,index,field,price,axisId=null,seriesId='p'){
 assert.equal(snapshot.snapped,true);assert.equal(snapshot.reason,'snapped');assert.equal(snapshot.index,index);assert.equal(snapshot.time,row(index).time);assert.equal(snapshot.field,field);assert.ok(Object.is(snapshot.price,price),'exact raw price');assert.equal(snapshot.axisId,axisId);assert.equal(snapshot.seriesId,seriesId);
}

test('default free retains raw model cursor shape, commands and legacy readout keys',t=>{
 const {model,c,api,snapshot}=fixture(t);assert.deepEqual(c.crosshairSnap,{mode:'free',target:null});c.move(1,x(2)+3,y(60)+4);
 assert.deepEqual(model.crosshair,{x:x(2)+3,y:y(60)+4});noSnap(snapshot(),'free');const layout=c.layout(),commands=createCrosshairCommands(model,layout);
 assert.deepEqual(commands[0].coords,[115,12,115,412]);assert.deepEqual(commands[1].coords,[12,176,812,176]);
 const before=api.crosshairValues(894,446);assert.deepEqual(Object.keys(before),['index','time','primary','series','axes']);assert.ok(Math.abs(before.axes[0].value-59)<1e-12);
 c.setCrosshairSnap({mode:'close'});c.setCrosshairSnap({mode:'free'});assert.deepEqual(api.crosshairValues(894,446),before);assert.deepEqual(createCrosshairCommands(model,layout),commands);
});
for(const [mode,field,price]of [['close','close',60],['ohlc','open',40],['ohlc','high',80],['ohlc','low',10],['ohlc','close',60]])test(`${mode} stores exact ${field} metadata and aligns readout/label/display`,t=>{
 const {model,c,api,snapshot}=fixture(t);c.setCrosshairSnap({mode});c.move(1,x(4)+3,y(mode==='close'?10:price)+4);
 const s=snapshot();snapped(s,4,field,price);assert.deepEqual(s.resolved,{x:192,y:y(price)});assert.deepEqual(model.crosshair,s.raw);assert.equal(s.storeVersion,model.store.version);
 const read=api.crosshairValues(894,446);assert.equal(read.index,4);assert.equal(read.time,s.time);assert.equal(read.axes[0].value,price);
 const commands=createCrosshairCommands(model,c.layout());assert.deepEqual(commands[1].coords,[12,y(price),812,y(price)]);assert.equal(commands.find(q=>q.role==='crosshair-price').fullText,price.toFixed(2));
});
test('exact X midpoint chooses earlier bar and exact OHLC Y tie chooses open',t=>{
 const {c,snapshot}=fixture(t);c.setCrosshairSnap({mode:'ohlc'});c.move(1,132,y(50));snapped(snapshot(),2,'open',40);
});
for(const scale of ['linear','log','percent'])for(const inverted of [false,true])test(`${scale}/inverted=${inverted} uses screen distance but keeps raw price`,t=>{
 const bars=Array.from({length:20},(_,i)=>row(i,{open:10,high:100,low:1,close:90})),{c,api,snapshot}=fixture(t,{bars,panel:{scale,inverted,base:25,range:[1,100]}});c.setCrosshairSnap({mode:'ohlc'});
 const fraction=scale==='log'?Math.log(35)/Math.log(100):(35-1)/99;c.move(1,x(4)+2,12+400*(inverted?fraction:1-fraction));const field=scale==='log'?'close':'open',price=scale==='log'?90:10;
 snapped(snapshot(),4,field,price);assert.equal(api.crosshairValues(894,446).axes[0].value,price);
});
test('secondary axis exact raw price bypasses logarithmic inverse roundtrip for labels/readout',t=>{
 const raw=0.00000000012345678912345678,bars=Array.from({length:20},(_,i)=>row(i,{open:raw,high:raw*2,low:raw/2,close:raw*1.5}));
 const {model,c,api,snapshot}=fixture(t,{bars});model.addAxis({id:'B',panel:'price',side:'left',scale:'log',inverted:true,range:[raw/4,raw*4],precision:18});model.addSeries({id:'b',type:'ohlc',panel:'price',axisId:'B'});c.setCrosshairSnap({mode:'ohlc',target:{panel:'price',seriesId:'b'}});
 c.move(1,94+4.5/20*718,212);const s=snapshot();snapped(s,4,'open',raw,'B','b');const read=api.crosshairValues(894,446);
 assert.ok(Object.is(read.axes.find(a=>a.id==='B').value,raw));assert.equal(read.axes.find(a=>a.id==='B').formatted,raw.toFixed(18));assert.notEqual(read.axes[0].value,raw);
 assert.equal(createCrosshairCommands(model,c.layout()).find(q=>q.role==='crosshair-price'&&q.axisId==='B').fullText,raw.toFixed(18));
});
test('signed-zero raw OHLC survives snapshot and legacy matching-axis value',t=>{
 const {c,api,snapshot}=fixture(t,{bars:Array.from({length:20},(_,i)=>row(i,{low:-0})),panel:{range:[-10,100]}});c.setCrosshairSnap({mode:'ohlc'});c.move(1,x(4),12+100/110*400);
 snapped(snapshot(),4,'low',-0);assert.ok(Object.is(api.crosshairValues(894,446).axes[0].value,-0));
});
for(const kind of ['external','indicator','volume','offset','hidden','removed','rebound'])test(`target ${kind} cannot silently borrow another series OHLC`,t=>{
 const {model,c,api,snapshot}=fixture(t);let id='other';if(kind==='indicator')model.indicators.add('e','ema',{period:2});
 if(['hidden','removed','rebound'].includes(kind)){id='p';}else model.addSeries({id,panel:'price',type:'line',...(kind==='external'?{values:new Float64Array(20).fill(50),symbolId:'B'}:kind==='indicator'?{indicator:'e'}:kind==='volume'?{source:'volume'}:{source:'close',offset:1})});
 c.setCrosshairSnap({mode:'ohlc',target:{panel:'price',seriesId:id}});c.move(1,x(4)+3,y(60)+4);
 if(kind==='hidden')api.setSeries('p',{visible:false});if(kind==='removed')model.removeSeries('p');if(kind==='rebound'){model.addAxis({id:'B',panel:'price',range:[0,100]});api.setSeries('p',{axisId:'B'});}
 noSnap(snapshot(),'ohlc');
});
test('default target follows active panel, while explicit target never leaks into another panel',t=>{
 const {model,c,snapshot}=fixture(t);model.addPanel({id:'osc',range:[0,100],padding:0});model.addSeries({id:'v',panel:'osc',type:'histogram',source:'volume'});c.setCrosshairSnap({mode:'close'});let l=c.layout();c.move(1,l.x(4)+3,l.axis('osc').y(55));noSnap(snapshot(),'close');
 model.addSeries({id:'q',panel:'osc',type:'ohlc'});snapped(snapshot(),4,'close',60,null,'q');c.setCrosshairSnap({mode:'close',target:{panel:'price'}});noSnap(snapshot(),'close');
});
test('no cursor/outside plot is null; empty/no-visible-center/clipped source is explicit no-eligible',t=>{
 for(const scenario of ['none','outside','empty','time','price']){const {model,c,snapshot}=fixture(t);c.setCrosshairSnap({mode:'close'});
 if(scenario==='empty')model.store.setData([]);if(scenario==='time')model.view={from:30,to:50};if(scenario==='price')model.setPanel('price',{range:[41,59]});if(scenario!=='none')c.move(1,scenario==='outside'?900:192,212);
 if(['none','outside'].includes(scenario))assert.equal(snapshot(),null);else noSnap(snapshot(),'close');}
});
test('visible centers and future whitespace select a real stored endpoint, never synthetic time',t=>{
 const {model,c,snapshot}=fixture(t);model.setVisibleRange(3.2,13.2);c.setCrosshairSnap({mode:'close'});c.move(1,12,212);snapped(snapshot(),4,'close',60);c.move(1,812,212);snapped(snapshot(),13,'close',60);
 const f=fixture(t,{bars:[row(0)]});f.c.setCrosshairSnap({mode:'close'});f.c.move(1,x(15),212);snapped(f.snapshot(),0,'close',60);
});
test('correction/reset/prepend refresh source identity without a new pointer event',t=>{
 const {model,c,snapshot}=fixture(t);c.setCrosshairSnap({mode:'close'});c.move(1,x(4)+3,212);const old=snapshot();model.store.update(4,row(4,{close:70}));snapped(snapshot(),4,'close',70);assert.equal(old.price,60);assert.notEqual(snapshot().storeVersion,old.storeVersion);
 model.store.setData(Array.from({length:20},(_,i)=>({...row(i),time:row(i).time+1000000000,close:65})));assert.equal(snapshot().time,row(4).time+1000000000);assert.equal(snapshot().price,65);
 const before=snapshot();model.store.prepend([{...row(0),time:T-1000}]);const after=snapshot();assert.equal(after.index,before.index+1);assert.equal(after.time,before.time);assert.equal(after.price,before.price);
});
test('direct cursor assignment or mutation does not inherit the last pointer snap intent',t=>{
 const {model,c,snapshot}=fixture(t);c.setCrosshairSnap({mode:'close'});c.move(1,195,176);snapped(snapshot(),4,'close',60);model.crosshair={x:195,y:176};noSnap(snapshot(),'free');
 c.move(1,195,176);model.crosshair.x=196;noSnap(snapshot(),'free');c.setCrosshairSnap({mode:'ohlc'});noSnap(snapshot(),'free');
});
test('snapshot copies and config copies cannot mutate active cursor or target',t=>{
 const {model,c,snapshot}=fixture(t),options={mode:'close',target:{panel:'price',seriesId:'p'}};c.setCrosshairSnap(options);options.mode='free';options.target.panel='bad';assert.ok(Object.isFrozen(c.crosshairSnap)&&Object.isFrozen(c.crosshairSnap.target));c.move(1,195,176);
 const s=snapshot();s.raw.x=900;s.resolved.y=0;s.price=-1;snapped(snapshot(),4,'close',60);assert.deepEqual(model.crosshair,{x:195,y:176});
});
test('invalid config is atomic during drawing and does not change cursor/gesture/notifications',t=>{
 const {model,c,api,snapshot,notifications}=fixture(t);c.setCrosshairSnap({mode:'close'});c.move(7,195,176);c.setTool('trendline');c.down(1,195,176);
 const cursor=model.crosshair,gesture=c.gesture,transaction=model.drawings.transaction,prior=snapshot(),count=notifications.length;
 for(const options of [null,[],{},'close',{mode:'magnet'},{mode:'close',extra:1},{mode:'close',target:{}},{mode:'close',target:{panel:'missing'}},{mode:'close',target:{panel:'price',axisId:'missing'}},{mode:'close',target:{panel:'price',seriesId:'missing'}},{mode:'free',target:{panel:'price',extra:1}}]){assert.throws(()=>api.setCrosshairSnap(options));assert.equal(model.crosshair,cursor);assert.equal(c.gesture,gesture);assert.equal(model.drawings.transaction,transaction);assert.deepEqual(snapshot(),prior);assert.equal(notifications.length,count);}
 assert.throws(()=>api.dispatch('setCrosshairSnap',[{mode:'free'},{}]),/argument count/);assert.throws(()=>new ChartAPI(model).setCrosshairSnap({mode:'free'}),/controller required/);c.cancel();
});
test('crosshair setting never cancels drafts or couples to drawing magnet',t=>{
 const {model,c,snapshot}=fixture(t);c.setDrawingMagnet({mode:'strong'});c.move(1,195,176);noSnap(snapshot(),'free');c.setDrawingMagnet({mode:'off'});c.setCrosshairSnap({mode:'close'});c.setTool('trendline');c.down(1,195,176);const transaction=model.drawings.transaction;
 c.setCrosshairSnap({mode:'ohlc'});assert.equal(model.drawings.transaction,transaction);c.move(1,235,96);c.up(1);assert.deepEqual(model.drawings.items[0].points,[c.layout().fromScreen(195,176,'price'),c.layout().fromScreen(235,96,'price')]);assert.equal(c.drawingMagnet.mode,'off');
});
test('shared-model latest pointer owns intent; foreign toggle and release cannot replace it',t=>{
 const {model,c:a,snapshot}=fixture(t),b=new InteractionController(model,()=>({width:894,height:446}));a.setCrosshairSnap({mode:'close'});a.move(1,195,96);b.setCrosshairSnap({mode:'ohlc'});snapped(snapshot(),4,'close',60);
 b.move(2,195,96);snapped(snapshot(),4,'high',80);a.setCrosshairSnap({mode:'free'});a.releaseCrosshair();snapped(snapshot(),4,'high',80);b.setCrosshairSnap({mode:'close'});snapped(snapshot(),4,'close',60);b.releaseCrosshair();noSnap(snapshot(),'free');assert.deepEqual(model.crosshair,{x:195,y:96});
});
test('prepared-layout resolution/hover and pointer setting perform zero indicator work',t=>{
 const {model,c,api}=fixture(t);model.indicators.add('e','ema',{period:2});model.addSeries({id:'e',panel:'price',type:'line',indicator:'e'});const layout=c.layout(),get=model.indicators.get;let calls=0;model.indicators.get=()=>{calls++;throw Error('unexpected compute');};
 try{api.setCrosshairSnap({mode:'ohlc'});c.move(1,195,96);snapped(resolveCrosshairSnapshot(model,layout),4,'high',80);assert.ok(createCrosshairCommands(model,layout).length);assert.equal(calls,0);}finally{model.indicators.get=get;}
});
test('explicit fresh-layout snapshot retains documented dirty-indicator calculation lifecycle',t=>{
 const {model,c,snapshot}=fixture(t);model.indicators.add('e','ema',{period:2});model.addSeries({id:'e',panel:'price',type:'line',indicator:'e'});c.setCrosshairSnap({mode:'close'});c.move(1,195,96);const original=model.indicators.get;let calls=0;model.indicators.get=function(...args){calls++;return original.apply(this,args);};
 snapped(snapshot(),4,'close',60);assert.ok(calls>0);
});
test('warm scene cache changes hover only; data correction rebuilds and refreshes exact metadata',t=>{
 const {model,c,api}=fixture(t),cache=new SceneCache();c.move(1,195,176);cache.frame(model,894,446);api.setCrosshairSnap({mode:'close'});let frame=cache.frame(model,894,446);
 assert.equal(frame.baseChanged,false);assert.equal(frame.drawingsChanged,false);assert.deepEqual(frame.hover.commands[1].coords,[12,172,812,172]);
 model.store.update(4,row(4,{close:70}));frame=cache.frame(model,894,446);assert.equal(frame.baseChanged,true);assert.deepEqual(frame.hover.commands[1].coords,[12,132,812,132]);snapped(resolveCrosshairSnapshot(model,frame.scene.layout),4,'close',70);
});
test('log invalid visible data still explicitly rejects rather than inventing a snapped price',t=>{
 const {c,snapshot}=fixture(t,{bars:Array.from({length:20},(_,i)=>row(i,{low:0})),panel:{scale:'log',range:[1,100]}});c.setCrosshairSnap({mode:'close'});c.move(1,195,176);assert.throws(snapshot,/Log scale requires strictly positive visible data/);
});
