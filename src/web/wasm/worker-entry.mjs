import {instantiateRustRuntime} from './runtime.mjs';

const PROTOCOL_VERSION = 1;
const scope = globalThis;
let generation = null;
let runtime = null;
let queue = Promise.resolve();

function serializedError(error, phase = 'rpc', quarantine = false) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'RustActorError',
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    status: error?.status ?? null,
    phase,
    quarantine: quarantine || error?.quarantined === true || error?.quarantine === true,
  };
}

function reply(message, transfer = []) {
  if (transfer.length) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

function fail(message, error, phase = 'rpc', fatal = false) {
  reply({protocol: PROTOCOL_VERSION, generation: message.generation ?? generation, id: message.id, type: 'error', error: serializedError(error, phase, fatal), quarantine: fatal});
}

async function dispatch(message) {
  if (!message || message.protocol !== PROTOCOL_VERSION || !Number.isSafeInteger(message.id) || message.id <= 0) {
    throw new Error('Invalid Rust actor protocol message');
  }
  if (message.type === 'init') {
    if (runtime || generation !== null) throw new Error('Rust actor is already initialized');
    if (typeof message.generation !== 'string' || !(message.module instanceof WebAssembly.Module)) throw new Error('Rust actor init requires a generation and WebAssembly.Module');
    generation = message.generation;
    try {
      runtime = instantiateRustRuntime(message.module, {requiredOperations: message.requiredOperations});
      reply({protocol: PROTOCOL_VERSION, generation, id: message.id, type: 'ready', capabilities: runtime.capabilities()});
    } catch (error) {
      generation = null;
      runtime = null;
      fail(message, error, 'init', true);
    }
    return;
  }
  if (message.generation !== generation || !runtime) { fail(message, new Error('Rust actor generation is not active'), 'protocol', true); return; }
  if (message.type === 'close') {
    try { runtime.close(); runtime = null; reply({protocol: PROTOCOL_VERSION, generation, id: message.id, type: 'closed'}); }
    catch (error) { fail(message, error, 'close', true); }
    return;
  }
  if (message.type !== 'rpc' || typeof message.method !== 'string') { fail(message, new Error('Unknown Rust actor request'), 'protocol', true); return; }
  try {
    let value;
    let transfer = [];
    if (message.method === 'call') value = runtime.call(message.name, message.args ?? [], message.flags ?? 1);
    else if (message.method === 'readF64') value = runtime.readF64(message.name, message.args ?? [], message.flags ?? 1);
    else if (message.method === 'writeF64') value = runtime.writeF64(message.name, message.args ?? [], message.values, message.flags ?? 1);
    else if (message.method === 'packet') value = runtime.packet(message.args ?? []);
    else if (message.method === 'capabilities') value = runtime.capabilities();
    else if (message.method === 'memoryStats') value = runtime.memoryStats();
    else throw new Error(`Unknown Rust actor method: ${message.method}`);
    if (value instanceof Float64Array) transfer = [value.buffer];
    else if (message.method === 'packet' && value?.numbers instanceof Float64Array) transfer = [value.numbers.buffer];
    reply({protocol: PROTOCOL_VERSION, generation, id: message.id, type: 'result', value}, transfer);
  } catch (error) {
    const fatal = runtime?.quarantined === true || error?.name === 'RustWasmTrapError' || error?.name === 'RustWasmProtocolError' || error?.name === 'RustWasmQuarantinedError';
    if (fatal) { try { runtime?.close(); } catch {} runtime = null; }
    fail(message, error, 'rpc', fatal);
  }
}

const isDedicatedWorker = typeof DedicatedWorkerGlobalScope !== 'undefined'
  ? scope instanceof DedicatedWorkerGlobalScope
  : scope?.constructor?.name === 'DedicatedWorkerGlobalScope';

if (isDedicatedWorker && typeof scope.postMessage === 'function') {
  scope.onmessage = event => {
    const message = event?.data;
    queue = queue.then(() => dispatch(message)).catch(error => { if (message?.id) fail(message, error, 'protocol', true); });
  };
}
