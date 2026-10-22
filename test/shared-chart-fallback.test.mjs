import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
// Actual chart/controller/model with minimal DOM and queued RAF; no browser or
// device teardown/pixel/AT claim.
function fixture(t){
 const keys=['document','requestAnimationFrame','cancelAnimationFrame'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map();let serial=0;
 class Canvas extends EventTarget{constructor(){super();this.style={};}setAttribute(){}cloneNode(){return new Canvas();}replaceWith(){this.removed=true;}getContext(){return {};}remove(){this.removed=true;}}
 globalThis.document={createElement:()=>new Canvas()};globalThis.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const model=new ChartModel();model.store.setData(Array.from({length:30},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));model.addSeries({id:'price',type:'candles',panel:'price'});model.fit();
 const charts=[],make=()=>{const chart=new CanvasChart({append(){},clientWidth:600,clientHeight:400},model,{interactive:false,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})});charts.push(chart);return chart;};
 t.after(()=>{for(const chart of charts)chart.destroy();model.dispose();for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
 return {model,make,frames};
}
function create(chart){chart.controller.setTool('trendline');chart.controller.down(1,100,100);chart.controller.move(1,200,200);}
for(const sibling of ['idle','pan'])test(`fallback of ${sibling} sibling preserves live drawing and replaces only its canvas`,t=>{
 const {model,make}=fixture(t),a=make(),b=make();if(sibling==='pan')b.controller.down(2,350,250);create(a);const txn=model.drawings.transaction,items=model.drawings.items,old=b.canvas;let notified=0;b.onFallback=()=>notified++;b.fallback('modeled renderer failure');assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);assert.equal(b.controller.pointers.size,0);assert.equal(b.controller.gesture,null);assert.notEqual(b.canvas,old);assert.equal(old.removed,true);assert.equal(b.rendererKind,'canvas');assert.equal(notified,1);a.controller.up(1);assert.equal(model.drawings.items.length,1);assert.equal(model.drawings.undoStack.length,1);
});
for(const kind of ['create','edit'])test(`owner ${kind} fallback still rolls back its own transaction`,t=>{
 const {model,make}=fixture(t),a=make();if(kind==='edit'){create(a);a.controller.up(1);a.controller.setTool('select');const p=a.controller.layout().toScreen(model.drawings.items[0].points[0],'price');a.controller.down(2,p.x,p.y);a.controller.move(2,p.x+15,p.y+10);}else create(a);const before=model.drawings.transaction.slice(),history=model.drawings.undoStack.slice();a.fallback('test');assert.deepEqual(model.drawings.items,before);assert.equal(model.drawings.transaction,null);assert.deepEqual(model.drawings.undoStack,history);
});
test('fallback host callback can start a new owner without late rollback',t=>{
 const {model,make}=fixture(t),a=make(),b=make();create(a);a.onFallback=()=>create(b);a.fallback('test');assert.equal(b.controller.gesture.kind,'create');assert.equal(model.drawings.items.length,1);assert(model.drawings.transaction);b.controller.up(1);assert.equal(model.drawings.undoStack.length,1);
});
test('stale creator fallback preserves replacement manual transaction',t=>{
 const {model,make}=fixture(t),a=make();create(a);model.drawings.cancel();model.drawings.begin();model.drawings.add({id:'manual',type:'horizontal',points:[{time:1000,price:10}]});const txn=model.drawings.transaction,items=model.drawings.items;a.fallback('test');assert.equal(model.drawings.transaction,txn);assert.equal(model.drawings.items,items);model.drawings.commit();
});
