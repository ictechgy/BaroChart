import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
// Actual chart/controller/model with minimal DOM and queued RAF; no browser or
// device teardown/pixel/AT claim.
function fixture(t){
 const keys=['document','requestAnimationFrame','cancelAnimationFrame'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map();let serial=0;
 class Canvas extends EventTarget{constructor(){super();this.style={};}setAttribute(){}focus(){}setPointerCapture(){}getBoundingClientRect(){return {left:0,top:0};}remove(){this.removed=true;}}
 globalThis.document={createElement:()=>new Canvas()};globalThis.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const model=new ChartModel();model.store.setData(Array.from({length:30},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));model.addSeries({id:'price',type:'candles',panel:'price'});model.fit();
 const charts=[],make=(source=model)=>{const chart=new CanvasChart({append(){},clientWidth:600,clientHeight:400},source,{dpr:()=>1,interactive:true,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){this.renders=(this.renders??0)+1;},dispose(){this.disposed=true;}})});charts.push(chart);return chart;};
 t.after(()=>{for(const chart of charts)chart.destroy();model.dispose();for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
 return {model,make,frames};
}
function create(chart){chart.controller.setTool('trendline');chart.controller.down(1,100,100);chart.controller.move(1,200,200);}
function down(chart,id,x=100,y=100){const e=new Event('pointerdown',{cancelable:true});Object.assign(e,{button:0,pointerId:id,clientX:x,clientY:y});chart.canvas.dispatchEvent(e);}
test('rejected sibling creation preserves owner transaction and can be retried after owner commit',t=>{
 const {model,make}=fixture(t),a=make(),b=make();b.controller.setTool('trendline');create(a);const txn=model.drawings.transaction,items=model.drawings.items;down(b,2,300,100);
 assert.match(b.lastError.message,/transaction/);assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);assert.equal(b.controller.pointers.size,0);assert.equal(b.controller.gesture,null);a.controller.up(1);assert.equal(model.drawings.undoStack.length,1);
 down(b,3,300,100);b.controller.move(3,400,200);b.controller.up(3);assert.equal(model.drawings.items.length,2);assert.equal(model.drawings.undoStack.length,2);
});
test('own creation failure after begin rolls back its transaction',t=>{
 const {model,make}=fixture(t),a=make();a.controller.setTool('text');a.controller.text='x'.repeat(2001);down(a,1);assert.match(a.lastError.message,/text/i);assert.equal(model.drawings.transaction,null);assert.equal(model.drawings.items.length,0);assert.equal(a.controller.pointers.size,0);a.controller.text='ok';down(a,2);a.controller.up(2);assert.equal(model.drawings.items[0].text,'ok');
});
test('failed setup preserves a replacement transaction created by reentry',t=>{
 const {model,make}=fixture(t),a=make();a.controller.setTool('trendline');const add=model.drawings.add.bind(model.drawings);let replacement;model.drawings.add=()=>{model.drawings.cancel();model.drawings.begin();add({id:'other',type:'horizontal',points:[{time:1000,price:10}]});replacement=model.drawings.transaction;throw new Error('setup failed');};down(a,1);assert.equal(a.lastError.message,'setup failed');assert.equal(model.drawings.transaction,replacement);assert.equal(model.drawings.items[0].id,'other');model.drawings.add=add;model.drawings.commit();
});
test('edit setup exception releases its own transaction without changing committed geometry',t=>{
 const {model,make}=fixture(t),a=make();create(a);a.controller.up(1);a.controller.setTool('select');const before=model.drawings.items,history=model.drawings.undoStack.slice(),point=a.controller.layout().toScreen(before[0].points[0],'price');a.controller.drawingProjection=()=>{throw new Error('projection failed');};down(a,2,point.x,point.y);assert.equal(a.lastError.message,'projection failed');assert.equal(model.drawings.transaction,null);assert.deepEqual(model.drawings.items,before);assert.deepEqual(model.drawings.undoStack,history);assert.equal(a.controller.pointers.size,0);
});
for(const count of [1,4,16])for(const shared of [false,true])test(`${count} charts, ${shared?'shared':'independent'} models: bounded update/resize/recreate lifecycle`,t=>{
 const {model,make,frames}=fixture(t),models=[model],charts=[],baseListeners=model.store.listeners.size;
 for(let i=0;i<count;i++){
  if(!shared&&i){const m=new ChartModel();m.store.setData(Array.from({length:30},(_,j)=>model.store.at(j)));m.addSeries({id:'p',type:'candles',panel:'price'});m.fit();models.push(m);}
  charts.push(make(shared?model:models[i]));
 }
 t.after(()=>{for(const m of models)m.dispose();});
 const flush=()=>{const pending=[...frames];frames.clear();for(const[,fn]of pending)fn();};flush();assert(charts.every(c=>c.lastScene&&c.lastError===null));
 for(const m of models)assert.equal(m.store.listeners.size,baseListeners+(shared?count:1));
 const originalViews=models.map(m=>({...m.view}));charts[0].api.pan(-2);charts[0].controller.move(999,250,120);
 if(shared){for(const chart of charts){assert.equal(chart.model.view,model.view);assert.equal(chart.model.crosshair,model.crosshair);}}
 else for(let i=1;i<models.length;i++){assert.deepEqual(models[i].view,originalViews[i]);assert.equal(models[i].crosshair,null);}
 const row=model.store.at(29);charts[0].api.applyDataEvent({kind:'append',bar:{...row,time:row.time+1000}});assert.equal(model.store.length,31);if(!shared)for(const m of models.slice(1))assert.equal(m.store.length,30);
 for(const chart of charts){chart.container.clientWidth=640;chart.resize();}assert.equal(frames.size,count);flush();assert(charts.every(c=>c.lastError===null));
 const first=charts[0],renderer=first.renderer;first.destroy();assert.equal(first.listeners.length,0);assert.equal(first.frame,null);assert.equal(renderer.disposed,true);assert.equal(first.canvas.width,0);assert.equal(first.canvas.height,0);assert.equal(model.store.listeners.size,baseListeners+(shared?count-1:0));
 const replacement=make(model);flush();assert.equal(replacement.lastError,null);assert(replacement.lastScene);for(const chart of charts.slice(1))chart.destroy();replacement.destroy();assert.equal(frames.size,0);for(const m of models)assert.equal(m.store.listeners.size,baseListeners);
});
test('late cancellation from a rejected sibling pointer cannot cancel the active owner',t=>{
 const {model,make}=fixture(t),a=make(),b=make();b.controller.setTool('trendline');create(a);const txn=model.drawings.transaction;down(b,2,300,100);const e=new Event('pointercancel');Object.assign(e,{pointerId:2});b.canvas.dispatchEvent(e);assert.equal(model.drawings.transaction,txn);a.controller.up(1);assert.equal(model.drawings.undoStack.length,1);
});
for(const event of ['pointercancel','lostpointercapture'])test(`${event} of a sibling pan leaves a foreign drawing transaction intact`,t=>{
 const {model,make}=fixture(t),a=make(),b=make();down(b,2,300,200);create(a);const txn=model.drawings.transaction;const e=new Event(event);Object.assign(e,{pointerId:2});b.canvas.dispatchEvent(e);assert.equal(model.drawings.transaction,txn);assert.equal(b.controller.pointers.size,0);assert.equal(b.controller.gesture,null);a.controller.up(1);assert.equal(model.drawings.undoStack.length,1);
});
test('generated core setup failure rolls back its own transaction and preserves error',async()=>{
 const {default:vm}=await import('node:vm');const {buildNativeBundle}=await import('../scripts/native-core-bundle.mjs');const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});const result=vm.runInContext(`(()=>{const m=new Aster.ChartModel(),c=new Aster.InteractionController(m,()=>({width:600,height:400}));m.store.setData([{time:1000,open:10,high:12,low:9,close:11,volume:1}]);m.addSeries({id:'p',type:'candles',panel:'price'});m.fit();c.setTool('text');c.text='x'.repeat(2001);let message;try{c.down(1,100,100);}catch(e){message=e.message;}const empty=m.drawings.items.length===0&&m.drawings.transaction===null;c.cancel();m.dispose();return {empty,message};})()`,context,{timeout:5000});assert.equal(result.empty,true);assert.match(result.message,/Drawing text/);
});
