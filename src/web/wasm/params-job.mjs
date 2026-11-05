// High-level NativeParams transport for the web Rust backend.
//
// This module deliberately contains no indicator or chart calculations.  The
// active session owns the source runtime and a private Rust actor owns the
// isolated target runtime; all protocol validation and publication decisions
// remain in the Rust core.

const SOURCE_PREFIX = 'web.paramsSource';
const SOURCE_ABORT = `${SOURCE_PREFIX}Abort`;
const SOURCE_BEGIN = `${SOURCE_PREFIX}Begin`;
const SOURCE_STEP = `${SOURCE_PREFIX}Step`;
const SOURCE_CHECK = `${SOURCE_PREFIX}Check`;
const SOURCE_RECEIVE = `${SOURCE_PREFIX}Receive`;
const SOURCE_ARM_WRITE = `${SOURCE_PREFIX}ArmWrite`;
const SOURCE_CHECKPOINT = `${SOURCE_PREFIX}Checkpoint`;
const SOURCE_VALIDATE = `${SOURCE_PREFIX}Validate`;
const SOURCE_PREPARE = `${SOURCE_PREFIX}Prepare`;
const SOURCE_PUBLISH = `${SOURCE_PREFIX}Publish`;

const TARGET_CREATE = 'nativeParamsTargetCreate';
const TARGET_START = 'nativeParamsTargetStart';
const TARGET_STEP = 'nativeParamsTargetStep';
const TARGET_DESCRIPTOR = 'nativeParamsTargetDescriptor';
const TARGET_CHECKPOINT = 'nativeParamsTargetCheckpoint';
const TARGET_DISPOSE = 'nativeParamsTargetDispose';

const SOURCE_BUFFER = 'nativeAsyncBuffer';
const TARGET_BUFFER = 'nativeAsyncTargetBuffer';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 805_306_368;
const DEFAULT_CHUNK_SIZE = 16_384;
const MAX_CHUNK_SIZE = 16_384;
const MAX_ADMISSION_RECORDS = 64;
const MAX_BARS = 4_194_304;
const CLEANUP_TIMEOUT_MS = 250;

export class RustParamsJobError extends Error {
  constructor(message, {
    name = 'RustParamsJobError',
    code = 'PARAMS_JOB',
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

export class RustParamsJobAbortError extends RustParamsJobError {
  constructor(cause, details = {}) {
    super('Rust params job aborted', {
      ...details,
      name: 'AbortError',
      code: 'ABORTED',
      cause,
    });
  }
}

export class RustParamsJobTimeoutError extends RustParamsJobError {
  constructor(cause, details = {}) {
    super('Rust params job timed out', {
      ...details,
      name: 'TimeoutError',
      code: 'TIMEOUT',
      cause,
    });
  }
}

export class RustParamsCommitUncertainError extends RustParamsJobError {
  constructor(cause, details = {}) {
    super('Rust params publication outcome is uncertain; resync is required', {
      ...details,
      name: 'RustParamsCommitUncertainError',
      code: 'COMMIT_UNCERTAIN',
      commitUncertain: true,
      resyncRequired: true,
      cause,
    });
  }
}

export class RustParamsResyncRequiredError extends RustParamsJobError {
  constructor(cause, details = {}) {
    super('Rust params committed but UI publication requires resync', {
      ...details,
      name: 'RustParamsResyncRequiredError',
      code: 'RESYNC_REQUIRED',
      resyncRequired: true,
      cause,
    });
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, label) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new RustParamsJobError(`Could not snapshot ${label}`, {
      code: 'SNAPSHOT_FAILED',
      phase: 'snapshot',
      cause: error,
    });
  }
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
    || typeof signal.aborted !== 'boolean') {
    throw new TypeError('AbortSignal required');
  }
}

function assertFiniteInteger(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Rust params ${label}`);
  }
  return value;
}

function assertPort(port) {
  if (!isObject(port)) throw new TypeError('Rust params port required');
  for (const name of ['call', 'readF64', 'writeF64', 'createTargetActor', 'nextRegistration', 'revision']) {
    if (typeof port[name] !== 'function') throw new TypeError(`Rust params port.${name} required`);
  }
}

function assertTargetActor(actor) {
  if (!isObject(actor)) throw new RustParamsJobError('Target actor is malformed', {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  for (const name of ['call', 'readF64', 'writeF64', 'close']) {
    if (typeof actor[name] !== 'function') throw new RustParamsJobError(`Target actor.${name} is required`, {code: 'BAD_TARGET_ACTOR', phase: 'target-create'});
  }
}

function numberField(value, label, options = {}) {
  return assertFiniteInteger(value, label, options);
}

function jsonObject(text, label) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 131_072) {
    throw new RustParamsJobError(`Malformed ${label}`, {code: 'BAD_METADATA', phase: label});
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RustParamsJobError(`Malformed ${label}`, {code: 'BAD_METADATA', phase: label, cause: error});
  }
  if (!isObject(value)) throw new RustParamsJobError(`Malformed ${label}`, {code: 'BAD_METADATA', phase: label});
  return value;
}

function assertLayout(value, label) {
  if (!Array.isArray(value.outputs) || value.outputs.length > 4096
    || value.outputs.some(output => typeof output !== 'string' || output.length === 0)) {
    throw new RustParamsJobError(`Malformed ${label} outputs`, {code: 'BAD_METADATA', phase: label});
  }
  numberField(value.length, `${label} length`, {max: MAX_BARS});
  numberField(value.capacity, `${label} capacity`, {min: 16, max: MAX_BARS});
  if (value.capacity < value.length) {
    throw new RustParamsJobError(`Malformed ${label} dimensions`, {code: 'BAD_METADATA', phase: label});
  }
}

function validateSourceMetadata(text, id, registration) {
  const metadata = jsonObject(text, 'Native params metadata');
  if (metadata.schema !== 'aster.native-params-target' || metadata.version !== 1
    || metadata.id !== id || metadata.registration !== registration) {
    throw new RustParamsJobError('Malformed Native params metadata', {code: 'BAD_METADATA', phase: 'source-admission'});
  }
  assertLayout(metadata, 'Native params metadata');
  return metadata;
}

function validateResultDescriptor(text, sourceMetadata, id, registration) {
  const descriptor = jsonObject(text, 'Native params result descriptor');
  if (descriptor.schema !== 'aster.native-params-result' || descriptor.version !== 1
    || descriptor.id !== id || descriptor.registration !== registration) {
    throw new RustParamsJobError('Malformed Native params result descriptor', {code: 'BAD_METADATA', phase: 'target-descriptor'});
  }
  assertLayout(descriptor, 'Native params result descriptor');
  numberField(descriptor.checkpointCount, 'Native params checkpoint count');
  if (descriptor.length !== sourceMetadata.length || descriptor.capacity !== sourceMetadata.capacity
    || descriptor.outputs.length !== sourceMetadata.outputs.length
    || descriptor.outputs.some((output, index) => output !== sourceMetadata.outputs[index])) {
    throw new RustParamsJobError('Native params result descriptor does not match source metadata', {code: 'BAD_METADATA', phase: 'target-descriptor'});
  }
  return descriptor;
}

function progress(value, label) {
  if (!isObject(value) || typeof value.complete !== 'boolean') {
    throw new RustParamsJobError(`Malformed ${label} progress`, {code: 'BAD_PROGRESS', phase: label});
  }
  if ('done' in value) numberField(value.done, `${label} progress done`);
  if ('total' in value) numberField(value.total, `${label} progress total`);
  return value;
}

function f64(value, label) {
  if (!(value instanceof Float64Array)) {
    throw new RustParamsJobError(`Malformed ${label} buffer`, {code: 'BAD_BUFFER', phase: label});
  }
  // A port/actor is allowed to retain or transfer its own result.  The job
  // always owns the next write buffer and therefore never detaches caller data.
  return new Float64Array(value);
}

function writeReceipt(value, label) {
  if (value !== true) {
    throw new RustParamsJobError(`${label} write was not acknowledged`, {code: 'WRITE_REJECTED', phase: label});
  }
  return value;
}

function trueReceipt(value, label) {
  if (value !== true) throw new RustParamsJobError(`Malformed ${label} result`, {code: 'BAD_RESULT', phase: label});
  return value;
}

function sourceBegin(value, registration) {
  if (!isObject(value)) throw new RustParamsJobError('Malformed Native params begin result', {code: 'BAD_RESULT', phase: 'source-begin'});
  const ticket = numberField(value.ticket, 'source ticket', {min: 1});
  if (value.registration !== registration) throw new RustParamsJobError('Native params registration mismatch', {code: 'BAD_RESULT', phase: 'source-begin'});
  if (typeof value.phase !== 'string') throw new RustParamsJobError('Malformed Native params begin phase', {code: 'BAD_RESULT', phase: 'source-begin'});
  return {ticket, phase: value.phase};
}

function receipt(value) {
  if (!isObject(value) || (value.status !== 'committed' && value.status !== 'unchanged')) {
    throw new RustParamsJobError('Malformed Native params publication receipt', {code: 'BAD_RECEIPT', phase: 'publish'});
  }
  return own(value, 'publication receipt');
}

function targetLimit(port, actor, key, requested, fallback, max) {
  const configured = requested ?? port[key] ?? port.limits?.[key] ?? actor?.[key] ?? fallback;
  return assertFiniteInteger(configured, key, {min: 1, max});
}

const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Run one Rust NativeParams source/isolated-target job and publish its receipt.
 * The port keeps the active session private; the returned promise never exposes
 * the target actor.
 *
 * @param {RustParamsPort} port
 * @param {string} id
 * @param {object} params
 * @param {RustParamsJobOptions} [options]
 * @returns {Promise<object>}
 */
export async function runRustParamsJob(port, id, params, options = {}) {
  assertPort(port);
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('Native params indicator id required');
  if (!isObject(params)) throw new TypeError('Native params object required');
  if (!isObject(options)) throw new TypeError('Native params job options required');
  const {signal, onProgress} = options;
  assertSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Native params progress callback required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Native params timeout');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  assertFiniteInteger(maxBytes, 'byte budget', {min: 1, max: DEFAULT_MAX_BYTES});
  const admissionRecords = assertFiniteInteger(options.admissionRecords ?? 8, 'admission records', {min: 1, max: MAX_ADMISSION_RECORDS});
  const snapshot = own(params, 'params');
  if (signal?.aborted) throw new RustParamsJobAbortError();

  let cancellation = null;
  let cancelReject;
  const cancelPromise = new Promise((_, reject) => { cancelReject = reject; });
  // The promise is intentionally retained by every guarded operation.  This
  // catch also covers the interval between operations when the signal fires.
  void cancelPromise.catch(() => {});
  const cancel = error => {
    if (cancellation) return;
    cancellation = error;
    cancelReject(error);
  };
  const onAbort = () => cancel(new RustParamsJobAbortError());
  signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => cancel(new RustParamsJobTimeoutError()), timeoutMs);

  let registration = null;
  let ticket = null;
  let sourceStarted = false;
  let publishStarted = false;
  let committed = false;
  let target = null;
  let targetCreated = null;
  let targetDisposePromise = null;
  let targetClosePromise = null;
  let sourceAbortPromise = null;
  let cleanupStarted = false;

  const details = phase => ({phase, registration, ticket});
  const check = phase => {
    if (cancellation) {
      if (cancellation instanceof RustParamsJobAbortError || cancellation instanceof RustParamsJobTimeoutError) {
        cancellation.phase ??= phase;
        cancellation.registration ??= registration;
        cancellation.ticket ??= ticket;
      }
      throw cancellation;
    }
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
      const payload = Object.freeze({...own(value, 'progress'), stage, id, registration, ticket});
      await onProgress(payload);
    });
  };
  const callSource = (name, args, phase) => guarded(phase, () => port.call(name, args));

  const abortSource = () => {
    if (!sourceStarted || committed || sourceAbortPromise) return sourceAbortPromise;
    sourceAbortPromise = Promise.resolve().then(() => port.call(SOURCE_ABORT, [registration])).catch(() => undefined);
    return sourceAbortPromise;
  };
  const disposeTarget = () => {
    if (!target || targetDisposePromise) return targetDisposePromise;
    targetDisposePromise = Promise.resolve().then(() => target.call(TARGET_DISPOSE, [])).catch(() => undefined);
    return targetDisposePromise;
  };
  const closeTarget = () => {
    if (!target || targetClosePromise) return targetClosePromise;
    targetClosePromise = Promise.resolve().then(() => target.close()).catch(() => undefined);
    return targetClosePromise;
  };
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    // Invoke all three operations before waiting.  If a session call is
    // blocked, the actor still receives close and the source still receives
    // its one abort attempt.
    const operations = [];
    // Publish is the commit boundary.  Once it was invoked, the transport
    // cannot distinguish a pre-commit error from a lost post-commit reply, so
    // never enqueue Abort (or replay) from this coordinator.
    if (!committed && !publishStarted) operations.push(abortSource());
    if (target) {
      operations.push(disposeTarget());
      operations.push(closeTarget());
    }
    if (targetCreated) {
      targetCreated.then(actor => {
        if (!target) target = actor;
        if (!targetDisposePromise) void disposeTarget();
        if (!targetClosePromise) void closeTarget();
      }, () => {});
    }
    if (operations.length === 0 && !targetCreated) return;
    const settled = Promise.allSettled(operations);
    await Promise.race([settled, new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS))]);
  };

  try {
    registration = await guarded('registration', () => port.nextRegistration());
    assertFiniteInteger(registration, 'registration', {min: 1});
    const revision = await guarded('revision', () => port.revision());
    assertFiniteInteger(revision, 'host revision');
    const chunkSize = targetLimit(port, null, 'paramsChunkLimit', options.chunkSize, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE);
    const stepSize = targetLimit(port, null, 'paramsStepLimit', options.stepSize, chunkSize, MAX_CHUNK_SIZE);

    // SourceBegin can install the Rust-owned row/lease before its reply crosses
    // the actor boundary.  Mark the attempt before dispatch so cancellation,
    // timeout, malformed reply, and transport failure all enqueue exactly one
    // registration-scoped Abort before Publish.
    sourceStarted = true;
    const beginValue = await callSource(SOURCE_BEGIN, [id, snapshot, revision, maxBytes, registration], 'source-begin');
    const begun = sourceBegin(beginValue, registration);
    ticket = begun.ticket;
    let admission = await callSource(SOURCE_STEP, [ticket, admissionRecords, revision], 'source-admission');
    admission = progress(admission, 'source-admission');
    while (!admission.complete) {
      await report('source-admission', admission);
      await guarded('source-admission-yield', yieldControl);
      admission = progress(await callSource(SOURCE_STEP, [ticket, admissionRecords, revision], 'source-admission'), 'source-admission');
    }
    await report('source-admission', admission);
    trueReceipt(await callSource(SOURCE_CHECK, [ticket, revision], 'source-check'), 'source check');

    // A no-op source has no target metadata and can safely prepare/publish in
    // the active actor.  The core still owns the ledger and publication state.
    if (begun.phase !== 'noop') {
      if (typeof admission.metadataJSON !== 'string') throw new RustParamsJobError('Native params admission metadata missing', {code: 'BAD_METADATA', phase: 'source-admission'});
      const sourceMetadata = validateSourceMetadata(admission.metadataJSON, id, registration);
      targetCreated = Promise.resolve().then(() => port.createTargetActor());
      targetCreated.catch(() => {});
      const created = await Promise.race([targetCreated, cancelPromise]);
      target = created;
      assertTargetActor(target);
      if (cleanupStarted || cancellation) {
        await disposeTarget();
        await closeTarget();
        check('target-create');
      }

      trueReceipt(await guarded('target-create', () => target.call(TARGET_CREATE, [admission.metadataJSON])), 'target create');
      for (let slot = 0; slot < 6; slot++) {
        for (let offset = 0; offset < sourceMetadata.length; offset += chunkSize) {
          const count = Math.min(chunkSize, sourceMetadata.length - offset);
          const values = f64(await guarded('input-transfer', () => port.readF64(SOURCE_BUFFER, [ticket, slot, offset, count])), 'input-transfer');
          if (values.length !== count) throw new RustParamsJobError('Native params input length mismatch', {code: 'BAD_BUFFER', phase: 'input-transfer'});
          writeReceipt(await guarded('input-transfer', () => target.writeF64(TARGET_BUFFER, [slot, offset, count], values)), 'input-transfer');
          await report('input-transfer', {slot, offset: offset + count, total: sourceMetadata.length});
          await guarded('input-transfer-yield', yieldControl);
        }
      }
      trueReceipt(await guarded('target-start', () => target.call(TARGET_START, [])), 'target start');
      let targetProgress = progress(await guarded('target-step', () => target.call(TARGET_STEP, [stepSize])), 'target-step');
      while (!targetProgress.complete) {
        await report('target-calculation', targetProgress);
        await guarded('target-calculation-yield', yieldControl);
        targetProgress = progress(await guarded('target-step', () => target.call(TARGET_STEP, [stepSize])), 'target-step');
      }
      await report('target-calculation', targetProgress);

      const descriptorJSON = await guarded('target-descriptor', () => target.call(TARGET_DESCRIPTOR, []));
      const descriptor = validateResultDescriptor(descriptorJSON, sourceMetadata, id, registration);
      trueReceipt(await callSource(SOURCE_RECEIVE, [ticket, descriptorJSON, revision], 'source-receive'), 'source receive');
      for (let slot = 0; slot < descriptor.outputs.length; slot++) {
        for (let offset = 0; offset < descriptor.capacity; offset += chunkSize) {
          const count = Math.min(chunkSize, descriptor.capacity - offset);
          const values = f64(await guarded('result-transfer', () => target.readF64(SOURCE_BUFFER, [registration, slot, offset, count])), 'result-transfer');
          if (values.length !== count) throw new RustParamsJobError('Native params result length mismatch', {code: 'BAD_BUFFER', phase: 'result-transfer'});
          trueReceipt(await callSource(SOURCE_ARM_WRITE, [ticket, slot, offset, count, revision], 'result-arm'), 'source arm');
          writeReceipt(await guarded('result-write', () => port.writeF64(TARGET_BUFFER, [slot, offset, count], values)), 'result-write');
          await report('result-transfer', {slot, offset: offset + count, total: descriptor.capacity});
          await guarded('result-transfer-yield', yieldControl);
        }
      }
      for (let ordinal = 0; ordinal < descriptor.checkpointCount; ordinal++) {
        const row = await guarded('checkpoint-transfer', () => target.call(TARGET_CHECKPOINT, [ordinal]));
        if (!isObject(row) || !Number.isSafeInteger(row.index) || typeof row.text !== 'string') {
          throw new RustParamsJobError('Malformed Native params checkpoint', {code: 'BAD_CHECKPOINT', phase: 'checkpoint-transfer'});
        }
        trueReceipt(await callSource(SOURCE_CHECKPOINT, [ticket, row.index, row.text, revision], 'checkpoint-transfer'), 'source checkpoint');
        await report('checkpoint-transfer', {done: ordinal + 1, total: descriptor.checkpointCount});
        await guarded('checkpoint-transfer-yield', yieldControl);
      }
      await disposeTarget();
      await closeTarget();
      let validation = progress(await callSource(SOURCE_VALIDATE, [ticket, chunkSize, revision], 'source-validation'), 'source-validation');
      while (!validation.complete) {
        await report('source-validation', validation);
        await guarded('source-validation-yield', yieldControl);
        validation = progress(await callSource(SOURCE_VALIDATE, [ticket, chunkSize, revision], 'source-validation'), 'source-validation');
      }
      await report('source-validation', validation);
    }

    trueReceipt(await callSource(SOURCE_PREPARE, [ticket, revision], 'source-prepare'), 'source prepare');
    const published = receipt(await guarded('publish', () => {
      // Mark the boundary inside the action, after the cancellation fence has
      // admitted the call.  A cancellation between Prepare and Publish may
      // still abort the source; a cancellation during Publish is uncertain.
      publishStarted = true;
      return port.call(SOURCE_PUBLISH, [ticket, revision]);
    }));
    committed = true;
    if (typeof port.committed === 'function') {
      try {
        const callbackResult = await Promise.race([
          Promise.resolve().then(() => port.committed(own(published, 'committed receipt'))),
          cancelPromise,
        ]);
        if (callbackResult === false) throw new Error('Committed callback returned false');
      } catch (error) {
        throw new RustParamsResyncRequiredError(error, {...details('committed'), resyncRequired: true});
      }
    }
    return published;
  } catch (error) {
    if (publishStarted && !committed && !(error instanceof RustParamsCommitUncertainError)) {
      throw new RustParamsCommitUncertainError(error, details('publish'));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}
