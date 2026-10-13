import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel} from '../src/core/index.mjs';
import {attachDrawingPanel, CanvasChart, DrawingSelectionController} from '../src/renderers/canvas.mjs';

// JavaScript source integration with a test-only DOM. Native checkbox changes,
// target-preserving bubbling, focus ownership, and listener removal are modeled;
// this is not a real-browser keyboard/default-action, accessibility-tree,
// screen-reader, pixel, or long-term heap test. RAF callbacks remain queued.
// Metadata-only/cold-RAF checks do not claim a later chart frame is compute-free.
const drawing = (id, extra = {}) => ({
  id, type: 'horizontal', panel: 'price', points: [{time: 1700000000000.125, price: 12.25}],
  style: {color: '#102030ff', fill: '#405060ff', width: 2, font: '12px monospace'}, ...extra,
});

function fixture(t) {
  const keys = ['document', 'HTMLElement', 'Element', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const elements = [], charts = [], models = [], panels = [], frames = new Map();
  let serial = 0;
  const document = {activeElement: null};
  class Element {
    constructor(tag = 'div') {
      this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = document;
      this.attributes = new Map(); this.events = new Map(); this.children = []; this.parentNode = null;
      this.style = {}; this._text = ''; this.writes = []; this.connected = false;
      this.clientWidth = 800; this.clientHeight = 500; this.width = 0; this.height = 0;
      this.checked = false; this.disabled = false; this.value = ''; elements.push(this);
    }
    get isConnected() {return this.connected || Boolean(this.parentNode?.isConnected);}
    get textContent() {return this._text + this.children.map(child => child.textContent).join('');}
    set textContent(value) {
      for (const child of [...this.children]) child.remove();
      this._text = String(value); this.writes.push(this._text); this.onText?.(this._text);
    }
    get innerHTML() {assert.fail('Panel output must not read innerHTML');}
    set innerHTML(_) {assert.fail('Panel output must use textContent, never innerHTML');}
    setAttribute(name, value) {this.attributes.set(name, String(value));}
    getAttribute(name) {return this.attributes.get(name) ?? null;}
    addEventListener(type, fn) {
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(fn);
    }
    removeEventListener(type, fn) {this.events.get(type)?.delete(fn);}
    listenerCount(type) {return type ? this.events.get(type)?.size ?? 0 : [...this.events.values()].reduce((n, set) => n + set.size, 0);}
    dispatchEvent(event) {
      if (!event.target) Object.defineProperty(event, 'target', {configurable: true, value: this});
      Object.defineProperty(event, 'currentTarget', {configurable: true, value: this});
      for (const fn of [...this.events.get(event.type) ?? []]) {
        if (this.events.get(event.type)?.has(fn)) fn.call(this, event);
      }
      if (event.bubbles && !event.cancelBubble) this.parentNode?.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    append(...nodes) {for (const node of nodes) {node.remove(); node.parentNode = this; this.children.push(node);}}
    insertBefore(node, before) {
      if (node === before) return node;
      if (before === null) {this.append(node); return node;}
      assert.ok(this.children.includes(before), 'insertBefore reference must belong to its parent');
      node.remove(); node.parentNode = this; this.children.splice(this.children.indexOf(before), 0, node); return node;
    }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = null;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null; this.connected = false;
    }
    replaceWith(node) {const parent = this.parentNode; this.remove(); parent?.append(node);}
    cloneNode() {const node = new Element(this.tagName); node.attributes = new Map(this.attributes); node.tabIndex = this.tabIndex; node.style = {...this.style}; return node;}
    contains(node) {return node === this || this.children.some(child => child.contains(node));}
    focus() {document.activeElement = this; this.onFocus?.();}
    getBoundingClientRect() {return {left: 0, top: 0, width: 800, height: 500};}
    setPointerCapture(id) {this.capture = id;}
    getContext() {return {};}
  }
  class ResizeObserver {observe() {} disconnect() {}}
  document.createElement = tag => new Element(tag);
  const globals = {document, HTMLElement: Element, Element, ResizeObserver,
    requestAnimationFrame: callback => {const id = ++serial; frames.set(id, callback); return id;},
    cancelAnimationFrame: id => frames.delete(id)};
  for (const key of keys) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: globals[key]});
  const root = new Element(); root.connected = true;
  const node = (tag = 'div') => {const value = new Element(tag); root.append(value); return value;};
  const create = (inputs = [drawing('a'), drawing('b'), drawing('keep')]) => {
    const model = new ChartModel(); models.push(model);
    for (const input of inputs) model.drawings.add(input);
    const container = node(), baselineListeners = model.store.listeners.size;
    const renderer = {kind: 'test', calls: 0, disposed: 0, render() {this.calls++;}, dispose() {this.disposed++;}};
    const chart = new CanvasChart(container, model, {dpr: () => 1, interactive: false,
      observeResize: false, layerCaching: false, rendererFactory: () => renderer});
    charts.push(chart);
    const f = {chart, model, api: chart.api, store: model.drawings, container, renderer,
      panelContainer: node(), baselineListeners, invalidations: 0, onInvalidate: null};
    const invalidate = chart.invalidate.bind(chart);
    chart.invalidate = (...args) => {if (chart.disposed) return invalidate(...args); f.invalidations++; invalidate(...args); f.onInvalidate?.();};
    f.attach = (options = {}) => {const panel = attachDrawingPanel(f.panelContainer, chart, options); panels.push(panel); return panel;};
    return f;
  };
  t.after(() => {
    try {
      for (const panel of panels) panel.destroy();
      for (const chart of charts) chart.destroy();
      for (const model of models) model.dispose();
    } finally {
      frames.clear();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  });
  return {create, node, elements, document, root, frames};
}

function event(node, type, fields = {}) {
  const value = new Event(type, {bubbles: true, cancelable: true});
  for (const [key, field] of Object.entries(fields)) Object.defineProperty(value, key, {configurable: true, value: field});
  node.dispatchEvent(value); return value;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const find = (node, predicate) => descendants(node).find(predicate);
const button = (f, text) => find(f.panelContainer, node => node.tagName === 'BUTTON' && node.textContent === text);
const click = (f, text) => event(button(f, text), 'click');
const list = f => find(f.panelContainer, node => node.tagName === 'UL');
const boxes = f => list(f).children.map(row => find(row, node => node.tagName === 'INPUT'));
const rowIds = f => list(f).children.map(row => row.textContent.split(' · ')[0]);
const status = f => find(f.panelContainer, node => node.getAttribute('role') === 'status');
const count = f => find(f.panelContainer, node => node.tagName === 'P');
const field = (f, name) => ({
  enabled: find(f.panelContainer, node => node.getAttribute('aria-label') === `Apply ${name}`),
  input: find(f.panelContainer, node => node.getAttribute('aria-label') === `${name} value`),
});
function styleField(f, name, value) {const control = field(f, name); control.enabled.checked = true; control.input.value = value;}
function check(f, index, selected = true) {const box = boxes(f)[index]; box.checked = selected; event(box, 'change'); return box;}
function selection(panel, ids) {assert.deepEqual(panel.selection.snapshot().selectedIds, ids);}
function unchanged(f) {
  const {items, undoStack, redoStack, selected, serial, transaction} = f.store;
  const copy = items.slice(), history = undoStack.slice(), redo = redoStack.slice(), invalidations = f.invalidations;
  return () => {
    assert.strictEqual(f.store.items, items); assert.deepEqual(f.store.items, copy);
    copy.forEach((item, i) => assert.strictEqual(f.store.items[i], item));
    assert.strictEqual(f.store.undoStack, undoStack); assert.deepEqual(f.store.undoStack, history);
    assert.strictEqual(f.store.redoStack, redoStack); assert.deepEqual(f.store.redoStack, redo);
    assert.equal(f.store.selected, selected); assert.equal(f.store.serial, serial);
    assert.strictEqual(f.store.transaction, transaction); assert.equal(f.invalidations, invalidations);
  };
}

test('canvas export attaches a labeled opt-in panel with native controls and a separate selection controller', t => {
  const h = fixture(t), f = h.create();
  assert.equal(f.panelContainer.children.length, 0);
  const panel = f.attach({label: 'Portfolio drawing controls'});
  assert.deepEqual(Object.keys(panel).sort(), ['destroy', 'refresh', 'selection']);
  assert.ok(panel.selection instanceof DrawingSelectionController);
  assert.equal(f.panelContainer.children[0].getAttribute('aria-label'), 'Portfolio drawing controls');
  assert.deepEqual(descendants(f.panelContainer).filter(node => node.tagName === 'BUTTON').map(node => [node.textContent, node.type]), [
    ['Refresh drawings', 'button'], ['Previous page', 'button'], ['Next page', 'button'],
    ['Clear selection', 'button'], ['Delete selected', 'button'], ['Apply checked styles', 'button'],
  ]);
  for (const name of ['color', 'fill', 'width', 'font']) {
    const {enabled, input} = field(f, name);
    assert.equal(enabled.type, 'checkbox'); assert.equal(enabled.checked, false); assert.equal(input.type, 'text');
  }
  assert.equal(descendants(f.panelContainer).filter(node => node.tagName === 'INPUT' && node.type === 'text').length, 4);
  assert.equal(status(f).getAttribute('aria-live'), 'polite');
  assert.equal(button(f, 'Previous page').disabled, true); assert.equal(button(f, 'Next page').disabled, true);
  for (const label of ['Clear selection', 'Delete selected', 'Apply checked styles']) assert.equal(button(f, label).disabled, true);
  check(f, 0); selection(panel, ['a']); assert.equal(f.store.selected, 'keep');
  check(f, 0, false); selection(panel, []);
  check(f, 1); click(f, 'Clear selection'); selection(panel, []);
  assert.equal(status(f).textContent, 'Selection cleared.');
});

test('one panel owns each chart and empty container; destruction releases both owners', t => {
  const h = fixture(t), f = h.create(), g = h.create(), panel = f.attach();
  assert.throws(() => attachDrawingPanel(h.node(), f.chart), /already attached/i);
  assert.throws(() => attachDrawingPanel(f.panelContainer, g.chart), /Empty|attached/i);
  const occupied = h.node(); occupied.append(h.node('span'));
  assert.throws(() => attachDrawingPanel(occupied, g.chart), /Empty/i);
  panel.destroy(); assert.equal(f.panelContainer.children.length, 0);
  const replacement = f.attach();
  panel.destroy(); assert.equal(f.panelContainer.children.length, 1); check(f, 0); selection(replacement, ['a']);
  replacement.destroy(); assert.equal(f.panelContainer.children.length, 0);
  f.chart.destroy(); assert.throws(() => f.attach(), /Live chart/i);
});

test('invalid options, labels, and getter-backed labels reject without side effects', t => {
  const h = fixture(t), f = h.create(); let reads = 0;
  for (const options of [null, [], {unknown: true}, {label: ''}, {label: 4}, {label: 'x'.repeat(129)},
    Object.create(null), Object.defineProperty({}, 'label', {get() {reads++; return 'unsafe';}})]) {
    assert.throws(() => f.attach(options)); assert.equal(f.panelContainer.children.length, 0);
    assert.equal(f.container.listenerCount(), 0);
  }
  assert.equal(reads, 0);
  assert.equal(f.attach().refresh().total, 3);
});

test('attach rejects mismatched chart and API model owners before creating controls or listeners', t => {
  const h = fixture(t), f = h.create(), g = h.create(), originalAPI = f.chart.api, originalModel = f.chart.model;
  try {
    f.chart.model = g.model;
    assert.throws(() => f.attach(), /owner mismatch/i);
    f.chart.model = originalModel; f.chart.api = new ChartAPI(g.model);
    assert.throws(() => f.attach(), /owner mismatch/i);
    assert.equal(f.panelContainer.children.length, 0); assert.equal(f.container.listenerCount(), 0);
  } finally {f.chart.api = originalAPI; f.chart.model = originalModel;}
  f.attach(); assert.equal(f.container.listenerCount('aster:state'), 1);
});

test('attach rejects getter-backed chart/API owners without invoking any owner getter', t => {
  const h = fixture(t), f = h.create(); let calls = 0;
  for (const [object, key] of [[f.chart, 'api'], [f.chart, 'model'], [f.chart, 'disposed'], [f.api, 'model']]) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, {configurable: true, get() {calls++; return descriptor.value;}});
    try {
      assert.throws(() => f.attach()); assert.equal(calls, 0);
      assert.equal(f.panelContainer.children.length, 0); assert.equal(f.container.listenerCount(), 0);
    } finally {Object.defineProperty(object, key, descriptor);}
  }
  f.attach(); assert.equal(f.container.listenerCount('aster:state'), 1);
});

test('page controls render at most 32 rows, retain off-page selections, and clamp after shrinking', t => {
  const h = fixture(t), f = h.create(Array.from({length: 70}, (_, i) => drawing(`d-${i}`))), panel = f.attach();
  assert.deepEqual(rowIds(f), Array.from({length: 32}, (_, i) => `d-${i}`));
  check(f, 0); const offPage = boxes(f)[0];
  click(f, 'Next page'); assert.equal(offPage.listenerCount(), 0);
  assert.equal(rowIds(f)[0], 'd-32'); check(f, 2);
  click(f, 'Next page'); assert.deepEqual(rowIds(f), ['d-64', 'd-65', 'd-66', 'd-67', 'd-68', 'd-69']);
  check(f, 5); selection(panel, ['d-0', 'd-34', 'd-69']);
  assert.match(count(f).textContent, /3 selected across all pages; 70 drawings/);
  assert.match(count(f).textContent, /Actions apply to every selected ID, including other pages/);
  assert.equal(button(f, 'Next page').disabled, true);
  click(f, 'Previous page'); assert.equal(boxes(f)[2].checked, true);
  click(f, 'Previous page'); assert.equal(boxes(f)[0].checked, true);
  click(f, 'Next page'); click(f, 'Next page');
  for (const item of [...f.store.items].slice(12)) f.store.remove(item.id);
  click(f, 'Refresh drawings');
  assert.equal(rowIds(f).length, 12); assert.equal(rowIds(f)[0], 'd-0'); selection(panel, ['d-0']);
  assert.equal(button(f, 'Previous page').disabled, true); assert.equal(button(f, 'Next page').disabled, true);
});

test('native checkbox changes enforce 128 selections across pages and recover the rejected checkbox', t => {
  const h = fixture(t), f = h.create(Array.from({length: 129}, (_, i) => drawing(`d-${i}`))), panel = f.attach();
  for (let page = 0; page < 4; page++) {
    for (let i = 0; i < 32; i++) check(f, i);
    click(f, 'Next page');
  }
  assert.equal(panel.selection.snapshot().selectedCount, 128);
  check(f, 0); assert.equal(boxes(f)[0].checked, false);
  assert.match(status(f).textContent, /128|limit/i); assert.equal(panel.selection.snapshot().selectedCount, 128);
  click(f, 'Clear selection'); check(f, 0); selection(panel, ['d-128']);
});

for (const action of ['style', 'delete']) test(`${action} acts on all selected pages as one atomic batch and undo unit`, t => {
  const h = fixture(t), f = h.create(Array.from({length: 70}, (_, i) => drawing(`d-${i}`))), panel = f.attach();
  check(f, 0); click(f, 'Next page'); check(f, 2); click(f, 'Next page'); check(f, 5);
  const before = f.store.items.slice(), history = f.store.undoStack.length;
  styleField(f, 'width', '4'); click(f, action === 'style' ? 'Apply checked styles' : 'Delete selected');
  assert.equal(f.invalidations, 1); assert.equal(f.store.undoStack.length, history + 1); selection(panel, []);
  assert.equal(status(f).textContent, '3 drawings changed.');
  const selected = new Set(['d-0', 'd-34', 'd-69']);
  for (const old of before) {
    const current = f.store.items.find(item => item.id === old.id);
    if (!selected.has(old.id)) assert.strictEqual(current, old);
    else if (action === 'style') {assert.notStrictEqual(current, old); assert.equal(current.style.width, 4); assert.deepEqual(current.points, old.points);}
    else assert.equal(current, undefined);
  }
  assert.equal(f.store.undo(), true); before.forEach((item, index) => assert.strictEqual(f.store.items[index], item));
});

test('only checked style fields are read and patched; normalized no-ops retain selection and history', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); check(f, 1);
  for (const name of ['color', 'fill', 'font']) Object.defineProperty(field(f, name).input, 'value', {
    configurable: true, get() {assert.fail(`Unchecked ${name} must not be read`);},
  });
  styleField(f, 'width', '2'); const stable = unchanged(f); click(f, 'Apply checked styles');
  stable(); selection(panel, ['a', 'b']); assert.equal(status(f).textContent, '0 drawings changed.');
  styleField(f, 'width', '3'); const old = f.store.items.slice(); click(f, 'Apply checked styles'); selection(panel, []);
  for (let i = 0; i < 2; i++) assert.deepEqual(f.store.items[i].style, {...old[i].style, width: 3});
  assert.strictEqual(f.store.items[2], old[2]);
});

for (const [name, value] of [['color', 'red'], ['fill', '#aabbcc'], ['width', '4.5'], ['font', 'italic 18px monospace']]) {
  test(`the checked ${name} text field supplies only its own portable style patch`, t => {
    const h = fixture(t), f = h.create(), panel = f.attach(), before = f.store.items[0].style;
    check(f, 0); styleField(f, name, value); click(f, 'Apply checked styles');
    const normalized = {color: '#ff0000ff', fill: '#aabbccff', width: 4.5, font: 'italic 18px monospace'}[name];
    assert.deepEqual(f.store.items[0].style, {...before, [name]: normalized}); selection(panel, []);
  });
}

for (const name of ['color', 'fill', 'width', 'font']) test(`checked blank ${name} rejects the whole patch and never resets a style`, t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); check(f, 1);
  styleField(f, 'color', 'red'); styleField(f, name, '  ');
  const stable = unchanged(f); click(f, 'Apply checked styles'); stable(); selection(panel, ['a', 'b']);
  assert.match(status(f).textContent, /blanks do not reset/i);
});

test('no checked fields and invalid checked values reject without a partial publication', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); check(f, 1);
  for (const value of [undefined, 'not-a-number', '0', 'Infinity']) {
    field(f, 'width').enabled.checked = value !== undefined;
    field(f, 'width').input.value = value ?? '2';
    const stable = unchanged(f); click(f, 'Apply checked styles'); stable(); selection(panel, ['a', 'b']);
    assert.ok(status(f).textContent.length > 0);
  }
});

test('positive partial style success clears every original selection, including unchanged rows', t => {
  const h = fixture(t), f = h.create([drawing('a'), drawing('b', {style: {width: 3}})]), panel = f.attach();
  const b = f.store.items[1]; check(f, 0); check(f, 1); styleField(f, 'width', '3'); click(f, 'Apply checked styles');
  assert.strictEqual(f.store.items[1], b); assert.equal(status(f).textContent, '1 drawings changed.'); selection(panel, []);
});

for (const action of ['style', 'delete']) test(`${action} rejects mixed locked selections atomically`, t => {
  const h = fixture(t), f = h.create([drawing('a'), drawing('locked', {locked: true})]), panel = f.attach();
  assert.match(list(f).children[1].textContent, /locked/); check(f, 0); check(f, 1); styleField(f, 'width', '4');
  const stable = unchanged(f); click(f, action === 'style' ? 'Apply checked styles' : 'Delete selected');
  stable(); selection(panel, ['a', 'locked']); assert.match(status(f).textContent, /locked/i);
});

for (const action of ['style', 'delete']) for (const stale of ['missing', 'replaced']) {
  test(`${action} rejects a whole stale ${stale} selection before refreshing surviving rows`, t => {
    const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); check(f, 1); styleField(f, 'width', '4');
    if (stale === 'missing') f.store.remove('a'); else f.store.edit('a', {text: 'external edit'});
    selection(panel, ['a', 'b']); const stable = unchanged(f);
    click(f, action === 'style' ? 'Apply checked styles' : 'Delete selected');
    stable(); selection(panel, ['b']); assert.match(status(f).textContent, /changed|refresh/i);
    assert.equal(f.store.items.find(item => item.id === 'b').style.width, 2);
  });
}

test('current-canvas bubbling state refreshes rows and selections; unrelated and old-canvas events do not', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0);
  f.store.edit('a', {text: 'external replacement'}); f.store.add(drawing('new'));
  event(f.container, 'aster:state'); selection(panel, ['a']); assert.equal(boxes(f).length, 3);
  const unrelated = h.node('canvas'); f.container.append(unrelated); event(unrelated, 'aster:state'); selection(panel, ['a']);
  event(f.chart.canvas, 'aster:state'); selection(panel, []); assert.equal(boxes(f).length, 4);
  check(f, 1); const oldCanvas = f.chart.canvas; f.chart.fallback('test replacement');
  assert.notStrictEqual(f.chart.canvas, oldCanvas); selection(panel, ['b']);
  f.store.edit('b', {text: 'later replacement'}); f.container.append(oldCanvas);
  event(oldCanvas, 'aster:state'); selection(panel, ['b']);
  event(f.chart.canvas, 'aster:state'); selection(panel, []);
});

test('state events during an action do not refresh away its original selection before success cleanup', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  let observed;
  f.onInvalidate = () => {observed = panel.selection.snapshot();};
  click(f, 'Apply checked styles');
  assert.deepEqual(observed.selectedIds, ['a']); assert.equal(observed.staleCount, 1);
  selection(panel, []); assert.equal(boxes(f)[0].checked, false); assert.equal(status(f).textContent, '1 drawings changed.');
});

test('a callback-created selection survives the returning older action and its status output', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  const output = status(f), writes = output.writes.length;
  f.onInvalidate = () => {panel.selection.clear(); panel.selection.select('keep');};
  click(f, 'Apply checked styles'); selection(panel, ['keep']); assert.equal(output.writes.length, writes);
  panel.refresh(); assert.equal(boxes(f)[2].checked, true);
  f.onInvalidate = null; styleField(f, 'width', '4'); click(f, 'Apply checked styles');
  assert.equal(f.store.items.find(item => item.id === 'keep').style.width, 4); selection(panel, []);
});

for (const action of ['style', 'delete']) test(`${action} callback disposal and replacement panel survive old cleanup`, t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  const oldRoot = f.panelContainer.children[0], oldStatus = status(f), oldWrites = oldStatus.writes.length;
  let replacement;
  f.onInvalidate = () => {panel.destroy(); replacement = f.attach({label: 'Replacement controls'}); replacement.selection.select('keep'); replacement.refresh();};
  click(f, action === 'style' ? 'Apply checked styles' : 'Delete selected');
  assert.notStrictEqual(f.panelContainer.children[0], oldRoot); selection(replacement, ['keep']);
  assert.equal(oldStatus.writes.length, oldWrites); assert.equal(status(f).textContent, '');
  panel.destroy(); assert.equal(f.panelContainer.children.length, 1);
  assert.equal(descendants(oldRoot).reduce((n, node) => n + node.listenerCount(), 0), 0);
  f.onInvalidate = null; click(f, 'Delete selected'); assert.ok(!f.store.items.some(item => item.id === 'keep'));
});

test('invalidation failure is announced as committed success and never retried or treated as rollback', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  const history = f.store.undoStack.length; f.onInvalidate = () => {throw new Error('observer failed');};
  click(f, 'Apply checked styles');
  assert.equal(f.store.items[0].style.width, 3); assert.equal(f.store.undoStack.length, history + 1);
  assert.equal(f.invalidations, 1); selection(panel, []);
  assert.match(status(f).textContent, /Stored edit succeeded; redraw notification failed\. Do not repeat as a rollback/);
});

test('row focus survives refresh and reordering; disappearance moves it to Refresh drawings', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(), box = check(f, 1); box.focus();
  panel.refresh(); assert.strictEqual(h.document.activeElement, box); assert.strictEqual(boxes(f)[1], box);
  f.store.items = [f.store.items[2], f.store.items[1], f.store.items[0]];
  panel.refresh(); assert.deepEqual(rowIds(f), ['keep', 'b', 'a']); assert.strictEqual(h.document.activeElement, box);
  f.store.remove('b'); panel.refresh(); assert.strictEqual(h.document.activeElement, button(f, 'Refresh drawings'));
  assert.equal(box.listenerCount(), 0);
});

test('paging away from a focused row chooses Refresh, while external focus is never stolen', t => {
  const h = fixture(t), f = h.create(Array.from({length: 33}, (_, i) => drawing(`d-${i}`))), panel = f.attach();
  check(f, 0).focus(); click(f, 'Next page'); assert.strictEqual(h.document.activeElement, button(f, 'Refresh drawings'));
  const external = h.node('input'); external.focus(); panel.refresh(); assert.strictEqual(h.document.activeElement, external);
  f.store.remove('d-32'); panel.refresh(); assert.strictEqual(h.document.activeElement, external);
});

test('action focus callbacks can destroy and remount without old success writes or removal of the replacement', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0).focus();
  const oldRoot = f.panelContainer.children[0], oldStatus = status(f), oldWrites = oldStatus.writes.length;
  let replacement;
  button(f, 'Refresh drawings').onFocus = () => {
    panel.destroy(); replacement = f.attach({label: 'New focus owner'});
    replacement.selection.select('keep'); replacement.refresh();
    status(f).textContent = 'New owner ready.';
  };
  click(f, 'Delete selected');
  assert.notStrictEqual(f.panelContainer.children[0], oldRoot); selection(replacement, ['keep']);
  assert.equal(status(f).textContent, 'New owner ready.'); assert.equal(oldStatus.writes.length, oldWrites);
  panel.destroy(); assert.equal(f.panelContainer.children.length, 1);
});

test('Clear render-focus callback selection and status are not overwritten by the older clear', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0).focus();
  f.store.remove('a');
  button(f, 'Refresh drawings').onFocus = () => {
    panel.selection.select('keep'); panel.refresh(); status(f).textContent = 'New selection ready.';
  };
  click(f, 'Clear selection');
  selection(panel, ['keep']); assert.equal(status(f).textContent, 'New selection ready.');
  assert.match(count(f).textContent, /^1 selected/); assert.equal(boxes(f).at(-1).checked, true);
});

test('action render-focus callback selection and status are not overwritten by the older success', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0).focus();
  button(f, 'Refresh drawings').onFocus = () => {
    panel.selection.select('keep'); panel.refresh(); status(f).textContent = 'New selection ready.';
  };
  click(f, 'Delete selected');
  selection(panel, ['keep']); assert.equal(status(f).textContent, 'New selection ready.');
  assert.match(count(f).textContent, /^1 selected/); assert.equal(boxes(f).at(-1).checked, true);
});

test('refresh text callbacks can remount a panel without stale render writes or orphan listeners', t => {
  const h = fixture(t), f = h.create(), panel = f.attach();
  const oldRoot = f.panelContainer.children[0], text = find(list(f).children[0], node => node.tagName === 'SPAN');
  let replacement;
  text.onText = () => {
    text.onText = null; panel.destroy(); replacement = f.attach({label: 'Replacement during refresh'});
    replacement.selection.select('keep'); replacement.refresh(); status(f).textContent = 'Replacement ready.';
  };
  click(f, 'Refresh drawings');
  selection(replacement, ['keep']); assert.equal(status(f).textContent, 'Replacement ready.');
  assert.notStrictEqual(f.panelContainer.children[0], oldRoot);
  assert.equal(descendants(oldRoot).reduce((n, node) => n + node.listenerCount(), 0), 0);
  panel.destroy(); assert.equal(f.container.listenerCount('aster:state'), 1);
});

test('Refresh focus reentry preserves the status of a newer successful style action', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0).focus();
  f.store.remove('a'); const history = f.store.undoStack.length, refresh = button(f, 'Refresh drawings');
  let focusCalls = 0;
  refresh.onFocus = () => {
    focusCalls++;
    check(f, 0); styleField(f, 'width', '7');
    assert.equal(button(f, 'Apply checked styles').disabled, false);
    click(f, 'Apply checked styles');
    assert.equal(status(f).textContent, '1 drawings changed.');
  };
  click(f, 'Refresh drawings');
  assert.equal(focusCalls, 1); assert.strictEqual(h.document.activeElement, refresh);
  assert.equal(f.store.items.find(item => item.id === 'b').style.width, 7);
  assert.equal(f.store.undoStack.length, history + 1); assert.equal(f.invalidations, 1);
  assert.equal(status(f).textContent, '1 drawings changed.'); selection(panel, []);
});

test('labels and drawing metadata are literal text and never parsed as HTML', t => {
  const h = fixture(t), id = '<img src=x onerror=alert(1)>', label = '<script>bad()</script>';
  const f = h.create([drawing(id, {panel: '<price>'})]); f.attach({label});
  assert.equal(f.panelContainer.children[0].getAttribute('aria-label'), label);
  assert.equal(find(f.panelContainer, node => node.tagName === 'H2').textContent, label);
  assert.match(list(f).children[0].textContent, /<img src=x onerror=alert\(1\)> · horizontal · <price>/);
  assert.ok(!descendants(f.panelContainer).some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'));
});

test('panel controls register no keyboard or composition handlers and leave Tab and IME untouched', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(); check(f, 0);
  const history = f.store.undoStack.length;
  for (const node of [f.panelContainer, ...descendants(f.panelContainer)]) {
    for (const type of ['keydown', 'keyup', 'keypress', 'compositionstart', 'compositionupdate', 'compositionend']) assert.equal(node.listenerCount(type), 0);
  }
  for (const target of [boxes(f)[0], field(f, 'font').input, button(f, 'Delete selected')]) {
    for (const key of ['Tab', 'Delete', 'Backspace', 'Enter', 'z']) for (const isComposing of [false, true]) {
      const emitted = event(target, 'keydown', {key, isComposing}); assert.equal(emitted.defaultPrevented, false);
    }
  }
  selection(panel, ['a']); assert.equal(f.store.undoStack.length, history);
});

for (const owner of ['api', 'model']) test(`a replaced chart ${owner} disables stale handlers and refresh without touching the new owner`, t => {
  const h = fixture(t), f = h.create(), g = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  const original = f.chart[owner], stable = unchanged(f), otherStable = unchanged(g), output = status(f), writes = output.writes.length;
  f.chart[owner] = g.chart[owner];
  try {
    click(f, 'Apply checked styles'); click(f, 'Delete selected'); click(f, 'Clear selection'); check(f, 1);
    event(f.chart.canvas, 'aster:state'); assert.throws(() => panel.refresh(), /owner|disposed/i);
    stable(); otherStable(); assert.equal(output.writes.length, writes); selection(panel, ['a']);
    panel.destroy(); assert.equal(f.panelContainer.children.length, 0);
  } finally {f.chart[owner] = original;}
  f.attach(); assert.equal(f.container.listenerCount('aster:state'), 1);
});

test('post-attach API model replacement disables every stale control before either model is mutated', t => {
  const h = fixture(t), f = h.create(), g = h.create(), panel = f.attach(); check(f, 0); styleField(f, 'width', '3');
  const stable = unchanged(f), otherStable = unchanged(g), output = status(f), writes = output.writes.length;
  const original = f.api.model; f.api.model = g.model;
  try {
    for (const label of ['Apply checked styles', 'Delete selected', 'Clear selection', 'Refresh drawings']) click(f, label);
    check(f, 1); event(f.chart.canvas, 'aster:state');
    assert.throws(() => panel.refresh(), /owner|disposed/i);
    stable(); otherStable(); assert.equal(output.writes.length, writes);
  } finally {f.api.model = original;}
  selection(panel, ['a']); panel.refresh(); assert.equal(boxes(f)[1].checked, false);
});

test('CanvasChart.destroy disposes panel controls, selection, queued frame, and owned listeners', t => {
  const h = fixture(t), f = h.create(), panel = f.attach(), oldControls = descendants(f.panelContainer);
  check(f, 0); const oldDelete = button(f, 'Delete selected'), items = f.store.items;
  assert.equal(f.container.listenerCount('aster:state'), 1); assert.equal(h.frames.size, 1);
  f.chart.destroy(); assert.equal(f.panelContainer.children.length, 0); assert.equal(f.container.listenerCount(), 0);
  assert.ok(oldControls.every(node => node.listenerCount() === 0)); assert.equal(h.frames.size, 0);
  assert.equal(f.model.store.listeners.size, f.baselineListeners); assert.equal(f.renderer.disposed, 1);
  assert.throws(() => panel.selection.snapshot(), /disposed/i); assert.throws(() => panel.refresh(), /disposed/i);
  event(oldDelete, 'click'); assert.strictEqual(f.store.items, items); panel.destroy(); f.chart.destroy();
});

test('repeated mount/unmount removes every row and container listener, including detached pages', t => {
  const h = fixture(t), f = h.create(Array.from({length: 65}, (_, i) => drawing(`d-${i}`)));
  for (let cycle = 0; cycle < 12; cycle++) {
    const panel = f.attach(); check(f, 0); click(f, 'Next page'); check(f, 0); click(f, 'Next page');
    panel.destroy(); panel.destroy();
    assert.equal(f.panelContainer.children.length, 0); assert.equal(f.container.listenerCount(), 0);
    assert.equal(h.elements.reduce((n, node) => n + node.listenerCount(), 0), 0);
  }
});

test('attach, page, selection, refresh, and batch edits do not query data or compute dirty indicators before RAF', t => {
  const h = fixture(t), f = h.create(Array.from({length: 33}, (_, i) => drawing(`d-${i}`)));
  f.api.setData([{time: 1700000000000, open: 1, high: 3, low: 0, close: 2, volume: 5}]);
  let steps = 0;
  f.api.registerIndicator('panel-counter', () => ({outputs: ['value'], plotOffsets: {}, create: () => ({
    step(bar) {steps++; return [bar.close];}, snapshot: () => ({}), restore() {},
  })}));
  f.api.addIndicator('counter', 'panel-counter');
  f.api.addSeries({id: 'counter-line', type: 'line', panel: 'price', indicator: 'counter', output: 'value'});
  f.model.store.update(0, {time: 1700000000000, open: 1, high: 4, low: 0, close: 3, volume: 6}); steps = 0;
  let queries = 0; f.api.dataAt = () => {queries++; assert.fail('Panel must not query plotted data');};
  const panel = f.attach(); check(f, 0); click(f, 'Next page'); check(f, 0); panel.refresh();
  styleField(f, 'width', '3'); click(f, 'Apply checked styles');
  check(f, 0); click(f, 'Delete selected');
  assert.equal(queries, 0); assert.equal(steps, 0); assert.equal(f.renderer.calls, 0); assert.equal(h.frames.size, 1);
});

test('each implicit label contains exactly one labelable control without nested labels',t=>{const h=fixture(t),f=h.create();f.attach();const labels=descendants(f.panelContainer).filter(n=>n.tagName==='LABEL');assert.ok(labels.length>=11);for(const label of labels){const children=descendants(label);assert.equal(children.filter(n=>['INPUT','BUTTON','SELECT','TEXTAREA','METER','OUTPUT','PROGRESS'].includes(n.tagName)).length,1);assert.equal(children.filter(n=>n.tagName==='LABEL').length,0);}for(const name of['color','fill','width','font']){const{enabled,input}=field(f,name);assert.equal(enabled.parentNode.tagName,'LABEL');assert.equal(input.parentNode.tagName,'LABEL');assert.notEqual(enabled.parentNode,input.parentNode);assert.match(input.parentNode.textContent,new RegExp(name+' value'));}});
