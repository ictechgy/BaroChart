// Small, host-owned controls for editing one indicator entry at a time.
// The core deliberately does not publish UI metadata, so this demo keeps an
// explicit description of the public builtin parameters here.  The editor
// never mutates a model directly: all mutations cross the callbacks supplied
// by the page root.

const PERIOD_MIN = 1;
const PERIOD_MAX = 10000;
const FINITE_MAX = Number.MAX_VALUE;
const TIMESTAMP_MAX = 8640000000000000;
const DEFAULT_HELP_STATUS = '지표별 기간과 표시 방법을 조정할 수 있습니다.';
const SOURCE_FIELDS = Object.freeze(['time', 'open', 'high', 'low', 'close', 'volume']);
const SOURCE_LABELS = Object.freeze({time: '시각', open: '시가', high: '고가', low: '저가', close: '종가', volume: '거래량'});
const VWAP_SOURCES = Object.freeze([
  Object.freeze({value: 'hlc3', label: '고가·저가·종가 평균'}),
  Object.freeze({value: 'close', label: '종가'}),
  Object.freeze({value: 'hl2', label: '고가·저가 평균'}),
  Object.freeze({value: 'ohlc4', label: 'OHLC 평균'})
]);

const number = (key, label, initial, {min = -FINITE_MAX, max = FINITE_MAX, step = 'any', integer = false, optional = false, readonly = false} = {}) => Object.freeze({
  key, label, type: 'number', initial, min, max, step, integer, optional, readonly
});
const select = (key, label, initial, options) => Object.freeze({
  key, label, type: 'select', initial, options: Object.freeze(options.map(option => Object.freeze(typeof option === 'string' ? {value: option, label: option} : {value: option.value, label: option.label})))
});
const text = (key, label, initial, {optional = false, maxLength = 256} = {}) => Object.freeze({key, label, type: 'text', initial, optional, maxLength});

const period = (key = 'period', label = '기간', initial = 20) => number(key, label, initial, {min: PERIOD_MIN, max: PERIOD_MAX, step: 1, integer: true});
const source = (initial = 'close') => select('source', '소스', initial, SOURCE_FIELDS.map(value => ({value, label: SOURCE_LABELS[value]})));

// Keep this table intentionally hand-authored.  It mirrors the defaults and
// validation branches in src/core/indicators.mjs and session-studies.mjs;
// it is not inferred from private factory closures at runtime.
const descriptorTable = {
  sma: {fields: [period(), source()]},
  vwma: {fields: [period()]},
  ema: {fields: [period(), source()]},
  wma: {fields: [period()]},
  rsi: {fields: [period('period', '기간', 14)]},
  atr: {fields: [period('period', '기간', 14)]},
  macd: {fields: [period('fast', '빠른 기간', 12), period('slow', '느린 기간', 26), period('signal', '신호 기간', 9)]},
  bollinger: {fields: [period(), number('deviation', '표준편차 배수', 2, {min: 0, step: 'any'})]},
  donchian: {fields: [period()]},
  aroon: {fields: [period('period', '기간', 25)]},
  stochastic: {fields: [period('period', '기간', 14), period('smoothK', 'K 평활', 3), period('smoothD', 'D 평활', 3)]},
  roc: {fields: [period('period', '기간', 12)]},
  williamsR: {fields: [period('period', '기간', 14)]},
  cci: {fields: [period()]},
  obv: {fields: []},
  vwap: {
    fields: [
      number('sessionMs', '세션 길이(ms)', 86400000, {min: Number.MIN_VALUE, step: 1}),
      select('source', '평균 가격 소스', 'hlc3', VWAP_SOURCES),
      number('deviation', '밴드 배수', undefined, {min: 0, step: 'any', optional: true}),
      number('anchorTime', '기준 시각(ms)', undefined, {min: -TIMESTAMP_MAX, max: TIMESTAMP_MAX, step: 1, integer: true, optional: true}),
      text('kinds', '세션 종류', undefined, {optional: true, maxLength: 2048})
    ]
  },
  mfi: {fields: [period('period', '기간', 14)]},
  cmf: {fields: [period()]},
  adx: {fields: [period('period', '기간', 14)]},
  dema: {fields: [period()]},
  tema: {fields: [period()]},
  hma: {fields: [period()]},
  keltner: {fields: [period(), period('atrPeriod', 'ATR 기간', 10), number('multiplier', '배수', 2, {min: 0, step: 'any'})]},
  supertrend: {fields: [period('period', '기간', 10), number('multiplier', '배수', 3, {min: Number.MIN_VALUE, step: 'any'})]},
  ichimoku: {
    fields: [
      period('conversion', '전환 기간', 9),
      period('base', '기준 기간', 26),
      period('span', '선행 기간', 52),
      number('displacement', '표시 오프셋(고정)', 26, {min: 0, max: 10000, step: 1, integer: true, readonly: true})
    ]
  },
  trix: {fields: [period('period', '기간', 15)]},
  ppo: {fields: [period('fast', '빠른 기간', 12), period('slow', '느린 기간', 26), period('signal', '신호 기간', 9)]},
  stochRSI: {fields: [period('period', '기간', 14), period('stochPeriod', '스토캐스틱 기간', 14), period('smoothK', 'K 평활', 3), period('smoothD', 'D 평활', 3)]},
  adl: {fields: []},
  chaikin: {fields: [period('fast', '빠른 기간', 3), period('slow', '느린 기간', 10)]},
  forceIndex: {fields: [period('period', '기간', 13)]},
  volumeOscillator: {fields: [period('fast', '빠른 기간', 14), period('slow', '느린 기간', 28)]},
  vortex: {fields: [period('period', '기간', 14)]},
  pivots: {
    fields: [
      number('sessionMs', '세션 길이(ms)', 86400000, {min: Number.MIN_VALUE, step: 1}),
      text('kinds', '세션 종류', undefined, {optional: true, maxLength: 2048})
    ]
  },
  parabolicSAR: {
    fields: [
      number('step', '가속 시작값', .02, {min: Number.MIN_VALUE, max: 1, step: 'any'}),
      number('max', '가속 상한값', .2, {min: Number.MIN_VALUE, max: 1, step: 'any'})
    ]
  }
};

for (const descriptor of Object.values(descriptorTable)) {
  descriptor.fields = Object.freeze(descriptor.fields);
  descriptor.defaults = Object.freeze(Object.fromEntries(descriptor.fields.filter(field => field.initial !== undefined && !field.optional).map(field => [field.key, field.initial])));
  Object.freeze(descriptor);
}

// A frozen copy is useful to demo consumers and keeps accidental control
// mutation from changing metadata for another editor instance.
export const INDICATOR_DESCRIPTORS = Object.freeze(descriptorTable);

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function entryOutputs(entry) {
  if (Array.isArray(entry?.def?.outputs)) return [...entry.def.outputs];
  if (entry?.def?.outputs && typeof entry.def.outputs === 'object') return Object.keys(entry.def.outputs);
  if (Array.isArray(entry?.outputs)) return [...entry.outputs];
  return [];
}

function entryFields(name, entry) {
  const descriptor = descriptorTable[name];
  if (!descriptor) return [];
  const params = entry?.params ?? {};
  const outputs = entryOutputs(entry);
  return descriptor.fields.filter(field => {
    if (name === 'vwap') {
      if (field.key === 'sessionMs') return !hasOwn(params, 'calendar') && !hasOwn(params, 'anchorTime');
      if (field.key === 'deviation') return hasOwn(params, 'deviation') || outputs.some(output => ['upper', 'lower', 'deviation', 'volume'].includes(output));
      if (field.key === 'anchorTime') return hasOwn(params, 'anchorTime');
      if (field.key === 'kinds') return hasOwn(params, 'kinds');
    }
    if (name === 'pivots') {
      if (field.key === 'sessionMs') return !hasOwn(params, 'calendar');
      if (field.key === 'kinds') return hasOwn(params, 'kinds');
    }
    return true;
  });
}

function fieldDefault(field, entry) {
  const params = entry?.params ?? {};
  if (hasOwn(params, field.key) && params[field.key] !== undefined) return params[field.key];
  if (field.key === 'deviation' && entryOutputs(entry).some(output => ['upper', 'lower', 'deviation', 'volume'].includes(output))) return 2;
  return field.initial;
}

function cloneParams(entry, fields) {
  const result = {...(entry?.params ?? {})};
  for (const field of fields) {
    const value = fieldDefault(field, entry);
    if (value !== undefined && !hasOwn(result, field.key)) result[field.key] = value;
  }
  return result;
}

function inputColor(value) {
  if (typeof value !== 'string') return '#7898ff';
  const source = value.trim().toLowerCase();
  const names = {black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', transparent: '#000000'};
  const named = names[source] ?? source;
  if (/^#[\da-f]{3,4}$/.test(named)) return '#'+[...named.slice(1, 4)].map(char => char+char).join('');
  if (/^#[\da-f]{6,8}$/.test(named)) return named.slice(0, 7);
  const rgb = named.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(',').slice(0, 3).map(part => Number(part.trim().replace('%', '')) * (part.trim().endsWith('%') ? 2.55 : 1));
    if (parts.length === 3 && parts.every(part => Number.isFinite(part) && part >= 0 && part <= 255)) return '#'+parts.map(part => Math.round(part).toString(16).padStart(2, '0')).join('');
  }
  return '#7898ff';
}

function errorMessage(error) {
  if (error?.name === 'AbortError') return '계산을 취소했습니다.';
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '알 수 없는 오류');
  return `변경을 적용하지 못했습니다: ${message.slice(0, 180)}`;
}

function validationMessage(field, reason) {
  const label = field?.label ?? '값';
  if (reason === 'required') return `${label}을(를) 입력하세요.`;
  if (reason === 'integer') return `${label}은(는) 정수여야 합니다.`;
  if (reason === 'finite') return `${label}은(는) 유한한 숫자여야 합니다.`;
  if (reason === 'min') return `${label}은(는) ${field.min} 이상이어야 합니다.`;
  if (reason === 'max') return `${label}은(는) ${field.max} 이하여야 합니다.`;
  return `${label} 값을 확인하세요.`;
}

function readField(field, node) {
  if (field.type === 'select' || field.type === 'text') {
    const value = String(node.value ?? '');
    if (!value && field.optional) return undefined;
    if (!value) throw new Error(validationMessage(field, 'required'));
    return value;
  }
  const raw = String(node.value ?? '').trim();
  if (!raw && field.optional) return undefined;
  if (!raw) throw new Error(validationMessage(field, 'required'));
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(validationMessage(field, 'finite'));
  if (field.integer && !Number.isSafeInteger(value)) throw new Error(validationMessage(field, 'integer'));
  if (value < field.min) throw new Error(validationMessage(field, 'min'));
  if (value > field.max) throw new Error(validationMessage(field, 'max'));
  return value;
}

function validateCrossFields(name, params) {
  const lessThan = (a, b, label) => {
    if (Number.isFinite(params[a]) && Number.isFinite(params[b]) && params[a] >= params[b]) throw new Error(`${label}은(는) 느린 기간보다 작아야 합니다.`);
  };
  if (['macd', 'ppo'].includes(name)) lessThan('fast', 'slow', '빠른 기간');
  if (['chaikin', 'volumeOscillator'].includes(name)) lessThan('fast', 'slow', '빠른 기간');
  if (name === 'parabolicSAR' && (params.max < params.step || params.max > 1)) throw new Error('가속 상한값은 시작값 이상이고 1 이하여야 합니다.');
  for (const key of ['vwap', 'pivots']) if (name === key && params.kinds !== undefined) {
    const kinds = params.kinds;
    if (!hasOwn(params, 'calendar') || !kinds || kinds.length > 2048 || kinds.split(',').length > 16 || kinds.split(',').some(kind => !kind || kind.trim() !== kind) || new Set(kinds.split(',')).size !== kinds.split(',').length) throw new Error('세션 종류는 달력이 있을 때 고유한 쉼표 구분 값이어야 합니다.');
  }
  if (name === 'vwap' && hasOwn(params, 'sessionMs') && (hasOwn(params, 'calendar') || hasOwn(params, 'anchorTime'))) throw new Error('세션 길이는 달력 또는 기준 시각과 함께 사용할 수 없습니다.');
}

function entriesOf(model) {
  const map = model?.indicators?.entries;
  if (map instanceof Map) return [...map.entries()].map(([id, entry]) => ({id, entry}));
  if (map && typeof map.entries === 'function') return [...map.entries()].map(([id, entry]) => ({id, entry}));
  return [];
}

function seriesFor(model, id) {
  return (model?.series ?? []).filter(series => series?.indicator === id);
}

function busyValue(isBusy) {
  try { return typeof isBusy === 'function' ? !!isBusy() : !!isBusy; } catch { return false; }
}

export function createIndicatorEditor({root, getChart, isBusy = false, onApplyParams, onApplyStyle, onRemove, onStatus} = {}) {
  if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('Indicator editor root required');
  if (typeof getChart !== 'function') throw new TypeError('Indicator editor chart getter required');
  if (onApplyParams !== undefined && typeof onApplyParams !== 'function') throw new TypeError('Indicator parameter callback required');
  if (onApplyStyle !== undefined && typeof onApplyStyle !== 'function') throw new TypeError('Indicator style callback required');
  if (onRemove !== undefined && typeof onRemove !== 'function') throw new TypeError('Indicator removal callback required');
  if (onStatus !== undefined && typeof onStatus !== 'function') throw new TypeError('Indicator status callback required');

  const document = root.ownerDocument ?? globalThis.document;
  if (!document?.createElement) throw new TypeError('Indicator editor document required');
  let disposed = false;
  let selectedId = null;
  let selectedSeriesId = null;
  let modelRef = null;
  let entriesRef = null;
  let selectedEntry = null;
  let selectedSeries = null;
  let seriesRowsRef = [];
  let paramsRef = null;
  let paramFields = [];
  let paramDraft = null;
  let styleDraft = null;
  let paramsDirty = false;
  let styleDirty = false;
  let colorTouched = false;
  let pending = false;
  let generation = 0;
  let nodes = {};
  let entryRows = [];
  let indicatorOptionsSignature = null;
  let emptyStateNotice = false;

  const status = (message, {empty = false} = {}) => { emptyStateNotice = empty; if (!disposed && typeof onStatus === 'function') onStatus(String(message)); };
  const make = tag => document.createElement(tag);
  const labelFor = (label, id) => { const node = make('label');node.textContent = label;node.setAttribute('for', id);return node; };
  const button = (id, label, handler) => { const node = make('button');node.type = 'button';node.setAttribute('type', 'button');node.id = id;node.textContent = label;node.onclick = handler;return node; };

  function modelForChart(chart) { return chart?.model ?? (chart?.indicators ? chart : null); }
  function currentChart() { return getChart(); }
  function currentEntry() { return entryRows.find(row => row.id === selectedId)?.entry ?? null; }
  function currentSeries() {
    const rows = seriesFor(modelRef, selectedId);
    if (!rows.length) return null;
    const actual = rows.find(row => row.id === selectedSeriesId) ?? rows[0];
    selectedSeriesId = actual.id;
    return actual;
  }

  function setDisabled(node, value) { if (node) node.disabled = !!value; }
  function controlsDisabled() { return disposed || pending || busyValue(isBusy) || !modelRef || !selectedEntry; }
  function insideEditor(node) { return !!node && (node === root || !!root.contains?.(node)); }
  function bodyFocus(node) { return !!node && (node === document.body || node === document.documentElement || String(node.tagName ?? '').toUpperCase() === 'BODY'); }
  function findNodeById(node, id) {
    if (!node || !id) return null;
    if (node.id === id) return node;
    for (const child of node.children ?? []) { const found = findNodeById(child, id);if (found) return found; }
    return null;
  }
  function captureFocus() {
    const node = document.activeElement;
    return insideEditor(node) && node.id ? {node, id: node.id} : null;
  }
  function focusPlan(original, fallbackId, preferFallback = false) {
    if (!original) return null;
    const active = document.activeElement;
    if (insideEditor(active) && active !== original.node) return active.id ? {id: active.id} : null;
    if (active && !insideEditor(active) && !bodyFocus(active) && active.isConnected !== false) return null;
    return {id: preferFallback ? fallbackId : original.id || fallbackId};
  }
  function ownerStillCurrent(action, allowSelectionChange = false) {
    if (!action?.chart || modelRef !== action.model) return false;
    let chart;
    try { chart = currentChart(); } catch { return false; }
    const sameChartOwner = chart === action.chart || modelForChart(chart) === action.model && (!action.chart.api || chart?.api === action.chart.api);
    return sameChartOwner && modelForChart(chart) === action.model && (allowSelectionChange || selectedId === action.id);
  }
  function restoreFocus(plan) {
    if (!plan) return;
    const node = findNodeById(root, plan.id);
    if (node && !node.disabled && typeof node.focus === 'function') node.focus();
  }

  function renderEntrySelector() {
    if (!nodes.indicator) return;
    const signature = entryRows.map(row => `${row.id}\u0000${row.entry?.name ?? row.id}`).join('\u0001');
    if (signature !== indicatorOptionsSignature) {
      nodes.indicator.replaceChildren();
      for (const row of entryRows) {
        const option = make('option');option.value = row.id;option.textContent = `${String(row.entry?.name ?? row.id).toUpperCase()} · ${row.id}`;nodes.indicator.append(option);
      }
      indicatorOptionsSignature = signature;
    }
    if (entryRows.length) {
      if (!entryRows.some(row => row.id === selectedId)) selectedId = entryRows[0].id;
      nodes.indicator.value = selectedId;
    } else {
      selectedId = null;selectedSeriesId = null;nodes.indicator.value = '';
    }
    setDisabled(nodes.indicator, disposed || pending || busyValue(isBusy) || !entryRows.length);
  }

  function appendField(container, field, value, {readonly = false} = {}) {
    const id = `editor-param-${field.key}`;
    const wrapper = make('div');
    const label = labelFor(field.label, id);
    const input = field.type === 'select' ? make('select') : make('input');
    input.id = id;
    if (field.type === 'select') {
      const options = field.options.slice();
      if (value !== undefined && !options.some(option => option.value === value)) options.push({value, label: `현재값 · ${value}`});
      for (const choice of options) { const option = make('option');option.value = choice.value;option.textContent = choice.label;input.append(option); }
      input.value = value ?? field.initial ?? '';
    } else {
      input.type = field.type;
      if (value !== undefined) input.value = String(value);
      if (field.type === 'number') {
        input.min = String(field.min);input.max = String(field.max);input.step = String(field.step);
        input.setAttribute('min', String(field.min));input.setAttribute('max', String(field.max));input.setAttribute('step', String(field.step));
      }
      if (field.type === 'text' && field.maxLength !== undefined) { input.maxLength = field.maxLength;input.setAttribute('maxlength', String(field.maxLength)); }
      if (readonly || field.readonly) { input.readOnly = true;input.setAttribute('aria-readonly', 'true');input.title = '출력 오프셋 변경은 지표를 다시 구성해야 합니다.'; }
    }
    if (!readonly && !field.readonly) {
      const markDirty = () => { paramsDirty = true; };
      input.oninput = markDirty;input.onchange = markDirty;
    }
    label.append(input);wrapper.append(label);container.append(wrapper);nodes.params[field.key] = input;
  }

  function renderParams(entry) {
    nodes.paramsBody.replaceChildren();nodes.params = {};
    paramFields = entryFields(entry?.name, entry);
    if (!paramFields.length) {
      const note = make('p');note.textContent = descriptorTable[entry?.name] ? '이 지표는 조정할 매개변수가 없습니다.' : '등록된 설명이 없어 기존 매개변수를 유지합니다.';nodes.paramsBody.append(note);
      paramDraft = null;paramsDirty = false;return;
    }
    paramDraft = cloneParams(entry, paramFields);paramsDirty = false;
    for (const field of paramFields) appendField(nodes.paramsBody, field, fieldDefault(field, entry));
    const actions = make('div');actions.append(button('editor-apply-params', '매개변수 적용', applyParams), button('editor-reset-params', '기본값으로 초기화', resetParams));nodes.paramsBody.append(actions);
    nodes.applyParams = actions.children[0];nodes.resetParams = actions.children[1];
  }

  function updateParamValuesFromDraft() {
    if (!paramDraft) return;
    for (const field of paramFields) {
      const value = hasOwn(paramDraft, field.key) ? paramDraft[field.key] : '';
      if (nodes.params[field.key] && !paramsDirty) nodes.params[field.key].value = value === undefined ? '' : String(value);
    }
  }

  function readParams() {
    const next = {...(selectedEntry?.params ?? {})};
    for (const field of paramFields) {
      if (field.readonly) continue;
      const value = readField(field, nodes.params[field.key]);
      if (value === undefined) delete next[field.key];
      else next[field.key] = value;
    }
    validateCrossFields(selectedEntry?.name, next);
    return next;
  }

  function renderStyleValues(series) {
    if (!nodes.output) return;
    const rows = seriesFor(modelRef, selectedId);
    nodes.output.replaceChildren();
    for (const row of rows) {
      const option = make('option');
      option.value = String(row.id);
      option.textContent = `${row.output ?? entryOutputs(selectedEntry)[0] ?? 'value'} · ${row.id}`;
      nodes.output.append(option);
    }
    if (rows.length) {
      if (!rows.some(row => row.id === selectedSeriesId)) selectedSeriesId = rows[0].id;
      nodes.output.value = String(selectedSeriesId);
    } else { selectedSeriesId = null;nodes.output.value = ''; }
    const actual = rows.find(row => row.id === selectedSeriesId) ?? null;
    selectedSeries = actual;
    seriesRowsRef = rows;
    const color = actual?.color;
    styleDraft = {color, width: actual?.width ?? 1.5, visible: actual?.visible !== false};styleDirty = false;colorTouched = false;
    if (nodes.color) nodes.color.value = inputColor(color);
    if (nodes.width) nodes.width.value = String(styleDraft.width);
    if (nodes.visible) nodes.visible.checked = styleDraft.visible;
  }

  function renderStyle(entry) {
    const rows = seriesFor(modelRef, selectedId);
    nodes.styleBody.replaceChildren();
    const outputLabel = labelFor('출력', 'editor-output');const outputNode = make('select');nodes.output = outputNode;outputNode.id = 'editor-output';outputNode.onchange = () => { selectedSeriesId = outputNode.value;renderStyleValues();updateDisabled(); };
    outputLabel.append(nodes.output);nodes.styleBody.append(outputLabel);
    const colorLabel = labelFor('색상', 'editor-color');nodes.color = make('input');nodes.color.type = 'color';nodes.color.id = 'editor-color';nodes.color.oninput = () => { colorTouched = true;styleDirty = true; };colorLabel.append(nodes.color);nodes.styleBody.append(colorLabel);
    const widthLabel = labelFor('선 너비', 'editor-width');nodes.width = make('input');nodes.width.type = 'number';nodes.width.id = 'editor-width';nodes.width.min = '0.1';nodes.width.max = '50';nodes.width.step = 'any';nodes.width.oninput = () => { styleDirty = true; };widthLabel.append(nodes.width);nodes.styleBody.append(widthLabel);
    const visibleLabel = labelFor('표시', 'editor-visible');nodes.visible = make('input');nodes.visible.type = 'checkbox';nodes.visible.id = 'editor-visible';nodes.visible.onchange = () => { styleDirty = true; };visibleLabel.append(nodes.visible);nodes.styleBody.append(visibleLabel);
    const actions = make('div');actions.append(button('editor-apply-style', '스타일 적용', applyStyle));nodes.styleBody.append(actions);nodes.applyStyle = actions.children[0];
    renderStyleValues(rows[0]);
  }

  function renderPanels(entry, {rebuildParams = true, rebuildStyle = true} = {}) {
    selectedEntry = entry;
    if (rebuildParams) renderParams(entry);
    if (rebuildStyle) renderStyle(entry);
    updateDisabled();
  }

  function renderAll() {
    root.replaceChildren();nodes = {};indicatorOptionsSignature = null;
    const selectorLabel = labelFor('지표', 'editor-indicator');nodes.indicator = make('select');nodes.indicator.id = 'editor-indicator';nodes.indicator.setAttribute('aria-label', '편집할 지표');nodes.indicator.onchange = () => select(nodes.indicator.value);selectorLabel.append(nodes.indicator);root.append(selectorLabel);
    const params = make('fieldset');const legend = make('legend');legend.textContent = '매개변수';params.append(legend);nodes.paramsBody = make('div');params.append(nodes.paramsBody);root.append(params);
    const style = make('fieldset');const styleLegend = make('legend');styleLegend.textContent = '출력 스타일';style.append(styleLegend);nodes.styleBody = make('div');style.append(nodes.styleBody);root.append(style);
    const remove = make('div');nodes.remove = button('editor-remove', '이 지표와 모든 출력 제거', removeIndicator);remove.append(nodes.remove);root.append(remove);
    renderEntrySelector();renderPanels(currentEntry());
  }

  function updateDisabled() {
    const noSelection = !modelRef || !selectedEntry;
    const blocked = controlsDisabled();
    const busy = busyValue(isBusy);
    setDisabled(nodes.indicator, disposed || pending || busy || !entryRows.length);
    if (nodes.params) for (const input of Object.values(nodes.params)) setDisabled(input, blocked || input.readOnly === true);
    setDisabled(nodes.applyParams, blocked || !paramFields.length);
    setDisabled(nodes.resetParams, blocked || !paramFields.length);
    setDisabled(nodes.output, blocked || !selectedSeries && !seriesFor(modelRef, selectedId).length);
    setDisabled(nodes.color, blocked || !selectedSeries);
    setDisabled(nodes.width, blocked || !selectedSeries);
    setDisabled(nodes.visible, blocked || !selectedSeries);
    setDisabled(nodes.applyStyle, blocked || !selectedSeries);
    setDisabled(nodes.remove, disposed || pending || busy || noSelection);
  }

  function ownerChanged(model, entries) { return modelRef !== model || entriesRef !== entries; }

  function sync() {
    if (disposed) return;
    let chart;
    try { chart = currentChart(); } catch (error) { status(errorMessage(error));return; }
    const model = modelForChart(chart), entries = model?.indicators?.entries;
    if (!model || !entries) {
      modelRef = null;entriesRef = null;entryRows = [];seriesRowsRef = [];indicatorOptionsSignature = null;selectedId = null;selectedSeriesId = null;selectedEntry = null;selectedSeries = null;root.replaceChildren();nodes = {};status('표시할 지표가 없습니다.', {empty: true});return;
    }
    const rows = entriesOf(model);
    const listChanged = ownerChanged(model, entries) || rows.length !== entryRows.length || rows.some((row, index) => row.id !== entryRows[index]?.id || row.entry !== entryRows[index]?.entry);
    modelRef = model;entriesRef = entries;entryRows = rows;
    if (listChanged || !nodes.indicator) {
      if (!selectedId || !rows.some(row => row.id === selectedId)) selectedId = rows[0]?.id ?? null;
      renderAll();
      if (!rows.length) status('표시할 지표가 없습니다.', {empty: true});
      else if (emptyStateNotice) status(DEFAULT_HELP_STATUS);
      return;
    }
    renderEntrySelector();
    const entry = currentEntry();
    const entryWasReplaced = entry !== selectedEntry;
    const rowsChanged = (() => {
      const rows = seriesFor(modelRef, selectedId);
      return rows.length !== seriesRowsRef.length || rows.some((row, index) => row !== seriesRowsRef[index]);
    })();
    const series = currentSeries();
    const seriesWasReplaced = series !== selectedSeries;
    if (entryWasReplaced) { selectedSeriesId = null;renderPanels(entry); }
    else if (seriesWasReplaced || rowsChanged) renderStyle(entry);
    else {
      if (paramsRef !== entry?.params && !paramsDirty) { paramDraft = cloneParams(entry, paramFields);paramsRef = entry?.params;updateParamValuesFromDraft(); }
      updateDisabled();
    }
    paramsRef = entry?.params ?? null;
    selectedEntry = entry;
    selectedSeries = currentSeries();
    updateDisabled();
  }

  function select(id) {
    if (disposed || pending || busyValue(isBusy)) return null;
    const next = entryRows.find(row => row.id === id);
    if (!next) return null;
    if (selectedId !== id) { selectedId = id;selectedSeriesId = null;paramDraft = null;styleDraft = null;paramsDirty = false;styleDirty = false;colorTouched = false;renderPanels(next.entry); }
    if (nodes.indicator) nodes.indicator.value = id;
    updateDisabled();
    return id;
  }

  async function applyParams() {
    if (controlsDisabled() || !paramFields.length || typeof onApplyParams !== 'function') return;
    let params;
    try { params = readParams(); }
    catch (error) { status(errorMessage(error));return; }
    let actionChart;
    try { actionChart = currentChart(); } catch { actionChart = null; }
    const mine = ++generation,id = selectedId,entry = selectedEntry,model = modelRef,action = {chart: actionChart, model, id, focus: captureFocus()};
    pending = true;updateDisabled();
    try {
      const result = await onApplyParams(id, params);
      if (!disposed && mine === generation && modelRef === model && selectedId === id && selectedEntry === entry) { paramDraft = null;paramsDirty = false;status('지표 매개변수를 적용했습니다.'); }
      return result;
    } catch (error) { if (!disposed && mine === generation) status(errorMessage(error)); }
    finally {
      if (mine === generation) {
        const plan = focusPlan(action.focus, 'editor-apply-params');
        pending = false;sync();
        if (ownerStillCurrent(action)) restoreFocus(plan);
      }
    }
  }

  function resetParams() {
    if (controlsDisabled() || !paramFields.length || !selectedEntry) return;
    paramDraft = cloneParams({...selectedEntry, params: {...(selectedEntry.params ?? {})}}, paramFields);
    for (const field of paramFields) {
      if (field.optional && field.key !== 'deviation') delete paramDraft[field.key];
      else if (field.key === 'deviation') paramDraft[field.key] = 2;
      else if (field.initial !== undefined) paramDraft[field.key] = field.initial;
    }
    paramsDirty = true;
    for (const field of paramFields) if (nodes.params[field.key]) nodes.params[field.key].value = hasOwn(paramDraft, field.key) ? String(paramDraft[field.key]) : '';
    status('매개변수 초안을 기본값으로 되돌렸습니다. 적용 버튼을 눌러 반영하세요.');
  }

  async function applyStyle() {
    if (controlsDisabled() || !selectedSeries || typeof onApplyStyle !== 'function') return;
    const width = Number(String(nodes.width?.value ?? '').trim());
    if (!Number.isFinite(width) || width <= 0 || width > 50) { status('선 너비는 0보다 크고 50 이하여야 합니다.');return; }
    const patch = {width, visible: !!nodes.visible?.checked};
    // Preserve the exact original value when the RGB input was not touched.
    // This keeps alpha channels and valid custom CSS strings intact.
    if (!colorTouched && nodes.color.value !== inputColor(selectedSeries.color)) colorTouched = true;
    if (colorTouched) patch.color = nodes.color.value;
    let actionChart;
    try { actionChart = currentChart(); } catch { actionChart = null; }
    const mine = ++generation,id = selectedSeries.id,series = selectedSeries,model = modelRef,action = {chart: actionChart, model, id: selectedId, focus: captureFocus()};
    pending = true;updateDisabled();
    try {
      const result = await onApplyStyle(id, patch);
      if (!disposed && mine === generation && modelRef === model && selectedSeries === series) { styleDirty = false;colorTouched = false;status('출력 스타일을 적용했습니다.'); }
      return result;
    } catch (error) { if (!disposed && mine === generation) status(errorMessage(error)); }
    finally {
      if (mine === generation) {
        const plan = focusPlan(action.focus, 'editor-apply-style');
        pending = false;sync();
        if (ownerStillCurrent(action)) restoreFocus(plan);
      }
    }
  }

  async function removeIndicator() {
    if (disposed || pending || busyValue(isBusy) || !selectedEntry || typeof onRemove !== 'function') return;
    let actionChart;
    try { actionChart = currentChart(); } catch { actionChart = null; }
    const mine = ++generation,id = selectedId,model = modelRef,entry = selectedEntry,action = {chart: actionChart, model, id, focus: captureFocus()};
    pending = true;updateDisabled();
    try {
      const result = await onRemove(id);
      if (!disposed && mine === generation && modelRef === model && selectedId === id && selectedEntry === entry) status('지표와 모든 출력을 제거했습니다.');
      return result;
    } catch (error) { if (!disposed && mine === generation) status(errorMessage(error)); }
    finally {
      if (mine === generation) {
        const plan = focusPlan(action.focus, 'editor-indicator', true);
        pending = false;sync();
        if (ownerStillCurrent(action, true)) restoreFocus(plan);
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;generation++;pending = false;emptyStateNotice = false;root.replaceChildren();nodes = {};modelRef = null;entriesRef = null;selectedSeriesId = null;selectedEntry = null;selectedSeries = null;entryRows = [];seriesRowsRef = [];indicatorOptionsSignature = null;
  }

  const editor = {sync, select, dispose};
  sync();
  return editor;
}
