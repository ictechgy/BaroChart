import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDrawingPanel,attachChartToolbar} from '../src/renderers/canvas.mjs';
import {isHoverStateEvent,notifyChartState} from '../src/renderers/state-notification.mjs';
import {fixture,event,pointer,button} from './helpers/customization-dom.mjs';

// Real chart/control modules with modeled DOM and queued RAF. These assertions
// count synchronous work, not browser layout, paint, accessibility or FPS.
function mount(t,n=1000){
 const h=fixture(t),f=h.create({rendererFactory:()=>({render(){},dispose(){}})});
 f.model.drawings.load(JSON.stringify({schema:'aster.drawings',version:1,drawings:Array.from({length:n},(_,i)=>({id:'d'+i,type:'horizontal',panel:'price',points:[{time:1000,price:11}]}))}));
 const panelHost=h.node(),toolbarHost=h.node(),panel=attachDrawingPanel(panelHost,f.chart),toolbar=attachChartToolbar(toolbarHost,f.chart);
 return{...f,h,panelHost,toolbarHost,panel,toolbar};
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
function idReads(store,fn){const own=Object.getOwnPropertyDescriptor,known=new WeakSet(store.items);let count=0;Object.getOwnPropertyDescriptor=(o,k)=>{if(known.has(o)&&k==='id')count++;return own(o,k);};try{fn();}finally{Object.getOwnPropertyDescriptor=own;}return count;}
function watchWrites(root){const counts={attributes:0,styles:0,disabled:0,text:0,append:0};for(const n of descendants(root)){n.onAttribute=()=>counts.attributes++;n.onDisable=()=>counts.disabled++;n.onText=()=>counts.text++;n.onAppend=()=>counts.append++;n.style=new Proxy(n.style,{set(target,key,value){counts.styles++;target[key]=value;return true;}});}return counts;}

test('idle pointer hover still publishes each state event but skips all optional-control source scans and writes',t=>{
 const f=mount(t),writes=watchWrites(f.toolbarHost),panelWrites=watchWrites(f.panelHost),focused=button(f.toolbarHost,'rectangle');focused.focus();let states=0;f.container.addEventListener('aster:state',()=>states++);
 const reads=idReads(f.model.drawings,()=>{for(let i=0;i<100;i++)pointer(f.chart,'pointermove',1,200+i%100,100);});
 assert.equal(states,100);assert.equal(reads,0);assert.deepEqual(writes,{attributes:0,styles:0,disabled:0,text:0,append:0});assert.deepEqual(panelWrites,writes);assert.equal(f.h.frames.size,1);assert.equal(f.h.document.activeElement,focused);
});

for(const kind of ['all','drawings','unknown'])test('non-hover invalidation '+kind+' retains full validation and toolbar refresh',t=>{
 const f=mount(t),writes=watchWrites(f.toolbarHost);assert.equal(idReads(f.model.drawings,()=>f.chart.invalidate(kind)),2000);assert.equal(writes.attributes,5);assert.equal(writes.styles,10);assert.equal(writes.disabled,9);assert.equal(writes.append,1);
});

test('manual events and forged hover-looking fields cannot suppress refresh',t=>{
 const f=mount(t);for(const fields of [{},{kind:'hover'},{detail:{kind:'hover'}}])assert.equal(idReads(f.model.drawings,()=>event(f.chart.canvas,'aster:state',fields)),2000);
 const forged=new Event('aster:state',{bubbles:true});Object.defineProperty(forged,'kind',{get(){throw new Error('do not inspect untrusted fields');}});assert.equal(idReads(f.model.drawings,()=>f.chart.canvas.dispatchEvent(forged)),2000);
});

test('hover classification is exact-canvas and ends after dispatch, including captured-event replay',t=>{
 const f=mount(t),other=f.h.node('canvas');let captured,inside=false;
 f.chart.canvas.addEventListener('aster:state',e=>{if(!captured){captured=e;inside=isHoverStateEvent(e,f.chart.canvas);assert.equal(isHoverStateEvent(e,other),false);}});
 assert.equal(idReads(f.model.drawings,()=>f.chart.invalidate('hover')),0);assert.equal(inside,true);assert.equal(isHoverStateEvent(captured,f.chart.canvas),false);
 button(f.toolbarHost,'select').setAttribute('aria-pressed','false');assert.equal(idReads(f.model.drawings,()=>f.chart.canvas.dispatchEvent(captured)),2000);assert.equal(button(f.toolbarHost,'select').getAttribute('aria-pressed'),'true');
});

test('hover classification retires in finally when dispatch throws',()=>{
 let captured;const canvas={dispatchEvent(e){captured=e;assert.equal(isHoverStateEvent(e,canvas),true);throw new Error('dispatch failed');}};assert.throws(()=>notifyChartState(canvas,'hover'),/dispatch failed/);assert.equal(isHoverStateEvent(captured,canvas),false);
});

test('normal API drawing edits and undo/redo update panel and toolbar synchronously',t=>{
 const f=mount(t,2),count=descendants(f.panelHost).find(n=>n.tagName==='P');f.chart.api.addDrawing({id:'new',type:'horizontal',panel:'price',points:[{time:2000,price:10}]});assert.match(count.textContent,/3 drawings/);assert.equal(button(f.toolbarHost,'undo').disabled,false);f.chart.api.undo();assert.match(count.textContent,/2 drawings/);assert.equal(button(f.toolbarHost,'redo').disabled,false);f.chart.api.redo();assert.match(count.textContent,/3 drawings/);f.chart.api.setTool('rectangle');assert.equal(button(f.toolbarHost,'rectangle').getAttribute('aria-pressed'),'true');
});

test('hover skips no authoritative validation: stale selected objects and off-page same-array edits still reject',t=>{
 const f=mount(t),store=f.model.drawings;f.panel.selection.select('d0');f.panel.refresh();store.edit('d0',{text:'external replacement'});const items=store.items,history=store.undoStack,copy=items.slice();f.chart.invalidate('hover');assert.throws(()=>f.panel.selection.deleteSelected(),e=>e.code==='STALE_SELECTION');assert.equal(store.items,items);assert.equal(store.undoStack,history);assert.deepEqual(store.items,copy);
 const old=items[999];items[999]=Object.freeze({...old,id:'d1'});try{f.chart.invalidate('hover');assert.throws(()=>f.panel.refresh(),/Duplicate drawing id/);assert.throws(()=>f.panel.selection.select('d0'),/Duplicate drawing id/);}finally{items[999]=old;}
});

test('nested normal invalidation from a public hover listener is not skipped',t=>{
 const f=mount(t,2);let once=false;f.chart.canvas.addEventListener('aster:state',()=>{if(!once){once=true;f.chart.api.setTool('rectangle');}});f.chart.invalidate('hover');assert.equal(button(f.toolbarHost,'rectangle').getAttribute('aria-pressed'),'true');assert.equal(button(f.toolbarHost,'select').getAttribute('aria-pressed'),'false');
});
