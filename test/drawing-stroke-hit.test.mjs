import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,InteractionController,seededColumns,drawingGeometry,drawingHitTest} from '../src/core/index.mjs';

function fixture(t,type,width=50){
 const store=new BarStore();store.setColumns(seededColumns(100));
 const model=new ChartModel({store});model.addSeries({id:'p',type:'candles',panel:'price'});
 const controller=new InteractionController(model,()=>({width:1000,height:600})),layout=controller.layout();
 const positions=type==='horizontal'?[[300,200]]:type==='rectangle'||type==='ellipse'?[[300,200],[500,400]]:[[300,200],[500,200]];
 const id=model.drawings.add({type,points:positions.map(([x,y])=>layout.fromScreen(x,y,'price')),style:{color:'#ffffff',width}});
 model.drawings.selected=null;t.after(()=>model.dispose());
 return {model,controller,layout,id,drawing:model.drawings.items[0],hit:(x,y,tolerance=8)=>drawingHitTest(model.drawings,layout,x,y,tolerance)};
}
for(const type of ['horizontal','trendline','ray','extendedline','measurement','freehand','rectangle','ellipse'])test(`${type}: supported thick stroke body remains selectable`,t=>{
 const f=fixture(t,type),commands=drawingGeometry(f.drawing,f.layout);
 const command=commands.find(c=>c.op==='lines'||c.op==='box'||c.op==='ellipse');
 assert.equal(command.width,50);
 // Horizontal top stroke (or circle's top) at y=200: y=180 is visibly inside
 // its 25px half-width, while y=174 is outside. No glyph/pixel mask claim.
 assert.equal(f.hit(400,180)?.id,f.id);
 assert.equal(f.hit(400,174),null);
});
for(const width of [.1,1.5,2,16])test(`width ${width}: existing 8px centerline selection allowance stays unchanged`,t=>{
 const f=fixture(t,'horizontal',width);
 assert.equal(f.hit(500,207)?.id,f.id);assert.equal(f.hit(500,209),null);
});
test('thick body does not enlarge selected anchor handles',t=>{
 const f=fixture(t,'trendline');f.model.drawings.selected=f.id;
 assert.deepEqual(f.hit(300,205),{id:f.id,handle:0});
 assert.deepEqual(f.hit(300,220),{id:f.id,handle:-1,locked:false});
});
test('topmost and locked selection remain intact; panel clipping still wins',t=>{
 const f=fixture(t,'horizontal');const id=f.model.drawings.add({type:'horizontal',points:f.drawing.points,style:{width:50},locked:true});f.model.drawings.selected=null;
 assert.deepEqual(f.hit(500,220),{id,handle:-1,locked:true});
 assert.equal(f.hit(f.layout.panels[0].left-1,200),null);
 assert.equal(f.hit(500,f.layout.panels[0].top-1),null);
});
test('body radius is max(input tolerance, half width), including exact edge and narrow input',t=>{
 const f=fixture(t,'horizontal');const y=drawingGeometry(f.drawing,f.layout)[0].coords[1];
 for(const tolerance of [1,8,24]){assert.equal(f.hit(500,y+25,tolerance)?.id,f.id);assert.equal(f.hit(500,y+25.001,tolerance),null);}
 assert.equal(f.hit(500,y+31,32)?.id,f.id);assert.equal(f.hit(500,y+33,32),null);
});
test('text stroke width does not expand text bounds and missing axis stays hidden',t=>{
 const f=fixture(t,'horizontal');f.model.drawings.remove(f.id);
 const id=f.model.drawings.add({type:'text',points:[f.layout.fromScreen(300,200,'price')],text:'Note',style:{width:50,font:'12px monospace'}});f.model.drawings.selected=null;
 assert.equal(f.hit(305,200)?.id,id);assert.equal(f.hit(280,200),null);
 assert.equal(drawingHitTest(f.model.drawings,{...f.layout,drawingAxis:()=>null},305,200),null);
});
test('ordinary controller selects and moves a thick body with one undo unit',t=>{
 const f=fixture(t,'horizontal'),before=f.model.drawings.save(),history=f.model.drawings.undoStack.length;
 f.controller.setTool('select');f.controller.down(1,500,220);assert.equal(f.model.drawings.selected,f.id);
 f.controller.move(1,500,240);f.controller.up(1);
 assert.notEqual(f.model.drawings.save(),before);assert.equal(f.model.drawings.undoStack.length,history+1);
 f.model.drawings.undo();assert.equal(f.model.drawings.save(),before);
});
test('generated native core uses the same thick-body selection and undo path',async()=>{
 const {default:vm}=await import('node:vm');const {buildNativeBundle}=await import('../scripts/native-core-bundle.mjs');
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(`JSON.stringify((()=>{nativeInit(100);const c=new Aster.InteractionController(nativeModel,()=>({width:1000,height:600})),l=c.layout();const id=nativeModel.drawings.add({type:'horizontal',points:[l.fromScreen(300,200,'price')],style:{width:50}});nativeModel.drawings.selected=null;const before=nativeModel.drawings.save();c.setTool('select');c.down(1,500,220);const selected=nativeModel.drawings.selected===id;c.move(1,500,240);c.up(1);const moved=nativeModel.drawings.save()!==before;nativeModel.drawings.undo();const restored=nativeModel.drawings.save()===before;nativeModel.dispose();return {selected,moved,restored};})())`,context,{timeout:5000}));
 assert.deepEqual(result,{selected:true,moved:true,restored:true});
});
