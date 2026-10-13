import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import * as core from '../src/core/index.mjs';
import * as root from '../src/index.mjs';
import * as workerEntry from '../src/web/worker.mjs';
import {safeCheckpointParse, safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
import {calculationJobStats} from '../src/web/calculation-job.mjs';
import {WORKSPACE_TEST_MODULE} from './fixtures/workspace-worker-host.mjs';

const {BarStore, ChartModel, ChartAPI, InteractionController, seededColumns,
  DRAWING_TYPES, drawingPointCount, buildScene, createLayout, drawingGeometry} = core;
const HOST = new URL('./fixtures/workspace-worker-host.mjs', import.meta.url);
const BINDING = Object.freeze({key: 'fixture:ASTER/1m', revision: '2026-10-13.1',
  adjustmentVersion: 'raw-v1', priceUnit: 'USD', adjustment: 'raw'});
const SYMBOL = Object.freeze({id: 'ASTER', exchange: 'TEST', timezone: 'America/New_York',
  currency: 'USD', volumeUnit: 'shares', priceDecimals: 2, tickSize: .01, adjustment: 'raw'});
const W = 1100, H = 760;
const BASELINE = {activeJobs: 0, reservedBytes: 0};
const save = (api, binding = BINDING) => core.saveWorkspace(api, binding);
const prepare = (store, text, options = {}) => root.prepareWorkspaceAsync(store, text,
  {datasetBinding: BINDING, ...options});
const invoke = (...args) => Promise.resolve().then(() => prepare(...args));
const isStale = error => /stale|source.changed/i.test(`${error?.name} ${error?.message}`);

function workers(t, hooks = {}) {
  const instances = [];
  const factory = url => {
    assert.match(String(url), /workspace-worker\.mjs$/);
    const node = new Worker(HOST), adapter = {
      node, threadId: node.threadId, onmessage: null, onerror: null, terminations: 0, posts: 0,
      postMessage(request, transfer) {
        this.posts++;
        hooks.beforeSend?.(request, this);
        node.postMessage(request, transfer);
        hooks.afterSend?.(request, this);
      },
      terminate() {
        this.terminations++;
        hooks.terminating?.(this);
        return node.terminate().then(async code => {await hooks.terminated?.(this); return code;});
      },
    };
    adapter.exited = new Promise(resolve => node.once('exit', resolve));
    node.on('message', packet => {
      if (packet?.__workspaceTestHost === 'dispatch') {hooks.processing?.(adapter); return;}
      hooks.beforeReceive?.(packet, adapter);
      adapter.onmessage?.({data: packet});
    });
    node.on('error', error => adapter.onerror?.(error));
    instances.push(adapter);
    return adapter;
  };
  t.after(async () => {await Promise.all(instances.map(instance => instance.node.terminate()));});
  return {factory, instances, async clean() {
    await Promise.all(instances.map(instance => instance.exited));
    assert.deepEqual(calculationJobStats(), BASELINE);
    for (const instance of instances) {
      assert.ok(instance.threadId > 0, 'computed in an actual separate Worker thread');
      assert.equal(instance.terminations, 1);
      assert.equal(instance.onmessage, null);
      assert.equal(instance.onerror, null);
    }
  }};
}

function fixture(t, {n = 550, rich = true, symbol = true, sign = -0} = {}) {
  const store = new BarStore(); store.setColumns(seededColumns(n, 89));
  const model = new ChartModel({store, axisWidth: 93, precision: 4,
    theme: {background: '#111925ff', grid: '#263545ff', text: '#aabbccff', up: '#33cc99ff',
      down: '#ee6677ff', crosshair: '#f0e1d2ff', font: '13px monospace'},
    panels: rich ? [
      {id: 'price', weight: 4, padding: .03, precision: 3, label: 'Primary price'},
      {id: 'osc', weight: 2, range: [-25, 25], padding: 0, precision: 5, axisSide: 'left'},
      {id: 'volume', weight: 1, padding: 0, axisVisible: false},
    ] : [{id: 'price', weight: 1}],
    axes: rich ? [
      {id: 'price-left', panel: 'price', side: 'left', width: 67, range: [1, 400], precision: 6,
        tickFormat: 'scientific', prefix: 'P:', suffix: ' USD'},
      {id: 'percent', panel: 'price', side: 'right', width: 76, scale: 'percent',
        base: 100, range: [1, 400], inverted: true, precision: 2},
      {id: 'quiet-axis', panel: 'osc', side: 'right', visible: false, scale: 'log', range: [1, 10000]},
    ] : [],
  });
  const controller = new InteractionController(model, () => ({width: W, height: H}));
  let invalidations = 0;
  const api = new ChartAPI(model, {controller, invalidate() {invalidations++;}});
  if (symbol) {api.setSymbol(SYMBOL); model.precision = 6;}
  api.addIndicator('ema', 'ema', {period: 13, negativeZero: -0, positiveZero: 0});
  api.addIndicator('own-keys', WORKSPACE_TEST_MODULE, {sign, shift: 2});
  api.addSeries({id: 'candles', type: 'candles', panel: 'price', color: '#7898ffff',
    upColor: '#22aa88ff', downColor: '#ee5577ff', width: 1.75});
  api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema',
    color: '#aacc44ff', width: 2.25, label: 'EMA 13'});
  api.addSeries({id: 'own-line', type: 'line', panel: 'price', indicator: 'own-keys', output: 'toString',
    color: '#eeee55ff', ...(rich ? {axisId: 'price-left'} : {})});
  if (rich) {
    api.addIndicator('macd', 'macd', {fast: 5, slow: 17, signal: 4});
    api.addIndicator('pressure', 'aster.volume-direction@1/pressure', {factor: .75, shift: -3});
    api.addIndicator('hidden-rsi', 'rsi', {period: 9});
    api.addSeries({id: 'ohlc-hidden', type: 'ohlc', panel: 'price', visible: false, color: '#7898ffff'});
    api.addSeries({id: 'raw-open', type: 'area', panel: 'price', axisId: 'percent', source: 'open',
      color: '#8899aaff', fill: '#11223344', width: 1.125, baseline: .5, offset: -1});
    api.addSeries({id: 'volume-bars', type: 'histogram', panel: 'volume', source: 'volume',
      color: '#55aaeeff', baseline: 0, upColor: '#11aa88ff', downColor: '#aa3344ff'});
    for (const [index, output] of Object.keys(model.indicators.get('macd').outputs).entries()) {
      api.addSeries({id: 'macd-' + output, type: index === 2 ? 'histogram' : 'line', panel: 'osc',
        indicator: 'macd', output, color: ['#cc88ffff', '#88ccffff', '#ffaa66ff'][index], baseline: 0});
    }
    api.addSeries({id: 'pressure-hidden', type: 'line', panel: 'osc', axisId: 'quiet-axis',
      indicator: 'pressure', output: 'cumulative', visible: false, color: '#ddeeffff'});
    const first = n ? store.at(0).time : 1700000000000;
    const last = n ? store.at(n - 1).time : first;
    DRAWING_TYPES.forEach((type, index) => {
      const count = type === 'freehand' ? 5 : drawingPointCount(type);
      const times = [first - 120000.25, first + 31 * 60000 + .125, last + 180000.75,
        first + 42 * 60000 + .5, last + 240000.25];
      api.addDrawing({id: 'anchor-' + type, type, panel: 'price',
        ...(index % 3 === 0 ? {seriesId: 'own-line'} : index % 3 === 1 ? {axisId: 'percent'} : {}),
        points: Array.from({length: count}, (_, j) => ({time: times[j], price: 92.125 + index + j * 3.375})),
        text: type === 'text' ? '한국 🚀 exact anchors' : '', locked: type === 'measurement',
        style: {color: '#ffcc88ff', fill: '#33445522', width: 1.75, font: '12px monospace'}});
    });
  }
  model.setVisibleRange(12.25, 189.75);
  t.after(() => model.dispose());
  return {store, model, api, controller, get invalidations() {return invalidations;}};
}

function outputs(model) {
  return Object.fromEntries([...model.indicators.entries].map(([id]) => [id,
    Object.fromEntries(Object.entries(model.indicators.get(id).outputs).map(([key, values]) => [key, [...values]]))]));
}
function freshOracle(model) {
  const store = new BarStore(); store.setColumns(model.store.columns, model.store.length);
  const fresh = new ChartModel({store});
  try {
    for (const [id, entry] of model.indicators.entries) fresh.indicators.add(id, entry.name, {...entry.params});
    return outputs(fresh);
  } finally {fresh.dispose();}
}
function oldState(f) {
  const values = outputs(f.model);
  return {store: f.store, columns: f.store.columns, index: f.store.index, version: f.store.version,
    listeners: [...f.store.listeners], columnValues: Object.fromEntries(Object.entries(f.store.columns).map(([key, v]) => [key, [...v]])),
    series: f.model.series, seriesRefs: [...f.model.series], entries: f.model.indicators.entries,
    entryRefs: [...f.model.indicators.entries], values, drawings: f.model.drawings.items,
    undo: f.model.drawings.undoStack, redo: f.model.drawings.redoStack,
    selected: f.model.drawings.selected, view: f.model.view, theme: f.model.theme, invalidations: f.invalidations};
}
function unchanged(f, before, {listeners = true} = {}) {
  assert.equal(f.model.store, before.store); assert.equal(f.store.columns, before.columns);
  assert.equal(f.store.index, before.index); assert.equal(f.store.version, before.version);
  if (listeners) assert.deepEqual([...f.store.listeners], before.listeners);
  for (const [key, v] of Object.entries(f.store.columns)) assert.deepEqual([...v], before.columnValues[key], 'source ' + key);
  assert.equal(f.model.series, before.series); before.seriesRefs.forEach((s, i) => assert.equal(f.model.series[i], s));
  assert.equal(f.model.indicators.entries, before.entries);
  for (const [id, e] of before.entryRefs) assert.equal(f.model.indicators.entries.get(id), e);
  assert.deepEqual(outputs(f.model), before.values); assert.equal(f.model.drawings.items, before.drawings);
  assert.equal(f.model.drawings.undoStack, before.undo); assert.equal(f.model.drawings.redoStack, before.redo);
  assert.equal(f.model.drawings.selected, before.selected); assert.equal(f.model.view, before.view);
  assert.equal(f.model.theme, before.theme); assert.equal(f.invalidations, before.invalidations);
}
function ownModel(t, model) {t.after(() => model.dispose()); return model;}

// All expected values come from public behavior or a freshly recomputed model,
// not from the workspace writer/reader under test.
test('workspace exports agree across public core, root and worker entrypoints', () => {
  assert.equal(typeof core.saveWorkspace, 'function');
  assert.equal(root.saveWorkspace, core.saveWorkspace);
  assert.equal(typeof root.prepareWorkspaceAsync, 'function');
  assert.equal(workerEntry.prepareWorkspaceAsync, root.prepareWorkspaceAsync);
});

test('canonical full workspace preserves panels, axes, all series, 14 drawing tools and exact scene', async t => {
  const f = fixture(t), w = workers(t);
  f.model.drawings.selected = null;
  const expectedScene = buildScene(f.model, W, H).commands;
  const expectedGeometry = f.model.drawings.items.map(d => drawingGeometry(d, createLayout(f.model, W, H)));
  f.model.crosshair = {x: 500, y: 210};
  f.controller.setTool('text'); f.controller.text = 'Transient uncommitted label';
  f.model.drawings.selected = 'anchor-text';
  const before = oldState(f), text = save(f.api), doc = safeCheckpointParse(text);
  unchanged(f, before);
  assert.equal(doc.schema, 'aster.workspace'); assert.equal(doc.version, 1);
  assert.deepEqual(doc.dataset, BINDING);
  assert.deepEqual(doc.source, {length: f.store.length, firstTime: f.store.at(0).time, lastTime: f.store.at(f.store.length - 1).time});
  assert.equal(doc.chart.precision, 6); assert.equal(doc.chart.formatters, 'symbol');
  assert.deepEqual(doc.chart.symbol, SYMBOL);
  assert.deepEqual(doc.series.map(s => s.id), f.model.series.map(s => s.id), 'includes raw, candles, OHLC, hidden and study series');
  assert.deepEqual(doc.drawings.drawings, f.model.drawings.items);
  assert.equal(doc.indicators.find(e => e.id === 'hidden-rsi').name, 'rsi', 'unplotted study survives');
  assert.deepEqual(Object.keys(doc).sort(), ['chart', 'dataset', 'drawings', 'indicators', 'schema', 'series', 'source', 'version']);
  for (const forbidden of ['columns', 'bars', 'crosshair', 'selected', 'undoStack', 'redoStack', 'pointers', 'gesture', 'tool', 'text', 'dataIngestion']) {
    assert.equal(Object.hasOwn(doc, forbidden), false);
    assert.equal(Object.hasOwn(doc.chart, forbidden), false);
  }
  for (const row of doc.indicators) for (const key of ['arrays', 'checkpoints', 'dirty', 'revision']) assert.equal(Object.hasOwn(row, key), false);
  const restored = ownModel(t, await prepare(f.store, text, {workerFactory: w.factory}));
  assert.ok(restored instanceof ChartModel); assert.notEqual(restored, f.model);
  assert.equal(restored.store, f.store); assert.equal(restored.store.columns, before.columns);
  unchanged(f, before, {listeners: false});
  assert.equal(f.store.listeners.size, before.listeners.length + 2, 'only returned engine/model listeners remain');
  assert.equal(save(new ChartAPI(restored)), text, 'save/restore/save is exact canonical text');
  assert.deepEqual(restored.panels, f.model.panels); assert.deepEqual(restored.axes, f.model.axes);
  assert.deepEqual(restored.theme, f.model.theme); assert.deepEqual(restored.symbol, f.model.symbol);
  assert.equal(restored.precision, 6, 'explicit precision remains after restoring setSymbol formatters');
  assert.deepEqual(restored.view, f.model.view); assert.equal(restored.follow, f.model.follow);
  assert.equal(restored.priceFormatter(123.456), f.model.priceFormatter(123.456));
  assert.equal(restored.timeFormatter(f.store.at(20).time), f.model.timeFormatter(f.store.at(20).time));
  assert.deepEqual(outputs(restored), before.values);
  assert.deepEqual(restored.drawings.items, before.drawings);
  assert.equal(restored.drawings.selected, null); assert.equal(restored.crosshair, null);
  assert.equal(restored.drawings.transaction, null);
  assert.equal(restored.drawings.undoStack.length, 0); assert.equal(restored.drawings.redoStack.length, 0);
  assert.deepEqual(buildScene(restored, W, H).commands, expectedScene);
  assert.deepEqual(restored.drawings.items.map(d => drawingGeometry(d, createLayout(restored, W, H))), expectedGeometry);
  await w.clean();
});

test('linked module own-key outputs, static versions, signed zero params and offsets remain exact', async t => {
  for (const sign of [-0, 0]) await t.test(Object.is(sign, -0) ? '-0' : '+0', async t => {
    const f = fixture(t, {rich: false, sign}), w = workers(t), text = save(f.api), doc = safeCheckpointParse(text);
    const row = doc.indicators.find(e => e.id === 'own-keys');
    assert.ok(Object.is(row.params.sign, sign));
    assert.deepEqual(row.module, {id: 'test.workspace-own-keys', version: 1, stateVersion: 1, exportName: 'signed', causal: true});
    assert.deepEqual(row.outputs, ['toString', 'valueOf', 'hasOwnProperty']);
    assert.deepEqual(row.plotOffsets, Object.fromEntries(row.outputs.map(name => [name, 2])));
    const restored = ownModel(t, await prepare(f.store, text, {workerFactory: w.factory}));
    assert.ok(Object.is(restored.indicators.entries.get('own-keys').params.sign, sign));
    assert.ok(Object.is(restored.indicators.entries.get('ema').params.negativeZero, -0));
    assert.ok(Object.is(restored.indicators.entries.get('ema').params.positiveZero, 0));
    const values = restored.indicators.get('own-keys').outputs;
    assert.deepEqual(Object.keys(values), row.outputs);
    assert.equal(values.toString[5], Object.is(sign, -0) ? f.store.at(5).close : -f.store.at(5).close);
    assert.equal(restored.series.find(s => s.id === 'own-line').offset, 2);
    assert.equal(save(new ChartAPI(restored)), text); await w.clean();
  });
});

test('default-formatters and symbol metadata without installed callbacks roundtrip distinctly', async t => {
  for (const metadata of [false, true]) await t.test(String(metadata), async t => {
    const f = fixture(t, {rich: false, symbol: false}), w = workers(t);
    if (metadata) f.model.symbol = {...SYMBOL};
    const text = save(f.api), doc = safeCheckpointParse(text);
    assert.equal(doc.chart.formatters, 'default'); assert.equal(doc.chart.precision, 4);
    const restored = ownModel(t, await prepare(f.store, text, {workerFactory: w.factory}));
    assert.equal(restored.priceFormatter, undefined); assert.equal(restored.timeFormatter, undefined);
    assert.equal(restored.precision, 4); assert.deepEqual(restored.symbol, f.model.symbol);
    assert.equal(save(new ChartAPI(restored)), text); await w.clean();
  });
});

test('save leaves a pending unplotted study unevaluated and all old source state unchanged', t => {
  const f = fixture(t, {rich: false}); f.model.indicators.add('lazy', 'sma', {period: 7});
  const first = f.store.at(0); f.store.update(0, {...first, volume: first.volume + 1});
  const entry = f.model.indicators.entries.get('lazy');
  const before = {arrays: entry.arrays, checkpoints: entry.checkpoints, length: entry.length,
    dirty: entry.dirty, revision: entry.revision, listeners: [...f.store.listeners], version: f.store.version};
  const doc = safeCheckpointParse(save(f.api));
  assert.equal(doc.indicators.find(e => e.id === 'lazy').name, 'sma');
  for (const key of ['arrays', 'checkpoints', 'length', 'dirty', 'revision']) assert.equal(entry[key], before[key], key);
  assert.deepEqual([...f.store.listeners], before.listeners); assert.equal(f.store.version, before.version);
});

for (const mode of ['pan', 'pinch', 'drawing', 'pointer-only', 'manual-transaction']) {
  test('save rejects active ' + mode + ' without cancelling or editing it', t => {
    const f = fixture(t, {rich: false});
    if (mode === 'manual-transaction') f.model.drawings.begin();
    else if (mode === 'pointer-only') f.controller.down(1, 1, 1);
    else {
      if (mode === 'drawing') f.controller.setTool('rectangle');
      f.controller.down(1, 260, 210);
      if (mode === 'pinch') f.controller.down(2, 420, 210);
      f.controller.move(1, 300, 230);
    }
    const gesture = f.controller.gesture, transaction = f.model.drawings.transaction,
      pointers = [...f.controller.pointers], items = f.model.drawings.items, view = {...f.model.view};
    assert.throws(() => save(f.api), /gesture|pointer|transaction|commit|cancel/i);
    assert.equal(f.controller.gesture, gesture); assert.equal(f.model.drawings.transaction, transaction);
    assert.deepEqual([...f.controller.pointers], pointers); assert.equal(f.model.drawings.items, items);
    assert.deepEqual(f.model.view, view);
    f.controller.cancel(); assert.equal(typeof save(f.api), 'string');
  });
}

for (const mode of ['external-values', 'model-price', 'model-time', 'panel', 'axis', 'unsupported-color']) {
  test('save explicitly rejects ' + mode + ' rather than silently omitting it', t => {
    const f = fixture(t);
    if (mode === 'external-values') f.api.addSeries({id: 'external', type: 'line', panel: 'price', values: new Float64Array(f.store.length)});
    if (mode === 'model-price') f.model.priceFormatter = value => String(value);
    if (mode === 'model-time') f.model.timeFormatter = value => String(value);
    if (mode === 'panel') f.model.setPanel('price', {formatter: value => String(value)});
    if (mode === 'axis') f.model.setAxis('price-left', {formatter: value => String(value)});
    if (mode === 'unsupported-color') f.model.series[0].upColor = 'color(display-p3 1 0 0)';
    const before = oldState(f);
    assert.throws(() => save(f.api), /external|values|formatter|portable|color|unsupported/i);
    unchanged(f, before);
  });
}

test('dataset identity, revision, adjustment and currency mismatches reject before creating a Worker', async t => {
  const f = fixture(t), text = save(f.api), before = oldState(f); let created = 0;
  const factory = () => {created++; throw new Error('validation must happen before Worker creation');};
  for (const [key, wrong] of [['key', 'other'], ['revision', 'r2'], ['adjustmentVersion', 'split-v2'], ['priceUnit', 'EUR'], ['adjustment', 'split']]) {
    await assert.rejects(invoke(f.store, text, {datasetBinding: {...BINDING, [key]: wrong}, workerFactory: factory}));
    unchanged(f, before);
  }
  for (const key of Object.keys(BINDING)) {
    const absent = {...BINDING}; delete absent[key];
    assert.throws(() => save(f.api, absent));
    assert.throws(() => save(f.api, {...BINDING, [key]: ''}));
    assert.throws(() => save(f.api, {...BINDING, [key]: 'x'.repeat(129)}));
  }
  assert.throws(() => save(f.api, {...BINDING, priceUnit: 'EUR'}));
  assert.throws(() => save(f.api, {...BINDING, adjustment: 'total-return'}));
  assert.throws(() => save(f.api, {...BINDING, extra: 'unknown'}));
  assert.equal(created, 0); unchanged(f, before);
});

test('strict document schemas, unique IDs, module versions, outputs and drawing bindings reject atomically', async t => {
  const f = fixture(t), text = save(f.api), before = oldState(f); let created = 0;
  const mutations = [
    d => {d.version = 2;}, d => {d.unknown = true;}, d => {d.chart.unknown = true;},
    d => {d.source.length++;}, d => {d.source.firstTime--;}, d => {d.source.lastTime++;},
    d => {d.chart.panels[1].id = d.chart.panels[0].id;},
    d => {d.chart.axes[1].id = d.chart.axes[0].id;},
    d => {d.series[1].id = d.series[0].id;}, d => {d.indicators[1].id = d.indicators[0].id;},
    d => {d.drawings.drawings[1].id = d.drawings.drawings[0].id;},
    d => {d.series[1].indicator = 'missing';}, d => {d.series[1].axisId = 'missing';},
    d => {d.series[1].output = 'missing';}, d => {d.series[1].values = [1, 2];},
    d => {d.chart.axes[0].panel = 'missing';}, d => {d.drawings.drawings[0].seriesId = 'missing';},
    d => {d.drawings.drawings[0].axisId = 'percent';}, d => {d.drawings.drawings[0].points[0].extra = 1;},
    d => {d.indicators.find(e => e.id === 'own-keys').module.version++;},
    d => {d.indicators.find(e => e.id === 'own-keys').module.stateVersion++;},
    d => {d.indicators.find(e => e.id === 'own-keys').module.exportName = 'missing';},
    d => {d.indicators.find(e => e.id === 'own-keys').outputs.reverse();},
    d => {d.indicators.find(e => e.id === 'own-keys').plotOffsets.toString++;},
    d => {d.chart.symbol.currency = 'EUR';}, d => {d.chart.symbol.adjustment = 'split';},
    d => {d.chart.symbol.unknown = true;}, d => {d.chart.precision = 1.5;},
  ];
  for (const [index, mutate] of mutations.entries()) {
    const doc = safeCheckpointParse(text); mutate(doc);
    await assert.rejects(invoke(f.store, safeCheckpointStringify(doc), {workerFactory() {created++; throw new Error('unexpected Worker');}}),
      undefined, 'invalid document mutation ' + index);
    unchanged(f, before);
  }
  assert.equal(created, 0, 'all static document validation precedes Worker creation');
  assert.deepEqual(calculationJobStats(), BASELINE);
});

test('restored indicators match fresh recomputation after append, tail update, historical correction and capacity growth', async t => {
  for (const n of [0, 1, 255, 256, 257, 550]) await t.test('source length ' + n, async t => {
    const f = fixture(t, {n}), w = workers(t), text = save(f.api);
    const doc = safeCheckpointParse(text);
    if (!n) assert.deepEqual(doc.source, {length: 0, firstTime: null, lastTime: null});
    const restored = ownModel(t, await prepare(f.store, text, {workerFactory: w.factory}));
    await w.clean(); assert.deepEqual(outputs(restored), freshOracle(restored), 'initial full oracle');
    const tail = n ? f.store.at(n - 1) : {time: 1700000000000, open: 100, high: 105, low: 95, close: 101, volume: 1};
    f.store.append({...tail, time: tail.time + 60000, open: tail.close, high: tail.close + 4,
      low: tail.close - 4, close: tail.close + 1, volume: 987});
    assert.deepEqual(outputs(restored), freshOracle(restored), 'append');
    let last = f.store.at(f.store.length - 1);
    f.store.update(f.store.length - 1, {...last, close: last.close - .5, volume: 4321});
    assert.deepEqual(outputs(restored), freshOracle(restored), 'tail update');
    const index = Math.min(257, f.store.length - 1), old = f.store.at(index);
    f.store.update(index, {...old, high: old.high + 5, low: old.low - 5, close: old.close + 2, volume: 8888});
    assert.deepEqual(outputs(restored), freshOracle(restored), 'historical correction');
    assert.deepEqual(outputs(f.model), freshOracle(f.model), 'original model remains live');
    assert.deepEqual(outputs(restored), outputs(f.model));
  });
});

test('disposing old or restored model leaves the other model, shared BarStore and held outputs usable', async t => {
  for (const disposed of ['old', 'restored']) await t.test(disposed, async t => {
    const f = fixture(t), w = workers(t), restored = ownModel(t, await prepare(f.store, save(f.api), {workerFactory: w.factory}));
    await w.clean();
    const removed = disposed === 'old' ? f.model : restored, survivor = disposed === 'old' ? restored : f.model;
    const held = removed.seriesData(removed.series.find(s => s.id === 'ema-line')).values;
    const heldValues = [...held], heldBuffer = held.buffer, heldBytes = held.buffer.byteLength, columns = f.store.columns, index = f.store.index;
    removed.dispose(); removed.dispose();
    assert.equal(f.store.listeners.size, 2); assert.equal(f.store.columns, columns); assert.equal(f.store.index, index);
    assert.equal(held.buffer, heldBuffer); assert.equal(heldBuffer.byteLength, heldBytes);
    assert.deepEqual([...held], heldValues);
    const old = f.store.at(257); f.store.update(257, {...old, close: old.high, volume: old.volume + 100});
    assert.deepEqual(outputs(survivor), freshOracle(survivor));
    assert.ok(buildScene(survivor, W, H).commands.length > 0);
    assert.deepEqual([...held], heldValues, 'disposed owner held arrays are not rewritten');
    survivor.dispose(); assert.equal(f.store.listeners.size, 0);
    const last = f.store.at(f.store.length - 1); f.store.append({...last, time: last.time + 60000});
    assert.equal(f.store.length, 551, 'caller-owned source still accepts events after both models are gone');
  });
});

for (const phase of ['send', 'receive', 'terminate']) {
  test('managed source change during ' + phase + ' rejects and cleans candidate listeners', async t => {
    const f = fixture(t), text = save(f.api), listeners = [...f.store.listeners]; let changed = false;
    const mutate = () => {if (!changed) {changed = true; const b = f.store.at(0); f.store.update(0, {...b, volume: b.volume + 1});}};
    const w = workers(t, phase === 'send' ? {afterSend: mutate} : phase === 'receive' ? {beforeReceive: mutate} : {terminated: mutate});
    await assert.rejects(invoke(f.store, text, {workerFactory: w.factory}), isStale);
    assert.equal(changed, true); await w.clean(); assert.deepEqual([...f.store.listeners], listeners);
    assert.equal(f.model.disposed, undefined); assert.deepEqual(outputs(f.model), freshOracle(f.model));
  });
}

test('UTF-16 and UTF-8 document limits reject before Worker allocation without touching old state', async t => {
  const f = fixture(t, {n: 1, rich: false}), text = save(f.api), before = oldState(f); let created = 0;
  const factory = () => {created++; throw new Error('oversized metadata reached a Worker');};
  const overChars = text + ' '.repeat(2097153 - text.length);
  await assert.rejects(invoke(f.store, overChars, {workerFactory: factory}), /document|limit|characters/i);
  const doc = safeCheckpointParse(text), template = doc.indicators.find(e => e.id === 'ema');
  doc.indicators = Array.from({length: 30}, (_, index) => ({...template, id: 'byte-budget-' + index,
    params: {period: 2, calendar: '한'.repeat(50000)}}));
  doc.series = [];
  const overBytes = JSON.stringify(doc);
  assert.ok(overBytes.length < 2097152); assert.ok(Buffer.byteLength(overBytes, 'utf8') > 4194304);
  await assert.rejects(invoke(f.store, overBytes, {workerFactory: factory}), /byte|document.*limit/i);
  assert.equal(created, 0); unchanged(f, before); assert.deepEqual(calculationJobStats(), BASELINE);
});

test('the reader accepts a valid document at its inclusive UTF-16 text boundary', async t => {
  const f = fixture(t, {n: 1, rich: false}), w = workers(t), text = save(f.api);
  const padded = text + ' '.repeat(2097152 - text.length);
  assert.equal(padded.length, 2097152);
  const restored = ownModel(t, await prepare(f.store, padded, {workerFactory: w.factory}));
  assert.equal(save(new ChartAPI(restored)), text); await w.clean();
});

for (const [label, calendar, count] of [['UTF-8', '한'.repeat(50000), 30], ['escaped UTF-16', '\0'.repeat(65536), 6]]) {
  test('writer bounds ' + label + ' before returning an oversized document', t => {
    const f = fixture(t, {n: 0, rich: false});
    for (let i = 0; i < count; i++) f.model.indicators.add('size-' + i, 'ema', {period: 2, calendar});
    const before = oldState(f);
    assert.throws(() => save(f.api), /document.*limit|limit.*document/i);
    unchanged(f, before);
  });
}

test('empty-study workspace preserves default configuration and future-offset follow behavior', async t => {
  const store = new BarStore(); store.setColumns(seededColumns(64, 91));
  const model = ownModel(t, new ChartModel({store})), api = new ChartAPI(model), w = workers(t);
  api.addSeries({id: 'raw', type: 'line', panel: 'price', source: 'close', offset: 7});
  model.fit(); assert.equal(model.follow, true);
  const text = save(api), restored = ownModel(t, await prepare(store, text, {workerFactory: w.factory}));
  assert.equal(restored.indicators.entries.size, 0); assert.equal(restored.follow, true);
  assert.equal(save(new ChartAPI(restored)), text);
  assert.deepEqual(buildScene(restored, W, H).commands, buildScene(model, W, H).commands);
  const span = restored.view.to - restored.view.from, tail = store.at(store.length - 1);
  store.append({...tail, time: tail.time + 60000});
  assert.equal(restored.view.to, store.length + 7 - .5);
  assert.equal(restored.view.to - restored.view.from, span);
  assert.deepEqual(restored.view, model.view); await w.clean();
});
