import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel, ChartAPI} from '../src/core/index.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';

// Web keyboard routing regression. Node-only fake DOM integration: synchronous
// callbacks, text writes and explicit resource ownership. This is NOT actual
// browser focus, keyboard default behavior, accessibility-tree, screen-reader,
// rendering, pixel, or long-term heap/leak coverage. RAF callbacks stay queued;
// invalidation-only checks do not claim that drawing dirty indicators is free.
const bars = Array.from({length: 6}, (_, i) => ({
  time: 1700000000000 + [0, 1, 3, 4, 8, 9][i] * 60000,
  open: 20 + i, high: 23 + i, low: 19 + i, close: 21 + i, volume: 100 + i,
}));

function fixture(t) {
  const keys = ['document', 'HTMLElement', 'Element', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const frames = new Map(), charts = [], models = [], elements = [], renderers = [], observers = [];
  let serial = 0;
  const document = {activeElement: null};
  class Element extends EventTarget {
    constructor(tag = 'div') {
      super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.style = {};
      this.attributes = new Map(); this.events = new Map(); this.children = [];
      this.parentNode = null; this.connected = false; this.removed = false;
      this._text = ''; this.writes = []; this.width = 0; this.height = 0;
      this.clientWidth = 400; this.clientHeight = 240; elements.push(this);
    }
    get isConnected() {return this.connected || Boolean(this.parentNode?.isConnected);}
    get textContent() {return this._text;}
    set textContent(value) {this._text = String(value); this.writes.push(this._text); this.onText?.(this._text);}
    set innerHTML(_) {assert.fail('Explorer output must use textContent, never innerHTML');}
    get innerHTML() {assert.fail('Explorer output must not read innerHTML');}
    setAttribute(name, value) {this.attributes.set(name, String(value));}
    getAttribute(name) {return this.attributes.get(name) ?? null;}
    addEventListener(type, fn, options) {
      super.addEventListener(type, fn, options);
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(fn);
    }
    removeEventListener(type, fn, options) {super.removeEventListener(type, fn, options); this.events.get(type)?.delete(fn);}
    listenerCount(type) {return type ? this.events.get(type)?.size ?? 0 : [...this.events.values()].reduce((n, set) => n + set.size, 0);}
    append(node) {node.remove(); node.removed = false; node.parentNode = this; this.children.push(node);}
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
      this.parentNode = null; this.connected = false; this.removed = true;
    }
    replaceWith(node) {const parent = this.parentNode; this.remove(); parent?.append(node);}
    cloneNode() {
      const node = new Element(this.tagName);
      node.attributes = new Map(this.attributes); node.tabIndex = this.tabIndex;
      node.style = {...this.style}; return node;
    }
    contains(node) {return node === this || this.children.some(child => child.contains(node));}
    focus() {document.activeElement = this;}
    getBoundingClientRect() {return {left: 0, top: 0, width: 400, height: 240};}
    setPointerCapture(id) {this.capture = id;}
    getContext() {return {};}
  }
  class ResizeObserver {
    constructor(callback) {this.callback = callback; this.disconnected = false; observers.push(this);}
    observe() {if (this.failObserve) throw new Error('observer setup failed');}
    disconnect() {this.disconnected = true;}
  }
  document.createElement = tag => new Element(tag);
  const globals = {
    document, HTMLElement: Element, Element, ResizeObserver,
    requestAnimationFrame: callback => {const id = ++serial; frames.set(id, callback); return id;},
    cancelAnimationFrame: id => frames.delete(id),
  };
  for (const key of keys) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: globals[key]});
  const root = new Element(); root.connected = true;
  const node = (tag = 'div') => {const element = new Element(tag); root.append(element); return element;};
  const readout = node(), live = node(), controls = [node('button'), node('button')];
  const outputs = {readout, live, controls};
  const makeModel = (input = bars) => {
    const model = new ChartModel(), api = new ChartAPI(model); models.push(model);
    api.setData(input); api.addSeries({id: 'price', type: 'line', panel: 'price'});
    return model;
  };
  const create = (options = {}, model = makeModel()) => {
    const container = node(), baselineListeners = model.store.listeners.size;
    const renderer = {kind: 'test', disposed: 0, render() {}, dispose() {this.disposed++;}};
    renderers.push(renderer);
    const chart = new CanvasChart(container, model, {
      dpr: () => 1, observeResize: false, layerCaching: false,
      rendererFactory: () => renderer, dataExplorer: outputs, ...options,
    });
    charts.push(chart); return {chart, model, renderer, container, baselineListeners};
  };
  t.after(() => {
    try {for (const chart of charts) chart.destroy(); for (const model of models) model.dispose();}
    finally {
      frames.clear();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  });
  return {create, makeModel, node, readout, live, controls, outputs, root, document, Element,
    ResizeObserver, elements, renderers, observers, frames};
}

function event(node, type, fields = {}) {
  const e = new Event(type, {cancelable: true, bubbles: true});
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(e, name, {configurable: true, value});
  node.dispatchEvent(e); return e;
}
const key = (chart, value, fields = {}) => event(chart.canvas, 'keydown', {key: value, ...fields});

function snapshot(f){return {view:{...f.model.view},follow:f.model.follow,items:f.model.drawings.items,selected:f.model.drawings.selected,undo:f.model.drawings.undoStack.slice(),redo:f.model.drawings.redoStack.slice()};}
function chartFixture(t){const env=fixture(t),f=env.create();f.model.store.setData(Array.from({length:300},(_,i)=>({time:1000+i*1000,open:10,high:12,low:9,close:11,volume:1})));f.model.setVisibleRange(100,150);f.chart.canvas.focus();return {...env,...f};}
for(const modifiers of [{ctrlKey:true},{metaKey:true},{ctrlKey:true,shiftKey:true},{metaKey:true,shiftKey:true}])test('browser shortcuts pass through '+JSON.stringify(modifiers),t=>{
 const f=chartFixture(t);for(const k of ['+','=','-','_','Home','End','PageUp','PageDown','Delete','Backspace','Escape','a']){const before=snapshot(f),frames=f.frames.size,e=key(f.chart,k,modifiers);assert.equal(e.defaultPrevented,false,k);assert.deepEqual(snapshot(f),before,k);assert.equal(f.frames.size,frames);}
});
for(const modifiers of [{altKey:true},{altKey:true,ctrlKey:true},{altKey:true,metaKey:true},{altKey:true,ctrlKey:true,shiftKey:true}])test('Alt combinations remain host-owned '+JSON.stringify(modifiers),t=>{
 const f=chartFixture(t);for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','Delete','z','y','Escape']){const before=snapshot(f),e=key(f.chart,k,modifiers);assert.equal(e.defaultPrevented,false,k);assert.deepEqual(snapshot(f),before,k);}
});
test('plain zoom and Ctrl/Cmd arrows retain chart routing and selection-independent pan',t=>{
 const f=chartFixture(t);for(const modifiers of [{ctrlKey:true},{metaKey:true}])for(const [k,view] of [['ArrowLeft',{from:95,to:145}],['ArrowRight',{from:105,to:155}],['ArrowUp',{from:102.5,to:147.5}],['ArrowDown',{from:97.5,to:152.5}]]){f.model.setVisibleRange(100,150);const e=key(f.chart,k,modifiers);assert.equal(e.defaultPrevented,true);assert.deepEqual(f.model.view,view);}
 f.model.setVisibleRange(100,150);assert.equal(key(f.chart,'+').defaultPrevented,true);assert.deepEqual(f.model.view,{from:105,to:145});
 const id=f.model.drawings.add({type:'horizontal',panel:'price',points:[{time:120000,price:11}]});const original=f.model.drawings.items[0];assert.equal(key(f.chart,'ArrowDown',{shiftKey:true}).defaultPrevented,true);assert.notDeepEqual(f.model.drawings.items[0].points,original.points);
 const edited=f.model.drawings.items[0];key(f.chart,'ArrowRight',{ctrlKey:true});assert.equal(f.model.drawings.items[0],edited);assert.equal(f.model.drawings.selected,id);
});
for(const modifier of ['ctrlKey','metaKey'])test(modifier+' undo/redo bindings remain active',t=>{
 const f=chartFixture(t);f.model.drawings.add({type:'horizontal',panel:'price',points:[{time:120000,price:11}]});
 assert.equal(key(f.chart,'z',{[modifier]:true}).defaultPrevented,true);assert.equal(f.model.drawings.items.length,0);
 assert.equal(key(f.chart,'Z',{[modifier]:true,shiftKey:true}).defaultPrevented,true);assert.equal(f.model.drawings.items.length,1);
 key(f.chart,'z',{[modifier]:true});assert.equal(key(f.chart,'y',{[modifier]:true}).defaultPrevented,true);assert.equal(f.model.drawings.items.length,1);
});
test('editable targets, composition and prior preventDefault never enter controller',t=>{
 const f=chartFixture(t);let calls=0;f.chart.controller.key=()=>calls++;
 for(const target of [f.node('input'),f.node('textarea'),f.node('div')]){target.contentEditable='true';const e=event(f.chart.canvas,'keydown',{key:'ArrowLeft',target,ctrlKey:true});assert.equal(e.defaultPrevented,false);}
 assert.equal(key(f.chart,'ArrowLeft',{isComposing:true}).defaultPrevented,false);
 const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'key',{value:'ArrowLeft'});e.preventDefault();f.chart.canvas.dispatchEvent(e);assert.equal(calls,0);
});
test('exploration mode preserves its existing strict modifier filter and plain navigation',t=>{
 const f=chartFixture(t);f.chart.setDataExploration(true);let calls=0;f.chart.controller.key=()=>calls++;const before=f.chart.dataExploration;
 for(const fields of [{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true,ctrlKey:true}])for(const k of ['ArrowLeft','z','+','Escape']){assert.equal(key(f.chart,k,fields).defaultPrevented,false);assert.deepEqual(f.chart.dataExploration,before);}
 assert.equal(key(f.chart,'ArrowLeft').defaultPrevented,true);assert.equal(f.chart.dataExploration.index,before.index-1);assert.equal(calls,0);
});
