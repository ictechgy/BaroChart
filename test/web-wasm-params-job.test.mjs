import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runRustParamsJob,
  RustParamsCommitUncertainError,
  RustParamsResyncRequiredError,
} from '../src/web/wasm/params-job.mjs';

const ID = 's';
const REVISION = 3;
const REGISTRATION = 7;
const TICKET = 11;
const META = Object.freeze({
  schema: 'aster.native-params-target',
  version: 1,
  registration: REGISTRATION,
  id: ID,
  name: 'ema',
  params: {period: 9},
  length: 3,
  capacity: 16,
  outputs: ['value'],
  plotOffsets: {value: 0},
  maxBytes: 805_306_368,
});
const DESCRIPTOR = Object.freeze({
  schema: 'aster.native-params-result',
  version: 1,
  registration: REGISTRATION,
  id: ID,
  name: 'ema',
  params: {period: 9},
  length: 3,
  capacity: 16,
  outputs: ['value'],
  plotOffsets: {value: 0},
  checkpointCount: 1,
});

const sourceColumns = Array.from({length: 6}, (_, slot) => new Float64Array([slot + 1, slot + 2, slot + 3]));

class FakeTarget {
  constructor(mode = {}) {
    this.mode = mode;
    this.calls = [];
    this.writes = [];
    this.closed = 0;
    this.disposed = 0;
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'nativeParamsTargetCreate') return true;
    if (name === 'nativeParamsTargetStart') return true;
    if (name === 'nativeParamsTargetStep') {
      if (this.mode.blockStep) return new Promise(() => {});
      return {phase: 'ready', done: 1, total: 1, complete: true};
    }
    if (name === 'nativeParamsTargetDescriptor') return JSON.stringify(DESCRIPTOR);
    if (name === 'nativeParamsTargetCheckpoint') return {index: 0, text: '{"at":0}'};
    if (name === 'nativeParamsTargetDispose') {
      this.disposed++;
      return true;
    }
    throw new Error(`unexpected target call ${name}`);
  }

  async readF64(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    assert.equal(name, 'nativeAsyncBuffer');
    const [, slot, offset, count] = args;
    return new Float64Array(Array.from({length: count}, (_, index) => 100 + slot * 10 + offset + index));
  }

  async writeF64(name, args, values) {
    this.calls.push({name, args: structuredClone(args)});
    assert.equal(name, 'nativeAsyncTargetBuffer');
    this.writes.push(new Float64Array(values));
    if (this.mode.writeFalse) return false;
    // Mutating the received view must not mutate the source read result.
    values.fill(-999);
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
    this.reads = [];
    this.writes = [];
    this.target = null;
    this.committedReceipts = [];
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'web.paramsSourceBegin') {
      if (this.mode.badBegin) return {ticket: TICKET, phase: 'admission'};
      return {ticket: TICKET, registration: REGISTRATION, phase: this.mode.noop ? 'noop' : 'admission'};
    }
    if (name === 'web.paramsSourceStep') {
      if (this.mode.badMetadata) return {phase: 'copy', complete: true, metadataJSON: '{bad'};
      if (this.mode.noop) return {phase: 'noop', complete: true};
      return {phase: 'copy', complete: true, metadataJSON: JSON.stringify(META)};
    }
    if (name === 'web.paramsSourceCheck') {
      if (this.mode.stale) {
        const error = new Error('Native params stale: source/owner changed');
        error.name = 'StaleSourceError';
        throw error;
      }
      return true;
    }
    if (name === 'web.paramsSourceReceive' || name === 'web.paramsSourceArmWrite'
      || name === 'web.paramsSourceCheckpoint' || name === 'web.paramsSourcePrepare') return true;
    if (name === 'web.paramsSourceValidate') return {phase: 'validate', done: 1, total: 1, complete: true};
    if (name === 'web.paramsSourcePublish') {
      if (this.mode.publishError) throw new Error('lost publish response');
      return {status: 'committed', registration: REGISTRATION, id: ID, outputs: ['value']};
    }
    if (name === 'web.paramsSourceAbort') {
      this.aborted = (this.aborted ?? 0) + 1;
      return {status: 'aborted'};
    }
    throw new Error(`unexpected source call ${name}`);
  }

  async readF64(name, args) {
    this.reads.push({name, args: structuredClone(args)});
    assert.equal(name, 'nativeAsyncBuffer');
    const [, slot, offset, count] = args;
    // Return a view into the caller-owned source array. The coordinator must
    // copy it before sending it to the target actor.
    return sourceColumns[slot].subarray(offset, offset + count);
  }

  async writeF64(name, args, values) {
    this.writes.push({name, args: structuredClone(args), values: new Float64Array(values)});
    assert.equal(name, 'nativeAsyncTargetBuffer');
    return true;
  }

  async createTargetActor() {
    this.target = new FakeTarget(this.mode);
    return this.target;
  }

  nextRegistration() { return REGISTRATION; }
  revision() { return REVISION; }

  async committed(receipt) {
    this.committedReceipts.push(receipt);
    if (this.mode.committedError) throw new Error('UI publication failed');
  }
}

function sourceNames(port) {
  return port.calls.map(call => call.name);
}

class BlockedBeginPort extends FakePort {
  constructor() {
    super();
    this.blockBegin = true;
    this.registrationValue = REGISTRATION;
    this.beginStarted = new Promise(resolve => { this.resolveBeginStarted = resolve; });
    this.releaseBegin = null;
  }

  nextRegistration() { return this.registrationValue; }

  async call(name, args = []) {
    if (name === 'web.paramsSourceBegin' && this.blockBegin) {
      this.calls.push({name, args: structuredClone(args)});
      this.resolveBeginStarted();
      return new Promise(resolve => { this.releaseBegin = () => resolve({ticket: TICKET, registration: args[4], phase: 'noop'}); });
    }
    if (name === 'web.paramsSourceBegin' && !this.blockBegin) {
      this.calls.push({name, args: structuredClone(args)});
      return {ticket: TICKET + 1, registration: args[4], phase: 'noop'};
    }
    return super.call(name, args);
  }
}

test('NativeParams coordinator uses two actors, bounded copies and one commit callback', async () => {
  const port = new FakePort();
  const originalParams = {period: 9, nested: {enabled: true}};
  const progress = [];
  const receipt = await runRustParamsJob(port, ID, originalParams, {
    chunkSize: 2,
    stepSize: 2,
    onProgress: value => progress.push(value),
  });

  assert.equal(receipt.status, 'committed');
  assert.deepEqual(originalParams, {period: 9, nested: {enabled: true}});
  assert.equal(port.committedReceipts.length, 1);
  assert.equal(port.aborted ?? 0, 0);
  assert.equal(port.target.disposed, 1);
  assert.equal(port.target.closed, 1);
  assert.equal(port.writes.length, 8);
  assert.ok(progress.some(value => value.stage === 'input-transfer'));
  assert.ok(progress.some(value => value.stage === 'target-calculation'));
  assert.ok(progress.some(value => value.stage === 'source-validation'));
  const names = sourceNames(port);
  assert.deepEqual(names.slice(0, 4), [
    'web.paramsSourceBegin', 'web.paramsSourceStep', 'web.paramsSourceCheck',
    'web.paramsSourceReceive',
  ]);
  assert.equal(names.filter(name => name === 'web.paramsSourceArmWrite').length, 8);
  assert.deepEqual(names.slice(-4), [
    'web.paramsSourceCheckpoint', 'web.paramsSourceValidate',
    'web.paramsSourcePrepare', 'web.paramsSourcePublish',
  ]);
  // FakeTarget mutates its write input. The source-owned views must remain intact.
  assert.deepEqual([...sourceColumns[0]], [1, 2, 3]);
});

test('stale source aborts once and never creates a target actor', async () => {
  const port = new FakePort({stale: true});
  await assert.rejects(
    runRustParamsJob(port, ID, {period: 9}),
    error => error.name === 'StaleSourceError',
  );
  assert.equal(port.aborted, 1);
  assert.equal(port.target, null);
});

test('blocked SourceBegin is abortable, ignores its late reply, and permits the next begin', async () => {
  const port = new BlockedBeginPort();
  const controller = new AbortController();
  const blocked = runRustParamsJob(port, ID, {period: 9}, {signal: controller.signal, timeoutMs: 5_000});
  await port.beginStarted;
  controller.abort();
  await assert.rejects(blocked, error => error.name === 'AbortError');
  assert.equal(port.aborted, 1);

  // The actor may deliver the old Begin reply after Abort has been queued.
  port.releaseBegin();
  port.blockBegin = false;
  port.mode.noop = true;
  port.registrationValue = REGISTRATION + 1;
  const next = await runRustParamsJob(port, ID, {period: 9});
  assert.equal(next.status, 'committed');
  assert.equal(port.aborted, 1);
});

test('malformed SourceBegin still aborts the registration-scoped source once', async () => {
  const port = new FakePort({badBegin: true});
  await assert.rejects(runRustParamsJob(port, ID, {period: 9}), /registration mismatch/);
  assert.equal(port.aborted, 1);
});

test('malformed metadata and rejected writes clean both runtimes exactly once', async () => {
  const malformed = new FakePort({badMetadata: true});
  await assert.rejects(runRustParamsJob(malformed, ID, {period: 9}), /Malformed Native params metadata/);
  assert.equal(malformed.aborted, 1);
  assert.equal(malformed.target, null);

  const rejected = new FakePort({writeFalse: true});
  await assert.rejects(runRustParamsJob(rejected, ID, {period: 9}, {chunkSize: 2}), /write was not acknowledged/);
  assert.equal(rejected.aborted, 1);
  assert.equal(rejected.target.disposed, 1);
  assert.equal(rejected.target.closed, 1);
});

test('abort during an isolated calculation does not hang and disposes private actor', async () => {
  const port = new FakePort({blockStep: true});
  const controller = new AbortController();
  const job = runRustParamsJob(port, ID, {period: 9}, {signal: controller.signal, timeoutMs: 5_000});
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(job, error => error.name === 'AbortError');
  assert.equal(port.aborted, 1);
  assert.equal(port.target.disposed, 1);
  assert.equal(port.target.closed, 1);
});

test('publish transport failure is commit-uncertain and never auto-aborts', async () => {
  const port = new FakePort({publishError: true});
  await assert.rejects(
    runRustParamsJob(port, ID, {period: 9}),
    error => error instanceof RustParamsCommitUncertainError && error.commitUncertain === true,
  );
  assert.equal(port.aborted ?? 0, 0);
  assert.equal(port.target.disposed, 1);
  assert.equal(port.target.closed, 1);
});

test('UI publication failure after Rust commit requests resync without rollback', async () => {
  const port = new FakePort({committedError: true});
  await assert.rejects(
    runRustParamsJob(port, ID, {period: 9}),
    error => error instanceof RustParamsResyncRequiredError && error.resyncRequired === true,
  );
  assert.equal(port.aborted ?? 0, 0);
  assert.equal(port.committedReceipts.length, 1);
});

test('no-op publication skips isolated target but still uses source ledger', async () => {
  const port = new FakePort({noop: true});
  const receipt = await runRustParamsJob(port, ID, {period: 9});
  assert.equal(receipt.status, 'committed');
  assert.equal(port.target, null);
  assert.equal(sourceNames(port).includes('web.paramsSourcePrepare'), true);
  assert.equal(port.aborted ?? 0, 0);
});
