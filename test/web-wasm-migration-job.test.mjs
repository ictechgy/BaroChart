import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runRustMigrationJob,
  RustMigrationCommitUncertainError,
} from '../src/web/wasm/migration-job.mjs';

const TICKET = 41;
const REGISTRATION = 9;
const REVISION = 12;
const LENGTHS = [5, 5, 5, 5, 5, 5];
const METADATA = JSON.stringify({schema: 'aster.native-workspace', version: 1, length: 5, capacity: 5});
const UI_ROWS = [
  JSON.stringify({schema: 'aster.native-ui', version: 1, kind: 'state', value: {theme: 'dark'}}),
];

class FakeTarget {
  constructor(mode = {}) {
    this.mode = mode;
    this.calls = [];
    this.writes = [];
    this.closed = 0;
    this.aborted = 0;
    this.steps = 0;
    this.generation = 'candidate-1';
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'web.migrationTargetCreate') return true;
    if (name === 'web.migrationTargetStart') return true;
    if (name === 'web.migrationTargetStep') {
      this.steps++;
      if (this.mode.blockStep) return new Promise(() => {});
      return JSON.stringify({complete: true, done: 1, total: 1});
    }
    if (name === 'web.migrationTargetUiBegin') {
      if (this.mode.uiError) throw new Error('invalid UI proof');
      return true;
    }
    if (name === 'web.migrationTargetUiChunk') return true;
    if (name === 'web.migrationTargetUiFinish') {
      if (this.mode.finishError) throw new Error('target finish failed');
      return {schema: 'aster.web-ui-migration-ready', version: 1, status: 'target-ready'};
    }
    if (name === 'web.migrationTargetAbort') {
      this.aborted++;
      return true;
    }
    throw new Error(`unexpected target operation ${name}`);
  }

  async writeF64(name, args, values) {
    assert.equal(name, 'nativeAsyncTargetBuffer');
    this.calls.push({name, args: structuredClone(args)});
    if (this.mode.writeError) throw new Error('target buffer failed');
    this.writes.push(new Float64Array(values));
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
    this.aborts = 0;
    this.finishes = 0;
    this.activations = [];
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'web.migrationSourceBegin') {
      if (this.mode.deferBegin) return new Promise(resolve => { this.resolveBegin = () => resolve({ticket: TICKET, registration: REGISTRATION, phase: 'admission'}); });
      return {ticket: TICKET, registration: REGISTRATION, phase: 'admission'};
    }
    if (name === 'web.migrationSourceStep') return {
      complete: true,
      metadataJSON: METADATA,
      buffers: LENGTHS.map((length, slot) => ({slot, length})),
    };
    if (name === 'web.migrationSourceUiBegin') return {header: 'header-json', description: {schema: 'ui-proof', value: 1}};
    if (name === 'web.migrationSourceUiNext') return JSON.stringify({complete: true});
    if (name === 'web.migrationSourceCheck') {
      if (this.mode.stale) throw new Error('source became stale');
      return true;
    }
    if (name === 'web.migrationSourceFinish') {
      this.finishes++;
      if (this.mode.sourceFinishError) throw new Error('source finish transport lost');
      return {status: 'finished', ticket: TICKET};
    }
    if (name === 'web.migrationSourceAbort') {
      this.aborts++;
      return true;
    }
    throw new Error(`unexpected source operation ${name}`);
  }

  async readF64(name, args) {
    assert.equal(name, 'nativeAsyncBuffer');
    const [, slot, offset, count] = args;
    return new Float64Array(Array.from({length: count}, (_, index) => slot * 100 + offset + index));
  }

  async createTargetActor() {
    this.target = new FakeTarget(this.mode);
    return this.target;
  }

  nextRegistration() { return REGISTRATION; }
  revision() { return this.mode.revision ?? REVISION; }
}

const fixture = () => ({document: JSON.stringify({schema: 'aster.workspace', version: 1, series: ['s'], values: [1, 2]}), binding: {key: 'chart', revision: 'r1'}});

test('migration transfers workspace columns and UI to an isolated actor, then returns the candidate', async () => {
  const port = new FakePort();
  const progress = [];
  const result = await runRustMigrationJob(port, fixture().document, fixture().binding, {
    chunkSize: 2,
    onProgress: value => progress.push(value),
  });

  assert.equal(result.status, 'target-ready');
  assert.equal(result.candidate.actor, port.target);
  assert.equal(port.target.closed, 0);
  assert.equal(port.target.aborted, 0);
  assert.equal(port.target.writes.length, 18);
  assert.equal(port.finishes, 1);
  assert.equal(port.aborts, 0);
  assert.ok(progress.some(value => value.stage === 'input-transfer'));
  assert.ok(progress.some(value => value.stage === 'target-ready'));
  assert.equal(port.calls.filter(value => value.name === 'web.migrationSourceCheck').length, 2);
  assert.deepEqual(result.candidate.description, {schema: 'ui-proof', value: 1});
});

test('abort during target calculation releases source and private target without retrying', async () => {
  const port = new FakePort({blockStep: true});
  const controller = new AbortController();
  const promise = runRustMigrationJob(port, fixture().document, fixture().binding, {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(port.aborts, 1);
  assert.equal(port.target.aborted, 1);
  assert.equal(port.target.closed, 1);
  assert.equal(port.finishes, 0);
});

test('stale source is rejected before target publication and source cleanup is attempted once', async () => {
  const port = new FakePort({stale: true});
  await assert.rejects(runRustMigrationJob(port, fixture().document, fixture().binding), /source became stale/);
  assert.equal(port.aborts, 1);
  assert.equal(port.target, null);
  assert.equal(port.finishes, 0);
});

test('target proof failure aborts and closes the candidate actor', async () => {
  const port = new FakePort({uiError: true});
  await assert.rejects(runRustMigrationJob(port, fixture().document, fixture().binding), /invalid UI proof/);
  assert.equal(port.aborts, 1);
  assert.equal(port.target.aborted, 1);
  assert.equal(port.target.closed, 1);
});

test('activation runs only after source finish and receives the opaque actor', async () => {
  const port = new FakePort();
  const order = [];
  const result = await runRustMigrationJob(port, fixture().document, {...fixture().binding}, {
    activate: async candidate => {
      order.push('activate');
      assert.equal(candidate.actor, port.target);
      assert.equal(port.finishes, 1);
      return {generation: candidate.generation};
    },
  });
  order.push('done');
  assert.deepEqual(order, ['activate', 'done']);
  assert.deepEqual(result.activation, {generation: 'candidate-1'});
  assert.equal(port.target.closed, 0);
});

test('source finish transport loss is commit-uncertain and never replays source abort', async () => {
  const port = new FakePort({sourceFinishError: true});
  await assert.rejects(
    runRustMigrationJob(port, fixture().document, fixture().binding),
    error => error instanceof RustMigrationCommitUncertainError && error.commitUncertain === true,
  );
  assert.equal(port.aborts, 0);
  assert.equal(port.target.closed, 1);
});

test('activation failure closes an unowned candidate, while explicit handoff retains it', async () => {
  const rejected = new FakePort();
  await assert.rejects(
    runRustMigrationJob(rejected, fixture().document, fixture().binding, {
      activate() { throw new Error('activation failed before ownership'); },
    }),
    error => error instanceof RustMigrationCommitUncertainError,
  );
  assert.equal(rejected.target.closed, 1);

  const handed = new FakePort();
  await assert.rejects(
    runRustMigrationJob(handed, fixture().document, fixture().binding, {
      activate(candidate) {
        candidate.handoff();
        throw new Error('activation failed after ownership');
      },
    }),
    error => error instanceof RustMigrationCommitUncertainError,
  );
  assert.equal(handed.target.closed, 0);
});

test('workspace input is the bounded nativeSaveWorkspace JSON string', async () => {
  const port = new FakePort();
  await assert.rejects(runRustMigrationJob(port, {series: []}, {key: 'chart'}), /bounded JSON string/);
});

test('late SourceBegin response is ticket-aborted exactly once after cancellation', async () => {
  const port = new FakePort({deferBegin: true, revision: 1});
  const controller = new AbortController();
  const promise = runRustMigrationJob(port, fixture().document, fixture().binding, {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(port.aborts, 0);
  port.resolveBegin();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(port.aborts, 1);
  assert.deepEqual(port.calls.filter(value => value.name === 'web.migrationSourceAbort')[0].args, [TICKET]);
});
