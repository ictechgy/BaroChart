import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,buildScene,InteractionController,drawingHitTest} from '../src/core/index.mjs';
import {SceneCache} from '../src/core/frame-cache.mjs';
function fixture(width=402,height=734,font='12px monospace',three=false){
 const bars=Array.from({length:64},(_,i)=>({time:1700000000000+i*60000,open:100,high:120,low:90,close:110,volume:1}));
 const model=new ChartModel({store:new BarStore(bars),theme:{font},panels:[{id:'price',label:'Primary price / currencies',range:[80,120]},{id:'other',range:[0,100],axisSide:'left'},...(three?[{id:'momentum',range:[0,100]}]:[])],axes:[{id:'A',panel:'price',range:[1000,5000],label:'Independent price A'},{id:'B',panel:'price',range:[0,100],label:'Independent price B'}]});
 model.view={from:0,to:12};model.indicators.add('EMA(3)','ema',{period:3});model.addSeries({id:'ema',type:'line',panel:'price',indicator:'EMA(3)',label:'EMA(3)'});
 const input=new InteractionController(model,()=>({width,height})),api=new ChartAPI(model,{controller:input});return {model,input,api,width,height,bars};
}
test('Narrow plot reduces time labels, keeps complete metadata and visible ellipsis',()=>{
 const f=fixture(),scene=buildScene(f.model,f.width,f.height),labels=scene.commands.filter(c=>c.role==='time-tick');
 assert.equal(labels.length,1);assert.ok(labels[0].text.endsWith('…'));assert.match(labels[0].fullText,/\d\d-\d\d/);assert.ok(labels[0].labelBounds[0]>=scene.layout.panels[0].left);assert.ok(labels[0].labelBounds[0]+labels[0].labelBounds[2]<=scene.layout.panels[0].right);f.model.dispose();
});
test('Large-font small multipanel labels fit their clips and remain separated within each lane',()=>{
 for(const [width,height,font,three] of [[320,160,'36px monospace',true],[402,734,'24px monospace',false],[1200,700,'36px sans-serif',false]]){
  const f=fixture(width,height,font,three),scene=buildScene(f.model,width,height),labels=scene.commands.filter(c=>c.labelBounds);if(!three)assert.ok(labels.length);
  for(const c of labels){const [x,y,w,h]=c.labelBounds,clip=c.clip??[0,0,width,height];assert.ok(x>=clip[0]&&y>=clip[1]&&x+w<=clip[0]+clip[2]+1e-8&&y+h<=clip[1]+clip[3]+1e-8,JSON.stringify(c));}
  for(const p of scene.layout.panels)for(const a of p.axes){const lane=labels.filter(c=>c.panelId===p.id&&c.axisId===a.axisId&&['price-tick','axis-title'].includes(c.role)).sort((a,b)=>a.labelBounds[1]-b.labelBounds[1]);for(let i=1;i<lane.length;i++)assert.ok(lane[i].labelBounds[1]-(lane[i-1].labelBounds[1]+lane[i-1].labelBounds[3])>=4-1e-8);}
  const times=labels.filter(c=>c.role==='time-tick').sort((a,b)=>a.x-b.x);for(let i=1;i<times.length;i++)assert.ok(times[i].x-times[i-1].x-times[i-1].labelBounds[2]>=4-1e-8);f.model.dispose();
 }
});
test('Long numeric and indicator labels explicitly shorten while preserving full text and source values',()=>{
 const f=fixture();f.api.setPanel('price',{range:[123456789,123456790]});const before=f.model.store.at(0),scene=buildScene(f.model,f.width,f.height),prices=scene.commands.filter(c=>c.role==='price-tick'&&c.panelId==='price'&&c.axisId===null);
 assert.ok(prices.length);assert.ok(prices.every(c=>c.text.endsWith('…')&&c.fullText.includes('123456789')));const title=scene.commands.find(c=>c.role==='panel-title'&&c.panelId==='price');assert.ok(title.fullText.includes('EMA(3)'));assert.deepEqual(f.model.store.at(0),before);f.model.dispose();
});
test('Crosshair labels use opaque bounded masks without rebuilding cached base',()=>{
 const f=fixture(800,500,'24px monospace'),cache=new SceneCache(),first=cache.frame(f.model,800,500),p=first.scene.layout.panels[0];f.model.crosshair={x:(p.left+p.right)/2,y:p.top+1};const frame=cache.frame(f.model,800,500);
 assert.equal(frame.baseChanged,false);assert.equal(frame.drawingsChanged,false);const labels=frame.hover.commands.filter(c=>c.role==='crosshair-price');assert.ok(labels.length);for(const c of labels){const i=frame.hover.commands.indexOf(c),mask=frame.hover.commands[i-1];assert.equal(mask.op,'box');assert.equal(mask.fill.slice(-2),'ff');assert.ok(c.labelBounds[1]>=p.top);assert.ok(c.labelBounds[1]+c.labelBounds[3]<=p.bottom);}f.model.dispose();
});
test('Touch hit radius is opt-in and selected nearby handles choose the closest point',()=>{
 const f=fixture(800,500),l=f.input.layout(),p=l.panels[0],a={x:p.left+70,y:p.top+70},b={x:a.x+10,y:a.y},id=f.api.addDrawing({type:'trendline',panel:'price',points:[l.fromScreen(a.x,a.y,'price'),l.fromScreen(b.x,b.y,'price')]});f.api.selectDrawing(id);
 assert.equal(drawingHitTest(f.model.drawings,l,b.x,b.y,22).handle,1);f.input.down(1,a.x,a.y-20);assert.equal(f.input.gesture.kind,'pan');f.input.cancel();f.api.selectDrawing(id);f.input.down(1,a.x,a.y-20,22);assert.equal(f.input.gesture.kind,'edit');assert.equal(f.input.gesture.handle,0);f.input.cancel();f.model.dispose();
});
test('Invalid touch radius rejects before pointer ownership changes',()=>{const f=fixture(800,500);for(const radius of [0,33,NaN,Infinity,'22']){assert.throws(()=>f.input.down(1,200,200,radius),/radius|tolerance/i);assert.equal(f.input.pointers.size,0);assert.equal(f.input.gesture,null);}f.model.dispose();});
test('Large drawing text remains selectable across its font-sized glyph area',()=>{
 const f=fixture(800,500,'36px monospace'),l=f.input.layout(),p=l.panels[0],x=p.left+40,y=p.top+70,id=f.api.addDrawing({type:'text',panel:'price',text:'TEXT NOTE',points:[l.fromScreen(x,y,'price')]});f.api.selectDrawing(null);assert.equal(drawingHitTest(f.model.drawings,l,x+120,y-25,8)?.id,id);f.model.dispose();
});
test('Extreme font and unequal tiny panels preserve positive projection geometry',()=>{
 const f=fixture(100,80,'96px monospace');f.api.setPanel('price',{weight:1000});f.api.setPanel('other',{weight:.01});const scene=buildScene(f.model,100,80);assert.ok(scene.layout.panels.every(p=>p.bottom>p.top));assert.ok(scene.commands.every(c=>!c.coords||c.coords.every(Number.isFinite)));f.model.dispose();
});
