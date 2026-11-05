// Full nativePrepare coordinator for the web Rust backend.
//
// The source actor owns the live chart and ingestion lease. The target actor
// owns a completely isolated prepare runtime. This coordinator moves only
// owned Float64Array copies and bounded UI JSON; neither an Instance nor linear
// memory crosses the actor boundary.

const SOURCE_BEGIN = 'nativePrepareBegin';
const SOURCE_UI_BEGIN = 'nativeAsyncUIBegin';
const SOURCE_UI_NEXT = 'nativeAsyncUINext';
const SOURCE_UI_CHECK = 'nativeAsyncUICheck';
const SOURCE_RELEASE = 'nativeAsyncRelease';
const TARGET_CREATE = 'nativePrepareCreate';
const TARGET_BUFFER = 'nativeAsyncTargetBuffer';
const TARGET_START = 'nativeAsyncStart';
const TARGET_STEP = 'nativeAsyncStep';
const TARGET_UI_BEGIN = 'nativeAsyncUIImportBegin';
const TARGET_UI_CHUNK = 'nativeAsyncUIImportChunk';
const TARGET_UI_END = 'nativeAsyncUIImportEnd';
const TARGET_FINISH = 'nativeAsyncFinish';

const FIELDS = Object.freeze(['time', 'open', 'high', 'low', 'close', 'volume']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STEP_SIZE = 4096;
const DEFAULT_CHUNK_SIZE = 262_144;
const MAX_BARS = 4_194_304;
const MAX_CHUNK_SIZE = 262_144;
const MAX_STEP_SIZE = 16_384;
const MAX_UI_BYTES = 1_048_576;
const MAX_UI_REFERENCES = 5_000_000;
const CLEANUP_TIMEOUT_MS = 250;

export class RustPrepareJobError extends Error {
  constructor(message, {
    name = 'RustPrepareJobError',
    code = 'PREPARE_JOB',
    phase = null,
    cause,
    ticket = null,
    commitUncertain = false,
    resyncRequired = false,
  } = {}) {
    super(message, {cause});
    this.name = name;
    this.code = code;
    this.phase = phase;
    this.ticket = ticket;
    this.commitUncertain = commitUncertain;
    this.resyncRequired = resyncRequired;
  }
}

export class RustPrepareJobAbortError extends RustPrepareJobError {
  constructor(cause, details = {}) {
    super('Rust prepare job aborted', {...details, name: 'AbortError', code: 'ABORTED', cause});
  }
}

export class RustPrepareJobTimeoutError extends RustPrepareJobError {
  constructor(cause, details = {}) {
    super('Rust prepare job timed out', {...details, name: 'TimeoutError', code: 'TIMEOUT', cause});
  }
}

export class RustPrepareCommitUncertainError extends RustPrepareJobError {
  constructor(cause, details = {}) {
    super('Rust prepare commit outcome is uncertain; resync is required', {
      ...details,
      name: 'RustPrepareCommitUncertainError',
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
    throw new RustPrepareJobError(`Could not snapshot ${label}`, {code: 'SNAPSHOT_FAILED', phase: 'snapshot', cause});
  }
}

function signalCheck(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean') {
    throw new TypeError('AbortSignal required');
  }
}

function integer(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Rust prepare ${label}`);
  return value;
}

function assertPort(port) {
  if (!object(port)) throw new TypeError('Rust prepare port required');
  for (const name of ['call', 'createTargetActor']) {
    if (typeof port[name] !== 'function') throw new TypeError(`Rust prepare port.${name} required`);
  }
}

function assertActor(actor) {
  if (!object(actor)) throw new RustPrepareJobError('Prepare target actor is malformed', {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  for (const name of ['call', 'writeF64', 'close']) {
    if (typeof actor[name] !== 'function') throw new RustPrepareJobError(`Prepare target actor.${name} is required`, {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  }
}

function parseJson(value, label, maxBytes = MAX_UI_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes) throw new RustPrepareJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label});
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error('object required');
    return parsed;
  } catch (cause) {
    throw new RustPrepareJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label, cause});
  }
}

function progress(value) {
  const parsed = typeof value === 'string' ? parseJson(value, 'prepare progress') : value;
  if (!object(parsed) || typeof parsed.complete !== 'boolean' || typeof parsed.phase !== 'string') throw new RustPrepareJobError('Malformed prepare progress', {code: 'BAD_PROGRESS', phase: 'calculate'});
  if ('done' in parsed) integer(parsed.done, 'progress done');
  if ('total' in parsed) integer(parsed.total, 'progress total');
  if (Number.isSafeInteger(parsed.done) && Number.isSafeInteger(parsed.total) && parsed.done > parsed.total) throw new RustPrepareJobError('Prepare progress exceeds total', {code: 'BAD_PROGRESS', phase: 'calculate'});
  return parsed;
}

function begin(value) {
  const parsed = typeof value === 'string' ? parseJson(value, 'prepare begin') : value;
  if (!object(parsed) || !Number.isSafeInteger(parsed.ticket) || parsed.ticket < 1 || typeof parsed.metadataJSON !== 'string') throw new RustPrepareJobError('Malformed prepare begin result', {code: 'BAD_RESULT', phase: 'source-begin'});
  if (!Array.isArray(parsed.buffers) || !Array.isArray(parsed.checkpoints)) throw new RustPrepareJobError('Prepare begin descriptors are missing', {code: 'BAD_RESULT', phase: 'source-begin'});
  if (parsed.buffers.length !== 0 || parsed.checkpoints.length !== 0) throw new RustPrepareJobError('nativePrepare must not expose source buffers or checkpoints', {code: 'BAD_RESULT', phase: 'source-begin'});
  return {ticket: parsed.ticket, metadataJSON: parsed.metadataJSON};
}

function columns(input, count) {
  if (!object(input)) throw new TypeError('Owned prepare columns required');
  const output = [];
  for (const field of FIELDS) {
    const values = input[field];
    if (!(values instanceof Float64Array) || values.length !== count) throw new TypeError(`Owned prepare column ${field} must be Float64Array(${count})`);
    output.push(new Float64Array(values));
  }
  return output;
}

function normalizeInput(input) {
  if (!object(input) || (input.kind !== 'seeded' && input.kind !== 'columns')) throw new TypeError('Rust prepare kind must be seeded or columns');
  const options = input.options === undefined ? {} : input.options;
  if (!object(options)) throw new TypeError('Rust prepare options required');
  const visibleBars = options.visibleBars ?? input.visibleBars ?? 200;
  integer(visibleBars, 'visible bars', {min: 1, max: MAX_BARS});
  if (input.kind === 'seeded') {
    const count = integer(input.count, 'count', {min: 0, max: MAX_BARS});
    const seed = input.seed ?? 42;
    integer(seed, 'seed', {min: 0, max: 0xFFFF_FFFF});
    const request = {kind: 'seeded', count, seed, visibleBars};
    return {kind: 'seeded', count, request, requestJSON: JSON.stringify(request), fields: null};
  }
  const fields = input.columns;
  if (!object(fields)) throw new TypeError('Rust prepare columns required');
  const lengths = FIELDS.map(field => fields[field]?.length);
  if (!Number.isSafeInteger(lengths[0]) || lengths.some(length => length !== lengths[0])) throw new RangeError('Rust prepare columns must have equal lengths');
  const count = integer(lengths[0], 'column length', {min: 0, max: MAX_BARS});
  const ownedFields = columns(fields, count);
  const request = {kind: 'columns', length: count, visibleBars};
  return {kind: 'columns', count, request, requestJSON: JSON.stringify(request), fields: ownedFields};
}

function uiHeader(value) {
  if (typeof value !== 'string') throw new RustPrepareJobError('Malformed prepare UI header', {code: 'BAD_UI', phase: 'source-ui-begin'});
  const parsed = parseJson(value, 'prepare UI header');
  if (parsed.schema !== 'aster.async.ui' || parsed.protocol !== 1 || !object(parsed.state) || !object(parsed.state.drawings)) {
    throw new RustPrepareJobError('Malformed prepare UI protocol', {code: 'BAD_UI', phase: 'source-ui-begin'});
  }
  let total = 0;
  const drawings = parsed.state.drawings;
  const frames = drawings.frameCounts;
  if (!Array.isArray(frames) || frames.length > 20_001 || !Number.isSafeInteger(drawings.undoCount) || !Number.isSafeInteger(drawings.redoCount) || frames.length !== 1 + drawings.undoCount + drawings.redoCount) {
    throw new RustPrepareJobError('Malformed prepare UI frame counts', {code: 'BAD_UI', phase: 'source-ui-begin'});
  }
  for (const frame of frames) {
    integer(frame, 'UI frame count', {max: 10_000});
    total += frame;
    if (total > MAX_UI_REFERENCES) throw new RustPrepareJobError('Prepare UI reference budget exceeded', {code: 'LIMIT', phase: 'source-ui-begin'});
  }
  return {header: value, total};
}

function uiChunk(value) {
  const parsed = parseJson(value, 'prepare UI chunk');
  if (typeof parsed.complete !== 'boolean') throw new RustPrepareJobError('Malformed prepare UI completion flag', {code: 'BAD_UI', phase: 'source-ui-next'});
  let references = 0;
  if (!parsed.complete) {
    if (!Array.isArray(parsed.refs) || parsed.refs.length < 1 || parsed.refs.length > 64) throw new RustPrepareJobError('Malformed prepare UI references', {code: 'BAD_UI', phase: 'source-ui-next'});
    references = parsed.refs.length;
  }
  return {parsed, references};
}

const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Run one complete nativePrepare job in an isolated actor.
 *
 * `input` is either `{kind:'seeded',count,seed?,options?:{visibleBars}}` or
 * `{kind:'columns',columns:{time,open,high,low,close,volume},options?:{visibleBars}}`.
 * The returned candidate actor remains owned by the caller after success.
 */
export async function runRustPrepareJob(port, input, options = {}) {
  assertPort(port);
  if (!object(options)) throw new TypeError('Rust prepare options required');
  const {signal, onProgress, activate} = options;
  signalCheck(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Rust prepare progress callback required');
  if (activate !== undefined && typeof activate !== 'function') throw new TypeError('Rust prepare activation callback required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Rust prepare timeout');
  const chunkSize = integer(options.chunkSize ?? DEFAULT_CHUNK_SIZE, 'chunk size', {min: 1, max: MAX_CHUNK_SIZE});
  const stepSize = integer(options.stepSize ?? DEFAULT_STEP_SIZE, 'step size', {min: 1, max: MAX_STEP_SIZE});
  const normalized = normalizeInput(input);
  if (signal?.aborted) throw new RustPrepareJobAbortError();

  let cancellation = null;
  let cancelReject;
  const cancelPromise = new Promise((_, reject) => { cancelReject = reject; });
  void cancelPromise.catch(() => {});
  const cancel = error => { if (!cancellation) { cancellation = error; cancelReject(error); } };
  const onAbort = () => cancel(new RustPrepareJobAbortError());
  signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => cancel(new RustPrepareJobTimeoutError()), timeoutMs);

  let ticket = null;
  let sourceStarted = false;
  let sourceReleased = false;
  let sourceBeginPromise = null;
  let sourceReleasePromise = null;
  let target = null;
  let targetCreated = null;
  let targetClosed = false;
  let cleanupStarted = false;
  let commitUncertain = false;
  let activationStarted = false;
  let handedOff = false;

  const details = phase => ({phase, ticket});
  const check = phase => {
    if (!cancellation) return;
    if (cancellation instanceof RustPrepareJobAbortError || cancellation instanceof RustPrepareJobTimeoutError) {
      cancellation.phase ??= phase;
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
  const report = async (phase, value = {}) => {
    if (!onProgress) return;
    await guarded('progress', async () => {
      const payload = Object.freeze({...own(value, 'progress'), phase, ticket});
      await onProgress(payload);
    });
  };
  const releaseSource = () => {
    if (!sourceStarted || sourceReleased || ticket === null || sourceReleasePromise) return sourceReleasePromise;
    sourceReleasePromise = Promise.resolve().then(() => port.call(SOURCE_RELEASE, [ticket]));
    return sourceReleasePromise;
  };
  const closeTarget = () => {
    if (!target || targetClosed) return null;
    targetClosed = true;
    return Promise.resolve().then(() => target.close()).catch(() => undefined);
  };
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    // Before the explicit handoff, the candidate remains this coordinator's
    // responsibility even when source release or activation was uncertain.
    // Close it on every preactivation error; never replay an uncertain release.
    if (handedOff) return;
    const operations = [];
    if (!sourceReleased && !commitUncertain) {
      const release = releaseSource();
      if (release) operations.push(release.catch(() => undefined));
    }
    const close = closeTarget();
    if (close) operations.push(close);
    if (targetCreated) {
      targetCreated.then(actor => {
        if (!target) target = actor;
        if (!handedOff) void closeTarget();
      }, () => {});
    }
    await Promise.race([Promise.allSettled(operations), new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS))]);
  };

  try {
    check('source-begin');
    // Register the dispatch before awaiting it. If cancellation wins the
    // public race, a later successful Begin still yields a real ticket that can
    // be released; ticket is never guessed from a host-side sequence number.
    sourceBeginPromise = Promise.resolve().then(() => port.call(SOURCE_BEGIN, [normalized.requestJSON]));
    sourceBeginPromise.then(value => {
      if (sourceStarted || !cancellation || sourceReleased) return;
      try {
        const late = begin(value);
        ticket = late.ticket;
        sourceStarted = true;
        void releaseSource().catch(() => {});
      } catch {
        // A failed Begin did not admit a source ticket, so release is unsafe.
      }
    }, () => {});
    const beginValue = await Promise.race([sourceBeginPromise, cancelPromise]);
    const admitted = begin(beginValue);
    ticket = admitted.ticket;
    sourceStarted = true;
    await report('source-admission', {complete: true, total: normalized.count});

    targetCreated = Promise.resolve().then(() => port.createTargetActor());
    targetCreated.catch(() => {});
    target = await Promise.race([targetCreated, cancelPromise]);
    assertActor(target);
    check('target-create');
    await guarded('target-create', () => target.call(TARGET_CREATE, [admitted.metadataJSON]));
    if (normalized.fields) {
      let copied = 0;
      const total = normalized.count * FIELDS.length;
      for (let slot = 0; slot < FIELDS.length; slot++) {
        const values = normalized.fields[slot];
        for (let offset = 0; offset < normalized.count; offset += chunkSize) {
          const count = Math.min(chunkSize, normalized.count - offset);
          const chunk = new Float64Array(values.subarray(offset, offset + count));
          const result = await guarded('input-transfer', () => target.writeF64(TARGET_BUFFER, [slot, offset, count], chunk));
          if (result !== true) throw new RustPrepareJobError('Prepare target rejected input buffer', {code: 'WRITE_REJECTED', phase: 'input-transfer', ticket});
          copied += count;
          await report('input-transfer', {slot, offset: offset + count, done: copied, total});
          await guarded('input-transfer-yield', yieldControl);
        }
      }
    }
    await guarded('calculate-start', () => target.call(TARGET_START, []));
    let current = progress(await guarded('calculate', () => target.call(TARGET_STEP, [stepSize])));
    while (!current.complete) {
      await report('calculate', current);
      await guarded('calculate-yield', yieldControl);
      current = progress(await guarded('calculate', () => target.call(TARGET_STEP, [stepSize])));
    }
    await report('calculate', current);

    const header = uiHeader(await sourceCall(sourceStarted, port, SOURCE_UI_BEGIN, [ticket], 'source-ui-begin', guarded, check));
    await guarded('target-ui-begin', () => target.call(TARGET_UI_BEGIN, [header.header]));
    let references = 0;
    const uiChunks = [];
    while (true) {
      const text = await guarded('source-ui-next', () => port.call(SOURCE_UI_NEXT, [ticket]));
      const {parsed, references: count} = uiChunk(text);
      uiChunks.push(String(text));
      if (parsed.complete) break;
      references += count;
      if (references > header.total) throw new RustPrepareJobError('Prepare UI transfer exceeds source references', {code: 'BAD_UI', phase: 'source-ui-next', ticket});
      await guarded('target-ui-chunk', () => target.call(TARGET_UI_CHUNK, [text]));
      await report('ui-copy', {done: references, total: header.total});
      await guarded('ui-yield', yieldControl);
    }
    if (references !== header.total) throw new RustPrepareJobError('Prepare UI transfer incomplete', {code: 'BAD_UI', phase: 'source-ui-next', ticket});
    await guarded('source-ui-check', () => port.call(SOURCE_UI_CHECK, [ticket]));
    await guarded('target-ui-end', () => target.call(TARGET_UI_END, []));
    const finished = await guarded('target-finish', () => target.call(TARGET_FINISH, ['']));
    if (finished !== true) throw new RustPrepareJobError('Prepare target finish was not acknowledged', {code: 'BAD_RESULT', phase: 'target-finish', ticket});
    // Target finish can take a long time and may run while the source mutates.
    // Recheck the live source after the candidate is complete, immediately
    // before the source lease release commit boundary.
    await guarded('source-ui-final-check', () => port.call(SOURCE_UI_CHECK, [ticket]));
    await report('target-ready', {complete: true});

    // Release is the source-side commit boundary. A lost response must never
    // be replayed because it could already have dropped the live lease.
    check('source-release');
    try {
      await port.call(SOURCE_RELEASE, [ticket]);
    } catch (cause) {
      commitUncertain = true;
      throw new RustPrepareCommitUncertainError(cause, {...details('source-release'), commitUncertain: true});
    }
    sourceReleased = true;
    check('source-release');
    let activation;
    const candidate = {
      actor: target,
      generation: target.generation ?? null,
      ticket,
      kind: normalized.kind,
      count: normalized.count,
      request: own(normalized.request, 'prepare request'),
      metadataJSON: admitted.metadataJSON,
      uiHeader: header.header,
      uiChunks: Object.freeze(uiChunks.slice()),
      handoff() { handedOff = true; },
    };
    if (activate) {
      activationStarted = true;
      try {
        activation = await activate(candidate);
      } catch (cause) {
        commitUncertain = true;
        throw new RustPrepareCommitUncertainError(cause, {...details('activation'), commitUncertain: true});
      }
    }
    const result = Object.freeze({schema: 'aster.web-wasm.prepare-result', version: 1, status: 'target-ready', ticket, kind: normalized.kind, count: normalized.count, metadataJSON: admitted.metadataJSON, uiHeader: header.header, uiChunks: Object.freeze(uiChunks.slice()), actor: target, generation: target.generation ?? null, candidate: Object.freeze(candidate), activation});
    handedOff = true;
    return result;
  } catch (error) {
    if (activationStarted && !(error instanceof RustPrepareCommitUncertainError)) {
      commitUncertain = true;
      throw new RustPrepareCommitUncertainError(error, details('activation'));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}

// Keep the source call race in one small helper so cancellation semantics stay
// identical to target calls while preserving the late-Begin cleanup above.
async function sourceCall(sourceStarted, port, name, args, phase, guarded) {
  if (!sourceStarted) throw new RustPrepareJobError('Prepare source is not active', {code: 'SOURCE_MISSING', phase});
  return guarded(phase, () => port.call(name, args));
}
