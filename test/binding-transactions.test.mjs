import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController,createLayout} from '../src/core/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {installRecomputed,modelRequest} from '../src/web/worker-state.mjs';

const T=1700000000000,point=price=>({time:T+120000,price});
function fixture(){
 const store=new BarStore(Array.from({length:12},(_,i)=>({time:T+i*60000,open:100,high:120,low:90,close:110,volume:1})));
 const model=new ChartModel({store,panels:[{id:'price',range:[80,120],padding:0},{id:'other',range:[0,100]}],axes:[{id:'A',panel:'price',range:[1000,5000],padding:0},{id:'B',panel:'price',range:[0,100],padding:0}]});model.view={from:0,to:12};
 const input=new InteractionController(model,()=>({width:1000,height:500})),api=new ChartAPI(model,{controller:input});
 api.addDrawing({id:'d',type:'horizontal',panel:'price',axisId:'A',points:[point(3000)]});
 model.drawings.undoStack=[];model.drawings.redoStack=[];
 const start=()=>{const p=createLayout(model,1000,500).toScreen(point(3000),'price','A');input.down(1,p.x,p.y);assert.equal(input.gesture.kind,'edit');return p;};
 return {model,input,api,start,dispose:()=>model.dispose()};
}
const state=x=>({items:x.model.drawings.items,transaction:x.model.drawings.transaction,undo:x.model.drawings.undoStack.slice(),redo:x.model.drawings.redoStack.slice(),gesture:x.input.gesture,pointers:[...x.input.pointers],selected:x.model.drawings.selected,axes:x.model.axes.slice(),panels:x.model.panels.slice()});

test('public rebind ends the old edit and publishes one independent undo step',()=>{
 const x=fixture();try{const p=x.start();x.input.move(1,p.x,p.y+10);
  x.api.editDrawing('d',{axisId:'B',points:[point(50)]});
  assert.equal(x.input.gesture,null);assert.equal(x.input.pointers.size,0);assert.equal(x.model.drawings.transaction,null);
  x.input.move(1,p.x,p.y);x.input.cancel();assert.equal(x.model.drawings.items[0].axisId,'B');assert.equal(x.model.drawings.items[0].points[0].price,50);
  assert.equal(x.model.drawings.undoStack.length,1);x.api.undo();assert.equal(x.model.drawings.items[0].axisId,'A');assert.equal(x.model.drawings.items[0].points[0].price,3000);
  x.api.redo();assert.equal(x.model.drawings.items[0].axisId,'B');assert.equal(x.model.drawings.items[0].points[0].price,50);
  assert.throws(()=>x.api.removeAxis('A'),/referenced/);assert.doesNotThrow(()=>x.api.loadDrawings(x.api.saveDrawings()));
 }finally{x.dispose();}
});

for(const [name,patch] of [['missing binding',{axisId:'missing'}],['invalid anchors',{axisId:'B',points:[point(NaN)]}],['invalid style',{axisId:'B',style:{width:99}}],['invalid type',{type:'rectangle'}]])
 test('rejected '+name+' preserves the edit transaction atomically',()=>{
  const x=fixture();try{const p=x.start();x.input.move(1,p.x,p.y+8);const before=state(x);assert.throws(()=>x.api.editDrawing('d',patch));assert.deepEqual(state(x),before);
   x.input.move(1,p.x,p.y);assert.equal(x.input.gesture.kind,'edit');x.input.cancel();assert.equal(x.model.drawings.items[0].points[0].price,3000);assert.equal(x.model.drawings.undoStack.length,0);
  }finally{x.dispose();}
 });

test('axis removal sees a reference retained only by transaction rollback',()=>{
 const x=fixture();try{x.model.drawings.begin();x.model.drawings.edit('d',{axisId:'B',points:[point(50)]});assert.throws(()=>x.model.removeAxis('A'),/referenced/);
  x.model.drawings.cancel();assert.equal(x.model.drawings.items[0].axisId,'A');assert.ok(createLayout(x.model,1000,500).drawingAxis(x.model.drawings.items[0]));assert.doesNotThrow(()=>x.api.loadDrawings(x.api.saveDrawings()));
 }finally{x.dispose();}
});

test('related projection changes reject during drawing transaction; unrelated hidden axis remains usable',()=>{
 const x=fixture();try{x.api.setAxis('B',{visible:false});x.start();const before=state(x);assert.throws(()=>x.api.setAxis('A',{range:[0,100]}),/transaction|gesture/);assert.deepEqual(state(x),before);
  assert.throws(()=>x.api.setPanel('price',{padding:.2}),/transaction|gesture/);assert.deepEqual(state(x),before);
  assert.throws(()=>x.api.setPanel('other',{weight:5}),/transaction|gesture/);assert.deepEqual(state(x),before);
  x.api.setAxis('B',{range:[0,200]});x.api.removeAxis('B');assert.equal(x.input.gesture.kind,'edit');assert.equal(x.model.drawings.selected,'d');x.input.cancel();
 }finally{x.dispose();}
});

test('external style edit restores live motion before an independent edit; cancel cannot erase it',()=>{
 const x=fixture();try{const p=x.start();x.input.move(1,p.x,p.y+8);x.api.editDrawing('d',{style:{color:'#123456'}});x.input.cancel();
  assert.equal(x.model.drawings.items[0].points[0].price,3000);assert.equal(x.model.drawings.items[0].style.color,'#123456ff');assert.equal(x.model.drawings.undoStack.length,1);
 }finally{x.dispose();}
});

test('adding a drawing during an edit is independent from pointer cancellation',()=>{
 const x=fixture();try{const p=x.start();x.input.move(1,p.x,p.y+8);x.api.addDrawing({id:'new',type:'horizontal',panel:'price',axisId:'B',points:[point(50)]});x.input.cancel();
  assert.deepEqual(x.model.drawings.items.map(d=>d.id),['d','new']);assert.equal(x.model.drawings.items[0].points[0].price,3000);assert.equal(x.model.drawings.undoStack.length,1);x.api.undo();assert.deepEqual(x.model.drawings.items.map(d=>d.id),['d']);
 }finally{x.dispose();}
});

test('missing delete is a no-op and cannot cancel a different active edit',()=>{
 const x=fixture();try{x.start();const before=state(x);assert.equal(x.api.deleteDrawing('missing'),false);assert.deepEqual(state(x),before);x.input.cancel();}finally{x.dispose();}
});

test('uncommitted creation rejects external edit before cancellation and explicit delete cancels it',()=>{
 const x=fixture();try{x.input.setTool('horizontal');x.input.setDrawingTarget({panel:'price',axisId:'B'});x.input.down(1,300,100);const id=x.input.gesture.id,before=state(x);
  assert.throws(()=>x.api.editDrawing(id,{axisId:'A',points:[point(3000)]}),/drawing/i);assert.deepEqual(state(x),before);assert.equal(x.api.deleteDrawing(id),false);assert.equal(x.input.gesture,null);assert.deepEqual(x.model.drawings.items.map(d=>d.id),['d']);
 }finally{x.dispose();}
});

test('direct low-level binding edits cannot reuse cached pointer coordinates from another axis',()=>{
 const x=fixture();try{const p=x.start();x.model.drawings.edit('d',{axisId:'B',points:[point(50)]});x.input.move(1,p.x,p.y);
  assert.equal(x.input.gesture,null);assert.equal(x.model.drawings.transaction,null);assert.equal(x.model.drawings.items[0].axisId,'A');assert.equal(x.model.drawings.items[0].points[0].price,3000);
 }finally{x.dispose();}
});

test('explicit low-level transactions retain API edit grouping outside pointer gestures',()=>{
 const x=fixture();try{x.model.drawings.begin();x.api.editDrawing('d',{points:[point(3100)]});assert.ok(x.model.drawings.transaction);assert.equal(x.model.drawings.undoStack.length,0);x.model.drawings.cancel();assert.equal(x.model.drawings.items[0].points[0].price,3000);}finally{x.dispose();}
});

test('failed count-budget add leaves the active gesture and history unchanged',()=>{
 const x=fixture();try{x.model.drawings.maxDrawings=1;x.start();const before=state(x);assert.throws(()=>x.api.addDrawing({id:'extra',type:'horizontal',axisId:'B',points:[point(50)]}),/limit/);assert.deepEqual(state(x),before);x.input.cancel();}finally{x.dispose();}
});

test('locked delete is a no-op and changing selection cancels only after validation',()=>{
 const x=fixture();try{x.api.addDrawing({id:'locked',type:'horizontal',axisId:'B',locked:true,points:[point(20)]});x.model.drawings.undoStack=[];x.start();const before=state(x);
  assert.equal(x.api.deleteDrawing('locked'),false);assert.deepEqual(state(x),before);assert.throws(()=>x.api.selectDrawing('missing'),/Missing/);assert.deepEqual(state(x),before);
  x.api.selectDrawing('d');assert.equal(x.input.gesture.kind,'edit');x.api.selectDrawing('locked');assert.equal(x.input.gesture,null);assert.equal(x.model.drawings.selected,'locked');assert.equal(x.model.drawings.transaction,null);
 }finally{x.dispose();}
});

test('state notifications observe committed drawing state and reentrant edits are retained',()=>{
 const x=fixture();try{x.start();let nested=false;const observed=[];
  const notify=()=>{observed.push(x.model.drawings.items[0].axisId);if(!nested){nested=true;x.api.addDrawing({id:'callback',type:'horizontal',axisId:'B',points:[point(20)]});}};
  x.api.invalidate=notify;x.input.invalidate=notify;x.api.editDrawing('d',{axisId:'B',points:[point(50)]});
  assert.deepEqual(observed,['B','B']);assert.deepEqual(x.model.drawings.items.map(d=>d.id),['d','callback']);assert.equal(x.model.drawings.undoStack.length,2);
  x.api.invalidate=()=>{};x.input.invalidate=()=>{};x.api.undo();assert.equal(x.model.drawings.items[0].axisId,'B');x.api.undo();assert.equal(x.model.drawings.items[0].axisId,'A');
 }finally{x.dispose();}
});

test('controller target and tool callbacks cannot observe cancellation before the new state',()=>{
 const x=fixture();try{x.start();const seen=[];x.input.invalidate=()=>seen.push({target:x.input.drawingTarget,tool:x.input.tool,gesture:x.input.gesture});
  x.input.setDrawingTarget({panel:'price',axisId:'B'});assert.equal(seen.length,1);assert.equal(seen[0].target.axisId,'B');assert.equal(seen[0].gesture,null);
  seen.length=0;x.input.setTool('horizontal');assert.equal(seen.length,1);assert.equal(seen[0].tool,'horizontal');
 }finally{x.dispose();}
});

test('worker correction cannot overwrite viewport changes from a publication observer',async()=>{
 const x=fixture();try{const event={kind:'correction',bar:{...x.model.store.at(0),volume:999}},expected=modelRequest(x.model),packet=await computeRequest({columns:x.model.store.columns,length:x.model.store.length,options:expected,event});
  x.model.store.subscribe(()=>x.api.setVisibleRange(-.5,9.5));installRecomputed(x.model,packet,event,expected);
  assert.deepEqual(x.model.view,{from:-.5,to:9.5});assert.equal(x.model.follow,false);assert.equal(x.model.store.at(0).volume,999);
 }finally{x.dispose();}
});
