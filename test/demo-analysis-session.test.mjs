import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {BarStore, ChartModel, ChartAPI, DEMO_SYMBOLS, seededColumns, saveWorkspace, prepareWorkspaceAsync} from '../src/index.mjs';
import {saveDemoAnalysis, readDemoAnalysis, MAX_ANALYSIS_BYTES, MAX_ANALYSIS_BARS} from '../examples/web/analysis-session.mjs';

function fixture(t, market = 'us') {
  const store = new BarStore();
  store.setColumns(seededColumns(64));
  const model = new ChartModel({store}), api = new ChartAPI(model);
  api.setSymbol(DEMO_SYMBOLS[market]);
  api.addSeries({id: 'price', type: 'candles', panel: 'price'});
  api.addIndicator('ema20', 'ema', {period: 20});
  api.addSeries({id: 'ema20-line', type: 'line', panel: 'price', indicator: 'ema20'});
  api.addDrawing({id: 'level', type: 'horizontal', panel: 'price', points: [{time: store.at(10).time, price: 100}], text: '<b>note</b>'});
  api.setVisibleRange(12, 42);
  t.after(() => model.dispose());
  return {model, api, options: {market, count: 10000, light: false}};
}

test('analysis roundtrip owns exact bars, studies, drawings and view through an actual Worker', async t => {
  const {model, api, options} = fixture(t);
  const original = model.store.at(0);
  api.applyDataEvent({kind: 'correction', bar: {...original, volume: -0}});
  const before = {columns: model.store.columns, version: model.store.version, drawings: model.drawings.items};
  const text = saveDemoAnalysis(api, options), snapshot = readDemoAnalysis(text);
  assert.notEqual(snapshot.store, model.store);
  for (let i = 0; i < model.store.length; i++) assert.deepEqual(snapshot.store.at(i), model.store.at(i));
  assert.ok(Object.is(snapshot.store.at(0).volume, -0));
  assert.equal(model.store.columns, before.columns);
  assert.equal(model.store.version, before.version);
  assert.equal(model.drawings.items, before.drawings);
  const factory = () => {
    const worker = new Worker(new URL('./fixtures/workspace-worker-host.mjs', import.meta.url));
    const adapter = {onmessage: null, onerror: null, postMessage: (packet, transfer) => worker.postMessage(packet, transfer), terminate: () => worker.terminate()};
    worker.on('message', packet => { if (packet?.__workspaceTestHost !== 'dispatch') adapter.onmessage?.({data: packet}); });
    worker.on('error', error => adapter.onerror?.(error));
    t.after(() => worker.terminate());
    return adapter;
  };
  const restored = await prepareWorkspaceAsync(snapshot.store, snapshot.workspace, {datasetBinding: snapshot.binding, workerFactory: factory});
  t.after(() => restored.dispose());
  assert.equal(saveWorkspace(new ChartAPI(restored), snapshot.binding), snapshot.workspace);
  assert.deepEqual(restored.view, model.view);
  assert.deepEqual(restored.drawings.items, model.drawings.items);
  assert.deepEqual([...new ChartAPI(restored).indicatorValues('ema20')], [...api.indicatorValues('ema20')]);
  api.applyDataEvent({kind: 'correction', bar: {...original, volume: 999}});
  assert.ok(Object.is(snapshot.store.at(0).volume, -0), 'loaded source never aliases the mounted source');
});

for (const market of ['us', 'kr', 'crypto']) test(`analysis keeps ${market} market and appearance`, t => {
  const f = fixture(t, market), result = readDemoAnalysis(saveDemoAnalysis(f.api, {...f.options, light: true}));
  assert.equal(result.market, market);
  assert.equal(result.count, 10000);
  assert.equal(result.light, true);
  assert.equal(result.binding.priceUnit, DEMO_SYMBOLS[market].currency);
});

for (const [name, mutate] of [
  ['unknown format', d => {d.version = 99;}],
  ['unknown fields', d => {d.extra = true;}],
  ['market mismatch', d => {d.market = 'kr';}],
  ['unequal columns', d => {d.columns.close.pop();}],
  ['nonfinite values', d => {d.columns.close[0] = null;}],
  ['text in numeric column', d => {d.columns.close[0] = '100';}],
  ['invalid OHLC', d => {d.columns.high[0] = -100;}],
  ['duplicate timestamps', d => {d.columns.time[1] = d.columns.time[0];}],
  ['source extent mismatch', d => {for (const k of Object.keys(d.columns)) d.columns[k].pop();}],
  ['unknown columns', d => {d.columns.future = [];}],
]) test(`analysis rejects ${name}`, t => {
  const f = fixture(t), document = JSON.parse(saveDemoAnalysis(f.api, f.options));
  mutate(document);
  assert.throws(() => readDemoAnalysis(JSON.stringify(document)));
  assert.notEqual(f.model.disposed, true);
  assert.equal(f.model.drawings.items.length, 1);
});

test('analysis rejects oversized and deeply nested files before parsing', () => {
  assert.throws(() => readDemoAnalysis(' '.repeat(MAX_ANALYSIS_BYTES + 1)), RangeError);
  assert.throws(() => readDemoAnalysis('['.repeat(100000) + ']'.repeat(100000)), RangeError);
});

test('saving an active drawing or over-limit source leaves the model unchanged', t => {
  const f = fixture(t);
  f.model.drawings.begin();
  assert.throws(() => saveDemoAnalysis(f.api, f.options), /gesture/i);
  f.model.drawings.cancel();
  f.model.store.setColumns(seededColumns(MAX_ANALYSIS_BARS + 1));
  const columns = f.model.store.columns;
  assert.throws(() => saveDemoAnalysis(f.api, f.options), RangeError);
  assert.equal(f.model.store.columns, columns);
});
