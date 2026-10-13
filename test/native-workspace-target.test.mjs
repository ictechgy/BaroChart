import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, FIELDS, seededColumns} from '../src/core/data.mjs';
import {ChartModel, createLayout} from '../src/core/model.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {builtinIndicators} from '../src/core/indicators.mjs';
import {defineIndicatorModule} from '../src/core/indicator-modules.mjs';
import {buildScene} from '../src/core/scene.mjs';
import {drawingGeometry} from '../src/core/drawings.mjs';
import {PreparedData} from '../src/core/prepare-state.mjs';
import {saveWorkspace, readWorkspaceDocument} from '../src/core/workspace.mjs';
import {safeCheckpointParse, safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
import {NativeCheckpointEntries, NativeCheckpointMap} from '../src/core/native-checkpoints.mjs';
import {NativeWorkspacePrepared, NATIVE_WORKSPACE_RESTORE_BYTES} from '../src/core/native-workspace-target.mjs';

// Direct target tests intentionally never use source capture, old UI import,
// a native facade, a host context swap, or a second copy of the restore code.
const BINDING = Object.freeze({key: 'native-target:ASTER/1m', revision: '2026-10-13.1',
  adjustmentVersion: 'raw-v1', priceUnit: 'USD', adjustment: 'raw'});
const SIZE = Object.freeze({width: 1100, height: 760});
const SYMBOL = Object.freeze({id: 'ASTER', exchange: 'TEST', timezone: 'America/New_York',
  currency: 'USD', volumeUnit: 'shares', priceDecimals: 2, tickSize: .01, adjustment: 'raw'});
const MODULE = 'test.native-workspace-target@1/probe';
const hooks = {};
defineIndicatorModule({id: 'test.native-workspace-target', version: 1, stateVersion: 1,
  indicators: {probe: {causal: true, factory(params = {}) {
    hooks.factory?.(params);
    const definition = {outputs: ['value', 'negative'], plotOffsets: {value: 2, negative: -3}, create() {
      hooks.create?.(); let index = 0;
      return {step(bar, at) {hooks.step?.(bar, at); index = at + 1; return [bar.close, -bar.close];},
        snapshot() {hooks.snapshot?.(index); return {index};},
        restore(state) {index = state.index;}};
    }};
    hooks.definition?.(definition); return definition;
  }, validateCheckpoint(_params, state, index) {
    hooks.validate?.(state, index);
    if (!state || Object.keys(state).length !== 1 || state.index !== index) throw new TypeError('Fixture checkpoint');
  }}}});

function fixture(t, {n = 257, rich = false, names = ['ema'], module = false} = {}) {
  const columns = seededColumns(Math.max(n, 1025), 713), store = new BarStore([], {maxBars: 4096, timeframeMs: 60000, timeOrigin: 123});
  store.setColumns(columns, n);
  const model = new ChartModel({store, precision: 4, axisWidth: 93,
    panels: rich ? [{id: 'price', weight: 3, padding: .03, precision: 5}, {id: 'osc', weight: 1, range: [-200, 200]}] : [{id: 'price'}],
    axes: rich ? [{id: 'price-left', panel: 'price', side: 'left', width: 67, precision: 6, prefix: 'P:', range: [50, 150]}] : []});
  const api = new ChartAPI(model);
  for (const name of names) api.addIndicator(name, name, {});
  if (module) api.addIndicator('module', MODULE, {negativeZero: -0});
  api.addSeries({id: 'candles', type: 'candles', panel: 'price', width: 1.75});
  api.addSeries({id: 'raw-close', type: 'line', panel: 'price', source: 'close', color: '#aa55ff'});
  if (names.includes('ema')) api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema', color: '#44ccaa'});
  if (module) api.addSeries({id: 'module-line', type: 'line', panel: 'price', indicator: 'module', output: 'value'});
  if (rich) {
    api.setSymbol(SYMBOL); model.precision = 7;
    const first = n ? store.at(0).time : 1700000000000, last = n ? store.at(n - 1).time : first;
    for (const [id, type, points, binding] of [
      ['fractional-trend', 'trendline', [{time: first - 180000.25, price: 97.125}, {time: last + 240000.75, price: 103.875}], {axisId: 'price-left'}],
      ['offscreen-text', 'text', [{time: last + 720000.125, price: 102.0625}], {seriesId: 'raw-close'}],
    ]) api.addDrawing({id, type, panel: 'price', ...binding, points, text: type === 'text' ? '한국 🚀 exact anchors' : '',
      style: {color: '#ffcc88', width: 1.75, font: '12px monospace'}});
    model.view = {from: -40.125, to: n + 80.875}; model.follow = true;
    model.drawings.selected = 'fractional-trend'; model.crosshair = {x: 120, y: 60};
  } else model.setVisibleRange(12.25, 189.75);
  t.after(() => model.dispose());
  return {columns, store, model, api};
}
function specification(f, patch = {}) {
  return {schema: 'aster.native-workspace-target', version: 1, document: saveWorkspace(f.api, BINDING), datasetBinding: {...BINDING},
    source: {length: f.store.length, maxBars: f.store.maxBars, timeframeMs: f.store.timeframeMs, timeOrigin: f.store.timeOrigin,
      version: f.store.version, timeVersion: f.store.timeVersion}, size: {...SIZE}, retainedBytes: 123456,
    maxBytes: 805306368, ...patch};
}
function prepared(t, f, patch = {}) {
  const p = new NativeWorkspacePrepared(safeCheckpointStringify(specification(f, patch)));
  t.after(() => p.dispose()); return p;
}
function transfer(p, columns, chunk = 71) {
  for (let slot = 0; slot < FIELDS.length; slot++) for (let offset = 0; offset < p.length; offset += chunk) {
    const count = Math.min(chunk, p.length - offset), view = p.target(slot, offset, count);
    assert.ok(view instanceof Float64Array); assert.equal(view.length, count);
    assert.notEqual(view.buffer, columns[FIELDS[slot]].buffer);
    view.set(columns[FIELDS[slot]].subarray(offset, offset + count));
  }
}
function run(p, maxBars = 113) {
  const phases = new Set([p.phase]);
  for (let steps = 0; steps < 20000; steps++) {
    const progress = p.step(maxBars); phases.add(progress.phase);
    assert.equal(typeof progress.complete, 'boolean');
    assert.ok(Number.isFinite(progress.done) && Number.isFinite(progress.total));
    if (progress.complete) return phases;
  }
  assert.fail('Target preparation did not terminate');
}
function toPhase(p, phase) {
  for (let steps = 0; steps < 20000 && p.phase !== phase; steps++) {
    assert.notEqual(p.phase, 'workspace-ready', 'requested phase must be reached'); p.step(37);
  }
  assert.equal(p.phase, phase);
}
function restore(t, f, patch = {}) {
  const p = prepared(t, f, patch); transfer(p, f.store.columns); p.start(); run(p);
  const result = p.finish(); t.after(() => result.model.dispose()); return {p, ...result};
}
function vectors(model) {
  return Object.fromEntries([...model.indicators.entries].map(([id]) => [id,
    Object.fromEntries(Object.entries(model.indicators.get(id).outputs).map(([key, values]) => [key, [...values]]))]));
}
function compareFresh(model, label) {
  const store = new BarStore(); store.setColumns(model.store.columns, model.store.length);
  const oracle = new ChartModel({store});
  try {
    for (const [id, entry] of model.indicators.entries) oracle.indicators.add(id, entry.name, {...entry.params});
    const actual = vectors(model), expected = vectors(oracle);
    for (const id of Object.keys(expected)) for (const key of Object.keys(expected[id])) {
      const a = actual[id][key], b = expected[id][key]; assert.equal(a.length, b.length, label + ':' + id);
      for (let i = 0; i < b.length; i++) assert.ok(Object.is(a[i], b[i]) || Math.abs(a[i] - b[i]) <= 1e-9 * Math.max(1, Math.abs(b[i])), `${label}:${id}.${key}[${i}] ${a[i]} != ${b[i]}`);
    }
  } finally {oracle.dispose();}
}
function accounting(p, model) {
  const maps = [...model.indicators.entries.values()].map(e => e.checkpoints).filter(m => m instanceof NativeCheckpointMap);
  assert.equal(p.checkpointBudget.usedBytes, maps.reduce((sum, m) => sum + m.encodedBytes, 0));
  for (const map of maps) assert.equal(map.validateHistory(model.store.length), map);
}
function sourceState(f) {
  return {model: f.model, store: f.store, columns: f.store.columns, index: f.store.index, version: f.store.version, timeVersion: f.store.timeVersion,
    listeners: [...f.store.listeners], values: Object.fromEntries(FIELDS.map(k => [k, [...f.store.columns[k]]])),
    document: saveWorkspace(f.api, BINDING), outputs: vectors(f.model)};
}
function unchanged(f, before) {
  assert.equal(f.model.disposed, undefined); assert.equal(f.model.store, before.store);
  assert.equal(f.store.columns, before.columns); assert.equal(f.store.index, before.index);
  assert.equal(f.store.version, before.version); assert.equal(f.store.timeVersion, before.timeVersion);
  assert.deepEqual([...f.store.listeners], before.listeners);
  for (const key of FIELDS) assert.deepEqual([...f.store.columns[key]], before.values[key], 'source ' + key);
  assert.equal(saveWorkspace(f.api, BINDING), before.document); assert.deepEqual(vectors(f.model), before.outputs);
}
function released(p, store, model, maps = []) {
  assert.equal(p.checkpointBudget.usedBytes, 0); assert.equal(p.model, null); assert.equal(p.store, null);
  assert.deepEqual(p.columns, {}); assert.deepEqual(p.workspaceColumnRefs, []);
  assert.deepEqual(p.workspaceEntries, []); assert.equal(p.workspaceEntryMap, null);
  assert.equal(p.task, null); assert.equal(p.checkIterator, null); assert.equal(p.readyBinding, null);
  assert.equal(p.workspace, null); assert.equal(p.workspaceText, null); assert.equal(p.normalizedWorkspace, null);
  if (store) assert.equal(store.listeners.size, 0);
  if (model) assert.equal(model.disposed, true);
  for (const map of maps) {assert.equal(map.encodedBytes, 0); assert.throws(() => map.get(0), /disposed/);}
  assert.throws(() => p.target(0, 0, 1), /closed/); assert.throws(() => p.start(), /closed/);
  assert.throws(() => p.step(), /closed/); assert.throws(() => p.finish(), /closed/);
  p.dispose(); assert.equal(p.checkpointBudget.usedBytes, 0);
}
function editDocument(spec, change) {
  const doc = safeCheckpointParse(spec.document); change(doc); spec.document = safeCheckpointStringify(doc); return spec;
}
function reverseFields(value) {
  if (Array.isArray(value)) return value.map(reverseFields);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseFields(value[key])]));
  return value;
}

test('native target restores canonical saved configuration, exact fractional/offscreen anchors and owned source columns', t => {
  const f = fixture(t, {rich: true, module: true, names: ['ema', 'rsi', 'macd']}), shared = new ChartModel({store: f.store});
  t.after(() => shared.dispose());
  const before = sourceState(f), expectedScene = buildScene(f.model, SIZE.width, SIZE.height).commands;
  const expectedGeometry = f.model.drawings.items.map(d => drawingGeometry(d, createLayout(f.model, SIZE.width, SIZE.height)));
  // Crosshair and selection are transient and deliberately excluded from scene parity.
  f.model.crosshair = null; f.model.drawings.selected = null;
  const cleanScene = buildScene(f.model, SIZE.width, SIZE.height).commands;
  f.model.crosshair = {x: 120, y: 60}; f.model.drawings.selected = 'fractional-trend';
  assert.ok(expectedScene.length);
  const {p, model, size, plan} = restore(t, f);
  assert.ok(p instanceof PreparedData); assert.notEqual(model.store, f.store); assert.deepEqual(size, SIZE);
  assert.equal(plan, p.plan); assert.ok(Object.isFrozen(plan));
  assert.equal(saveWorkspace(new ChartAPI(model), BINDING), before.document);
  assert.deepEqual(model.symbol, SYMBOL); assert.equal(model.precision, 7);
  assert.equal(model.priceFormatter(123.456), f.model.priceFormatter(123.456));
  assert.equal(model.timeFormatter(f.store.at(5).time), f.model.timeFormatter(f.store.at(5).time));
  assert.deepEqual(model.view, {from: -40.125, to: 337.875}); assert.equal(model.follow, true);
  assert.deepEqual(model.drawings.items, f.model.drawings.items); assert.equal(model.drawings.selected, null);
  assert.equal(model.drawings.transaction, null); assert.deepEqual(model.drawings.undoStack, []); assert.deepEqual(model.drawings.redoStack, []);
  assert.equal(model.crosshair, null); assert.deepEqual(buildScene(model, SIZE.width, SIZE.height).commands, cleanScene);
  assert.deepEqual(model.drawings.items.map(d => drawingGeometry(d, createLayout(model, SIZE.width, SIZE.height))), expectedGeometry);
  assert.deepEqual(vectors(model), before.outputs);
  assert.equal(model.store.version, f.store.version + 1); assert.equal(model.store.timeVersion, f.store.timeVersion + 1);
  for (const key of FIELDS) {assert.notEqual(model.store.columns[key].buffer, f.store.columns[key].buffer); assert.deepEqual([...model.store.columns[key]], before.values[key]);}
  assert.equal(model.store.maxBars, 4096); assert.equal(model.store.timeframeMs, 60000); assert.equal(model.store.timeOrigin, 123);
  assert.ok(model.indicators.entries instanceof NativeCheckpointEntries); accounting(p, model); unchanged(f, before);
  p.dispose(); assert.notEqual(model.disposed, true); assert.equal(model.store.listeners.size, 2);
  assert.notEqual(shared.disposed, true); unchanged(f, before);
});

test('all 34 builtins match independent fresh calculation after restore, tail update, append and historical corrections', t => {
  const names = [...builtinIndicators.keys()]; assert.equal(names.length, 34);
  const f = fixture(t, {n: 1024, names}), before = sourceState(f), {p, model} = restore(t, f);
  const row = i => Object.fromEntries(FIELDS.map(k => [k, f.columns[k][i]]));
  compareFresh(model, 'initial'); accounting(p, model);
  const last = model.store.at(1023); model.store.update(1023, {...last, close: last.high, volume: last.volume + 7});
  compareFresh(model, 'tail update'); accounting(p, model);
  model.store.append(row(1024)); compareFresh(model, 'append 1025'); accounting(p, model);
  for (const i of [255, 256, 0]) {
    const bar = model.store.at(i); model.store.applyEvents([{kind: 'correction', bar: {...bar, close: bar.low, volume: bar.volume + 11}}]);
    compareFresh(model, 'correction ' + i); accounting(p, model);
  }
  unchanged(f, before); model.dispose(); assert.equal(p.checkpointBudget.usedBytes, 0); assert.equal(model.store.listeners.size, 0);
});

for (const n of [0, 1, 255, 256, 257]) test('native target checkpoint/source boundary ' + n, t => {
  const f = fixture(t, {n, names: ['ema', 'rsi', 'bollinger']}), {p, model} = restore(t, f);
  assert.equal(model.store.length, n); compareFresh(model, 'length ' + n);
  for (const entry of model.indicators.entries.values()) assert.deepEqual([...entry.checkpoints.keys()], n ? Array.from({length: Math.floor(n / 256) + 1}, (_, i) => i * 256) : []);
  assert.equal(saveWorkspace(new ChartAPI(model), BINDING), saveWorkspace(f.api, BINDING)); accounting(p, model);
});

test('valid omitted panel/axis/series defaults normalize to the public model defaults', t => {
  const f = fixture(t, {names: []}), spec = specification(f);
  editDocument(spec, doc => {doc.chart.panels = [{id: 'price'}]; doc.chart.axes = [{id: 'aux', panel: 'price'}]; doc.series = [{id: 'minimal', type: 'line', panel: 'price'}];});
  const p = new NativeWorkspacePrepared(safeCheckpointStringify(spec)); t.after(() => p.dispose());
  transfer(p, f.store.columns); p.start(); run(p); const {model} = p.finish(); t.after(() => model.dispose());
  const oracle = new ChartModel({store: f.store, panels: [{id: 'price'}], axes: [{id: 'aux', panel: 'price'}]}); t.after(() => oracle.dispose());
  oracle.addSeries({id: 'minimal', type: 'line', panel: 'price'});
  assert.deepEqual(model.panels, oracle.panels); assert.deepEqual(model.axes, oracle.axes);
  const restoredDoc = readWorkspaceDocument(saveWorkspace(new ChartAPI(model), BINDING));
  const oracleDoc = readWorkspaceDocument(saveWorkspace(new ChartAPI(oracle), BINDING));
  assert.deepEqual(restoredDoc.series, oracleDoc.series);
});

test('valid document field reordering, including multi-output plot offsets, preserves meaning', t => {
  const f = fixture(t, {module: true}), canonical = saveWorkspace(f.api, BINDING);
  const {model} = restore(t, f, {document: safeCheckpointStringify(reverseFields(safeCheckpointParse(canonical)))});
  assert.deepEqual(readWorkspaceDocument(saveWorkspace(new ChartAPI(model), BINDING)), readWorkspaceDocument(canonical));
});

test('valid v2 drawings without bindings normalize to the writer canonical drawing version', t => {
  const f = fixture(t), spec = specification(f);
  editDocument(spec, doc => {doc.drawings.version = 2;});
  assert.equal(readWorkspaceDocument(spec.document).drawings.version, 2, 'reader accepts this valid document');
  const {model} = restore(t, f, {document: spec.document});
  assert.equal(saveWorkspace(new ChartAPI(model), BINDING), saveWorkspace(f.api, BINDING));
});

test('sub-bar offscreen saved view survives and later source UI cannot overwrite the target configuration', t => {
  const f = fixture(t, {rich: true}); f.model.view = {from: -10000000.125, to: -9999999.875}; f.model.follow = false;
  const text = saveWorkspace(f.api, BINDING), p = prepared(t, f); transfer(p, f.store.columns); p.start();
  f.api.setVisibleRange(40, 90); f.api.setTheme({background: '#010203'}); f.api.setSymbol({...SYMBOL, id: 'LATER'});
  run(p, 65536); const {model} = p.finish(); t.after(() => model.dispose());
  assert.equal(saveWorkspace(new ChartAPI(model), BINDING), text); assert.deepEqual(model.view, {from: -10000000.125, to: -9999999.875});
  assert.equal(model.follow, false); assert.equal(model.symbol.id, 'ASTER'); assert.equal(model.precision, 7);
});

test('version increment accepts the final safe source revision and empty maxBars zero', t => {
  const f = fixture(t, {n: 0}), source = specification(f).source;
  const {model} = restore(t, f, {source: {...source, maxBars: 0, version: Number.MAX_SAFE_INTEGER - 1, timeVersion: Number.MAX_SAFE_INTEGER - 1}});
  assert.equal(model.store.version, Number.MAX_SAFE_INTEGER); assert.equal(model.store.timeVersion, Number.MAX_SAFE_INTEGER);
  assert.equal(model.store.maxBars, 0); assert.equal(model.store.length, 0);
});

test('logical admission plan includes caller retained assertion, all target structures and fixed reserves at exact byte limit', t => {
  const f = fixture(t, {n: 257, names: ['ema', 'macd']}), p = prepared(t, f), plan = p.plan;
  assert.equal(NATIVE_WORKSPACE_RESTORE_BYTES, 805306368);
  assert.deepEqual(plan, {retainedBytes: 123456, sourceBytes: 512 * 96, outputBytes: 4 * 512 * 8,
    rangeBytes: 2 * 512 * 48, checkpointBytes: 33554432, recordMetadataBytes: 2 * 2 * 128,
    scratchBytes: 33554432, documentBytes: 33554432, transferBytes: 4194304, ingestionBytes: 0,
    totalBytes: 123456 + 512 * 96 + 4 * 512 * 8 + 2 * 512 * 48 + 33554432 * 3 + 2 * 2 * 128 + 4194304,
    maxBytes: 805306368, capacity: 512, outputs: 4});
  const exact = prepared(t, f, {maxBytes: plan.totalBytes}); assert.equal(exact.plan.totalBytes, exact.plan.maxBytes);
  assert.throws(() => prepared(t, f, {maxBytes: plan.totalBytes - 1}), /byte.*limit/);
  // This field is an explicit host assertion, never source-memory authentication.
  const zero = prepared(t, f, {retainedBytes: 0}); assert.equal(zero.plan.totalBytes, plan.totalBytes - 123456);
});

test('large projected output allocation rejects before constructing source arrays', t => {
  const f = fixture(t, {names: [...builtinIndicators.keys()]}), spec = specification(f), n = 1048577;
  spec.source.length = n; spec.source.maxBars = n;
  editDocument(spec, doc => {doc.source.length = n; doc.source.lastTime = doc.source.firstTime + (n - 1) * 60000;});
  assert.throws(() => new NativeWorkspacePrepared(safeCheckpointStringify(spec)), /output.*byte.*limit/);
});

const metadataAttacks = {
  'wrong outer schema': s => {s.schema = 'aster.prepare';}, 'wrong outer version': s => {s.version = 2;},
  'extra outer field': s => {s.surprise = true;}, 'missing source': s => {delete s.source;},
  'dataset mismatch': s => {s.datasetBinding.revision = 'different';}, 'missing binding field': s => {delete s.datasetBinding.priceUnit;},
  'document schema': s => editDocument(s, d => {d.schema = 'other';}),
  'document version': s => editDocument(s, d => {d.version = 2;}),
  'document/source length mismatch': s => {s.source.length--;},
  'negative length': s => {s.source.length = -1;}, 'fractional length': s => {s.source.length = 2.5;},
  'maxBars under source': s => {s.source.maxBars = 1;}, 'excess maxBars': s => {s.source.maxBars = 4194305;},
  'invalid timeframe': s => {s.source.timeframeMs = 0;}, 'nonfinite origin': s => {s.source.timeOrigin = Infinity;},
  'version overflow': s => {s.source.version = Number.MAX_SAFE_INTEGER;},
  'timeVersion overflow': s => {s.source.timeVersion = Number.MAX_SAFE_INTEGER;},
  'negative version': s => {s.source.version = -1;}, 'fractional timeVersion': s => {s.source.timeVersion = .5;},
  'bad size': s => {s.size.width = 0;}, 'pixel limit': s => {s.size = {width: 16384, height: 16384};},
  'negative retained bytes': s => {s.retainedBytes = -1;}, 'fractional retained bytes': s => {s.retainedBytes = .5;},
  'retained exceeds cap': s => {s.retainedBytes = s.maxBytes + 1;}, 'combined memory overflow': s => {s.retainedBytes = s.maxBytes;},
  'excess combined cap': s => {s.maxBytes++;}, 'zero combined cap': s => {s.maxBytes = 0;},
  'missing linked module': s => editDocument(s, d => {d.indicators[0].name = 'test.absent@1/unknown';}),
  'output schema binding': s => editDocument(s, d => {d.indicators[0].outputs = ['wrong'];}),
  'output offset binding': s => editDocument(s, d => {d.indicators[0].plotOffsets = {value: 1};}),
  'duplicate indicator id': s => editDocument(s, d => {d.indicators.push({...d.indicators[0]});}),
};
for (const [label, change] of Object.entries(metadataAttacks)) test('native target rejects metadata ' + label, t => {
  const f = fixture(t), before = sourceState(f), spec = specification(f); change(spec);
  assert.throws(() => new NativeWorkspacePrepared(safeCheckpointStringify(spec))); unchanged(f, before);
});

test('metadata must be bounded primitive JSON text without duplicate or reserved keys', t => {
  const f = fixture(t), text = safeCheckpointStringify(specification(f));
  for (const invalid of [null, {}, 1, new String(text), '', '{bad}', ' '.repeat(8388609),
    text.replace('"version":1', '"version":1,"version":1'), text.replace('"schema":', '"__proto__":{},"schema":')])
    assert.throws(() => new NativeWorkspacePrepared(invalid));
});

const chunkAttacks = {
  'negative slot': p => p.target(-1, 0, 1), 'out-of-range slot': p => p.target(6, 0, 1),
  'fractional slot': p => p.target(.5, 0, 1), 'string slot': p => p.target('0', 0, 1),
  'missing leading span': p => p.target(0, 1, 1), 'negative offset': p => p.target(0, -1, 1),
  'fractional offset': p => p.target(0, .5, 1), 'empty chunk': p => p.target(0, 0, 0),
  'negative count': p => p.target(0, 0, -1), 'fractional count': p => p.target(0, 0, .5),
  'oversized chunk': p => p.target(0, 0, 262145), 'beyond source': p => p.target(0, 0, p.length + 1),
  'duplicate span': p => {p.target(0, 0, 1); p.target(0, 0, 1);},
  'overlapping span': p => {p.target(0, 0, 2); p.target(0, 1, 1);},
  'missing columns': p => {p.target(0, 0, p.length); p.start();},
};
for (const [label, attack] of Object.entries(chunkAttacks)) test('native target rejects transfer ' + label + ' and closes ownership', t => {
  const f = fixture(t), before = sourceState(f), p = prepared(t, f); assert.throws(() => attack(p)); released(p); unchanged(f, before);
});

const columnAttacks = {
  'nonfinite price': c => {c.close[2] = NaN;}, 'infinite volume': c => {c.volume[2] = Infinity;},
  'negative volume': c => {c.volume[2] = -1;}, 'high below close': c => {c.high[2] = c.close[2] - 100;},
  'low above open': c => {c.low[2] = c.open[2] + 100;}, 'duplicate time': c => {c.time[2] = c.time[1];},
  'reverse time': c => {c.time[2] = c.time[1] - 1;}, 'fractional time': c => {c.time[2] += .5;},
  'date limit': c => {c.time[2] = 8640000000000001;},
  'volume sum overflow': c => {c.volume.fill(Number.MAX_VALUE);},
  'first source extent': c => {c.time[0] -= 60000;}, 'last source extent': c => {c.time[256] += 60000;},
};
for (const [label, attack] of Object.entries(columnAttacks)) test('native target rejects invalid OHLCV or extent: ' + label, t => {
  const f = fixture(t), before = sourceState(f), p = prepared(t, f); transfer(p, f.store.columns); attack(p.columns); p.start();
  const store = p.store; assert.throws(() => run(p)); released(p, store); unchanged(f, before);
});

for (const phase of ['capture', 'validate', 'store-index', 'calculate', 'indices', 'workspace-checkpoints', 'workspace-ready'])
  test('dispose during ' + phase + ' releases target listeners/checkpoint ledger only', t => {
    const f = fixture(t, {names: ['ema', 'rsi']}), before = sourceState(f), p = prepared(t, f);
    if (phase === 'capture') p.target(0, 0, 71).set(f.store.columns.time.subarray(0, 71));
    else {transfer(p, f.store.columns); p.start(); toPhase(p, phase); if (phase === 'calculate') p.step(37);}
    const store = p.store, model = p.model, maps = model ? [...model.indicators.entries.values()].map(e => e.checkpoints) : [];
    if (['calculate', 'indices', 'workspace-checkpoints', 'workspace-ready'].includes(phase)) assert.ok(p.checkpointBudget.usedBytes > 0);
    p.dispose(); released(p, store, model, maps); unchanged(f, before);
  });

test('finish transfers exactly once; later target cleanup preserves returned model until its own disposal', t => {
  const f = fixture(t, {names: ['ema', 'rsi', 'macd']}), {p, model} = restore(t, f), api = new ChartAPI(model);
  assert.deepEqual(p.workspaceColumnRefs, [], 'successful transfer drops wrapper-owned source vector references');
  assert.deepEqual(p.workspaceEntries, []); assert.equal(p.workspaceEntryMap, null);
  assert.equal(p.model, null); assert.equal(p.store, null); assert.deepEqual(p.columns, {});
  const firstMap = model.indicators.entries.get('ema').checkpoints, firstBytes = firstMap.encodedBytes;
  const held = model.indicators.get('ema').outputs.value, heldValues = [...held], initialBytes = p.checkpointBudget.usedBytes;
  assert.throws(() => p.finish(), /closed/); p.dispose(); p.dispose();
  assert.notEqual(model.disposed, true); assert.equal(p.checkpointBudget.usedBytes, initialBytes);
  api.removeIndicator('ema'); assert.equal(p.checkpointBudget.usedBytes, initialBytes - firstBytes);
  assert.throws(() => firstMap.get(0), /disposed/); assert.deepEqual([...held], heldValues);
  const replaced = model.indicators.entries.get('rsi').checkpoints, removedBytes = replaced.encodedBytes, before = p.checkpointBudget.usedBytes;
  api.setIndicatorParams('rsi', {period: 7}); assert.equal(p.checkpointBudget.usedBytes, before - removedBytes);
  assert.throws(() => replaced.get(0), /disposed/); assert.ok(model.indicators.entries instanceof NativeCheckpointEntries);
  compareFresh(model, 'after params replacement'); accounting(p, model);
  model.dispose(); assert.equal(p.checkpointBudget.usedBytes, 0); assert.equal(model.store.listeners.size, 0);
});

test('a throwing model cleanup still retires the captured checkpoint registry and all target wrapper references', t => {
  const f = fixture(t, {names: ['ema', 'rsi']}), before = sourceState(f), p = prepared(t, f);
  transfer(p, f.store.columns); p.start(); run(p);
  const model = p.model, store = p.store, originalDispose = model.dispose;
  const maps = [...model.indicators.entries.values()].map(entry => entry.checkpoints), refs = [...p.workspaceColumnRefs];
  assert.equal(refs.length, 6); assert.ok(p.checkpointBudget.usedBytes > 0);
  t.after(() => originalDispose.call(model));
  model.dispose = () => {throw new Error('intentional model cleanup failure');};
  assert.throws(() => p.dispose(), /intentional model cleanup failure/);
  released(p, undefined, undefined, maps); unchanged(f, before);
  for (let i = 0; i < FIELDS.length; i++) assert.equal(refs[i], store.columns[FIELDS[i]], 'held vectors are not detached or mutated');
  // The hostile public cleanup override is not allowed to hide a test leak.
  originalDispose.call(model); assert.equal(store.listeners.size, 0);
});

test('invalid lifecycle order and old UI import fail closed', t => {
  const f = fixture(t);
  for (const operation of [p => p.step(), p => p.finish(), p => p.finishUI({follow: true})]) {
    const p = prepared(t, f); assert.throws(() => operation(p)); released(p);
  }
  for (const operation of [p => p.start(), p => p.target(0, 0, 1), p => p.finish('{}'), p => p.step(65537), p => p.step(0), p => p.step(1.5)]) {
    const p = prepared(t, f); transfer(p, f.store.columns); p.start(); run(p);
    const model = p.model, store = p.store; assert.throws(() => operation(p)); released(p, store, model);
  }
});

for (const label of ['factory params', 'factory outputs', 'module descriptor']) test('native target rejects changing ' + label + ' binding', t => {
  const f = fixture(t, {module: true}), spec = specification(f);
  t.after(() => {for (const key of Object.keys(hooks)) delete hooks[key];});
  if (label === 'factory params') hooks.factory = params => {params.negativeZero = 0;};
  if (label === 'factory outputs') hooks.definition = definition => {definition.outputs.reverse();};
  if (label === 'module descriptor') editDocument(spec, doc => {doc.indicators.find(e => e.id === 'module').module.stateVersion = 2;});
  assert.throws(() => new NativeWorkspacePrepared(safeCheckpointStringify(spec)));
});

for (const callback of ['factory', 'create', 'step', 'snapshot', 'validate']) test('module ' + callback + ' failure releases target allocations and leaves shared source live', t => {
  const f = fixture(t, {module: true}), before = sourceState(f), p = prepared(t, f);
  t.after(() => {for (const key of Object.keys(hooks)) delete hooks[key];});
  transfer(p, f.store.columns); p.start(); const store = p.store;
  hooks[callback] = () => {throw new Error('intentional ' + callback + ' failure');};
  assert.throws(() => run(p), new RegExp('intentional ' + callback));
  delete hooks[callback]; released(p, store); unchanged(f, before);
});

for (const mutation of ['dispose target', 'update target source', 'replace target params', 'change output schema', 'replace entry registry'])
  test('trusted checkpoint callback cannot publish after it reenters to ' + mutation, t => {
    const f = fixture(t, {module: true}), before = sourceState(f), p = prepared(t, f);
    t.after(() => {for (const key of Object.keys(hooks)) delete hooks[key];});
    transfer(p, f.store.columns); p.start(); toPhase(p, 'calculate');
    const store = p.store, model = p.model;
    hooks.validate = () => {
      delete hooks.validate;
      if (mutation === 'dispose target') p.dispose();
      if (mutation === 'update target source') {const bar = store.at(1); store.update(1, {...bar, volume: bar.volume + 1});}
      if (mutation === 'replace target params') model.indicators.entries.get('module').params = {changed: true};
      if (mutation === 'change output schema') model.indicators.entries.get('module').def.outputs.reverse();
      if (mutation === 'replace entry registry') model.indicators.entries = new Map();
    };
    assert.throws(() => run(p)); released(p, store, model); unchanged(f, before);
  });

const readyMutations = {
  setPanel: api => api.setPanel('price', {padding: .25}), setAxis: api => api.setAxis('price-left', {width: 88}),
  setSeries: api => api.setSeries('raw-close', {color: '#ff0000'}), setTheme: api => api.setTheme({background: '#112233'}),
  setView: api => api.setVisibleRange(30, 80), setSymbol: api => api.setSymbol({...SYMBOL, id: 'CHANGED'}),
  sourceUpdate: api => {const bar = api.model.store.at(1); api.model.store.update(1, {...bar, volume: bar.volume + 1});},
  sourceReplace: api => api.model.store.setColumns(api.model.store.columns, api.model.store.length),
  selectedDrawing: api => api.selectDrawing('fractional-trend'),
  drawingHistory: api => api.addDrawing({id: 'late', type: 'text', panel: 'price', points: [{time: api.model.store.at(0).time, price: 100}], text: 'late'}),
};
for (const [label, mutate] of Object.entries(readyMutations)) test('final ready guard rejects managed ' + label + ' mutation and releases ownership', t => {
  const f = fixture(t, {rich: true}), before = sourceState(f), p = prepared(t, f); transfer(p, f.store.columns); p.start(); run(p);
  const model = p.model, store = p.store; mutate(new ChartAPI(model));
  assert.throws(() => p.finish(), /changed/); released(p, store, model); unchanged(f, before);
});

test('ready polling also verifies freshness and missing checkpoint history fails before readiness', t => {
  const f = fixture(t), p = prepared(t, f); transfer(p, f.store.columns); p.start(); run(p);
  assert.deepEqual(p.step(65536), {phase: 'workspace-ready', done: 1, total: 1, complete: true});
  const store = p.store, model = p.model; new ChartAPI(model).setTheme({grid: '#334455'});
  assert.throws(() => p.step(), /changed/); released(p, store, model);
  const q = prepared(t, f); transfer(q, f.store.columns); q.start(); toPhase(q, 'workspace-checkpoints');
  const qStore = q.store, qModel = q.model; qModel.indicators.entries.get('ema').checkpoints.delete(0);
  assert.throws(() => run(q), /checkpoint.*count/); released(q, qStore, qModel);
});
test('target ingestion transport is separate, preserves paused cursor and reserves bounded ring copies',t=>{const f=fixture(t);f.api.configureDataIngestion({streamId:'target-feed',generation:2,firstSequence:71,maxQueuedEvents:8,maxQueuedBytes:392});f.api.pauseDataIngestion();const state=f.api.saveDataIngestion(),p=prepared(t,f,{dataIngestion:state});assert.equal(p.plan.ingestionBytes,8*49*3);transfer(p,f.store.columns);p.start();run(p);const result=p.finish();t.after(()=>result.model.dispose());assert.equal(new ChartAPI(result.model).saveDataIngestion(),state);assert.equal(saveWorkspace(new ChartAPI(result.model),BINDING),saveWorkspace(f.api,BINDING));});
for(const mode of ['oversize','wrong-type','unknown-field','invalid-capacity','pending'])test('target rejects forged ingestion transport '+mode,t=>{const f=fixture(t);f.api.configureDataIngestion({streamId:'target-feed',generation:2,maxQueuedEvents:8,maxQueuedBytes:392});let state=f.api.saveDataIngestion();if(mode==='oversize')state='x'.repeat(32769);else if(mode==='wrong-type')state={};else{const doc=safeCheckpointParse(state);if(mode==='unknown-field')doc.extra=true;else if(mode==='invalid-capacity')doc.policy.maxQueuedEvents=4097;else{doc.pending.events=[{kind:'append',bar:f.store.at(0)}];doc.nextSequence=1;doc.counters.accepted=1;doc.counters.peakPendingEvents=1;doc.counters.peakPendingBytes=49;}state=safeCheckpointStringify(doc);}assert.throws(()=>prepared(t,f,{dataIngestion:state}));assert.equal(f.model.disposed,undefined);});
test('ready target ingestion mutation invalidates ownership transfer and releases its ring',t=>{const f=fixture(t);f.api.configureDataIngestion({streamId:'target-feed',generation:2});const p=prepared(t,f,{dataIngestion:f.api.saveDataIngestion()});transfer(p,f.store.columns);p.start();run(p);const session=p.model.dataIngestion;session.pause();assert.throws(()=>p.finish(),/configuration changed/);assert.equal(session.closed,true);assert.equal(session.kinds,null);});
