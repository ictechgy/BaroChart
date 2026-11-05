// Capture the live Rust workspace into portable JS-owned data while its
// source lease is held. No candidate Rust actor, Instance, or linear memory
// crosses this boundary.

const SOURCE_BEGIN = 'web.migrationSourceBegin';
const SOURCE_STEP = 'web.migrationSourceStep';
const SOURCE_UI_BEGIN = 'web.migrationSourceUiBegin';
const SOURCE_UI_NEXT = 'web.migrationSourceUiNext';
const SOURCE_CHECK = 'web.migrationSourceCheck';
const SOURCE_FINISH = 'web.migrationSourceFinish';
const SOURCE_ABORT = 'web.migrationSourceAbort';
const SOURCE_BUFFER = 'nativeAsyncBuffer';
const FIELDS = Object.freeze(['time', 'open', 'high', 'low', 'close', 'volume']);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 805_306_368;
const DEFAULT_CHUNK_SIZE = 262_144;
const MAX_CHUNK_SIZE = 262_144;
const MAX_RECORDS = 64;
const MAX_BARS = 4_194_304;
const MAX_UI_CHUNKS = 1_048_576;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 250;

export class RustCaptureJobError extends Error {
  constructor(message, {
    name = 'RustCaptureJobError',
    code = 'CAPTURE_JOB',
    phase = null,
    cause,
    registration = null,
    ticket = null,
    commitUncertain = false,
    resyncRequired = false,
  } = {}) {
    super(message, {cause});
    this.name = name;
    this.code = code;
    this.phase = phase;
    this.registration = registration;
    this.ticket = ticket;
    this.commitUncertain = commitUncertain;
    this.resyncRequired = resyncRequired;
  }
}

export class RustCaptureJobAbortError extends RustCaptureJobError {
  constructor(cause, details = {}) {
    super('Rust capture job aborted', {...details, name: 'AbortError', code: 'ABORTED', cause});
  }
}

export class RustCaptureJobTimeoutError extends RustCaptureJobError {
  constructor(cause, details = {}) {
    super('Rust capture job timed out', {...details, name: 'TimeoutError', code: 'TIMEOUT', cause});
  }
}

export class RustCaptureCommitUncertainError extends RustCaptureJobError {
  constructor(cause, details = {}) {
    super('Rust capture commit outcome is uncertain; resync is required', {
      ...details,
      name: 'RustCaptureCommitUncertainError',
      code: 'COMMIT_UNCERTAIN',
      commitUncertain: true,
      resyncRequired: true,
      cause,
    });
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new RustCaptureJobError(`Could not snapshot ${label}`, {code: 'SNAPSHOT_FAILED', phase: 'snapshot', cause});
  }
}

function signalCheck(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw new TypeError('AbortSignal required');
}

function integer(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Rust capture ${label}`);
  return value;
}

function assertPort(port) {
  if (!object(port)) throw new TypeError('Rust capture port required');
  for (const name of ['call', 'readF64', 'nextRegistration', 'revision']) {
    if (typeof port[name] !== 'function') throw new TypeError(`Rust capture port.${name} required`);
  }
}

function workspaceDocument(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_JSON_BYTES) throw new TypeError('Rust workspace document must be a bounded JSON string');
  try {
    if (!object(JSON.parse(value))) throw new Error('workspace object required');
  } catch (cause) {
    throw new RustCaptureJobError('Malformed Rust workspace document', {code: 'BAD_DOCUMENT', phase: 'snapshot', cause});
  }
}

function parseJson(value, label, maxBytes = MAX_JSON_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes) throw new RustCaptureJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label});
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error('object required');
    return parsed;
  } catch (cause) {
    throw new RustCaptureJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label, cause});
  }
}

function begin(value, registration) {
  const parsed = typeof value === 'string' ? parseJson(value, 'capture source begin') : value;
  if (!object(parsed) || !Number.isSafeInteger(parsed.ticket) || parsed.ticket < 1 || typeof parsed.phase !== 'string') throw new RustCaptureJobError('Malformed capture source begin result', {code: 'BAD_RESULT', phase: 'source-begin'});
  if (parsed.registration !== undefined && parsed.registration !== registration) throw new RustCaptureJobError('Capture registration mismatch', {code: 'BAD_RESULT', phase: 'source-begin'});
  return {ticket: parsed.ticket, phase: parsed.phase};
}

function sourceProgress(value) {
  const parsed = typeof value === 'string' ? parseJson(value, 'capture source progress') : value;
  if (!object(parsed) || typeof parsed.complete !== 'boolean') throw new RustCaptureJobError('Malformed capture source progress', {code: 'BAD_PROGRESS', phase: 'source-admission'});
  if ('done' in parsed) integer(parsed.done, 'source progress done');
  if ('total' in parsed) integer(parsed.total, 'source progress total');
  if (parsed.complete && typeof parsed.metadataJSON !== 'string') throw new RustCaptureJobError('Capture source metadata missing', {code: 'BAD_METADATA', phase: 'source-admission'});
  return parsed;
}

function bufferLengths(value) {
  if (!Array.isArray(value) || value.length !== FIELDS.length) throw new RustCaptureJobError('Capture source must expose six data buffers', {code: 'BAD_METADATA', phase: 'source-admission'});
  return value.map((row, slot) => {
    if (!object(row) || row.slot !== slot) throw new RustCaptureJobError('Capture data buffer slots are not contiguous', {code: 'BAD_METADATA', phase: 'source-admission'});
    return integer(row.length, `buffer ${slot} length`, {max: MAX_BARS});
  });
}

function uiBegin(value) {
  if (!object(value) || typeof value.header !== 'string' || value.header.length === 0 || !object(value.description)) throw new RustCaptureJobError('Malformed capture UI source begin result', {code: 'BAD_UI', phase: 'source-ui-begin'});
  return {header: value.header, description: own(value.description, 'capture UI description')};
}

function uiChunk(value) {
  const parsed = parseJson(value, 'capture UI chunk');
  if (typeof parsed.complete !== 'boolean') throw new RustCaptureJobError('Malformed capture UI completion flag', {code: 'BAD_UI', phase: 'source-ui-next'});
  return parsed;
}

function cloneF64(value, count, label) {
  if (!(value instanceof Float64Array) || value.length !== count) throw new RustCaptureJobError(`Malformed ${label} buffer`, {code: 'BAD_BUFFER', phase: label});
  return new Float64Array(value);
}

const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));

function disposeValue(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (typeof value.dispose === 'function') return Promise.resolve().then(() => value.dispose()).catch(() => undefined);
  if (typeof value.close === 'function') return Promise.resolve().then(() => value.close()).catch(() => undefined);
  return null;
}

/**
 * Capture one live Rust workspace into JS-owned portable data.
 *
 * `consume(capture)` runs while the source lease is still held and may build a
 * JS candidate. The final source check and finish happen only after consume
 * completes. `activate({capture,value,handoff})` runs after finish; call
 * `handoff()` before returning/throwing if the candidate has been transferred
 * to another owner and must survive cleanup.
 */
export async function runRustCaptureJob(port, document, binding, options = {}) {
  assertPort(port);
  workspaceDocument(document);
  if (!object(binding)) throw new TypeError('Rust workspace binding required');
  if (!object(options)) throw new TypeError('Rust capture options required');
  const {signal, onProgress, consume, activate} = options;
  signalCheck(signal);
  if (typeof consume !== 'function') throw new TypeError('Rust capture consume callback required');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Rust capture progress callback required');
  if (activate !== undefined && typeof activate !== 'function') throw new TypeError('Rust capture activation callback required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Rust capture timeout');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  integer(maxBytes, 'byte budget', {min: 1, max: DEFAULT_MAX_BYTES});
  const admissionRecords = integer(options.admissionRecords ?? 8, 'admission records', {min: 1, max: MAX_RECORDS});
  const chunkSize = integer(options.chunkSize ?? DEFAULT_CHUNK_SIZE, 'chunk size', {min: 1, max: MAX_CHUNK_SIZE});
  const documentCopy = own(document, 'workspace document');
  const bindingCopy = own(binding, 'workspace binding');
  if (signal?.aborted) throw new RustCaptureJobAbortError();

  let cancellation = null;
  let cancelReject;
  const cancelPromise = new Promise((_, reject) => { cancelReject = reject; });
  void cancelPromise.catch(() => {});
  const cancel = error => { if (!cancellation) { cancellation = error; cancelReject(error); } };
  const onAbort = () => cancel(new RustCaptureJobAbortError());
  signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => cancel(new RustCaptureJobTimeoutError()), timeoutMs);

  let registration = null;
  let revision = null;
  let ticket = null;
  let sourceStarted = false;
  let sourceFinished = false;
  let sourceBeginPromise = null;
  let sourceAbortPromise = null;
  let candidateValue;
  let consumePromise = null;
  let candidateDisposePromise = null;
  let handedOff = false;
  let cleanupStarted = false;
  let commitUncertain = false;

  const details = phase => ({phase, registration, ticket});
  const check = phase => {
    if (!cancellation) return;
    if (cancellation instanceof RustCaptureJobAbortError || cancellation instanceof RustCaptureJobTimeoutError) {
      cancellation.phase ??= phase;
      cancellation.registration ??= registration;
      cancellation.ticket ??= ticket;
    }
    throw cancellation;
  };
  const guarded = async (phase, action) => {
    check(phase);
    const pending = Promise.resolve().then(action);
    const value = await Promise.race([pending, cancelPromise]);
    check(phase);
    return value;
  };
  const report = async (stage, value = {}) => {
    if (!onProgress) return;
    await guarded('progress', async () => {
      await onProgress(Object.freeze({...own(value, 'progress'), stage, registration, ticket}));
    });
  };
  const abortSource = () => {
    if (!sourceStarted || sourceFinished || ticket === null || sourceAbortPromise) return sourceAbortPromise;
    sourceAbortPromise = Promise.resolve().then(() => port.call(SOURCE_ABORT, [ticket])).catch(() => undefined);
    return sourceAbortPromise;
  };
  const disposeCandidate = () => {
    if (handedOff || candidateDisposePromise) return candidateDisposePromise;
    candidateDisposePromise = disposeValue(candidateValue);
    return candidateDisposePromise;
  };
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (handedOff) return;
    // A source finish response can be lost after the lease was dropped. Never
    // replay SourceAbort; the JS candidate is still unowned and is disposed.
    const operations = [disposeCandidate()];
    if (!sourceFinished && !commitUncertain) {
      const abort = abortSource();
      if (abort) operations.push(abort);
    }
    await Promise.race([Promise.allSettled(operations), new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS))]);
    if (sourceBeginPromise) sourceBeginPromise.catch(() => {});
  };

  try {
    registration = integer(await guarded('registration', () => port.nextRegistration()), 'registration', {min: 1});
    revision = integer(await guarded('revision', () => port.revision()), 'host revision', {min: 1});
    check('source-begin');
    sourceBeginPromise = Promise.resolve().then(() => port.call(SOURCE_BEGIN, [documentCopy, bindingCopy, revision, maxBytes, registration]));
    sourceBeginPromise.then(value => {
      if (sourceStarted || !cancellation || sourceFinished) return;
      try {
        const late = begin(value, registration);
        ticket = late.ticket;
        sourceStarted = true;
        void abortSource();
      } catch {
        // Begin failed before admitting a ticket; no safe cleanup call exists.
      }
    }, () => {});
    const beginValue = await Promise.race([sourceBeginPromise, cancelPromise]);
    const admitted = begin(beginValue, registration);
    ticket = admitted.ticket;
    sourceStarted = true;

    let admission = sourceProgress(await guarded('source-admission', () => port.call(SOURCE_STEP, [ticket, admissionRecords, revision])));
    while (!admission.complete) {
      await report('source-admission', admission);
      await guarded('source-admission-yield', yieldControl);
      admission = sourceProgress(await guarded('source-admission', () => port.call(SOURCE_STEP, [ticket, admissionRecords, revision])));
    }
    const metadataJSON = admission.metadataJSON;
    const metadata = parseJson(metadataJSON, 'capture workspace metadata');
    const lengths = bufferLengths(admission.buffers);
    const length = lengths[0];
    if (lengths.some(value => value !== length)) throw new RustCaptureJobError('Capture source columns have different lengths', {code: 'BAD_METADATA', phase: 'source-admission'});
    await report('source-admission', {complete: true, total: length});

    const sourceUi = uiBegin(await guarded('source-ui-begin', () => port.call(SOURCE_UI_BEGIN, [ticket, revision])));
    const uiChunks = [];
    while (true) {
      const text = await guarded('source-ui-next', () => port.call(SOURCE_UI_NEXT, [ticket]));
      const parsed = uiChunk(text);
      if (parsed.complete) break;
      uiChunks.push(String(text));
      if (uiChunks.length > MAX_UI_CHUNKS) throw new RustCaptureJobError('Capture UI chunk limit exceeded', {code: 'LIMIT', phase: 'source-ui-next'});
      await report('source-ui', {done: uiChunks.length});
      await guarded('source-ui-yield', yieldControl);
    }

    const copied = {};
    for (let slot = 0; slot < FIELDS.length; slot++) {
      const values = new Float64Array(length);
      for (let offset = 0; offset < length; offset += chunkSize) {
        const count = Math.min(chunkSize, length - offset);
        const chunk = cloneF64(await guarded('column-copy', () => port.readF64(SOURCE_BUFFER, [ticket, slot, offset, count])), count, `capture ${FIELDS[slot]}`);
        values.set(chunk, offset);
        await report('column-copy', {field: FIELDS[slot], offset: offset + count, total: length});
        await guarded('column-copy-yield', yieldControl);
      }
      copied[FIELDS[slot]] = values;
    }

    const capture = Object.freeze({
      schema: 'aster.web-wasm.capture/v1',
      version: 1,
      ticket,
      registration,
      revision,
      length,
      metadata: own(metadata, 'capture metadata'),
      metadataJSON,
      header: sourceUi.header,
      description: own(sourceUi.description, 'capture UI description'),
      uiChunks: Object.freeze(uiChunks.slice()),
      columns: Object.freeze(copied),
    });
    consumePromise = Promise.resolve().then(() => consume(capture));
    consumePromise.then(value => {
      // If AbortSignal won the public race, consume may still finish later.
      // Retain and dispose its JS candidate instead of losing ownership.
      if (candidateValue === undefined && cancellation && !handedOff) {
        candidateValue = value;
        void disposeCandidate();
      }
    }, () => {});
    candidateValue = await Promise.race([consumePromise, cancelPromise]);
    check('consume');
    await guarded('source-final-check', () => port.call(SOURCE_CHECK, [ticket, registration, revision]));

    check('source-finish');
    let sourceReceipt;
    try {
      sourceReceipt = await port.call(SOURCE_FINISH, [ticket, registration, revision]);
    } catch (cause) {
      commitUncertain = true;
      throw new RustCaptureCommitUncertainError(cause, {...details('source-finish'), commitUncertain: true});
    }
    sourceFinished = true;
    check('source-finish');

    let activation;
    const activationCandidate = Object.freeze({capture, value: candidateValue, handoff() { handedOff = true; }});
    if (activate) {
      try {
        activation = await activate(activationCandidate);
        check('activation');
      } catch (cause) {
        commitUncertain = true;
        throw new RustCaptureCommitUncertainError(cause, {...details('activation'), commitUncertain: true});
      }
    }
    const result = Object.freeze({schema: 'aster.web-wasm.capture-result', version: 1, status: 'captured', capture, value: candidateValue, sourceReceipt: own(sourceReceipt, 'capture source receipt'), activation, candidate: activationCandidate});
    handedOff = true;
    return result;
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}
