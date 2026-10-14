import test from 'node:test';
import assert from 'node:assert/strict';
// Import the shipped module unchanged. Only browser DOM/canvas/RAF primitives
// are modeled: this catches real initialization/API wiring, not browser pixels.
test('shipped linked-ranges module initializes, maps ranges, disconnects and cleans up',async t=>{
 const names=['document','window','HTMLElement','Element','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'],saved=names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),frames=new Map(),elements=[],observers=[];let serial=0,paints=0;
 const document={activeElement:null};
 class Element extends EventTarget{
  constructor(){super();this.nodeType=1;this.style={};this.children=[];this.parentNode=null;this.textContent='';this.clientWidth=600;this.clientHeight=320;this.width=0;this.height=0;this.attributes={};this.events=new Map();elements.push(this);}
  get isConnected(){return true;}setAttribute(k,v){this.attributes[k]=String(v);}append(n){n.parentNode=this;this.children.push(n);}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}contains(n){return n===this||this.children.includes(n);}focus(){document.activeElement=this;}getBoundingClientRect(){return{left:0,top:0,width:600,height:320};}setPointerCapture(){}releasePointerCapture(){}
  addEventListener(k,f,o){super.addEventListener(k,f,o);if(!this.events.has(k))this.events.set(k,new Set());this.events.get(k).add(f);}removeEventListener(k,f,o){super.removeEventListener(k,f,o);this.events.get(k)?.delete(f);}getContext(){return new Proxy({measureText:text=>({width:String(text).length*7})},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='fillRect')paints++;}});}
 }
 const nodes=Object.fromEntries(['link',...['a','b'].flatMap(id=>['sync','chart','range'].map(prefix=>prefix+'-'+id))].map(id=>[id,new Element()]));document.getElementById=id=>nodes[id];document.createElement=()=>new Element();const window=new Element();window.devicePixelRatio=1;
 class ResizeObserver{constructor(){this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
 const globals={document,window,HTMLElement:Element,Element,ResizeObserver,requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 for(const k of names)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:globals[k]});
 const send=(target,type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);};const flush=()=>{const pending=[...frames];frames.clear();for(const[,fn]of pending)fn();};
 t.after(()=>{try{send(window,'pagehide');}finally{for(const[k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 await import('../examples/web/linked-ranges.mjs?initialization-regression');
 assert.equal(nodes['chart-a'].children.length,1);assert.equal(nodes['chart-b'].children.length,1);assert.equal(observers.length,2);flush();assert.ok(paints>0);
 send(nodes['sync-a'],'click');assert.match(nodes['range-b'].textContent,/Requested 2026-01-05T09:00:00.000Z to 2026-01-05T10:59:00.000Z/);assert.match(nodes['range-b'].textContent,/effective 2026-01-05T09:00:00.000Z to 2026-01-05T10:55:00.000Z; clipped/);
 const canvas=nodes['chart-a'].children[0];send(canvas,'keydown',{key:'+'});flush();assert.match(nodes['range-b'].textContent,/applied/);send(nodes.link,'click');assert.equal(nodes['range-b'].textContent,'No received range.');
 send(window,'pagehide');assert.equal(nodes['chart-a'].children.length,0);assert.equal(nodes['chart-b'].children.length,0);assert.equal(frames.size,0);assert.ok(observers.every(o=>o.disconnected));assert.equal(elements.reduce((n,e)=>n+[...e.events.values()].reduce((a,x)=>a+x.size,0),0),0);
});
