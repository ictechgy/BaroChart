import assert from 'node:assert/strict';
import test from 'node:test';
import {safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';
import {loadRustBackend} from '../src/web/wasm/backend.mjs';

const wasmModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
const WEB_OPERATIONS = [
  'web.capabilities', 'web.presentationState', 'web.configuration', 'web.drawingsState',
  'web.indicatorCatalog', 'web.layoutCapture','web.layoutReferences', 'web.applyLayoutFrame',
  ...['Begin', 'Step', 'Check', 'Receive', 'ArmWrite', 'Checkpoint', 'Validate', 'Prepare', 'Publish', 'Status', 'Abort']
    .map(suffix => `web.paramsSource${suffix}`),
  ...['Begin', 'Step', 'UiBegin', 'UiNext', 'Check', 'Finish', 'Abort']
    .map(suffix => `web.migrationSource${suffix}`),
  ...['Create', 'Start', 'Step', 'UiBegin', 'UiChunk', 'UiFinish', 'Abort']
    .map(suffix => `web.migrationTarget${suffix}`),
];
const CORE_OPERATIONS = [
  'nativeInit', 'nativeCommand', 'nativeScenePacket', 'nativeSaveWorkspace',
  'nativePrepareBegin', 'nativePrepareCreate', 'nativeAsyncBuffer', 'nativeAsyncTargetBuffer',
  'nativeAsyncStart', 'nativeAsyncStep', 'nativeAsyncUIBegin', 'nativeAsyncUINext',
  'nativeAsyncUICheck', 'nativeAsyncUIImportBegin', 'nativeAsyncUIImportChunk',
  'nativeAsyncUIImportEnd', 'nativeAsyncFinish', 'nativeAsyncRelease',
  'nativeParamsTargetCreate', 'nativeParamsTargetStart', 'nativeParamsTargetStep',
  'nativeParamsTargetDescriptor', 'nativeParamsTargetCheckpoint',
  'nativeWorkspaceTargetCreate', 'nativeWorkspaceTargetFinish',
];
const CAPABILITIES = Object.freeze({
  schema: 'aster.web-wasm.capabilities', version: 1, abiVersion: 1, transfer: 'f64-le',
  packetVersion: 1, maxTransfer: 262144, typedReads: ['web.dataColumn'],
  implemented: [...WEB_OPERATIONS, ...CORE_OPERATIONS], unavailable: [],
});
const PRESENTATION = Object.freeze({
  schema: 'aster.web-wasm.presentation', version: 1,
  data: {length: 0, capacity: 16, version: 1, timeVersion: 1},
  view: {from: 0, to: 0, follow: true},
  configuration: {panels: 1, axes: 1, series: 1, indicators: 0},
  drawings: {count: 0, selected: null, canUndo: false, canRedo: false, serial: 0},
  interaction: {tool: 'select', text: '', gestureKind: null, pointerCount: 0, crosshair: null, crosshairSnap: null, drawingTarget: null, drawingMagnet: null},
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeWorker {
  static mode = {};
  static instances = [];

  constructor() {
    if (FakeWorker.mode.constructError) throw new Error(FakeWorker.mode.constructError);
    this.mode = FakeWorker.mode;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    this.closed = false;
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'init') {
      if (this.mode.holdInit) return;
      this.reply({type: 'ready', capabilities: CAPABILITIES}, message);
      return;
    }
    if (message.type === 'close') {
      this.closed = true;
      this.reply({type: 'closed'}, message);
      return;
    }
    if (message.type !== 'rpc') return;
    const name = message.name;
    if (this.mode.holdNativeInit && name === 'nativeInit') return;
    if (this.mode.holdInitialResync && name === 'web.presentationState' && this.messages.some(item => item.type === 'rpc' && item.name === 'nativeInit')) return;
    if (this.mode.workspaceError && name === 'nativeAsyncStep') {
      this.replyError(new Error('workspace step failed'), message);
      return;
    }
    if (this.mode.migrationError && name === 'web.migrationTargetStep') {
      this.replyError(new Error('migration step failed'), message);
      return;
    }
    let value = null;
    if (name === 'web.capabilities') value = CAPABILITIES;
    else if (name === 'web.presentationState') value = PRESENTATION;
    else if (name === 'nativeAsyncStep' || name === 'web.migrationTargetStep') value = {complete: true, phase: 'ready', done: 1, total: 1};
    else if (name === 'nativeAsyncTargetBuffer' || name === 'nativeWorkspaceTargetCreate' || name === 'nativeWorkspaceTargetFinish') value = true;
    else if (message.method === 'writeF64') value = true;
    else if (name === 'nativeSaveWorkspace') value = '{}';
    this.reply({type: 'result', value}, message);
  }

  reply(payload, request) {
    queueMicrotask(() => this.emit({data: {protocol: 1, generation: request.generation, id: request.id, ...payload}}));
  }

  replyError(error, request) {
    this.reply({type: 'error', error: {name: error.name, message: error.message, code: 'FAKE', phase: 'rpc', quarantine: false}}, request);
  }

  emit(event) {
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }

  terminate() { this.terminated = true; }
}

async function withWorker(mode, callback) {
  const previous = globalThis.Worker;
  FakeWorker.mode = mode;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  try { return await callback(); }
  finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
}

function columns(length = 1) {
  return Object.fromEntries(FIELDS.map((field, slot) => [field, Float64Array.from({length}, (_, index) => slot * 100 + index + 1)]));
}

function binding() {
  return {key: 'barochart:test', revision: '1', adjustmentVersion: 'raw-v1', priceUnit: 'USD', adjustment: 'raw'};
}

function workspaceInput({length = 1, source, size = {width: 640, height: 360}} = {}) {
  return {
    columns: columns(length), document: '{}', binding: binding(),
    source: source ?? {
      length, maxBars: 4096, timeframeMs: 900000, timeOrigin: 1700000000000,
      version: 7, timeVersion: 9,
    },
    size,
  };
}

test('backend reports a typed worker creation failure without leaking a Worker', async () => {
 await withWorker({constructError: 'worker constructor failed'}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  await assert.rejects(backend.createSession(), error => error.message === 'worker constructor failed');
  assert.equal(FakeWorker.instances.length, 0);
 });
});

for (const [label, mode] of [['nativeInit', {holdNativeInit: true}], ['initial resync', {holdInitialResync: true}]]) {
 test(`createSession aborts during ${label} and closes its actor`, async () => {
  await withWorker(mode, async () => {
   const backend = await loadRustBackend({source: wasmModule});
   const controller = new AbortController();
   const pending = backend.createSession({signal: controller.signal});
   await tick();
   controller.abort();
   await assert.rejects(pending, error => error.name === 'AbortError');
   assert.equal(FakeWorker.instances.length, 1);
   assert.equal(FakeWorker.instances[0].closed, true);
   assert.equal(FakeWorker.instances[0].terminated, true);
  });
 });
}

test('each session receives a distinct Worker and closes independently', async () => {
 await withWorker({}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  const first = await backend.createSession();
  const second = await backend.createSession();
  assert.notEqual(first.generation, second.generation);
  assert.equal(FakeWorker.instances.length, 2);
  await first.close();
  assert.equal(FakeWorker.instances[0].closed, true);
  assert.equal(FakeWorker.instances[1].closed, false);
  await second.close();
  assert.equal(FakeWorker.instances[1].closed, true);
 });
});

test('workspace creation snapshots caller columns and returns an independent session', async () => {
 await withWorker({}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  const input = workspaceInput(), source = input.columns;
  const before = Object.fromEntries(FIELDS.map(field => [field, source[field][0]]));
  const session = await backend.createSessionFromWorkspace(input);
  for (const field of FIELDS) assert.equal(source[field][0], before[field]);
  assert.equal(session.backend, 'rust-wasm');
  assert.equal(FakeWorker.instances.length, 1);
  const createMessage = FakeWorker.instances[0].messages.find(message => message.type === 'rpc' && message.name === 'nativeWorkspaceTargetCreate');
  assert.ok(createMessage);
  const descriptor = JSON.parse(createMessage.args[0]);
  assert.deepEqual(descriptor.source, input.source);
  assert.deepEqual(descriptor.size, input.size);
  await session.close();
 });
});

test('workspace source metadata preserves a signed-zero origin on the checkpoint wire',async()=>{
 await withWorker({},async()=>{
  const backend=await loadRustBackend({source:wasmModule}),input=workspaceInput();input.source.timeOrigin=-0;
  const session=await backend.createSessionFromWorkspace(input);
  const sent=FakeWorker.instances[0].messages.find(message=>message.name==='nativeWorkspaceTargetCreate');
  assert.equal(Object.is(safeCheckpointParse(sent.args[0]).source.timeOrigin,-0),true);
  assert.equal(Object.is(input.source.timeOrigin,-0),true);await session.close();
 });
});

test('workspace and migration input accessors are rejected before a Worker is created', async () => {
 await withWorker({}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  const input = workspaceInput();
  Object.defineProperty(input, 'source', {get() { throw new Error('must not invoke source getter'); }});
  await assert.rejects(backend.createSessionFromWorkspace(input), /own data|source|Workspace/i);
  const capture = {metadataJSON: '{}', header: '{}', description: binding(), uiChunks: [], columns: columns(1)};
  Object.defineProperty(capture, 'metadataJSON', {get() { throw new Error('must not invoke'); }});
  await assert.rejects(backend.createSessionFromMigration(capture), /own data|capture/i);
  assert.equal(FakeWorker.instances.length, 0);
 });
});

test('invalid workspace source metadata is rejected before Worker creation', async () => {
 await withWorker({}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  await assert.rejects(backend.createSessionFromWorkspace(workspaceInput({source: {
   length: 1, maxBars: 4096, timeframeMs: 0, timeOrigin: 1700000000000, version: 7, timeVersion: 9,
  }})), /source|timeframe/i);
  await assert.rejects(backend.createSessionFromWorkspace(workspaceInput({source: {
   length: 2, maxBars: 4096, timeframeMs: 900000, timeOrigin: 1700000000000, version: 7, timeVersion: 9,
  }})), /source|length/i);
  assert.equal(FakeWorker.instances.length, 0);
 });
});

test('workspace target errors close the candidate Worker', async () => {
 await withWorker({workspaceError: true}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  await assert.rejects(backend.createSessionFromWorkspace(workspaceInput()), /workspace step failed/i);
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].closed, true);
  assert.equal(FakeWorker.instances[0].terminated, true);
 });
});

test('workspace creation abort during transfer closes the candidate Worker', async () => {
 await withWorker({}, async () => {
  const backend = await loadRustBackend({source: wasmModule});
  const controller = new AbortController();
  const pending = backend.createSessionFromWorkspace({
   ...workspaceInput(), signal: controller.signal,
   onProgress(progress) { if (progress.phase === 'transfer') controller.abort(); },
  });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].closed, true);
  assert.equal(FakeWorker.instances[0].terminated, true);
 });
});
