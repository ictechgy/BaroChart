// High-level workspace/UI migration coordinator for the web Rust backend.
//
// The active session and the candidate actor are intentionally supplied by the
// caller.  This module only moves protocol-owned bytes and JSON between them;
// it never exposes an Instance or WebAssembly.Memory and never retries an
// operation after a commit boundary has been entered.

const SOURCE_BEGIN = 'web.migrationSourceBegin';
const SOURCE_STEP = 'web.migrationSourceStep';
const SOURCE_UI_BEGIN = 'web.migrationSourceUiBegin';
const SOURCE_UI_NEXT = 'web.migrationSourceUiNext';
const SOURCE_CHECK = 'web.migrationSourceCheck';
const SOURCE_FINISH = 'web.migrationSourceFinish';
const SOURCE_ABORT = 'web.migrationSourceAbort';
const TARGET_CREATE = 'web.migrationTargetCreate';
const TARGET_START = 'web.migrationTargetStart';
const TARGET_STEP = 'web.migrationTargetStep';
const TARGET_UI_BEGIN = 'web.migrationTargetUiBegin';
const TARGET_UI_CHUNK = 'web.migrationTargetUiChunk';
const TARGET_UI_FINISH = 'web.migrationTargetUiFinish';
const TARGET_ABORT = 'web.migrationTargetAbort';
const SOURCE_BUFFER = 'nativeAsyncBuffer';
const TARGET_BUFFER = 'nativeAsyncTargetBuffer';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 805_306_368;
const DEFAULT_CHUNK_SIZE = 16_384;
const MAX_CHUNK_SIZE = 16_384;
const MAX_STEP_SIZE = 16_384;
const MAX_RECORDS = 64;
const MAX_BARS = 4_194_304;
const MAX_UI_CHUNKS = 1_048_576;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 250;

export class RustMigrationJobError extends Error {
  constructor(message, {
    name = 'RustMigrationJobError',
    code = 'MIGRATION_JOB',
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

export class RustMigrationJobAbortError extends RustMigrationJobError {
  constructor(cause, details = {}) {
    super('Rust workspace migration aborted', {
      ...details,
      name: 'AbortError',
      code: 'ABORTED',
      cause,
    });
  }
}

export class RustMigrationJobTimeoutError extends RustMigrationJobError {
  constructor(cause, details = {}) {
    super('Rust workspace migration timed out', {
      ...details,
      name: 'TimeoutError',
      code: 'TIMEOUT',
      cause,
    });
  }
}

export class RustMigrationCommitUncertainError extends RustMigrationJobError {
  constructor(cause, details = {}) {
    super('Rust workspace migration commit outcome is uncertain; resync is required', {
      ...details,
      name: 'RustMigrationCommitUncertainError',
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
    throw new RustMigrationJobError(`Could not snapshot ${label}`, {
      code: 'SNAPSHOT_FAILED',
      phase: 'snapshot',
      cause,
    });
  }
}

function signalCheck(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
    || typeof signal.aborted !== 'boolean') {
    throw new TypeError('AbortSignal required');
  }
}

function integer(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Rust migration ${label}`);
  return value;
}

function assertPort(port) {
  if (!object(port)) throw new TypeError('Rust migration port required');
  for (const name of ['call', 'readF64', 'createTargetActor', 'nextRegistration', 'revision']) {
    if (typeof port[name] !== 'function') throw new TypeError(`Rust migration port.${name} required`);
  }
}

function assertActor(actor) {
  if (!object(actor)) throw new RustMigrationJobError('Migration target actor is malformed', {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  for (const name of ['call', 'writeF64', 'close']) {
    if (typeof actor[name] !== 'function') throw new RustMigrationJobError(`Migration target actor.${name} is required`, {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  }
}

function parseJson(value, label, {maxBytes = MAX_JSON_BYTES} = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes) {
    throw new RustMigrationJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label});
  }
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error('object required');
    return parsed;
  } catch (cause) {
    throw new RustMigrationJobError(`Malformed ${label}`, {code: 'BAD_JSON', phase: label, cause});
  }
}

function progress(value, label) {
  const parsed = typeof value === 'string' ? parseJson(value, label) : value;
  if (!object(parsed) || typeof parsed.complete !== 'boolean') {
    throw new RustMigrationJobError(`Malformed ${label} progress`, {code: 'BAD_PROGRESS', phase: label});
  }
  if ('done' in parsed) integer(parsed.done, `${label} done`);
  if ('total' in parsed) integer(parsed.total, `${label} total`);
  return parsed;
}

function begin(value, registration) {
  if (!object(value)) throw new RustMigrationJobError('Malformed migration source begin result', {code: 'BAD_RESULT', phase: 'source-begin'});
  const ticket = integer(value.ticket, 'source ticket', {min: 1});
  if (value.registration !== undefined && value.registration !== registration) {
    throw new RustMigrationJobError('Migration registration mismatch', {code: 'BAD_RESULT', phase: 'source-begin'});
  }
  if (typeof value.phase !== 'string') throw new RustMigrationJobError('Malformed migration source phase', {code: 'BAD_RESULT', phase: 'source-begin'});
  return {ticket, phase: value.phase};
}

function buffers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
    throw new RustMigrationJobError('Malformed migration data buffers', {code: 'BAD_METADATA', phase: 'source-admission'});
  }
  const lengths = [];
  for (let index = 0; index < value.length; index++) {
    const row = value[index];
    if (!object(row) || row.slot !== index) throw new RustMigrationJobError('Migration data buffer slots are not contiguous', {code: 'BAD_METADATA', phase: 'source-admission'});
    lengths.push(integer(row.length, `buffer ${index} length`, {max: MAX_BARS}));
  }
  return lengths;
}

function uiBegin(value) {
  if (!object(value) || typeof value.header !== 'string' || value.header.length === 0 || !object(value.description)) {
    throw new RustMigrationJobError('Malformed migration UI source begin result', {code: 'BAD_UI', phase: 'source-ui-begin'});
  }
  return {header: value.header, description: own(value.description, 'migration UI description')};
}

function uiChunk(value) {
  const parsed = parseJson(value, 'migration UI chunk');
  if (typeof parsed.complete !== 'boolean') throw new RustMigrationJobError('Malformed migration UI chunk completion', {code: 'BAD_UI', phase: 'source-ui-next'});
  return parsed;
}

function targetReady(value) {
  if (!object(value) || value.schema !== 'aster.web-ui-migration-ready' || value.version !== 1 || value.status !== 'target-ready') {
    throw new RustMigrationJobError('Malformed migration target-ready result', {code: 'BAD_RESULT', phase: 'target-ui-finish'});
  }
  return own(value, 'migration target receipt');
}

function cloneF64(value, count, label) {
  if (!(value instanceof Float64Array) || value.length !== count) {
    throw new RustMigrationJobError(`Malformed ${label} buffer`, {code: 'BAD_BUFFER', phase: label});
  }
  return new Float64Array(value);
}

const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));

function normalizeInvocation(documentOrConfig, bindingOrOptions, maybeOptions) {
  if (object(documentOrConfig) && Object.hasOwn(documentOrConfig, 'document') && Object.hasOwn(documentOrConfig, 'binding')) {
    const config = documentOrConfig;
    return {document: config.document, binding: config.binding, options: bindingOrOptions ?? {}};
  }
  return {document: documentOrConfig, binding: bindingOrOptions, options: maybeOptions ?? {}};
}

function workspaceDocument(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_JSON_BYTES) {
    throw new TypeError('Rust workspace document must be a bounded JSON string');
  }
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error('workspace object required');
  } catch (cause) {
    throw new RustMigrationJobError('Malformed Rust workspace document', {code: 'BAD_DOCUMENT', phase: 'snapshot', cause});
  }
  return value;
}

/**
 * Run a complete workspace/UI migration against an isolated Rust actor.
 *
 * The returned `candidate.actor` remains owned by the caller after success.
 * If `port.activate` is supplied, it is called after source validation and
 * source finish; an activation error is commit-uncertain and is never followed
 * by an automatic target close or source abort.
 *
 * @param {object} port active-session transport
 * @param {string|object} documentOrConfig workspace JSON string, or `{document,binding}`
 * @param {object} bindingOrOptions workspace binding, or options for config form
 * @param {object} maybeOptions options for positional form
 * @returns {Promise<object>}
 */
export async function runRustMigrationJob(port, documentOrConfig, bindingOrOptions, maybeOptions) {
  assertPort(port);
  const {document, binding, options} = normalizeInvocation(documentOrConfig, bindingOrOptions, maybeOptions);
  if (!object(options)) throw new TypeError('Rust migration options required');
  workspaceDocument(document);
  if (!object(binding)) throw new TypeError('Rust workspace binding required');
  const {signal, onProgress, activate} = options;
  signalCheck(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Rust migration progress callback required');
  if (activate !== undefined && typeof activate !== 'function') throw new TypeError('Rust migration activation callback required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Rust migration timeout');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  integer(maxBytes, 'byte budget', {min: 1, max: DEFAULT_MAX_BYTES});
  const admissionRecords = integer(options.admissionRecords ?? 8, 'admission records', {min: 1, max: MAX_RECORDS});
  const chunkSize = integer(options.chunkSize ?? DEFAULT_CHUNK_SIZE, 'chunk size', {min: 1, max: MAX_CHUNK_SIZE});
  const stepSize = integer(options.stepSize ?? chunkSize, 'step size', {min: 1, max: MAX_STEP_SIZE});
  const documentCopy = own(document, 'workspace document');
  const bindingCopy = own(binding, 'workspace binding');
  if (signal?.aborted) throw new RustMigrationJobAbortError();

  let cancellation = null;
  let cancelReject;
  const cancelPromise = new Promise((_, reject) => { cancelReject = reject; });
  void cancelPromise.catch(() => {});
  const cancel = error => { if (!cancellation) { cancellation = error; cancelReject(error); } };
  const onAbort = () => cancel(new RustMigrationJobAbortError());
  signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => cancel(new RustMigrationJobTimeoutError()), timeoutMs);

  let registration = null;
  let ticket = null;
  let sourceStarted = false;
  let sourceFinished = false;
  let target = null;
  let targetCreated = null;
  let targetAborted = false;
  let targetClosed = false;
  let targetAbortPromise = null;
  let targetClosePromise = null;
  let sourceBeginPromise = null;
  let sourceAbortPromise = null;
  let cleanupStarted = false;
  let activationStarted = false;
  let commitUncertain = false;
  let handedOff = false;

  const details = phase => ({phase, registration, ticket});
  const check = phase => {
    if (!cancellation) return;
    if (cancellation instanceof RustMigrationJobAbortError || cancellation instanceof RustMigrationJobTimeoutError) {
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
      const payload = Object.freeze({...own(value, 'progress'), stage, registration, ticket});
      await onProgress(payload);
    });
  };
  const sourceCall = (name, args, phase) => guarded(phase, () => port.call(name, args));
  const abortSource = () => {
    if (!sourceStarted || sourceFinished || activationStarted || ticket === null) return sourceAbortPromise;
    if (sourceAbortPromise) return sourceAbortPromise;
    sourceAbortPromise = Promise.resolve().then(() => port.call(SOURCE_ABORT, [ticket])).catch(() => undefined);
    return sourceAbortPromise;
  };
  const abortTarget = () => {
    if (!target || targetAborted) return targetAbortPromise;
    targetAborted = true;
    targetAbortPromise = Promise.resolve().then(() => target.call(TARGET_ABORT, [])).catch(() => undefined);
    return targetAbortPromise;
  };
  const closeTarget = () => {
    if (!target || targetClosed) return targetClosePromise;
    targetClosed = true;
    targetClosePromise = Promise.resolve().then(() => target.close()).catch(() => undefined);
    return targetClosePromise;
  };
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    // The candidate is retained only after an explicit handoff. Before that
    // point, source finish may already have released its lease, but the private
    // actor is still caller-unowned and must be closed on every error.
    if (handedOff) return;
    const operations = [];
    if (!sourceFinished && !commitUncertain) {
      const sourceAbort = abortSource();
      if (sourceAbort) operations.push(sourceAbort);
    }
    if (target) {
      if (!sourceFinished && !commitUncertain) operations.push(abortTarget());
      operations.push(closeTarget());
    }
    if (targetCreated) {
      targetCreated.then(actor => {
        if (!target) target = actor;
        if (!handedOff) {
          if (!sourceFinished && !commitUncertain) void abortTarget();
          void closeTarget();
        }
      }, () => {});
    }
    if (sourceBeginPromise) {
      // A Begin request may resolve after AbortSignal won the public race. Its
      // completion handler below extracts the real ticket and sends exactly
      // one ticket-scoped abort; never guess ticket == registration.
      sourceBeginPromise.catch(() => {});
    }
    if (operations.length === 0 && !targetCreated) return;
    await Promise.race([Promise.allSettled(operations), new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS))]);
  };

  try {
    registration = integer(await guarded('registration', () => port.nextRegistration()), 'registration', {min: 1});
    const revision = integer(await guarded('revision', () => port.revision()), 'host revision', {min: 1});
    check('source-begin');
    sourceBeginPromise = Promise.resolve().then(() => port.call(SOURCE_BEGIN, [documentCopy, bindingCopy, revision, maxBytes, registration]));
    sourceBeginPromise.then(value => {
      if (sourceStarted || !cancellation || sourceFinished || activationStarted) return;
      try {
        const late = begin(value, registration);
        ticket = late.ticket;
        sourceStarted = true;
        void abortSource();
      } catch {
        // A failed Begin did not admit a source ticket, so there is nothing
        // safe to abort. The original cancellation remains the public error.
      }
    }, () => {});
    const beginValue = await Promise.race([sourceBeginPromise, cancelPromise]);
    const started = begin(beginValue, registration);
    ticket = started.ticket;
    sourceStarted = true;

    let admission = progress(await sourceCall(SOURCE_STEP, [ticket, admissionRecords, revision], 'source-admission'), 'source-admission');
    while (!admission.complete) {
      await report('source-admission', admission);
      await guarded('source-admission-yield', yieldControl);
      admission = progress(await sourceCall(SOURCE_STEP, [ticket, admissionRecords, revision], 'source-admission'), 'source-admission');
    }
    await report('source-admission', admission);
    if (typeof admission.metadataJSON !== 'string') throw new RustMigrationJobError('Migration source metadata missing', {code: 'BAD_METADATA', phase: 'source-admission'});
    const sourceMetadata = parseJson(admission.metadataJSON, 'migration workspace metadata');
    const lengths = buffers(admission.buffers);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (!Number.isSafeInteger(total) || total > MAX_BARS * lengths.length) throw new RustMigrationJobError('Migration data buffer total is too large', {code: 'BAD_METADATA', phase: 'source-admission'});

    const ui = uiBegin(await sourceCall(SOURCE_UI_BEGIN, [ticket, revision], 'source-ui-begin'));
    const uiChunks = [];
    let uiRow;
    do {
      uiRow = await sourceCall(SOURCE_UI_NEXT, [ticket], 'source-ui-next');
      const parsed = uiChunk(uiRow);
      if (!parsed.complete) {
        uiChunks.push(String(uiRow));
        if (uiChunks.length > MAX_UI_CHUNKS) throw new RustMigrationJobError('Migration UI chunk limit exceeded', {code: 'LIMIT', phase: 'source-ui-next'});
      }
      await report('source-ui', {done: uiChunks.length});
      if (!parsed.complete) await guarded('source-ui-yield', yieldControl);
    } while (!uiRow || !uiChunk(uiRow).complete);

    // UI capture is a second live-owner fence.  Reject a changed source before
    // allocating the isolated target actor; the transfer loop and final check
    // still repeat this fence around the long-running copy.
    await sourceCall(SOURCE_CHECK, [ticket, registration, revision], 'source-check');
    targetCreated = Promise.resolve().then(() => port.createTargetActor());
    targetCreated.catch(() => {});
    target = await Promise.race([targetCreated, cancelPromise]);
    assertActor(target);
    check('target-create');
    await guarded('target-create', () => target.call(TARGET_CREATE, [admission.metadataJSON, ticket, registration, revision]));
    for (let slot = 0; slot < lengths.length; slot++) {
      for (let offset = 0; offset < lengths[slot]; offset += chunkSize) {
        const count = Math.min(chunkSize, lengths[slot] - offset);
        const values = cloneF64(await guarded('input-transfer', () => port.readF64(SOURCE_BUFFER, [ticket, slot, offset, count])), count, 'migration input');
        const wrote = await guarded('input-transfer', () => target.writeF64(TARGET_BUFFER, [slot, offset, count], values));
        if (wrote !== true) throw new RustMigrationJobError('Migration target rejected data buffer', {code: 'WRITE_REJECTED', phase: 'input-transfer'});
        await report('input-transfer', {slot, offset: offset + count, total: lengths[slot]});
        await guarded('input-transfer-yield', yieldControl);
      }
    }
    await guarded('target-start', () => target.call(TARGET_START, []));
    let targetProgress = progress(await guarded('target-calculation', () => target.call(TARGET_STEP, [stepSize])), 'target-calculation');
    while (!targetProgress.complete) {
      await report('target-calculation', targetProgress);
      await guarded('target-calculation-yield', yieldControl);
      targetProgress = progress(await guarded('target-calculation', () => target.call(TARGET_STEP, [stepSize])), 'target-calculation');
    }
    await report('target-calculation', targetProgress);
    await guarded('target-ui-begin', () => target.call(TARGET_UI_BEGIN, [ui.description, ui.header]));
    for (const row of uiChunks) {
      await guarded('target-ui-chunk', () => target.call(TARGET_UI_CHUNK, [row]));
      await guarded('target-ui-yield', yieldControl);
    }
    const ready = targetReady(await guarded('target-ui-finish', () => target.call(TARGET_UI_FINISH, [ticket, registration, revision])));
    await report('target-ready', ready);
    await sourceCall(SOURCE_CHECK, [ticket, registration, revision], 'source-check');

    // SourceFinish releases the live source lease.  It is the first commit
    // boundary; cancellation after this call must not enqueue SourceAbort.
    check('source-finish');
    let sourceReceipt;
    try {
      sourceReceipt = await port.call(SOURCE_FINISH, [ticket, registration, revision]);
    } catch (cause) {
      commitUncertain = true;
      throw new RustMigrationCommitUncertainError(cause, {...details('source-finish'), commitUncertain: true});
    }
    sourceFinished = true;
    // If cancellation raced the response, SourceFinish still completed and
    // source abort must not be replayed.  The caller receives the cancellation
    // while retaining the candidate for explicit resync/activation handling.
    check('source-finish');

    let activationResult;
    const candidate = {
      actor: target,
      generation: target.generation ?? null,
      ticket,
      registration,
      revision,
      metadata: own(sourceMetadata, 'migration metadata'),
      metadataJSON: admission.metadataJSON,
      header: ui.header,
      description: own(ui.description, 'migration UI description'),
      uiChunks: Object.freeze(uiChunks.slice()),
      // Root calls this immediately before handing the actor to the stable
      // session facade. If activation then reports an error, cleanup can retain
      // the actor because ownership has already crossed the boundary.
      handoff() { handedOff = true; },
    };
    if (activate) {
      activationStarted = true;
      try {
        activationResult = await activate(candidate);
      } catch (cause) {
        commitUncertain = true;
        throw new RustMigrationCommitUncertainError(cause, {...details('activation'), commitUncertain: true});
      }
    }
    const result = Object.freeze({
      schema: 'aster.web-wasm.migration-result',
      version: 1,
      status: 'target-ready',
      ticket,
      registration,
      revision,
      sourceReceipt: own(sourceReceipt, 'migration source receipt'),
      targetReceipt: ready,
      candidate: Object.freeze(candidate),
      activation: activationResult,
    });
    handedOff = true;
    return result;
  } catch (error) {
    if (activationStarted && !(error instanceof RustMigrationCommitUncertainError)) {
      commitUncertain = true;
      throw new RustMigrationCommitUncertainError(error, details('activation'));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}
