import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {DrawingStore,BarStore,ChartModel,InteractionController,seededColumns,drawingGeometry,drawingHitTest} from '../src/core/index.mjs';
import {WebGLRenderer} from '../src/renderers/webgl.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const panel={id:'price',left:100,right:900,top:100,bottom:500};
function fixture(orientation,{width=50,reverse=false,fill=null}={}){
 const positions=orientation==='horizontal'?[[200,300],[600,300]]:[[400,150],[400,450]];
 if(reverse)positions.reverse();
 const store=new DrawingStore(),layout={panels:[panel],drawingAxis:()=>panel,toScreen:p=>({x:p.time,y:p.price})};
 const id=store.add({type:'ellipse',points:positions.map(([time,price])=>({time,price})),style:{width,color:'#ffffff',...(fill?{fill}:{})}});
 store.selected=null;
 return {store,layout,id,drawing:store.items[0],hit:(x,y,tolerance=8)=>drawingHitTest(store,layout,x,y,tolerance)};
}
// Execute the shipped ellipse-to-quad path. The GL calls are no-ops: this checks
// the submitted nonzero-area mesh and does not claim GPU raster/pixel coverage.
function rendererMesh(commands){
 const renderer=Object.create(WebGLRenderer.prototype);
 Object.assign(renderer,{gl:new Proxy({isContextLost:()=>false},{get:(o,k)=>o[k]??(()=>{})}),canvas:{width:1000,height:600},packed:new Float32Array(4096*16),capacityBytes:0,atlasDpr:1,atlasDirty:false,glyphs:new Map(),color:()=>[1,1,1,1]});
 renderer.render({width:1000,height:600,background:'#000000',commands});
 return Array.from({length:renderer.count},(_,i)=>Array.from(renderer.packed.slice(i*16,i*16+8)));
}
function triangleContains(x,y,a,b,c){
 const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 if(Math.abs(cross(a,b,c))<1e-6)return false;
 const signs=[cross(a,b,[x,y]),cross(b,c,[x,y]),cross(c,a,[x,y])];
 return signs.every(v=>v>=0)||signs.every(v=>v<=0);
}
function meshContains(mesh,x,y){return mesh.some(q=>{const a=q.slice(0,2),b=q.slice(2,4),c=q.slice(4,6),d=q.slice(6,8);return triangleContains(x,y,a,b,c)||triangleContains(x,y,b,c,d);});}

for(const orientation of ['horizontal','vertical'])for(const reverse of [false,true])for(const fill of [null,'#ff0000'])test(`${orientation} degenerate ellipse, reversed=${reverse}, fill=${!!fill}: submitted stroke body is selectable`,()=>{
 const f=fixture(orientation,{reverse,fill}),mesh=rendererMesh(drawingGeometry(f.drawing,f.layout));
 const [x,y]=orientation==='horizontal'?[430,320]:[420,270];
 assert.ok(meshContains(mesh,x,y),'probe lies in a nonzero-area shipped renderer triangle');
 assert.deepEqual(f.hit(x,y),{id:f.id,handle:-1,locked:false});
 assert.equal(f.hit(orientation==='horizontal'?x:426,orientation==='horizontal'?326:y),null);
});
for(const orientation of ['horizontal','vertical'])test(`${orientation} collapsed outline respects tolerance, stroke width and endpoint distance`,()=>{
 for(const width of [.1,1.5,16,50])for(const tolerance of [1,8,24,32]){
  const f=fixture(orientation,{width}),radius=Math.max(tolerance,width/2),horizontal=orientation==='horizontal';
  assert.equal(f.hit(horizontal?400:400+radius,horizontal?300+radius:300,tolerance)?.id,f.id);
  assert.equal(f.hit(horizontal?400:400+radius+.01,horizontal?300+radius+.01:300,tolerance),null);
  assert.equal(f.hit(horizontal?200-radius:400,horizontal?300:150-radius,tolerance)?.id,f.id);
  assert.equal(f.hit(horizontal?200-radius-.01:400,horizontal?300:150-radius-.01,tolerance),null);
  // A square bounding-box corner outside the endpoint's circular allowance.
  assert.equal(f.hit(horizontal?200-radius:400+radius,horizontal?300+radius:150-radius,tolerance),null);
 }
});
test('both-zero ellipse has no submitted area or new body hit; selected handles still work',()=>{
 const f=fixture('horizontal');f.store.edit(f.id,{points:[{time:400,price:300},{time:400,price:300}]});
 for(const fill of [null,'#ff0000']){
  f.store.edit(f.id,{style:{width:50,color:'#ffffff',...(fill?{fill}:{})}});
  const mesh=rendererMesh(drawingGeometry(f.store.items[0],f.layout));
  assert.equal(meshContains(mesh,400,300),false);assert.equal(f.hit(400,300),null);
 }
 f.store.selected=f.id;assert.deepEqual(f.hit(400,300),{id:f.id,handle:0});
});
test('selected handles keep their radius and precede a newer collapsed body',()=>{
 const f=fixture('horizontal');const later=f.store.add({type:'ellipse',points:f.drawing.points,style:{width:50}});
 f.store.selected=f.id;
 assert.deepEqual(f.hit(200,305),{id:f.id,handle:0});
 assert.deepEqual(f.hit(200,320),{id:later,handle:-1,locked:false});
});
test('topmost locked collapsed body stays selectable and cannot be edited',()=>{
 const f=fixture('vertical'),id=f.store.add({type:'ellipse',points:f.drawing.points,style:{width:50},locked:true});f.store.selected=id;
 assert.deepEqual(f.hit(400,300),{id,handle:-1,locked:true});
 assert.throws(()=>f.store.edit(id,{points:[{time:300,price:150},{time:300,price:450}]}),/locked/);
 assert.equal(f.store.remove(id),false);
});
test('panel clipping, panel identity and absent bound axis precede collapsed body selection',()=>{
 const f=fixture('horizontal');f.store.edit(f.id,{points:[{time:50,price:300},{time:950,price:300}]});
 assert.equal(f.hit(99,300),null);assert.equal(f.hit(901,300),null);assert.equal(f.hit(100,300)?.id,f.id);
 assert.equal(drawingHitTest(f.store,{...f.layout,drawingAxis:()=>null},400,300),null);
 assert.equal(drawingHitTest(f.store,{...f.layout,panels:[{...panel,id:'other'}]},400,300),null);
});
for(const orientation of ['horizontal','vertical'])test(`${orientation}: actual controller selects and moves a collapsed body with one undo`,t=>{
 const store=new BarStore();store.setColumns(seededColumns(100));const model=new ChartModel({store});model.addSeries({id:'p',type:'candles',panel:'price'});t.after(()=>model.dispose());
 const controller=new InteractionController(model,()=>({width:1000,height:600})),layout=controller.layout();
 const positions=orientation==='horizontal'?[[300,300],[600,300]]:[[400,180],[400,420]];
 const id=model.drawings.add({type:'ellipse',points:positions.map(([x,y])=>layout.fromScreen(x,y,'price')),style:{width:50}});model.drawings.selected=null;
 const before=model.drawings.save(),undo=model.drawings.undoStack.length,[x,y]=orientation==='horizontal'?[450,320]:[420,300];
 controller.setTool('select');controller.down(1,x,y);assert.equal(model.drawings.selected,id);controller.move(1,x+20,y+20);controller.up(1);
 assert.notEqual(model.drawings.save(),before);assert.equal(model.drawings.undoStack.length,undo+1);model.drawings.undo();assert.equal(model.drawings.save(),before);model.drawings.redo();assert.notEqual(model.drawings.save(),before);
});
test('generated native core includes collapsed-body selection and undo',async()=>{
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(`JSON.stringify((()=>{nativeInit(100);const c=new Aster.InteractionController(nativeModel,()=>({width:1000,height:600})),l=c.layout();const id=nativeModel.drawings.add({type:'ellipse',points:[l.fromScreen(300,300,'price'),l.fromScreen(600,300,'price')],style:{width:50}});nativeModel.drawings.selected=null;const before=nativeModel.drawings.save();c.setTool('select');c.down(1,450,320);const selected=nativeModel.drawings.selected===id;c.move(1,470,340);c.up(1);const moved=nativeModel.drawings.save()!==before;nativeModel.drawings.undo();const restored=nativeModel.drawings.save()===before;nativeModel.dispose();return {selected,moved,restored};})())`,context,{timeout:5000}));
 assert.deepEqual(result,{selected:true,moved:true,restored:true});
});
