import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runRustCaptureJob,
  RustCaptureCommitUncertainError,
} from '../src/web/wasm/capture-job.mjs';

const TICKET = 71;
const REGISTRATION = 13;
const REVISION = 4;
const LENGTH = 4;
const METADATA = JSON.stringify({schema: 'aster.workspace', version: 1, length: LENGTH, capacity: LENGTH});
const BINDING = {key: 'capture', revision: 'r1'};

class FakePort {
  constructor(mode = {}) {
    this.mode = mode;
    this.calls = [];
    this.reads = [];
    this.aborts = 0;
    this.finishes = 0;
    this.active = false;
  }

  async call(name, args = []) {
    this.calls.push({name, args: structuredClone(args)});
    if (name === 'web.migrationSourceBegin') {
      if (this.mode.deferBegin) return new Promise(resolve => { this.resolveBegin = () => resolve({ticket: TICKET, registration: REGISTRATION, phase: 'admission'}); });
      this.active = true;
      return {ticket: TICKET, registration: REGISTRATION, phase: 'admission'};
    }
    if (name === 'web.migrationSourceStep') return {
      complete: true,
      metadataJSON: METADATA,
      buffers: Array.from({length: 6}, (_, slot) => ({slot, length: LENGTH})),
    };
    if (name === 'web.migrationSourceUiBegin') return {header: 'header-json', description: {schema: 'ui-proof', revision: REVISION}};
    if (name === 'web.migrationSourceUiNext') return JSON.stringify({complete: true});
    if (name === 'web.migrationSourceCheck') {
      if (this.mode.stale) throw new Error('source changed during consume');
      return true;
    }
    if (name === 'web.migrationSourceFinish') {
      this.finishes++;
      if (this.mode.finishError) throw new Error('finish response lost');
      this.active = false;
      return {status: 'finished', ticket: TICKET};
    }
    if (name === 'web.migrationSourceAbort') {
      this.aborts++;
      this.active = false;
      return true;
    }
    throw new Error(`unexpected source call ${name}`);
  }

  async readF64(name, args) {
    assert.equal(name, 'nativeAsyncBuffer');
    assert.equal(this.active, true);
    const [, slot, offset, count] = args;
    this.reads.push({slot, offset, count});
    if (this.mode.blockRead) return new Promise(() => {});
    return new Float64Array(Array.from({length: count}, (_, index) => slot * 10 + offset + index));
  }

  nextRegistration() { return REGISTRATION; }
  revision() { return REVISION; }
}

const candidate = () => {
  let disposed = 0;
  return {value: {id: 'candidate'}, dispose() { disposed++; }, get disposed() { return disposed; }};
};

const closeOnly = () => {
  let closed = 0;
  return {close() { closed++; }, get closed() { return closed; }};
};

const bothCandidate = () => {
  let disposed = 0;
  let closed = 0;
  return {
    dispose() { disposed++; },
    close() { closed++; },
    get disposed() { return disposed; },
    get closed() { return closed; },
  };
};

test('capture copies six bounded columns and runs consume before final check/finish', async () => {
  const port = new FakePort();
  let consumed;
  const result = await runRustCaptureJob(port, JSON.stringify({schema: 'aster.workspace', version: 1}), BINDING, {
    chunkSize: 2,
    consume: async capture => {
      consumed = capture;
      assert.equal(port.active, true);
      return {id: 'js-target'};
    },
  });
  assert.equal(result.status, 'captured');
  assert.equal(result.capture.length, LENGTH);
  assert.equal(port.reads.length, 12);
  assert.deepEqual([...result.capture.columns.close], [40, 41, 42, 43]);
  assert.equal(consumed, result.capture);
  const names = port.calls.map(call => call.name);
  assert.deepEqual(names.slice(-2), ['web.migrationSourceCheck', 'web.migrationSourceFinish']);
  assert.equal(port.aborts, 0);
});

test('consume mutation is rejected by final source check and disposes the unowned JS candidate', async () => {
  const port = new FakePort();
  const owned = candidate();
  await assert.rejects(
    runRustCaptureJob(port, '{}', BINDING, {
      consume() {
        port.mode.stale = true;
        return owned;
      },
    }),
    /source changed during consume/,
  );
  assert.equal(owned.disposed, 1);
  assert.equal(port.aborts, 1);
  assert.equal(port.finishes, 0);
});

test('late SourceBegin response is aborted by its real ticket exactly once', async () => {
  const port = new FakePort({deferBegin: true});
  const controller = new AbortController();
  const promise = runRustCaptureJob(port, '{}', BINDING, {signal: controller.signal, consume: () => null, timeoutMs: 5000});
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(port.aborts, 0);
  port.resolveBegin();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(port.aborts, 1);
  assert.deepEqual(port.calls.find(call => call.name === 'web.migrationSourceAbort').args, [TICKET]);
});

test('finish response loss does not retry abort and disposes the unowned candidate', async () => {
  const port = new FakePort({finishError: true});
  const owned = candidate();
  await assert.rejects(
    runRustCaptureJob(port, '{}', BINDING, {consume: () => owned}),
    error => error instanceof RustCaptureCommitUncertainError,
  );
  assert.equal(port.finishes, 1);
  assert.equal(port.aborts, 0);
  assert.equal(owned.disposed, 1);
});

test('activation handoff keeps a candidate after activation uncertainty', async () => {
  const port = new FakePort();
  const owned = candidate();
  await assert.rejects(
    runRustCaptureJob(port, '{}', BINDING, {
      consume: () => owned,
      activate(candidateValue) {
        candidateValue.handoff();
        throw new Error('activation failed after handoff');
      },
    }),
    error => error instanceof RustCaptureCommitUncertainError,
  );
  assert.equal(owned.disposed, 0);
});

test('activation failure before handoff disposes the candidate after source finish', async () => {
  const port = new FakePort();
  const owned = candidate();
  await assert.rejects(
    runRustCaptureJob(port, '{}', BINDING, {
      consume: () => owned,
      activate() { throw new Error('activation failed before handoff'); },
    }),
    error => error instanceof RustCaptureCommitUncertainError,
  );
  assert.equal(owned.disposed, 1);
});

test('close-only candidates are closed after final-check failure and finish response loss', async () => {
  const stalePort = new FakePort();
  const stale = closeOnly();
  await assert.rejects(runRustCaptureJob(stalePort, '{}', BINDING, {
    consume() { stalePort.mode.stale = true; return stale; },
  }), /source changed during consume/);
  assert.equal(stale.closed, 1);

  const finishPort = new FakePort({finishError: true});
  const lost = closeOnly();
  await assert.rejects(runRustCaptureJob(finishPort, '{}', BINDING, {consume: () => lost}), RustCaptureCommitUncertainError);
  assert.equal(lost.closed, 1);
});

test('late consume result after abort closes a close-only candidate', async () => {
  const port = new FakePort();
  const controller = new AbortController();
  const owned = closeOnly();
  let release;
  let started = false;
  const promise = runRustCaptureJob(port, '{}', BINDING, {
    signal: controller.signal,
    consume() {
      started = true;
      return new Promise(resolve => { release = () => resolve(owned); });
    },
  });
  while (!started) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(owned.closed, 1);
});

test('dispose is preferred over close and each cleanup operation runs once', async () => {
  const port = new FakePort({finishError: true});
  const owned = bothCandidate();
  await assert.rejects(runRustCaptureJob(port, '{}', BINDING, {consume: () => owned}), RustCaptureCommitUncertainError);
  assert.equal(owned.disposed, 1);
  assert.equal(owned.closed, 0);
});
