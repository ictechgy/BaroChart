import {parseDemoLayout,stringifyDemoLayout,MAX_DEMO_LAYOUT_BYTES} from './demo-layout-preset.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from '../../src/core/checkpoint-validation.mjs';

export const LAYOUT_STORAGE_KEY = 'barochart.main-demo.layout.v1';

const MEMORY_SCHEMA = 'barochart.main-demo-memory';
const MEMORY_VERSION = 1;
const MEMORY_TEXT_OVERHEAD = 256;
const MAX_MEMORY_TEXT = MAX_DEMO_LAYOUT_BYTES + MEMORY_TEXT_OVERHEAD;
const noop = () => {};

function report(onStatus,message) {
  try { onStatus(message); } catch {}
}

function exactDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('layout memory document');
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['schema','version','enabled','preset'].every(key => Object.hasOwn(value,key))) throw new TypeError('layout memory keys');
  if (value.schema !== MEMORY_SCHEMA || value.version !== MEMORY_VERSION || typeof value.enabled !== 'boolean') throw new TypeError('layout memory header');
  if (value.enabled === false && value.preset !== null) throw new TypeError('disabled layout memory');
  return value;
}

function normalizedPreset(value) {
  if (value === null) return null;
  // Running through both codec directions gives callers the same normalized,
  // detached value as a normal layout import and preserves tagged -0 values.
  return parseDemoLayout(stringifyDemoLayout(value));
}

function documentValue(enabled,preset) {
  return {schema: MEMORY_SCHEMA, version: MEMORY_VERSION, enabled, preset: enabled ? preset : null};
}

function boundedText(text) {
  if (typeof text !== 'string' || text.length > MAX_MEMORY_TEXT) throw new RangeError('layout memory text limit');
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('layout memory Unicode scalar');
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('layout memory Unicode scalar');
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > MAX_MEMORY_TEXT) throw new RangeError('layout memory byte limit');
  }
  return text;
}

function documentText(document) {
  return boundedText(safeCheckpointStringify(document));
}

export function createLayoutMemory({getStorage,getPreset,onStatus = noop,delay = 300} = {}) {
  if (typeof getPreset !== 'function') throw new TypeError('getPreset function required');
  if (!Number.isFinite(delay) || delay < 0) throw new RangeError('delay must be non-negative');

  let disposed = false;
  let initialized = false;
  let enabled = true;
  let preset = null;
  let dirty = false;
  let timer = null;
  let storageResolved = false;
  let storageValue = null;

  function cancelTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  function storage() {
    if (storageResolved) return storageValue;
    try {
      const value = typeof getStorage === 'function' ? getStorage() : null;
      if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function') throw new TypeError('storage unavailable');
      storageResolved = true; storageValue = value; return value;
    } catch {
      report(onStatus,'레이아웃 저장소를 사용할 수 없습니다.');
      return null;
    }
  }

  function initialize() {
    if (initialized) return true;
    initialized = true;
    const target = storage();
    if (!target) return false;
    let text;
    try { text = target.getItem(LAYOUT_STORAGE_KEY); }
    catch { report(onStatus,'레이아웃 저장소를 읽을 수 없습니다.'); return false; }
    if (text === null || text === undefined) return true;
    try {
      const document = exactDocument(safeCheckpointParse(boundedText(text)));
      const nextPreset = document.preset === null ? null : normalizedPreset(document.preset);
      enabled = document.enabled;
      preset = enabled ? nextPreset : null;
    } catch {
      enabled = true; preset = null;
      report(onStatus,'저장된 레이아웃이 유효하지 않아 무시했습니다.');
    }
    return true;
  }

  function save(document) {
    const target = storage();
    if (!target) return false;
    let text;
    try { text = documentText(document); }
    catch { report(onStatus,'레이아웃을 저장하지 못했습니다.'); return false; }
    try {
      target.setItem(LAYOUT_STORAGE_KEY,text);
      return true;
    } catch {
      report(onStatus,'레이아웃 저장에 실패했습니다.');
      return false;
    }
  }

  function flush() {
    if (disposed) return false;
    initialize(); cancelTimer();
    if (!enabled) { dirty = false; return true; }
    if (!dirty) return true;
    const target = storage();
    if (!target) return false;
    let next;
    try { next = getPreset(); }
    catch { report(onStatus,'레이아웃을 저장하지 못했습니다.'); return false; }
    if (next === null || next === undefined) { report(onStatus,'차트가 준비된 뒤 레이아웃을 저장하세요.'); return false; }
    let normalized;
    try { normalized = normalizedPreset(next); }
    catch { report(onStatus,'레이아웃을 저장하지 못했습니다.'); return false; }
    if (!save(documentValue(true,normalized))) return false;
    preset = normalized; dirty = false;
    report(onStatus,'레이아웃을 저장했습니다.');
    return true;
  }

  function changed() {
    if (disposed) return false;
    initialize();
    if (!enabled) return false;
    dirty = true;
    if (timer === null) timer = setTimeout(() => { timer = null; if (dirty && !disposed) flush(); }, delay);
    return true;
  }

  function setEnabled(value) {
    if (disposed || typeof value !== 'boolean') return false;
    initialize();
    const previousDirty = dirty;
    cancelTimer();
    const nextPreset = value ? preset : null;
    if (!save(documentValue(value,nextPreset))) { dirty = previousDirty; return false; }
    enabled = value; preset = nextPreset; dirty = false;
    return true;
  }

  function clear() {
    if (disposed) return false;
    initialize();
    const previousDirty = dirty;
    cancelTimer();
    if (!save(documentValue(false,null))) { dirty = previousDirty; return false; }
    enabled = false; preset = null; dirty = false;
    return true;
  }

  function read() {
    if (!disposed) initialize();
    return {enabled,preset};
  }

  function dispose() {
    if (disposed) return false;
    cancelTimer(); dirty = false; disposed = true; return true;
  }

  return {read,changed,flush,setEnabled,clear,dispose,get enabled() { return enabled; }};
}
