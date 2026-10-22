import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import vm from 'node:vm';
import {BarStore, ChartModel, ChartAPI, saveWorkspace} from '../src/core/index.mjs';
import {readWorkspaceDocument} from '../src/core/workspace.mjs';
import {prepareWorkspaceAsync} from '../src/web/workspace-async.mjs';
import {calculationJobStats} from '../src/web/calculation-job.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const BINDING = {key: 'symbol-fixture', revision: 'bars-1', adjustmentVersion: 'dataset-1',
  priceUnit: 'USD', adjustment: 'split'};
const SYMBOL = {id: 'TEST', exchange: 'VENUE', timezone: 'UTC', currency: 'USD',
  volumeUnit: 'shares', priceDecimals: 2, tickSize: .01, adjustment: 'split'};
const OPTIONAL = {provider: '외부 feed 🚀', adjustmentVersion: 'symbol-revision-7'};

function fixture(t, extra = {}) {
  const store = new BarStore([{time: 0, open: 1, high: 2, low: 0, close: 1, volume: 1},
    {time: 60000, open: 2, high: 3, low: 1, close: 2, volume: 2}]);
  const model = new ChartModel({store});
  let notices = 0;
  const api = new ChartAPI(model, {invalidate() {notices++;}});
  api.setSymbol({...SYMBOL, ...extra});
  api.addDrawing({id: 'keep', type: 'horizontal', panel: 'price', points: [{time: 0, price: 1}]});
  api.addDrawing({id: 'redo', type: 'horizontal', panel: 'price', points: [{time: 0, price: 2}]});
  api.undo();
  api.selectDrawing('keep');
  t.after(() => model.dispose());
  return {store, model, api, get notices() {return notices;}};
}

function state(f) {
  const {store: s, model: m} = f, d = m.drawings;
  return {store: s, columns: s.columns, index: s.index, version: s.version,
    timeVersion: s.timeVersion, length: s.length, capacity: s.capacity,
    columnRefs: Object.values(s.columns), columnValues: Object.values(s.columns).map(a => [...a]),
    listeners: [...s.listeners], symbol: m.symbol, priceFormatter: m.priceFormatter,
    timeFormatter: m.timeFormatter, precision: m.precision, view: m.view, follow: m.follow,
    drawings: d.items, drawingRefs: [...d.items], undo: d.undoStack, redo: d.redoStack,
    undoRows: [...d.undoStack], redoRows: [...d.redoStack], selected: d.selected,
    transaction: d.transaction, serial: d.serial, historyBytes: d.retainedHistoryBytes,
    notices: f.notices};
}

function unchanged(f, before) {
  const after = state(f);
  for (const key of ['store', 'columns', 'index', 'symbol', 'priceFormatter', 'timeFormatter',
    'view', 'drawings', 'undo', 'redo', 'transaction']) assert.equal(after[key], before[key], key);
  for (const key of ['columnRefs', 'listeners', 'drawingRefs', 'undoRows', 'redoRows'])
    after[key].forEach((value, i) => assert.equal(value, before[key][i], key + ' entry'));
  assert.deepEqual(after, before);
  assert.deepEqual(calculationJobStats(), {activeJobs: 0, reservedBytes: 0});
}

const cases = [
  ['legacy absent', {}], ['provider only', {provider: OPTIONAL.provider}],
  ['adjustment version only', {adjustmentVersion: OPTIONAL.adjustmentVersion}],
  ['both optional strings', OPTIONAL],
  ['128-character boundary', {provider: 'p'.repeat(128), adjustmentVersion: 'v'.repeat(128)}],
];
for (const [label, extra] of cases) {
  test('workspace writer preserves symbol metadata: ' + label, t => {
    const f = fixture(t, extra), before = state(f);
    const text = saveWorkspace(f.api, BINDING), doc = readWorkspaceDocument(text);
    assert.deepEqual(doc.chart.symbol, {...SYMBOL, ...extra});
    assert.deepEqual(doc.dataset, BINDING, 'symbol revision does not overwrite the independent dataset assertion');
    assert.notEqual(doc.chart.symbol, f.model.symbol);
    unchanged(f, before);
  });
  test('workspace reader accepts symbol metadata: ' + label, t => {
    const f = fixture(t), doc = JSON.parse(saveWorkspace(f.api, BINDING));
    doc.chart.symbol = {...SYMBOL, ...extra};
    const before = state(f), parsed = readWorkspaceDocument(JSON.stringify(doc));
    assert.deepEqual(parsed.chart.symbol, doc.chart.symbol);
    unchanged(f, before);
  });
}

test('workspace writer omits explicitly undefined optional symbol fields without mutating the symbol', t => {
  const f = fixture(t, {provider: undefined, adjustmentVersion: undefined}), before = state(f);
  assert.deepEqual(readWorkspaceDocument(saveWorkspace(f.api, BINDING)).chart.symbol, SYMBOL);
  assert.ok(Object.hasOwn(f.model.symbol, 'provider'));
  assert.ok(Object.hasOwn(f.model.symbol, 'adjustmentVersion'));
  unchanged(f, before);
});

test('undefined optional symbol fields do not mask accessors, unknown fields or invalid object shape', t => {
  const f = fixture(t);
  f.model.priceFormatter = null; f.model.timeFormatter = null;
  let reads = 0;
  const accessor = {...SYMBOL, provider: undefined};
  Object.defineProperty(accessor, 'adjustmentVersion', {enumerable: true, get() {reads++; return 'bad';}});
  const nonenumerable = {...SYMBOL, provider: undefined};
  Object.defineProperty(nonenumerable, 'hidden', {value: 'bad'});
  const symbolic = {...SYMBOL, provider: undefined, [Symbol('extra')]: 'bad'};
  const hiddenOptional = {...SYMBOL};
  Object.defineProperty(hiddenOptional, 'provider', {value: undefined});
  for (const symbol of [accessor, nonenumerable, symbolic, hiddenOptional,
    {...SYMBOL, provider: undefined, unknown: undefined},
    Object.assign(Object.create({custom: true}), SYMBOL, {provider: undefined})]) {
    f.model.symbol = symbol;
    const before = state(f); assert.throws(() => saveWorkspace(f.api, BINDING)); unchanged(f, before);
  }
  assert.equal(reads, 0);
});

for (const knownFormatters of [true, false]) test('actual Worker restores optional symbol metadata with ' +
  (knownFormatters ? 'symbol formatters' : 'default formatters'), async t => {
  const f = fixture(t, OPTIONAL), workers = [];
  if (!knownFormatters) {f.model.priceFormatter = null; f.model.timeFormatter = null;}
  f.model.precision = 5;
  const before = state(f), text = saveWorkspace(f.api, BINDING);
  t.after(async () => {await Promise.all(workers.map(w => w.node.terminate()));});
  const workerFactory = () => {
    const node = new Worker(new URL('./fixtures/workspace-worker-host.mjs', import.meta.url));
    const adapter = {node, threadId: node.threadId, terminations: 0, onmessage: null, onerror: null,
      postMessage(packet, transfer) {node.postMessage(packet, transfer);},
      terminate() {this.terminations++; return node.terminate();}};
    node.on('message', packet => {if (!packet?.__workspaceTestHost) adapter.onmessage?.({data: packet});});
    node.on('error', error => adapter.onerror?.(error));
    workers.push(adapter); return adapter;
  };
  const next = await prepareWorkspaceAsync(f.store, text, {datasetBinding: BINDING, workerFactory});
  try {
    assert.deepEqual(next.symbol, {...SYMBOL, ...OPTIONAL});
    assert.notEqual(next.symbol, f.model.symbol); assert.ok(Object.isFrozen(next.symbol));
    assert.equal(next.precision, 5); assert.equal(next.store, f.store);
    assert.equal(typeof next.priceFormatter === 'function', knownFormatters);
    assert.equal(typeof next.timeFormatter === 'function', knownFormatters);
    if (knownFormatters) assert.equal(next.priceFormatter(1.25), '1.25');
    assert.equal(saveWorkspace(new ChartAPI(next), BINDING), text);
    assert.equal(f.store.listeners.size, before.listeners.length + 2);
    assert.equal(workers.length, 1); assert.ok(workers[0].threadId > 0);
    assert.equal(workers[0].terminations, 1);
    assert.equal(workers[0].onmessage, null); assert.equal(workers[0].onerror, null);
  } finally {next.dispose();}
  unchanged(f, before);
});

for (const key of ['provider', 'adjustmentVersion']) {
  for (const [label, value] of [['empty', ''], ['too long', 'x'.repeat(129)], ['number', 42],
    ['null', null], ['array', []], ['object', {}], ['invalid Unicode', '\ud800']]) {
    test('workspace rejects ' + key + ' ' + label + ' before publication', async t => {
      const f = fixture(t), doc = JSON.parse(saveWorkspace(f.api, BINDING));
      doc.chart.symbol[key] = value;
      const before = state(f); let workers = 0;
      assert.throws(() => readWorkspaceDocument(JSON.stringify(doc)));
      await assert.rejects(prepareWorkspaceAsync(f.store, JSON.stringify(doc), {datasetBinding: BINDING,
        workerFactory() {workers++; throw new Error('Invalid metadata must not create a Worker');}}));
      assert.equal(workers, 0); unchanged(f, before);
      f.api.setSymbol({...SYMBOL, [key]: value});
      const invalidBefore = state(f);
      assert.throws(() => saveWorkspace(f.api, BINDING));
      unchanged(f, invalidBefore);
    });
  }
}

test('workspace optional symbol keys do not permit unknown fields or missing required fields', async t => {
  const f = fixture(t), original = JSON.parse(saveWorkspace(f.api, BINDING));
  for (const mutate of [d => {d.chart.symbol.providerExtra = 'unknown';},
    d => {delete d.chart.symbol.id;}, d => {delete d.chart.symbol.adjustment;}]) {
    const doc = structuredClone(original); mutate(doc); const before = state(f);
    assert.throws(() => readWorkspaceDocument(JSON.stringify(doc)));
    await assert.rejects(prepareWorkspaceAsync(f.store, JSON.stringify(doc), {datasetBinding: BINDING,
      workerFactory() {throw new Error('Invalid metadata must not create a Worker');}}));
    unchanged(f, before);
  }
  f.api.setSymbol({...SYMBOL, providerExtra: 'unknown'});
  const before = state(f); assert.throws(() => saveWorkspace(f.api, BINDING)); unchanged(f, before);
});

test('symbol metadata does not bypass workspace document and parser budgets', t => {
  const f = fixture(t), text = saveWorkspace(f.api, BINDING), before = state(f);
  assert.throws(() => readWorkspaceDocument(text.replace('"id":"TEST"', '"id":"TEST","provider":"a","provider":"b"')));
  const doc = JSON.parse(text); doc.chart.symbol.provider = 'x'.repeat(2097153);
  assert.throws(() => readWorkspaceDocument(JSON.stringify(doc)), /limit/);
  unchanged(f, before);
});

test('generated native VM saves and preflights optional symbol metadata', async () => {
  const context = vm.createContext({});
  vm.runInContext(await buildNativeBundle(), context);
  vm.runInContext(`nativeInit(2,{series:[]});
    globalThis.binding=${JSON.stringify(BINDING)};
    nativeAPI.setSymbol(${JSON.stringify({...SYMBOL, ...OPTIONAL})});
    globalThis.text=nativeSaveWorkspace(binding);
    globalThis.result=nativePreflightWorkspace(text,binding);`, context);
  try {
    assert.deepEqual(JSON.parse(context.text).chart.symbol, {...SYMBOL, ...OPTIONAL});
    assert.ok(context.result);
    assert.equal(vm.runInContext('nativeSaveWorkspace(binding)', context), context.text);
  } finally {context.nativeModel?.dispose();}
});
