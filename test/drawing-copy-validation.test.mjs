import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingStore} from '../src/core/drawings.mjs';

const horizontal = (extra = {}) => ({
  type: 'horizontal', points: [{time: 1700000000000, price: 10}], ...extra,
});

// Preserve every own state field and nested history-array entry, including
// identities. This captures items, undo/redo, serial, selection, transaction,
// retained-history bytes, limits and the bookkeeping WeakMaps.
function captureState(store) {
  const fields = Object.fromEntries(Object.keys(store).map(key => [key, store[key]]));
  const arrays = [];
  const visited = new Set();
  function captureArray(array) {
    if (visited.has(array)) return;
    visited.add(array);
    arrays.push([array, array.slice()]);
    for (const value of array) if (Array.isArray(value)) captureArray(value);
  }
  for (const value of Object.values(fields)) if (Array.isArray(value)) captureArray(value);
  return () => {
    assert.deepEqual(Object.keys(store), Object.keys(fields), 'own store fields unchanged');
    for (const [key, value] of Object.entries(fields)) {
      assert.strictEqual(store[key], value, `${key} identity/value unchanged`);
    }
    for (const [array, values] of arrays) {
      assert.equal(array.length, values.length, 'history array length unchanged');
      values.forEach((value, i) => assert.strictEqual(array[i], value, `history entry ${i} unchanged`));
    }
  };
}

function populatedStore(activeTransaction = false) {
  const store = new DrawingStore();
  const id = store.add(horizontal());
  store.edit(id, {text: 'first committed edit'});
  store.edit(id, {text: 'second committed edit'});
  assert.equal(store.undo(), true);
  store.selected = id;
  assert.ok(store.undoStack.length > 0);
  assert.ok(store.redoStack.length > 0);
  assert.equal(store.serial, 1);
  if (activeTransaction) {
    store.begin();
    store.edit(id, {text: 'pending gesture edit'});
  }
  return {store, id};
}

function assertRejectedAtomically(operation, makeInput, expected, activeTransaction = false) {
  const {store, id} = populatedStore(activeTransaction);
  const unchanged = captureState(store);
  let beforeMutations = 0;
  const context = {beforeMutation() { beforeMutations++; }};
  const candidate = makeInput(operation);
  try {
    assert.throws(() => operation === 'add'
      ? store.add(horizontal(candidate), context)
      : store.edit(id, candidate, context), expected);
  } finally {
    assert.equal(beforeMutations, 0, 'beforeMutation must not run for rejected candidates');
    unchanged();
  }
}

// Deliberately remain valid through the initial validation (and, for edit,
// through equality serialization), then change during the copy serialization.
// Read counts here target the current validator's expressions; these tests do
// not require getters to run once or prevent harmless repeated access.
function changesWhenCopied(operation, target, field, initialValue, finalValue, validationReads) {
  let reads = 0;
  const validReads = validationReads + (operation === 'edit' ? 1 : 0);
  Object.defineProperty(target, field, {
    enumerable: true,
    get() {
      if (++reads <= validReads) return initialValue;
      if (finalValue instanceof Error) throw finalValue;
      return finalValue;
    },
  });
  return target;
}

const invalidCopiedCases = [
  {
    label: 'price getter becomes Infinity (JSON null)', expected: {name: 'TypeError'},
    input(operation) {
      return {points: [changesWhenCopied(operation, {time: 1700000000000}, 'price', 11, Infinity, 1)]};
    },
  },
  {
    label: 'time getter leaves the Date range', expected: {name: 'TypeError'},
    input(operation) {
      return {points: [changesWhenCopied(operation, {price: 11}, 'time', 1700000000000, 8640000000000001, 2)]};
    },
  },
  {
    label: 'time getter becomes Infinity (JSON null)', expected: {name: 'TypeError'},
    input(operation) {
      return {points: [changesWhenCopied(operation, {price: 11}, 'time', 1700000000000, Infinity, 2)]};
    },
  },
  {
    label: 'style width getter becomes Infinity (JSON null)', expected: {name: 'RangeError'},
    input(operation) {
      return {style: changesWhenCopied(operation, {color: '#ffffff'}, 'width', 2, Infinity, 4)};
    },
  },
  {
    label: 'style width getter falls below the minimum', expected: {name: 'RangeError'},
    input(operation) {
      return {style: changesWhenCopied(operation, {color: '#ffffff'}, 'width', 2, 0, 4)};
    },
  },
  {
    label: 'style color getter changes to a non-string', expected: {name: 'TypeError'},
    input(operation) {
      return {style: changesWhenCopied(operation, {width: 2}, 'color', '#ffffff', 42, 2)};
    },
  },
];

for (const operation of ['add', 'edit']) {
  for (const fixture of invalidCopiedCases) {
    for (const activeTransaction of [false, true]) {
      test(`${operation}: rejects copied ${fixture.label}; ${activeTransaction ? 'active gesture' : 'committed state'} stays atomic`, () => {
        assertRejectedAtomically(operation, fixture.input, fixture.expected, activeTransaction);
      });
    }
  }

  for (const field of ['price', 'time', 'width']) {
    test(`${operation}: ${field} getter exception during copying leaves all state and callbacks unchanged`, () => {
      const error = new Error(`copy-time ${field} getter failure`);
      assertRejectedAtomically(operation, operation => field === 'width'
        ? {style: changesWhenCopied(operation, {color: '#ffffff'}, 'width', 2, error, 4)}
        : {points: [changesWhenCopied(operation,
          field === 'price' ? {time: 1700000000000} : {price: 11},
          field, field === 'price' ? 11 : 1700000000000, error, field === 'price' ? 1 : 2)]},
      value => value === error, true);
    });
  }
}

function withToJSON(object, replacement) {
  Object.defineProperty(object, 'toJSON', {enumerable: false, value() { return replacement; }});
  assert.equal(Object.keys(object).includes('toJSON'), false);
  return object;
}

const toJSONCases = [
  {
    label: 'anchor toJSON returns an invalid price', expected: {name: 'TypeError'},
    input: () => ({points: [withToJSON({time: 1, price: 11}, {time: 1, price: Infinity})]}),
  },
  {
    label: 'anchor toJSON returns an out-of-range time', expected: {name: 'TypeError'},
    input: () => ({points: [withToJSON({time: 1, price: 11}, {time: 8640000000000001, price: 11})]}),
  },
  {
    label: 'points toJSON returns an invalid anchor count', expected: {name: 'TypeError'},
    input: () => ({points: withToJSON([{time: 1, price: 11}], [])}),
  },
  {
    label: 'style toJSON returns an invalid width', expected: {name: 'RangeError'},
    input: () => ({style: withToJSON({color: '#ffffff', width: 2}, {color: '#ffffff', width: 99})}),
  },
  {
    label: 'style toJSON returns null', expected: {name: 'TypeError'},
    input: () => ({style: withToJSON({color: '#ffffff', width: 2}, null)}),
  },
];
for (const operation of ['add', 'edit']) {
  for (const fixture of toJSONCases) {
    test(`${operation}: non-enumerable ${fixture.label} is rejected atomically`, () => {
      assertRejectedAtomically(operation, fixture.input, fixture.expected, true);
    });
  }
}

function assertFrozenDrawing(drawing) {
  assert.ok(Object.isFrozen(drawing));
  assert.ok(Object.isFrozen(drawing.points));
  assert.ok(drawing.points.every(point => Object.isFrozen(point)));
  assert.ok(Object.isFrozen(drawing.style));
}
function assertRoundTrips(store) {
  const saved = store.save();
  const receiver = new DrawingStore();
  receiver.load(saved);
  assert.equal(receiver.save(), saved);
  assert.deepEqual(receiver.items, store.items);
}

test('ordinary add/edit still copy, freeze, call beforeMutation once and preserve undo/redo behavior', () => {
  const store = new DrawingStore();
  const points = [{time: 1700000000000, price: 10}];
  const style = {color: '#ffffff', width: 2};
  let beforeMutations = 0;
  const id = store.add(horizontal({points, style}), {beforeMutation() {
    beforeMutations++;
    assert.equal(store.items.length, 0);
    assert.equal(store.serial, 0);
  }});
  assert.equal(id, 'drawing-1');
  assert.equal(store.selected, id);
  assert.equal(store.serial, 1);
  assert.equal(beforeMutations, 1);
  const initial = store.items[0];
  assertFrozenDrawing(initial);
  assert.notStrictEqual(initial.points, points);
  assert.notStrictEqual(initial.points[0], points[0]);
  assert.notStrictEqual(initial.style, style);
  points[0].price = 999;
  style.width = 49;
  assert.equal(initial.points[0].price, 10);
  assert.equal(initial.style.width, 2);
  store.edit(id, {points: [{time: 1700000000001, price: 12}], style: {color: '#00ff00', width: 3}}, {
    beforeMutation() { beforeMutations++; assert.strictEqual(store.items[0], initial); },
  });
  assert.equal(beforeMutations, 2);
  assert.equal(store.serial, 1);
  assert.equal(store.selected, id);
  const edited = store.items[0];
  assertFrozenDrawing(edited);
  assert.equal(store.undoStack.length, 2);
  assertRoundTrips(store);
  assert.equal(store.undo(), true);
  assert.strictEqual(store.items[0], initial);
  assert.equal(store.redo(), true);
  assert.strictEqual(store.items[0], edited);
  assertRoundTrips(store);
});

test('ordinary no-op edit still calls beforeMutation without changing history or record identity', () => {
  const {store, id} = populatedStore();
  const unchanged = captureState(store);
  let calls = 0;
  store.edit(id, {text: 'first committed edit'}, {beforeMutation() { calls++; }});
  assert.equal(calls, 1);
  unchanged();
});

for (const operation of ['add', 'edit']) {
  test(`${operation}: signed-zero anchors retain existing JSON normalization and round-trip behavior`, () => {
    const store = new DrawingStore();
    let id;
    if (operation === 'add') id = store.add(horizontal({points: [{time: -0, price: -0}], axisId: null, seriesId: null}));
    else {
      id = store.add(horizontal());
      store.edit(id, {points: [{time: -0, price: -0}], axisId: null, seriesId: null});
    }
    assert.equal(store.items[0].id, id);
    assert.ok(Object.is(store.items[0].points[0].time, 0));
    assert.ok(Object.is(store.items[0].points[0].price, 0));
    assert.equal(Object.hasOwn(store.items[0], 'axisId'), false);
    assert.equal(Object.hasOwn(store.items[0], 'seriesId'), false);
    assertFrozenDrawing(store.items[0]);
    assertRoundTrips(store);
  });
}

test('valid non-enumerable nested toJSON still follows the existing JSON copy contract', () => {
  const store = new DrawingStore();
  const id = store.add(horizontal({points: [withToJSON({time: 1, price: 10}, {time: 2, price: 20})]}));
  assert.deepEqual(store.items[0].points, [{time: 2, price: 20}]);
  store.edit(id, {style: withToJSON({color: '#ffffff', width: 2}, {color: '#00ff00', width: 3})});
  assert.deepEqual(store.items[0].style, {color: '#00ff00', width: 3});
  assertFrozenDrawing(store.items[0]);
  assertRoundTrips(store);
});
