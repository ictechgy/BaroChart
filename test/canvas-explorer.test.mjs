import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel, ChartAPI} from '../src/core/index.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';

// Node-only fake DOM integration: target/relatedTarget routing, synchronous
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
function spyReads(chart) {
  const original = chart.api.dataAt.bind(chart.api), queries = [];
  chart.api.dataAt = (...args) => {queries.push(args); return original(...args);};
  return queries;
}
function dirtyStudy(f, effect = () => {}) {
  const {chart, model} = f; let steps = 0, armed = false;
  chart.api.registerIndicator('callback', () => ({
    outputs: ['value'], plotOffsets: {}, create: () => ({
      step(bar, index) {steps++; if (armed) effect(bar, index); return [bar.close];},
      snapshot: () => ({}), restore() {},
    }),
  }));
  chart.api.addIndicator('study', 'callback');
  chart.api.addSeries({id: 'study-line', type: 'line', panel: 'price', indicator: 'study', output: 'value'});
  model.store.update(0, {...bars[0]}); steps = 0; armed = true;
  return {get steps() {return steps;}};
}

for (const configured of [false, true]) test(`data exploration defaults off: configured=${configured}`, t => {
  const h = fixture(t), {chart} = h.create(configured ? {} : {dataExplorer: null});
  assert.deepEqual(chart.dataExploration, {active: false, time: null, index: null, seriesId: null, phase: 'off', text: ''});
  assert.equal(h.readout.textContent, configured ? 'Data exploration off.' : '');
  assert.ok(h.live.writes.every(text => text === ''), 'Construction must not announce an unsolicited value');
  const drawingKeys = []; chart.controller.key = (...args) => drawingKeys.push(args);
  assert.equal(key(chart, 'ArrowLeft').defaultPrevented, true);
  assert.equal(drawingKeys.length, 1);
  if (!configured) {
    assert.throws(() => chart.setDataExploration(true), /Configure/);
    assert.throws(() => chart.readExploration(), /Configure/);
  } else {
    assert.throws(() => chart.setDataExploration(1), /boolean/);
    assert.throws(() => chart.readExploration(), /Enable/);
    assert.equal(chart.dataExploration.active, false);
  }
});

test('navigation selects stored bars and visible series without a data query or viewport change', t => {
  const h = fixture(t), f = h.create(), {chart, model} = f;
  chart.api.addSeries({id: 'hidden', type: 'line', panel: 'price', visible: false});
  chart.api.addSeries({id: 'volume', type: 'line', panel: 'price', source: 'volume'});
  const queries = spyReads(chart), view = {...model.view}, history = model.drawings.undoStack.length;
  chart.controller.pointers.set(7, {x: 10, y: 10}); chart.controller.gesture = {kind: 'wait'};
  chart.setDataExploration(true); chart.canvas.focus();
  assert.equal(chart.controller.pointers.size, 0); assert.equal(chart.controller.gesture, null);
  assert.equal(chart.dataExploration.index, bars.length - 1);
  for (const [pressed, index] of [['Home', 0], ['ArrowLeft', 0], ['ArrowRight', 1], ['ArrowRight', 2], ['End', 5], ['ArrowRight', 5]]) {
    assert.equal(key(chart, pressed).defaultPrevented, true);
    assert.equal(chart.dataExploration.index, index); assert.equal(chart.dataExploration.time, bars[index].time);
  }
  for (const [pressed, id] of [['ArrowDown', 'volume'], ['ArrowDown', 'volume'], ['ArrowUp', 'price'], ['ArrowUp', 'price']]) {
    assert.equal(key(chart, pressed).defaultPrevented, true); assert.equal(chart.dataExploration.seriesId, id);
  }
  assert.equal(queries.length, 0); assert.deepEqual(model.view, view);
  assert.equal(model.drawings.undoStack.length, history);
  const detached = chart.dataExploration; detached.active = false; detached.time = -1;
  assert.equal(chart.dataExploration.active, true); assert.equal(chart.dataExploration.time, bars.at(-1).time);
});

test('only Enter and explicit read perform an exact-time lazy query', t => {
  const h = fixture(t), f = h.create(), {chart} = f, counter = dirtyStudy(f), queries = spyReads(chart);
  chart.setDataExploration(true); chart.canvas.focus(); key(chart, 'Home'); key(chart, 'ArrowRight');
  assert.equal(counter.steps, 0); assert.equal(queries.length, 0);
  assert.equal(key(chart, 'Enter').defaultPrevented, true);
  assert.equal(chart.dataExploration.phase, 'read'); assert.ok(counter.steps > 0);
  assert.deepEqual(queries, [[{time: bars[1].time, match: 'exact'}]]);
  assert.match(h.readout.textContent, /Open 21; high 24; low 20; close 22; volume 101/);
  assert.match(h.readout.textContent, /Current plotted values/);
  assert.equal(h.live.textContent, h.readout.textContent);
  const value = chart.readExploration(); assert.equal(value.phase, 'read'); assert.equal(queries.length, 2);
  assert.equal(key(chart, 'Escape').defaultPrevented, true);
  assert.equal(chart.dataExploration.active, false); assert.match(h.readout.textContent, /off/i);
});

test('active mode isolates unsupported drawing commands while preserving unhandled browser keys', t => {
  const h = fixture(t), {chart} = h.create(), calls = [];
  chart.controller.key = (...args) => calls.push(args); chart.setDataExploration(true); chart.canvas.focus();
  const before = chart.dataExploration, writes = h.live.writes.length;
  for (const value of ['Delete', 'Backspace', 'PageUp', 'PageDown', '+', '-', '=', '_', 'z', 'y', 'Tab', 'a']) {
    assert.equal(key(chart, value).defaultPrevented, false, value);
    assert.deepEqual(chart.dataExploration, before, value);
  }
  assert.equal(calls.length, 0); assert.equal(h.live.writes.length, writes);
});

for (const [name, fields] of [
  ['control modifier', {ctrlKey: true}], ['meta modifier', {metaKey: true}],
  ['alt modifier', {altKey: true}], ['shift modifier', {shiftKey: true}],
  ['IME composition', {isComposing: true}], ['already prevented', {defaultPrevented: true}],
]) test(`exploration leaves ${name} untouched`, t => {
  const h = fixture(t), {chart} = h.create(), queries = spyReads(chart), calls = [];
  chart.controller.key = (...args) => calls.push(args); chart.setDataExploration(true); chart.canvas.focus();
  const before = chart.dataExploration, writes = h.live.writes.length;
  for (const value of ['Home', 'ArrowLeft', 'Enter', 'Escape', 'z']) {
    const e = key(chart, value, fields); assert.equal(e.defaultPrevented, Boolean(fields.defaultPrevented));
    assert.deepEqual(chart.dataExploration, before);
  }
  assert.equal(queries.length, 0); assert.equal(calls.length, 0); assert.equal(h.live.writes.length, writes);
});

test('a canvas-target event cannot explore when focus belongs to another element', t => {
  const h = fixture(t), {chart} = h.create(), queries = spyReads(chart), calls = [];
  chart.controller.key = (...args) => calls.push(args); chart.setDataExploration(true);
  const before = chart.dataExploration, writes = h.live.writes.length;
  for (const focused of [null, h.controls[0], h.node('input')]) {
    h.document.activeElement = focused;
    for (const pressed of ['Home', 'ArrowLeft', 'Enter', 'Escape', 'Delete']) {
      assert.equal(key(chart, pressed).defaultPrevented, false);
      assert.deepEqual(chart.dataExploration, before);
    }
  }
  assert.equal(queries.length, 0); assert.equal(calls.length, 0); assert.equal(h.live.writes.length, writes);
});

test('editor and registered-control key targets never drive canvas exploration', t => {
  const h = fixture(t), {chart} = h.create(), queries = spyReads(chart), calls = [];
  chart.controller.key = (...args) => calls.push(args); chart.setDataExploration(true);
  const input = h.node('input'), editor = h.node(); editor.isContentEditable = true;
  const before = chart.dataExploration, writes = h.live.writes.length;
  for (const target of [input, editor, ...h.controls]) for (const value of ['Home', 'ArrowLeft', 'Enter', 'Escape']) {
    target.focus(); assert.equal(key(chart, value, {target}).defaultPrevented, false);
    assert.deepEqual(chart.dataExploration, before);
  }
  assert.equal(calls.length, 0); assert.equal(queries.length, 0); assert.equal(h.live.writes.length, writes);
});

test('hover performs no exploration reads, and data/display invalidation only marks the readout changed', t => {
  const h = fixture(t), f = h.create(), {chart, model} = f, counter = dirtyStudy(f), queries = spyReads(chart);
  chart.setDataExploration(true); chart.canvas.focus();
  const live = h.live.textContent, writes = h.live.writes.length, selected = chart.dataExploration.time;
  for (let i = 0; i < 12; i++) event(chart.canvas, 'pointermove', {pointerId: 1, clientX: 30 + i, clientY: 40});
  chart.invalidate('hover'); assert.equal(chart.dataExploration.phase, 'selected');
  chart.invalidate(); assert.equal(chart.dataExploration.phase, 'changed');
  chart.api.pan(1); model.store.update(1, {...bars[1], close: 23});
  assert.equal(chart.dataExploration.time, selected); assert.match(h.readout.textContent, /changed/i);
  assert.equal(h.live.textContent, live); assert.equal(h.live.writes.length, writes);
  assert.equal(queries.length, 0); assert.equal(counter.steps, 0);
});

for (const type of ['pointerdown', 'wheel']) test(`${type} exits exploration before controller input`, t => {
  const h = fixture(t), {chart} = h.create(), queries = spyReads(chart), states = [];
  chart.setDataExploration(true);
  chart.controller[type === 'wheel' ? 'wheel' : 'down'] = () => states.push(chart.dataExploration.active);
  const e = event(chart.canvas, type, {button: 0, pointerId: 2, clientX: 10, clientY: 20, deltaY: 1, deltaMode: 0});
  assert.equal(chart.dataExploration.active, false); assert.deepEqual(states, [false]);
  assert.equal(queries.length, 0); if (type === 'wheel') assert.equal(e.defaultPrevented, true);
});

test('focusout stays inside canvas and registered controls, and exits for outside/null/removed controls', t => {
  const h = fixture(t), {chart} = h.create(); chart.setDataExploration(true);
  const before = h.live.writes.length;
  for (const [from, to] of [[chart.canvas, h.controls[0]], [h.controls[0], h.controls[1]], [h.controls[1], chart.canvas]]) {
    event(from, 'focusout', {relatedTarget: to}); assert.equal(chart.dataExploration.active, true);
  }
  assert.equal(h.live.writes.length, before);
  for (const destination of [h.node('button'), null, h.readout, h.live]) {
    event(chart.canvas, 'focusout', {relatedTarget: destination}); assert.equal(chart.dataExploration.active, false);
    chart.setDataExploration(true);
  }
  h.controls[1].remove();
  event(h.controls[0], 'focusout', {relatedTarget: h.controls[1]}); assert.equal(chart.dataExploration.active, false);
});

test('output uses literal bounded textContent and announces only explicit actions', t => {
  const h = fixture(t), {chart, model} = h.create();
  chart.api.removeSeries('price');
  const id = '<img src=x onerror=alert(1)>';
  chart.api.addSeries({id, type: 'line', panel: 'price'});
  chart.setDataExploration(true); assert.ok(h.readout.textContent.includes(id));
  chart.readExploration(); assert.ok(h.readout.textContent.includes(id));
  const liveWrites = h.live.writes.length;
  chart.invalidate(); chart.invalidate('drawings'); chart.invalidate('hover');
  assert.equal(h.live.writes.length, liveWrites);
  assert.ok(h.readout.writes.every(text => text.length <= 4096));
  // Defensive presentation bound, not support for corrupting model metadata.
  model.series[0].id = 'x'.repeat(5000);
  chart.setDataExploration(true); assert.equal(h.readout.textContent.length, 4096);
  assert.equal(h.live.textContent.length, 4096);
});

test('empty storage can enter, navigate and read without calling dataAt', t => {
  const h = fixture(t), {chart} = h.create({}, h.makeModel([])), queries = spyReads(chart);
  chart.setDataExploration(true); chart.canvas.focus();
  for (const pressed of ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']) key(chart, pressed);
  assert.equal(chart.dataExploration.active, true); assert.equal(chart.dataExploration.index, -1);
  assert.match(h.readout.textContent, /No stored bars/); assert.equal(queries.length, 0);
});

test('fallback detaches the old canvas, exits mode and binds exactly one replacement listener set', t => {
  const h = fixture(t), {chart, renderer} = h.create(), queries = spyReads(chart);
  chart.setDataExploration(true); const old = chart.canvas, listenerCount = old.listenerCount();
  chart.fallback('test loss');
  assert.notEqual(chart.canvas, old); assert.equal(old.listenerCount(), 0); assert.equal(old.isConnected, false);
  assert.equal(chart.canvas.listenerCount(), listenerCount); assert.equal(renderer.disposed, 1);
  assert.equal(chart.dataExploration.active, false); assert.equal(chart.rendererKind, 'canvas');
  assert.equal(h.controls[0].listenerCount('focusout'), 1);
  chart.setDataExploration(true); chart.canvas.focus(); const selected = chart.dataExploration;
  event(old, 'keydown', {key: 'Home'}); event(old, 'focusout', {relatedTarget: null});
  assert.deepEqual(chart.dataExploration, selected);
  key(chart, 'Home'); assert.equal(chart.dataExploration.index, 0); assert.equal(queries.length, 0);
  chart.destroy(); assert.equal(chart.canvas.listenerCount(), 0);
  assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
});

test('new chart ownership preserves output when the older chart updates or is destroyed', t => {
  const h = fixture(t), old = h.create(); old.chart.setDataExploration(true); old.chart.readExploration();
  const newer = h.create(); newer.chart.setDataExploration(true); newer.chart.canvas.focus(); key(newer.chart, 'Home');
  const text = h.readout.textContent, live = h.live.textContent;
  const writes = [h.readout.writes.length, h.live.writes.length];
  old.chart.invalidate(); old.chart.readExploration(); old.chart.destroy();
  assert.equal(h.readout.textContent, text); assert.equal(h.live.textContent, live);
  assert.deepEqual([h.readout.writes.length, h.live.writes.length], writes);
  assert.equal(h.controls[0].listenerCount('focusout'), 1);
  key(newer.chart, 'ArrowRight'); assert.equal(newer.chart.dataExploration.index, 1);
  newer.chart.destroy(); assert.equal(h.readout.textContent, ''); assert.equal(h.live.textContent, '');
});

test('destroy releases explorer output/control references, listeners, subscription and queued RAF', t => {
  const h = fixture(t), {chart, model, baselineListeners} = h.create(); chart.setDataExploration(true);
  const explorer = chart.explorer, canvas = chart.canvas;
  chart.destroy(); chart.destroy();
  assert.equal(chart.explorer, null); assert.equal(chart.explorerNodes, null);
  assert.equal(explorer.api, null); assert.equal(explorer.model, null); assert.equal(explorer.disposed, true);
  assert.equal(canvas.listenerCount(), 0); assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
  assert.equal(model.store.listeners.size, baselineListeners); assert.equal(h.frames.size, 0);
  assert.equal(h.readout.textContent, ''); assert.equal(h.live.textContent, '');
  assert.equal(canvas.isConnected, false); assert.equal(chart.dataExploration.active, false);
  assert.throws(() => chart.setDataExploration(true), /disposed/i); assert.throws(() => chart.readExploration(), /disposed/i);
  const writes = [h.readout.writes.length, h.live.writes.length];
  event(canvas, 'keydown', {key: 'Enter'}); event(h.controls[0], 'focusout', {relatedTarget: null}); chart.invalidate();
  assert.deepEqual([h.readout.writes.length, h.live.writes.length], writes);
});

for (const [name, options] of [
  ['same output node', h => ({readout: h.readout, live: h.readout})],
  ['missing live', h => ({readout: h.readout})],
  ['non-element output', h => ({readout: {}, live: h.live})],
  ['duplicate controls', h => ({...h.outputs, controls: [h.controls[0], h.controls[0]]})],
  ['five controls', h => ({...h.outputs, controls: Array.from({length: 5}, () => h.node('button'))})],
  ['output as a control', h => ({...h.outputs, controls: [h.readout]})],
  ['unknown option', h => ({...h.outputs, extra: true})],
]) test(`invalid explorer options clean up construction: ${name}`, t => {
  const h = fixture(t), model = h.makeModel(), baseline = model.store.listeners.size;
  assert.throws(() => h.create({dataExplorer: options(h)}, model), TypeError);
  const canvas = h.elements.find(element => element.tagName === 'CANVAS');
  assert.equal(canvas.isConnected, false); assert.equal(canvas.listenerCount(), 0);
  assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
  assert.equal(model.store.listeners.size, baseline); assert.equal(h.frames.size, 0);
  assert.equal(h.renderers[0].disposed, 1);
});

test('four registered controls are accepted and independently removed at destroy', t => {
  const h = fixture(t), controls = Array.from({length: 4}, () => h.node('button'));
  const {chart} = h.create({dataExplorer: {...h.outputs, controls}});
  chart.setDataExploration(true);
  for (const control of controls) {
    assert.equal(control.listenerCount('focusout'), 1);
    event(chart.canvas, 'focusout', {relatedTarget: control}); assert.equal(chart.dataExploration.active, true);
  }
  chart.destroy(); for (const control of controls) assert.equal(control.listenerCount(), 0);
});

test('constructor failure after explorer binding releases controls and canvas listeners', t => {
  const h = fixture(t), model = h.makeModel(), baseline = model.store.listeners.size;
  h.ResizeObserver.prototype.failObserve = true;
  assert.throws(() => h.create({observeResize: true}, model), /observer setup failed/);
  const canvas = h.elements.find(element => element.tagName === 'CANVAS');
  assert.equal(canvas.isConnected, false); assert.equal(canvas.listenerCount(), 0);
  assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
  assert.equal(h.readout.textContent, ''); assert.equal(h.live.textContent, '');
  assert.equal(h.observers[0].disconnected, true); assert.equal(model.store.listeners.size, baseline);
  assert.equal(h.frames.size, 0); assert.equal(h.renderers[0].disposed, 1);
});

for (const trigger of ['public read', 'Enter']) for (const action of ['destroy', 'stop', 'fallback']) {
  test(`lazy callback ${action} prevents stale UI republication: ${trigger}`, t => {
    const h = fixture(t), f = h.create(), {chart} = f;
    let ran = false, afterAction;
    dirtyStudy(f, () => {
      if (ran) return; ran = true;
      if (action === 'destroy') chart.destroy();
      else if (action === 'stop') chart.setDataExploration(false);
      else chart.fallback('lazy callback loss');
      afterAction = {readout: h.readout.textContent, live: h.live.textContent,
        readoutWrites: h.readout.writes.length, liveWrites: h.live.writes.length};
    });
    chart.setDataExploration(true); chart.canvas.focus();
    if (trigger === 'public read') assert.throws(() => chart.readExploration(), /disposed|owner changed/i);
    else {
      assert.equal(key(chart, 'Enter').defaultPrevented, true);
      if (action !== 'destroy') assert.ok(chart.lastError);
    }
    assert.equal(ran, true); assert.equal(chart.dataExploration.active, false);
    assert.equal(h.readout.textContent, afterAction.readout); assert.equal(h.live.textContent, afterAction.live);
    assert.equal(h.readout.writes.length, afterAction.readoutWrites, 'Outer read must not republish after lifecycle changes');
    assert.equal(h.live.writes.length, afterAction.liveWrites, 'Outer read must not announce after lifecycle changes');
  });
}

for (const trigger of ['fallback', 'pointerdown', 'wheel']) for (const action of ['destroy', 'fallback']) {
  test(`mode-exit observer ${action} aborts the outer ${trigger} owner`, t => {
    const h = fixture(t), fallbackCalls = [], f = h.create({onFallback: reason => fallbackCalls.push(reason)});
    const {chart, renderer} = f, queries = spyReads(chart), controllerCalls = [];
    chart.controller.down = () => controllerCalls.push('down');
    chart.controller.wheel = () => controllerCalls.push('wheel');
    chart.setDataExploration(true); chart.canvas.focus();
    const old = chart.canvas, ownListeners = old.listenerCount(); let ran = false, afterAction;
    const observer = () => {
      old.removeEventListener('aster:exploration', observer); ran = true;
      assert.equal(chart.dataExploration.active, false);
      if (action === 'destroy') chart.destroy(); else chart.fallback('observer replacement');
      afterAction = {canvas: chart.canvas, readoutWrites: h.readout.writes.length, liveWrites: h.live.writes.length};
    };
    old.addEventListener('aster:exploration', observer);
    if (trigger === 'fallback') chart.fallback('outer loss');
    else event(old, trigger, {button: 0, pointerId: 3, clientX: 10, clientY: 20, deltaY: 1, deltaMode: 0});
    assert.equal(ran, true); assert.deepEqual(controllerCalls, []); assert.equal(queries.length, 0);
    assert.equal(chart.canvas, afterAction.canvas); assert.equal(old.listenerCount(), 0);
    assert.equal(old.capture, undefined); assert.equal(renderer.disposed, 1);
    assert.equal(h.readout.writes.length, afterAction.readoutWrites);
    assert.equal(h.live.writes.length, afterAction.liveWrites);
    if (action === 'destroy') {
      assert.equal(chart.canvas, old); assert.equal(chart.disposed, true); assert.equal(old.isConnected, false);
      assert.equal(chart.explorer, null); assert.equal(chart.explorerNodes, null);
      assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
      assert.equal(h.frames.size, 0); assert.deepEqual(fallbackCalls, []);
      const canvases = h.elements.filter(node => node.tagName === 'CANVAS'), staged = canvases.find(node => node !== old);
      assert.equal(canvases.length, trigger === 'fallback' ? 2 : 1);
      if (trigger === 'fallback') {assert.equal(staged.isConnected, false); assert.equal(staged.width, 0); assert.equal(staged.height, 0); assert.equal(staged.listenerCount(), 0);}
    } else {
      assert.notEqual(chart.canvas, old); assert.equal(chart.canvas.listenerCount(), ownListeners);
      assert.equal(chart.canvas.isConnected, true); assert.equal(chart.dataExploration.active, false);
      assert.deepEqual(fallbackCalls, ['observer replacement']);
      const canvases = h.elements.filter(node => node.tagName === 'CANVAS'), staged = canvases.find(node => node !== old && node !== chart.canvas);
      assert.equal(canvases.length, trigger === 'fallback' ? 3 : 2);
      if (trigger === 'fallback') {assert.equal(staged.isConnected, false); assert.equal(staged.width, 0); assert.equal(staged.height, 0); assert.equal(staged.listenerCount(), 0);}
      assert.equal(h.controls[0].listenerCount('focusout'), 1);
      chart.destroy(); assert.equal(chart.canvas.listenerCount(), 0);
    }
  });
}

test('exploration change observer teardown cannot schedule a new frame or republish live text', t => {
  const h = fixture(t), {chart} = h.create(); chart.setDataExploration(true);
  const canvas = chart.canvas; let ran = false, writes;
  const observer = () => {
    canvas.removeEventListener('aster:exploration', observer); ran = true;
    assert.equal(chart.dataExploration.phase, 'changed'); chart.destroy();
    writes = [h.readout.writes.length, h.live.writes.length];
  };
  canvas.addEventListener('aster:exploration', observer);
  chart.invalidate();
  assert.equal(ran, true); assert.equal(chart.disposed, true); assert.equal(h.frames.size, 0);
  assert.equal(canvas.listenerCount(), 0); assert.equal(chart.explorerNodes, null);
  assert.deepEqual([h.readout.writes.length, h.live.writes.length], writes);
});

for (const trigger of ['public read', 'Enter']) test(`lazy errors retain their identity and visible retry state: ${trigger}`, t => {
  const h = fixture(t), errors = [], f = h.create({onError: error => errors.push(error)}), {chart} = f;
  const failure = new Error('trusted callback failed <unsafe detail>'); let shouldThrow = true;
  const counter = dirtyStudy(f, () => {if (shouldThrow) throw failure;}), queries = spyReads(chart);
  chart.setDataExploration(true); chart.canvas.focus();
  const selected = chart.dataExploration.time, liveWrites = h.live.writes.length;
  let cancellations = 0; const cancel = chart.controller.cancel.bind(chart.controller);
  chart.controller.cancel = (...args) => {cancellations++; return cancel(...args);};
  if (trigger === 'public read') assert.throws(() => chart.readExploration(), error => error === failure);
  else {
    assert.equal(key(chart, 'Enter').defaultPrevented, true);
    assert.equal(chart.lastError, failure); assert.deepEqual(errors, [failure]);
  }
  assert.equal(chart.dataExploration.active, true); assert.equal(chart.dataExploration.phase, 'error');
  assert.equal(chart.dataExploration.time, selected); assert.equal(chart.explorer.busy, false);
  assert.equal(h.readout.textContent, 'Value read failed. Press Enter to retry.');
  assert.equal(h.live.textContent, h.readout.textContent); assert.equal(h.live.writes.length, liveWrites + 1);
  assert.equal(h.readout.textContent.includes(failure.message), false);
  assert.equal(cancellations, 0); assert.equal(queries.length, 1); assert.ok(counter.steps > 0);
  shouldThrow = false;
  if (trigger === 'public read') assert.equal(chart.readExploration().phase, 'read');
  else assert.equal(key(chart, 'Enter').defaultPrevented, true);
  assert.equal(chart.dataExploration.phase, 'read'); assert.equal(chart.dataExploration.time, selected);
  assert.match(h.readout.textContent, /Current plotted values/); assert.equal(h.live.textContent, h.readout.textContent);
  assert.equal(queries.length, 2); assert.equal(cancellations, 0);
  assert.equal(errors.length, trigger === 'Enter' ? 1 : 0);
});

for (const action of ['destroy', 'stop', 'fallback']) test(`onError ${action} owns the terminal UI and cleanup state`, t => {
  const h = fixture(t), failure = new Error('callback read error');
  let chart, afterAction, cancellations = 0; const received = [];
  const f = h.create({onError: error => {
    received.push(error); assert.equal(error, failure);
    assert.equal(chart.dataExploration.phase, 'error');
    if (action === 'destroy') chart.destroy();
    else if (action === 'stop') chart.setDataExploration(false);
    else chart.fallback('error observer replacement');
    afterAction = {
      canvas: chart.canvas, readout: h.readout.textContent, live: h.live.textContent,
      readoutWrites: h.readout.writes.length, liveWrites: h.live.writes.length,
      listeners: chart.canvas.listenerCount(), frames: h.frames.size, cancellations,
    };
  }});
  chart = f.chart; dirtyStudy(f, () => {throw failure;});
  chart.setDataExploration(true); chart.canvas.focus();
  const old = chart.canvas, cancel = chart.controller.cancel.bind(chart.controller);
  chart.controller.cancel = (...args) => {cancellations++; return cancel(...args);};
  assert.equal(key(chart, 'Enter').defaultPrevented, true);
  assert.deepEqual(received, [failure]); assert.equal(chart.lastError, failure);
  assert.equal(chart.dataExploration.active, false); assert.equal(chart.canvas, afterAction.canvas);
  assert.equal(h.readout.textContent, afterAction.readout); assert.equal(h.live.textContent, afterAction.live);
  assert.equal(h.readout.writes.length, afterAction.readoutWrites); assert.equal(h.live.writes.length, afterAction.liveWrites);
  assert.equal(chart.canvas.listenerCount(), afterAction.listeners); assert.equal(h.frames.size, afterAction.frames);
  assert.equal(cancellations, afterAction.cancellations, 'Outer input must not cancel again after onError returns');
  if (action === 'destroy') {
    assert.equal(chart.disposed, true); assert.equal(chart.explorer, null); assert.equal(chart.explorerNodes, null);
    assert.equal(old.listenerCount(), 0); assert.equal(h.frames.size, 0);
    assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
  } else if (action === 'fallback') {
    assert.notEqual(chart.canvas, old); assert.equal(old.listenerCount(), 0);
    assert.equal(f.renderer.disposed, 1); assert.equal(chart.canvas.isConnected, true);
    assert.equal(h.controls[0].listenerCount('focusout'), 1);
  } else {
    assert.equal(chart.canvas, old); assert.equal(chart.disposed, false); assert.match(h.readout.textContent, /off/i);
  }
});

test('catch cancellation observer teardown suppresses error reporting after disposal', t => {
  const h = fixture(t), errors = [], f = h.create({onError: error => errors.push(error)}), {chart} = f;
  const failure = new Error('read failed after stopping exploration'); let callbacks = 0, destroyed = false, writes;
  dirtyStudy(f, () => {callbacks++; chart.setDataExploration(false); throw failure;});
  const queries = spyReads(chart);
  chart.setDataExploration(true); chart.canvas.focus(); const canvas = chart.canvas;
  const observer = () => {
    canvas.removeEventListener('aster:state', observer);
    assert.equal(chart.dataExploration.active, false);
    chart.destroy(); destroyed = true;
    writes = [h.readout.writes.length, h.live.writes.length];
  };
  canvas.addEventListener('aster:state', observer);
  assert.equal(key(chart, 'Enter').defaultPrevented, true);
  assert.equal(callbacks, 1); assert.equal(queries.length, 1); assert.equal(destroyed, true);
  assert.equal(chart.disposed, true); assert.deepEqual(errors, []); assert.equal(chart.lastError, null);
  assert.equal(chart.explorer, null); assert.equal(chart.explorerNodes, null);
  assert.equal(chart.canvas, canvas); assert.equal(canvas.listenerCount(), 0); assert.equal(canvas.isConnected, false);
  assert.equal(h.controls[0].listenerCount(), 0); assert.equal(h.controls[1].listenerCount(), 0);
  assert.equal(h.frames.size, 0); assert.equal(h.readout.textContent, ''); assert.equal(h.live.textContent, '');
  assert.deepEqual([h.readout.writes.length, h.live.writes.length], writes);
});
