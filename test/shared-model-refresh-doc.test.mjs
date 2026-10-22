// Execute the documented host recipe, with modeled event bubbling/no-op Canvas.
// This does not launch a browser or validate native DOM/input/raster behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BarStore,ChartModel} from '../src/core/index.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
import {modeledChartDOM} from './helpers/shared-model-dom.mjs';
const doc=await readFile(new URL('../docs/SHARED-MODEL-REFRESH.md',import.meta.url),'utf8');
function block(name){const marker=`<!-- shared-refresh-${name} -->`,at=doc.indexOf(marker);assert.ok(at>=0,marker);return doc.slice(at+marker.length).match(/```js\n([\s\S]*?)```/)[1];}
const relaySource=block('listener');
const install=(f,source=relaySource)=>Function('authority','mirror','authorityHost',source+'\nreturn stopMirroring;')(f.authority,f.mirror,f.authorityHost);
function fixture(t,{nested=false,caching=true}={}) {
 const dom=modeledChartDOM(),prototype=Object.getPrototypeOf(dom.root),dispatch=prototype.dispatchEvent;
 // Deliberate deterministic bubbling model: preserve originating target as an
 // event crosses parent nodes. No real DOM event-order claim.
 prototype.dispatchEvent=function(event){const result=dispatch.call(this,event);if(event.bubbles&&this.parentNode){const next=new Event(event.type,{bubbles:true});Object.defineProperty(next,'target',{value:event.target});this.parentNode.dispatchEvent(next);}return result;};
 prototype.cloneNode=function(){const next=document.createElement(this.tagName);next.style={...this.style};next.tabIndex=this.tabIndex;return next;};
 prototype.replaceWith=function(next){const parent=this.parentNode,index=parent.children.indexOf(this);parent.children[index]=next;next.parentNode=parent;this.parentNode=null;};
 const authorityHost=document.createElement('section'),mirrorHost=document.createElement('section');dom.root.append(authorityHost);(nested?authorityHost:dom.root).append(mirrorHost);
 const model=new ChartModel({store:new BarStore(Array.from({length:20},(_,i)=>({time:1700000000000+i*60000,open:40,high:80,low:10,close:60,volume:1}))),visibleBars:20,panels:[{id:'price',range:[0,100],padding:0}]});
 model.addSeries({id:'p',type:'candles',panel:'price'});
 const options={dpr:()=>1,observeResize:false,layerCaching:caching,rasterCaching:'never'},authority=new CanvasChart(authorityHost,model,options),mirror=new CanvasChart(mirrorHost,model,{...options,interactive:false});
 const stops=[];t.after(()=>{for(const stop of stops)stop();authority.destroy();mirror.destroy();model.dispose();assert.equal(dom.frames.size,0);assert.equal(model.store.listeners.size,0);dom.restore();});
 const f={dom,model,authority,mirror,authorityHost,mirrorHost,connect(source){const stop=install(f,source);stops.push(stop);return stop;}};return f;
}
const begin=f=>{f.authority.api.setTool('trendline');f.authority.controller.down(1,110,110);f.authority.controller.move(1,220,160);};
// Compare complete commands, including drawing/selection and shared hover.
const scene=chart=>chart.lastScene.commands;
const sameFrames=f=>assert.deepEqual(scene(f.mirror),scene(f.authority),'shared frame refresh oracle');

for(const caching of [false,true])test(`manual command invalidation repairs documented stale sibling frame, cache=${caching}`,async t=>{
 const f=fixture(t,{caching});await f.dom.settle();const old=f.mirror.lastScene;
 f.authority.api.addDrawing({id:'a',type:'horizontal',points:[{time:1700000000000,price:50}]});await f.dom.settle();
 assert.equal(f.model.drawings.items.length,1);assert.equal(f.mirror.lastScene,old);assert.notDeepEqual(scene(f.authority),scene(f.mirror));
 f.mirror.invalidate();await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.undoStack.length,1);
});
for(const caching of [false,true])test(`literal relay covers preview, commit, undo/redo, visibility and cancel with one history, cache=${caching}`,async t=>{
 const f=fixture(t,{caching});f.connect();await f.dom.settle();begin(f);await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.undoStack.length,0);assert.ok(f.model.drawings.transaction);
 f.authority.controller.up(1);await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.undoStack.length,1);
 f.authority.api.undo();await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.items.length,0);
 f.authority.api.redo();await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.items.length,1);
 const id=f.model.drawings.items[0].id;f.authority.api.setDrawingVisibility(id,false);await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.items[0].visible,false);
 f.authority.api.undo();begin(f);await f.dom.settle();const history=f.model.drawings.undoStack.length;f.authority.controller.cancel();await f.dom.settle();sameFrames(f);assert.equal(f.model.drawings.items.length,1);assert.equal(f.model.drawings.undoStack.length,history);
});

test('nested mirror events never echo or create history; multiple source events share one pending frame',async t=>{
 const f=fixture(t,{nested:true});f.connect();await f.dom.settle();let mirrorEvents=0;f.mirror.canvas.addEventListener('aster:state',()=>{assert.ok(++mirrorEvents<10,'no echo oracle');});
 f.authority.invalidate();f.authority.invalidate();assert.equal(mirrorEvents,2);assert.equal(f.dom.frames.size,2);await f.dom.settle();assert.equal(f.model.drawings.undoStack.length,0);sameFrames(f);
});

test('current-canvas filter survives modeled fallback and ignores stale canvas events',async t=>{
 const f=fixture(t);f.connect();await f.dom.settle();const old=f.authority.canvas;begin(f);await f.dom.settle();f.authority.fallback('modeled context loss');await f.dom.settle();assert.notEqual(f.authority.canvas,old);assert.equal(f.model.drawings.items.length,0);sameFrames(f);
 // A stale target delivered to the retained host must not schedule the mirror.
 const event=new Event('aster:state',{bubbles:true});Object.defineProperty(event,'target',{value:old});f.authorityHost.dispatchEvent(event);assert.equal(f.dom.frames.size,0);
 f.authority.api.addDrawing({type:'horizontal',points:[{time:1700000000000,price:70}]});await f.dom.settle();sameFrames(f);
});

test('literal teardown removes listener before canceled preview and refreshes surviving mirror',async t=>{
 const f=fixture(t),stopMirroring=f.connect();await f.dom.settle();begin(f);await f.dom.settle();assert.equal(f.model.drawings.items.length,1);
 const source=block('teardown'),survivor=source.slice(0,source.indexOf('// Later,'));Function('stopMirroring','authority','mirror',survivor)(stopMirroring,f.authority,f.mirror);
 await f.dom.settle();assert.equal(f.model.drawings.items.length,0);assert.equal(f.model.drawings.undoStack.length,0);assert.equal(f.mirror.lastError,null);
 f.authority.canvas.dispatchEvent(new Event('aster:state',{bubbles:true}));assert.equal(f.dom.frames.size,0);
 // Remaining statements in the exact documentation snippet are also executable.
 Function('mirror','model',source.slice(source.indexOf('// Later,')))(f.mirror,f.model);
});

test('detaching relay leaves future source commands manual and permits explicit recovery',async t=>{
 const f=fixture(t),stop=f.connect();await f.dom.settle();stop();stop();const prior=f.mirror.lastScene;
 f.authority.api.addDrawing({type:'horizontal',points:[{time:1700000000000,price:70}]});await f.dom.settle();assert.equal(f.mirror.lastScene,prior);
 f.mirror.invalidate();await f.dom.settle();sameFrames(f);
});

test('intentional omitted relay invalidation fails the specific scene oracle',async t=>{
 const f=fixture(t);assert.equal(relaySource.split('if (event.target === authority.canvas) mirror.invalidate();').length,2);
 f.connect(relaySource.replace('if (event.target === authority.canvas) mirror.invalidate();','if (event.target === authority.canvas) void 0;'));await f.dom.settle();begin(f);await f.dom.settle();
 let failure;assert.throws(()=>sameFrames(f),error=>{failure=error;return error instanceof assert.AssertionError&&error.message.includes('shared frame refresh oracle');});t.diagnostic(failure.stack);
});

test('intentional captured-old-canvas listener fails its specific post-fallback scene oracle',async t=>{
 const f=fixture(t);f.connect('const capturedCanvas = authority.canvas;\n'+relaySource.replace('event.target === authority.canvas','event.target === capturedCanvas'));
 await f.dom.settle();f.authority.fallback('modeled replacement');await f.dom.settle();
 f.authority.api.addDrawing({type:'horizontal',points:[{time:1700000000000,price:70}]});await f.dom.settle();
 let failure;assert.throws(()=>sameFrames(f),error=>{failure=error;return error instanceof assert.AssertionError&&error.message.includes('shared frame refresh oracle');});t.diagnostic(failure.stack);
});
