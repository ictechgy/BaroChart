import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/index.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
const observed=[];
const random=seed=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
for(const seed of [7,41,117,991,2026,65537])test(`shared-controller deterministic lifecycle sequence seed ${seed}`,t=>{
 const saved=['document','requestAnimationFrame','cancelAnimationFrame'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map();let serial=0;
 class Canvas extends EventTarget{constructor(){super();this.style={};}setAttribute(){}remove(){}focus(){}setPointerCapture(){}getBoundingClientRect(){return {left:0,top:0};}}
 globalThis.document={createElement:()=>new Canvas()};globalThis.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const model=new ChartModel();model.store.setData(Array.from({length:50},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));model.addSeries({id:'p',type:'candles',panel:'price'});model.fit();const baseListeners=model.store.listeners.size;
 const make=()=>new CanvasChart({append(){},clientWidth:600,clientHeight:400},model,{dpr:()=>1,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})}),charts=[make(),make(),make()],rng=random(seed),trace=[],reached={create:0,edit:0,pinch:0,foreignProtected:0};
 t.after(()=>{for(const c of charts)c.destroy();model.dispose();for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
 const event=(chart,type,id,x,y)=>{const e=new Event(type);Object.assign(e,{pointerId:id,button:0,clientX:x,clientY:y});chart.canvas.dispatchEvent(e);};
 // Start with both a committed editable shape and an overlapping active owner.
 const first=charts[0].controller;first.setTool('trendline');first.down(1,100,100);first.move(1,200,200);first.up(1);first.down(1,120,120);first.move(1,240,210);
 const ops=['move','up','cancel','down','pinch','close','source','create','select','globalCancel','edit','undo','redo','escape'];
 for(let step=0;step<120;step++){
  const who=Math.floor(rng()*3),op=ops[Math.floor(rng()*ops.length)],chart=charts[who],c=chart.controller,id=1+Math.floor(rng()*2),x=80+Math.floor(rng()*350),y=80+Math.floor(rng()*180),oldGesture=c.gesture,before=model.drawings.transaction,foreign=before&&c.gesture?.transaction!==before,items=model.drawings.items,history=structuredClone(model.drawings.undoStack),redo=structuredClone(model.drawings.redoStack),geometry=structuredClone(items);trace.push({step,who,op,id,x,y});
  try{
   if(op==='create')c.setTool('trendline');else if(op==='select')c.setTool('select');else if(op==='globalCancel')c.cancel();else if(op==='undo')c.key('z',{ctrl:true});else if(op==='redo')c.key('z',{ctrl:true,shift:true});else if(op==='escape')c.key('Escape');
   else if(op==='move')event(chart,'pointermove',id,x,y);else if(op==='up')event(chart,'pointerup',id,x,y);else if(op==='cancel')event(chart,'pointercancel',id,x,y);
   else if(op==='down')event(chart,'pointerdown',id,x,y);
   else if(op==='pinch'){event(chart,'pointerdown',1,x,y);event(chart,'pointerdown',2,x+40,y+30);}
   else if(op==='close'){chart.destroy();assert.equal(chart.listeners.length,0);assert.equal(chart.frame,null);charts[who]=make();}
   else if(op==='source'){const last=model.store.at(model.store.length-1);if(step%2)model.store.update(model.store.length-1,{...last,volume:last.volume+1});else model.store.append({...last,time:last.time+1000});}
   else if(op==='edit'){// Explicit tool switch is deliberately global; then target an existing handle.
    c.setTool('select');const d=model.drawings.items[0];if(d){const p=c.layout().toScreen(d.points[0],d.panel,d.axisId);event(chart,'pointerdown',1,p.x,p.y);}
   }
   if(['create','select','globalCancel','undo','redo','escape'].includes(op))assert.equal(model.drawings.transaction,null);
   else if(foreign&&op!=='edit'){assert.equal(model.drawings.transaction,before);assert.equal(model.drawings.items,items);assert.deepEqual(model.drawings.items,geometry);assert.deepEqual(model.drawings.undoStack,history);assert.deepEqual(model.drawings.redoStack,redo);reached.foreignProtected++;}
   if(op==='source')assert.equal(model.drawings.transaction,before);
   const now=charts[who].controller.gesture;if(now!==oldGesture&&['create','edit','pinch'].includes(now?.kind))reached[now.kind]++;
   assert.equal(model.store.listeners.size,baseListeners+3);assert.equal(new Set(model.drawings.items.map(d=>d.id)).size,model.drawings.items.length);
   assert(charts.every(ch=>ch.controller.pointers.size<=2));
   const pending=[...frames];frames.clear();for(const[,fn]of pending)fn();assert(charts.every(ch=>ch.lastScene));
  }catch(error){error.message+=`\nseed=${seed} trace=${JSON.stringify(trace)}`;throw error;}
 }
 const counts=Object.fromEntries(ops.map(op=>[op,trace.filter(x=>x.op===op).length]));assert(Object.values(counts).every(n=>n>0));observed.push({seed,reached});t.diagnostic(JSON.stringify({seed,steps:trace.length,operations:counts,reached}));
 for(const chart of charts)chart.destroy();assert.equal(frames.size,0);assert.equal(model.store.listeners.size,baseListeners);
});

test('seed suite reaches actual create/edit/pinch and foreign ownership boundaries',()=>{assert.equal(observed.length,6);const totals={create:0,edit:0,pinch:0,foreignProtected:0};for(const r of observed)for(const k of Object.keys(totals))totals[k]+=r.reached[k];assert(Object.values(totals).every(n=>n>0),JSON.stringify(totals));});
