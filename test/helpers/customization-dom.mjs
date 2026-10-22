import assert from 'node:assert/strict';
import {ChartModel} from '../../src/core/index.mjs';
import {CanvasChart} from '../../src/renderers/canvas.mjs';
// Modeled DOM, queued RAF, and synchronous hooks, not real browser rendering,
// touch default actions, accessibility tree, screen readers or focus certification.
export function fixture(t){
 const keys=['document','window','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'],saved=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]),frames=new Map(),charts=[],models=[];let serial=0;
 const document={activeElement:null};
 class Element{
  constructor(tag='div'){this.nodeType=1;this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.events=new Map();this.attributes=new Map();this.style={};this.dataset={};this.parentNode=null;this.clientWidth=800;this.clientHeight=500;this.width=this.height=0;this.value='';this.checked=false;this._text='';this.captures=new Set();}
  get isConnected(){return this===document.body||!!this.parentNode?.isConnected;}
  get disabled(){return this._disabled??false;}set disabled(value){this._disabled=!!value;if(value&&document.activeElement===this)document.activeElement=null;this.onDisable?.(value);}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}set textContent(value){this.replaceChildren();this._text=String(value);this.onText?.(value);}
  set innerHTML(_){assert.fail('Use textContent');}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);this.onAppend?.(node);}}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes);}
  insertBefore(node,before){if(node===before)return;if(before===null){this.append(node);return;}assert(this.children.includes(before));node.remove();node.parentNode=this;this.children.splice(this.children.indexOf(before),0,node);}
  remove(){if(this.contains(document.activeElement))document.activeElement=null;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;this.onRemove?.();}
  contains(node){return node===this||this.children.some(x=>x.contains(node));}
  replaceWith(node){const parent=this.parentNode;this.remove();parent?.append(node);}
  cloneNode(){const node=new Element(this.tagName);node.attributes=new Map(this.attributes);node.style={...this.style};node.tabIndex=this.tabIndex;return node;}
  setAttribute(key,value){this.attributes.set(key,String(value));this.onAttribute?.(key,value);}getAttribute(key){return this.attributes.get(key)??null;}
  addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
  dispatchEvent(event){if(!event.target)Object.defineProperty(event,'target',{configurable:true,value:this});for(const fn of [...this.events.get(event.type)??[]])if(this.events.get(event.type)?.has(fn))fn(event);this['on'+event.type]?.(event);if(event.bubbles&&!event.cancelBubble)this.parentNode?.dispatchEvent(event);return !event.defaultPrevented;}
  focus(){if(this.disabled)return;document.activeElement=this;this.onFocus?.();}
  setPointerCapture(id){this.captures.add(id);this.onCapture?.(id);}releasePointerCapture(id){this.captures.delete(id);this.onRelease?.(id);}
  getBoundingClientRect(){return{left:0,top:0,width:this.clientWidth,height:this.clientHeight};}getContext(){return{};}
 }
 document.createElement=tag=>new Element(tag);document.createElementNS=(_namespace,tag)=>new Element(tag);document.createTextNode=text=>{const n=new Element('#text');n.nodeType=3;n.textContent=text;return n;};document.body=new Element('body');
 const window=new Element('window');window.devicePixelRatio=1;
 const values={document,window,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:values[key]});
 const node=(tag='div')=>{const n=new Element(tag);document.body.append(n);return n;};
 const makeModel=()=>{const model=new ChartModel();models.push(model);model.store.setData(Array.from({length:300},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));model.addSeries({id:'price',type:'candles',panel:'price'});model.setVisibleRange(100,150);return model;};
 const create=(options={},model=makeModel())=>{const container=node(),chart=new CanvasChart(container,model,{observeResize:false,dpr:()=>1,layerCaching:false,...options});charts.push(chart);return{chart,model,container};};
 t.after(()=>{try{for(const chart of charts)chart.destroy();for(const model of models)model.dispose();}finally{for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}});
 return{document,window,node,create,makeModel,Element,frames,charts,models};
}
export function event(node,type,fields={}){const e=new Event(type,{cancelable:true,bubbles:true});for(const[key,value]of Object.entries(fields))Object.defineProperty(e,key,{configurable:true,value});node.dispatchEvent(e);return e;}
export const pointer=(chart,type='pointerdown',id=1,x=200,y=100)=>event(chart.canvas,type,{button:0,pointerId:id,clientX:x,clientY:y});
export const wheel=chart=>event(chart.canvas,'wheel',{deltaY:100,deltaMode:0,clientX:200,clientY:100});
export const key=(chart,value='ArrowLeft')=>event(chart.canvas,'keydown',{key:value});
export function button(container,id){const walk=n=>n.getAttribute('data-chart-control')===id?n:n.children.map(walk).find(Boolean);return walk(container);}
