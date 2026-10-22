// Direct controller/worker-state composition only; no real UI or platform runtime.
import test from 'node:test';import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController,saveWorkspace} from '../src/core/index.mjs';
import {readWorkspaceDocument} from '../src/core/workspace.mjs';
import {AsyncCapture,AsyncPrepared} from '../src/core/async-state.mjs';
import {AsyncUICapture,AsyncUIImport} from '../src/core/async-ui.mjs';
import {NativeWorkspacePrepared} from '../src/core/native-workspace-target.mjs';
const T=1700000000000,size={width:894,height:446},x=i=>32+40*i,y=p=>412-4*p;
const rows=Array.from({length:20},(_,i)=>({time:T+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1}));
const anchors=()=>[{time:rows[4].time,price:50},{time:rows[4].time,price:40},{time:rows[4].time,price:70},{time:rows[12].time,price:50}];
const BINDING={key:'position-tests',revision:'1',adjustmentVersion:'raw',priceUnit:'USD',adjustment:'raw'};
function setup(t,panel={}){const model=new ChartModel({store:new BarStore(rows),visibleBars:20,panels:[{id:'price',range:[0,100],padding:0,...panel}]});model.addSeries({id:'p',type:'candles',panel:'price'});const notices=[],c=new InteractionController(model,()=>size,kind=>notices.push(kind)),api=new ChartAPI(model,{controller:c,invalidate:()=>notices.push('api')});t.after(()=>model.dispose());return{model,c,api,notices};}
function edit(f,handle,sx,sy){const d=f.model.drawings.items[0],q=f.c.layout().toScreen(d.points[handle],'price');f.c.setTool('select');f.c.down(1,q.x,q.y);assert.equal(f.c.gesture.handle,handle);f.c.move(1,sx,sy);f.c.up(1);}
for(const type of ['longposition','shortposition'])for(const inverted of [false,true])test(`${type} creation is valid before movement on inverted=${inverted}`,t=>{
 const f=setup(t,{inverted}),py=p=>inverted?12+4*p:y(p);f.c.setTool(type);f.c.down(1,x(4),py(50));const draft=f.model.drawings.items[0],m=f.api.positionMetrics(draft.id);
 assert.equal(m.entry,50);assert.equal(m.stop,type==='longposition'?40:60);assert.equal(m.target,type==='longposition'?60:40);assert.equal(m.endTime,rows[6].time);assert.equal(f.model.drawings.undoStack.length,0);
 f.c.move(1,x(12),py(type==='longposition'?70:30));f.c.up(1);const done=f.api.positionMetrics(draft.id);assert.ok(Math.abs(done.target-(type==='longposition'?70:30))<1e-12,'free inverse-projection target');assert.equal(done.endTime,rows[12].time);assert.equal(done.stop,m.stop);assert.equal(f.model.drawings.undoStack.length,1);f.api.undo();assert.equal(f.model.drawings.items.length,0);f.api.redo();assert.deepEqual(f.api.positionMetrics(draft.id),done);
});
test('unrepresentable initial offsets no-op without transaction or history',t=>{const f=setup(t,{range:[1e16,1e16+2]});f.c.setTool('longposition');f.c.down(1,x(4),212);assert.equal(f.model.drawings.items.length,0);assert.equal(f.model.drawings.transaction,null);f.c.up(1);assert.equal(f.c.pointers.size,0);assert.equal(f.model.drawings.undoStack.length,0);});
for(const kind of ['create','edit'])test(`invalid ${kind} move keeps last valid geometry but repaints the pointer`,t=>{
 const f=setup(t);if(kind==='create'){f.c.setTool('longposition');f.c.down(1,x(4),y(50));}else{f.api.addDrawing({type:'longposition',points:anchors()});f.c.down(1,x(4),y(40));}
 const before=f.model.drawings.items[0],count=f.notices.length;f.c.move(1,x(12),y(kind==='create'?30:80));assert.equal(f.model.drawings.items[0],before);assert.equal(f.notices.length,count+1);assert.equal(f.notices.at(-1),'hover');assert.deepEqual(f.model.crosshair,{x:x(12),y:y(kind==='create'?30:80)});f.c.cancel();assert.equal(f.model.drawings.transaction,null);
});
for(const handle of [0,1,2,3])test(`handle ${handle} magnet updates only its semantic coordinates, with exact undo`,t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:anchors()}),before=f.api.saveDrawings();f.c.setDrawingMagnet({mode:'strong'});
 const index=handle===0?8:16,price=[60,10,80,80][handle];edit(f,handle,x(index)+2,y(price)+1);const p=f.model.drawings.items[0].points,want=anchors();
 if(handle===0){want[0]={time:rows[8].time,price:60};want[1].time=want[2].time=rows[8].time;want[3].price=60;}else if(handle===3)want[3].time=rows[16].time;else want[handle].price=price;
 assert.deepEqual(p,want);const saved=f.api.saveDrawings();f.api.undo();assert.equal(f.api.saveDrawings(),before);f.api.redo();assert.equal(f.api.saveDrawings(),saved);assert.equal(f.api.positionMetrics(id).entry,want[0].price);
});
test('creation magnet stores exact source time and price, collapsed endpoint retains valid default',t=>{
 const f=setup(t);f.c.setDrawingMagnet({mode:'strong'});f.c.setTool('longposition');f.c.down(1,x(4)+1,y(60)+1);const before=f.model.drawings.items[0];f.c.move(1,x(4)+1,y(80));assert.equal(f.model.drawings.items[0],before);f.c.move(1,x(12)+1,y(80)+1);f.c.up(1);const m=f.api.positionMetrics(before.id);assert.equal(m.startTime,rows[4].time);assert.equal(m.endTime,rows[12].time);assert.equal(m.entry,60);assert.equal(m.target,80);
});
test('body/keyboard are unsnapped pixel moves; raw group translation preserves exact distances',t=>{
 const f=setup(t,{scale:'log',range:[1,100]}),id=f.api.addDrawing({type:'longposition',points:anchors()}),before=f.api.positionMetrics(id),l=f.c.layout(),py=l.axis('price').y(55);
 f.c.setDrawingMagnet({mode:'strong'});f.c.down(1,x(8),py);assert.equal(f.c.gesture.handle,-1);f.c.move(1,x(8)+3,py+5);f.c.up(1);const after=f.api.positionMetrics(id);assert.notEqual(after.entry,before.entry);assert.ok(Math.abs(after.ratio-2)<1e-12);assert.ok(Math.abs(after.entry-50*Math.exp(-5/400*Math.log(100)))<1e-12);
 const prior=f.model.drawings.items[0].points;f.c.key('ArrowRight');assert.notEqual(f.model.drawings.items[0].points[0].time,prior[0].time);f.api.undo();f.api.undo();assert.equal(f.api.positionMetrics(id).entry,50);
 assert.deepEqual(f.api.translateDrawings([id],{deltaTimeMs:.25,deltaPrice:5}),{changed:1,invalidationFailed:false});const raw=f.api.positionMetrics(id);assert.equal(raw.risk,10);assert.equal(raw.reward,20);assert.equal(raw.entry,55);assert.equal(raw.startTime,rows[4].time+.25);
});
test('mixed group operations, lock, Float64-collapse rejection and history remain atomic',t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:anchors()}),other=f.api.addDrawing({type:'horizontal',points:[{time:T,price:1}]}),before=f.api.saveDrawings(),undo=f.model.drawings.undoStack;
 assert.throws(()=>f.api.translateDrawings([id,other],{deltaTimeMs:0,deltaPrice:1e20}),/Position/);assert.equal(f.api.saveDrawings(),before);assert.equal(f.model.drawings.undoStack,undo);
 assert.equal(f.api.setDrawingsStyle([id,other],{fill:'#abc',width:2}).changed,2);assert.equal(f.model.drawings.items[0].style.fill,'#aabbccff');f.api.undo();assert.equal(f.api.saveDrawings(),before);
 f.api.editDrawing(id,{locked:true});const locked=f.api.saveDrawings();assert.throws(()=>f.api.translateDrawings([id,other],{deltaTimeMs:1,deltaPrice:1}),/locked/);assert.throws(()=>f.api.deleteDrawings([id,other]),/locked/);assert.equal(f.api.saveDrawings(),locked);assert.equal(f.api.deleteDrawing(id),false);
 f.api.editDrawing(id,{locked:false});const unlocked=f.api.saveDrawings();assert.equal(f.api.deleteDrawings([id,other]).changed,2);f.api.undo();assert.equal(f.api.saveDrawings(),unlocked);f.api.redo();assert.equal(f.model.drawings.items.length,0);
});
test('shared-model stale events do not cancel a replacement drawing owner',t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:anchors()}),b=new InteractionController(f.model,()=>size);
 f.c.down(1,x(4),y(50));f.api.editDrawing(id,{text:'command'});assert.equal(f.c.gesture,null);b.setTool('shortposition');b.down(2,x(8),y(60));const transaction=f.model.drawings.transaction;f.c.up(1);f.c.cancel({ownedDrawingsOnly:true});assert.equal(f.model.drawings.transaction,transaction);b.up(2);assert.equal(f.model.drawings.items.length,2);
});
test('workspace embedded v3 preserves bound axes and rejects downgrade before restore',t=>{
 const f=setup(t);f.api.addAxis({id:'B',panel:'price',scale:'log',range:[1,100],inverted:true});f.api.addSeries({id:'B-price',panel:'price',type:'ohlc',axisId:'B'});f.api.addDrawing({type:'longposition',points:anchors(),seriesId:'B-price'});const saved=saveWorkspace(f.api,BINDING),doc=readWorkspaceDocument(saved);assert.equal(doc.version,1);assert.equal(doc.drawings.version,3);assert.equal(doc.drawings.drawings[0].axisId,'B');
 const before=f.api.saveDrawings();for(const version of [1,2]){const bad=JSON.parse(saved);bad.drawings.version=version;assert.throws(()=>readWorkspaceDocument(JSON.stringify(bad)),/version 3/);assert.equal(f.api.saveDrawings(),before);}
});
for(const segmented of [false,true])test(`async UI/history transfer retains v3, segmented=${segmented}`,t=>{
 const f=setup(t),id=f.api.addDrawing({type:'longposition',points:anchors()}),capture=new AsyncCapture(f.model,{kind:'correction',bar:{...rows[0],volume:2}}),p=new AsyncPrepared(capture.metadataJSON);t.after(()=>p.dispose());
 capture.buffers.forEach((v,i)=>p.target(i,0,v.length).set(capture.buffer(i,0,v.length)));p.start();while(!p.step(64).complete){}f.api.editDrawing(id,{text:'latest'});f.api.undo();const expected=f.api.saveDrawings();let result;
 if(segmented){const source=new AsyncUICapture(capture,f.c,size),target=new AsyncUIImport(source.headerJSON,p);for(let i=0;i<100;i++){const text=source.next();if(JSON.parse(text).complete)break;target.chunk(text);}result=target.finish();}else result=p.finish(capture.ui(f.c,size));
 t.after(()=>result.model.dispose());assert.equal(result.model.drawings.save(),expected);result.model.drawings.redo();assert.equal(result.model.drawings.items[0].text,'latest');assert.equal(JSON.parse(result.model.drawings.save()).version,3);
});
test('native workspace target keeps v3 through normalization and finishes with exact stored anchors',t=>{
 const f=setup(t);f.api.addDrawing({type:'longposition',points:anchors()});const s=f.model.store,document=saveWorkspace(f.api,BINDING),spec={schema:'aster.native-workspace-target',version:1,document,datasetBinding:BINDING,source:{length:s.length,maxBars:s.maxBars,timeframeMs:s.timeframeMs,timeOrigin:s.timeOrigin,version:s.version,timeVersion:s.timeVersion},size,retainedBytes:0,maxBytes:805306368};
 const p=new NativeWorkspacePrepared(JSON.stringify(spec));t.after(()=>p.dispose());for(const [i,k]of ['time','open','high','low','close','volume'].entries())p.target(i,0,s.length).set(s.columns[k].subarray(0,s.length));p.start();let complete=false;for(let i=0;i<100;i++)if(p.step(64).complete){complete=true;break;}assert.equal(complete,true);const result=p.finish();t.after(()=>result.model.dispose());assert.equal(saveWorkspace(new ChartAPI(result.model),BINDING),document);
 for(const version of [1,2]){const bad=JSON.parse(document);bad.drawings.version=version;assert.throws(()=>new NativeWorkspacePrepared(JSON.stringify({...spec,document:JSON.stringify(bad)})),/version 3/);assert.equal(saveWorkspace(f.api,BINDING),document);}
});
