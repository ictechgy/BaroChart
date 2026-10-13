import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {dedicatedCalculationWorkers} from './helpers/dedicated-calculation-workers.mjs';
import {assertMatchingResult, observeOperation, watchdog, withCalculationDeadline} from './helpers/calculation-deadline-fixture.mjs';

const ROOT = new URL('../',import.meta.url);
const {BarStore, ChartModel, ChartAPI, seededColumns} = await import(new URL('src/core/index.mjs', ROOT));
const {setIndicatorParamsAsync} = await import(new URL('src/web/indicator-params-async.mjs', ROOT));
const {calculationJobStats} = await import(new URL('src/web/calculation-job.mjs', ROOT));
const HOST = new URL('test/helpers/async-resample-worker-host.mjs', ROOT);
const BASELINE = {activeJobs: 0, reservedBytes: 0};
const SAMPLE = 'aster.volume-direction@1/pressure';
const isAbort = error => /abort/i.test(`${error?.name} ${error?.code}`);
const isTimeout = error => /timeout|timed.?out|deadline/i.test(`${error?.name} ${error?.code} ${error?.message}`);
const isStale = error => /stale|source.changed/i.test(`${error?.name} ${error?.code} ${error?.message}`);
const invocation = (...args) => Promise.resolve().then(() => setIndicatorParamsAsync(...args));
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }

function workers(t, hooks = {}) {
  const instances = [];
  const factory = url => {
    const node = new Worker(HOST, {workerData: {url: String(url)}});
    const exited = deferred();
    const adapter = {
      node, threadId: node.threadId, onmessage: null, onerror: null, terminateCalls: 0, posts: 0,
      exited: exited.promise, cleanupFinished: false,
      postMessage(data, transfer) {
        this.posts++;
        hooks.beforeSend?.(data, adapter);
        node.postMessage(data, transfer);
        hooks.afterSend?.(data, adapter);
      },
      terminate() {
        this.terminateCalls++;
        hooks.terminating?.(adapter);
        return node.terminate().then(async code => {
          await hooks.terminated?.(adapter);
          this.cleanupFinished = true;
          return code;
        });
      },
    };
    node.on('message', data => {
      if (data?.__asterTestHost === 'dispatch') { hooks.processing?.(adapter); return; }
      hooks.beforeReceive?.(data, adapter);
      if (hooks.shouldDeliver?.(data, adapter) !== false) adapter.onmessage?.({data});
      hooks.afterReceive?.(data, adapter);
    });
    node.on('error', error => adapter.onerror?.(error));
    node.on('exit', code => exited.resolve(code));
    instances.push(adapter);
    hooks.created?.(adapter);
    return adapter;
  };
  t.after(async () => { await Promise.all(instances.map(x => x.node.terminate())); });
  return {
    factory, instances,
    async clean() {
      await Promise.all(instances.map(x => x.exited));
      assert.deepEqual(calculationJobStats(), BASELINE);
      for (const instance of instances) {
        assert.ok(instance.threadId > 0, 'actual separate worker thread');
        assert.equal(instance.terminateCalls, 1, 'one dedicated worker termination');
        assert.equal(instance.onmessage, null, 'message listener detached');
        assert.equal(instance.onerror, null, 'error listener detached');
      }
    },
  };
}

function fixture(t, {n = 550, name = 'ema', params = {period: 5}, extra = true} = {}) {
  const store = new BarStore();
  store.setColumns(seededColumns(n, 73));
  const model = new ChartModel({store, axes: [{id: 'study-axis', panel: 'price', side: 'left'}]});
  model.indicators.add('target', name, params);
  const outputs = model.indicators.get('target').outputs;
  Object.keys(outputs).forEach((output, index) => model.addSeries({id: 'target-' + index, type: 'line', panel: 'price', axisId: 'study-axis', indicator: 'target', output, color: '#f783ac', width: 2}));
  if (extra) {
    model.indicators.add('other', 'sma', {period: 3});
    model.addSeries({id: 'other-series', type: 'line', panel: 'price', indicator: 'other', color: '#aabbcc'});
    model.addSeries({id: 'prices', type: 'candles', panel: 'price'});
    model.drawings.add({type: 'text', panel: 'price', points: [{time: n ? store.at(0).time : 0, price: 10}], text: 'keep this drawing'});
  }
  for (const series of model.series) if (series.type === 'line') model.seriesData(series);
  let notifications = 0;
  const api = new ChartAPI(model, {invalidate() {notifications++;}});
  t.after(() => model.dispose());
  return {model, store, api, get notifications() {return notifications;}};
}

function outputValues(model, id = 'target') {
  return Object.fromEntries(Object.entries(model.indicators.get(id).outputs).map(([key, array]) => [key, [...array]]));
}
function fullOracle(source, name, params) {
  const store = new BarStore(); store.setColumns(source.store.columns, source.store.length);
  const model = new ChartModel({store});
  try { model.indicators.add('target', name, params); return outputValues(model); }
  finally { model.dispose(); }
}
function hold(model) {
  const engine = model.indicators;
  return {
    store: model.store, columns: model.store.columns, version: model.store.version,
    capacity: model.store.capacity, index: model.store.index,
    columnSnapshots: Object.entries(model.store.columns).map(([key, array]) => ({key, array, buffer: array.buffer, values: [...array]})),
    engine, entries: engine.entries, registry: engine.registry, target: engine.entries.get('target'),
    others: [...engine.entries].filter(([id]) => id !== 'target'),
    oldOutputs: engine.entries.get('target').arrays.map(array => ({array, buffer: array.buffer, values: [...array]})),
    series: model.series, seriesObjects: [...model.series],
    seriesRecords: model.series.map(series => ({...series})),
    rangeIndices: model.series.map(series => series.rangeIndex),
    rangeSnapshots: model.series.map(series => series.rangeIndex ? {min: [...series.rangeIndex.min], max: [...series.rangeIndex.max], sum: series.rangeIndex.sum ? [...series.rangeIndex.sum] : null} : null),
    panels: model.panels, panelObjects: [...model.panels], axes: model.axes, axisObjects: [...model.axes],
    drawings: model.drawings, drawingItems: model.drawings.items, drawingObjects: [...model.drawings.items],
    drawingJSON: JSON.stringify(model.drawings.items), theme: model.theme, view: model.view,
  };
}
function assertHeldOutputs(before) {
  for (const {array, buffer, values} of before.oldOutputs) {
    assert.equal(array.buffer, buffer);
    assert.equal(buffer.byteLength, values.length * 8, 'held output buffer remains attached');
    assert.deepEqual([...array], values, 'held old output is not overwritten');
  }
  before.rangeIndices.forEach((index, i) => {
    if (!index) return;
    assert.deepEqual([...index.min], before.rangeSnapshots[i].min, 'held min index is immutable');
    assert.deepEqual([...index.max], before.rangeSnapshots[i].max, 'held max index is immutable');
    if (index.sum) assert.deepEqual([...index.sum], before.rangeSnapshots[i].sum, 'held sum index is immutable');
  });
}
function assertPublishedOnlyTarget(model, before) {
  assert.equal(model.store, before.store); assert.equal(model.store.columns, before.columns);
  assert.equal(model.store.version, before.version); assert.equal(model.store.capacity, before.capacity);
  assert.equal(model.store.index, before.index);
  for (const {key, array, buffer, values} of before.columnSnapshots) {
    assert.equal(model.store.columns[key], array); assert.equal(array.buffer, buffer);
    assert.deepEqual([...array], values, key + ' caller source remains unchanged');
  }
  assert.equal(model.indicators, before.engine); assert.equal(model.indicators.entries, before.entries);
  assert.equal(model.indicators.registry, before.registry);
  assert.notEqual(model.indicators.entries.get('target'), before.target);
  for (const [id, entry] of before.others) assert.equal(model.indicators.entries.get(id), entry);
  assert.equal(model.series, before.series);
  model.series.forEach((series, i) => {
    assert.equal(series, before.seriesObjects[i]);
    for (const [key, value] of Object.entries(before.seriesRecords[i])) {
      if (series.indicator === 'target' && ['rangeIndex', 'revision', 'dirtyFrom'].includes(key)) continue;
      assert.equal(series[key], value, 'series ' + series.id + ' ' + key);
    }
    if (series.indicator === 'target') { assert.equal(series.rangeIndex, null); assert.equal(series.revision, undefined); assert.equal(series.dirtyFrom, 0); }
  });
  for (const key of ['panels', 'axes', 'drawings', 'theme', 'view']) assert.equal(model[key], before[key]);
  model.panels.forEach((value, i) => assert.equal(value, before.panelObjects[i]));
  model.axes.forEach((value, i) => assert.equal(value, before.axisObjects[i]));
  assert.equal(model.drawings.items, before.drawingItems);
  model.drawings.items.forEach((value, i) => assert.equal(value, before.drawingObjects[i]));
  assert.equal(JSON.stringify(model.drawings.items), before.drawingJSON);
  assertHeldOutputs(before);
}
function assertUnpublished(f, before) {
  assert.equal(f.model.indicators.entries.get('target'), before.target, 'failed operation did not replace target');
  assert.equal(f.notifications, 0, 'precommit failure does not notify');
  assertHeldOutputs(before);
}
function trackedSignal(controller, onDetach) {
  const signal = controller.signal, listeners = new Set();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {if (type === 'abort') listeners.add(listener); return add(type, listener, options);};
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') {listeners.delete(listener); onDetach?.();}
    return remove(type, listener, options);
  };
  return {signal, listeners};
}

test('public root and worker entries reexport the same async parameter function', async () => {
  const root = await import(new URL('src/index.mjs', ROOT));
  const worker = await import(new URL('src/web/worker.mjs', ROOT));
  assert.equal(root.setIndicatorParamsAsync, setIndicatorParamsAsync);
  assert.equal(worker.setIndicatorParamsAsync, setIndicatorParamsAsync);
});

test('preabort avoids chart and params properties, factory, progress and observer callbacks', async () => {
  const controller = new AbortController(); controller.abort();
  let reads = 0, calls = 0;
  const hostile = new Proxy({}, {get() {reads++; throw new Error('unexpected property read');}, ownKeys() {reads++; throw new Error('unexpected reflection');}});
  await assert.rejects(invocation(hostile, 'target', hostile, {
    signal: controller.signal,
    workerFactory() {calls++; throw new Error('unexpected worker');},
    onProgress() {calls++;}, onObserverError() {calls++;},
  }), isAbort);
  assert.equal(reads, 0); assert.equal(calls, 0); assert.deepEqual(calculationJobStats(), BASELINE);
});

test('real-worker EMA, multioutput MACD and linked module match synchronous replacement', async t => {
  for (const spec of [
    {name: 'ema', params: {period: 5}, next: {period: 17}},
    {name: 'macd', params: {fast: 5, slow: 15, signal: 3}, next: {fast: 9, slow: 21, signal: 5}},
    {name: SAMPLE, params: {factor: .5, shift: -2}, next: {factor: .75, shift: -2}},
  ]) await t.test(spec.name, async t => {
    const f = fixture(t, spec), oracle = fixture(t, spec), w = workers(t), before = hold(f.model);
    const expected = oracle.api.setIndicatorParams('target', spec.next);
    const result = await setIndicatorParamsAsync(f.api, 'target', spec.next, {workerFactory: w.factory});
    assert.deepEqual(result, expected);
    assertPublishedOnlyTarget(f.model, before);
    assert.deepEqual(outputValues(f.model), outputValues(oracle.model));
    assert.equal(f.notifications, 1); assert.equal(w.instances.length, 1);
    assert.deepEqual(f.model.indicators.entries.get('target').params, spec.next);
    await w.clean();
  });
});

test('published lazy checkpoints remain correct through append, last update and historical correction', async t => {
  for (const spec of [
    {name: 'ema', params: {period: 5}, next: {period: 17}},
    {name: 'macd', params: {fast: 5, slow: 15, signal: 3}, next: {fast: 9, slow: 21, signal: 5}},
    {name: SAMPLE, params: {factor: .5, shift: -2}, next: {factor: .75, shift: -2}},
  ]) await t.test(spec.name, async t => {
    const f = fixture(t, spec), w = workers(t);
    await setIndicatorParamsAsync(f.api, 'target', spec.next, {workerFactory: w.factory});
    await w.clean();
    assert.deepEqual(outputValues(f.model), fullOracle(f, spec.name, spec.next), 'initial full recalculation oracle');
    const last = f.store.at(f.store.length - 1);
    f.store.append({...last, time: last.time + 60000, open: last.close, high: last.close + 4, low: last.close - 4, close: last.close + 1, volume: 987});
    assert.deepEqual(outputValues(f.model), fullOracle(f, spec.name, spec.next), 'append full recalculation oracle');
    const tail = f.store.at(f.store.length - 1);
    f.store.update(f.store.length - 1, {...tail, close: tail.close - .5, volume: 4321});
    assert.deepEqual(outputValues(f.model), fullOracle(f, spec.name, spec.next), 'last update full recalculation oracle');
    const old = f.store.at(257);
    f.store.update(257, {...old, high: old.high + 5, low: old.low - 5, close: old.close + 2, volume: 8888});
    assert.deepEqual(outputValues(f.model), fullOracle(f, spec.name, spec.next), 'historical correction restores correct checkpoint');
  });
});

test('replacement works at the 128-indicator cap without a temporary extra live entry', async t => {
  const f = fixture(t, {n: 16, extra: false}), w = workers(t);
  for (let i = 1; i < 128; i++) f.model.indicators.add('extra-' + i, 'ema', {period: 2});
  const entries = [...f.model.indicators.entries], map = f.model.indicators.entries;
  await setIndicatorParamsAsync(f.api, 'target', {period: 7}, {workerFactory: w.factory});
  assert.equal(f.model.indicators.entries, map); assert.equal(map.size, 128);
  for (const [id, entry] of entries.slice(1)) assert.equal(map.get(id), entry);
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 7}));
  await w.clean();
});

test('Object.is semantic no-op avoids Worker and preserves target/cache identities while notifying once', async t => {
  const f = fixture(t, {params: {period: 5, marker: -0}}), before = hold(f.model);
  let count = 0;
  const result = await setIndicatorParamsAsync(f.api, 'target', {marker: -0, period: 5}, {workerFactory() {count++; throw new Error('no-op started worker');}});
  assert.deepEqual(result, {outputs: ['value'], plotOffsets: {}});
  assert.equal(count, 0); assert.equal(f.model.indicators.entries.get('target'), before.target);
  f.model.series.forEach((series, i) => assert.equal(series.rangeIndex, before.rangeIndices[i]));
  assert.equal(f.notifications, 1); assertHeldOutputs(before); assert.deepEqual(calculationJobStats(), BASELINE);
});

test('negative zero differs from positive zero and caller params are copied', async t => {
  const f = fixture(t, {params: {period: 5, marker: 0}}), w = workers(t), before = hold(f.model);
  const requested = {period: 5, marker: -0};
  await setIndicatorParamsAsync(f.api, 'target', requested, {workerFactory: w.factory});
  assert.equal(w.instances.length, 1); assert.notEqual(f.model.indicators.entries.get('target'), before.target);
  assert.equal(Object.is(f.model.indicators.entries.get('target').params.marker, -0), true);
  assert.notEqual(f.model.indicators.entries.get('target').params, requested);
  requested.period = 90; assert.equal(f.model.indicators.entries.get('target').params.period, 5);
  assertHeldOutputs(before); await w.clean();
});

test('empty, checkpoint-grid and capacity-edge fixtures preserve metadata and can append after publication', async t => {
  for (const n of [0, 1, 255, 256, 257, 512]) await t.test(String(n), async t => {
    const f = fixture(t, {n, extra: false}), w = workers(t), before = hold(f.model);
    await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {workerFactory: w.factory});
    assertPublishedOnlyTarget(f.model, before);
    assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 8}));
    const last = n ? f.store.at(n - 1) : {time: Date.UTC(2026, 0, 1), open: 100, high: 103, low: 97, close: 101, volume: 1};
    f.store.append({...last, time: last.time + 60000});
    assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 8}), 'append restores checkpoint after boundary');
    await w.clean();
  });
});

test('abort after the first full snapshot chunk stops before worker creation', async t => {
  const f = fixture(t, {n: 16385, extra: false}), before = hold(f.model), controller = new AbortController(), w = workers(t); let reached = false;
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
    signal: controller.signal, workerFactory: w.factory,
    onProgress(progress) {if (progress.phase === 'snapshot' && progress.done === 16384) {reached = true; controller.abort();}},
  }), isAbort);
  assert.equal(reached, true); assert.equal(w.instances.length, 0); assertUnpublished(f, before); await w.clean();
});

test('abort midway through owner validation preserves held outputs and source identities', async t => {
  const f = fixture(t, {n: 16385, extra: false}), before = hold(f.model), controller = new AbortController(), w = workers(t); let reached = false;
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
    signal: controller.signal, workerFactory: w.factory,
    onProgress(progress) {if (progress.phase === 'validate' && progress.done >= 16384) {reached = true; controller.abort();}},
  }), isAbort);
  assert.equal(reached, true); assertUnpublished(f, before);
  assert.equal(f.store.columns, before.columns); assert.equal(f.store.index, before.index); assert.equal(f.store.version, before.version);
  await w.clean();
});

test('same model/id is Busy across different API facades, cancellation settlement enables the next request', async t => {
  const f = fixture(t), controller = new AbortController(), posted = deferred();
  const first = workers(t, {afterSend() {posted.resolve();}, shouldDeliver() {return false;}}), before = hold(f.model);
  const pending = setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: controller.signal, workerFactory: first.factory});
  await posted.promise;
  let secondFactory = 0;
  await assert.rejects(invocation(new ChartAPI(f.model), 'target', {period: 12}, {workerFactory() {secondFactory++; throw new Error('busy started worker');}}), error => error.name === 'BusyError');
  assert.equal(secondFactory, 0); assert.equal(f.model.indicators.entries.get('target'), before.target);
  controller.abort(); await assert.rejects(pending, isAbort); await first.clean();
  assertUnpublished(f, before);
  const next = workers(t);
  await setIndicatorParamsAsync(f.api, 'target', {period: 12}, {workerFactory: next.factory});
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 12})); await next.clean();
});

test('progress callback throws are isolated, but reentrant cancellation still rejects before publication', async t => {
  const f = fixture(t), w = workers(t); let calls = 0;
  await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {workerFactory: w.factory, onProgress() {calls++; throw new Error('host progress exception');}});
  assert.ok(calls > 0); assert.equal(f.notifications, 1); await w.clean();
  const cancelled = fixture(t), controller = new AbortController(), cancelledWorkers = workers(t), before = hold(cancelled.model);
  await assert.rejects(setIndicatorParamsAsync(cancelled.api, 'target', {period: 8}, {
    signal: controller.signal, workerFactory: cancelledWorkers.factory,
    onProgress() {controller.abort(); throw new Error('progress throw after abort');},
  }), isAbort);
  assertUnpublished(cancelled, before); await cancelledWorkers.clean();
});

for (const phase of ['snapshot', 'compute', 'validate']) {
  test(`abort from ${phase} progress prevents publication`, async t => {
    const f = fixture(t), controller = new AbortController(), w = workers(t), before = hold(f.model); let reached = false;
    await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
      signal: controller.signal, workerFactory: w.factory,
      onProgress(progress) {if (progress.phase === phase) {reached = true; controller.abort();}},
    }), isAbort);
    assert.equal(reached, true); assertUnpublished(f, before); await w.clean();
  });
  test(`managed source mutation from ${phase} progress rejects stale before publication`, async t => {
    const f = fixture(t), w = workers(t), before = hold(f.model); let reached = false;
    await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
      workerFactory: w.factory,
      onProgress(progress) {
        if (progress.phase !== phase || reached) return;
        reached = true; const old = f.store.at(0); f.store.update(0, {...old, volume: old.volume + 1});
      },
    }), isStale);
    assert.equal(reached, true); assertUnpublished(f, before); await w.clean();
  });
  test(`total deadline is rechecked after the ${phase} progress callback returns`, async t => {
    const f = fixture(t), controller = new AbortController(), before = hold(f.model); let reached = false, request, packet;
    const w = dedicatedCalculationWorkers(t, {beforeSend(data) {request = data;}, beforeReceive(data) {packet = data;}});
    if (phase === 'validate') await w.prepare(new URL('../src/web/indicator-params-worker.mjs', import.meta.url));
    await withCalculationDeadline(700, async clock => {
      const operation = observeOperation(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
        signal: controller.signal, workerFactory: w.factory, timeoutMs: 700,
        onProgress(progress) {
          if (progress.phase !== phase || reached) return;
          reached = true;
          clock.advanceTo(700); // No timer callback: the owner must check on return.
        },
      }));
      try {
        const result = await watchdog(operation.outcome, `${phase} callback deadline cleanup`);
        assert.equal(result.error?.name, 'TimeoutError');
        assert.equal(reached, true);
        assert.equal(w.instances.length, phase === 'validate' ? 1 : 0);
        if (phase === 'validate') assertMatchingResult(packet, request, 'aster.params-result');
        assertUnpublished(f, before); await w.clean();
      } finally {
        controller.abort();
        await watchdog(operation.outcome, `${phase} callback failure cleanup`);
      }
    });
  });
}

test('abort after actual Worker dispatch prevents publication and releases ownership', async t => {
  const f = fixture(t), controller = new AbortController(), before = hold(f.model); let dispatched = false;
  const w = workers(t, {processing() {dispatched = true; controller.abort();}});
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: controller.signal, workerFactory: w.factory}), isAbort);
  assert.equal(dispatched, true); assertUnpublished(f, before); await w.clean();
});

test('last progress callbacks remain cancellable after snapshot, Worker result and complete validation', async t => {
  for (const phase of ['snapshot', 'compute', 'validate']) await t.test(phase, async t => {
    const f = fixture(t), before = hold(f.model), controller = new AbortController(), w = workers(t); let reached = false;
    await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
      signal: controller.signal, workerFactory: w.factory,
      onProgress(progress) {if (progress.phase === phase && progress.done === progress.total) {reached = true; controller.abort();}},
    }), isAbort);
    assert.equal(reached, true, 'final ' + phase + ' callback reached');
    assertUnpublished(f, before); await w.clean();
  });
});

test('guarded configuration, registry and other-entry changes during validation reject stale', async t => {
  for (const kind of ['axis', 'series-style', 'registry', 'other-entry']) await t.test(kind, async t => {
    const f = fixture(t), before = hold(f.model), w = workers(t); let changed = false;
    await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
      workerFactory: w.factory,
      onProgress(progress) {
        if (progress.phase !== 'validate' || changed) return;
        changed = true;
        if (kind === 'axis') f.model.setAxis('study-axis', {width: 91});
        if (kind === 'series-style') f.model.series[0].color = '#ffffff';
        if (kind === 'registry') f.model.indicators.registry.set('ema', f.model.indicators.registry.get('ema').bind(null));
        if (kind === 'other-entry') f.model.indicators.add('new-entry', 'sma', {period: 3});
      },
    }), isStale);
    assert.equal(changed, true); assertUnpublished(f, before); await w.clean();
  });
});

test('changed module offsets reject before worker creation without touching live bindings', async t => {
  const f = fixture(t, {name: SAMPLE, params: {factor: .5, shift: -2}}), before = hold(f.model), w = workers(t);
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {factor: .75, shift: 3}, {workerFactory: w.factory}), /offset|schema/i);
  assert.equal(w.instances.length, 0); assertUnpublished(f, before);
  assert.deepEqual(f.model.series.filter(series => series.indicator === 'target').map(series => series.offset), [-2, -2]);
  await w.clean();
});

test('metadata accessor failure stays before publication and notifies nobody', async t => {
  const f = fixture(t), before = hold(f.model), w = workers(t); let reads = 0;
  Object.defineProperty(before.target.def, 'plotOffsets', {configurable: true, get() {reads++; throw new Error('metadata staging failed');}});
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {workerFactory: w.factory}), /metadata staging failed|data|accessor/i);
  assert.equal(f.model.indicators.entries.get('target'), before.target); assert.equal(f.notifications, 0);
  assert.ok(reads <= 1); assert.equal(w.instances.length, 0); assertHeldOutputs(before); await w.clean();
});

for (const mode of ['abort', 'stale', 'timeout', 'throw']) {
  test(`${mode} during awaited Worker termination prevents a validated result from committing`, async t => {
    const timeoutMs = mode === 'timeout' ? 600 : 5000;
    await withCalculationDeadline(timeoutMs, async clock => {
      const f = fixture(t), controller = new AbortController(), before = hold(f.model), cleanupError = new Error('Worker cleanup failed'); let reached = false, validated = false, request, packet;
      const hooks = {
        beforeSend(data) {request = data;}, beforeReceive(data) {packet = data;},
        async terminated() {
          reached = true;
          assertMatchingResult(packet, request, 'aster.params-result');
          assert.equal(validated, true, 'complete result validation precedes Worker cleanup');
          assert.equal(f.model.indicators.entries.get('target'), before.target, 'target still original inside worker cleanup');
          assert.equal(f.notifications, 0);
          if (mode === 'abort') controller.abort();
          if (mode === 'stale') {const old = f.store.at(0); f.store.update(0, {...old, volume: old.volume + 1});}
          if (mode === 'timeout') clock.expire();
          if (mode === 'throw') throw cleanupError;
        },
      };
      const w = dedicatedCalculationWorkers(t, hooks);
      await w.prepare(new URL('../src/web/indicator-params-worker.mjs', import.meta.url));
      const operation = observeOperation(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
        signal: controller.signal, workerFactory: w.factory, timeoutMs,
        onProgress(progress) {if (progress.phase === 'validate' && progress.done === progress.total) validated = true;},
      }));
      try {
        const result = await watchdog(operation.outcome, `${mode} after validated result`);
        if (mode === 'throw') assert.equal(result.error, cleanupError);
        else assert.equal(result.error?.name, {abort: 'AbortError', stale: 'StaleSourceError', timeout: 'TimeoutError'}[mode]);
        assertMatchingResult(packet, request, 'aster.params-result');
        assert.equal(validated, true); assert.equal(reached, true); assertUnpublished(f, before); await w.clean();
      } finally {
        controller.abort();
        await watchdog(operation.outcome, `${mode} termination failure cleanup`);
      }
    });
  });
}

test('listener-detach reentry is checked before final commit', async t => {
  const f = fixture(t), before = hold(f.model), controller = new AbortController(), w = workers(t); let detached = false;
  const tracked = trackedSignal(controller, () => {if (!detached) {detached = true; const old = f.store.at(0); f.store.update(0, {...old, volume: old.volume + 1});}});
  await assert.rejects(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: tracked.signal, workerFactory: w.factory}), isStale);
  assert.equal(detached, true); assert.equal(tracked.listeners.size, 0); assertUnpublished(f, before); await w.clean();
});

test('publication follows worker termination and listener detach; notification follows budget release', async t => {
  const f = fixture(t), before = hold(f.model), controller = new AbortController(), tracked = trackedSignal(controller), w = workers(t);
  let notifications = 0, observed;
  f.api.invalidate = () => {
    notifications++;
    observed = {entry: f.model.indicators.entries.get('target'), listeners: tracked.listeners.size, stats: calculationJobStats(), cleaned: w.instances.every(worker => worker.cleanupFinished), handlers: w.instances.map(worker => [worker.onmessage, worker.onerror])};
    controller.abort();
  };
  const result = await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: tracked.signal, workerFactory: w.factory});
  assert.deepEqual(result, {outputs: ['value'], plotOffsets: {}});
  assert.equal(notifications, 1); assert.notEqual(observed.entry, before.target);
  assert.equal(observed.listeners, 0); assert.deepEqual(observed.stats, BASELINE); assert.equal(observed.cleaned, true);
  assert.deepEqual(observed.handlers, [[null, null]]); assert.equal(controller.signal.aborted, true);
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 8})); await w.clean();
});

test('committed invalidation errors resolve with a bounded diagnostic and are reported once', async t => {
  const f = fixture(t), controller = new AbortController(), w = workers(t); let notifications = 0, reports = 0, reported;
  const error = new Error('observer failure '.repeat(10000)); error.name = 'ObserverHostError';
  f.api.invalidate = () => {notifications++; controller.abort(); throw error;};
  const result = await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {
    signal: controller.signal, workerFactory: w.factory,
    onObserverError(diagnostic) {reports++; reported = diagnostic; throw new Error('error reporter failure');},
  });
  assert.equal(notifications, 1); assert.equal(reports, 1);
  assert.deepEqual(Object.keys(result).sort(), ['observerError', 'outputs', 'plotOffsets']);
  assert.deepEqual(Object.keys(result.observerError).sort(), ['message', 'name']);
  assert.equal(result.observerError.name, 'ObserverHostError');
  assert.equal(typeof result.observerError.message, 'string'); assert.ok(result.observerError.message.length > 0);
  assert.ok(result.observerError.name.length <= 64); assert.ok(result.observerError.message.length <= 256, 'observer diagnostic is bounded');
  assert.deepEqual(reported, result.observerError);
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 8})); await w.clean();
});

test('observer diagnostics never invoke thrown-object name/message accessors', async t => {
  const f = fixture(t), w = workers(t); let reads = 0, reports = 0;
  const thrown = Object.create(null);
  for (const key of ['name', 'message']) Object.defineProperty(thrown, key, {get() {reads++; throw new Error('do not inspect accessor');}});
  f.api.invalidate = () => {throw thrown;};
  const result = await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {workerFactory: w.factory, onObserverError() {reports++;}});
  assert.equal(reads, 0); assert.equal(reports, 1);
  assert.equal(typeof result.observerError.name, 'string'); assert.equal(typeof result.observerError.message, 'string');
  assert.ok(result.observerError.name.length <= 64); assert.ok(result.observerError.message.length <= 256);
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 8})); await w.clean();
});

test('semantic no-op observer errors use the same resolved diagnostic contract', async t => {
  const f = fixture(t), before = hold(f.model); let factories = 0, notifications = 0, reports = 0;
  f.api.invalidate = () => {notifications++; throw new Error('no-op observer failure');};
  const result = await setIndicatorParamsAsync(f.api, 'target', {period: 5}, {workerFactory() {factories++; throw new Error('no-op worker');}, onObserverError() {reports++;}});
  assert.equal(factories, 0); assert.equal(notifications, 1); assert.equal(reports, 1);
  assert.equal(result.observerError.message, 'no-op observer failure');
  assert.equal(f.model.indicators.entries.get('target'), before.target); assertHeldOutputs(before); assert.deepEqual(calculationJobStats(), BASELINE);
});

test('notification can start another same-target operation after release without BusyError', async t => {
  const f = fixture(t), w = workers(t); let notifications = 0, subsequent;
  f.api.invalidate = () => {
    notifications++;
    if (notifications === 1) subsequent = setIndicatorParamsAsync(f.api, 'target', {period: 12}, {workerFactory: w.factory});
  };
  await setIndicatorParamsAsync(f.api, 'target', {period: 8}, {workerFactory: w.factory});
  assert.ok(subsequent); await subsequent;
  assert.equal(notifications, 2); assert.equal(w.instances.length, 2);
  assert.deepEqual(outputValues(f.model), fullOracle(f, 'ema', {period: 12})); await w.clean();
});

test('withheld computed parameter response rejects when its original deadline fires', async t => {
  const f = fixture(t), before = hold(f.model), controller = new AbortController(), tracked = trackedSignal(controller), received = deferred();
  const w = dedicatedCalculationWorkers(t, {beforeReceive(packet, adapter) {received.resolve({packet, request: adapter.request});}, shouldDeliver() {return false;}});
  await w.prepare(new URL('../src/web/indicator-params-worker.mjs', import.meta.url));
  await withCalculationDeadline(600, async clock => {
    const operation = observeOperation(setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: tracked.signal, workerFactory: w.factory, timeoutMs: 600}));
    try {
      const {packet, request} = await operation.beforeSettlement(received.promise, 'computed parameter response');
      assertMatchingResult(packet, request, 'aster.params-result');
      assert.equal(packet.result.computedUntil, f.store.length);
      assert.equal(operation.settled, false, 'computed reply is withheld from the owner');
      clock.expire();
      const result = await watchdog(operation.outcome, 'parameter timeout cleanup');
      assert.equal(result.error?.name, 'TimeoutError');
      assert.equal(w.instances.length, 1); assert.equal(w.instances[0].posts, 1);
      assert.equal(tracked.listeners.size, 0); assertUnpublished(f, before); await w.clean();
    } finally {
      controller.abort();
      await watchdog(operation.outcome, 'parameter failure cleanup');
    }
  });
});

test('repeated success and cancellation return Workers and logical resources to baseline', async t => {
  for (let iteration = 0; iteration < 4; iteration++) {
    const f = fixture(t, {n: 64}), controller = new AbortController(), tracked = trackedSignal(controller);
    const w = workers(t, iteration % 2 ? {afterSend() {controller.abort();}} : {});
    const pending = setIndicatorParamsAsync(f.api, 'target', {period: 8}, {signal: tracked.signal, workerFactory: w.factory});
    if (iteration % 2) await assert.rejects(pending, isAbort); else await pending;
    assert.equal(tracked.listeners.size, 0); await w.clean();
  }
  await delay(5); assert.deepEqual(calculationJobStats(), BASELINE);
});
