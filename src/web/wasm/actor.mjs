const PROTOCOL_VERSION = 1;
const MAX_PENDING = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const METHOD_NAMES = Object.freeze(new Set([
  'call', 'readF64', 'writeF64', 'packet', 'capabilities', 'memoryStats', 'close',
]));
let generationSequence = 0;

export class RustActorError extends Error {
  constructor(message, {
    name = 'RustActorError', code = null, status = null, phase = 'rpc',
    quarantine = false, cause,
  } = {}) {
    super(message, {cause});
    this.name = name;
    this.code = code;
    this.status = status;
    this.phase = phase;
    this.quarantine = quarantine;
  }
}

export class RustActorProtocolError extends RustActorError {}
export class RustActorTimeoutError extends RustActorError {}
export class RustActorClosedError extends RustActorError {}
export class RustActorQuarantinedError extends RustActorError {}

const now = () => globalThis.performance?.now?.() ?? Date.now();
const nextGeneration = () => `rust-actor-${Date.now().toString(36)}-${(++generationSequence).toString(36)}`;

function abortError() {
  return new RustActorError('Rust WASM actor creation aborted', {name: 'AbortError', code: 'ABORTED', phase: 'init'});
}

function assertSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('AbortSignal required');
  }
}

function cloneError(value, fallback = 'Rust WASM actor request failed') {
  if (value instanceof RustActorError) return value;
  const message = typeof value?.message === 'string' ? value.message : fallback;
  const name = typeof value?.name === 'string' ? value.name : 'RustActorError';
  return new RustActorError(message, {
    name,
    code: value?.code ?? null,
    status: value?.status ?? null,
    phase: value?.phase ?? 'rpc',
    quarantine: value?.quarantine === true,
  });
}

function normalizeFloat64(value, label) {
  if (value instanceof Float64Array) return value;
  if (value instanceof ArrayBuffer && value.byteLength % Float64Array.BYTES_PER_ELEMENT === 0) return new Float64Array(value.slice(0));
  if (ArrayBuffer.isView(value) && value.byteLength % Float64Array.BYTES_PER_ELEMENT === 0) return new Float64Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new RustActorProtocolError(`Rust WASM actor returned ${label}`, {name: 'RustActorProtocolError', code: 'BAD_RESULT', quarantine: true});
}

function normalizeValue(method, value) {
  if (method === 'readF64') {
    return normalizeFloat64(value, 'a non-Float64Array read result');
  }
  if (method === 'packet') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RustActorProtocolError('Rust WASM actor returned a malformed packet', {name: 'RustActorProtocolError', code: 'BAD_RESULT', quarantine: true});
    const numbers = normalizeFloat64(value.numbers, 'a malformed packet');
    return numbers === value.numbers ? value : {...value, numbers};
  }
  if (method === 'writeF64' && typeof value !== 'boolean') throw new RustActorProtocolError('Rust WASM actor returned a non-boolean write receipt', {name: 'RustActorProtocolError', code: 'BAD_RESULT', quarantine: true});
  return value;
}

function makeWorker(workerURL) {
  if (typeof Worker !== 'function') throw new RustActorError('Web Worker is unavailable', {name: 'RustActorLoadError', code: 'WORKER_UNAVAILABLE', phase: 'init'});
  // Keep the literal URL expression for module-aware bundlers.
  return workerURL === undefined
    ? new Worker(new URL('./worker-entry.mjs', import.meta.url), {type: 'module'})
    : new Worker(workerURL, {type: 'module'});
}

function addListener(worker, type, handler) {
  if (typeof worker.addEventListener === 'function') worker.addEventListener(type, handler);
  else worker[`on${type}`] = handler;
}

function removeListener(worker, type, handler) {
  if (typeof worker.removeEventListener === 'function') worker.removeEventListener(type, handler);
  else if (worker[`on${type}`] === handler) worker[`on${type}`] = null;
}

function post(worker, message, transfer = []) {
  if (transfer.length === 0) worker.postMessage(message);
  else worker.postMessage(message, transfer);
}

/**
 * Create a Worker-owned Rust actor. The WebAssembly.Module is structured-cloned
 * to the worker; its Instance and linear memory never cross the boundary.
 */
export function createRustActor({module, workerURL, signal, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  assertSignal(signal);
  if (!(module instanceof WebAssembly.Module)) return Promise.reject(new TypeError('WebAssembly.Module required'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) return Promise.reject(new RangeError('Rust actor timeout must be between 1 and 120000 ms'));
  if (signal?.aborted) return Promise.reject(abortError());

  let worker;
  try { worker = makeWorker(workerURL); } catch (error) { return Promise.reject(error); }
  const generation = nextGeneration();
  let nextId = 1;
  let quarantined = false;
  let closed = false;
  let closing = false;
  let terminated = false;
  let initSettled = false;
  let closePromise = null;
  const pending = new Map();
  const abandoned = new Set();

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    try { worker.terminate?.(); } catch {}
  };

  const rejectAll = error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    abandoned.clear();
  };

  const quarantine = error => {
    const failure = error instanceof RustActorError ? error : new RustActorProtocolError(String(error?.message ?? error), {name: 'RustActorProtocolError', code: 'PROTOCOL', phase: 'transport', quarantine: true, cause: error});
    quarantined = true;
    terminate();
    rejectAll(failure);
    return failure;
  };

  const failTransport = (message, cause) => quarantine(new RustActorProtocolError(message, {name: 'RustActorProtocolError', code: 'WORKER_ERROR', phase: 'transport', quarantine: true, cause}));

  const onError = event => { failTransport(event?.message || 'Rust WASM worker failed', event); };
  const onMessage = event => {
    const message = event?.data;
    if (!message || message.protocol !== PROTOCOL_VERSION || message.generation !== generation || !Number.isSafeInteger(message.id) || message.id <= 0) {
      failTransport('Rust WASM worker returned an invalid protocol message');
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      if (abandoned.delete(message.id)) return;
      failTransport('Rust WASM worker returned an unknown request id');
      return;
    }
    const settleCurrent = () => {
      pending.delete(message.id);
      clearTimeout(request.timer);
    };
    if (message.type === 'error') {
      settleCurrent();
      const error = cloneError(message.error);
      if (message.quarantine === true || error.quarantine === true) {
        request.reject(error);
        quarantine(error);
        return;
      }
      request.reject(error);
      return;
    }
    const expectedType = request.type === 'init' ? 'ready' : request.type === 'close' ? 'closed' : 'result';
    if (message.type !== expectedType) {
      settleCurrent();
      const error = new RustActorProtocolError(`Rust WASM worker returned ${String(message.type)} for ${request.type}`, {name: 'RustActorProtocolError', code: 'BAD_RESPONSE_TYPE', phase: request.type, quarantine: true});
      request.reject(error);
      quarantine(error);
      return;
    }
    let value;
    try {
      if (message.type === 'ready') {
        if (!message.capabilities || typeof message.capabilities !== 'object') throw new RustActorProtocolError('Rust WASM worker ready response is missing capabilities', {name: 'RustActorProtocolError', code: 'BAD_READY', phase: 'init', quarantine: true});
        value = message.capabilities;
      } else if (message.type === 'closed') value = true;
      else value = normalizeValue(request.method, message.value);
    } catch (error) {
      settleCurrent();
      const failure = error instanceof RustActorError ? error : new RustActorProtocolError(`Rust WASM worker returned a malformed ${request.method} result`, {name: 'RustActorProtocolError', code: 'BAD_RESULT', phase: request.type, quarantine: true, cause: error});
      request.reject(failure);
      quarantine(failure);
      return;
    }
    settleCurrent();
    request.resolve(value);
  };
  addListener(worker, 'message', onMessage);
  addListener(worker, 'error', onError);

  const removeListeners = () => {
    removeListener(worker, 'message', onMessage);
    removeListener(worker, 'error', onError);
  };

  const request = (type, payload = {}, {method = type, allowClosing = false, transfer = []} = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new RustActorClosedError('Rust WASM actor is closed', {name: 'RustActorClosedError', code: 'CLOSED', phase: type})); return; }
    if (quarantined) { reject(new RustActorQuarantinedError('Rust WASM actor is quarantined; recreate it', {name: 'RustActorQuarantinedError', code: 'QUARANTINED', phase: type, quarantine: true})); return; }
    if (closing && !allowClosing) { reject(new RustActorClosedError('Rust WASM actor is closing', {name: 'RustActorClosedError', code: 'CLOSING', phase: type})); return; }
    if (pending.size >= MAX_PENDING) { reject(new RustActorError('Rust WASM actor request queue is full', {name: 'RustActorError', code: 'QUEUE_FULL', phase: type})); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      const timeout = new RustActorTimeoutError(`Rust WASM actor request timed out: ${type}`, {name: 'RustActorTimeoutError', code: 'TIMEOUT', phase: type, quarantine: true});
      quarantine(timeout);
    }, timeoutMs);
    pending.set(id, {id, type, method, resolve, reject, timer});
    try { post(worker, {protocol: PROTOCOL_VERSION, generation, id, type, ...payload}, transfer); }
    catch (error) {
      pending.delete(id); clearTimeout(timer);
      reject(new RustActorError(`Rust WASM actor could not post ${type}: ${error.message}`, {name: 'RustActorPostError', code: 'POST_FAILED', phase: type, cause: error}));
    }
  });

  const actor = {
    protocol: PROTOCOL_VERSION,
    generation,
    get closed() { return closed; },
    get quarantined() { return quarantined; },
    call(name, args = [], flags = 1) {
      if (typeof name !== 'string' || !Array.isArray(args)) return Promise.reject(new TypeError('Rust actor call requires a name and argument array'));
      return request('rpc', {method: 'call', name, args, flags}, {method: 'call'});
    },
    readF64(name, args = [], flags = 1) {
      if (typeof name !== 'string' || !Array.isArray(args)) return Promise.reject(new TypeError('Rust actor readF64 requires a name and argument array'));
      return request('rpc', {method: 'readF64', name, args, flags}, {method: 'readF64'});
    },
    writeF64(name, args = [], values, flags = 1) {
      if (typeof name !== 'string' || !Array.isArray(args) || !(values instanceof Float64Array)) return Promise.reject(new TypeError('Rust actor writeF64 requires a name, argument array and Float64Array'));
      const copy = new Float64Array(values);
      return request('rpc', {method: 'writeF64', name, args, values: copy, flags}, {method: 'writeF64', transfer: [copy.buffer]});
    },
    packet(args = []) {
      if (!Array.isArray(args)) return Promise.reject(new TypeError('Rust actor packet requires an argument array'));
      return request('rpc', {method: 'packet', args}, {method: 'packet'});
    },
    capabilities() { return request('rpc', {method: 'capabilities'}, {method: 'capabilities'}); },
    memoryStats() { return request('rpc', {method: 'memoryStats'}, {method: 'memoryStats'}); },
    close() {
      if (closePromise) return closePromise;
      if (closed) return Promise.resolve();
      closing = true;
      // The worker may still flush commands already posted before close. Reject
      // their public promises now, but retain bounded tombstones so those normal
      // late replies cannot be mistaken for a protocol violation.
      for (const [id, request] of [...pending]) {
        if (request.type === 'init' || request.type === 'close') continue;
        pending.delete(id);
        clearTimeout(request.timer);
        abandoned.add(id);
        request.reject(new RustActorClosedError('Rust WASM actor closed before the request completed', {name: 'RustActorClosedError', code: 'CLOSED', phase: request.type}));
      }
      closePromise = request('close', {}, {method: 'close', allowClosing: true})
        .then(() => { closed = true; removeListeners(); terminate(); })
        .catch(error => { closed = true; removeListeners(); terminate(); throw error; });
      return closePromise;
    },
  };

  const removeAbort = () => { if (signal) signal.removeEventListener('abort', abortInit); };
  const abortInit = () => {
    if (initSettled) return;
    const error = abortError();
    initSettled = true;
    removeAbort();
    quarantine(error);
  };
  if (signal) signal.addEventListener('abort', abortInit, {once: true});
  const init = request('init', {module, requiredOperations: ['nativeInit', 'nativeCommand', 'nativeScenePacket']}, {method: 'init'});
  return init.then(capabilities => {
    initSettled = true;
    removeAbort();
    return Object.assign(actor, {initialCapabilities: capabilities});
  }, error => {
    initSettled = true;
    removeAbort();
    removeListeners();
    terminate();
    throw error;
  });
}

export {METHOD_NAMES as RUST_ACTOR_METHODS, PROTOCOL_VERSION as RUST_ACTOR_PROTOCOL_VERSION};
