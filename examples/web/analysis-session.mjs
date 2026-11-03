// Application-owned example file: the portable SDK workspace remains metadata-only.
import {BarStore, FIELDS} from '../../src/core/data.mjs';
import {saveWorkspace, readWorkspaceDocument, workspaceBindingSame} from '../../src/core/workspace.mjs';
import {DEMO_SYMBOLS} from '../../src/core/markets.mjs';
import {assertJsonTextDepth} from '../../src/core/contracts.mjs';

export const MAX_ANALYSIS_BYTES = 32 * 1024 * 1024;
export const MAX_ANALYSIS_BARS = 250000;
const KEYS = ['schema', 'version', 'market', 'count', 'light', 'revision', 'columns', 'workspace'];
const COUNTS = new Set([10000, 100000, 1000000]);

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Analysis file fields');
  }
}
function metadata({market, count, light, revision}) {
  if (!Object.hasOwn(DEMO_SYMBOLS, market) || !COUNTS.has(count) || typeof light !== 'boolean' ||
      !Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Analysis file settings');
  return {key: 'barochart-demo:' + market, revision: String(revision), adjustmentVersion: 'raw-v1',
    priceUnit: DEMO_SYMBOLS[market].currency, adjustment: 'raw'};
}
function workspace(text, binding, market) {
  const doc = readWorkspaceDocument(text), symbol = DEMO_SYMBOLS[market];
  if (!workspaceBindingSame(doc.dataset, binding) || doc.chart.symbol?.id !== symbol.id ||
      doc.chart.symbol?.timezone !== symbol.timezone) throw new TypeError('Analysis market/dataset mismatch');
  return doc;
}
function boundedText(text) {
  if (typeof text !== 'string' || text.length > MAX_ANALYSIS_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_ANALYSIS_BYTES) {
    throw new RangeError('분석 파일은 32 MiB 이하여야 합니다.');
  }
  return text;
}

export function saveDemoAnalysis(api, {market, count, light}) {
  const model = api.model, store = model.store;
  if (store.length > MAX_ANALYSIS_BARS) throw new RangeError('분석 파일 저장은 250,000봉까지 지원합니다. 저장 봉 수를 줄여 다시 시도하세요.');
  const revision = store.version, binding = metadata({market, count, light, revision});
  const document = saveWorkspace(api, binding);
  workspace(document, binding, market);
  const columns = Object.fromEntries(FIELDS.map(key => [key, Array.from(store.columns[key].subarray(0, store.length), value => {
    if (!Number.isFinite(value)) throw new TypeError('Analysis finite OHLCV required');
    // Only column numbers use this token. Workspace keeps the SDK's own codec.
    return Object.is(value, -0) ? '-0' : value;
  })]));
  return boundedText(JSON.stringify({schema: 'barochart.demo-analysis', version: 1,
    market, count, light, revision, columns, workspace: document}));
}

export function readDemoAnalysis(text) {
  boundedText(text);
  assertJsonTextDepth(text, 4, 'Analysis file depth limit');
  const document = JSON.parse(text);
  record(document, KEYS);
  if (document.schema !== 'barochart.demo-analysis' || document.version !== 1) throw new TypeError('Analysis file schema/version');
  const binding = metadata(document), doc = workspace(document.workspace, binding, document.market);
  record(document.columns, FIELDS);
  const length = document.columns.time.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ANALYSIS_BARS) throw new RangeError('Analysis bar count limit');
  const columns = Object.fromEntries(FIELDS.map(key => {
    const values = document.columns[key];
    if (!Array.isArray(values) || values.length !== length) throw new TypeError('Analysis column lengths');
    return [key, values.map(value => {
      if (value === '-0') return -0;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Analysis numeric columns');
      return value;
    })];
  }));
  const store = new BarStore();
  store.setColumns(columns);
  if (doc.source.length !== length || doc.source.firstTime !== (length ? store.at(0).time : null) ||
      doc.source.lastTime !== (length ? store.at(length - 1).time : null)) throw new TypeError('Analysis source extent mismatch');
  return {market: document.market, count: document.count, light: document.light, store, workspace: document.workspace, binding};
}
