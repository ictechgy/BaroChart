import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, FIELDS, seededColumns} from '../src/core/data.mjs';
import {ChartModel, createLayout} from '../src/core/model.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {InteractionController} from '../src/core/interaction.mjs';
import {builtinIndicators} from '../src/core/indicators.mjs';
import {buildScene} from '../src/core/scene.mjs';
import {drawingGeometry} from '../src/core/drawings.mjs';
import {BlockRangeIndex} from '../src/core/block-index.mjs';
import {assertDataIngestionIdle} from '../src/core/ingestion.mjs';
import {NativeCheckpointMap, NativeCheckpointBudget} from '../src/core/native-checkpoints.mjs';
import {saveWorkspace} from '../src/core/workspace.mjs';
import {safeCheckpointParse, safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
import {NativeWorkspaceCapture} from '../src/core/native-workspace-source.mjs';
import {NativeWorkspacePrepared} from '../src/core/native-workspace-target.mjs';

// Direct source tests exercise the two JS protocols, never a facade, host swap,
// generated native bundle, or a second implementation of source capture.
const BINDING = Object.freeze({key: 'native-source:ASTER/1m', revision: '2026-10-13.1',
  adjustmentVersion: 'raw-v1', priceUnit: 'USD', adjustment: 'raw'});
const SIZE = Object.freeze({width: 1100, height: 760});
const REVISION = 41;

function fixture(t, {n = 257, names = ['ema'], rich = false, input = false, ingestion = false} = {}) {
  const columns = seededColumns(Math.max(n, 514), 419), store = new BarStore([], {maxBars: 4096, timeframeMs: 60000, timeOrigin: 123});
  store.setColumns(columns, n);
  const model = new ChartModel({store, precision: 5, axisWidth: 83,
    panels: rich ? [{id: 'price', weight: 3}, {id: 'osc', weight: 1, range: [-200, 200]}] : [{id: 'price'}],
    axes: rich ? [{id: 'left', panel: 'price', side: 'left', width: 64, range: [50, 150]}] : []});
  const size = {...SIZE}, controller = input ? new InteractionController(model, () => size) : null;
  const api = new ChartAPI(model, {controller});
  for (const name of names) api.addIndicator(name, name, {});
  api.addSeries({id: 'candles', type: 'candles', panel: 'price'});
  api.addSeries({id: 'close', type: 'line', panel: 'price', source: 'close', color: '#8877dd'});
  if (names.includes('ema')) api.addSeries({id: 'ema', type: 'line', panel: 'price', indicator: 'ema'});
  model.view = {from: -20.125, to: n + 45.875}; model.follow = true;
  if (rich) {
    api.setSymbol({id: 'ASTER', exchange: 'TEST', timezone: 'America/New_York', currency: 'USD',
      volumeUnit: 'shares', priceDecimals: 2, tickSize: .01, adjustment: 'raw'});
    model.precision = 7;
    const first = n ? store.columns.time[0] : 1700000000000, last = n ? store.columns.time[n - 1] : first;
    api.addDrawing({id: 'trend', type: 'trendline', panel: 'price', axisId: 'left',
      points: [{time: first - 180000.25, price: 97.125}, {time: last + 240000.75, price: 103.875}]});
    api.addDrawing({id: 'note', type: 'text', panel: 'price', seriesId: 'close',
      points: [{time: last + 720000.125, price: 102.0625}], text: '한국 🚀 exact anchors'});
    model.drawings.selected = null; model.crosshair = null;
  }
  if (ingestion) api.configureDataIngestion({streamId: 'source-tests', generation: 3, maxQueuedEvents: 8, maxBatchEvents: 8});
  t.after(() => model.dispose());
  return {columns, store, model, api, input: controller, size, text: saveWorkspace(api, BINDING)};
}
function capture(t, f, options = {}) {
  const c = new NativeWorkspaceCapture(f.api, f.text, BINDING, {input: f.input, size: f.size, revision: REVISION, ...options});
  t.after(() => c.dispose()); return c;
}
function admit(c, revision = REVISION, maxRecords = 3) {
  for (let i = 0; i < 10000; i++) {const progress = c.step(maxRecords, revision); if (progress.complete) return progress;}
  assert.fail('Source admission did not terminate');
}
function copy(c, target = null, revision = REVISION, chunk = 71) {
  const length = c.model.store.length;
  // Different slots may be interleaved; each individual slot is sequential.
  for (let offset = 0; offset < length; offset += chunk) for (let slot = FIELDS.length - 1; slot >= 0; slot--) {
    const count = Math.min(chunk, length - offset), borrowed = c.buffer(slot, offset, count, revision);
    const source = c.model.store.columns[FIELDS[slot]];
    assert.equal(borrowed.buffer, source.buffer); assert.equal(borrowed.byteOffset, source.byteOffset + offset * 8);
    assert.deepEqual([...borrowed], [...source.subarray(offset, offset + count)]);
    if (target) {const owned = target.target(slot, offset, count); assert.notEqual(owned.buffer, borrowed.buffer); owned.set(borrowed);}
  }
}
function run(target) {
  target.start();
  for (let i = 0; i < 10000; i++) if (target.step(113).complete) return;
  assert.fail('Target preparation did not terminate');
}
function live(f, listeners) {
  assert.notEqual(f.model.disposed, true); assert.equal(f.model.store, f.store);
  assert.deepEqual([...f.store.listeners], listeners, 'source subscriptions keep their identity');
  for (const key of FIELDS) assert.ok(f.store.columns[key].buffer.byteLength > 0, 'source ' + key + ' is not detached');
  assert.doesNotThrow(() => assertDataIngestionIdle(f.model));
  if (f.model.dataIngestion) assert.equal(f.model.dataIngestion.leased, false);
}
function released(c) {
  assert.equal(c.closed, true);
  for (const key of ['api', 'model', 'input', 'size', 'session', 'refs', 'before', 'document', 'binding', 'metadataJSON', 'ingestionText', 'recordIterator']) assert.equal(c[key], null, key);
  for (const key of ['records', 'frames', 'buffers']) assert.deepEqual(c[key], [], key);
  assert.throws(() => c.step(1, REVISION), /closed/); assert.throws(() => c.buffer(0, 0, 1, REVISION), /closed/);
  assert.throws(() => c.finish(REVISION), /closed/); assert.doesNotThrow(() => c.dispose());
}
function rawCost(value) {
  const nodes = v => 1 + (v && typeof v === 'object' ? Object.values(v).reduce((sum, x) => sum + nodes(x), 0) : 0);
  return safeCheckpointStringify(value).length * 2 + nodes(value) * 32;
}
function backingBytes(model) {
  const buffers = new Set(), add = a => {if (a) buffers.add(a.buffer);}, tree = t => {for (const k of ['min', 'max', 'sum']) add(t?.[k]);};
  for (const key of FIELDS) add(model.store.columns[key]); tree(model.store.index);
  if (model.dataIngestion) {for (const key of FIELDS) add(model.dataIngestion.columns[key]); add(model.dataIngestion.kinds);}
  for (const entry of model.indicators.entries.values()) for (const array of entry.arrays) add(array);
  for (const item of model.series) {add(item.values); add(item.rangeIndex?.values); tree(item.rangeIndex instanceof BlockRangeIndex ? item.rangeIndex.tree : item.rangeIndex);}
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
function vectors(model) {
  return Object.fromEntries([...model.indicators.entries].map(([id]) => [id,
    Object.fromEntries(Object.entries(model.indicators.get(id).outputs).map(([key, values]) => [key, [...values]]))]));
}
function freshOracle(t, f) {
  const store = new BarStore(); store.setColumns(f.store.columns, f.store.length);
  const model = new ChartModel({store}); t.after(() => model.dispose());
  for (const [id, entry] of f.model.indicators.entries) model.indicators.add(id, entry.name, {...entry.params});
  return vectors(model);
}

test('source lazily measures all 33 raw builtin checkpoint histories without get or recalculation', t => {
  const names = [...builtinIndicators.keys()]; assert.equal(names.length, 33);
  const f = fixture(t, {n: 513, names}), listeners = [...f.store.listeners], entries = [...f.model.indicators.entries.values()];
  // Deliberately leave the caches dirty: admission is accounting, not source calculation.
  const last = f.store.at(512); f.store.update(512, {...last, close: last.high});
  const before = entries.map(e => ({entry: e, arrays: e.arrays, revision: e.revision, dirty: e.dirty,
    records: [...e.checkpoints], values: e.arrays.map(a => [...a])}));
  const count = before.reduce((n, e) => n + e.records.length, 0);
  const expected = before.reduce((n, e) => n + e.records.reduce((sum, [, state]) => sum + 128 + rawCost(state), 0), 0);
  let gets = 0, creates = 0;
  f.model.indicators.get = () => {gets++; throw new Error('source get forbidden');};
  for (const e of entries) e.def.create = () => {creates++; throw new Error('source calculation forbidden');};
  const c = capture(t, f); assert.equal(c.recordCount, 0); assert.equal(c.checkpointBytes, count * 128);
  assert.equal(c.step(1, REVISION).complete, false); assert.equal(c.recordCount, 1);
  admit(c, REVISION, 2); assert.equal(c.recordCount, count); assert.equal(c.checkpointBytes, expected);
  assert.equal(c.sourceBytes, backingBytes(f.model)); assert.equal(gets, 0); assert.equal(creates, 0);
  for (const old of before) {const e = old.entry; assert.equal(e.arrays, old.arrays); assert.equal(e.revision, old.revision);
    assert.equal(e.dirty, old.dirty); assert.deepEqual([...e.checkpoints], old.records); assert.deepEqual(e.arrays.map(a => [...a]), old.values);}
  c.dispose(); released(c); live(f, listeners);
});

test('already encoded NativeCheckpointMap source is charged without decoding or iteration', t => {
  const f = fixture(t), e = f.model.indicators.entries.get('ema'), budget = new NativeCheckpointBudget();
  const encoded = new NativeCheckpointMap(e.name, e.params, {budget});
  for (const [index, state] of e.checkpoints) encoded.set(index, state);
  e.checkpoints = encoded; t.after(() => encoded.dispose());
  const expected = encoded.encodedBytes + encoded.size * 128, listeners = [...f.store.listeners];
  for (const key of ['get', 'keys', Symbol.iterator]) encoded[key] = () => {throw new Error('encoded checkpoint decoded or iterated');};
  const c = capture(t, f); admit(c); assert.equal(c.checkpointBytes, expected); assert.equal(c.recordCount, 0);
  c.dispose(); live(f, listeners); assert.ok(budget.usedBytes > 0, 'capture never owns source checkpoint storage');
});

test('source-to-target copy matches all 33 fresh builtin oracles, canonical save, scene and exact drawing anchors', t => {
  const f = fixture(t, {n: 513, names: [...builtinIndicators.keys()], rich: true, input: true, ingestion: true});
  const expected = freshOracle(t, f), scene = buildScene(f.model, SIZE.width, SIZE.height).commands;
  const geometry = f.model.drawings.items.map(d => drawingGeometry(d, createLayout(f.model, SIZE.width, SIZE.height)));
  const listeners = [...f.store.listeners], arrays = FIELDS.map(k => f.store.columns[k]), epoch = f.model.dataIngestion.epoch;
  const ingestion = f.api.saveDataIngestion();
  const c = capture(t, f); assert.equal(f.model.dataIngestion.leased, true); admit(c);
  const metadata = safeCheckpointParse(c.metadataJSON);
  assert.equal(metadata.retainedBytes, c.sourceBytes + c.checkpointBytes + c.drawingBytes);
  assert.equal(metadata.document, f.text); assert.deepEqual(metadata.size, SIZE);
  assert.equal(c.sourceBytes, backingBytes(f.model)); assert.equal(metadata.dataIngestion, ingestion);
  const target = new NativeWorkspacePrepared(c.metadataJSON); t.after(() => target.dispose());
  copy(c, target); run(target);
  const receipt = c.finish(REVISION); assert.equal(receipt.schema, 'aster.native-workspace-source-finished');
  assert.equal(receipt.revision, REVISION); assert.equal(receipt.sourceVersion, f.store.version);
  assert.equal(f.model.dataIngestion.epoch, epoch + 2); released(c); live(f, listeners);
  const {model} = target.finish(); t.after(() => model.dispose());
  assert.equal(saveWorkspace(new ChartAPI(model), BINDING), f.text); assert.deepEqual(vectors(model), expected);
  assert.equal(new ChartAPI(model).saveDataIngestion(), ingestion); assert.equal(f.api.saveDataIngestion(), ingestion);
  assert.deepEqual(buildScene(model, SIZE.width, SIZE.height).commands, scene);
  assert.deepEqual(model.drawings.items.map(d => drawingGeometry(d, createLayout(model, SIZE.width, SIZE.height))), geometry);
  assert.equal(model.drawings.selected, null); assert.deepEqual(model.drawings.undoStack, []); assert.equal(model.crosshair, null);
  for (const [i, key] of FIELDS.entries()) {assert.equal(f.store.columns[key], arrays[i]);
    assert.notEqual(model.store.columns[key].buffer, arrays[i].buffer); assert.deepEqual([...model.store.columns[key]], [...arrays[i]]);}
  target.dispose(); assert.notEqual(model.disposed, true); live(f, listeners);
});

test('source accounting deduplicates shared buffers and charges full backing allocations for subviews', t => {
  const f = fixture(t, {n: 17}), listeners = [...f.store.listeners], shared = new ArrayBuffer(8192);
  for (const [slot, key] of FIELDS.entries()) {const a = new Float64Array(shared, (slot * 64 + 5) * 8, 32); a.set(f.store.columns[key].subarray(0, 17)); f.store.columns[key] = a;}
  const e = f.model.indicators.entries.get('ema'); e.arrays = [new Float64Array(shared, 4096, 32)];
  const extra = new ArrayBuffer(16384), line = f.model.series.find(s => s.id === 'close');
  line.values = new Float64Array(extra, 80, 17);
  line.rangeIndex = {values: new Float64Array(extra, 400, 17), min: new Float64Array(extra, 800, 32),
    max: new Float64Array(extra, 1200, 32), sum: new Float64Array(shared, 4800, 32)};
  const expected = backingBytes(f.model), c = capture(t, f); admit(c);
  assert.equal(c.sourceBytes, expected); assert.ok(c.sourceBytes >= shared.byteLength + extra.byteLength);
  copy(c); c.finish(REVISION); released(c); live(f, listeners);
});

test('drawing admission deduplicates retained frame and frozen drawing identities across undo/redo history', t => {
  const f = fixture(t, {names: [], rich: true}), d = f.model.drawings, frame = d.items;
  d.undoStack = [frame, [frame[0]], frame]; d.redoStack = [frame, [frame[1]]];
  const listeners = [...f.store.listeners], c = capture(t, f); admit(c, REVISION, 1);
  assert.equal(c.drawingCount, 2); assert.equal(c.drawingBytes, 4 * 8 + rawCost(frame[0]) + rawCost(frame[1]));
  c.dispose(); released(c); live(f, listeners);
});

const changes = {
  'API owner replacement': f => {f.api.model = {...f.model};},
  'input owner replacement': f => {f.input.model = {...f.model};},
  'ingestion ledger mutation': f => {f.model.dataIngestion.counters.rejectedPackets++;},
  'ingestion epoch mutation': f => {f.model.dataIngestion.epoch++;},
  'data update': f => {const b = f.store.at(3); f.store.update(3, {...b, volume: b.volume + 1});},
  'column replacement': f => {f.store.columns.close = f.store.columns.close.slice();},
  'store version': f => {f.store.version++;},
  'time version': f => {f.store.timeVersion++;},
  'entry replacement': f => {const e = f.model.indicators.entries.get('ema'); f.model.indicators.entries.set('ema', {...e});},
  'entry revision': f => {f.model.indicators.entries.get('ema').revision++;},
  'checkpoint map replacement': f => {const e = f.model.indicators.entries.get('ema'); e.checkpoints = new Map(e.checkpoints);},
  'checkpoint count growth': f => {f.model.indicators.entries.get('ema').checkpoints.set(512, {});},
  'indicator output replacement': f => {f.model.indicators.entries.get('ema').arrays[0] = new Float64Array(f.store.capacity);},
  'indicator dirty state': f => {f.model.indicators.entries.get('ema').dirty = 0;},
  'theme command': f => {f.api.setTheme({background: '#123456'});},
  'view in-place change': f => {f.model.view.from += .125;},
  'view identity': f => {f.model.view = {...f.model.view};},
  'follow mode': f => {f.model.follow = !f.model.follow;},
  'precision': f => {f.model.precision++;},
  'size': f => {f.size.width++;},
  'series replacement': f => {f.api.setSeries('close', {color: '#aabbcc'});},
  'panel replacement': f => {f.api.setPanel('price', {weight: 2});},
  'selection': f => {f.model.drawings.selected = 'another';},
  'crosshair': f => {f.model.crosshair = {x: 20, y: 30};},
  'drawing history': f => {f.model.drawings.undoStack.push([]);},
  'input tool': f => {f.input.setTool('trendline');},
  'input text': f => {f.input.text = 'Changed';},
  'input target': f => {f.input.setDrawingTarget({panel: 'price'});},
  'input pointer state': f => {f.input.pointers.set(1, {x: 4, y: 8});},
  'input gesture': f => {f.input.gesture = {kind: 'pan'};},
};
for (const [label, change] of Object.entries(changes)) test('source stale after managed ' + label, t => {
  const f = fixture(t, {input: true, ingestion: true}), listeners = [...f.store.listeners], c = capture(t, f);
  admit(c); change(f);
  assert.throws(() => c.buffer(0, 0, 1, REVISION), {name: 'StaleSourceError'});
  released(c); live(f, listeners);
});

test('host revision invalidates even a same-value command that preserves source identities', t => {
  const f = fixture(t, {input: true}), c = capture(t, f), listeners = [...f.store.listeners]; admit(c);
  f.input.setTool(f.input.tool); // A native command still increments its owner revision.
  assert.throws(() => c.step(1, REVISION + 1), {name: 'StaleSourceError'}); released(c); live(f, listeners);
});

test('final-chunk source change is stale at finish and discards a fully prepared target', t => {
  const f = fixture(t), listeners = [...f.store.listeners], c = capture(t, f); admit(c);
  const target = new NativeWorkspacePrepared(c.metadataJSON); t.after(() => target.dispose()); copy(c, target); run(target);
  const b = f.store.at(0); f.store.update(0, {...b, volume: b.volume + 1});
  assert.throws(() => c.finish(REVISION), {name: 'StaleSourceError'}); released(c);
  const preparedModel = target.model; target.dispose(); assert.equal(preparedModel.disposed, true); live(f, listeners);
});

for (const n of [0, 1, 255, 256, 257]) test('source copy and finish boundary length ' + n, t => {
  const f = fixture(t, {n}), listeners = [...f.store.listeners], c = capture(t, f); admit(c);
  if (!n) assert.deepEqual(c.offsets, [0, 0, 0, 0, 0, 0]);
  copy(c, null, REVISION, 17); const receipt = c.finish(REVISION);
  assert.equal(receipt.schema, 'aster.native-workspace-source-finished'); released(c); live(f, listeners);
});

const copyAttacks = {
  'before admission': c => c.buffer(0, 0, 1, REVISION),
  'negative slot': c => {admit(c); c.buffer(-1, 0, 1, REVISION);},
  'unknown slot': c => {admit(c); c.buffer(6, 0, 1, REVISION);},
  'fractional slot': c => {admit(c); c.buffer(.5, 0, 1, REVISION);},
  'gap': c => {admit(c); c.buffer(0, 1, 1, REVISION);},
  'duplicate/retry': c => {admit(c); c.buffer(0, 0, 1, REVISION); c.buffer(0, 0, 1, REVISION);},
  'overlap': c => {admit(c); c.buffer(0, 0, 10, REVISION); c.buffer(0, 9, 1, REVISION);},
  'count zero': c => {admit(c); c.buffer(0, 0, 0, REVISION);},
  'negative count': c => {admit(c); c.buffer(0, 0, -1, REVISION);},
  'fractional count': c => {admit(c); c.buffer(0, 0, 1.5, REVISION);},
  'oversized chunk': c => {admit(c); c.buffer(0, 0, 262145, REVISION);},
  'beyond source': c => {admit(c); c.buffer(0, 0, 258, REVISION);},
  'omitted revision': c => {admit(c); c.buffer(0, 0, 1);},
  'incomplete finish': c => {admit(c); c.buffer(0, 0, 1, REVISION); c.finish(REVISION);},
  'finish before admission': c => c.finish(REVISION),
};
for (const [label, attack] of Object.entries(copyAttacks)) test('source rejects copy ' + label + ' and permits a fresh capture retry', t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners], c = capture(t, f);
  assert.throws(() => attack(c)); released(c); live(f, listeners);
  const retry = capture(t, f); admit(retry); copy(retry); retry.finish(REVISION); live(f, listeners);
});
for (const work of [0, -1, 65, 1.5, NaN, Infinity]) test('source rejects invalid admission work ' + work, t => {
  const f = fixture(t), listeners = [...f.store.listeners], c = capture(t, f);
  assert.throws(() => c.step(work, REVISION), /admission work/); released(c); live(f, listeners);
});
for (const phase of ['admission', 'copy', 'partial']) test('source cancellation releases references and fences during ' + phase, t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners], c = capture(t, f);
  if (phase !== 'admission') admit(c); if (phase === 'partial') c.buffer(0, 0, 1, REVISION);
  c.dispose(); c.dispose(); released(c); live(f, listeners);
  const retry = capture(t, f); retry.dispose(); live(f, listeners);
});

test('source rejects malicious checkpoint own accessor without invoking it or damaging the live source', t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners]; let reads = 0;
  f.model.indicators.entries.get('ema').checkpoints.set(0, {get malicious() {reads++; return 1;}});
  const c = capture(t, f); assert.equal(reads, 0);
  assert.throws(() => c.step(1, REVISION), /own data/); assert.equal(reads, 0); released(c); live(f, listeners);
});

test('source rejects an accessor checkpoint slot without invoking it and releases a partially acquired fence', t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners], e = f.model.indicators.entries.get('ema'); let reads = 0;
  Object.defineProperty(e, 'checkpoints', {configurable: true, get() {reads++; return new Map();}});
  assert.throws(() => capture(t, f), /data|accessor/); assert.equal(reads, 0); live(f, listeners);
});

test('giant raw checkpoint rejects in admission before any target can be allocated', t => {
  const f = fixture(t), listeners = [...f.store.listeners];
  f.model.indicators.entries.get('ema').checkpoints.set(0, {payload: 'x'.repeat(131072)});
  const c = capture(t, f); let targets = 0;
  const beginTarget = () => {admit(c); targets++; return new NativeWorkspacePrepared(c.metadataJSON);};
  assert.throws(beginTarget, /record byte limit/); assert.equal(targets, 0); released(c); live(f, listeners);
});

test('first source drawing implementation applies the same 256 KiB bounded own-data record limit to history', t => {
  const f = fixture(t, {names: []}), listeners = [...f.store.listeners];
  // This is retained old history, not the requested document. A large drawing
  // can be portable yet exceed this first implementation's stricter source walk.
  f.model.drawings.undoStack.push([{id: 'large-old', type: 'text', panel: 'price',
    points: [{time: f.store.columns.time[0], price: 100}], text: 'x'.repeat(131072)}]);
  const c = capture(t, f); assert.throws(() => admit(c), /record byte limit/); released(c); live(f, listeners);
});

test('source refuses pending ingestion, an existing fence and active pointer/drawing gestures without cancelling them', t => {
  for (const kind of ['pending', 'fence', 'pointer', 'gesture', 'drawing']) {
    const f = fixture(t, {input: true, ingestion: true}), listeners = [...f.store.listeners]; let first;
    if (kind === 'pending') f.api.enqueueDataEvents({streamId: 'source-tests', generation: 3, firstSequence: 0,
      events: [{kind: 'update', bar: {...f.store.at(f.store.length - 1)}}]});
    if (kind === 'fence') first = capture(t, f);
    if (kind === 'pointer') f.input.pointers.set(1, {x: 0, y: 0});
    if (kind === 'gesture') f.input.gesture = {kind: 'pan'};
    if (kind === 'drawing') f.model.drawings.begin();
    assert.throws(() => capture(t, f), /pending|lease|fence|gesture/i);
    if (kind === 'pending') assert.equal(f.model.dataIngestion.count, 1);
    if (kind === 'pointer') assert.equal(f.input.pointers.size, 1);
    if (kind === 'gesture') assert.equal(f.input.gesture.kind, 'pan');
    if (kind === 'drawing') assert.ok(f.model.drawings.transaction);
    first?.dispose(); live(f, listeners);
  }
});

for (const when of ['acquire', 'release']) test('source detects UI mutation from ingestion lease ' + when + ' callback', t => {
  const f = fixture(t, {ingestion: true}), session = f.model.dataIngestion, listeners = [...f.store.listeners];
  const original = session.acquireLease.bind(session); let releases = 0;
  session.acquireLease = () => {const release = original(); if (when === 'acquire') f.model.precision++;
    return () => {releases++; release(); if (when === 'release') f.model.precision++;};};
  if (when === 'acquire') assert.throws(() => capture(t, f), {name: 'StaleSourceError'});
  else {const c = capture(t, f); admit(c); copy(c); assert.throws(() => c.finish(REVISION), {name: 'StaleSourceError'}); released(c);}
  assert.equal(releases, 1); live(f, listeners);
});

test('source lease acquisition throw leaves source alive and allows retry', t => {
  const f = fixture(t, {ingestion: true}), session = f.model.dataIngestion, listeners = [...f.store.listeners], original = session.acquireLease;
  session.acquireLease = () => {throw new Error('lease acquire callback');};
  assert.throws(() => capture(t, f), /lease acquire callback/); live(f, listeners);
  session.acquireLease = original; const retry = capture(t, f); retry.dispose(); live(f, listeners);
});

for (const action of ['finish', 'dispose']) test('source lease release throw cleans its fence and references on ' + action, t => {
  const f = fixture(t, {ingestion: true}), session = f.model.dataIngestion, listeners = [...f.store.listeners], original = session.acquireLease.bind(session); let releases = 0;
  session.acquireLease = () => {const release = original(); return () => {releases++; release(); throw new Error('lease release callback');};};
  const c = capture(t, f); if (action === 'finish') {admit(c); copy(c);}
  assert.throws(() => c[action](REVISION), /lease release callback/); released(c); assert.equal(releases, 1); live(f, listeners);
  session.acquireLease = original; const retry = capture(t, f); retry.dispose(); live(f, listeners);
});

test('host must independently reread native revision after finish because release callbacks cannot update a numeric argument', t => {
  const f = fixture(t, {input: true, ingestion: true}), session = f.model.dataIngestion, listeners = [...f.store.listeners];
  const original = session.acquireLease.bind(session); let hostRevision = REVISION;
  session.acquireLease = () => {const release = original(); return () => {release(); f.input.setTool(f.input.tool); hostRevision++;};};
  const c = capture(t, f); admit(c); copy(c); const receipt = c.finish(hostRevision);
  assert.equal(receipt.revision, REVISION); assert.notEqual(hostRevision, receipt.revision,
    'the host must reject publication after its callback-free native revision recheck');
  released(c); live(f, listeners);
});

test('combined logical plan is admitted at the exact boundary and rejected before target allocation one byte below it', t => {
  const f = fixture(t, {rich: true}), listeners = [...f.store.listeners], probe = capture(t, f); admit(probe);
  const bytes = probe.plan.totalBytes, retained = probe.sourceBytes + probe.checkpointBytes + probe.drawingBytes;
  assert.ok(bytes > retained); assert.equal(probe.plan.retainedBytes, retained); assert.ok(Object.isFrozen(probe.plan)); probe.dispose();
  const exact = capture(t, f, {maxBytes: bytes}); admit(exact); assert.equal(exact.plan.totalBytes, bytes); exact.dispose();
  const short = capture(t, f, {maxBytes: bytes - 1}); let targetAllocations = 0;
  assert.throws(() => {admit(short); targetAllocations++; new NativeWorkspacePrepared(short.metadataJSON);}, /combined logical byte limit/);
  assert.equal(targetAllocations, 0); released(short); live(f, listeners);
});

test('source buffer accounting rejects a retained allocation exceeding the supplied byte limit', t => {
  const f = fixture(t), listeners = [...f.store.listeners];
  assert.throws(() => capture(t, f, {maxBytes: 1}), /logical byte/); live(f, listeners);
});

for (const revision of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) test('source rejects invalid host revision ' + revision, t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners];
  assert.throws(() => capture(t, f, {revision}), /host revision/); live(f, listeners);
});

test('source rejects an invalid requested document or binding without retaining its ingestion fence', t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners];
  for (const [text, binding] of [['{', BINDING], [f.text, {...BINDING, revision: 'wrong'}]]) {
    assert.throws(() => new NativeWorkspaceCapture(f.api, text, binding, {size: f.size, revision: REVISION})); live(f, listeners);
  }
});

test('a managed source change during incremental admission prevents metadata from becoming transferable', t => {
  const f = fixture(t), listeners = [...f.store.listeners], c = capture(t, f);
  assert.equal(c.step(1, REVISION).complete, false); f.api.setTheme({background: '#abcdef'});
  assert.throws(() => c.step(1, REVISION), {name: 'StaleSourceError'}); released(c); live(f, listeners);
});

test('even a recalculated dirty source cache is stale while raw checkpoint admission is in progress', t => {
  const f = fixture(t), listeners = [...f.store.listeners], b = f.store.at(256);
  f.store.update(256, {...b, close: b.high}); const c = capture(t, f); c.step(1, REVISION);
  f.model.indicators.get('ema'); assert.throws(() => c.step(1, REVISION), {name: 'StaleSourceError'}); released(c); live(f, listeners);
});

test('source accounting includes block-index trees and shared borrowed value buffers exactly once', t => {
  const f = fixture(t), listeners = [...f.store.listeners], line = f.model.series.find(s => s.id === 'close');
  line.rangeIndex = new BlockRangeIndex(f.store.length, f.store.columns.close, f.store.capacity);
  const expected = backingBytes(f.model), c = capture(t, f); admit(c); assert.equal(c.sourceBytes, expected);
  c.dispose(); released(c); live(f, listeners);
});

test('source release callback that changes data is rejected before source-finished receipt', t => {
  const f = fixture(t, {ingestion: true}), listeners = [...f.store.listeners], session = f.model.dataIngestion;
  const original = session.acquireLease.bind(session); session.acquireLease = () => {const release = original(); return () => {
    release(); const b = f.store.at(0); f.store.update(0, {...b, volume: b.volume + 1});
  };};
  const c = capture(t, f); admit(c); copy(c); assert.throws(() => c.finish(REVISION), {name: 'StaleSourceError'});
  released(c); live(f, listeners);
});

test('checkpoint traversal reentry changing source UI fails closed after the bounded record walk', t => {
  const f = fixture(t), listeners = [...f.store.listeners]; let calls = 0;
  const record = new Proxy({value: 1}, {ownKeys(value) {calls++; f.api.setTheme({background: '#bbaacc'}); return Reflect.ownKeys(value);}});
  f.model.indicators.entries.get('ema').checkpoints.set(0, record);
  const c = capture(t, f); assert.throws(() => c.step(1, REVISION), {name: 'StaleSourceError'});
  assert.equal(calls, 1); released(c); live(f, listeners);
});

test('first source drawing own-data walk rejects history getters without invocation', t => {
  const f = fixture(t, {names: []}), listeners = [...f.store.listeners]; let calls = 0;
  f.model.drawings.undoStack.push([{get text() {calls++; return 'malicious';}}]);
  const c = capture(t, f); assert.throws(() => admit(c), /own data/); assert.equal(calls, 0); released(c); live(f, listeners);
});

test('source step remains complete without charging records twice after admission', t => {
  const f = fixture(t, {rich: true}), listeners = [...f.store.listeners], c = capture(t, f); admit(c);
  const bytes = c.sourceBytes + c.checkpointBytes + c.drawingBytes, metadata = c.metadataJSON;
  for (let i = 0; i < 3; i++) {assert.equal(c.step(64, REVISION).complete, true); assert.equal(c.metadataJSON, metadata);
    assert.equal(c.sourceBytes + c.checkpointBytes + c.drawingBytes, bytes);}
  copy(c); c.finish(REVISION); released(c); live(f, listeners);
});
test('core capture rejects replaced controller model accessor without invoking it',t=>{const f=fixture(t,{input:true,ingestion:true}),c=capture(t,f);let reads=0;Object.defineProperty(f.input,'model',{configurable:true,get(){reads++;return f.model;}});assert.throws(()=>c.step(1,REVISION),/own data slot/);assert.equal(reads,0);Object.defineProperty(f.input,'model',{configurable:true,writable:true,value:f.model});assert.equal(c.closed,true);const retry=capture(t,f);retry.dispose();});
