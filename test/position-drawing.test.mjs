// Analytical raw-price/chart geometry contracts. No browser or native SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController,DrawingStore,drawingGeometry,drawingHitTest,buildScene} from '../src/core/index.mjs';
const T=1700000000000, W=894,H=446;
const rows=Array.from({length:20},(_,i)=>({time:T+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1}));
const points=(type='longposition',entry=50,stop=40,target=70)=>[{time:rows[4].time,price:entry},{time:rows[4].time,price:type==='longposition'?stop:target},{time:rows[4].time,price:type==='longposition'?target:stop},{time:rows[12].time,price:entry}];
function setup(t,{scale='linear',inverted=false,secondary=false}={}){
 const axis={range:scale==='log'?[1,100]:[0,100],padding:0,scale,inverted,...(scale==='percent'?{base:50}:{})};
 const model=new ChartModel({store:new BarStore(rows),visibleBars:20,panels:[{id:'price',...(secondary?{range:[0,1000],padding:0}:axis)}],axes:secondary?[{id:'B',panel:'price',side:'left',...axis}]:[]});
 model.addSeries({id:'p',type:'candles',panel:'price',...(secondary?{axisId:'B'}:{})});
 let notices=0;const controller=new InteractionController(model,()=>({width:W,height:H}),()=>notices++),api=new ChartAPI(model,{controller,invalidate:()=>notices++});
 t.after(()=>model.dispose());return {model,controller,api,binding:secondary?{axisId:'B',seriesId:'p'}:{},get notices(){return notices;}};
}
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<=1e-9,`${label}: ${a} != ${b}`);
for(const type of ['longposition','shortposition'])for(const scale of ['linear','log','percent'])for(const inverted of [false,true])for(const secondary of [false,true])test(`${type} ${scale} inverted=${inverted} secondary=${secondary}: raw metrics and analytical zones`,t=>{
 const f=setup(t,{scale,inverted,secondary}),id=f.api.addDrawing({type,points:points(type),...f.binding}),d=f.model.drawings.items[0],l=f.controller.layout(),g=drawingGeometry(d,l),p=l.axis('price',secondary?'B':null);
 const y=value=>{const u=scale==='log'?Math.log(value)/Math.log(100):value/100;return p.top+(inverted?u:1-u)*(p.bottom-p.top);};
 const x=index=>p.left+(index+.5)/20*(p.right-p.left),boxes=g.filter(c=>c.op==='box'),metric=f.api.positionMetrics(id);
 assert.deepEqual(metric,{direction:type==='longposition'?'long':'short',startTime:rows[4].time,endTime:rows[12].time,entry:50,stop:type==='longposition'?40:70,target:type==='longposition'?70:40,risk:type==='longposition'?10:20,reward:type==='longposition'?20:10,riskPercent:type==='longposition'?20:40,rewardPercent:type==='longposition'?40:20,ratio:type==='longposition'?2:.5});
 assert.equal(boxes.length,2);for(const [i,level]of [metric.stop,metric.target].entries()){close(boxes[i].x,x(4),'zone start');close(boxes[i].w,x(12)-x(4),'zone extent');close(boxes[i].y,Math.min(y(50),y(level)),'zone top');close(boxes[i].h,Math.abs(y(50)-y(level)),'zone height');}
 assert.match(g.find(c=>c.op==='text').text,/entry 50 · R\/R/);assert.match(g[boxes.length+2].text,/Stop/);assert.ok(g.some(c=>c.op==='text'&&c.text.includes('Target')));
 f.model.drawings.selected=null;assert.equal(drawingHitTest(f.model.drawings,l,x(8),(y(50)+y(metric.stop))/2)?.id,id,'shaded interior hit');
 f.model.drawings.selected=id;for(let i=0;i<4;i++){const q=l.toScreen(d.points[i],'price',d.axisId);assert.equal(drawingHitTest(f.model.drawings,l,q.x,q.y)?.handle,i,'stable semantic handle');}
});

test('stored Float64 narrow risk remains nonzero; no tick or decimal rounding',t=>{
 const f=setup(t),e=1+Number.EPSILON,id=f.api.addDrawing({type:'longposition',points:points('longposition',e,1,1+3*Number.EPSILON)}),m=f.api.positionMetrics(id);
 assert.equal(m.risk,Number.EPSILON);assert.equal(m.reward,2*Number.EPSILON);assert.equal(m.ratio,2);
 const labels=drawingGeometry(f.model.drawings.items[0],f.controller.layout()).filter(c=>c.op==='text').map(c=>c.text).join('\n');assert.match(labels,/2\.22045e-16/);assert.ok(labels.includes(String(e)),'round-trip level text');
 m.entry=999;assert.equal(f.api.positionMetrics(id).entry,e,'detached query');
});
for(const entry of [0,-50,Number.MIN_VALUE])test(`percent of absolute entry ${entry}: nullable finite result`,t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:points('longposition',entry,entry-10,entry+20)}),m=f.api.positionMetrics(id);
 assert.equal(m.ratio,2);assert.equal(m.riskPercent,entry===-50?20:null);assert.equal(m.rewardPercent,entry===-50?40:null);
});
const invalid={
 'zero risk':p=>p[1].price=50,'wrong stop':p=>p[1].price=60,'wrong target':p=>p[2].price=49,
 'zero extent':p=>p[3].time=p[0].time,'backwards extent':p=>p[3].time=p[0].time-1,
 'split start':p=>p[1].time++,'split entry':p=>p[3].price++,
 'overflow distance':p=>{p[0].price=p[3].price=1e308;p[1].price=-1e308;p[2].price=1.1e308;},
 'overflow ratio':p=>{p[0].price=p[3].price=0;p[1].price=-Number.MIN_VALUE;p[2].price=1;},
 'underflow ratio':p=>{p[0].price=p[3].price=0;p[1].price=-1e308;p[2].price=Number.MIN_VALUE;},
};
for(const [name,mutate]of Object.entries(invalid))test(`invalid ${name} rejects before state/history/gesture change`,t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:points()}),before=f.model.drawings.items,history=f.model.drawings.undoStack;
 f.controller.setTool('trendline');f.controller.down(1,300,200);const transaction=f.model.drawings.transaction,gesture=f.controller.gesture,p=points();mutate(p);
 assert.throws(()=>f.api.editDrawing(id,{points:p}),/Position/);assert.equal(f.model.drawings.transaction,transaction);assert.equal(f.controller.gesture,gesture);assert.equal(f.model.drawings.undoStack,history);f.controller.cancel();assert.equal(f.model.drawings.items[0],before[0]);
});

test('metrics query is read-only and does not query layout, bars, indicators or invalidate',t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:points()}),notices=f.notices;
 f.model.indicators.get=()=>{throw Error('unexpected indicator query');};f.model.store.at=()=>{throw Error('unexpected source query');};f.controller.layout=()=>{throw Error('unexpected layout query');};
 assert.equal(f.api.dispatch('positionMetrics',[id]).ratio,2);assert.equal(f.notices,notices);assert.throws(()=>f.api.dispatch('positionMetrics',[id,'extra']),/argument count/);assert.throws(()=>f.api.positionMetrics('missing'),/Position drawing required/);
 const other=f.api.addDrawing({type:'horizontal',points:[{time:T,price:1}]});assert.throws(()=>f.api.positionMetrics(other),/Position drawing required/);
});

test('unprojectable log levels hide the entire position and its selected handles/hits',t=>{
 const f=setup(t,{scale:'log'});f.api.addDrawing({type:'shortposition',points:points('shortposition',10,-10,20)});const l=f.controller.layout();assert.deepEqual(drawingGeometry(f.model.drawings.items[0],l),[]);
 assert.equal(drawingHitTest(f.model.drawings,l,l.x(4),l.axis('price').y(10)),null);const withDrawing=buildScene(f.model,W,H);f.model.drawings.items=[];assert.deepEqual(withDrawing.commands,buildScene(f.model,W,H).commands);
});

test('legacy versions remain minimal; position v3 roundtrips and downgrades reject atomically',()=>{
 const s=new DrawingStore();assert.equal(JSON.parse(s.save()).version,1);s.add({id:'old',type:'horizontal',points:[{time:T,price:1}],axisId:'B'});assert.equal(JSON.parse(s.save()).version,2);
 s.add({id:'position',type:'longposition',points:points(),axisId:'B',seriesId:'p'});const saved=s.save();assert.equal(JSON.parse(saved).version,3);const other=new DrawingStore();other.load(saved);assert.equal(other.save(),saved);
 for(const version of [1,2,5]){const doc=JSON.parse(saved);doc.version=version;const before=other.items,history=other.undoStack;assert.throws(()=>other.load(JSON.stringify(doc)),/version|document/i);assert.equal(other.items,before);assert.equal(other.undoStack,history);}
});

test('minimum positive subnormal risk is accepted without an arbitrary epsilon',t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:points('longposition',0,-Number.MIN_VALUE,Number.MIN_VALUE)}),m=f.api.positionMetrics(id);
 assert.equal(m.risk,Number.MIN_VALUE);assert.equal(m.reward,Number.MIN_VALUE);assert.equal(m.ratio,1);assert.equal(m.riskPercent,null);
});
test('four-anchor resource accounting and Date-boundary group overflow stay atomic',t=>{
 const limited=new DrawingStore({maxPoints:3});assert.throws(()=>limited.add({type:'longposition',points:points()}),/points/);assert.equal(limited.items.length,0);assert.equal(limited.transaction,null);assert.equal(limited.undoStack.length,0);
 const f=setup(t),p=points();for(let i=0;i<3;i++)p[i].time=8639999999999999;p[3].time=8640000000000000;const id=f.api.addDrawing({type:'longposition',points:p}),before=f.api.saveDrawings();assert.throws(()=>f.api.translateDrawings([id],{deltaTimeMs:1,deltaPrice:0}),/Date range/);assert.equal(f.api.saveDrawings(),before);
});
