import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel, DrawingStore, InteractionController, buildScene} from '../src/core/index.mjs';

// Expected values are intentionally independent of the style decoder, planner,
// drawingPointCount, and DrawingStore.edit. In particular this oracle distinguishes
// stored values from equivalent rendered colors and absent keys from defaults.
const TYPES = [
  ['trendline', 2], ['horizontal', 1], ['fibonacci', 2], ['rectangle', 2],
  ['ellipse', 2], ['text', 1], ['ray', 2], ['extendedline', 2],
  ['channel', 3], ['fibextension', 3], ['fibfan', 2], ['fibtimezones', 2],
  ['freehand', 7], ['measurement', 2],
];
const PATCH = Object.freeze({color: ' RED ', fill: '#aBc8', width: 3.25, font: '  italic 24px monospace  '});
const NORMALIZED = Object.freeze({color: '#ff0000ff', fill: '#aabbcc88', width: 3.25, font: 'italic 24px monospace'});
const horizontal = (extra = {}) => ({type: 'horizontal', panel: 'price', points: [{time: 1700000000000.125, price: 12.25}], ...extra});
const merged = (drawing, patch) => ({...drawing, style: {...drawing.style, ...patch}});
const bytes = items => items.length * 8 + items.reduce((sum, d) => sum + JSON.stringify(d).length * 2, 0);

function fixture(t, limits) {
  const model = new ChartModel();
  if (limits) model.drawings = new DrawingStore(limits);
  const input = new InteractionController(model, () => ({width: 800, height: 500}));
  const f = {model, input, store: model.drawings, invalidations: 0, onInvalidate: null, restores: []};
  f.api = new ChartAPI(model, {controller: input, invalidate() {f.invalidations++; f.onInvalidate?.();}});
  t.after(() => {for (const restore of f.restores.reverse()) restore(); model.dispose();});
  return f;
}
function requireStyling(f) {
  assert.equal(typeof f.api.setDrawingsStyle, 'function', 'ChartAPI.setDrawingsStyle must exist');
}
function apply(f, ids, patch) {
  requireStyling(f);
  return f.api.setDrawingsStyle(ids, patch);
}

// Descriptor snapshots preserve identity and content without evaluating getters.
function preserveObjects(...roots) {
  const seen = new Set(), records = [], maps = [], sets = [], vectors = [];
  function capture(value, recurse = true) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {vectors.push([value, Array.from(value)]); return;}
    if (value instanceof Map) {
      maps.push([value, [...value]]);
      for (const [key, item] of value) {capture(key); capture(item);}
      return;
    }
    if (value instanceof Set) {sets.push([value, [...value]]); return;}
    const descriptors = Object.getOwnPropertyDescriptors(value);
    records.push([value, descriptors]);
    if (recurse) for (const d of Object.values(descriptors)) {
      if (!Object.hasOwn(d, 'value') || !d.value || typeof d.value !== 'object') continue;
      const child = d.value, proto = Object.getPrototypeOf(child);
      if (Array.isArray(child) || proto === Object.prototype || proto === null ||
          child instanceof Map || child instanceof Set || ArrayBuffer.isView(child)) capture(child);
    }
  }
  for (const root of roots) Array.isArray(root) && root.length === 2 && typeof root[1] === 'boolean'
    ? capture(root[0], root[1]) : capture(root);
  return () => {
    for (const [value, before] of records) {
      const after = Object.getOwnPropertyDescriptors(value);
      assert.deepEqual(Reflect.ownKeys(after), Reflect.ownKeys(before), 'own state fields remain unchanged');
      for (const key of Reflect.ownKeys(before)) for (const attribute of ['enumerable', 'configurable', 'writable', 'get', 'set', 'value']) {
        assert.strictEqual(after[key][attribute], before[key][attribute], `${String(key)} ${attribute} remains unchanged`);
      }
    }
    for (const [map, entries] of maps) {
      assert.equal(map.size, entries.length);
      [...map].forEach(([key, value], i) => {assert.strictEqual(key, entries[i][0]); assert.strictEqual(value, entries[i][1]);});
    }
    for (const [set, values] of sets) assert.deepEqual([...set], values);
    for (const [vector, values] of vectors) assert.deepEqual(Array.from(vector), values);
  };
}
function unchangedState(f) {
  const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
  const preserve = preserveObjects(f.store, [f.model, false], [f.api, false], [f.input, false],
    ...['panels', 'axes', 'series', 'view', 'crosshair'].map(key => own(f.model, key)),
    own(f.input, 'gesture'), own(f.input, 'drawingTarget'), own(f.input, 'pointers'));
  const invalidations = f.invalidations;
  return () => {preserve(); assert.equal(f.invalidations, invalidations, 'rejection/no-op must not invalidate');};
}
function rejectUnchanged(f, ids, patch = PATCH) {
  // Outside assert.throws: an absent method cannot make rejection tests pass.
  requireStyling(f);
  const unchanged = unchangedState(f);
  try {assert.throws(() => f.api.setDrawingsStyle(ids, patch));}
  finally {unchanged();}
}
function withRedo(f, extra = {}) {
  const id = f.store.add(horizontal({text: 'committed', style: {...NORMALIZED}, ...extra}));
  f.store.edit(id, {text: 'redo branch'});
  assert.equal(f.store.undo(), true);
  f.store.selected = id;
  assert.ok(f.store.undoStack.length && f.store.redoStack.length);
  return id;
}
function assertReferences(actual, expected) {
  assert.deepEqual(actual, expected);
  expected.forEach((d, i) => assert.strictEqual(actual[i], d, `drawing ${i} retains identity/order`));
}
function assertFrozen(drawing) {
  assert.ok(Object.isFrozen(drawing));
  assert.ok(Object.isFrozen(drawing.points));
  assert.ok(drawing.points.every(Object.isFrozen));
  if (drawing.style) assert.ok(Object.isFrozen(drawing.style));
}
function poison(f, object, key, getter) {
  const before = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, {configurable: true, enumerable: before?.enumerable ?? true, get: getter});
  f.restores.push(() => before ? Object.defineProperty(object, key, before) : delete object[key]);
}

test('style oracle: all 14 types merge normalized keys in one undo unit, preserving anchors, order and unrelated records', t => {
  const f = fixture(t), ids = [];
  for (const [type, count] of TYPES) {
    f.store.add(horizontal({id: `keep-${type}`, text: 'locked survivor', locked: true}));
    ids.push(f.store.add({
      type, panel: 'price', text: `${type} annotation`, locked: false,
      style: {color: '#abcdef', fill: '#12345678', width: 2, font: '13px monospace'},
      points: Array.from({length: count}, (_, i) => ({time: 1700000000000.125 + i * .5, price: .1 + i * 3.25})),
    }));
  }
  f.store.selected = ids[8];
  const target = f.input.drawingTarget = {panel: 'price', axisId: 'orphan-axis'};
  const before = f.store.items.slice(), history = f.store.undoStack.slice(), serial = f.store.serial;
  const held = preserveObjects(before), expected = before.map(d => ids.includes(d.id) ? merged(d, NORMALIZED) : d);
  assert.deepEqual(apply(f, Object.freeze(ids.slice().reverse()), PATCH), {changed: 14, invalidationFailed: false});
  assert.deepEqual(f.store.items, expected, 'independent literal merge oracle');
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.selected, ids[8]);
  assert.equal(f.store.serial, serial);
  assert.strictEqual(f.input.drawingTarget, target);
  assert.equal(f.store.undoStack.length, history.length + 1);
  history.forEach((snapshot, i) => assertReferences(f.store.undoStack[i], snapshot));
  assertReferences(f.store.undoStack.at(-1), before);
  assert.deepEqual(f.store.redoStack, []);
  f.store.items.forEach((d, i) => {
    assertFrozen(d);
    if (!ids.includes(d.id)) assert.strictEqual(d, before[i]);
    else {assert.notStrictEqual(d, before[i]); assert.notStrictEqual(d.style, before[i].style);}
  });
  held();
  const committed = f.store.items.slice();
  assert.equal(f.store.undo(), true);
  assertReferences(f.store.items, before);
  assert.equal(f.store.selected, null);
  assert.equal(f.store.redo(), true);
  assertReferences(f.store.items, committed);
  assert.equal(f.store.selected, null);
  assert.equal(f.store.serial, serial);
});

for (const count of [1, 128]) test(`style oracle: accepts ${count} distinct explicit IDs, including a 128-character ID`, t => {
  const f = fixture(t);
  const ids = Array.from({length: count}, (_, i) => f.store.add(horizontal({id: i === 0 ? 'x'.repeat(128) : `target-${i}`})));
  const before = f.store.items.slice();
  assert.deepEqual(apply(f, ids.slice().reverse(), {width: .1}), {changed: count, invalidationFailed: false});
  assert.deepEqual(f.store.items, before.map(d => merged(d, {width: .1})));
  assert.equal(f.invalidations, 1);
});

test('style oracle: 2048-point freehand retains every fractional anchor', t => {
  const f = fixture(t), id = f.store.add({type: 'freehand', points: Array.from({length: 2048}, (_, i) => ({time: i + .125, price: i * .3}))});
  const held = f.store.items[0], unchanged = preserveObjects(held);
  assert.deepEqual(apply(f, [id], {width: 50}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], merged(held, {width: 50}));
  unchanged();
});

for (const [key, input, expected] of [
  ['color', '#aBc', '#aabbccff'], ['color', '#AbCdEf', '#abcdefff'],
  ['color', '#AbCdEf80', '#abcdef80'], ['color', ' Navy ', '#000080ff'],
  ['color', 'rgb(1, 2, 3)', '#010203ff'], ['fill', 'rgba(255, 0, 128, 0.5)', '#ff008080'],
  ['fill', 'transparent', '#00000000'], ['fill', '#f00a', '#ff0000aa'],
  ['font', '  bold italic 4px monospace ', 'bold italic 4px monospace'],
  ['font', ' 96px "Open Sans", sans-serif ', '96px "Open Sans", sans-serif'],
  ['font', ' 12.5px serif ', '12.5px serif'], ['width', .1, .1], ['width', 50, 50],
]) test(`style oracle: ${key} ${JSON.stringify(input)} has explicit portable normalization`, t => {
  const f = fixture(t), id = f.store.add(horizontal({style: {color: '#10203040', fill: '#50607080', width: 2, font: '13px monospace'}}));
  const before = f.store.items[0], request = Object.freeze({[key]: input});
  assert.deepEqual(apply(f, [id], request), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], merged(before, {[key]: expected}));
});

test('style oracle: null-prototype own-data patch is accepted and copied', t => {
  const f = fixture(t), id = f.store.add(horizontal()), patch = Object.assign(Object.create(null), {color: 'red', width: 5});
  const before = f.store.items[0];
  assert.deepEqual(apply(f, [id], patch), {changed: 1, invalidationFailed: false});
  patch.color = 'blue'; patch.width = 1;
  assert.deepEqual(f.store.items[0], merged(before, {color: '#ff0000ff', width: 5}));
});

test('style oracle: only supplied keys are decoded; omitted low-level HSL, fill and font survive byte-for-byte', t => {
  const f = fixture(t), id = f.store.add(horizontal({style: {color: 'hsl(240, 100%, 50%)', fill: 'var(--fill)', font: ' 13px monospace ', width: 2}}));
  const before = f.store.items[0];
  assert.deepEqual(apply(f, [id], {width: 3}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], merged(before, {width: 3}));
  assert.deepEqual(apply(f, [id], {color: 'red'}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], merged(before, {width: 3, color: '#ff0000ff'}));
});

for (const patch of [PATCH, {color: '#ff0000'}, {fill: '#ABC8'}, {width: 3.25}, {font: ' italic 24px monospace '}]) {
  test(`style oracle: equal normalized stored keys are a no-op with redo and selection intact (${Object.keys(patch)})`, t => {
    const f = fixture(t), id = withRedo(f), unchanged = unchangedState(f);
    f.onInvalidate = () => {throw new Error('no-op must not notify');};
    assert.deepEqual(apply(f, [id], patch), {changed: 0, invalidationFailed: false});
    unchanged();
  });
}

test('style oracle: changed counts stored-value changes, not requested IDs, changed keys, or rendered equivalence', t => {
  const f = fixture(t);
  const same = f.store.add(horizontal({style: {color: '#aabbccff', width: 1.5}}));
  const equivalent = f.store.add(horizontal({style: {color: '#aabbcc', width: 1.5}}));
  const missingColor = f.store.add(horizontal({style: {width: 1.5}}));
  const before = f.store.items.slice();
  assert.deepEqual(apply(f, [missingColor, equivalent, same], {color: '#aBc', width: 1.5}), {changed: 2, invalidationFailed: false});
  assert.strictEqual(f.store.items[0], before[0]);
  assert.deepEqual(f.store.items.slice(1), before.slice(1).map(d => merged(d, {color: '#aabbccff', width: 1.5})));
  assert.equal(f.invalidations, 1);
});

for (const style of [undefined, {}, {color: '#abcdef'}]) test(`style oracle: absent width becomes an explicit default (${JSON.stringify(style)})`, t => {
  const f = fixture(t), id = f.store.add(horizontal({style})), before = f.store.items[0];
  assert.equal(Object.hasOwn(before.style ?? {}, 'width'), false);
  assert.deepEqual(apply(f, [id], {width: 1.5}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], merged(before, {width: 1.5}));
});

const invalidIds = [
  ['omitted', () => undefined], ['null', () => null], ['empty', () => []], ['string', id => id],
  ['set', id => new Set([id])], ['typed array', () => new Uint8Array([1])],
  ['array-like', id => ({0: id, length: 1})], ['duplicate', id => [id, id]],
  ['missing member', id => [id, 'missing']], ['all missing', () => ['missing']],
  ['empty ID', id => [id, '']], ['numeric ID', id => [id, 1]], ['null ID', id => [id, null]],
  ['undefined ID', id => [id, undefined]], ['symbol ID', id => [id, Symbol('id')]],
  ['oversize ID', id => [id, 'x'.repeat(129)]],
  ...['__proto__', 'constructor', 'prototype'].map(name => [`reserved ${name}`, id => [id, name]]),
  ['sparse array', id => {const ids = [id]; ids.length = 2; return ids;}],
  ['array subclass', id => new (class extends Array {})(id)],
  ['custom array prototype', id => Object.setPrototypeOf([id], Object.create(Array.prototype))],
  ['null array prototype', id => Object.setPrototypeOf([id], null)],
  ['extra field', id => Object.assign([id], {extra: true})],
  ['hidden field', id => Object.defineProperty([id], 'extra', {value: true})],
  ['symbol field', id => Object.assign([id], {[Symbol('extra')]: true})],
];
for (const [name, make] of invalidIds) test(`style oracle: ${name} IDs reject atomically`, t => {
  const f = fixture(t), id = withRedo(f);
  rejectUnchanged(f, make(id));
});

test('style oracle: 129 existing unique IDs reject before changing any record', t => {
  const f = fixture(t), ids = Array.from({length: 129}, (_, i) => f.store.add(horizontal({id: `target-${i}`})));
  rejectUnchanged(f, ids);
});

const invalidPatches = [
  ['omitted', undefined], ['null', null], ['empty', {}], ['array', ['red']], ['string', 'red'],
  ['class instance', new (class Patch {constructor() {this.width = 2;}})()],
  ['inherited value', Object.create({width: 2})], ['nested style', {style: {width: 2}}],
  ['unknown field', {width: 2, opacity: .5}],
  ['symbol field', {width: 2, [Symbol('extra')]: true}],
  ['hidden field', Object.defineProperty({width: 2}, 'color', {value: 'red'})],
  ...['__proto__', 'prototype', 'constructor'].map(key => [`reserved ${key}`, JSON.parse(`{"${key}":"red"}`)]),
  ...['color', 'fill', 'width', 'font'].flatMap(key => [null, undefined].map(value => [`${key}=${String(value)}`, {[key]: value}])),
  ...[0, -0, -.1, .099999, 50.000001, NaN, Infinity, -Infinity, '2', 2n, true].map(value => [`width=${String(value)}`, {width: value}]),
  ...['hsl(0, 100%, 50%)', 'var(--color)', 'rebeccapurple', 'color(display-p3 1 0 0)', '', '#12', '#gggggg', 'rgb(256, 0, 0)', 'rgba(0,0,0,1.1)'].flatMap(value => ['color', 'fill'].map(key => [`${key}=${value}`, {[key]: value}])),
  ...['3.99px monospace', '96.01px monospace', '12pt serif', '12px', '', '12px var(--font)', '12px serif; color:red'].map(value => [`font=${value}`, {font: value}]),
];
for (const [name, patch] of invalidPatches) test(`style oracle: invalid patch ${name} rejects without changing history`, t => {
  const f = fixture(t), id = withRedo(f);
  // Preserve an explicitly omitted second argument rather than helper defaults.
  requireStyling(f);
  const unchanged = unchangedState(f);
  try {assert.throws(() => f.api.setDrawingsStyle([id], patch));}
  finally {unchanged();}
});

for (const kind of ['index accessor', 'inherited index', 'extra ID accessor', 'ID toJSON', 'ID iterator', 'coercible ID', 'color', 'fill', 'width', 'font', 'inherited patch', 'patch toJSON', 'coercible value']) {
  test(`style oracle: ${kind} rejects without evaluating user code or reentry`, t => {
    const f = fixture(t), id = withRedo(f);
    let calls = 0, ids = [id], patch = {...PATCH};
    const callback = () => {calls++; f.api.selectDrawing(null); return kind === 'width' ? 2 : 'red';};
    if (kind === 'index accessor') Object.defineProperty(ids, '0', {enumerable: true, get: callback});
    else if (kind === 'inherited index') ids = Object.setPrototypeOf(new Array(1), Object.create(Array.prototype, {'0': {get: callback}}));
    else if (kind === 'extra ID accessor') Object.defineProperty(ids, 'extra', {get: callback});
    else if (kind === 'ID toJSON' || kind === 'ID iterator') Object.defineProperty(ids, kind === 'ID iterator' ? Symbol.iterator : 'toJSON', {get: callback});
    else if (kind === 'coercible ID') ids = [id, {toString: callback, valueOf: callback, toJSON: callback}];
    else if (kind === 'inherited patch') patch = Object.create({get width() {return callback();}}, {color: {value: 'red', enumerable: true}});
    else if (kind === 'patch toJSON') Object.defineProperty(patch, 'toJSON', {get: callback});
    else if (kind === 'coercible value') patch = {color: {toString: callback, valueOf: callback, toJSON: callback}};
    else Object.defineProperty(patch, kind, {enumerable: true, get: callback});
    rejectUnchanged(f, ids, patch);
    assert.equal(calls, 0);
  });
}

for (const noOp of [false, true]) {
  const patch = noOp ? PATCH : {width: 4};
  test(`style oracle: locked batch member rejects even when normalized values already match (${noOp})`, t => {
    const f = fixture(t), id = withRedo(f), locked = f.store.add(horizontal({locked: true, style: {...NORMALIZED}}));
    rejectUnchanged(f, [id, locked], patch);
    rejectUnchanged(f, [locked, id], patch);
  });
  test(`style oracle: missing member rejects even a normalized no-op (${noOp})`, t => {
    const f = fixture(t), id = withRedo(f);
    rejectUnchanged(f, [id, 'missing'], patch);
  });
  test(`style oracle: manual transaction rejects without cancelling or committing (${noOp})`, t => {
    const f = fixture(t), id = withRedo(f);
    f.store.begin(); f.store.edit(id, {text: 'pending preview'});
    rejectUnchanged(f, [id], patch);
  });
  for (const kind of ['pan', 'pinch', 'wait', 'create', 'edit']) test(`style oracle: active ${kind} gesture preserves pointer ownership on rejection (${noOp})`, t => {
    const f = fixture(t), id = withRedo(f);
    f.input.gesture = {kind, id, view: {...f.model.view}, follow: f.model.follow};
    f.input.pointers.set(17, {x: 120, y: 80});
    rejectUnchanged(f, [id], patch);
  });
}

test('style oracle: mixed and orphan bindings are preserved, including explicit null and absent fields', t => {
  const f = fixture(t), bindings = [
    {}, {panel: 'secondary'}, {axisId: 'axis-a'}, {axisId: 'axis-b'},
    {axisId: 'axis-a', seriesId: 'series-a'}, {axisId: 'axis-b', seriesId: 'series-b'},
    {panel: 'removed-panel', axisId: 'removed-axis', seriesId: 'removed-series'},
    {panel: 'price', seriesId: 'also-removed'},
  ];
  const ids = bindings.map(binding => f.store.add(horizontal({...binding, text: 'kept', style: {width: 2}})));
  f.store.items[1] = Object.freeze({...f.store.items[1], axisId: null, seriesId: null});
  const before = f.store.items.slice();
  assert.deepEqual(apply(f, ids.slice().reverse(), {width: 4}), {changed: ids.length, invalidationFailed: false});
  assert.deepEqual(f.store.items, before.map(d => merged(d, {width: 4})));
  assert.equal(f.store.undo(), true); assertReferences(f.store.items, before);
});

test('style oracle: no live metadata, drawing-target, source, or indicator query is needed', t => {
  const f = fixture(t), id = f.store.add(horizontal({panel: 'gone-panel', axisId: 'gone-axis', seriesId: 'gone-series'}));
  let calls = 0;
  const forbidden = () => {calls++; throw new Error('metadata must not be queried');};
  for (const key of ['panels', 'axes', 'series', 'indicators', 'store', 'validateDrawingBinding', 'seriesData']) poison(f, f.model, key, forbidden);
  poison(f, f.input, 'drawingTarget', forbidden);
  assert.deepEqual(apply(f, [id], {width: 4}), {changed: 1, invalidationFailed: false});
  assert.equal(calls, 0);
});

test('style oracle: indicator buffers, dirty checkpoints and source events remain untouched', t => {
  const f = fixture(t), source = f.model.store, engine = f.model.indicators;
  source.setData(Array.from({length: 8}, (_, i) => ({time: 1000 + i, open: 10, high: 12, low: 9, close: 11, volume: 20 + i})));
  let callbacks = 0, sourceEvents = 0;
  engine.register('tracked', () => {
    callbacks++;
    return {outputs: ['value'], create() {
      callbacks++;
      return {step(bar) {callbacks++; return [bar.close];}, snapshot() {callbacks++; return {};}, restore() {callbacks++;}};
    }};
  });
  engine.add('tracked-study', 'tracked');
  f.model.addSeries({id: 'study-series', type: 'line', panel: 'price', indicator: 'tracked-study'});
  const series = f.model.series.at(-1);
  f.model.seriesData(series);
  source.update(0, {...source.at(0), volume: 99});
  const a = f.store.add(horizontal({seriesId: 'study-series'})), b = f.store.add(horizontal({panel: 'gone', seriesId: 'gone-series'}));
  source.subscribe(() => sourceEvents++); callbacks = 0;
  const unchanged = preserveObjects(source, source.index, engine, series, series.rangeIndex, f.model.panels, f.model.axes, f.model.series, f.model.view, f.model.crosshair);
  assert.deepEqual(apply(f, [b, a], {width: 4}), {changed: 2, invalidationFailed: false});
  unchanged(); assert.equal(callbacks, 0); assert.equal(sourceEvents, 0); assert.equal(f.invalidations, 1);
});

test('style oracle: whole prior snapshot must fit the undo budget, including unrelated records', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.add(horizontal({id: 'unrelated', text: 'large unrelated annotation '.repeat(60)}));
  f.store.historyBytes = bytes(f.store.items) - 1; f.store.trim();
  assert.ok(bytes([f.store.items[0]]) < f.store.historyBytes);
  rejectUnchanged(f, [id], {width: 4});
});

test('style oracle: normalized no-op can retain redo when the current snapshot exceeds the undo budget', t => {
  const f = fixture(t), id = f.store.add(horizontal({style: {...NORMALIZED}, text: 'long committed text '.repeat(40)}));
  f.store.edit(id, {text: 'short redo'}); f.store.undo(); f.store.selected = id;
  f.store.historyBytes = bytes(f.store.items) - 1; f.store.trim();
  assert.equal(f.store.redoStack.length, 1);
  const unchanged = unchangedState(f);
  assert.deepEqual(apply(f, [id], PATCH), {changed: 0, invalidationFailed: false});
  unchanged();
});

test('style oracle: exact byte budget trims older history and clears redo before the single notification', t => {
  const f = fixture(t), id = f.store.add(horizontal({text: 'first'}));
  f.store.edit(id, {text: 'second, longer'}); f.store.edit(id, {text: 'third, much longer '.repeat(30)});
  f.store.edit(id, {text: 'short redo'}); f.store.undo(); f.store.selected = id;
  const before = f.store.items.slice(), serial = f.store.serial;
  f.store.historyBytes = bytes(before); f.store.trim();
  let observed = false;
  f.onInvalidate = () => {
    observed = true;
    assert.equal(f.store.undoStack.length, 1); assertReferences(f.store.undoStack[0], before);
    assert.equal(f.store.redoStack.length, 0); assert.equal(f.store.retainedHistoryBytes, f.store.historyBytes);
    assert.equal(f.store.selected, id); assert.equal(f.store.serial, serial);
  };
  assert.deepEqual(apply(f, [id], {width: 4}), {changed: 1, invalidationFailed: false});
  assert.equal(observed, true); assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true); assertReferences(f.store.items, before);
});

test('style oracle: historyLimit retains exactly one grouped undo snapshot', t => {
  const f = fixture(t, {historyLimit: 1}), a = f.store.add(horizontal()), b = f.store.add(horizontal()), before = f.store.items.slice();
  assert.deepEqual(apply(f, [a, b], PATCH), {changed: 2, invalidationFailed: false});
  assert.equal(f.store.undoStack.length, 1); assertReferences(f.store.undoStack[0], before);
  assert.equal(f.store.undo(), true); assertReferences(f.store.items, before);
});

test('style oracle: throwing observer reports committed, undoable success without retrying notification', t => {
  const f = fixture(t), id = withRedo(f), before = f.store.items.slice(), serial = f.store.serial;
  f.onInvalidate = () => {throw new Error('host renderer unavailable');};
  assert.deepEqual(apply(f, [id], {width: 4}), {changed: 1, invalidationFailed: true});
  assert.deepEqual(f.store.items, before.map(d => merged(d, {width: 4})));
  assert.equal(f.store.redoStack.length, 0); assert.equal(f.store.selected, id); assert.equal(f.store.serial, serial); assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true); assertReferences(f.store.items, before);
  assert.equal(f.store.redo(), true); assert.deepEqual(f.store.items, before.map(d => merged(d, {width: 4})));
});

test('style oracle: observer reentry is not overwritten after outer publication', t => {
  const f = fixture(t), id = f.store.add(horizontal()), before = f.store.items.slice(), historyLength = f.store.undoStack.length;
  f.onInvalidate = () => {f.onInvalidate = null; assert.deepEqual(apply(f, [id], {color: 'blue'}), {changed: 1, invalidationFailed: false});};
  assert.deepEqual(apply(f, [id], {width: 4}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items, before.map(d => merged(d, {width: 4, color: '#0000ffff'})));
  assert.equal(f.store.undoStack.length, historyLength + 2); assert.equal(f.invalidations, 2);
  assert.equal(f.store.undo(), true); assert.deepEqual(f.store.items, before.map(d => merged(d, {width: 4})));
  assert.equal(f.store.undo(), true); assertReferences(f.store.items, before);
});

test('style oracle: ordinary normalized styles round-trip through public save/load', t => {
  const f = fixture(t), ids = TYPES.map(([type, count]) => f.store.add({type, panel: 'price', text: `note ${type}`, points: Array.from({length: count}, (_, i) => ({time: 1700000000000.125 + i, price: 10 + i})), style: {width: 2}}));
  const expected = f.store.items.map(d => merged(d, NORMALIZED));
  assert.equal(apply(f, ids, PATCH).changed, 14);
  const saved = f.api.saveDrawings(), doc = JSON.parse(saved);
  assert.deepEqual(doc.drawings, expected);
  const other = fixture(t); other.api.loadDrawings(saved);
  assert.deepEqual(other.store.items, expected);
  other.store.items.forEach(assertFrozen);
});

test('style oracle: final buildScene honors text/font overrides and normalized stroke/fill', t => {
  const f = fixture(t), time = 1700000000000;
  f.model.store.setData(Array.from({length: 5}, (_, i) => ({time: time + i * 1000, open: 10, high: 14, low: 8, close: 11, volume: 1})));
  const a = f.store.add({type: 'text', points: [{time: time + 1000, price: 11}], text: 'style oracle label', style: {font: '13px monospace'}});
  const b = f.store.add({type: 'rectangle', points: [{time: time + 1000, price: 10}, {time: time + 3000, price: 12}], style: {width: 2}});
  f.store.selected = null;
  assert.deepEqual(apply(f, [a, b], PATCH), {changed: 2, invalidationFailed: false});
  const scene = buildScene(f.model, 800, 500, {crosshair: false});
  const label = scene.commands.find(c => c.op === 'text' && c.text === 'style oracle label');
  assert.ok(label, 'drawing label reaches final scene');
  assert.equal(label.font, NORMALIZED.font); assert.equal(label.color, NORMALIZED.color);
  const box = scene.commands.find(c => c.op === 'box' && c.fill === NORMALIZED.fill && c.color === NORMALIZED.color);
  assert.ok(box, 'drawing fill and stroke reach final scene'); assert.equal(box.width, NORMALIZED.width);
});
