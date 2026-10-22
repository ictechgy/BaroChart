import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel, DrawingStore, InteractionController} from '../src/core/index.mjs';

// Deliberately independent of drawingPointCount and the translation implementation.
const TYPES = [
  ['trendline', 2], ['horizontal', 1], ['fibonacci', 2], ['rectangle', 2],
  ['ellipse', 2], ['text', 1], ['ray', 2], ['extendedline', 2],
  ['channel', 3], ['fibextension', 3], ['fibfan', 2], ['fibtimezones', 2],
  ['freehand', 7], ['measurement', 2],
];
const TIME_LIMIT = 8640000000000000;
const DELTA = Object.freeze({deltaTimeMs: 0.375, deltaPrice: -0.125});
const horizontal = (extra = {}) => ({
  type: 'horizontal', panel: 'price', points: [{time: 1700000000000.125, price: 12.25}], ...extra,
});
const translated = (drawing, delta) => ({
  ...drawing,
  points: drawing.points.map(({time, price}) => ({
    time: time + delta.deltaTimeMs, price: price + delta.deltaPrice,
  })),
});
// Existing snapshot accounting is part of the store's public resource contract.
const snapshotBytes = items => items.length * 8 + items.reduce((n, d) => n + JSON.stringify(d).length * 2, 0);

function fixture(t, limits) {
  const model = new ChartModel();
  if (limits) model.drawings = new DrawingStore(limits);
  const input = new InteractionController(model, () => ({width: 800, height: 500}));
  const f = {model, store: model.drawings, input, invalidations: 0, onInvalidate: null};
  f.api = new ChartAPI(model, {controller: input, invalidate() {
    f.invalidations++;
    f.onInvalidate?.();
  }});
  t.after(() => model.dispose());
  return f;
}

function requireTranslation(f) {
  assert.equal(typeof f.api.translateDrawings, 'function', 'ChartAPI.translateDrawings must exist');
}

function translate(f, ids, delta) {
  requireTranslation(f);
  return f.api.translateDrawings(ids, delta);
}

// A rejected operation or validated no-op must retain both contents and identity.
// Inspect own descriptors, so the assertion itself never invokes input getters.
function unchangedState(f) {
  const seen = new Set(), records = [], maps = [];
  function capture(value, recurse = true) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      maps.push([value, [...value]]);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    records.push([value, descriptors]);
    if (recurse) for (const d of Object.values(descriptors)) {
      if ('value' in d && d.value && typeof d.value === 'object' &&
          (Array.isArray(d.value) || Object.getPrototypeOf(d.value) === Object.prototype)) capture(d.value);
    }
  }
  capture(f.store);
  capture(f.model, false);
  for (const name of ['panels', 'axes', 'series', 'view', 'crosshair']) capture(f.model[name]);
  capture(f.input, false);
  capture(f.input.gesture);
  capture(f.input.drawingTarget);
  capture(f.input.pointers);
  const invalidations = f.invalidations;
  return () => {
    for (const [value, before] of records) {
      const after = Object.getOwnPropertyDescriptors(value);
      assert.deepEqual(Reflect.ownKeys(after), Reflect.ownKeys(before), 'own fields remain unchanged');
      for (const key of Reflect.ownKeys(before)) {
        assert.equal(after[key].enumerable, before[key].enumerable);
        assert.equal(after[key].configurable, before[key].configurable);
        assert.equal(after[key].writable, before[key].writable);
        assert.strictEqual(after[key].value, before[key].value, `${String(key)} value/reference remains unchanged`);
        assert.strictEqual(after[key].get, before[key].get);
        assert.strictEqual(after[key].set, before[key].set);
      }
    }
    for (const [map, entries] of maps) assert.deepEqual([...map], entries, 'pointer ownership remains unchanged');
    assert.equal(f.invalidations, invalidations, 'no invalidation on rejection/no-op');
  };
}

function rejectUnchanged(f, operation) {
  // Outside assert.throws: an absent API must not make a rejection test pass.
  requireTranslation(f);
  const unchanged = unchangedState(f);
  try { assert.throws(operation); }
  finally { unchanged(); }
}

function withRedo(f) {
  const id = f.store.add(horizontal({text: 'committed'}));
  f.store.edit(id, {text: 'redo branch'});
  assert.equal(f.store.undo(), true);
  f.store.selected = id;
  assert.ok(f.store.undoStack.length && f.store.redoStack.length);
  assert.equal(f.store.serial, 1);
  return id;
}

function assertFrozen(drawing) {
  assert.ok(Object.isFrozen(drawing));
  assert.ok(Object.isFrozen(drawing.points));
  assert.ok(drawing.points.every(p => Object.isFrozen(p)));
  if (drawing.style) assert.ok(Object.isFrozen(drawing.style));
}

test('translation oracle: all 14 legacy types use exact raw addition and one undo unit', t => {
  const f = fixture(t), ids = [];
  for (const [type, count] of TYPES) {
    ids.push(f.store.add({
      type, panel: 'price', text: `${type} annotation`, locked: false,
      style: {color: '#abcdef', fill: '#12345678', width: 2, font: '13px monospace'},
      points: Array.from({length: count}, (_, i) => ({time: 1700000000000.125 + i * 0.5, price: 0.1 + i * 3.25})),
    }));
  }
  const unrelatedId = f.store.add(horizontal({text: 'outside the batch'}));
  f.store.selected = unrelatedId;
  const before = f.store.items.slice(), serial = f.store.serial, history = f.store.undoStack.slice();
  const expected = before.map(d => ids.includes(d.id) ? translated(d, DELTA) : d);
  const request = Object.freeze(ids.slice().reverse());
  const result = translate(f, request, DELTA);
  assert.deepEqual(result, {changed: 14, invalidationFailed: false});
  assert.deepEqual(f.store.items, expected, 'every raw anchor matches an independent addition oracle');
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.selected, unrelatedId);
  assert.equal(f.store.serial, serial);
  assert.strictEqual(f.store.items.at(-1), before.at(-1), 'unrelated drawing identity retained');
  assert.equal(f.store.undoStack.length, history.length + 1);
  history.forEach((snapshot, i) => {
    assert.deepEqual(f.store.undoStack[i], snapshot);
    snapshot.forEach((d, j) => assert.strictEqual(f.store.undoStack[i][j], d, 'older history retains drawing references'));
  });
  assert.deepEqual(f.store.undoStack.at(-1), before);
  before.forEach((d, i) => assert.strictEqual(f.store.undoStack.at(-1)[i], d));
  f.store.items.forEach(assertFrozen);
  for (let i = 0; i < 14; i++) {
    assert.notStrictEqual(f.store.items[i], before[i]);
    assert.notStrictEqual(f.store.items[i].points, before[i].points);
    assert.equal(before[i].points[0].time, 1700000000000.125, 'old snapshot was not modified');
  }
  const committed = f.store.items.slice(), saved = f.store.save();
  const receiver = new DrawingStore();
  receiver.load(saved);
  assert.deepEqual(receiver.items, expected, 'fractional timestamps survive the drawing document');
  assert.equal(f.store.undo(), true);
  before.forEach((d, i) => assert.strictEqual(f.store.items[i], d));
  assert.equal(f.store.redo(), true);
  committed.forEach((d, i) => assert.strictEqual(f.store.items[i], d));
});

test('translation oracle: maximum 2048-point freehand translates every anchor', t => {
  const f = fixture(t);
  const id = f.store.add({type: 'freehand', points: Array.from({length: 2048}, (_, i) => ({time: i + 0.125, price: i * 0.3}))});
  const expected = translated(f.store.items[0], DELTA);
  assert.deepEqual(translate(f, [id], DELTA), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0], expected);
  assert.equal(f.invalidations, 1);
});

for (const count of [1, 128]) test(`translation oracle: accepts ${count} explicit unique IDs`, t => {
  const f = fixture(t);
  const ids = Array.from({length: count}, (_, i) => f.store.add(horizontal({id: i === 0 ? 'x'.repeat(128) : `target-${i}`})));
  assert.deepEqual(translate(f, ids, DELTA), {changed: count, invalidationFailed: false});
  assert.equal(f.invalidations, 1);
});

const invalidIds = [
  ['omitted', () => undefined], ['null', () => null], ['empty', () => []],
  ['string', () => 'drawing-1'], ['set', () => new Set(['drawing-1'])],
  ['typed array', () => new Uint8Array([1])], ['array-like', () => ({0: 'drawing-1', length: 1})],
  ['duplicate', id => [id, id]], ['missing ID', id => [id, 'missing']],
  ['empty ID', id => [id, '']], ['numeric ID', id => [id, 1]], ['null ID', id => [id, null]],
  ['undefined ID', id => [id, undefined]], ['oversize ID', id => [id, 'x'.repeat(129)]],
  ['reserved __proto__ ID', id => [id, '__proto__']], ['reserved constructor ID', id => [id, 'constructor']],
  ['reserved prototype ID', id => [id, 'prototype']],
  ['sparse array', id => {const a = [id]; a.length = 2; return a;}],
  ['array subclass', id => new (class extends Array {})(id)],
  ['custom array prototype', id => Object.setPrototypeOf([id], Object.create(Array.prototype))],
];
for (const [name, make] of invalidIds) test(`translation oracle: ${name} IDs reject atomically`, t => {
  const f = fixture(t), id = withRedo(f), ids = make(id);
  rejectUnchanged(f, () => f.api.translateDrawings(ids, DELTA));
});

test('translation oracle: 129 existing unique IDs reject before any drawing changes', t => {
  const f = fixture(t);
  const ids = Array.from({length: 129}, (_, i) => f.store.add(horizontal({id: `target-${i}`})));
  rejectUnchanged(f, () => f.api.translateDrawings(ids, DELTA));
});

const invalidDeltas = [
  ['omitted', undefined], ['null', null], ['array', [1, 1]],
  ['empty', {}], ['missing price', {deltaTimeMs: 1}], ['missing time', {deltaPrice: 1}],
  ...['deltaTimeMs', 'deltaPrice'].flatMap(key => [undefined, null, '1', NaN, Infinity, -Infinity, 1n].map(value => [
    `${key}=${String(value)}`, {deltaTimeMs: 1, deltaPrice: 1, [key]: value},
  ])),
];
for (const [name, delta] of invalidDeltas) test(`translation oracle: raw finite deltas required (${name})`, t => {
  const f = fixture(t), id = withRedo(f);
  rejectUnchanged(f, () => f.api.translateDrawings([id], delta));
});

for (const kind of ['ID index', 'deltaTimeMs', 'deltaPrice', 'inherited delta', 'custom array prototype']) {
  test(`translation oracle: ${kind} accessor rejects without invocation or reentry`, t => {
    const f = fixture(t), id = withRedo(f);
    let calls = 0, ids = [id], delta = {...DELTA};
    const getter = () => { calls++; f.api.selectDrawing(null); return kind === 'ID index' ? id : 1; };
    if (kind === 'ID index') Object.defineProperty(ids, '0', {enumerable: true, get: getter});
    else if (kind === 'inherited delta') delta = Object.create({get deltaTimeMs() { return getter(); }}, {deltaPrice: {value: 1, enumerable: true}});
    else if (kind === 'custom array prototype') {
      ids = new Array(1);
      Object.setPrototypeOf(ids, Object.create(Array.prototype, {'0': {get: getter}}));
    } else Object.defineProperty(delta, kind, {enumerable: true, get: getter});
    rejectUnchanged(f, () => f.api.translateDrawings(ids, delta));
    assert.equal(calls, 0, 'input code must not run during validation');
  });
}

test('translation oracle: coercible delta objects reject without invoking valueOf/toJSON', t => {
  const f = fixture(t), id = withRedo(f);
  let calls = 0;
  const value = {valueOf() { calls++; return 1; }, toJSON() { calls++; return 1; }};
  rejectUnchanged(f, () => f.api.translateDrawings([id], {deltaTimeMs: value, deltaPrice: 1}));
  assert.equal(calls, 0);
});

for (const [name, delta] of [
  ['positive zero', {deltaTimeMs: 0, deltaPrice: 0}],
  ['negative zero', {deltaTimeMs: -0, deltaPrice: -0}],
  ['mixed signed zero', {deltaTimeMs: -0, deltaPrice: 0}],
  ['sub-ULP positive deltas', {deltaTimeMs: Number.MIN_VALUE, deltaPrice: Number.MIN_VALUE}],
  ['sub-ULP negative deltas', {deltaTimeMs: -Number.MIN_VALUE, deltaPrice: -Number.MIN_VALUE}],
]) test(`translation oracle: ${name} is a validated no-op retaining redo and every reference`, t => {
  const f = fixture(t), id = withRedo(f);
  f.onInvalidate = () => { throw new Error('a no-op must not notify'); };
  const unchanged = unchangedState(f);
  assert.deepEqual(translate(f, [id], delta), {changed: 0, invalidationFailed: false});
  unchanged();
});

test('translation oracle: changed counts drawings, not requested IDs or changed anchors', t => {
  const f = fixture(t);
  const unchangedId = f.store.add(horizontal({points: [{time: TIME_LIMIT, price: 2 ** 60}]}));
  const changedId = f.store.add({type: 'channel', points: [
    {time: 0.125, price: 1}, {time: 1.25, price: 2}, {time: 2.5, price: 3},
  ]});
  const before = f.store.items.slice(), delta = {deltaTimeMs: 0.125, deltaPrice: 0.125};
  assert.deepEqual(translated(before[0], delta), before[0], 'fixture really rounds back to identical coordinates');
  assert.deepEqual(translate(f, [unchangedId, changedId], delta), {changed: 1, invalidationFailed: false});
  assert.strictEqual(f.store.items[0], before[0]);
  assert.deepEqual(f.store.items[1], translated(before[1], delta));
  assert.equal(f.invalidations, 1);
});

for (const delta of [DELTA, {deltaTimeMs: 0, deltaPrice: -0}]) {
  test(`translation oracle: locked members reject the entire batch (${delta.deltaTimeMs})`, t => {
    const f = fixture(t), id = withRedo(f);
    const locked = f.store.add(horizontal({locked: true}));
    rejectUnchanged(f, () => f.api.translateDrawings([id, locked], delta));
  });
  test(`translation oracle: missing members reject even a no-op (${delta.deltaTimeMs})`, t => {
    const f = fixture(t), id = withRedo(f);
    rejectUnchanged(f, () => f.api.translateDrawings([id, 'missing'], delta));
  });
}

for (const [name, point, delta] of [
  ['upper date overflow', {time: TIME_LIMIT, price: 1}, {deltaTimeMs: 1, deltaPrice: 0}],
  ['lower date overflow', {time: -TIME_LIMIT, price: 1}, {deltaTimeMs: -1, deltaPrice: 0}],
  ['positive price overflow', {time: 0, price: Number.MAX_VALUE}, {deltaTimeMs: 0, deltaPrice: Number.MAX_VALUE}],
  ['negative price overflow', {time: 0, price: -Number.MAX_VALUE}, {deltaTimeMs: 0, deltaPrice: -Number.MAX_VALUE}],
]) test(`translation oracle: ${name} rejects after an earlier valid member without partial mutation`, t => {
  const f = fixture(t), first = f.store.add(horizontal({points: [{time: 0, price: 0}]}));
  const last = f.store.add(horizontal({points: [point]}));
  rejectUnchanged(f, () => f.api.translateDrawings([first, last], delta));
});

for (const sign of [-1, 1]) test(`translation oracle: inclusive ${sign < 0 ? 'lower' : 'upper'} date endpoint and maximum finite price`, t => {
  const f = fixture(t), id = f.store.add(horizontal({points: [{time: sign * (TIME_LIMIT - 1), price: 0}]}));
  const delta = {deltaTimeMs: sign, deltaPrice: sign * Number.MAX_VALUE};
  assert.deepEqual(translate(f, [id], delta), {changed: 1, invalidationFailed: false});
  assert.deepEqual(f.store.items[0].points, [{time: sign * TIME_LIMIT, price: sign * Number.MAX_VALUE}]);
});

function boundFixture(t) {
  const f = fixture(t);
  f.model.addPanel({id: 'secondary'});
  f.model.addAxis({id: 'axis-a', panel: 'price'});
  f.model.addAxis({id: 'axis-b', panel: 'price'});
  f.model.addSeries({id: 'series-a', type: 'line', panel: 'price', axisId: 'axis-a'});
  f.model.addSeries({id: 'series-b', type: 'line', panel: 'price', axisId: 'axis-a'});
  return f;
}

for (const [name, first, second] of [
  ['panel', {}, {panel: 'secondary'}],
  ['axis', {axisId: 'axis-a'}, {axisId: 'axis-b'}],
  ['default versus explicit axis', {}, {axisId: 'axis-a'}],
  ['series', {axisId: 'axis-a', seriesId: 'series-a'}, {axisId: 'axis-a', seriesId: 'series-b'}],
  ['unbound versus bound series', {axisId: 'axis-a'}, {axisId: 'axis-a', seriesId: 'series-a'}],
]) for (const zero of [false, true]) test(`translation oracle: mixed ${name} binding rejects (${zero ? 'zero' : 'nonzero'} delta)`, t => {
  const f = boundFixture(t), a = f.store.add(horizontal(first)), b = f.store.add(horizontal(second));
  rejectUnchanged(f, () => f.api.translateDrawings([a, b], zero ? {deltaTimeMs: 0, deltaPrice: 0} : DELTA));
});

test('translation oracle: absent and explicit null bindings normalize to the same tuple', t => {
  const f = fixture(t), a = f.store.add(horizontal()), b = f.store.add(horizontal());
  // add/load normalize nulls away; an existing valid record can still contain them.
  f.store.items[1] = Object.freeze({...f.store.items[1], axisId: null, seriesId: null});
  const before = f.store.items.slice();
  assert.deepEqual(translate(f, [a, b], DELTA), {changed: 2, invalidationFailed: false});
  assert.deepEqual(f.store.items, before.map(d => translated(d, DELTA)));
});

test('translation oracle: matching live series/axis bindings validate without evaluating data or indicators', t => {
  const f = boundFixture(t), options = {axisId: 'axis-a', seriesId: 'indicator-series'};
  f.model.indicators.add('ema-study', 'ema', {period: 2});
  f.model.addSeries({id: 'indicator-series', type: 'line', panel: 'price', axisId: 'axis-a', indicator: 'ema-study'});
  f.model.store.setData([{time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 20}]);
  const a = f.store.add(horizontal(options)), b = f.store.add(horizontal(options));
  const entry = f.model.indicators.entries.get('ema-study');
  const entryFields = Object.fromEntries(Object.entries(entry));
  let computations = 0;
  f.model.seriesData = () => { computations++; throw new Error('series computation is forbidden'); };
  f.model.indicators.get = () => { computations++; throw new Error('indicator computation is forbidden'); };
  assert.deepEqual(translate(f, [a, b], DELTA), {changed: 2, invalidationFailed: false});
  assert.equal(computations, 0);
  for (const [key, value] of Object.entries(entryFields)) assert.strictEqual(entry[key], value, `indicator ${key} unchanged`);
});

for (const [name, corrupt] of [
  ['missing panel', f => { f.model.panels = f.model.panels.filter(p => p.id !== 'price'); }],
  ['missing axis', f => { f.model.axes = f.model.axes.filter(a => a.id !== 'axis-a'); }],
  ['axis moved to another panel', f => { f.model.axes.find(a => a.id === 'axis-a').panel = 'secondary'; }],
  ['removed series', f => f.model.removeSeries('series-a')],
  ['series moved to another panel', f => { f.model.series.find(s => s.id === 'series-a').panel = 'secondary'; }],
  ['series moved to another axis', f => { f.model.series.find(s => s.id === 'series-a').axisId = 'axis-b'; }],
]) for (const zero of [false, true]) test(`translation oracle: current ${name} rejects (${zero ? 'zero' : 'nonzero'} delta)`, t => {
  const f = boundFixture(t), options = {axisId: 'axis-a', seriesId: 'series-a'};
  const a = f.store.add(horizontal(options)), b = f.store.add(horizontal(options));
  corrupt(f);
  rejectUnchanged(f, () => f.api.translateDrawings([a, b], zero ? {deltaTimeMs: 0, deltaPrice: 0} : DELTA));
});

for (const [name, patch] of [
  ['unknown type', {type: 'not-a-drawing'}],
  ['wrong anchor count', {points: []}],
  ['nonfinite time', {points: [{time: NaN, price: 1}]}],
  ['out-of-range time', {points: [{time: TIME_LIMIT + 1, price: 1}]}],
  ['nonfinite price', {points: [{time: 1, price: Infinity}]}],
  ['nonnumeric price', {points: [{time: 1, price: '1'}]}],
]) test(`translation oracle: invalid existing ${name} rejects even with zero deltas`, t => {
  const f = fixture(t), a = f.store.add(horizontal()), b = f.store.add(horizontal());
  f.store.items[1] = {...f.store.items[1], ...patch};
  rejectUnchanged(f, () => f.api.translateDrawings([a, b], {deltaTimeMs: 0, deltaPrice: 0}));
});

for (const zero of [false, true]) test(`translation oracle: active drawing transaction rejects without cancelling (${zero ? 'zero' : 'nonzero'} delta)`, t => {
  const f = fixture(t), id = withRedo(f);
  f.store.begin();
  f.store.edit(id, {text: 'uncommitted preview'});
  rejectUnchanged(f, () => f.api.translateDrawings([id], zero ? {deltaTimeMs: 0, deltaPrice: 0} : DELTA));
});

for (const kind of ['pan', 'pinch', 'wait', 'create', 'edit']) {
  for (const zero of [false, true]) test(`translation oracle: active ${kind} controller gesture rejects (${zero ? 'zero' : 'nonzero'} delta)`, t => {
    const f = fixture(t), id = withRedo(f);
    f.input.gesture = {kind, id, view: {...f.model.view}, follow: f.model.follow};
    f.input.pointers.set(17, {x: 120, y: 80});
    rejectUnchanged(f, () => f.api.translateDrawings([id], zero ? {deltaTimeMs: 0, deltaPrice: 0} : DELTA));
  });
}

test('translation oracle: whole prior snapshot must fit historyBytes, including unrelated drawings', t => {
  const f = fixture(t), id = withRedo(f);
  f.store.add(horizontal({id: 'unrelated', text: 'unselected payload '.repeat(80)}));
  f.store.historyBytes = snapshotBytes(f.store.items) - 1;
  f.store.trim();
  assert.ok(snapshotBytes([f.store.items[0]]) < f.store.historyBytes, 'selected subset alone would fit');
  rejectUnchanged(f, () => f.api.translateDrawings([id], DELTA));
});

test('translation oracle: tiny history budget permits a validated no-op without discarding redo', t => {
  const f = fixture(t), id = f.store.add(horizontal({text: 'long committed annotation '.repeat(40)}));
  f.store.edit(id, {text: 'short redo branch'});
  f.store.undo();
  f.store.selected = id;
  f.store.historyBytes = snapshotBytes(f.store.items) - 1;
  // Existing history can fit even though the next full snapshot cannot.
  f.store.trim();
  assert.equal(f.store.redoStack.length, 1);
  const unchanged = unchangedState(f);
  assert.deepEqual(translate(f, [id], {deltaTimeMs: 0, deltaPrice: 0}), {changed: 0, invalidationFailed: false});
  unchanged();
});

test('translation oracle: exact history-byte budget retains the new undo unit and trims older snapshots before notification', t => {
  const f = fixture(t), id = f.store.add(horizontal({text: 'first'}));
  f.store.edit(id, {text: 'second, longer'});
  f.store.edit(id, {text: 'third, much longer still '.repeat(30)});
  f.store.edit(id, {text: 'short redo'});
  f.store.undo();
  f.store.selected = id;
  const before = f.store.items.slice(), selected = f.store.selected, serial = f.store.serial;
  f.store.historyBytes = snapshotBytes(before);
  f.store.trim();
  assert.ok(f.store.undoStack.length || f.store.redoStack.length);
  f.onInvalidate = () => {
    assert.equal(f.store.undoStack.length, 1);
    assert.deepEqual(f.store.undoStack[0], before);
    assert.equal(f.store.redoStack.length, 0);
    assert.equal(f.store.retainedHistoryBytes, f.store.historyBytes);
    assert.equal(f.store.selected, selected);
    assert.equal(f.store.serial, serial);
  };
  assert.deepEqual(translate(f, [id], DELTA), {changed: 1, invalidationFailed: false});
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undo(), true);
  assert.deepEqual(f.store.items, before);
});

test('translation oracle: historyLimit is enforced while preserving one grouped undo', t => {
  const f = fixture(t, {historyLimit: 1});
  const a = f.store.add(horizontal()), b = f.store.add(horizontal());
  const before = f.store.items.slice();
  assert.deepEqual(translate(f, [a, b], DELTA), {changed: 2, invalidationFailed: false});
  assert.equal(f.store.undoStack.length, 1);
  assert.deepEqual(f.store.undoStack[0], before);
  assert.equal(f.store.undo(), true);
  assert.deepEqual(f.store.items, before);
});

test('translation oracle: invalidation failure is reported after a committed, undoable success', t => {
  const f = fixture(t), id = withRedo(f), before = f.store.items.slice();
  const historyLength = f.store.undoStack.length, serial = f.store.serial;
  f.onInvalidate = () => { throw new Error('host renderer unavailable'); };
  assert.deepEqual(translate(f, [id], DELTA), {changed: 1, invalidationFailed: true});
  assert.deepEqual(f.store.items, before.map(d => translated(d, DELTA)));
  assert.equal(f.store.undoStack.length, historyLength + 1);
  assert.equal(f.store.redoStack.length, 0);
  assert.equal(f.store.selected, id);
  assert.equal(f.store.serial, serial);
  assert.equal(f.invalidations, 1, 'notification is not retried');
  assert.equal(f.store.undo(), true);
  assert.deepEqual(f.store.items, before);
  assert.equal(f.store.redo(), true);
  assert.deepEqual(f.store.items, before.map(d => translated(d, DELTA)));
});
