import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let imports=0;
// Real shipped module and core/CanvasChart; fake DOM/canvas is not browser QA.
async function setup(t){
 const names=['document','window','HTMLElement','Element','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'],saved=names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map(),elements=[],observers=[];let serial=0,paints=0;
 const document={activeElement:null};
 class Element extends EventTarget{
  constructor(){super();this.nodeType=1;this.style={};this.children=[];this.parentNode=null;this.textContent='';this.clientWidth=600;this.clientHeight=320;this.width=0;this.height=0;this.attributes={};this.events=new Map();elements.push(this);}
  get isConnected(){return true;}setAttribute(k,v){this.attributes[k]=String(v);}append(n){n.parentNode=this;this.children.push(n);}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}contains(n){return n===this||this.children.includes(n);}focus(){document.activeElement=this;}getBoundingClientRect(){return{left:0,top:0,width:600,height:320};}setPointerCapture(){}releasePointerCapture(){}
  addEventListener(k,f,o){super.addEventListener(k,f,o);if(!this.events.has(k))this.events.set(k,new Set());this.events.get(k).add(f);}removeEventListener(k,f,o){super.removeEventListener(k,f,o);this.events.get(k)?.delete(f);}getContext(){return new Proxy({measureText:text=>({width:String(text).length*7})},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='fillRect')paints++;}});}
 }
 const nodes=Object.fromEntries(['chart','enqueue','drain','pause','resume','cancel','source-change','status','queue-state','counters','budget'].map(id=>[id,new Element()]));document.getElementById=id=>nodes[id];document.createElement=()=>new Element();const window=new Element();window.devicePixelRatio=1;
 class ResizeObserver{constructor(){this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
 const globals={document,window,HTMLElement:Element,Element,ResizeObserver,requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 for(const k of names)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:globals[k]});
 const send=(target,type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);};const flush=()=>{const pending=[...frames];frames.clear();for(const[,fn]of pending)fn();};
 t.after(()=>{try{send(window,'pagehide');}finally{for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 const module=await import('../examples/web/ingestion-queue.mjs?case='+ ++imports);return {...module,nodes,window,send,flush,elements,observers,frames,click:id=>send(nodes[id],'click'),stats:()=>module.chart.api.dataIngestionStats()};
}
function conserved(f){const s=f.stats();assert.equal(s.accepted,s.applied+s.cancelled+s.pendingEvents);assert.match(f.nodes.counters.textContent,/Conservation: true/);return s;}
test('module init and full queue reject whole packets; explicit retry keeps the offered payload and sequence',async t=>{
 const f=await setup(t),api=f.chart.api,version=f.model.store.version,held=f.model.store.columns.close,packets=[],enqueue=api.enqueueDataEvents;
 api.enqueueDataEvents=function(packet){packets.push(packet);return enqueue.call(this,packet);};
 assert.equal(f.nodes.chart.children.length,1);assert.equal(f.model.store.length,32);f.flush();
 for(let i=0;i<4;i++)f.click('enqueue');let s=conserved(f);assert.equal(s.pendingEvents,8);assert.equal(s.accepted,8);assert.equal(s.nextSequence,8);assert.equal(f.model.store.version,version);assert.equal(f.model.store.columns.close,held);
 const pending=api.saveDataIngestion();f.click('enqueue');s=conserved(f);assert.equal(s.pendingEvents,8);assert.equal(s.nextSequence,8);assert.equal(s.rejectedPackets,1);assert.equal(s.rejectedEvents,2);assert.match(f.nodes.status.textContent,/QUEUE_BUDGET/);
 assert.deepEqual(JSON.parse(api.saveDataIngestion()).pending,JSON.parse(pending).pending);
 const offer=packets.at(-1);f.click('drain');f.click('enqueue');assert.equal(packets.at(-1),offer);assert.match(f.nodes.status.textContent,/QUEUE_BUDGET/);assert.equal(conserved(f).pendingEvents,7);
 f.click('drain');f.click('enqueue');assert.equal(packets.at(-1),offer);s=conserved(f);assert.equal(s.pendingEvents,8);assert.equal(s.accepted,10);assert.equal(s.applied,2);assert.equal(s.nextSequence,10);
 for(let i=0;i<8;i++)f.click('drain');s=conserved(f);assert.equal(s.pendingEvents,0);assert.equal(f.model.store.length,37);assert.equal(f.model.store.at(31).volume,141);assert.equal(f.model.store.at(32).volume,10);assert.equal(f.model.store.at(36).volume,0);
});
test('pause retains events; partial drain then cancel preserves sequence and rebuilds producer tail',async t=>{
 const f=await setup(t);f.click('enqueue');f.click('enqueue');f.click('pause');const before=conserved(f);f.click('drain');assert.match(f.nodes.status.textContent,/PAUSED/);f.click('enqueue');assert.match(f.nodes.status.textContent,/PAUSED/);assert.equal(conserved(f).accepted,before.accepted);
 f.click('resume');assert.equal(conserved(f).applied,0);f.click('drain');f.click('drain');f.click('pause');f.click('cancel');let s=conserved(f);assert.equal(s.cancelled,2);assert.equal(s.nextSequence,4);assert.equal(s.state,'paused');assert.equal(s.pendingEvents,0);
 f.click('resume');f.click('enqueue');s=conserved(f);assert.equal(s.nextSequence,6);f.click('drain');f.click('drain');assert.equal(f.model.store.length,34);assert.equal(conserved(f).pendingEvents,0);
});
test('disjoint source change preserves accepted queue; resume is not validation and drain fails atomically',async t=>{
 const f=await setup(t);f.click('enqueue');const pending=JSON.parse(f.chart.api.saveDataIngestion()).pending;f.click('source-change');assert.equal(conserved(f).state,'paused');assert.match(f.nodes['queue-state'].textContent,/SOURCE_CHANGED/);f.click('drain');assert.match(f.nodes.status.textContent,/SOURCE_CHANGED/);
 f.click('resume');assert.equal(conserved(f).pendingEvents,2);assert.equal(conserved(f).applied,0);assert.match(f.nodes.status.textContent,/not applied or discarded/);
 const version=f.model.store.version,bars=Array.from({length:32},(_,i)=>f.model.store.at(i));f.click('drain');assert.match(f.nodes.status.textContent,/DRAIN_FAILED/);assert.equal(f.model.store.version,version);assert.deepEqual(Array.from({length:32},(_,i)=>f.model.store.at(i)),bars);assert.deepEqual(JSON.parse(f.chart.api.saveDataIngestion()).pending,pending);assert.equal(conserved(f).state,'paused');
 f.click('cancel');assert.equal(conserved(f).cancelled,2);assert.equal(conserved(f).nextSequence,2);assert.equal(conserved(f).state,'paused');f.click('resume');f.click('enqueue');f.click('drain');f.click('drain');assert.equal(conserved(f).applied,2);assert.equal(f.model.store.length,33);
});
test('BFCache preserves one chart and queue; final teardown removes handlers/RAF and blocks returning action UI writes',async t=>{
 const f=await setup(t);f.click('enqueue');const canvas=f.chart.canvas;f.send(f.window,'pagehide',{persisted:true});f.send(f.window,'pageshow',{persisted:true});assert.equal(f.chart.canvas,canvas);assert.equal(conserved(f).pendingEvents,2);assert.equal(f.observers.length,1);
 const text=f.nodes.status.textContent;const close=()=>f.send(f.window,'pagehide');canvas.addEventListener('aster:state',close,{once:true});f.click('drain');canvas.removeEventListener('aster:state',close);
 assert.equal(f.model.disposed,true);assert.equal(f.nodes.status.textContent,text);assert.equal(f.nodes.chart.children.length,0);assert.equal(f.frames.size,0);assert.ok(f.observers.every(o=>o.disconnected));assert.equal(f.elements.reduce((n,e)=>n+[...e.events.values()].reduce((a,s)=>a+s.size,0),0),0);
 f.click('enqueue');assert.equal(f.nodes.status.textContent,text);
});
test('shipped controls are explicit labeled buttons with status and no timer/network workflow',async()=>{
 const html=await readFile(new URL('../examples/web/ingestion-queue.html',import.meta.url),'utf8'),source=await readFile(new URL('../examples/web/ingestion-queue.mjs',import.meta.url),'utf8');
 for(const id of ['enqueue','drain','pause','resume','cancel','source-change'])assert.match(html,new RegExp(`<button id="${id}">[^<]+</button>`));
 assert.match(html,/role="status" aria-live="polite"/);assert.match(source,/No timer/);assert.doesNotMatch(source,/setInterval|setTimeout|fetch\(|WebSocket|\.innerHTML/);
});
test('source cap rejects only the next explicit drain atomically and retains its accepted event',async t=>{
 const f=await setup(t);
 for(let i=0;i<32;i++){f.click('enqueue');f.click('drain');f.click('drain');}
 assert.equal(f.model.store.length,64);assert.equal(conserved(f).applied,64);
 f.click('enqueue');f.click('drain');const version=f.model.store.version,columns=f.model.store.columns,bars=Array.from({length:64},(_,i)=>f.model.store.at(i)),pending=JSON.parse(f.chart.api.saveDataIngestion()).pending;
 f.click('drain');const s=conserved(f);assert.equal(s.state,'paused');assert.equal(s.pendingEvents,1);assert.equal(s.applied,65);assert.match(f.nodes.status.textContent,/DRAIN_FAILED/);
 assert.equal(f.model.store.version,version);assert.equal(f.model.store.columns,columns);assert.deepEqual(Array.from({length:64},(_,i)=>f.model.store.at(i)),bars);assert.deepEqual(JSON.parse(f.chart.api.saveDataIngestion()).pending,pending);
 f.click('cancel');assert.equal(conserved(f).cancelled,1);assert.equal(conserved(f).nextSequence,66);
});
test('README and main demo link the shipped queue module; parameter guidance uses supported replacement API',async()=>{
 for(const path of ['../README.md','../README.ko.md','../examples/web/index.html'])assert.match(await readFile(new URL(path,import.meta.url),'utf8'),/ingestion-queue\.html/);
 const html=await readFile(new URL('../examples/web/ingestion-queue.html',import.meta.url),'utf8');assert.match(html,/type="module" src="\.\/ingestion-queue\.mjs"/);
 const docs=await readFile(new URL('../docs/INGESTION.md',import.meta.url),'utf8');assert.match(docs,/api\.setIndicatorParams\(id, params\)/);assert.doesNotMatch(docs,/현재 remove\/add/);
 for(const path of ['../docs/INGESTION-DEMO.md','../docs/INDICATOR-PARAMETERS.md','../docs/ASYNC-INDICATOR-PARAMS.md','../docs/NATIVE-ASYNC-PARAMS.md'])assert.ok((await readFile(new URL(path,import.meta.url))).length>0);
});
