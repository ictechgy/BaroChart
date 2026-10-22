import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel, DrawingStore, InteractionController} from '../src/core/index.mjs';
import {DrawingSelectionController} from '../src/renderers/drawing-selection.mjs';

// These tests exercise the real mutation API. They intentionally do not replace
// public ChartAPI methods: overriding them is not a controller extension point.
const drawing = (id, extra = {}) => ({
  id, type: 'horizontal', panel: 'price',
  points: [{time: 1700000000000.125, price: 12.25}],
  style: {color: '#102030ff', width: 2}, ...extra,
});

function fixture(t, inputs = [drawing('a'), drawing('b'), drawing('keep')]) {
  const model = new ChartModel();
  const input = new InteractionController(model, () => ({width: 800, height: 500}));
  const f = {model, input, store: model.drawings, invalidations: 0, onInvalidate: null, restores: []};
  f.api = new ChartAPI(model, {controller: input, invalidate() {
    f.invalidations++;
    f.onInvalidate?.();
  }});
  for (const d of inputs) f.store.add(d);
  f.selection = new DrawingSelectionController(f.api);
  t.after(() => {
    for (const restore of f.restores.reverse()) restore();
    f.selection.dispose();
    model.dispose();
  });
  return f;
}

function selected(f, expected) {
  const snapshot = f.selection.snapshot();
  assert.equal(snapshot.selectedCount, expected.length);
  assert.deepEqual([...snapshot.selectedIds].sort(), [...expected].sort());
  return snapshot;
}

function unchanged(f) {
  const {items, undoStack, redoStack, selected: handle, serial, transaction} = f.store;
  const itemRefs = items.slice(), undoRefs = undoStack.slice(), redoRefs = redoStack.slice();
  const invalidations = f.invalidations;
  return () => {
    assert.strictEqual(f.store.items, items, 'items array is not published on rejection/no-op');
    assert.strictEqual(f.store.undoStack, undoStack, 'undo array is not published on rejection/no-op');
    assert.strictEqual(f.store.redoStack, redoStack, 'redo array is not published on rejection/no-op');
    assert.deepEqual(f.store.items, itemRefs);
    itemRefs.forEach((d, i) => assert.strictEqual(f.store.items[i], d));
    assert.deepEqual(f.store.undoStack, undoRefs);
    assert.deepEqual(f.store.redoStack, redoRefs);
    assert.equal(f.store.selected, handle);
    assert.equal(f.store.serial, serial);
    assert.strictEqual(f.store.transaction, transaction);
    assert.equal(f.invalidations, invalidations);
  };
}

function replaceProperty(f, object, key, descriptor) {
  const before = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, {configurable: true, enumerable: true, ...descriptor});
  const restore = () => before ? Object.defineProperty(object, key, before) : delete object[key];
  f.restores.push(restore);
  return restore;
}

test('selection is DOM-free, explicit, independent of the single canvas handle, and detached in snapshots', t => {
  const f = fixture(t);
  Object.defineProperty(f.store, 'selected', {value: 'keep', writable: false, configurable: true});
  f.restores.push(() => Object.defineProperty(f.store, 'selected', {writable: true}));
  const before = unchanged(f);
  assert.deepEqual(f.selection.snapshot(), {
    rows: [
      {id: 'a', type: 'horizontal', panel: 'price', locked: false, visible: true, selected: false},
      {id: 'b', type: 'horizontal', panel: 'price', locked: false, visible: true, selected: false},
      {id: 'keep', type: 'horizontal', panel: 'price', locked: false, visible: true, selected: false},
    ], total: 3, selectedIds: [], selectedCount: 0, staleCount: 0, offset: 0, limit: 32,
  });
  f.selection.select('b');
  f.selection.select('a', true);
  f.selection.select('a', true);
  const first = selected(f, ['a', 'b']);
  assert.equal(first.rows[0].selected, true);
  assert.equal(first.rows[1].selected, true);
  assert.equal(first.rows[2].selected, false);
  for (const row of first.rows) assert.deepEqual(Object.keys(row).sort(), ['id', 'locked', 'panel', 'selected', 'type', 'visible']);
  Reflect.set(first.rows[0], 'id', 'forged');
  Reflect.set(first.selectedIds, '0', 'forged');
  assert.equal(f.selection.snapshot().rows[0].id, 'a');
  selected(f, ['a', 'b']);
  f.selection.select('a', false);
  selected(f, ['b']);
  f.selection.refresh();
  f.selection.clear();
  selected(f, []);
  before();
});

test('snapshots page in drawing order at 32 rows while reporting all off-page selected IDs', t => {
  const f = fixture(t, Array.from({length: 70}, (_, i) => drawing(`d-${i}`)));
  for (const id of ['d-0', 'd-34', 'd-69']) f.selection.select(id);
  const first = f.selection.snapshot();
  assert.equal(first.rows.length, 32);
  assert.equal(first.total, 70);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 32);
  assert.deepEqual(first.rows.map(row => row.id), Array.from({length: 32}, (_, i) => `d-${i}`));
  const second = f.selection.snapshot({offset: 32, limit: 32});
  assert.deepEqual(second.rows.map(row => row.id), Array.from({length: 32}, (_, i) => `d-${i + 32}`));
  assert.equal(second.rows[2].selected, true);
  assert.equal(second.selectedCount, 3);
  assert.deepEqual([...second.selectedIds].sort(), ['d-0', 'd-34', 'd-69']);
  const last = f.selection.snapshot({offset: 64, limit: 8});
  assert.equal(last.rows.length, 6);
  assert.equal(last.rows.at(-1).selected, true);
  assert.deepEqual(f.selection.snapshot({offset: 99, limit: 1}).rows, []);
  selected(f, ['d-0', 'd-34', 'd-69']);
});

for (const options of [
  {offset: -1}, {offset: .5}, {offset: Infinity}, {offset: '0'}, {offset: Number.MAX_SAFE_INTEGER + 1},
  {limit: -1}, {limit: 0}, {limit: .5}, {limit: 33}, {limit: Infinity}, {limit: '32'},
  null, [], {offset: 0, unknown: true},
]) test(`invalid page ${JSON.stringify(options)} rejects without changing selection`, t => {
  const f = fixture(t);
  f.selection.select('a');
  const before = unchanged(f);
  assert.throws(() => f.selection.snapshot(options));
  selected(f, ['a']);
  before();
});

test('page option getters are rejected without invocation', t => {
  const f = fixture(t);
  let reads = 0;
  for (const key of ['offset', 'limit']) {
    const options = Object.defineProperty({}, key, {enumerable: true, get() {reads++; return 1;}});
    assert.throws(() => f.selection.snapshot(options));
  }
  assert.equal(reads, 0);
});

for (const id of [undefined, null, '', 1, [], {}, 'x'.repeat(129), 'missing']) {
  test(`select requires a present explicit identifier (${String(id)})`, t => {
    const f = fixture(t);
    f.selection.select('a');
    const before = unchanged(f);
    assert.throws(() => f.selection.select(id));
    selected(f, ['a']);
    before();
  });
}

for (const value of [null, 0, 1, 'true', {}]) test(`selection flag must be a boolean (${String(value)})`, t => {
  const f = fixture(t);
  assert.throws(() => f.selection.select('a', value));
  selected(f, []);
});

test('128 unique selections are accepted; the 129th rejects atomically and deselecting frees a slot', t => {
  const longId = 'x'.repeat(128);
  const ids = Array.from({length: 129}, (_, i) => i ? `d-${i}` : longId);
  const f = fixture(t, ids.map(id => drawing(id)));
  for (const id of ids.slice(0, 128)) f.selection.select(id);
  selected(f, ids.slice(0, 128));
  f.selection.select(ids[0]);
  assert.throws(() => f.selection.select(ids[128]), /limit|128/i);
  selected(f, ids.slice(0, 128));
  f.selection.select(ids[0], false);
  f.selection.select(ids[128]);
  selected(f, ids.slice(1));
  assert.equal(f.invalidations, 0);
});

for (const action of ['style', 'delete']) test(`${action} applies to all 128 selected IDs, including every off-page row, as one undo unit`, t => {
  const ids = Array.from({length: 128}, (_, i) => `d-${i}`);
  const f = fixture(t, [...ids.map(id => drawing(id)), drawing('keep')]);
  const before = f.store.items.slice(), history = f.store.undoStack.length;
  for (const id of ids.slice().reverse()) f.selection.select(id);
  const receipt = action === 'style' ? f.selection.applyStyle({width: 4, color: 'red'}) : f.selection.deleteSelected();
  assert.deepEqual(receipt, {changed: 128, invalidationFailed: false});
  assert.equal(f.invalidations, 1);
  assert.equal(f.store.undoStack.length, Math.min(history + 1, f.store.historyLimit));
  before.forEach((d, i) => assert.strictEqual(f.store.undoStack.at(-1)[i], d));
  assert.strictEqual(f.store.items.at(-1), before.at(-1));
  assert.equal(f.store.selected, 'keep');
  selected(f, []);
  if (action === 'style') {
    assert.equal(f.store.items.length, 129);
    for (let i = 0; i < 128; i++) {
      assert.equal(f.store.items[i].style.width, 4);
      assert.equal(f.store.items[i].style.color, '#ff0000ff');
      assert.deepEqual(f.store.items[i].points, before[i].points);
      assert.ok(Object.isFrozen(f.store.items[i]));
    }
  } else assert.deepEqual(f.store.items.map(d => d.id), ['keep']);
  assert.equal(f.store.undo(), true);
  before.forEach((d, i) => assert.strictEqual(f.store.items[i], d));
});

test('normalized width/color no-op keeps selection, history, redo, and exact frozen refs', t => {
  const f = fixture(t);
  f.store.edit('b', {text: 'redo branch'});
  f.store.undo();
  f.selection.select('a');
  f.selection.select('b');
  const before = unchanged(f);
  f.onInvalidate = () => assert.fail('no-op should not invalidate');
  assert.deepEqual(f.selection.applyStyle({width: 2, color: '#102030'}), {changed: 0, invalidationFailed: false});
  selected(f, ['a', 'b']);
  before();
});

test('a partly unchanged style batch counts only changed drawings and clears the entire original selection', t => {
  const f = fixture(t, [drawing('a'), drawing('b', {style: {width: 3, color: '#102030ff'}})]);
  f.selection.select('a');
  f.selection.select('b');
  const b = f.store.items[1];
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  assert.strictEqual(f.store.items[1], b);
  selected(f, []);
});

test('style and deletion do not write an unrelated read-only canvas handle', t => {
  const f = fixture(t);
  Object.defineProperty(f.store, 'selected', {value: 'keep', writable: false, configurable: true});
  f.restores.push(() => Object.defineProperty(f.store, 'selected', {writable: true}));
  f.selection.select('a');
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.selected, 'keep');
  f.selection.select('a');
  assert.deepEqual(f.selection.deleteSelected(), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.selected, 'keep');
});

for (const action of ['style', 'delete']) test(`${action} requires selection and never falls back to the canvas handle`, t => {
  const f = fixture(t);
  f.store.selected = 'a';
  const before = unchanged(f);
  assert.throws(() => action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected());
  selected(f, []);
  before();
});

for (const action of ['style', 'delete']) test(`${action} rejects a mixed locked selection atomically`, t => {
  const f = fixture(t, [drawing('a'), drawing('locked', {locked: true})]);
  f.selection.select('a');
  f.selection.select('locked');
  assert.equal(f.selection.snapshot().rows[1].locked, true);
  const before = unchanged(f);
  assert.throws(() => action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected(), /locked/i);
  selected(f, ['a', 'locked']);
  before();
});

for (const action of ['style', 'delete']) for (const ownership of ['gesture', 'transaction']) {
  test(`${action} rejects an active ${ownership} without canceling it or changing selection`, t => {
    const f = fixture(t);
    f.selection.select('a');
    if (ownership === 'gesture') f.input.gesture = {kind: 'pan', sentinel: true};
    else f.store.begin();
    const gesture = f.input.gesture, before = unchanged(f);
    assert.throws(() => action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected(), /gesture|transaction/i);
    selected(f, ['a']);
    assert.strictEqual(f.input.gesture, gesture);
    before();
    f.input.gesture = null;
    f.store.cancel();
  });
}

test('invalid style patches retain the full selection without publishing a partial change', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.selection.select('b');
  for (const patch of [{}, {width: 0}, {width: Infinity}, {color: 'not-a-color'}, {width: 3, unknown: true}]) {
    const before = unchanged(f);
    assert.throws(() => f.selection.applyStyle(patch));
    selected(f, ['a', 'b']);
    before();
  }
});

for (const action of ['style', 'delete']) for (const stale of ['missing', 'replaced']) {
  test(`${action}: one ${stale} ref rejects the entire action, then refreshes only stale selections`, t => {
    const f = fixture(t);
    f.selection.select('a');
    f.selection.select('b');
    const oldA = f.store.items[0], liveB = f.store.items[1];
    if (stale === 'missing') f.store.remove('a');
    else f.store.edit('a', {text: 'external edit'});
    const before = unchanged(f);
    const snapshot = selected(f, ['a', 'b']);
    assert.equal(snapshot.staleCount, 1);
    if (stale === 'replaced') assert.equal(snapshot.rows.find(row => row.id === 'a').selected, false);
    selected(f, ['a', 'b']); // Rendering a snapshot must not silently repair the selection.
    assert.throws(() => action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected(), /changed|stale|refresh/i);
    selected(f, ['b']);
    assert.strictEqual(f.store.items.find(d => d.id === 'b'), liveB);
    assert.equal(oldA.style.width, 2);
    before();
    const receipt = action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected();
    assert.equal(receipt.changed, 1);
  });
}

test('explicit refresh prunes same-ID replacements and missing refs without adding new records', t => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'keep']) f.selection.select(id);
  f.store.edit('a', {text: 'replacement'});
  f.store.remove('b');
  f.store.add(drawing('new'));
  selected(f, ['a', 'b', 'keep']);
  f.selection.refresh();
  selected(f, ['keep']);
  assert.equal(f.selection.snapshot().rows.find(row => row.id === 'new').selected, false);
  assert.equal(f.invalidations, 0);
});

for (const external of ['undo', 'redo', 'load']) test(`${external} same-ID records remain stale until explicit reselection`, t => {
  const f = fixture(t);
  if (external === 'undo') f.store.edit('a', {text: 'latest'});
  if (external === 'redo') {
    f.store.edit('a', {text: 'latest'});
    f.store.undo();
  }
  f.selection.select('a');
  const held = f.store.items[0];
  if (external === 'load') f.api.loadDrawings(f.api.saveDrawings());
  else f.store[external]();
  assert.equal(f.store.items[0].id, held.id);
  assert.notStrictEqual(f.store.items[0], held);
  selected(f, ['a']);
  const before = unchanged(f);
  assert.throws(() => f.selection.applyStyle({width: 3}), /changed|stale|refresh/i);
  selected(f, []);
  before();
  f.selection.select('a');
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
});

test('raw bar-data replacement preserves drawing identity and a still-valid selection', t => {
  const f = fixture(t);
  f.selection.select('a');
  const held = f.store.items[0];
  f.api.setData([{time: 1000, open: 1, high: 2, low: 0, close: 1, volume: 3}]);
  f.api.setData([{time: 2000, open: 3, high: 4, low: 2, close: 3, volume: 5}]);
  assert.strictEqual(f.store.items[0], held);
  f.selection.refresh();
  selected(f, ['a']);
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
});

for (const action of ['style', 'delete']) test(`${action} invalidation failure is committed success and clears the original selection`, t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => {throw new Error('observer failure');};
  const history = f.store.undoStack.length;
  assert.deepEqual(action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected(), {changed: 1, invalidationFailed: true});
  assert.equal(f.store.undoStack.length, history + 1);
  assert.equal(f.invalidations, 1);
  selected(f, []);
  if (action === 'style') assert.equal(f.store.items[0].style.width, 3);
  else assert.ok(!f.store.items.some(d => d.id === 'a'));
});

for (const action of ['style', 'delete']) test(`${action} does not erase a replacement selection made synchronously by its observer`, t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => {
    f.selection.clear();
    f.selection.select('keep');
  };
  const receipt = action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected();
  assert.deepEqual(receipt, {changed: 1, invalidationFailed: false});
  selected(f, ['keep']);
  f.onInvalidate = null;
  assert.equal(f.selection.applyStyle({width: 4}).changed, 1);
  assert.equal(f.store.items.find(d => d.id === 'keep').style.width, 4);
});

test('observer select on the changed ID captures the newly published frozen ref and survives old cleanup', t => {
  const f = fixture(t);
  f.selection.select('a');
  const old = f.store.items[0];
  f.onInvalidate = () => f.selection.select('a');
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
  assert.notStrictEqual(f.store.items[0], old);
  selected(f, ['a']);
  f.onInvalidate = null;
  assert.equal(f.selection.applyStyle({width: 4}).changed, 1);
  selected(f, []);
});

test('a throwing observer still preserves a newer selection generation after commit', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => {
    f.selection.clear();
    f.selection.select('keep');
    throw new Error('after observer reselection');
  };
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: true});
  selected(f, ['keep']);
});

test('observer external same-ID replacement followed by select retains only its explicitly selected new ref', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => {
    f.onInvalidate = null;
    f.api.editDrawing('a', {text: 'observer replacement'});
    f.selection.clear();
    f.selection.select('a');
  };
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  selected(f, ['a']);
  assert.equal(f.store.items[0].text, 'observer replacement');
  assert.equal(f.selection.applyStyle({width: 4}).changed, 1);
});

test('observer select without clear preserves the newer selection generation, including stale old IDs until refresh', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => f.selection.select('keep');
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
  selected(f, ['a', 'keep']);
  f.selection.refresh();
  selected(f, ['keep']);
});

test('observer snapshot sees the original selection without pruning or preventing ordinary success cleanup', t => {
  const f = fixture(t);
  f.selection.select('a');
  let during;
  f.onInvalidate = () => {during = f.selection.snapshot();};
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
  assert.deepEqual(during.selectedIds, ['a']);
  assert.equal(during.selectedCount, 1);
  selected(f, []);
});

test('observer refresh plus reselect cannot be overwritten by the outer style action', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => {
    f.selection.refresh();
    f.selection.select('b');
  };
  assert.equal(f.selection.applyStyle({width: 3}).changed, 1);
  selected(f, ['b']);
});

test('nested observer action and newer selection survive the older action returning', t => {
  const f = fixture(t);
  f.selection.select('a');
  let nestedReceipt;
  f.onInvalidate = () => {
    f.onInvalidate = null;
    f.selection.clear();
    f.selection.select('b');
    nestedReceipt = f.selection.applyStyle({width: 4});
    f.selection.select('keep');
  };
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  assert.deepEqual(nestedReceipt, {changed: 1, invalidationFailed: false});
  assert.equal(f.store.items[0].style.width, 3);
  assert.equal(f.store.items[1].style.width, 4);
  selected(f, ['keep']);
});

for (const action of ['style', 'delete']) test(`${action} observer disposal is never undone or resurrected`, t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => f.selection.dispose();
  assert.deepEqual(action === 'style' ? f.selection.applyStyle({width: 3}) : f.selection.deleteSelected(), {changed: 1, invalidationFailed: false});
  f.selection.dispose();
  assert.throws(() => f.selection.snapshot(), /disposed/i);
  assert.throws(() => f.selection.select('b'), /disposed/i);
});

for (const owner of ['model', 'store']) test(`observer replacement of the ${owner} prevents old-owner selection cleanup`, t => {
  const f = fixture(t);
  const replacement = owner === 'model' ? new ChartModel() : new DrawingStore();
  if (owner === 'model') t.after(() => replacement.dispose());
  f.selection.select('a');
  f.onInvalidate = () => {
    if (owner === 'model') f.api.model = replacement;
    else f.model.drawings = replacement;
  };
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.items[0].style.width, 3);
  assert.throws(() => f.selection.snapshot(), /owner|changed/i);
  f.api.model = f.model;
  f.model.drawings = f.store;
  selected(f, ['a']);
  f.selection.refresh();
  selected(f, []);
});

test('observer model disposal preserves the committed receipt and rejects later controller operations', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.onInvalidate = () => f.model.dispose();
  assert.deepEqual(f.selection.applyStyle({width: 3}), {changed: 1, invalidationFailed: false});
  assert.equal(f.store.items[0].style.width, 3);
  assert.throws(() => f.selection.snapshot(), /disposed/i);
});

test('mixed and orphan drawing metadata needs no live panel, axis, series, or indicator lookup', t => {
  const f = fixture(t, [
    drawing('a', {panel: 'orphan-panel', axisId: 'missing-axis'}),
    drawing('b', {seriesId: 'missing-series'}),
    drawing('keep'),
  ]);
  let reads = 0;
  for (const key of ['panels', 'axes', 'series', 'indicators']) replaceProperty(f, f.model, key, {get() {reads++; throw new Error('unexpected metadata lookup');}});
  f.selection.select('a');
  f.selection.select('b');
  f.selection.snapshot({offset: 1, limit: 2});
  f.selection.refresh();
  assert.deepEqual(f.selection.applyStyle({width: 3, color: 'blue'}), {changed: 2, invalidationFailed: false});
  f.selection.select('a');
  f.selection.select('b');
  assert.deepEqual(f.selection.deleteSelected(), {changed: 2, invalidationFailed: false});
  assert.equal(reads, 0);
  assert.deepEqual(f.store.items.map(d => d.id), ['keep']);
});

for (const target of ['api.model', 'model.disposed', 'model.drawings', 'store.items', 'items.0']) {
  test(`accessor-backed ${target} rejects without getter execution or selection publication`, t => {
    const f = fixture(t);
    f.selection.select('a');
    const [owner, key] = target.split('.');
    const object = owner === 'api' ? f.api : owner === 'model' ? f.model : owner === 'store' ? f.store : f.store.items;
    const value = Object.getOwnPropertyDescriptor(object, key)?.value;
    let reads = 0;
    const restore = replaceProperty(f, object, key, {get() {reads++; return value;}});
    for (const operation of [() => f.selection.snapshot(), () => f.selection.select('b'), () => f.selection.refresh(), () => f.selection.applyStyle({width: 3}), () => f.selection.deleteSelected()]) assert.throws(operation);
    assert.equal(reads, 0);
    assert.equal(f.invalidations, 0);
    restore();
    selected(f, ['a']);
  });
}

for (const key of ['id', 'type', 'panel', 'locked']) test(`frozen drawing ${key} accessor is never executed`, t => {
  const f = fixture(t);
  f.selection.select('a');
  const before = f.store.items;
  let reads = 0;
  const malformed = {...before[1]};
  Object.defineProperty(malformed, key, {enumerable: true, get() {reads++; return before[1][key];}});
  f.store.items = [before[0], Object.freeze(malformed), before[2]];
  for (const operation of [() => f.selection.snapshot(), () => f.selection.select('a'), () => f.selection.refresh(), () => f.selection.applyStyle({width: 3}), () => f.selection.deleteSelected()]) assert.throws(operation);
  assert.equal(reads, 0);
  assert.equal(f.invalidations, 0);
  f.store.items = before;
  selected(f, ['a']);
});

test('unfrozen records, duplicate IDs, sparse source arrays, and nonordinary source arrays reject', t => {
  const f = fixture(t);
  const before = f.store.items;
  const sparse = before.slice();
  delete sparse[1];
  const nonordinary = before.slice();
  Object.setPrototypeOf(nonordinary, Object.create(Array.prototype));
  for (const items of [[{...before[0]}, ...before.slice(1)], [before[0], before[0]], sparse, nonordinary]) {
    f.store.items = items;
    assert.throws(() => f.selection.snapshot());
  }
  f.store.items = before;
  assert.equal(f.selection.snapshot().total, 3);
});

test('frozen non-plain drawing records are rejected', t => {
  const f = fixture(t);
  const before = f.store.items;
  const malformed = Object.assign(Object.create({foreign: true}), before[0]);
  f.store.items = [Object.freeze(malformed), ...before.slice(1)];
  assert.throws(() => f.selection.snapshot());
  f.store.items = before;
});

test('constructor rejects non-ChartAPI inputs, disposed models, and accessor ownership without invoking getters', t => {
  for (const api of [undefined, null, {}, {model: {}}, new ChartModel()]) {
    if (api instanceof ChartModel) t.after(() => api.dispose());
    assert.throws(() => new DrawingSelectionController(api));
  }
  const f = fixture(t);
  let reads = 0;
  const api = new ChartAPI(f.model);
  Object.defineProperty(api, 'model', {get() {reads++; return f.model;}});
  assert.throws(() => new DrawingSelectionController(api));
  assert.equal(reads, 0);
  f.model.dispose();
  assert.throws(() => new DrawingSelectionController(f.api), /disposed/i);
});

test('disposing either model or controller rejects subsequent operations; controller disposal is idempotent', t => {
  const f = fixture(t);
  f.selection.select('a');
  f.selection.dispose();
  f.selection.dispose();
  for (const operation of [() => f.selection.snapshot(), () => f.selection.select('a'), () => f.selection.clear(), () => f.selection.refresh(), () => f.selection.applyStyle({width: 3}), () => f.selection.deleteSelected()]) assert.throws(operation, /disposed/i);
  const g = fixture(t);
  g.selection.select('a');
  g.model.dispose();
  for (const operation of [() => g.selection.snapshot(), () => g.selection.select('a'), () => g.selection.clear(), () => g.selection.refresh(), () => g.selection.applyStyle({width: 3}), () => g.selection.deleteSelected()]) assert.throws(operation, /disposed/i);
  g.selection.dispose();
  g.selection.dispose();
});

// Visibility uses a separate presentation action; hidden and locked rows remain
// selectable in this controller even though they cannot own canvas handles.
test('visibility snapshots expose effective defaults; hidden locked batch toggles clear only changed selection',t=>{const f=fixture(t,[drawing('a'),drawing('b',{visible:false,locked:true})]);assert.deepEqual(f.selection.snapshot().rows.map(r=>r.visible),[true,false]);f.selection.select('b');assert.equal(f.selection.setVisibility(false).changed,0);selected(f,['b']);assert.equal(f.selection.setVisibility(true).changed,1);selected(f,[]);assert.equal(f.store.items[1].locked,true);assert.equal(f.store.items[1].visible,true);f.selection.select('a');f.selection.select('b');assert.equal(f.selection.setVisibility(false).changed,2);selected(f,[]);assert.equal(f.store.selected,null);});
test('row visibility targets the opaque exact identity, ignoring mutable metadata; unrelated selection survives',t=>{const f=fixture(t);f.selection.select('a');f.selection.select('b');const row=f.selection.snapshot().rows[0];row.id='keep';row.visible=false;assert.equal(f.selection.setRowVisibility(row,false).changed,1);assert.equal(f.store.items[0].visible,false);assert.equal(f.store.items[2].visible,undefined);selected(f,['b']);assert.throws(()=>f.selection.setRowVisibility(row,true),e=>e.code==='STALE_ROW');});
test('cloned, foreign, missing and same-ID replacement rows cannot drive stale visibility actions',t=>{const f=fixture(t),row=f.selection.snapshot().rows[0],other=new DrawingSelectionController(f.api);t.after(()=>other.dispose());const same=unchanged(f);assert.throws(()=>f.selection.setRowVisibility({...row},false),/snapshot row/);assert.throws(()=>other.setRowVisibility(row,false),/snapshot row/);same();f.api.editDrawing('a',{text:'replacement'});const replaced=unchanged(f);assert.throws(()=>f.selection.setRowVisibility(row,false),e=>e.code==='STALE_ROW');replaced();const live=f.selection.snapshot().rows[0];f.api.deleteDrawing('a');assert.throws(()=>f.selection.setRowVisibility(live,false),e=>e.code==='STALE_ROW');});
test('row no-op preserves group selection and failed visibility preserves exact state',t=>{const f=fixture(t);f.selection.select('a');f.selection.select('b');const row=f.selection.snapshot().rows[0],same=unchanged(f);assert.equal(f.selection.setRowVisibility(row,true).changed,0);selected(f,['a','b']);assert.throws(()=>f.selection.setRowVisibility(row,'false'),/boolean/);same();f.store.begin();const active=unchanged(f);assert.throws(()=>f.selection.setVisibility(false),/transaction/);active();f.store.cancel();});
test('row callback reentry preserves newer selection rather than clearing it',t=>{const f=fixture(t);f.selection.select('a');const row=f.selection.snapshot().rows[0];f.onInvalidate=()=>{f.selection.select('a');f.selection.select('b');};assert.equal(f.selection.setRowVisibility(row,false).changed,1);selected(f,['a','b']);});
test('batch stale visibility refuses all rows; disposed row handles cannot retain a live action',t=>{const f=fixture(t);f.selection.select('a');f.selection.select('b');f.api.editDrawing('b',{text:'replaced'});const same=unchanged(f);assert.throws(()=>f.selection.setVisibility(false),e=>e.code==='STALE_SELECTION');same();selected(f,['a']);const row=f.selection.snapshot().rows[0];f.selection.dispose();assert.throws(()=>f.selection.setRowVisibility(row,false),/disposed/);});

test('duplicate selected appends in source order, keeps canvas selection, and clears only current group selection',t=>{const f=fixture(t,[drawing('a',{visible:false,locked:true}),drawing('b')]);f.selection.select('b');f.selection.select('a');f.store.selected='b';const r=f.selection.duplicate({deltaTimeMs:0,deltaPrice:0});assert.deepEqual(r.created,[{sourceId:'a',id:'drawing-1'},{sourceId:'b',id:'drawing-2'}]);assert.equal(f.store.selected,'b');selected(f,[]);assert.equal(f.store.items[2].visible,false);assert.equal(f.store.items[2].locked,false);assert.ok(Object.isFrozen(r.created));});
test('duplicate stale selected identity rejects every source without consuming IDs',t=>{const f=fixture(t);f.selection.select('a');f.selection.select('b');f.api.editDrawing('b',{text:'new'});const same=unchanged(f);assert.throws(()=>f.selection.duplicate({deltaTimeMs:0,deltaPrice:0}),e=>e.code==='STALE_SELECTION');same();selected(f,['a']);});
test('duplicate rejection preserves selection; committed callback error clears it and stays undoable',t=>{const f=fixture(t);f.selection.select('a');const same=unchanged(f);assert.throws(()=>f.selection.duplicate({deltaTimeMs:0}),/Finite/);same();selected(f,['a']);f.onInvalidate=()=>{throw Error('notification');};const r=f.selection.duplicate({deltaTimeMs:0,deltaPrice:0});assert.equal(r.invalidationFailed,true);selected(f,[]);assert.equal(f.store.items.length,4);f.store.undo();assert.equal(f.store.items.length,3);});
test('duplicate callback newer selection and disposal survive returning receipt',t=>{const f=fixture(t);f.selection.select('a');f.onInvalidate=()=>f.selection.select('b');const r=f.selection.duplicate({deltaTimeMs:0,deltaPrice:0});assert.equal(r.changed,1);selected(f,['a','b']);f.onInvalidate=()=>f.selection.dispose();const next=f.selection.duplicate({deltaTimeMs:0,deltaPrice:0});assert.equal(next.changed,2);assert.throws(()=>f.selection.snapshot(),/disposed/);});

test('style preset capture retains explicit selection; apply clears only its successful prior selection',async t=>{const {DrawingStylePresets}=await import('../src/index.mjs'),f=fixture(t),p=new DrawingStylePresets();f.selection.select('a');assert.deepEqual(f.selection.captureStylePreset(p,'Saved'),{changed:1});selected(f,['a']);assert.deepEqual(p.get('Saved').style,{color:'#102030ff',width:2});f.selection.select('b');p.set('Wide',{width:4});assert.deepEqual(f.selection.applyStylePreset(p,'Wide'),{changed:2,invalidationFailed:false});selected(f,[]);assert.equal(f.store.items[0].style.width,4);});
test('style preset capture rejects no/multiple/stale selected identities without registry mutation',async t=>{const {DrawingStylePresets}=await import('../src/index.mjs'),f=fixture(t),p=new DrawingStylePresets();assert.throws(()=>f.selection.captureStylePreset(p,'Saved'),/exactly one/);f.selection.select('a');f.selection.select('b');assert.throws(()=>f.selection.captureStylePreset(p,'Saved'),/exactly one/);f.selection.select('b',false);f.store.edit('a',{text:'replacement'});assert.throws(()=>f.selection.captureStylePreset(p,'Saved'),e=>e.code==='STALE_SELECTION');assert.equal(p.list().length,0);selected(f,[]);});
test('style preset apply retains newer reentrant selection and respects disposal and ownership',async t=>{const {DrawingStylePresets}=await import('../src/index.mjs'),f=fixture(t),p=new DrawingStylePresets();p.set('Wide',{width:4});f.selection.select('a');f.onInvalidate=()=>f.selection.select('b');assert.equal(f.selection.applyStylePreset(p,'Wide').changed,1);selected(f,['a','b']);f.selection.dispose();assert.throws(()=>f.selection.captureStylePreset(p,'Saved'),/disposed/);assert.throws(()=>f.selection.applyStylePreset(p,'Wide'),/disposed/);});
