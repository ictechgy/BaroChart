import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,InteractionController,createLayout,buildScene,IndicatorEngine} from '../src/core/index.mjs';
function setup({log=false,irregular=false}={}) {
 const days=irregular?['2026-01-07','2026-01-08','2026-01-09','2026-01-12','2026-01-13','2026-01-14','2026-01-15','2026-01-16','2026-01-19','2026-01-20']:null;
 const s=new BarStore(Array.from({length:10},(_,i)=>({time:days?Date.parse(days[i]+'T09:00:00Z'):i*60000,open:10,high:100,low:10,close:100,volume:10})));
 const m=new ChartModel({store:s,visibleBars:10});m.addSeries({id:'price',type:'candles',panel:'price'});m.setPanel('price',{scale:log?'log':'linear',range:[1,1000],padding:0});
 const input=new InteractionController(m,()=>({width:1000,height:600}));return {s,m,input};
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
test('log-axis drawing body drag preserves screen shape and positive prices',()=>{
 const {s,m,input}=setup({log:true});const l=input.layout();m.drawings.add({type:'trendline',points:[{time:s.columns.time[2],price:10},{time:s.columns.time[7],price:100}]});m.drawings.selected=null;
 const before=m.drawings.items[0].points.map(p=>l.toScreen(p,'price'));const x=(before[0].x+before[1].x)/2,y=(before[0].y+before[1].y)/2;
 input.down(1,x,y);input.move(1,x,y+150);input.up(1);
 const after=m.drawings.items[0].points.map(p=>l.toScreen(p,'price'));
 console.log(JSON.stringify({case:'log-drag',points:m.drawings.items[0].points,after,expectedY:before.map(p=>p.y+150),drawingCommands:buildScene(m,1000,600).commands.filter(c=>c.color==='#f5b85a').length}));
 assert.ok(m.drawings.items[0].points.every(p=>p.price>0));for(let i=0;i<2;i++)near(after[i].y-before[i].y,150);
});
test('drawing body drag preserves shape across compressed weekend gap',()=>{
 const {s,m,input}=setup({irregular:true});const l=input.layout();m.drawings.add({type:'trendline',points:[{time:s.columns.time[1],price:100},{time:s.columns.time[3],price:300}]});m.drawings.selected=null;
 const before=m.drawings.items[0].points.map(p=>l.toScreen(p,'price')),x=(before[0].x+before[1].x)/2,y=(before[0].y+before[1].y)/2,dx=l.x(3)-l.x(2);
 input.down(1,x,y);input.move(1,x+dx,y);input.up(1);const after=m.drawings.items[0].points.map(p=>l.toScreen(p,'price'));
 console.log(JSON.stringify({case:'weekend-drag',requestedDx:dx,actualDx:after.map((p,i)=>p.x-before[i].x),times:m.drawings.items[0].points.map(p=>new Date(p.time).toISOString())}));
 for(let i=0;i<2;i++)near(after[i].x-before[i].x,dx);
});
test('hidden series is excluded from autoscale including logarithmic charts',()=>{
 const {s,m}=setup();m.setPanel('price',{range:undefined});const before=createLayout(m,1000,600).panels[0];m.addSeries({id:'hidden',type:'line',panel:'price',values:new Float64Array(s.length).fill(1e9),visible:false});const after=createLayout(m,1000,600).panels[0];
 console.log(JSON.stringify({case:'hidden-series',before:[before.min,before.max],after:[after.min,after.max]}));assert.equal(after.max,before.max);
});
test('single-bar drawing can retain a user-selected horizontal position',()=>{
 const s=new BarStore([{time:1000,open:10,high:12,low:9,close:11,volume:1}]),m=new ChartModel({store:s,visibleBars:10});m.addSeries({id:'p',type:'candles',panel:'price'});const i=new InteractionController(m,()=>({width:1000,height:600}));i.setTool('text');i.down(1,400,200);i.up(1);const screen=i.layout().toScreen(m.drawings.items[0].points[0],'price');console.log(JSON.stringify({case:'single-bar',anchor:m.drawings.items[0].points[0],screen,expectedX:400}));near(screen.x,400);
});
test('undo during a live drawing gesture leaves the next pointer move usable',()=>{
 const {m,input}=setup();input.setTool('rectangle');input.down(1,200,200);input.move(1,300,300);input.key('z',{ctrl:true});console.log(JSON.stringify({case:'undo-during-drag',drawings:m.drawings.items.length,gesture:input.gesture,pointers:input.pointers.size}));assert.doesNotThrow(()=>input.move(1,350,320));input.up(1);assert.equal(m.drawings.transaction,null);
});
test('delete during a live drawing gesture leaves the next pointer move usable',()=>{
 const {m,input}=setup();input.setTool('rectangle');input.down(1,200,200);input.move(1,300,300);input.key('Delete');console.log(JSON.stringify({case:'delete-during-drag',drawings:m.drawings.items.length,gesture:input.gesture,pointers:input.pointers.size}));assert.doesNotThrow(()=>input.move(1,350,320));input.up(1);assert.equal(m.drawings.transaction,null);
});
