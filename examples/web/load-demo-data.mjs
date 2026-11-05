import {DATA_FIELDS, MAX_DEMO_DATA_COUNT} from './demo-data.mjs';

const MAX_ERROR_LENGTH = 256;

function errorWithName(name, message, cause) {
  const error = new Error(String(message).slice(0, MAX_ERROR_LENGTH), cause === undefined ? undefined : {cause});
  error.name = name;
  return error;
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw new TypeError('Demo data AbortSignal required');
}

function assertInput(market, count) {
  if (!['us', 'kr', 'crypto'].includes(market)) throw new TypeError('Demo market');
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_DEMO_DATA_COUNT) throw new RangeError('Demo data count limit');
}

function validateColumns(value, market, count) {
  if (!value || value.schema !== 'aster.demo-data-result' || value.version !== 1 || value.market !== market || value.count !== count || !value.columns || typeof value.columns !== 'object') throw errorWithName('DataWorkerProtocolError', 'Malformed demo data worker result');
  const columns = {};
  for (const key of DATA_FIELDS) {
    const source = value.columns[key];
    if (!(source instanceof Float64Array) || source.length !== count) throw errorWithName('DataWorkerProtocolError', 'Malformed demo data column');
    // A transferred typed array is already owned by this realm.  Copying the
    // six references into a fresh record prevents a worker-shaped object from
    // leaking into the public result while retaining the transferred buffers.
    columns[key] = source;
  }
  return Object.freeze(columns);
}

/** Load synthetic OHLCV data in a dedicated worker, without a main-thread fallback. */
export async function loadDemoData({market, count, signal, onProgress} = {}) {
  assertInput(market, count);
  assertSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Demo data progress callback required');
  if (signal?.aborted) throw errorWithName('AbortError', 'Demo data load cancelled');
  return new Promise((resolve, reject) => {
    let worker = null;
    let finished = false;
    let timeoutClean = false;
    const removeAbort = () => { if (signal) signal.removeEventListener('abort', abort); };
    const terminate = () => {
      if (!worker || timeoutClean) return;
      timeoutClean = true;
      try { worker.onmessage = null; worker.onerror = null; } catch {}
      try { worker.terminate(); } catch {}
      worker = null;
    };
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      removeAbort();
      terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(errorWithName('AbortError', 'Demo data load cancelled'));
    if (signal) signal.addEventListener('abort', abort, {once: true});
    try {
      // Keep this literal URL expression for module-aware bundlers.
      worker = new Worker(new URL('./demo-data-worker.mjs', import.meta.url), {type: 'module'});
      if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw new TypeError('Dedicated demo data Worker interface required');
      worker.onerror = event => finish(errorWithName('DataWorkerError', event?.message || 'Demo data Worker failed', event));
      worker.onmessage = event => {
        if (finished) return;
        const data = event?.data;
        if (data?.progress) {
          try { onProgress?.(data.progress); } catch {}
          return;
        }
        try {
          if (data?.error !== undefined) throw errorWithName('DataWorkerError', data.error);
          finish(null, validateColumns(data, market, count));
        } catch (error) {
          finish(error);
        }
      };
      worker.postMessage({schema: 'aster.demo-data-request', version: 1, market, count});
    } catch (error) {
      finish(errorWithName(error?.name === 'AbortError' ? 'AbortError' : 'DataWorkerError', error?.message ?? error, error));
    }
  });
}
