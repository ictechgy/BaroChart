import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel, DrawingStore, InteractionController} from '../src/core/index.mjs';

// Independent of drawingPointCount, the group-edit planner, and store.remove.
const TYPES = [
  ['trendline', 2], ['horizontal', 1], ['fibonacci', 2], ['rectangle', 2],
  ['ellipse', 2], ['text', 1], ['ray', 2], ['extendedline', 2],
  ['channel', 3], ['fibextension', 3], ['fibfan', 2], ['fibtimezones', 2],
  ['freehand', 7], ['measurement', 2],
];
const horizontal = (extra = {}) => ({
  type: 'horizontal', panel: 'price', points: [{time: 1700000000000.125, price: 12.25}], ...extra,
});
const without = (drawings, ids) => drawings.filter(drawing => !ids.includes(drawing.id));
// Existing history accounting is a public resource bound, not a deletion helper.
const bytes = snapshot => snapshot.length * 8 + snapshot.reduce((sum, d) => sum + JSON.stringify(d).length * 2, 0);

function fixture(t, limits) {
  const model = new ChartModel();
  if (limits) model.drawings = new DrawingStore(limits);
  const input = new InteractionController(model, () => ({width: 800, height: 500}));
  const f = {model, input, store: model.drawings, invalidations: 0, onInvalidate: null, restores: []};
  f.api = new ChartAPI(model, {controller: input, invalidate() {
    f.invalidations++;
    f.onInvalidate?.();
  }});
  t.after(() => {
    for (const restore of f.restores.reverse()) restore();
    model.dispose();
  });
  return f;
}

function requireDeletion(f) {
  assert.equal(typeof f.api.deleteDrawings, 'function', 'ChartAPI.deleteDrawings must exist');
}
function remove(f, ids) {
  requireDeletion(f);
  return f.api.deleteDrawings(ids);
}

// Capture data descriptors without evaluating poisoned fields. Retain both
// content and identity, including nested history arrays and pointer ownership.
function preserveObjects(...roots) {
  const seen = new Set(), records = [], maps = [], sets = [], vectors = [];
  function capture(value, recurse = true) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      vectors.push([value, Array.from(value)]);
      return;
    }
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
      for (const key of Reflect.ownKeys(before)) {
        for (const attribute of ['enumerable', 'configurable', 'writable', 'get', 'set', 'value']) {
          assert.strictEqual(after[key][attribute], before[key][attribute], `${String(key)} ${attribute} remains unchanged`);
        }
      }
    }
    for (const [map, entries] of maps) {
      assert.equal(map.size, entries.length);
      [...map].forEach(([key, value], i) => {
        assert.strictEqual(key, entries[i][0]);
        assert.strictEqual(value, entries[i][1]);
      });
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
  return () => {preserve(); assert.equal(f.invalidations, invalidations, 'rejection must not invalidate');};
}

function rejectUnchanged(f, ids) {
  // Keep this outside assert.throws: a missing method must never pass a test.
  requireDeletion(f);
  const unchanged = unchangedState(f);
  try {assert.throws(() => f.api.deleteDrawings(ids));}
  finally {unchanged();}
}

function withRedo(f) {
  const id = f.store.add(horizontal({text: 'committed'}));
  f.store.edit(id, {text: 'redo branch'});
  assert.equal(f.store.undo(), true);
  f.store.selected = id;
  assert.ok(f.store.undoStack.length && f.store.redoStack.length);
  return id;
}

function assertSameDrawings(actual, expected) {
  assert.deepEqual(actual, expected, 'independent filtering oracle');
  expected.forEach((drawing, i) => assert.strictEqual(actual[i], drawing, `drawing ${i} retains identity/order`));
}

function freezeDrawing(drawing) {
  drawing.points.forEach(Object.freeze);
  Object.freeze(drawing.points);
  if (drawing.style) Object.freeze(drawing.style);
  return Object.freeze(drawing);
}

function poison(f, object, key, getter) {
  const before = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, {configurable: true, enumerable: before?.enumerable ?? true, get: getter});
  f.restores.push(() => before ? Object.defineProperty(object, key, before) : delete object[key]);
}

test('deletion oracle: all 14 legacy types filter atomically, preserve survivors, and form exactly one undo unit', t => {
  const f = fixture(t), ids = [];
  for (const [type, count] of TYPES) {
    f.store.add(horizontal({id: `keep-${type}`, text: 'survivor'}));
    ids.push(f.store.add({
      type, panel: 'price', text: `${type} annotation`, locked: false,
      style: {color: '#abcdef', fill: '#12345678', width: 2, font: '13px monospace'},
      points: Array.from({length: count}, (_, i) => ({time: 1700000000000.125 + i * 0.5, price: 0.1 + i * 3.25})),
    }));
  }
  f.store.selected = 'keep-channel';
  const target = f.input.drawingTarget = {panel: 'price'};
  const before = f.store.items.slice(), history = f.store.undoStack.slice(), serial = f.store.serial;
  const expected = without(before, ids), held = before.filter(d => ids.includes(d.id));
  const heldContents = JSON.stringify(held), request = Object.freeze(ids.slice().reverse());
  assert.deepEqual(remove(f, request), {changed: 14, invalidationFailed: false});
  assertSameDrawings(f.store.items, expected);
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.selected, 'keep-channel');
  assert.equal(f.store.serial, serial);
  assert.strictEqual(f.input.drawingTarget, target);
  assert.equal(f.store.undoStack.length, history.length + 1);
  history.forEach((snapshot, i) => assertSameDrawings(f.store.undoStack[i], snapshot));
  assertSameDrawings(f.store.undoStack.at(-1), before);
  assert.deepEqual(f.store.redoStack, []);
  for (const drawing of held) {
    assert.ok(Object.isFrozen(drawing));
    assert.ok(Object.isFrozen(drawing.points));
    assert.ok(drawing.points.every(Object.isFrozen));
    assert.ok(Object.isFrozen(drawing.style));
    assert.throws(() => {drawing.points[0].price = 999;}, TypeError);
    assert.throws(() => {drawing.style.width = 20;}, TypeError);
  }
  assert.equal(JSON.stringify(held), heldContents, 'held deleted records remain immutable and unchanged');
  const receiver = new DrawingStore();
  receiver.load(f.store.save());
  assert.deepEqual(receiver.items, expected);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.selected, null, 'existing undo clears selection');
  assert.equal(f.store.undoStack.length, history.length);
  f.store.selected = ids[0];
  assert.equal(f.store.redo(), true);
  assertSameDrawings(f.store.items, expected);
  assert.equal(f.store.selected, null, 'existing redo also clears selection');
  assert.equal(f.store.serial, serial);
  assert.strictEqual(f.input.drawingTarget, target);
});

for (const count of [1, 128]) test(`deletion oracle: accepts ${count} unique explicit IDs, including a 128-character ID`, t => {
  const f = fixture(t);
  const ids = Array.from({length: count}, (_, i) => f.store.add(horizontal({id: i === 0 ? 'x'.repeat(128) : `target-${i}`})));
  const before = f.store.items.slice(), serial = f.store.serial;
  assert.deepEqual(remove(f, Object.freeze(ids.slice().reverse())), {changed: count, invalidationFailed: false});
  assert.deepEqual(f.store.items, []);
  assert.equal(f.store.selected, null);
  assert.equal(f.store.serial, serial);
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assert.deepEqual(f.store.items, []);
});

test('deletion oracle: maximum 2048-point freehand is removable without changing held anchors', t => {
  const f = fixture(t);
  const id = f.store.add({type: 'freehand', points: Array.from({length: 2048}, (_, i) => ({time: i + 0.125, price: i * 0.3}))});
  const held = f.store.items[0], preserve = preserveObjects(held);
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items, []);
  preserve();
  assert.equal(f.store.undo(), true);
  assert.strictEqual(f.store.items[0], held);
});

for (const selection of ['removed', 'survivor', 'null']) test(`deletion oracle: ${selection} selection and drawing target are handled independently`, t => {
  const f = fixture(t), a = f.store.add(horizontal()), b = f.store.add(horizontal());
  const selected = selection === 'removed' ? a : selection === 'survivor' ? b : null;
  f.store.selected = selected;
  const target = f.input.drawingTarget = {panel: 'price', axisId: 'orphan-axis', seriesId: 'orphan-series'};
  const serial = f.store.serial;
  assert.deepEqual(remove(f, [a]), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.selected, selection === 'removed' ? null : selected);
  assert.strictEqual(f.input.drawingTarget, target);
  assert.equal(f.store.serial, serial);
});

test('deletion oracle: unrelated nonwritable selection does not prevent deletion', t => {
  const f = fixture(t), a = f.store.add(horizontal()), b = f.store.add(horizontal());
  Object.defineProperty(f.store, 'selected', {value: b, writable: false});
  assert.deepEqual(remove(f, [a]), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.selected, b);
  assert.deepEqual(f.store.items.map(d => d.id), [b]);
});

test('deletion oracle: selected nonwritable removal rejects before any publication', t => {
  const f = fixture(t), id = withRedo(f);
  Object.defineProperty(f.store, 'selected', {writable: false});
  rejectUnchanged(f, [id]);
});

test('deletion oracle: optional controller is not required', t => {
  const f = fixture(t), id = f.store.add(horizontal());
  f.api.controller = null;
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items, []);
  assert.equal(f.invalidations, 1);
});

const invalidIds = [
  ['omitted', () => undefined], ['null', () => null], ['empty', () => []],
  ['string', () => 'drawing-1'], ['set', () => new Set(['drawing-1'])],
  ['typed array', () => new Uint8Array([1])], ['array-like', () => ({0: 'drawing-1', length: 1})],
  ['duplicate', id => [id, id]], ['missing member', id => [id, 'missing']],
  ['all missing', () => ['missing']], ['empty ID', id => [id, '']],
  ['numeric ID', id => [id, 1]], ['null ID', id => [id, null]],
  ['undefined ID', id => [id, undefined]], ['symbol ID', id => [id, Symbol('id')]],
  ['oversize ID', id => [id, 'x'.repeat(129)]],
  ...['__proto__', 'constructor', 'prototype'].map(name => [`reserved ${name}`, id => [id, name]]),
  ['sparse array', id => {const ids = [id]; ids.length = 2; return ids;}],
  ['array subclass', id => new (class extends Array {})(id)],
  ['custom array prototype', id => Object.setPrototypeOf([id], Object.create(Array.prototype))],
  ['null array prototype', id => Object.setPrototypeOf([id], null)],
  ['extra enumerable field', id => Object.assign([id], {extra: true})],
  ['extra nonenumerable field', id => Object.defineProperty([id], 'extra', {value: true})],
  ['extra symbol field', id => Object.assign([id], {[Symbol('extra')]: true})],
];
for (const [name, make] of invalidIds) test(`deletion oracle: ${name} IDs reject atomically`, t => {
  const f = fixture(t), id = withRedo(f);
  rejectUnchanged(f, make(id));
});

test('deletion oracle: 129 existing unique IDs reject without partial removal', t => {
  const f = fixture(t);
  const ids = Array.from({length: 129}, (_, i) => f.store.add(horizontal({id: `target-${i}`})));
  rejectUnchanged(f, ids);
});

for (const kind of ['index accessor', 'inherited index', 'extra accessor', 'toJSON', 'iterator', 'coercible ID']) {
  test(`deletion oracle: ${kind} rejects without executing input code`, t => {
    const f = fixture(t), id = withRedo(f);
    let calls = 0, ids = [id];
    const callback = () => {calls++; f.api.selectDrawing(null); return id;};
    if (kind === 'index accessor') Object.defineProperty(ids, '0', {enumerable: true, get: callback});
    else if (kind === 'inherited index') {
      ids = new Array(1);
      Object.setPrototypeOf(ids, Object.create(Array.prototype, {'0': {get: callback}}));
    } else if (kind === 'extra accessor') Object.defineProperty(ids, 'extra', {get: callback});
    else if (kind === 'coercible ID') ids = [id, {toString: callback, valueOf: callback, toJSON: callback}];
    else Object.defineProperty(ids, kind === 'iterator' ? Symbol.iterator : 'toJSON', {get: callback});
    rejectUnchanged(f, ids);
    assert.equal(calls, 0);
  });
}

for (const position of ['first', 'last']) test(`deletion oracle: locked ${position} member rejects the whole batch`, t => {
  const f = fixture(t), id = withRedo(f), locked = f.store.add(horizontal({locked: true}));
  rejectUnchanged(f, position === 'first' ? [locked, id] : [id, locked]);
});

test('deletion oracle: an unrelated locked survivor does not block deletion', t => {
  const f = fixture(t), id = f.store.add(horizontal()), locked = f.store.add(horizontal({locked: true}));
  const survivor = f.store.items[1];
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assertSameDrawings(f.store.items, [survivor]);
  assert.equal(f.store.selected, locked);
});

function boundFixture(t) {
  const f = fixture(t);
  f.model.addPanel({id: 'secondary'});
  f.model.addAxis({id: 'axis-a', panel: 'price'});
  f.model.addAxis({id: 'axis-b', panel: 'price'});
  f.model.addSeries({id: 'series-a', type: 'line', panel: 'price', axisId: 'axis-a'});
  f.model.addSeries({id: 'series-b', type: 'line', panel: 'price', axisId: 'axis-b'});
  return f;
}

test('deletion oracle: mixed panel, default/explicit axis, series, and orphan bindings delete as one group', t => {
  const f = boundFixture(t);
  const bindings = [
    {}, {panel: 'secondary'}, {axisId: 'axis-a'}, {axisId: 'axis-b'},
    {axisId: 'axis-a', seriesId: 'series-a'}, {axisId: 'axis-b', seriesId: 'series-b'},
    {panel: 'removed-panel', axisId: 'removed-axis', seriesId: 'removed-series'},
    {panel: 'price', seriesId: 'also-removed'},
  ];
  const ids = bindings.map(binding => f.store.add(horizontal(binding)));
  const before = f.store.items.slice(), serial = f.store.serial;
  const target = f.input.drawingTarget = {...bindings[4], panel: 'price'};
  assert.deepEqual(remove(f, ids.slice().reverse()), {changed: ids.length, invalidationFailed: false});
  assert.deepEqual(f.store.items, []);
  assert.equal(f.store.serial, serial);
  assert.strictEqual(f.input.drawingTarget, target);
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assert.deepEqual(f.store.items, []);
});

for (const [name, retire] of [
  ['panel removed', f => {f.model.panels = [];}],
  ['axis removed', f => {f.model.axes = [];}],
  ['axis moved', f => {f.model.axes[0].panel = 'secondary';}],
  ['series removed', f => f.model.removeSeries('series-a')],
  ['series moved panel', f => {f.model.series[0].panel = 'secondary';}],
  ['series moved axis', f => {f.model.series[0].axisId = 'axis-b';}],
]) test(`deletion oracle: existing orphan after ${name} can be removed and restored`, t => {
  const f = boundFixture(t), id = f.store.add(horizontal({axisId: 'axis-a', seriesId: 'series-a'}));
  const held = f.store.items[0];
  retire(f);
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items, []);
  assert.equal(f.store.undo(), true);
  assert.strictEqual(f.store.items[0], held);
});

test('deletion oracle: even live metadata field access is unnecessary', t => {
  const f = boundFixture(t), id = f.store.add(horizontal({axisId: 'axis-a', seriesId: 'series-a'}));
  let calls = 0;
  const forbidden = () => {calls++; throw new Error('live metadata must not be queried');};
  for (const key of ['panels', 'axes', 'series', 'indicators', 'store', 'validateDrawingBinding', 'seriesData']) poison(f, f.model, key, forbidden);
  poison(f, f.input, 'drawingTarget', forbidden);
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.equal(calls, 0);
  assert.deepEqual(f.store.items, []);
});

test('deletion oracle: source buffers, study checkpoints, output vectors, caches and callbacks remain untouched', t => {
  const f = boundFixture(t), source = f.model.store, engine = f.model.indicators;
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
  f.model.addSeries({id: 'study-series', type: 'line', panel: 'price', axisId: 'axis-a', indicator: 'tracked-study'});
  const studySeries = f.model.series.at(-1);
  f.model.seriesData(studySeries);
  source.update(0, {...source.at(0), volume: 99});
  const a = f.store.add(horizontal({axisId: 'axis-a', seriesId: 'study-series'}));
  const b = f.store.add(horizontal({panel: 'gone-panel', seriesId: 'gone-series'}));
  source.subscribe(() => sourceEvents++);
  callbacks = 0;
  let queries = 0;
  for (const [object, key] of [[engine, 'get'], [engine, 'calculate'], [f.model, 'seriesData'], [f.model, 'validateDrawingBinding']]) {
    poison(f, object, key, () => {queries++; throw new Error('no derived query');});
  }
  const unchanged = preserveObjects(source, source.index, engine, studySeries, studySeries.rangeIndex,
    f.model.panels, f.model.axes, f.model.series, f.model.view, f.model.crosshair);
  assert.deepEqual(remove(f, [b, a]), {changed: 2, invalidationFailed: false});
  unchanged();
  assert.equal(queries, 0);
  assert.equal(callbacks, 0);
  assert.equal(sourceEvents, 0);
  assert.equal(f.invalidations, 1);
});

test('deletion oracle: active manual transaction rejects without cancelling or committing it', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.begin();
  f.store.edit(id, {text: 'pending manual preview'});
  rejectUnchanged(f, [id]);
});

for (const kind of ['pan', 'pinch', 'wait', 'create', 'edit']) test(`deletion oracle: active ${kind} gesture rejects without releasing pointer ownership`, t => {
  const f = fixture(t), id = withRedo(f);
  f.input.gesture = {kind, id, view: {...f.model.view}, follow: f.model.follow};
  f.input.pointers.set(17, {x: 120, y: 80});
  rejectUnchanged(f, [id]);
});

test('deletion oracle: whole previous snapshot must fit, even when only the selected subset fits', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.add(horizontal({id: 'unrelated', text: 'large unrelated annotation '.repeat(60)}));
  f.store.historyBytes = bytes(f.store.items) - 1;
  f.store.trim();
  assert.ok(bytes([f.store.items[0]]) < f.store.historyBytes);
  rejectUnchanged(f, [id]);
});

test('deletion oracle: deleting every drawing still requires room for the full undo snapshot', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.historyBytes = 0;
  f.store.trim();
  rejectUnchanged(f, [id]);
});

test('deletion oracle: exact byte budget trims old undo and clears redo before a single notification', t => {
  const f = fixture(t), id = f.store.add(horizontal({text: 'first'}));
  f.store.edit(id, {text: 'second'});
  f.store.edit(id, {text: 'third, much longer '.repeat(30)});
  f.store.edit(id, {text: 'short redo'});
  assert.equal(f.store.undo(), true);
  f.store.selected = id;
  const before = f.store.items.slice(), serial = f.store.serial;
  f.store.historyBytes = bytes(before);
  f.store.trim();
  assert.ok(f.store.undoStack.length || f.store.redoStack.length);
  f.onInvalidate = () => {
    assert.deepEqual(f.store.items, []);
    assert.equal(f.store.undoStack.length, 1);
    assertSameDrawings(f.store.undoStack[0], before);
    assert.deepEqual(f.store.redoStack, []);
    assert.equal(f.store.retainedHistoryBytes, f.store.historyBytes);
    assert.equal(f.store.selected, null);
    assert.equal(f.store.serial, serial);
  };
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assert.deepEqual(f.store.items, []);
});

for (const limit of [1, 2]) test(`deletion oracle: historyLimit ${limit} retains a bounded grouped undo`, t => {
  const f = fixture(t, {historyLimit: limit}), ids = [];
  for (let i = 0; i < 5; i++) ids.push(f.store.add(horizontal()));
  const before = f.store.items.slice(), subset = [ids[3], ids[1]], expected = without(before, subset);
  assert.deepEqual(remove(f, subset), {changed: 2, invalidationFailed: false});
  assert.equal(f.store.undoStack.length, limit);
  assertSameDrawings(f.store.undoStack.at(-1), before);
  assert.equal(f.store.retainedHistoryBytes, f.store.undoStack.reduce((sum, snapshot) => sum + bytes(snapshot), 0));
  assert.ok(f.store.retainedHistoryBytes <= f.store.historyBytes);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assertSameDrawings(f.store.items, expected);
});

for (const [name, patch] of [
  ['unknown type', {type: 'unknown'}], ['wrong anchor count', {points: []}],
  ['nonfinite time', {points: [{time: NaN, price: 1}]}],
  ['out-of-range time', {points: [{time: 8640000000000001, price: 1}]}],
  ['nonfinite price', {points: [{time: 1, price: Infinity}]}],
  ['nonnumeric price', {points: [{time: 1, price: '1'}]}],
  ['invalid panel ID', {panel: '__proto__'}], ['invalid binding ID', {seriesId: ''}],
  ['invalid locked flag', {locked: 'yes'}], ['unknown field', {extra: true}],
]) for (const location of ['requested', 'survivor', 'undo']) test(`deletion oracle: immutable invalid ${name} in ${location} rejects atomically`, t => {
  const f = fixture(t), id = withRedo(f);
  const other = f.store.add(horizontal());
  const corrupt = freezeDrawing({...f.store.items[1], ...patch});
  if (location === 'undo') f.store.undoStack.push([corrupt]);
  else f.store.items[1] = corrupt;
  rejectUnchanged(f, location === 'requested' ? [id, other] : [id]);
});

for (const part of ['record', 'points', 'point', 'style']) test(`deletion oracle: mutable current ${part} rejects even if being deleted`, t => {
  const f = fixture(t), id = withRedo(f), original = f.store.items[0];
  const changed = {...original};
  if (part === 'points') changed.points = original.points.slice();
  if (part === 'point') changed.points = Object.freeze([{...original.points[0]}]);
  if (part === 'style') changed.style = {...original.style};
  f.store.items[0] = part === 'record' ? changed : Object.freeze(changed);
  rejectUnchanged(f, [id]);
});

test('deletion oracle: duplicate current IDs reject before filtering', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.items.push(f.store.items[0]);
  rejectUnchanged(f, [id]);
});

for (const [owner, key] of [
  ['api', 'model'], ['api', 'controller'], ['api', 'invalidate'],
  ['model', 'drawings'], ['model', 'disposed'], ['input', 'model'], ['input', 'gesture'],
  ['store', 'items'], ['store', 'undoStack'], ['store', 'redoStack'], ['store', 'selected'],
  ['store', 'serial'], ['store', 'transaction'], ['store', 'historyBytes'], ['store', 'retainedHistoryBytes'],
]) test(`deletion oracle: ${owner}.${key} accessor rejects without invocation or reentry`, t => {
  const f = fixture(t), id = withRedo(f);
  let calls = 0;
  poison(f, f[owner], key, () => {calls++; throw new Error('owner accessor must not run');});
  rejectUnchanged(f, [id]);
  assert.equal(calls, 0);
});

for (const key of ['items', 'undoStack', 'redoStack', 'retainedHistoryBytes']) test(`deletion oracle: nonwritable ${key} rejects before any store field changes`, t => {
  const f = fixture(t), id = withRedo(f);
  Object.defineProperty(f.store, key, {writable: false});
  rejectUnchanged(f, [id]);
});

test('deletion oracle: absent history accounting on a nonextensible store rejects atomically', t => {
  const f = fixture(t), id = withRedo(f);
  delete f.store.retainedHistoryBytes;
  Object.preventExtensions(f.store);
  rejectUnchanged(f, [id]);
});

test('deletion oracle: controller bound to another model rejects', t => {
  const f = fixture(t), id = withRedo(f), other = new ChartModel();
  t.after(() => other.dispose());
  f.input.model = other;
  rejectUnchanged(f, [id]);
});

test('deletion oracle: an unmanaged drawing store rejects', t => {
  const f = fixture(t), id = withRedo(f);
  f.model.drawings = {...f.store};
  rejectUnchanged(f, [id]);
});

test('deletion oracle: disposed owner rejects', t => {
  const f = fixture(t), id = withRedo(f);
  f.model.dispose();
  rejectUnchanged(f, [id]);
});

for (const field of ['items', 'undoStack', 'redoStack']) for (const shape of ['extra', 'sparse', 'prototype', 'accessor']) {
  test(`deletion oracle: ${field} ${shape} array rejects without getter execution`, t => {
    const f = fixture(t), id = withRedo(f), array = f.store[field];
    let calls = 0;
    if (shape === 'extra') array.extra = true;
    if (shape === 'sparse') delete array[0];
    if (shape === 'prototype') Object.setPrototypeOf(array, Object.create(Array.prototype));
    if (shape === 'accessor') Object.defineProperty(array, '0', {get() {calls++; throw new Error('array accessor');}});
    rejectUnchanged(f, [id]);
    assert.equal(calls, 0);
  });
}

test('deletion oracle: an accessor inside a prior undo snapshot rejects without running it', t => {
  const f = fixture(t), id = withRedo(f);
  let calls = 0;
  const snapshot = [f.store.items[0]];
  Object.defineProperty(snapshot, '0', {get() {calls++; throw new Error('history accessor');}});
  f.store.undoStack.push(snapshot);
  rejectUnchanged(f, [id]);
  assert.equal(calls, 0);
});

for (const location of ['record', 'point', 'style']) test(`deletion oracle: frozen ${location} accessors reject without invoking serializers or getters`, t => {
  const f = fixture(t), id = withRedo(f), old = f.store.items[0];
  let calls = 0;
  const trap = () => {calls++; throw new Error('drawing accessor');};
  const changed = {...old};
  if (location === 'record') Object.defineProperty(changed, 'text', {enumerable: true, get: trap});
  if (location === 'point') changed.points = Object.freeze([Object.freeze(Object.defineProperty({...old.points[0]}, 'price', {enumerable: true, get: trap}))]);
  if (location === 'style') changed.style = Object.freeze(Object.defineProperty({...old.style}, 'color', {enumerable: true, get: trap}));
  f.store.items[0] = Object.freeze(changed);
  rejectUnchanged(f, [id]);
  assert.equal(calls, 0);
});

for (const [key, value] of [
  ['maxDrawings', 0], ['maxPoints', 0], ['maxDocumentChars', -1],
  ['historyLimit', 0], ['historyLimit', 10001], ['historyBytes', -1], ['historyBytes', 33554433],
  ['historyBytes', NaN], ['historyBytes', Infinity], ['historyBytes', '1024'],
]) test(`deletion oracle: invalid or exhausted ${key}=${String(value)} rejects atomically`, t => {
  const f = fixture(t), id = withRedo(f);
  f.store[key] = value;
  rejectUnchanged(f, [id]);
});

test('deletion oracle: no overridable store mutation/history methods are invoked', t => {
  const f = fixture(t), id = withRedo(f), before = f.store.items.slice();
  let calls = 0;
  for (const key of ['begin', 'commit', 'cancel', 'trim', 'weight', 'mutate', 'snapshot', 'remove', 'budget']) {
    poison(f, f.store, key, () => {calls++; throw new Error(`overridden ${key}`);});
  }
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assert.equal(calls, 0);
  assert.deepEqual(f.store.items, []);
  assertSameDrawings(f.store.undoStack.at(-1), before);
});

test('deletion oracle: invalidation exception reports committed undoable success and is never retried', t => {
  const f = fixture(t), id = withRedo(f), before = f.store.items.slice(), serial = f.store.serial;
  const historyLength = f.store.undoStack.length;
  f.onInvalidate = () => {throw new Error('host renderer unavailable');};
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: true});
  assert.deepEqual(f.store.items, []);
  assert.equal(f.store.undoStack.length, historyLength + 1);
  assert.deepEqual(f.store.redoStack, []);
  assert.equal(f.store.selected, null);
  assert.equal(f.store.serial, serial);
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assert.deepEqual(f.store.items, []);
});

test('deletion oracle: nested observer deletion is not overwritten by the outer publication', t => {
  const f = fixture(t), ids = Array.from({length: 4}, () => f.store.add(horizontal()));
  const before = f.store.items.slice(), historyLength = f.store.undoStack.length;
  let nested;
  f.onInvalidate = () => {
    f.onInvalidate = null;
    assertSameDrawings(f.store.items, without(before, [ids[2]]));
    nested = remove(f, [ids[0]]);
  };
  assert.deepEqual(remove(f, [ids[2]]), {changed: 1, invalidationFailed: false});
  assert.deepEqual(nested, {changed: 1, invalidationFailed: false});
  assert.equal(f.invalidations, 2);
  assertSameDrawings(f.store.items, without(before, [ids[0], ids[2]]));
  assert.equal(f.store.undoStack.length, historyLength + 2);
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, without(before, [ids[2]]));
  assert.equal(f.store.undo(), true);
  assertSameDrawings(f.store.items, before);
});

test('deletion oracle: observer undo remains published after the deletion call returns', t => {
  const f = fixture(t), id = withRedo(f), before = f.store.items.slice();
  f.onInvalidate = () => {assert.equal(f.store.undo(), true);};
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: false});
  assertSameDrawings(f.store.items, before);
  assert.equal(f.store.selected, null);
  assert.equal(f.store.redoStack.length, 1);
  assert.deepEqual(f.store.redoStack[0], []);
  assert.equal(f.invalidations, 1);
});

test('deletion oracle: observer selection and target updates are not overwritten', t => {
  const f = fixture(t), a = f.store.add(horizontal()), b = f.store.add(horizontal());
  f.store.selected = a;
  const nextTarget = {panel: 'price', seriesId: 'observer-target'};
  f.onInvalidate = () => {f.store.selected = b; f.input.drawingTarget = nextTarget;};
  assert.deepEqual(remove(f, [a]), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.selected, b);
  assert.strictEqual(f.input.drawingTarget, nextTarget);
  assert.equal(f.invalidations, 1);
});

test('deletion oracle: observer disposal and replacement are not revived after an exception', t => {
  const f = fixture(t), id = withRedo(f), replacement = new DrawingStore();
  replacement.add(horizontal({id: 'replacement'}));
  const preserve = preserveObjects(replacement);
  f.onInvalidate = () => {
    f.model.dispose();
    f.model.drawings = replacement;
    throw new Error('observer failed after cleanup');
  };
  assert.deepEqual(remove(f, [id]), {changed: 1, invalidationFailed: true});
  assert.equal(f.model.disposed, true);
  assert.equal(f.model.store.listeners.size, 0);
  assert.strictEqual(f.model.drawings, replacement);
  preserve();
  assert.deepEqual(f.store.items, []);
  assert.equal(f.invalidations, 1);
});
