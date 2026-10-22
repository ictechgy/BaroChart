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

// Valid JSON can grow when numbers and public portable colors are normalized.
// Admission must measure the exact document the writer will subsequently emit.
function importedDocument(version, {color = 'red', compactNumbers = true} = {}) {
  const drawing = {
    id: 'imported', type: version >= 3 ? 'longposition' : 'horizontal', panel: 'price',
    points: version >= 3
      ? [{time: 1e10, price: 1e20}, {time: 1e10, price: 9e19}, {time: 1e10, price: 2e20}, {time: 2e10, price: 1e20}]
      : [{time: 1e10, price: 1e20}],
    style: {color}, ...(version >= 2 ? {axisId: 'other', seriesId: 'price-series'} : {}),
    ...(version === 4 ? {visible: false, locked: true} : {}),
  };
  let text = JSON.stringify({schema: 'aster.drawings', version, drawings: [drawing]});
  if (compactNumbers) text = text.replaceAll('100000000000000000000', '1e20')
    .replaceAll('90000000000000000000', '9e19').replaceAll('200000000000000000000', '2e20')
    .replaceAll('10000000000', '1e10').replaceAll('20000000000', '2e10');
  return text;
}
function importModel(t, limit) {
  const model = new ChartModel();
  t.after(() => model.dispose());
  model.drawings = new DrawingStore({maxDocumentChars: limit});
  model.addAxis({id: 'other', panel: 'price'});
  model.addSeries({id: 'price-series', type: 'line', panel: 'price', axisId: 'other'});
  return model;
}
for (const version of [1, 2, 3, 4]) {
  for (const compactNumbers of [false, true]) {
    test(`v${version} normalized ${compactNumbers ? 'numeric/color' : 'color'} overflow rejects before any import mutation`, t => {
      const text = importedDocument(version, {compactNumbers});
      const reference = importModel(t, 8388608), referenceAPI = new ChartAPI(reference);
      referenceAPI.loadDrawings(text);
      const canonical = referenceAPI.saveDrawings();
      assert.ok(canonical.length > text.length, 'fixture expands after normalization');
      for (const limit of [text.length, canonical.length - 1]) {
        const model = importModel(t, limit);
        populateHistory(model.drawings);
        let invalidations = 0;
        const api = new ChartAPI(model, {invalidate() { invalidations++; }});
        const unchanged = captureState(model.drawings);
        assertDocumentLimit(() => api.loadDrawings(text), model.drawings);
        unchanged();
        assert.equal(invalidations, 0, 'rejected import never announces a change');
      }
    });
  }
  test(`v${version} normalized import at exact output budget saves and undoes in one step`, t => {
    const text = importedDocument(version);
    const reference = importModel(t, 8388608), api = new ChartAPI(reference);
    api.loadDrawings(text);
    const canonical = api.saveDrawings();
    const model = importModel(t, canonical.length), receiver = new ChartAPI(model);
    populateHistory(model.drawings);
    const previous = model.drawings.items.slice(), depth = model.drawings.undoStack.length;
    receiver.loadDrawings(text);
    assert.equal(receiver.saveDrawings(), canonical);
    assert.equal(model.drawings.undoStack.length, depth + 1);
    assert.equal(model.drawings.selected, null);
    assert.ok(model.drawings.items.every(Object.isFrozen));
    model.drawings.undo(); assert.deepEqual(model.drawings.items, previous);
    model.drawings.redo(); assert.equal(receiver.saveDrawings(), canonical);
  });
}
test('direct DrawingStore import accounts for canonical numeric expansion without a style decoder', () => {
  const text = importedDocument(1, {color: '#ff0000ff'});
  const store = new DrawingStore({maxDocumentChars: text.length});
  populateHistory(store);
  const unchanged = captureState(store);
  assertDocumentLimit(() => store.load(text), store);
  unchanged();
});
test('normalized import keeps the existing active-transaction error and pending state', () => {
  const text = importedDocument(1), store = new DrawingStore({maxDocumentChars: text.length});
  const id = populateHistory(store);
  store.begin(); store.edit(id, {text: 'pending'});
  const unchanged = captureState(store);
  assert.throws(() => store.load(text), {message: 'Cannot load during a gesture'});
  unchanged();
});
test('higher incoming schema saves with the minimal version, using that exact size', () => {
  const text = '{"schema":"aster.drawings","version":4,"drawings":[]}';
  const store = new DrawingStore({maxDocumentChars: text.length});
  store.load(text);
  assert.equal(store.save(), '{"schema":"aster.drawings","version":1,"drawings":[]}');
});

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
