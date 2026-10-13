import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {dedicatedCalculationWorkers} from './helpers/dedicated-calculation-workers.mjs';
import {assertMatchingResult, observeOperation, watchdog, withCalculationDeadline} from './helpers/calculation-deadline-fixture.mjs';

const {BarStore,SessionCalendar,resampleOHLCV}=await import('../src/core/index.mjs');
const {resampleOHLCVAsync}=await import('../src/web/resample-async.mjs');
const {calculationJobStats}=await import('../src/web/calculation-job.mjs');
const HOST=new URL('./helpers/async-resample-worker-host.mjs',import.meta.url);
const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
const M = 60000, H = 60 * M, T = Date.parse('2026-03-09T09:30:00Z');
const baseline = {activeJobs: 0, reservedBytes: 0};
const isAbort = error => /abort/i.test(`${error?.name} ${error?.code}`);
const isTimeout = error => /timeout|timed.?out|deadline/i.test(`${error?.name} ${error?.code} ${error?.message}`);
const isStale = error => /stale|source.changed/i.test(`${error?.name} ${error?.code} ${error?.message}`);

function bar(time, i = 0) { return {time, open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i, volume: i + 1}; }
function columns(rows, {prefix = 0, suffix = 0, spare = 0} = {}) {
  const result = Object.fromEntries(FIELDS.map(field => {
    const backing = new Float64Array(prefix + rows.length + spare + suffix).fill(NaN);
    rows.forEach((row, i) => { backing[prefix + i] = row[field]; });
    return [field, backing.subarray(prefix, prefix + rows.length + spare)];
  }));
  return {columns: result, length: rows.length};
}
function immutable(input) { return {kind: 'immutable-columns', ...input}; }
function fixedCalendar(windows = [{open: '09:30', close: '10:00', kind: 'regular'}], dates = ['2026-03-09'], timezone = 'UTC') {
  return new SessionCalendar(timezone, date => dates.includes(date) ? windows.map(x => ({...x})) : []);
}
function options(patch = {}) {
  return {sourceIntervalMs: M, targetIntervalMs: 5 * M, calendar: fixedCalendar(), kinds: ['regular'], asOf: T + 30 * M, partialTarget: 'include-unconfirmed', ...patch};
}
function plain(result) {
  return {
    columns: Object.fromEntries(FIELDS.map(field => [field, [...result.columns[field]]])),
    length: result.length,
    ...Object.fromEntries(['endTime', 'availableAt', 'sourceFrom', 'sourceTo', 'complete', 'confirmed'].map(field => [field, [...result[field]]])),
    asOf: result.asOf, sourceIntervalMs: result.sourceIntervalMs, targetIntervalMs: result.targetIntervalMs,
  };
}
function checkShape(result) {
  for (const field of FIELDS) assert.ok(result.columns[field] instanceof Float64Array, field);
  for (const field of ['endTime', 'availableAt']) assert.ok(result[field] instanceof Float64Array, field);
  for (const field of ['sourceFrom', 'sourceTo']) assert.ok(result[field] instanceof Uint32Array, field);
  for (const field of ['complete', 'confirmed']) assert.ok(result[field] instanceof Uint8Array, field);
  for (const vector of [...Object.values(result.columns), ...['endTime', 'availableAt', 'sourceFrom', 'sourceTo', 'complete', 'confirmed'].map(field => result[field])]) assert.equal(vector.length, result.length);
}
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }
function workerFactory(t, hooks = {}) {
  const instances = [];
  const factory = url => {
    const node = new Worker(HOST, {workerData: {url: String(url)}});
    const exited = deferred();
    const adapter = {node, threadId: node.threadId, onmessage: null, onerror: null, terminateCalls: 0, posts: 0, exited: exited.promise,
      postMessage(data, transfer) { this.posts++; hooks.beforeSend?.(data, adapter); node.postMessage(data, transfer); hooks.afterSend?.(data, adapter); },
      terminate() { this.terminateCalls++; return node.terminate().then(async code => {await hooks.terminated?.(adapter); return code;}); },
    };
    node.on('message', data => { if (data?.__asterTestHost === 'dispatch') {hooks.processing?.(adapter); return;} hooks.beforeReceive?.(data, adapter); if (hooks.shouldDeliver?.(data, adapter) !== false) adapter.onmessage?.({data}); hooks.afterReceive?.(data, adapter); });
    node.on('error', error => adapter.onerror?.(error));
    node.on('exit', code => exited.resolve(code));
    instances.push(adapter); hooks.created?.(adapter); return adapter;
  };
  t.after(async () => { await Promise.all(instances.map(x => x.node.terminate())); });
  return {factory, instances, async clean() {
    await Promise.all(instances.map(x => x.exited));
    assert.deepEqual(calculationJobStats(), baseline);
    for (const instance of instances) { assert.ok(instance.threadId > 0, 'real worker_threads used'); assert.equal(instance.terminateCalls, 1, 'dedicated worker terminated exactly once'); }
  }};
}
function packedInput(n = 32769) {
  const start = Date.parse('2026-03-09T00:00:00Z');
  const result = {columns: Object.fromEntries(FIELDS.map(field => [field, new Float64Array(n)])), length: n};
  for (let i = 0; i < n; i++) {
    result.columns.time[i] = start + i;
    result.columns.open[i] = 100;
    result.columns.high[i] = 103;
    result.columns.low[i] = 98;
    result.columns.close[i] = 101;
    result.columns.volume[i] = 1;
  }
  return {input: result, opts: options({sourceIntervalMs: 1, targetIntervalMs: 10, calendar: fixedCalendar([{open: '00:00', close: '00:00'}]), asOf: start + n + 1})};
}
function recordCalendar(calendar) {
  return {cache: calendar.cache, entries: [...calendar.cache].map(([date, windows]) => [date, windows, windows.map(window => ({reference: window, value: {...window}}))]), provider: calendar.provider, timezone: calendar.timezone, maxCachedDays: calendar.maxCachedDays};
}
function assertCalendarUnchanged(calendar, before) {
  assert.equal(calendar.cache, before.cache);
  assert.deepEqual([...calendar.cache.keys()], before.entries.map(entry => entry[0]));
  for (const [date, windows, records] of before.entries) {
    assert.equal(calendar.cache.get(date), windows);
    assert.equal(windows.length, records.length);
    records.forEach(({reference, value}, i) => {assert.equal(windows[i], reference); assert.deepEqual(windows[i], value);});
  }
  for (const key of ['provider', 'timezone', 'maxCachedDays']) assert.equal(calendar[key], before[key]);
}

test('pre-aborted signal touches no source, calendar, provider, or worker', async () => {
  const controller = new AbortController(); controller.abort();
  let sourceReads = 0, calendarReads = 0, workers = 0;
  const source = new Proxy({}, {get() {sourceReads++; throw new Error('Source should not be read');}, ownKeys() {sourceReads++; throw new Error('Source should not be reflected');}});
  const opts = options({signal: controller.signal, workerFactory() {workers++; throw new Error('Worker should not be created');}});
  Object.defineProperty(opts, 'calendar', {get() {calendarReads++; throw new Error('Calendar should not be read');}});
  await assert.rejects(Promise.resolve().then(() => resampleOHLCVAsync(source, opts)), isAbort);
  assert.deepEqual({sourceReads, calendarReads, workers}, {sourceReads: 0, calendarReads: 0, workers: 0});
  assert.deepEqual(calculationJobStats(), baseline);
});

test('real worker output matches synchronous oracle across complete, partial, future, empty, lunch and DST fixtures', async t => {
  const complete = Array.from({length: 10}, (_, i) => bar(T + i * M, i));
  const partial = complete.filter((_, i) => i !== 2);
  const lunchStart = Date.parse('2026-03-09T12:02:00Z');
  const lunch = [...Array.from({length: 7}, (_, i) => bar(T + i * M, i)), ...Array.from({length: 7}, (_, i) => bar(lunchStart + i * M, i + 7))];
  const fixtures = [
    {name: 'empty', rows: [], opts: options({partialTarget: 'reject'})},
    {name: 'complete', rows: complete, opts: options({partialTarget: 'reject'})},
    {name: 'partial and NaN availability', rows: partial, opts: options()},
    {name: 'omit populated partial', rows: partial, opts: options({partialTarget: 'omit'})},
    {name: 'future source ignored at asOf', rows: complete, opts: options({asOf: T + 5 * M, partialTarget: 'reject'})},
    {name: 'source close cutoff', rows: complete, opts: options({asOf: T + 2 * M - 1})},
    {name: 'lunch resets and session end', rows: lunch, opts: options({calendar: fixedCalendar([{open: '09:30', close: '09:37'}, {open: '12:02', close: '12:09'}]), asOf: lunchStart + 7 * M, partialTarget: 'reject'})},
    ...[
      {date: '2026-03-08', start: '2026-03-08T05:00:00Z', hours: 3},
      {date: '2026-11-01', start: '2026-11-01T04:00:00Z', hours: 5},
    ].map(fixture => ({name: `DST ${fixture.date}`, rows: Array.from({length: fixture.hours}, (_, i) => bar(Date.parse(fixture.start) + i * H, i)), opts: options({calendar: fixedCalendar([{open: '00:00', close: '04:00'}], [fixture.date], 'America/New_York'), sourceIntervalMs: H, targetIntervalMs: 2 * H, asOf: Date.parse(fixture.start) + fixture.hours * H, partialTarget: 'reject'})})),
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async t => {
    const source = columns(fixture.rows);
    const expected = plain(resampleOHLCV(source, fixture.opts));
    const workers = workerFactory(t);
    const actual = await resampleOHLCVAsync(immutable(source), {...fixture.opts, workerFactory: workers.factory});
    checkShape(actual); assert.deepEqual(plain(actual), expected); await workers.clean();
  });
});

test('worker validates future malformed OHLCV and propagates rejection without leaked reservation', async t => {
  const rows = Array.from({length: 6}, (_, i) => bar(T + i * M, i)); rows.at(-1).open = NaN;
  const source = columns(rows), opts = options({asOf: T + 5 * M, partialTarget: 'reject'}), workers = workerFactory(t);
  assert.throws(() => resampleOHLCV(source, opts));
  await assert.rejects(resampleOHLCVAsync(immutable(source), {...opts, workerFactory: workers.factory}));
  await workers.clean();
});

test('nonzero byteOffset and logical capacity preserve caller storage and return independent arrays', async t => {
  const source = columns(Array.from({length: 10}, (_, i) => bar(T + i * M, i)), {prefix: 3, spare: 11, suffix: 4});
  const snapshots = Object.fromEntries(FIELDS.map(field => [field, {ref: source.columns[field], buffer: source.columns[field].buffer, byteLength: source.columns[field].buffer.byteLength, data: [...new Float64Array(source.columns[field].buffer)]}]));
  const calendar = fixedCalendar(); calendar.sessions('2026-03-01'); calendar.sessions('2026-03-02'); const before = recordCalendar(calendar);
  const opts = options({calendar}), expected = plain(resampleOHLCV(source, opts)), workers = workerFactory(t);
  const result = await resampleOHLCVAsync(immutable(source), {...opts, workerFactory: workers.factory});
  assert.deepEqual(plain(result), expected); assertCalendarUnchanged(calendar, before);
  for (const field of FIELDS) {
    const saved = snapshots[field];
    assert.equal(source.columns[field], saved.ref); assert.equal(source.columns[field].buffer, saved.buffer);
    assert.equal(saved.buffer.byteLength, saved.byteLength, `${field} caller buffer not detached`);
    assert.deepEqual([...new Float64Array(saved.buffer)], saved.data, `${field} complete backing store unchanged`);
    assert.notEqual(result.columns[field].buffer, saved.buffer);
  }
  result.columns.open[0] = -123; assert.equal(source.columns.open[0], 100);
  await workers.clean();
});

test('successful store mode agrees with synchronous source and leaves store identity/version intact', async t => {
  const store = new BarStore(Array.from({length: 10}, (_, i) => bar(T + i * M, i)));
  const before = {version: store.version, columns: store.columns, length: store.length};
  const workers = workerFactory(t), opts = options({workerFactory: workers.factory});
  const result = await resampleOHLCVAsync({kind: 'store', store}, opts);
  assert.deepEqual(plain(result), plain(resampleOHLCV(store, opts)));
  assert.equal(store.version, before.version); assert.equal(store.columns, before.columns); assert.equal(store.length, before.length);
  await workers.clean();
});

test('abort immediately after invocation interrupts snapshot before a worker is started', async () => {
  const {input, opts} = packedInput(), controller = new AbortController(); let workers = 0;
  const pending = resampleOHLCVAsync(immutable(input), {...opts, signal: controller.signal, workerFactory() {workers++; throw new Error('Snapshot abort started worker');}});
  controller.abort();
  await assert.rejects(pending, isAbort); assert.equal(workers, 0); assert.deepEqual(calculationJobStats(), baseline);
  assert.equal(input.columns.time.byteLength, input.length * 8);
});

test('store API mutation during chunked snapshot rejects stale source', async () => {
  const {input, opts} = packedInput(), store = new BarStore(); store.setColumns(input.columns, input.length); let workers = 0;
  const pending = resampleOHLCVAsync({kind: 'store', store}, {...opts, workerFactory() {workers++; throw new Error('Stale snapshot started worker');}});
  store.update(0, {...store.at(0), close: 102});
  await assert.rejects(pending, isStale); assert.equal(workers, 0); assert.deepEqual(calculationJobStats(), baseline);
});

test('abort performed inside trusted calendar provider is observed immediately on return', async () => {
  const controller = new AbortController(); let calls = 0, workers = 0;
  const calendar = new SessionCalendar('UTC', () => {calls++; controller.abort(); return [];});
  await assert.rejects(resampleOHLCVAsync(immutable(columns([bar(T)])), options({calendar, signal: controller.signal, workerFactory() {workers++; throw new Error('Aborted calendar capture started worker');}})), isAbort);
  assert.equal(calls, 1, 'provider capture stops after aborting call returns'); assert.equal(workers, 0); assert.deepEqual(calculationJobStats(), baseline);
});

test('deadline includes a trusted provider call and is checked before worker creation', async () => {
  const controller = new AbortController(); let calls = 0, workers = 0;
  await withCalculationDeadline(50, async clock => {
    const calendar = new SessionCalendar('UTC', date => {
      calls++;
      clock.advanceTo(50); // Simulate provider time without running the timer.
      return date === '2026-03-09' ? [{open: '09:30', close: '10:00'}] : [];
    });
    const operation = observeOperation(resampleOHLCVAsync(immutable(columns([bar(T)])), options({calendar, signal: controller.signal, timeoutMs: 50, workerFactory() {workers++; throw new Error('Expired capture started worker');}})));
    try {
      const result = await watchdog(operation.outcome, 'calendar provider deadline cleanup');
      assert.equal(result.error?.name, 'TimeoutError');
      assert.equal(calls, 1); assert.equal(workers, 0); assert.deepEqual(calculationJobStats(), baseline);
    } finally {
      controller.abort();
      await watchdog(operation.outcome, 'calendar provider failure cleanup');
    }
  });
});

test('abort after real worker receives its owned snapshot terminates the thread and cleans counters', async t => {
  const controller = new AbortController(), dispatched = deferred();
  const workers = workerFactory(t, {afterSend() {dispatched.resolve();}});
  const pending = resampleOHLCVAsync(immutable(columns(Array.from({length: 10}, (_, i) => bar(T + i * M, i)))), options({signal: controller.signal, workerFactory: workers.factory}));
  await dispatched.promise; controller.abort();
  await assert.rejects(pending, isAbort); await workers.clean();
});

test('store update after worker dispatch is rejected before publishing result', async t => {
  const store = new BarStore(Array.from({length: 10}, (_, i) => bar(T + i * M, i)));
  const workers = workerFactory(t, {afterSend() {store.update(0, {...store.at(0), close: 102});}});
  await assert.rejects(resampleOHLCVAsync({kind: 'store', store}, options({workerFactory: workers.factory})), isStale);
  await workers.clean();
});

test('scheduled macrotask executes while a chunked snapshot remains pending', async t => {
  let workerCreated = false;
  const {input, opts} = packedInput(65537), workers = workerFactory(t, {created() {workerCreated = true;}}); let settled = false, timerObservedPending = false, timerBeforeWorker = false;
  const timer = new Promise(resolve => setTimeout(() => {timerObservedPending = !settled; timerBeforeWorker = !workerCreated; resolve();}, 0));
  const pending = resampleOHLCVAsync(immutable(input), {...opts, workerFactory: workers.factory});
  const result = await pending; settled = true; await timer;
  assert.equal(timerObservedPending, true, 'real event-loop timer observed operation pending');
  assert.equal(timerBeforeWorker, true, 'snapshot yields a real macrotask before worker creation');
  assert.equal(result.length, Math.ceil(input.length / 10)); await workers.clean();
});

test('repeated actual worker success/cancellation returns reservations and workers to baseline', async t => {
  for (let iteration = 0; iteration < 4; iteration++) {
    const controller = new AbortController();
    const workers = workerFactory(t, iteration % 2 ? {afterSend() {controller.abort();}} : {});
    const pending = resampleOHLCVAsync(immutable(columns(Array.from({length: 5}, (_, i) => bar(T + i * M, i)))), options({signal: controller.signal, workerFactory: workers.factory}));
    if (iteration % 2) await assert.rejects(pending, isAbort); else assert.equal((await pending).length, 1);
    await workers.clean();
  }
  await delay(10); assert.deepEqual(calculationJobStats(), baseline);
});


test('progress-triggered abort is checked after snapshot, calendar, compute and validation callbacks', async t => {
  for (const phase of ['snapshot', 'calendar', 'compute', 'validate']) await t.test(phase, async t => {
    const controller = new AbortController(), workers = workerFactory(t); let reached = false;
    await assert.rejects(resampleOHLCVAsync(immutable(columns(Array.from({length: 10}, (_, i) => bar(T + i * M, i)))), options({
      signal: controller.signal, workerFactory: workers.factory,
      onProgress(progress) {if (progress.phase === phase) {reached = true; controller.abort();}},
    })), isAbort);
    assert.equal(reached, true, `${phase} callback observed`); await workers.clean();
  });
});

test('store mutation from validation progress rejects before final publication', async t => {
  const store = new BarStore(Array.from({length: 10}, (_, i) => bar(T + i * M, i))), workers = workerFactory(t); let reached = false;
  await assert.rejects(resampleOHLCVAsync({kind: 'store', store}, options({workerFactory: workers.factory,
    onProgress(progress) {if (progress.phase === 'validate' && !reached) {reached = true; store.update(0, {...store.at(0), close: 102});}},
  })), isStale);
  assert.equal(reached, true); await workers.clean();
});

test('withheld computed resample response rejects when its original deadline fires', async t => {
  const received = deferred(), controller = new AbortController(), signal = controller.signal, listeners = new Set();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {if (type === 'abort') listeners.add(listener); return add(type, listener, options);};
  signal.removeEventListener = (type, listener, options) => {if (type === 'abort') listeners.delete(listener); return remove(type, listener, options);};
  const workers = dedicatedCalculationWorkers(t, {beforeReceive(packet, adapter) {received.resolve({packet, request: adapter.request});}, shouldDeliver() {return false;}});
  await workers.prepare(new URL('../src/web/resample-worker.mjs', import.meta.url));
  await withCalculationDeadline(500, async clock => {
    const operation = observeOperation(resampleOHLCVAsync(immutable(columns(Array.from({length: 10}, (_, i) => bar(T + i * M, i)))), options({timeoutMs: 500, workerFactory: workers.factory, signal})));
    try {
      const {packet, request} = await operation.beforeSettlement(received.promise, 'computed resample response');
      assertMatchingResult(packet, request, 'aster.resample-result');
      assert.equal(packet.result.length, 2);
      assert.equal(operation.settled, false, 'computed reply is withheld from the owner');
      clock.expire();
      const result = await watchdog(operation.outcome, 'resample timeout cleanup');
      assert.equal(result.error?.name, 'TimeoutError');
      assert.equal(workers.instances.length, 1); assert.equal(workers.instances[0].posts, 1);
      assert.equal(listeners.size, 0); await workers.clean();
    } finally {
      controller.abort();
      await watchdog(operation.outcome, 'resample failure cleanup');
    }
  });
});

test('total deadline is rechecked after a validation progress callback returns', async t => {
  const controller = new AbortController(); let reached = false, request, packet;
  const workers = dedicatedCalculationWorkers(t, {beforeSend(data) {request = data;}, beforeReceive(data) {packet = data;}});
  await workers.prepare(new URL('../src/web/resample-worker.mjs', import.meta.url));
  await withCalculationDeadline(1000, async clock => {
    const operation = observeOperation(resampleOHLCVAsync(immutable(columns(Array.from({length: 10}, (_, i) => bar(T + i * M, i)))), options({signal: controller.signal, timeoutMs: 1000, workerFactory: workers.factory,
      onProgress(progress) {
        if (progress.phase !== 'validate' || reached) return;
        reached = true;
        clock.advanceTo(1000); // The timer never fires; the post-callback check rejects.
      },
    })));
    try {
      const result = await watchdog(operation.outcome, 'validation callback deadline cleanup');
      assert.equal(result.error?.name, 'TimeoutError');
      assert.equal(reached, true, 'validation phase was reached before the callback consumed the deadline');
      assertMatchingResult(packet, request, 'aster.resample-result');
      assert.equal(workers.instances.length, 1); assert.equal(workers.instances[0].posts, 1);
      await workers.clean();
    } finally {
      controller.abort();
      await watchdog(operation.outcome, 'validation callback failure cleanup');
    }
  });
});

test('progress callback errors do not alter success, but a callback abort still takes effect', async t => {
  const workers = workerFactory(t); let calls = 0;
  const result = await resampleOHLCVAsync(immutable(columns(Array.from({length: 5}, (_, i) => bar(T + i * M, i)))), options({workerFactory: workers.factory, onProgress() {calls++; throw new Error('Host progress callback');}}));
  assert.equal(result.length, 1); assert.ok(calls > 0); await workers.clean();
  const cancelledWorkers = workerFactory(t), controller = new AbortController();
  await assert.rejects(resampleOHLCVAsync(immutable(columns([bar(T)])), options({signal: controller.signal, workerFactory: cancelledWorkers.factory,
    onProgress() {controller.abort(); throw new Error('Host progress callback after abort');},
  })), isAbort);
  await cancelledWorkers.clean();
});


test('final store version check runs after awaited worker termination', async t => {
  const store = new BarStore(Array.from({length: 5}, (_, i) => bar(T + i * M, i))); let terminationMutation = false;
  const workers = workerFactory(t, {terminated() {terminationMutation = true; store.update(0, {...store.at(0), close: 102});}});
  await assert.rejects(resampleOHLCVAsync({kind: 'store', store}, options({workerFactory: workers.factory})), isStale);
  assert.equal(terminationMutation, true); await workers.clean();
});

test('abort during asynchronous worker termination cannot publish an already validated result', async t => {
  const controller = new AbortController(); let terminated = false;
  const workers = workerFactory(t, {terminated() {terminated = true; controller.abort();}});
  await assert.rejects(resampleOHLCVAsync(immutable(columns(Array.from({length: 5}, (_, i) => bar(T + i * M, i)))), options({workerFactory: workers.factory, signal: controller.signal})), isAbort);
  assert.equal(terminated, true); await workers.clean();
});

test('abort listeners are removed after success and cancellation', async t => {
  for (const shouldAbort of [false, true]) {
    const controller = new AbortController(), signal = controller.signal, listeners = new Set();
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => {if (type === 'abort') listeners.add(listener); return add(type, listener, options);};
    signal.removeEventListener = (type, listener, options) => {if (type === 'abort') listeners.delete(listener); return remove(type, listener, options);};
    const workers = workerFactory(t, shouldAbort ? {afterSend() {controller.abort();}} : {});
    const pending = resampleOHLCVAsync(immutable(columns(Array.from({length: 5}, (_, i) => bar(T + i * M, i)))), options({workerFactory: workers.factory, signal}));
    if (shouldAbort) await assert.rejects(pending, isAbort); else await pending;
    assert.equal(listeners.size, 0, 'no retained abort listener'); await workers.clean();
  }
});


test('abort after separate worker thread enters dispatch cancels its compute lifetime', async t => {
  const {input, opts} = packedInput(65537), controller = new AbortController(); let processing = false;
  const workers = workerFactory(t, {processing() {processing = true; controller.abort();}});
  await assert.rejects(resampleOHLCVAsync(immutable(input), {...opts, workerFactory: workers.factory, signal: controller.signal}), isAbort);
  assert.equal(processing, true, 'worker thread received source snapshot and entered calculation dispatch'); await workers.clean();
});

test('documented job handle cancels superseded work and returns the next pure result',async t=>{
 const {startFiveMinuteResample}=await import('../examples/resampling-async.mjs');
 const input=columns(Array.from({length:10},(_,i)=>bar(T+i*M,i))),store=new BarStore();store.setColumns(input.columns,input.length);
 const workers=workerFactory(t),first=startFiveMinuteResample(store,fixedCalendar(),T+10*M,{workerFactory:workers.factory});first.cancel();await assert.rejects(first.promise,isAbort);
 const next=startFiveMinuteResample(store,fixedCalendar(),T+10*M,{workerFactory:workers.factory}),result=await next.promise;assert.equal(result.length,2);assert.equal(store.length,10);await workers.clean();
});
