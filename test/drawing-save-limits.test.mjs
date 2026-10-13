import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingStore, ChartModel, ChartAPI} from '../src/core/index.mjs';

// Writer and reader enforce the same bounded document contract.
const encode = store => JSON.stringify({
  schema: 'aster.drawings',
  version: store.items.some(d => d.axisId != null || d.seriesId != null) ? 2 : 1,
  drawings: store.items,
});
const horizontal = (extra = {}) => ({
  type: 'horizontal', points: [{time: 1700000000000, price: 12.5}], ...extra,
});

// Preserve object identity as well as all observable array contents. Drawings
// and their points/styles are frozen; histories contain arrays of those values.
function captureState(store) {
  const values = Object.fromEntries(Object.keys(store).map(key => [key, store[key]]));
  const arrays = [];
  function captureArray(array) {
    arrays.push([array, array.slice()]);
    for (const value of array) if (Array.isArray(value)) captureArray(value);
  }
  for (const value of Object.values(values)) if (Array.isArray(value)) captureArray(value);
  return () => {
    assert.deepEqual(Object.keys(store), Object.keys(values), 'own store fields unchanged');
    for (const [key, value] of Object.entries(values)) {
      assert.strictEqual(store[key], value, `${key} identity/value unchanged`);
    }
    for (const [array, values] of arrays) {
      assert.equal(array.length, values.length, 'array length unchanged');
      values.forEach((value, i) => assert.strictEqual(array[i], value, `array entry ${i} unchanged`));
    }
  };
}
function assertDocumentLimit(operation, store) {
  assert.throws(operation, {
    name: 'TypeError',
    message: `Drawing document: string limit ${store.maxDocumentChars}`,
  });
}
function populateHistory(store) {
  const id = store.add(horizontal());
  store.edit(id, {text: 'first committed edit'});
  store.edit(id, {text: 'second committed edit'});
  store.undo();
  store.selected = id;
  assert.ok(store.undoStack.length > 0);
  assert.ok(store.redoStack.length > 0);
  assert.equal(store.serial, 1);
  return id;
}

const emptyDocument = JSON.stringify({schema: 'aster.drawings', version: 1, drawings: []});
test('empty document succeeds at the exact character limit and round-trips', () => {
  const store = new DrawingStore({maxDocumentChars: emptyDocument.length});
  const unchanged = captureState(store);
  assert.equal(store.save(), emptyDocument);
  unchanged();
  const receiver = new DrawingStore({maxDocumentChars: emptyDocument.length});
  receiver.load(store.save());
  assert.equal(receiver.save(), emptyDocument);
});

for (const limit of [0, 1, emptyDocument.length - 1]) {
  test(`empty save rejects tiny limit ${limit} without changing state`, () => {
    const store = new DrawingStore({maxDocumentChars: limit});
    const unchanged = captureState(store);
    try { assertDocumentLimit(() => store.save(), store); }
    finally { unchanged(); }
    assertDocumentLimit(() => new DrawingStore({maxDocumentChars: limit}).load(emptyDocument), store);
  });
}

test('nonempty save rejects a tiny custom document limit', () => {
  const store = new DrawingStore({maxDocumentChars: 100});
  store.add(horizontal({id: 'small'}));
  assert.ok(encode(store).length > store.maxDocumentChars);
  const unchanged = captureState(store);
  try { assertDocumentLimit(() => store.save(), store); }
  finally { unchanged(); }
});

for (const version of [1, 2]) {
  const input = horizontal({id: `v${version}`, text: '메모 😀', ...(version === 2 ? {axisId: 'other', seriesId: 'price-series'} : {})});
  const fixture = new DrawingStore();
  fixture.add(input);
  const expected = encode(fixture);

  test(`v${version} save preserves exact serialization at and above the limit boundary`, () => {
    assert.equal(JSON.parse(expected).version, version);
    // The contract counts JS string characters, not UTF-8 encoded bytes.
    assert.ok(Buffer.byteLength(expected, 'utf8') > expected.length);
    for (const limit of [expected.length, expected.length + 1]) {
      const store = new DrawingStore({maxDocumentChars: limit});
      store.add(input);
      const unchanged = captureState(store);
      const saved = store.save();
      assert.equal(saved, expected);
      unchanged();
      const receiver = new DrawingStore({maxDocumentChars: limit});
      receiver.load(saved);
      assert.equal(receiver.save(), saved);
      assert.deepEqual(receiver.items, store.items);
    }
  });

  test(`v${version} save rejects a document one character over the limit atomically`, () => {
    const store = new DrawingStore({maxDocumentChars: expected.length - 1});
    store.add(input);
    assert.equal(encode(store).length, store.maxDocumentChars + 1);
    const unchanged = captureState(store);
    try { assertDocumentLimit(() => store.save(), store); }
    finally { unchanged(); }
    const receiver = new DrawingStore({maxDocumentChars: store.maxDocumentChars});
    assertDocumentLimit(() => receiver.load(expected), receiver);
  });
}

test('oversized save preserves generated ID serial, selection, undo and redo history', () => {
  const store = new DrawingStore({maxDocumentChars: 100});
  populateHistory(store);
  const unchanged = captureState(store);
  try { assertDocumentLimit(() => store.save(), store); }
  finally { unchanged(); }
});

for (const limit of [100, 8388608]) {
  test(`active-transaction guard retains precedence and state at document limit ${limit}`, () => {
    const store = new DrawingStore({maxDocumentChars: limit});
    const id = populateHistory(store);
    store.begin();
    store.edit(id, {text: 'pending transaction edit'});
    const unchanged = captureState(store);
    assert.throws(() => store.save(), {name: 'Error', message: 'Commit or cancel before saving'});
    unchanged();
    store.cancel();
    assert.equal(store.items[0].text, 'first committed edit');
    assert.ok(store.redoStack.length > 0);
  });
}

for (const version of [1, 2]) {
  test(`ChartAPI v${version} round-trips with valid bindings and no save side effects`, () => {
    const model = new ChartModel();
    const receiverModel = new ChartModel();
    let invalidations = 0;
    const api = new ChartAPI(model, {invalidate() { invalidations++; }});
    const receiver = new ChartAPI(receiverModel);
    try {
      if (version === 2) {
        for (const facade of [api, receiver]) {
          facade.addAxis({id: 'other', panel: 'price'});
          facade.addSeries({id: 'price-series', type: 'line', panel: 'price', axisId: 'other'});
        }
      }
      api.addDrawing(horizontal({id: 'public', ...(version === 2 ? {axisId: 'other', seriesId: 'price-series'} : {})}));
      const unchanged = captureState(model.drawings);
      const beforeInvalidations = invalidations;
      const beforeVersion = model.store.version;
      const saved = api.saveDrawings();
      assert.equal(JSON.parse(saved).version, version);
      assert.equal(saved, encode(model.drawings));
      unchanged();
      assert.equal(invalidations, beforeInvalidations);
      assert.equal(model.store.version, beforeVersion);
      receiver.loadDrawings(saved);
      assert.equal(receiver.saveDrawings(), saved);
    } finally {
      model.dispose(); receiverModel.dispose();
    }
  });
}

test('ChartAPI propagates custom-limit rejection without cancelling a gesture or notifying', () => {
  const model = new ChartModel();
  model.drawings = new DrawingStore({maxDocumentChars: 100});
  populateHistory(model.drawings);
  let invalidations = 0, cancellations = 0;
  const controller = {gesture: null, cancel() { cancellations++; }};
  const api = new ChartAPI(model, {controller, invalidate() { invalidations++; }});
  try {
    const unchanged = captureState(model.drawings);
    const version = model.store.version;
    try { assertDocumentLimit(() => api.saveDrawings(), model.drawings); }
    finally {
      unchanged();
      assert.equal(model.store.version, version);
      assert.equal(invalidations, 0);
      assert.equal(cancellations, 0);
    }
  } finally { model.dispose(); }
});

test('ChartAPI active transaction remains active and uncancelled after rejected save', () => {
  const model = new ChartModel();
  model.drawings = new DrawingStore({maxDocumentChars: 100});
  const id = populateHistory(model.drawings);
  model.drawings.begin();
  model.drawings.edit(id, {text: 'pending gesture'});
  const gesture = {kind: 'edit', id};
  let invalidations = 0, cancellations = 0;
  const controller = {gesture, cancel() { cancellations++; }};
  const api = new ChartAPI(model, {controller, invalidate() { invalidations++; }});
  try {
    const unchanged = captureState(model.drawings);
    const version = model.store.version;
    assert.throws(() => api.saveDrawings(), {name: 'Error', message: 'Commit or cancel before saving'});
    unchanged();
    assert.strictEqual(controller.gesture, gesture);
    assert.equal(model.store.version, version);
    assert.equal(invalidations, 0);
    assert.equal(cancellations, 0);
  } finally { model.dispose(); }
});

test('default 200000-point public document exceeds 8 Mi characters and cannot be saved', () => {
  const model = new ChartModel();
  const receiverModel = new ChartModel();
  let invalidations = 0;
  const api = new ChartAPI(model, {invalidate() { invalidations++; }});
  const receiver = new ChartAPI(receiverModel);
  try {
    const points = Array.from({length: 2000}, (_, i) => ({time: 1700000000000 + i, price: 12345.67890123456 + i / 1000}));
    for (let i = 0; i < 100; i++) api.addDrawing({id: `freehand-${i}`, type: 'freehand', panel: 'price', points});
    assert.equal(model.drawings.maxPoints, 200000);
    assert.equal(model.drawings.maxDocumentChars, 8388608);
    assert.equal(model.drawings.items.reduce((n, d) => n + d.points.length, 0), 200000);
    assert.equal(model.drawings.items.length, 100);
    assert.doesNotThrow(() => model.drawings.budget(model.drawings.items));
    const raw = encode(model.drawings);
    assert.equal(raw.length, 9832942);
    assert.ok(raw.length > model.drawings.maxDocumentChars);
    assert.equal(JSON.parse(raw).version, 1);
    const receiverUnchanged = captureState(receiverModel.drawings);
    assertDocumentLimit(() => receiver.loadDrawings(raw), receiverModel.drawings);
    receiverUnchanged();
    const unchanged = captureState(model.drawings);
    const beforeInvalidations = invalidations;
    const version = model.store.version;
    try { assertDocumentLimit(() => api.saveDrawings(), model.drawings); }
    finally {
      unchanged();
      assert.equal(model.store.version, version);
      assert.equal(invalidations, beforeInvalidations);
    }
  } finally { model.dispose(); receiverModel.dispose(); }
});
