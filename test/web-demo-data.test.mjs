import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seededColumns} from '../src/core/data.mjs';
import {demoCalendar} from '../src/core/markets.mjs';
import {makeDemoData, DATA_FIELDS, MAX_DEMO_DATA_COUNT} from '../examples/web/demo-data.mjs';
import {loadDemoData} from '../examples/web/load-demo-data.mjs';

function oldDemoData(market, count) {
  const columns = seededColumns(count, 42), calendar = demoCalendar(market);
  let written = 0, date = '2026-01-01';
  while (written < count) {
    for (const session of calendar.sessions(date).filter(value => value.kind === 'regular')) {
      for (let time = session.open; time < session.close && written < count; time += 60000) columns.time[written++] = time;
    }
    date = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  const factor = market === 'kr' ? 700 : market === 'crypto' ? 1e-10 : 1;
  for (let index = 0; index < count; index++) for (const key of ['open', 'high', 'low', 'close']) columns[key][index] *= factor;
  return columns;
}

test('shared demo data is bit-exact with the legacy model-worker generator', () => {
  for (const market of ['us', 'kr', 'crypto']) {
    const actual = makeDemoData({market, count: 257}), expected = oldDemoData(market, 257);
    for (const key of DATA_FIELDS) assert.deepEqual(actual[key], expected[key], `${market} ${key}`);
  }
});

test('shared generator reports bounded data progress and enforces input limits', () => {
  const progress = [], columns = makeDemoData({market: 'us', count: 1_000_000, onProgress: value => progress.push(value)});
  assert.equal(columns.time.length, 1_000_000);
  assert.ok(progress.length > 0);
  assert.equal(progress[0].phase, 'data');
  assert.equal(progress[0].total, 1_000_000);
  assert.ok(progress[0].done > 0);
  assert.throws(() => makeDemoData({market: 'bad', count: 1}), /market/i);
  assert.throws(() => makeDemoData({market: 'us', count: MAX_DEMO_DATA_COUNT + 1}), /limit/i);
});

function workerFixture() {
  const previous = globalThis.Worker, instances = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.terminated = 0;
      instances.push(this);
    }
    postMessage(request) { this.request = request; }
    terminate() { this.terminated++; }
  }
  globalThis.Worker = FakeWorker;
  return {instances, restore: () => {globalThis.Worker = previous;}};
}

test('loader owns transferred columns, forwards progress and terminates after completion', async () => {
  const fixture = workerFixture();
  try {
    const progress = [], pending = loadDemoData({market: 'kr', count: 8, onProgress: value => progress.push(value)}), worker = fixture.instances[0];
    assert.match(worker.url, /demo-data-worker\.mjs$/);
    assert.deepEqual(worker.options, {type: 'module'});
    assert.deepEqual(worker.request, {schema: 'aster.demo-data-request', version: 1, market: 'kr', count: 8});
    worker.onmessage({data: {progress: {phase: 'data', done: 8, total: 8}}});
    const columns = makeDemoData({market: 'kr', count: 8});
    worker.onmessage({data: {schema: 'aster.demo-data-result', version: 1, market: 'kr', count: 8, columns}});
    const loaded = await pending;
    assert.deepEqual(progress, [{phase: 'data', done: 8, total: 8}]);
    assert.deepEqual(loaded.time, columns.time);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(worker.terminated, 1);
  } finally { fixture.restore(); }
});

test('loader cancellation terminates the worker and ignores a stale reply', async () => {
  const fixture = workerFixture();
  try {
    const controller = new AbortController(), pending = loadDemoData({market: 'us', count: 1_000_000, signal: controller.signal}), worker = fixture.instances[0];
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(worker.terminated, 1);
    worker.onmessage?.({data: {schema: 'aster.demo-data-result', version: 1, market: 'us', count: 1_000_000, columns: makeDemoData({market: 'us', count: 0})}});
  } finally { fixture.restore(); }
});

test('loader bounds worker errors and rejects malformed replies without a main-thread fallback', async () => {
  const fixture = workerFixture();
  try {
    const pending = loadDemoData({market: 'crypto', count: 1}), worker = fixture.instances[0];
    worker.onmessage({data: {error: 'x'.repeat(1000)}});
    await assert.rejects(pending, error => error.name === 'DataWorkerError' && error.message.length <= 256);
    assert.equal(worker.terminated, 1);
    await assert.rejects(loadDemoData({market: 'us', count: -1}), /count/i);
  } finally { fixture.restore(); }
});

test('data-only worker has no ChartModel or computeRequest dependency', async () => {
  const source = await readFile(new URL('../examples/web/demo-data-worker.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ChartModel|computeRequest|prepareChartModel/);
});
