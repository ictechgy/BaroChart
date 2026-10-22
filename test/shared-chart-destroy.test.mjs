import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
// Actual chart/controller/model with minimal DOM and queued RAF; no browser or
// device teardown/pixel/AT claim.
function fixture(t){
 const keys=['document','requestAnimationFrame','cancelAnimationFrame'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map();let serial=0;
 class Canvas extends EventTarget{constructor(){super();this.style={};}setAttribute(){}remove(){this.removed=true;}}
 globalThis.document={createElement:()=>new Canvas()};globalThis.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const model=new ChartModel();model.store.setData(Array.from({length:30},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));model.addSeries({id:'price',type:'candles',panel:'price'});model.fit();
 const charts=[],make=()=>{const chart=new CanvasChart({append(){},clientWidth:600,clientHeight:400},model,{interactive:false,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})});charts.push(chart);return chart;};
 t.after(()=>{for(const chart of charts)chart.destroy();model.dispose();for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
 return {model,make,frames};
}
function create(chart){chart.controller.setTool('trendline');chart.controller.down(1,100,100);chart.controller.move(1,200,200);}
for(const sibling of ['idle','pan','wait'])test(`destroy ${sibling} sibling preserves another chart's live creation`,t=>{
 const {model,make}=fixture(t),a=make(),b=make();
 if(sibling!=='idle'){b.controller.down(8,300,200);if(sibling==='wait'){b.controller.down(9,400,200);b.controller.up(9);}}
 create(a);const txn=model.drawings.transaction,items=model.drawings.items,selected=model.drawings.selected;
 b.destroy();assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);assert.equal(model.drawings.selected,selected);assert.equal(b.controller.pointers.size,0);assert.equal(b.controller.gesture,null);
 a.controller.up(1);assert.equal(model.drawings.items.length,1);assert.equal(model.drawings.undoStack.length,1);assert.equal(model.drawings.transaction,null);assert.equal(model.drawings.undo(),true);assert.equal(model.drawings.items.length,0);
});
for(const kind of ['create','edit'])test(`destroy own ${kind} rolls back only its live transaction`,t=>{
 const {model,make}=fixture(t),a=make(),b=make();
 if(kind==='edit'){create(a);a.controller.up(1);a.controller.setTool('select');const layout=a.controller.layout(),p=layout.toScreen(model.drawings.items[0].points[0],'price');a.controller.down(2,p.x,p.y);a.controller.move(2,p.x+15,p.y+10);}else create(a);
 const before=model.drawings.transaction.slice(),history=model.drawings.undoStack.slice();a.destroy();assert.deepEqual(model.drawings.items,before);assert.equal(model.drawings.transaction,null);assert.deepEqual(model.drawings.undoStack,history);assert.notEqual(model.disposed,true);assert.equal(b.disposed,false);a.destroy();
});
test('stale creator cannot cancel a later manual transaction',t=>{
 const {model,make}=fixture(t),a=make();create(a);model.drawings.cancel();model.drawings.begin();model.drawings.add({id:'manual',type:'horizontal',points:[{time:1000,price:10}]});const txn=model.drawings.transaction,items=model.drawings.items;
 a.destroy();assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);model.drawings.commit();assert.equal(model.drawings.items[0].id,'manual');
});
test('ordinary explicit cancel retains its existing global transaction contract',t=>{
 const {model,make}=fixture(t),a=make(),b=make();create(a);b.controller.cancel();assert.equal(model.drawings.transaction,null);assert.equal(model.drawings.items.length,0);
});
for(const replacement of ['undo','load'])test(`destroy after ${replacement} cannot roll back a new manual transaction`,t=>{
 const {model,make}=fixture(t),a=make();create(a);a.controller.up(1);create(a);
 if(replacement==='undo')model.drawings.undo();else{model.drawings.cancel();model.drawings.load(model.drawings.save());}
 model.drawings.begin();model.drawings.add({id:'later',type:'horizontal',points:[{time:1000,price:10}]});const txn=model.drawings.transaction,items=model.drawings.items;a.destroy();assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);model.drawings.commit();
});
test('teardown callback replacing the transaction preserves its new owner',t=>{
 const {model,make}=fixture(t),a=make(),b=make();create(a);const dispose=a.disposeDataExplorer.bind(a);let later;
 a.disposeDataExplorer=()=>{dispose();model.drawings.cancel();create(b);later=model.drawings.transaction;};
 a.destroy();assert.equal(model.drawings.transaction,later);assert.equal(b.controller.gesture.kind,'create');b.controller.up(1);assert.equal(model.drawings.items.length,1);assert.equal(model.drawings.undoStack.length,1);
});
test('generated core bundle retains default cancellation and owns its captured transaction',async()=>{
 const {default:vm}=await import('node:vm');const {buildNativeBundle}=await import('../scripts/native-core-bundle.mjs');const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const result=vm.runInContext(`(()=>{const m=new Aster.ChartModel();m.store.setData(Array.from({length:30},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));m.addSeries({id:'p',type:'candles',panel:'price'});m.fit();const a=new Aster.InteractionController(m,()=>({width:600,height:400})),b=new Aster.InteractionController(m,()=>({width:600,height:400}));a.setTool('trendline');a.down(1,100,100);const txn=m.drawings.transaction;b.cancel({ownedDrawingsOnly:true});const preserved=m.drawings.transaction===txn;a.cancel({ownedDrawingsOnly:true});const rolledBack=m.drawings.transaction===null&&m.drawings.items.length===0;m.drawings.begin();b.cancel();const defaultCancelled=m.drawings.transaction===null;m.dispose();return {preserved,rolledBack,defaultCancelled};})()`,context,{timeout:5000});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{preserved:true,rolledBack:true,defaultCancelled:true});
});
