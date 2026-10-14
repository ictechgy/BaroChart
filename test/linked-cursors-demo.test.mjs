import test from 'node:test';
import assert from 'node:assert/strict';
// Import the shipped module unchanged. Only browser DOM/canvas/RAF primitives
// are modeled: this catches real initialization/API wiring, not browser pixels.
test('shipped linked-cursors module creates both charts, maps gaps and disposes on pagehide',async t=>{
 const names=['document','window','HTMLElement','Element','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'],saved=names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map(),elements=[],observers=[];let serial=0,paints=0;
 const document={activeElement:null};
 class Element extends EventTarget{
  constructor(){super();this.nodeType=1;this.style={};this.children=[];this.parentNode=null;this.textContent='';this.clientWidth=600;this.clientHeight=320;this.width=0;this.height=0;this.attributes={};this.events=new Map();elements.push(this);}
  get isConnected(){return true;}setAttribute(k,v){this.attributes[k]=String(v);}append(n){n.parentNode=this;this.children.push(n);}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}contains(n){return n===this||this.children.includes(n);}focus(){document.activeElement=this;}getBoundingClientRect(){return{left:0,top:0,width:600,height:320};}setPointerCapture(){}releasePointerCapture(){}
  addEventListener(k,f,o){super.addEventListener(k,f,o);if(!this.events.has(k))this.events.set(k,new Set());this.events.get(k).add(f);}removeEventListener(k,f,o){super.removeEventListener(k,f,o);this.events.get(k)?.delete(f);}getContext(){return new Proxy({measureText:text=>({width:String(text).length*7})},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='fillRect')paints++;}});}
 }
 const nodes=Object.fromEntries(['policy','link',...['a','b'].flatMap(id=>['explore','read','chart','cursor','values','live'].map(prefix=>prefix+'-'+id))].map(id=>[id,new Element()]));nodes.policy.value='exact';document.getElementById=id=>nodes[id];document.createElement=()=>new Element();const window=new Element();window.devicePixelRatio=1;
 class ResizeObserver{constructor(){this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
 const globals={document,window,HTMLElement:Element,Element,ResizeObserver,requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 for(const k of names)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:globals[k]});
 const send=(target,type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);};const flush=()=>{const pending=[...frames];frames.clear();for(const[,fn]of pending)fn();};
 t.after(()=>{try{send(window,'pagehide');}finally{for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 await import('../examples/web/linked-cursors.mjs?initialization-regression');
 assert.equal(nodes['chart-a'].children.length,1);assert.equal(nodes['chart-b'].children.length,1);assert.equal(observers.length,2);flush();assert.ok(paints>0);
 const canvas=nodes['chart-a'].children[0];send(nodes['explore-a'],'click');send(canvas,'keydown',{key:'Home'});assert.match(nodes['cursor-b'].textContent,/matched 2026-01-05T09:00:00.000Z/);
 send(canvas,'keydown',{key:'ArrowRight'});assert.match(nodes['cursor-b'].textContent,/Requested 2026-01-05T09:01:00.000Z; matched none/);
 nodes.policy.value='at-or-before';send(nodes.policy,'change');send(canvas,'keydown',{key:'Home'});for(let i=0;i<35;i++)send(canvas,'keydown',{key:'ArrowRight'});assert.match(nodes['cursor-b'].textContent,/Requested 2026-01-05T09:35:00.000Z; matched 2026-01-05T09:25:00.000Z/);
 send(nodes['read-a'],'click');assert.match(nodes['values-a'].textContent,/Bar 36;/);assert.match(nodes['values-a'].textContent,/volume 135\./);assert.match(nodes['values-a'].textContent,/Current plotted values, cutoff 89;/);send(nodes.link,'click');assert.equal(nodes['cursor-b'].textContent,'No linked cursor.');
 const retained=['a','b'].map(id=>nodes['chart-'+id].children[0]),listenerCount=()=>elements.reduce((n,e)=>n+[...e.events.values()].reduce((a,s)=>a+s.size,0),0),beforeListeners=listenerCount();
 for(let round=0;round<2;round++){send(window,'pagehide',{persisted:true});assert.deepEqual(['a','b'].map(id=>nodes['chart-'+id].children[0]),retained);assert.ok(observers.every(o=>!o.disconnected));send(window,'pageshow',{persisted:true});assert.equal(listenerCount(),beforeListeners);assert.equal(observers.length,2);flush();}
 send(nodes.link,'click');assert.match(nodes.link.textContent,/Disconnect/);
 // A synchronous state callback can permanently leave during restoration.
 const terminate=()=>send(window,'pagehide',{persisted:false});retained[0].addEventListener('aster:state',terminate,{once:true});send(window,'pageshow',{persisted:true});retained[0].removeEventListener('aster:state',terminate);
 send(window,'pageshow',{persisted:true});
 send(window,'pagehide');assert.equal(nodes['chart-a'].children.length,0);assert.equal(nodes['chart-b'].children.length,0);assert.equal(frames.size,0);assert.ok(observers.every(o=>o.disconnected));assert.equal(elements.reduce((n,e)=>n+[...e.events.values()].reduce((a,s)=>a+s.size,0),0),0);
});
