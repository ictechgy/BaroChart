import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, ChartAPI} from '../src/core/index.mjs';

const fields = ['time', 'open', 'high', 'low', 'close', 'volume'];
const bar = (time, close = time, volume = 1) => ({time, open: close, high: close, low: close, close, volume});
const event = (kind, time, close = time, volume = 1) => ({kind, bar: bar(time, close, volume)});
const compactOptions = (keepLastBars, extra = {}) => ({keepLastBars, studyHistory: 'restart', pendingData: 'preserve-retained', ...extra});
function fixture(t, {length = 12, timeStep = 1, policy = {}} = {}) {
  const model = new ChartModel({store: new BarStore(Array.from({length}, (_, i) => bar((i + 1) * timeStep)))});
  let invalidations = 0;
  const api = new ChartAPI(model, {invalidate: () => invalidations++});
  api.configureDataIngestion({streamId: 'pending', generation: 4, firstSequence: 20, ...policy});
  t.after(() => model.dispose());
  return {model, api, queue: model.dataIngestion, invalidations: () => invalidations};
}
function enqueue(f, events) {
  return f.api.enqueueDataEvents({streamId: 'pending', generation: 4, firstSequence: f.queue.nextSequence, events});
}
const bytes = array => Buffer.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
function queueSnapshot(queue) {
  return {
    descriptors: Object.getOwnPropertyDescriptors(queue),
    columns: Object.fromEntries(fields.map(key => [key, {array: queue.columns[key], buffer: queue.columns[key].buffer, bytes: bytes(queue.columns[key])}])),
    kinds: {array: queue.kinds, buffer: queue.kinds.buffer, bytes: bytes(queue.kinds)},
    counters: {...queue.counters}, policy: {...queue.policy}, lastError: queue.lastError && {...queue.lastError},
  };
}
function assertQueueUnchanged(queue, before, {sourceVersion, epoch} = {}) {
  const descriptors = Object.getOwnPropertyDescriptors(queue);
  for (const [key, descriptor] of Object.entries(before.descriptors)) {
    if (key === 'sourceVersion' && sourceVersion !== undefined) assert.equal(descriptors[key].value, sourceVersion);
    else if (key === 'epoch' && epoch !== undefined) assert.equal(descriptors[key].value, epoch);
    else {
      assert.equal(descriptors[key].value, descriptor.value, `queue ${key} identity/value`);
      assert.deepEqual(descriptors[key], descriptor, `queue ${key} descriptor`);
    }
  }
  assert.deepEqual(Reflect.ownKeys(descriptors), Reflect.ownKeys(before.descriptors));
  for (const key of fields) {
    assert.equal(queue.columns[key], before.columns[key].array, `${key} column identity`);
    assert.equal(queue.columns[key].buffer, before.columns[key].buffer, `${key} buffer identity`);
    assert.deepEqual(bytes(queue.columns[key]), before.columns[key].bytes, `${key} full physical ring bytes`);
  }
  assert.equal(queue.kinds, before.kinds.array);
  assert.equal(queue.kinds.buffer, before.kinds.buffer);
  assert.deepEqual(bytes(queue.kinds), before.kinds.bytes);
  assert.deepEqual(queue.counters, before.counters);
  assert.deepEqual(queue.policy, before.policy);
  assert.deepEqual(queue.lastError, before.lastError);
}
function sourceSnapshot(f) {
  const {model} = f, store = model.store;
  return {
    store, columns: store.columns, index: store.index, length: store.length, capacity: store.capacity,
    version: store.version, timeVersion: store.timeVersion, view: model.view, crosshair: model.crosshair,
    bytes: Object.fromEntries(fields.map(key => [key, bytes(store.columns[key])])), invalidations: f.invalidations(),
  };
}
function assertSourceUnchanged(f, before) {
  const after = sourceSnapshot(f);
  for (const key of ['store', 'columns', 'index', 'length', 'capacity', 'version', 'timeVersion', 'view', 'crosshair', 'invalidations']) assert.equal(after[key], before[key], key);
  assert.deepEqual(after.bytes, before.bytes);
}
function rejectUnchanged(f, options = compactOptions(4), pattern) {
  const queue = queueSnapshot(f.queue), source = sourceSnapshot(f);
  assert.throws(() => f.api.compactData(options), pattern);
  assertQueueUnchanged(f.queue, queue);
  assertSourceUnchanged(f, source);
}

test('preserve-retained keeps wrapped FIFO storage and signed-zero bytes, then drains mixed dependencies', t => {
  const f = fixture(t, {policy: {maxQueuedEvents: 8, maxBatchEvents: 8}});
  enqueue(f, [...Array.from({length: 5}, (_, i) => event('update', 12, 20 + i)), event('correction', 9, -0, -0)]);
  assert.equal(f.api.drainDataEvents(5).events, 5);
  enqueue(f, [event('append', 13, -0, -0), event('update', 13, 0, 0), event('correction', 9, 23), event('correction', 13, -0, -0), event('append', 14)]);
  assert.equal(f.queue.head, 5);
  assert.equal(f.queue.count, 6);
  f.api.pauseDataIngestion();
  const before = queueSnapshot(f.queue), oldEpoch = f.queue.epoch;
  const receipt = f.api.compactData(compactOptions(4));
  assert.equal(receipt.removed, 8);
  assert.equal(f.model.dataIngestion, f.queue);
  assertQueueUnchanged(f.queue, before, {sourceVersion: receipt.version, epoch: oldEpoch + 1});
  f.api.resumeDataIngestion();
  assert.equal(f.api.drainDataEvents().events, 6);
  assert.deepEqual(Array.from(f.model.store.columns.time.subarray(0, f.model.store.length)), [9, 10, 11, 12, 13, 14]);
  assert.equal(f.model.store.at(0).close, 23);
  assert.ok(Object.is(f.model.store.at(4).close, -0));
  assert.ok(Object.is(f.model.store.at(4).volume, -0));
  assert.equal(f.queue.counters.accepted, f.queue.counters.applied);
  assert.equal(f.queue.firstPendingSequence, f.queue.nextSequence);
});

for (const pendingData of [undefined, 'reject']) {
  test(`pending compaction still rejects in ${pendingData ?? 'default'} mode`, t => {
    const f = fixture(t);
    enqueue(f, [event('append', 13)]);
    f.api.pauseDataIngestion();
    const options = {keepLastBars: 4, studyHistory: 'restart'};
    if (pendingData !== undefined) options.pendingData = pendingData;
    rejectUnchanged(f, options);
  });
}

for (const pendingData of [null, false, 0, '', 'preserve', 'PRESERVE-RETAINED', {}]) {
  test(`invalid pendingData ${JSON.stringify(pendingData)} rejects even a no-op`, t => {
    const f = fixture(t);
    rejectUnchanged(f, compactOptions(12, {pendingData}));
  });
}

test('pendingData accessor is rejected without being invoked on trim or no-op', t => {
  const f = fixture(t);
  let reads = 0;
  for (const keepLastBars of [4, 12]) {
    rejectUnchanged(f, {keepLastBars, studyHistory: 'restart', get pendingData() { reads++; return 'preserve-retained'; }});
    assert.equal(reads, 0);
  }
});

for (const state of ['running', 'draining', 'leased']) {
  test(`real preservation rejects ${state} queue without changing source or ledger`, t => {
    const f = fixture(t);
    enqueue(f, [event('append', 13)]);
    if (state !== 'running') {
      f.api.pauseDataIngestion();
      f.queue[state] = true;
    }
    rejectUnchanged(f);
    if (state !== 'running') f.queue[state] = false;
  });
}

test('real preservation rejects a stale original sourceVersion without rebinding or rewriting lastError', t => {
  const f = fixture(t);
  enqueue(f, [event('append', 13)]);
  f.api.pauseDataIngestion();
  const queueVersion = f.queue.sourceVersion;
  f.model.store.update(11, bar(12, 50));
  assert.notEqual(f.model.store.version, queueVersion);
  rejectUnchanged(f);
  assert.equal(f.queue.sourceVersion, queueVersion);
  assert.equal(f.queue.lastError, null);
});

for (const state of ['running', 'paused', 'stale', 'draining', 'leased']) {
  test(`no-op preservation does not certify or mutate ${state} semantically invalid pending events`, t => {
    const f = fixture(t);
    enqueue(f, [event('correction', 13), event('append', 13), event('update', 11)]);
    if (state !== 'running') f.api.pauseDataIngestion();
    if (state === 'stale') f.model.store.update(11, bar(12, 50));
    if (state === 'draining' || state === 'leased') f.queue[state] = true;
    const before = queueSnapshot(f.queue), source = sourceSnapshot(f);
    for (const keep of [12, 20]) {
      const receipt = f.api.compactData(compactOptions(keep));
      assert.equal(receipt.removed, 0);
      assertQueueUnchanged(f.queue, before);
      assertSourceUnchanged(f, source);
    }
    if (state === 'draining' || state === 'leased') f.queue[state] = false;
  });
}

const invalidFifos = [
  ['evicted correction', [event('correction', 8)]],
  ['correction before future append', [event('correction', 13), event('append', 13)]],
  ['update before future append', [event('update', 13), event('append', 13)]],
  ['update to old tail after append', [event('append', 13), event('update', 12)]],
  ['update to earlier retained bar', [event('update', 10)]],
  ['append equal to original tail', [event('append', 12)]],
  ['append before original tail', [event('append', 11)]],
  ['duplicate pending append', [event('append', 13), event('append', 13)]],
  ['decreasing pending append', [event('append', 14), event('append', 13)]],
  ['late evicted correction', [event('append', 13), event('update', 13), event('correction', 1)]],
  ['late correction is not an upsert', [event('append', 13), event('correction', 16), event('append', 16)]],
];
for (const [name, events] of invalidFifos) {
  test(`preservation atomically rejects ${name}`, t => {
    const f = fixture(t);
    enqueue(f, events);
    f.api.pauseDataIngestion();
    rejectUnchanged(f);
  });
}

test('corrections can revisit retained or previously appended times after the virtual tail advances', t => {
  const f = fixture(t, {policy: {maxBatchEvents: 16}});
  enqueue(f, [
    event('correction', 12, 40), event('update', 12, 41), event('append', 13, 13),
    event('append', 15, 15), event('correction', 13, 50), event('correction', 9, 51),
    event('update', 15, 52), event('correction', 13, 53), event('correction', 9, 54),
  ]);
  f.api.pauseDataIngestion();
  const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
  const result = f.api.compactData(compactOptions(4));
  assertQueueUnchanged(f.queue, before, {sourceVersion: result.version, epoch: epoch + 1});
  f.api.resumeDataIngestion();
  assert.equal(f.api.drainDataEvents().events, 9);
  assert.deepEqual(Array.from(f.model.store.columns.close.subarray(0, 6)), [54, 10, 11, 41, 53, 52]);
});

test('compaction rebinds preserved queue before a store observer resumes and drains it', t => {
  const f = fixture(t);
  enqueue(f, [event('append', 13), event('correction', 9, 90)]);
  f.api.pauseDataIngestion();
  const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
  let compactObserved = 0, drained = 0;
  const stop = f.model.store.subscribe(change => {
    if (change.kind !== 'compact') return;
    compactObserved++;
    assert.equal(f.model.store.length, 4);
    assertQueueUnchanged(f.queue, before, {sourceVersion: f.model.store.version, epoch: epoch + 1});
    f.api.resumeDataIngestion();
    drained = f.api.drainDataEvents().events;
  });
  t.after(stop);
  const receipt = f.api.compactData(compactOptions(4));
  assert.equal(compactObserved, 1);
  assert.equal(drained, 2);
  assert.equal(receipt.length, 4);
  assert.equal(f.model.store.length, 5);
  assert.equal(f.model.store.at(0).close, 90);
  assert.equal(f.queue.sourceVersion, f.model.store.version);
  assert.equal(f.queue.count, 0);
  assert.deepEqual(f.model.store.listenerErrors, []);
});

test('small drains and repeated compaction preserve cursor conservation and dependencies', t => {
  const f = fixture(t, {policy: {maxBatchEvents: 2}});
  enqueue(f, [event('append', 13), event('update', 13, 30), event('correction', 12, 40), event('append', 14), event('correction', 13, 50), event('update', 14, 60)]);
  f.api.pauseDataIngestion();
  f.api.compactData(compactOptions(4));
  for (const keep of [3, 2]) {
    f.api.resumeDataIngestion();
    assert.equal(f.api.drainDataEvents(2).events, 2);
    f.api.pauseDataIngestion();
    const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
    const receipt = f.api.compactData(compactOptions(keep));
    assertQueueUnchanged(f.queue, before, {sourceVersion: receipt.version, epoch: epoch + 1});
    assert.equal(f.queue.counters.accepted, f.queue.counters.applied + f.queue.counters.cancelled + f.queue.count);
    assert.equal(f.queue.firstPendingSequence + f.queue.count, f.queue.nextSequence);
  }
  f.api.resumeDataIngestion();
  assert.equal(f.api.drainDataEvents(1).events, 1);
  assert.equal(f.api.drainDataEvents(1).events, 1);
  assert.equal(f.api.drainDataEvents(1).events, 0);
  assert.deepEqual(Array.from(f.model.store.columns.time.subarray(0, 2)), [13, 14]);
  assert.deepEqual(Array.from(f.model.store.columns.close.subarray(0, 2)), [50, 60]);
  assert.equal(f.queue.counters.applied, 6);
  assert.equal(f.queue.counters.lastAppliedSequence, 25);
  assert.equal(f.queue.nextSequence, 26);
});

test('correction inside retained time bounds still requires an exact retained timestamp', t => {
  const f = fixture(t, {timeStep: 2});
  enqueue(f, [event('correction', 19)]);
  f.api.pauseDataIngestion();
  rejectUnchanged(f);
});

test('failed capacity drain recovers through compaction while preserving its last error and counters', t => {
  const f = fixture(t, {policy: {maxStoredBars: 12}});
  enqueue(f, [event('append', 13), event('update', 13, 30)]);
  assert.throws(() => f.api.drainDataEvents(), error => error.code === 'DRAIN_FAILED');
  assert.equal(f.queue.paused, true);
  assert.equal(f.queue.counters.failedDrains, 1);
  assert.equal(f.queue.lastError.code, 'DRAIN_FAILED');
  const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
  const result = f.api.compactData(compactOptions(4));
  assertQueueUnchanged(f.queue, before, {sourceVersion: result.version, epoch: epoch + 1});
  f.api.resumeDataIngestion();
  assert.equal(f.queue.lastError, null);
  assert.equal(f.api.drainDataEvents().events, 2);
  assert.equal(f.model.store.length, 5);
  assert.equal(f.model.store.at(4).close, 30);
  assert.equal(f.queue.counters.failedDrains, 1);
  assert.equal(f.queue.counters.applied, 2);
});

const laterFailures = [
  ['stored-row cap', {maxStoredBars: 12}, [event('append', 13), event('append', 14)]],
  ['capacity-byte budget', {maxStoreBytes: 1536}, Array.from({length: 6}, (_, i) => event('append', 13 + i))],
  ['intermediate volume sum', {}, [event('correction', 10, 10, Number.MAX_VALUE), event('correction', 11, 11, Number.MAX_VALUE), event('correction', 10, 10, 1), event('correction', 11, 11, 1)]],
];
for (const [name, policy, events] of laterFailures) {
  test(`preservation does not promise future drain success for ${name}`, t => {
    const f = fixture(t, {policy});
    enqueue(f, events);
    f.api.pauseDataIngestion();
    const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
    const receipt = f.api.compactData(compactOptions(11));
    assert.equal(receipt.removed, 1);
    assertQueueUnchanged(f.queue, before, {sourceVersion: receipt.version, epoch: epoch + 1});
    f.api.resumeDataIngestion();
    const source = sourceSnapshot(f), firstSequence = f.queue.firstPendingSequence, nextSequence = f.queue.nextSequence;
    assert.throws(() => f.api.drainDataEvents(), error => error.code === 'DRAIN_FAILED');
    assertSourceUnchanged(f, source);
    assert.equal(f.queue.count, events.length);
    assert.equal(f.queue.firstPendingSequence, firstSequence);
    assert.equal(f.queue.nextSequence, nextSequence);
    assert.equal(f.queue.counters.applied, 0);
    assert.equal(f.queue.counters.failedDrains, 1);
    assert.equal(f.queue.paused, true);
    for (const key of fields) assert.deepEqual(bytes(f.queue.columns[key]), before.columns[key].bytes);
    assert.deepEqual(bytes(f.queue.kinds), before.kinds.bytes);
  });
}

for (const [owner, key] of [
  ...['sourceVersion', 'head', 'count', 'capacity', 'columns', 'kinds', 'nextSequence', 'firstPendingSequence', 'policy', 'counters', 'lastError', 'paused', 'draining', 'leased', 'epoch'].map(key => ['queue', key]),
  ...fields.map(key => ['columns', key]),
  ['counters', 'accepted'],
]) {
  test(`preservation rejects ${owner}.${key} accessor without invoking it`, t => {
    const f = fixture(t);
    enqueue(f, [event('append', 13)]);
    f.api.pauseDataIngestion();
    const before = queueSnapshot(f.queue), source = sourceSnapshot(f);
    const target = owner === 'queue' ? f.queue : f.queue[owner];
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    let calls = 0;
    Object.defineProperty(target, key, {configurable: true, enumerable: descriptor.enumerable, get() { calls++; return descriptor.value; }});
    try {
      assert.throws(() => f.api.compactData(compactOptions(4)));
      assert.equal(calls, 0);
    } finally {
      Object.defineProperty(target, key, descriptor);
    }
    assertQueueUnchanged(f.queue, before);
    assertSourceUnchanged(f, source);
  });
}

test('preservation uses physical buffers without invoking shadowed typed-array getters or queue methods', t => {
  const f = fixture(t, {policy: {maxQueuedEvents: 4}});
  enqueue(f, [event('append', 13, -0, 0), event('update', 13, 0, -0)]);
  f.api.pauseDataIngestion();
  // Unused physical slots are deliberately nonzero. They are not FIFO events
  // and must neither be validated as such nor rewritten during preservation.
  for (const key of fields) f.queue.columns[key][3] = key === 'time' ? -400 : -0;
  f.queue.kinds[3] = 255;
  const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
  let calls = 0;
  const installed = [];
  const shadow = (owner, key) => {
    installed.push([owner, key, Object.getOwnPropertyDescriptor(owner, key)]);
    Object.defineProperty(owner, key, {configurable: true, get() { calls++; throw new Error(`unexpected ${key} access`); }});
  };
  for (const array of [...fields.map(key => f.queue.columns[key]), f.queue.kinds]) {
    shadow(array, 'length');
    shadow(array, 'buffer');
    shadow(array, 'byteLength');
    shadow(array, 'byteOffset');
  }
  for (const key of ['prefix', 'stats', 'save', 'source']) shadow(f.queue, key);
  let receipt;
  try {
    receipt = f.api.compactData(compactOptions(4));
    assert.equal(calls, 0);
  } finally {
    for (const [owner, key, descriptor] of installed) {
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete owner[key];
    }
  }
  assertQueueUnchanged(f.queue, before, {sourceVersion: receipt.version, epoch: epoch + 1});
});

test('no-op does not inspect pending ring accessors', t => {
  const f = fixture(t);
  enqueue(f, [event('update', 1)]);
  const before = queueSnapshot(f.queue), source = sourceSnapshot(f);
  const count = Object.getOwnPropertyDescriptor(f.queue, 'count');
  let calls = 0;
  Object.defineProperty(f.queue, 'count', {configurable: true, enumerable: true, get() { calls++; throw new Error('queue must not be certified'); }});
  try {
    assert.equal(f.api.compactData(compactOptions(12)).removed, 0);
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(f.queue, 'count', count);
  }
  assertQueueUnchanged(f.queue, before);
  assertSourceUnchanged(f, source);
});

test('rejected pending correction leaves indicator outputs, checkpoints, and range caches installed', t => {
  const f = fixture(t);
  f.api.addIndicator('ema', 'ema', {period: 3});
  f.api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema'});
  const series = f.model.series.find(row => row.id === 'ema-line');
  f.model.seriesData(series);
  const entry = f.model.indicators.entries.get('ema');
  const arrays = entry.arrays, output = arrays.map(array => ({array, bytes: bytes(array)}));
  const checkpoints = entry.checkpoints, checkpointEntries = [...checkpoints], rangeIndex = series.rangeIndex;
  const dirty = entry.dirty, dirtyTo = entry.dirtyTo, invalidated = entry.invalidated, revision = series.revision;
  enqueue(f, [event('append', 13), event('correction', 1)]);
  f.api.pauseDataIngestion();
  rejectUnchanged(f);
  assert.equal(entry.arrays, arrays);
  for (const [i, saved] of output.entries()) {
    assert.equal(entry.arrays[i], saved.array);
    assert.deepEqual(bytes(entry.arrays[i]), saved.bytes);
  }
  assert.equal(entry.checkpoints, checkpoints);
  assert.deepEqual([...checkpoints], checkpointEntries);
  assert.equal(entry.dirty, dirty);
  assert.equal(entry.dirtyTo, dirtyTo);
  assert.equal(entry.invalidated, invalidated);
  assert.equal(series.rangeIndex, rangeIndex);
  assert.equal(series.revision, revision);
});

test('maximum 4096-event FIFO preserves every payload byte and sequence before draining', t => {
  const f = fixture(t, {policy: {maxQueuedEvents: 4096, maxBatchEvents: 4096}});
  const events = Array.from({length: 4096}, (_, i) => event('update', 12, i % 2 ? -0 : 0, i % 3 ? 0 : -0));
  enqueue(f, events);
  assert.equal(f.queue.count, 4096);
  assert.equal(f.queue.nextSequence, 4116);
  f.api.pauseDataIngestion();
  const before = queueSnapshot(f.queue), epoch = f.queue.epoch;
  const receipt = f.api.compactData(compactOptions(4));
  assertQueueUnchanged(f.queue, before, {sourceVersion: receipt.version, epoch: epoch + 1});
  assert.equal(f.queue.firstPendingSequence, 20);
  assert.equal(f.queue.nextSequence, 4116);
  f.api.resumeDataIngestion();
  const drained = f.api.drainDataEvents(4096);
  assert.equal(drained.events, 4096);
  assert.equal(drained.firstSequence, 20);
  assert.equal(drained.lastSequence, 4115);
  assert.equal(f.queue.counters.applied, 4096);
  assert.equal(f.queue.count, 0);
  assert.equal(f.queue.firstPendingSequence, 4116);
  assert.ok(Object.is(f.model.store.at(3).close, -0));
  assert.ok(Object.is(f.model.store.at(3).volume, -0));
});

test('preservation rejects tampered ring capacity 4097 before publication', t => {
  const f = fixture(t);
  enqueue(f, [event('append', 13)]);
  f.api.pauseDataIngestion();
  const capacity = f.queue.capacity;
  f.queue.capacity = 4097;
  try {
    rejectUnchanged(f, compactOptions(4), /ring bounds/);
  } finally {
    f.queue.capacity = capacity;
  }
});
