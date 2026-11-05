import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runRustPrepareJob,
  RustPrepareCommitUncertainError,
} from '../src/web/wasm/prepare-job.mjs';

const TICKET = 17;
const HEADER = JSON.stringify({schema: 'aster.async.ui', protocol: 1, state: {drawings: {frameCounts: [2], undoCount: 0, redoCount: 0}}});
const UI_ROWS = [
  JSON.stringify({complete: false, refs: ['a']}),
  JSON.stringify({complete: false, refs: ['b']}),
  JSON.stringify({complete: true}),
];

class FakeTarget {
  constructor(mode = {}) {
    this.mode = mode;
    this.calls = [];
    this.writes = [];
    this.closed = 0;
    this.generation = 'prepare-candidate-1';
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'nativePrepareCreate') return true;
    if (name === 'nativeAsyncStart') return true;
    if (name === 'nativeAsyncStep') {
      if (this.mode.blockStep) return new Promise(() => {});
      return JSON.stringify({phase: 'ready', done: 1, total: 1, complete: true});
    }
    if (name === 'nativeAsyncUIImportBegin') return true;
    if (name === 'nativeAsyncUIImportChunk') return true;
    if (name === 'nativeAsyncUIImportEnd') return true;
    if (name === 'nativeAsyncFinish') {
      if (this.mode.finishError) throw new Error('target finish failed');
      if (this.mode.blockFinish) {
        this.mode.onFinishStart?.();
        return new Promise(resolve => { this.mode.resolveFinish = () => resolve(true); });
      }
      return true;
    }
    throw new Error(`unexpected target operation ${name}`);
  }

  async writeF64(name, args, values) {
    assert.equal(name, 'nativeAsyncTargetBuffer');
    this.writes.push({args: structuredClone(args), values: new Float64Array(values)});
    return true;
  }

  async close() {
    this.closed++;
  }
}

class FakePort {
  constructor(mode = {}) {
    this.mode = mode;
    this.calls = [];
    this.target = null;
    this.releases = 0;
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'nativePrepareBegin') {
      if (this.mode.deferBegin) return new Promise(resolve => { this.resolveBegin = () => resolve(JSON.stringify({ticket: TICKET, metadataJSON: '{"schema":"aster.prepare"}', buffers: [], checkpoints: []})); });
      return JSON.stringify({ticket: TICKET, metadataJSON: '{"schema":"aster.prepare"}', buffers: [], checkpoints: []});
    }
    if (name === 'nativeAsyncUIBegin') {
      if (this.mode.uiError) throw new Error('UI source changed');
      return HEADER;
    }
    if (name === 'nativeAsyncUINext') {
      this.uiIndex ??= 0;
      return UI_ROWS[this.uiIndex++];
    }
    if (name === 'nativeAsyncUICheck') {
      if (this.mode.uiCheckError) throw new Error('UI source stale');
      return true;
    }
    if (name === 'nativeAsyncRelease') {
      this.releases++;
      if (this.mode.releaseError) throw new Error('release response lost');
      return true;
    }
    throw new Error(`unexpected source operation ${name}`);
  }

  async createTargetActor() {
    this.target = new FakeTarget(this.mode);
    return this.target;
  }
}

const columns = length => Object.fromEntries(['time', 'open', 'high', 'low', 'close', 'volume'].map((name, slot) => [name, new Float64Array(Array.from({length}, (_, index) => slot * 10 + index))]));

test('seeded prepare uses exact source/target protocol and returns live candidate actor', async () => {
  const port = new FakePort();
  const progress = [];
  const result = await runRustPrepareJob(port, {kind: 'seeded', count: 4, seed: 7, options: {visibleBars: 3}}, {onProgress: value => progress.push(value)});
  assert.equal(result.status, 'target-ready');
  assert.equal(result.actor, port.target);
  assert.equal(port.target.writes.length, 0);
  assert.equal(port.target.closed, 0);
  assert.equal(port.releases, 1);
  assert.ok(progress.some(value => value.phase === 'calculate'));
  assert.deepEqual(port.calls.map(value => value.name), [
    'nativePrepareBegin', 'nativeAsyncUIBegin', 'nativeAsyncUINext', 'nativeAsyncUINext', 'nativeAsyncUINext',
    'nativeAsyncUICheck', 'nativeAsyncUICheck', 'nativeAsyncRelease',
  ]);
  assert.deepEqual(port.target.calls.map(value => value.name), [
    'nativePrepareCreate', 'nativeAsyncStart', 'nativeAsyncStep', 'nativeAsyncUIImportBegin',
    'nativeAsyncUIImportChunk', 'nativeAsyncUIImportChunk', 'nativeAsyncUIImportEnd', 'nativeAsyncFinish',
  ]);
});

test('columns are copied as owned chunks and caller arrays stay unchanged', async () => {
  const port = new FakePort();
  const input = columns(5);
  const before = Object.fromEntries(Object.entries(input).map(([key, values]) => [key, [...values]]));
  const result = await runRustPrepareJob(port, {kind: 'columns', columns: input, visibleBars: 2}, {chunkSize: 2});
  assert.equal(result.kind, 'columns');
  assert.equal(port.target.writes.length, 18);
  for (const [key, values] of Object.entries(input)) assert.deepEqual([...values], before[key]);
  assert.deepEqual(port.target.calls.find(value => value.name === 'nativePrepareCreate').args, ['{"schema":"aster.prepare"}']);
});

test('abort during isolated calculation closes target and releases source once', async () => {
  const port = new FakePort({blockStep: true});
  const controller = new AbortController();
  const promise = runRustPrepareJob(port, {kind: 'seeded', count: 4}, {signal: controller.signal, timeoutMs: 5000});
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(port.releases, 1);
  assert.equal(port.target.closed, 1);
});

test('late Begin response gets its real ticket released after cancellation', async () => {
  const port = new FakePort({deferBegin: true});
  const controller = new AbortController();
  const promise = runRustPrepareJob(port, {kind: 'seeded', count: 1}, {signal: controller.signal, timeoutMs: 5000});
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(port.releases, 0);
  port.resolveBegin();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(port.releases, 1);
  assert.deepEqual(port.calls.find(value => value.name === 'nativeAsyncRelease').args, [TICKET]);
});

test('UI source failure releases source and closes private target', async () => {
  const port = new FakePort({uiCheckError: true});
  await assert.rejects(runRustPrepareJob(port, {kind: 'seeded', count: 1}), /UI source stale/);
  assert.equal(port.releases, 1);
  assert.equal(port.target.closed, 1);
});

test('release transport loss is commit-uncertain, does not retry release, and closes unowned candidate', async () => {
  const port = new FakePort({releaseError: true});
  await assert.rejects(runRustPrepareJob(port, {kind: 'seeded', count: 1}), error => error instanceof RustPrepareCommitUncertainError);
  assert.equal(port.releases, 1);
  assert.equal(port.target.closed, 1);
});

test('final UI check runs after target finish and rejects a source mutation before release', async () => {
  const mode = {blockFinish: true};
  const port = new FakePort(mode);
  mode.onFinishStart = () => { mode.uiCheckError = true; };
  const promise = runRustPrepareJob(port, {kind: 'seeded', count: 1});
  while (!mode.resolveFinish) await new Promise(resolve => setTimeout(resolve, 1));
  mode.resolveFinish();
  await assert.rejects(promise, /UI source stale/);
  assert.equal(port.releases, 1);
  assert.equal(port.target.closed, 1);
});
