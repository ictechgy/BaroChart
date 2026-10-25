import {resolveCrosshairSnapshot} from '../../src/core/crosshair-snap.mjs';

// The readout deliberately owns a small, keyed DOM tree.  Hovering a chart is
// a high-frequency operation, so a pointer event only causes the chart's
// existing render/exploration notifications to be observed here; it never
// installs another pointer listener or asks the renderer for a new frame.
const MAX_TIME_FORMATTERS = 16;
const timeFormatters = new Map();
const statusLabels = Object.freeze({
  pending: '계산 대기',
  'non-finite': '값 없음',
  'outside-source': '원본 범위 밖',
  'after-cutoff': '기준 시점 이후',
  'unsupported-causality': '과거 계산 불가',
  'unsupported-cache': '자동 조회 미지원',
});
const barFields = Object.freeze([
  ['open', '시가'],
  ['high', '고가'],
  ['low', '저가'],
  ['close', '종가'],
  ['volume', '거래량'],
]);

function add(node, ...children) {
  node.append(...children);
  return node;
}
function element(document, tag, className, text = '') {
  const node = document.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== '') node.textContent = text;
  return node;
}

function clearRoot(root) {
  if (typeof root.replaceChildren === 'function') {
    root.replaceChildren();
    return;
  }
  while (root.firstChild) root.firstChild.remove();
}

function rawNumber(value) {
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

function trimExponent(value) {
  return value
    .replace(/(\.\d*?[1-9])0+(?=e|$)/u, '$1')
    .replace(/\.0+(?=e|$)/u, '')
    .replace(/e([+-])0+(\d+)/u, 'e$1$2');
}

function readableNumber(value, precision) {
  if (!Number.isFinite(value)) return '—';
  if (Object.is(value, -0)) return '-0';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-6 || magnitude >= 1e12)) return trimExponent(value.toExponential(6));
  if (Number.isInteger(precision) && precision >= 0 && precision <= 12) {
    if (magnitude !== 0 && magnitude < 10 ** -precision) return trimExponent(value.toExponential(6));
    return value.toFixed(precision);
  }
  const text = value.toPrecision(10);
  return text.includes('e') ? trimExponent(text) : text.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function timezoneFor(model) {
  const timezone = model?.symbol?.timezone;
  return typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 128 ? timezone : 'UTC';
}

function formatterFor(timezone) {
  const requested = typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 128 ? timezone : 'UTC';
  const cached = timeFormatters.get(requested);
  if (cached) return cached;
  let zone = requested;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    zone = 'UTC';
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  }
  const value = {formatter, zone};
  if (timeFormatters.size >= MAX_TIME_FORMATTERS) timeFormatters.delete(timeFormatters.keys().next().value);
  timeFormatters.set(requested, value);
  return value;
}

function formattedTime(time, model) {
  if (!Number.isFinite(time)) return '—';
  const cached = formatterFor(timezoneFor(model));
  try {
    const parts = Object.fromEntries(cached.formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${cached.zone}`;
  } catch {
    try { return `${new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, '')} UTC`; } catch { return '—'; }
  }
}

function statusTitle(row) {
  const status = row?.status;
  if (status === 'value' && Number.isFinite(row.value)) return `원본 값 ${rawNumber(row.value)}`;
  if (statusLabels[status]) return statusLabels[status];
  return row?.value == null ? '값 없음' : String(status ?? '값 없음');
}

function rowValue(row, model) {
  if (!row || row.status === 'pending') return row?.status === 'pending' ? '계산 대기' : '—';
  if (row.status === 'unsupported-cache') return statusLabels['unsupported-cache'];
  const precision = row.kind === 'source' && row.source === 'volume' ? undefined : Math.max(2, model.precision ?? 2);
  return Number.isFinite(row.value) ? readableNumber(row.value, precision) : '—';
}

function isVisiblePlotSeries(series) {
  return series?.visible !== false && ['line', 'area', 'histogram'].includes(series.type);
}

function sizeOf(chart, binding) {
  try {
    if (typeof chart.size === 'function') return chart.size();
  } catch {
    return null;
  }
  const width = Number(chart.container?.clientWidth);
  const height = Number(chart.container?.clientHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {width: Math.max(100, width), height: Math.max(80, height)};
}

function validPreparedLayout(chart, model, canvas) {
  const binding = chart?.timeLayout;
  if (!binding || chart.fullDirty || binding.canvas !== canvas || binding.store !== model.store || binding.version !== model.store.version) return null;
  if (!Object.is(binding.from, model.view.from) || !Object.is(binding.to, model.view.to)) return null;
  const size = sizeOf(chart, binding);
  if (!size || binding.width !== size.width || binding.height !== size.height) return null;
  if (binding.axisWidth !== model.axisWidth || binding.font !== model.theme.font) return null;
  if (!Array.isArray(binding.panels) || binding.panels.length !== model.panels.length || binding.panels.some((panel, index) => panel !== model.panels[index])) return null;
  if (!Array.isArray(binding.axes) || binding.axes.length !== model.axes.length || binding.axes.some((axis, index) => axis !== model.axes[index])) return null;
  const layout = binding.layout;
  return layout && typeof layout.index === 'function' && Array.isArray(layout.panels) ? layout : null;
}

function pointerIndex(chart, model, canvas) {
  const cursor = model.crosshair;
  if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return null;
  const layout = validPreparedLayout(chart, model, canvas);
  if (!layout) return null;
  const panel = layout.panels.find(candidate => cursor.x >= candidate.left && cursor.x <= candidate.right && cursor.y >= candidate.top && cursor.y <= candidate.bottom);
  if (!panel) return null;
  const snapshot = resolveCrosshairSnapshot(model, layout);
  if (!snapshot) return null;
  let index = snapshot.snapped ? snapshot.index : Math.round(layout.index(cursor.x));
  if (!Number.isSafeInteger(index) || index < 0 || index >= model.store.length) return null;
  if (snapshot.snapped && snapshot.storeVersion !== model.store.version) return null;
  return index;
}

function explorationState(chart) {
  try {
    const state = chart.dataExploration;
    if (!state || state.active !== true) return {active: false, time: null};
    return {active: true, time: Number.isSafeInteger(state.time) ? state.time : null};
  } catch {
    return {active: false, time: null};
  }
}

function normalizedLabel(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function seriesLabel(series, row, counts, baseMeta) {
  const base = String(row?.label ?? series?.label ?? series?.id ?? 'Series');
  const indicator = row?.indicator ?? series?.indicator ?? null;
  const output = row?.output ?? series?.output ?? null;
  const parts = [];
  const baseKey = normalizedLabel(base), indicatorKey = normalizedLabel(indicator), outputKey = normalizedLabel(output);
  const meta = baseMeta.get(baseKey), indicatorIds = meta?.indicators;
  const explicitLabel = series?.label !== undefined && series?.label !== null;
  const needIndicator = indicator && (meta?.rows.length ?? 0) > 1 && (indicatorIds?.size ?? 0) > 1 && !baseKey.includes(indicatorKey);
  if (needIndicator) parts.push(String(indicator));
  const sameIndicatorOutputs = indicator && meta?.rows.filter(item => item.indicator === String(indicator)).map(item => item.output).filter(Boolean);
  const multipleOutputs = new Set(sameIndicatorOutputs ?? []).size > 1;
  const needOutput = output && !baseKey.includes(outputKey) && (multipleOutputs || !explicitLabel && output !== 'value');
  if (needOutput) parts.push(String(output));
  else if ((row?.kind === 'external' || series?.values) && (!explicitLabel || (meta?.rows.length ?? 0) > 1)) {
    const symbol = row?.symbolId ?? series?.symbolId;
    if (symbol && !baseKey.includes(normalizedLabel(symbol))) parts.push(String(symbol));
  }
  const key = `${base}\u0000${indicator ?? ''}\u0000${output ?? ''}`;
  const occurrence = (counts.get(key) ?? 0) + 1;
  counts.set(key, occurrence);
  if (occurrence > 1) parts.push(`#${occurrence}`);
  return parts.length ? `${base} · ${parts.join(' · ')}` : base;
}

function makeCard(document, role) {
  const card = element(document, 'div', 'live-readout-card');
  card.setAttribute('data-readout-card', role);
  const label = element(document, 'span', 'live-readout-card-label');
  label.setAttribute('data-readout-label', role);
  const time = element(document, 'time', 'live-readout-time');
  time.setAttribute('data-readout-time', role);
  const fields = element(document, 'div', 'live-readout-ohlcv');
  const values = new Map();
  for (const [key, text] of barFields) {
    const field = element(document, 'span', 'live-readout-field');
    const name = element(document, 'span', 'live-readout-field-label', text);
    const value = element(document, 'span', 'live-readout-field-value', '—');
    value.setAttribute('data-readout-value', key);
    add(field, name, value);
    add(fields, field);
    values.set(key, value);
  }
  add(card, label, time, fields);
  return {card, label, time, values};
}

function buildTree(root) {
  const document = root.ownerDocument ?? globalThis.document;
  if (!document || typeof document.createElement !== 'function') throw new TypeError('Readout root document required');
  clearRoot(root);
  root.setAttribute?.('data-live-readout', 'true');
  root.setAttribute?.('aria-live', 'off');
  const header = element(document, 'div', 'live-readout-header');
  const card = makeCard(document, 'selected');
  add(header, card.card);
  const selection = element(document, 'p', 'live-readout-selection', '데이터 없음');
  selection.setAttribute('data-readout-selection', '');
  const series = element(document, 'div', 'live-readout-series');
  series.setAttribute('data-readout-series-list', '');
  const empty = element(document, 'p', 'live-readout-empty', '데이터 없음');
  empty.setAttribute('data-readout-empty', '');
  add(root, header, selection, series, empty);
  return {document, card, selection, series, empty};
}

export function createLiveReadout({root, onError} = {}) {
  if (!root || typeof root.append !== 'function') throw new TypeError('Readout root element required');
  if (onError !== undefined && typeof onError !== 'function') throw new TypeError('Readout error callback required');
  const nodes = buildTree(root);
  const keyedRows = new Map();
  let disposed = false;
  let generation = 0;
  let current = null;

  const ownsChart = token => !disposed && current === token && generation === token.generation && !token.chart.disposed && !token.model.disposed && token.chart.model === token.model && token.chart.api === token.api && token.chart.container === token.container && token.api.model === token.model;
  const isCurrent = token => ownsChart(token) && token.chart.canvas === token.canvas;
  const refreshCanvas = token => {
    if (!ownsChart(token) || !token.chart.canvas) return false;
    token.canvas = token.chart.canvas;
    return true;
  };
  const report = error => {
    try { onError?.(error instanceof Error ? error : new Error(String(error))); } catch {}
  };
  const validToken = token => typeof token === 'function' ? token() : !token || isCurrent(token);

  function setText(node, value, token) {
    if (!validToken(token)) return false;
    const next = String(value);
    if (node.textContent === next) return validToken(token);
    node.textContent = next;
    return validToken(token);
  }

  function setAttribute(node, name, value, token) {
    if (!validToken(token)) return false;
    const next = String(value);
    let currentValue;
    try { currentValue = node.getAttribute?.(name); } catch {}
    if (currentValue === next) return validToken(token);
    node.setAttribute(name, next);
    return validToken(token);
  }

  function clearReading(card, message, token) {
    if (!setText(card.time, message, token)) return false;
    for (const value of card.values.values()) {
      if (!setText(value, '—', token)) return false;
      if (!setAttribute(value, 'title', message, token)) return false;
    }
    return true;
  }

  function publishCard(card, label, result, model, token, emptyMessage = '데이터 없음') {
    if (!setText(card.label, label, token)) return false;
    if (!result?.primary?.bar) return clearReading(card, emptyMessage, token);
    if (!setText(card.time, formattedTime(result.time, model), token)) return false;
    for (const [key, valueNode] of card.values) {
      const value = result.primary.bar[key];
      const precision = key === 'volume' ? undefined : model.symbol?.priceDecimals ?? model.precision;
      const display = Number.isFinite(value) ? readableNumber(value, precision) : '—';
      if (!setText(valueNode, display, token)) return false;
      if (!setAttribute(valueNode, 'title', Number.isFinite(value) ? `원본 값 ${rawNumber(value)}` : '값 없음', token)) return false;
    }
    return true;
  }

  function rowFor(id, token) {
    let row = keyedRows.get(id);
    if (row) return row;
    const label = element(nodes.document, 'span', 'live-readout-series-label');
    const swatch = element(nodes.document, 'span', 'live-readout-series-swatch');
    const value = element(nodes.document, 'span', 'live-readout-series-value', '—');
    const node = element(nodes.document, 'div', 'live-readout-series-row');
    node.setAttribute('data-readout-series', id);
    add(node, swatch, label, value);
    if (token && !isCurrent(token)) return null;
    nodes.series.append(node);
    if (token && !isCurrent(token)) {
      if (node.parentNode === nodes.series) node.remove();
      return null;
    }
    row = {node, label, swatch, value};
    keyedRows.set(id, row);
    return row;
  }

  function publishSeries(result, model, token) {
    const byId = new Map((result?.series ?? []).map(row => [row.id, row]));
    const baseMeta = new Map();
    for (const series of model.series) {
      if (!isVisiblePlotSeries(series)) continue;
      const base = normalizedLabel(series.label ?? series.id), meta = baseMeta.get(base) ?? {rows: [], indicators: new Set()};
      meta.rows.push({indicator: series.indicator ? String(series.indicator) : null, output: series.indicator ? String(series.output ?? 'value') : null});
      if (series.indicator) meta.indicators.add(String(series.indicator));
      baseMeta.set(base, meta);
    }
    const counts = new Map();
    const visible = [];
    for (const series of model.series) {
      if (!isVisiblePlotSeries(series)) continue;
      const row = byId.get(series.id);
      if (!row) continue;
      const node = rowFor(row.id, token);
      if (!node) return false;
      visible.push({row, series, node});
    }
    const visibleIds = new Set(visible.map(item => item.row.id));
    for (const [id, row] of [...keyedRows]) {
      if (visibleIds.has(id)) continue;
      // Retire the map entry before invoking DOM hooks. A reentrant bind may
      // immediately create a fresh row for the same identifier.
      keyedRows.delete(id);
      if (!isCurrent(token)) return false;
      if (row.node.parentNode === nodes.series) row.node.remove();
      if (!isCurrent(token)) return false;
    }
    let order = 0;
    for (const item of visible) {
      const expected = nodes.series.children[order] ?? null;
      if (expected !== item.node.node) {
        if (!isCurrent(token)) return false;
        nodes.series.insertBefore(item.node.node, expected);
        if (!isCurrent(token)) return false;
      }
      order++;
    }
    for (const item of visible) {
      const {row, series, node} = item;
      const label = seriesLabel(series, row, counts, baseMeta);
      if (!setText(node.label, label, token)) return false;
      if (!setAttribute(node.node, 'data-readout-status', row.status ?? 'value', token)) return false;
      const color = typeof series.color === 'string' ? series.color : typeof series.fill === 'string' ? series.fill : '';
      if (!isCurrent(token)) return false;
      node.swatch.style.backgroundColor = color;
      if (!isCurrent(token)) return false;
      if (!setText(node.value, rowValue(row, model), token)) return false;
      if (!setAttribute(node.value, 'title', statusTitle(row), token)) return false;
      const source = row.sourceIndex == null ? '' : ` · 원본 index ${row.sourceIndex}`;
      if (!setAttribute(node.node, 'title', `${label}${source}`, token)) return false;
      if (node.node.parentNode !== nodes.series) {
        if (!isCurrent(token)) return false;
        nodes.series.append(node.node);
        if (!isCurrent(token)) return false;
      }
    }
    return true;
  }

  function clearOwned(message = '데이터 없음', token = null) {
    const expectedGeneration = generation, expectedOwner = current;
    const valid = token ? () => isCurrent(token) : () => !disposed && generation === expectedGeneration && current === expectedOwner;
    if (!setText(nodes.card.label, '최신 봉', valid)) return;
    if (!clearReading(nodes.card, message, valid)) return;
    if (!setText(nodes.selection, message, valid)) return;
    if (!setText(nodes.empty, message, valid)) return;
    if (!setAttribute(nodes.card.card, 'data-readout-mode', 'latest', valid)) return;
    for (const [id, row] of [...keyedRows]) {
      keyedRows.delete(id);
      if (!valid()) return;
      if (row.node.parentNode === nodes.series) row.node.remove();
      if (!valid()) return;
    }
  }

  function detach(token) {
    if (!token) return;
    token.container.removeEventListener('aster:render', token.onRender);
    token.container.removeEventListener('aster:exploration', token.onExploration);
  }

  function syncToken(token) {
    if (!refreshCanvas(token) || !isCurrent(token)) return;
    try {
      const model = token.model, store = model.store, length = store.length;
      const exploration = explorationState(token.chart);
      const index = exploration.active ? null : pointerIndex(token.chart, model, token.canvas);
      if (!isCurrent(token)) return;
      const selectedLabel = exploration.active ? '키보드 선택' : index === null ? '최신 봉' : '십자선';
      let selected = null;
      if (exploration.active) {
        if (exploration.time !== null) selected = token.api.dataAt({time: exploration.time, match: 'exact'}, {indicatorMode: 'cached'});
      } else if (index !== null) {
        selected = token.api.dataAt({index}, {indicatorMode: 'cached'});
      } else if (length) {
        selected = token.api.dataAt({index: length - 1}, {indicatorMode: 'cached'});
      }
      if (!isCurrent(token)) return;
      if (!publishCard(nodes.card, selectedLabel, selected, model, token, exploration.active ? '선택한 봉을 찾을 수 없습니다.' : '데이터 없음')) return;
      if (!setText(nodes.selection, selected ? `봉 ${selected.index + 1} / ${length}` : exploration.active ? '선택한 봉을 찾을 수 없습니다.' : '데이터 없음', token)) return;
      if (!setText(nodes.empty, selected?.series?.some(row => isVisiblePlotSeries(model.series.find(series => series.id === row.id))) ? '' : '표시할 값이 없습니다.', token)) return;
      if (!publishSeries(selected, model, token)) return;
      if (!setAttribute(nodes.card.card, 'data-readout-mode', selectedLabel, token)) return;
      if (!setAttribute(nodes.selection, 'data-readout-selection-kind', selectedLabel, token)) return;
    } catch (error) {
      if (!isCurrent(token)) return;
      report(error);
      if (!isCurrent(token)) return;
      try { clearOwned(error?.name === 'StaleSourceError' ? '새 데이터 반영 중…' : '값을 읽지 못했습니다.', token); } catch (clearError) { report(clearError); }
    }
  }

  const api = {
    bind(chart) {
      if (disposed) return;
      generation++;
      const prior = current;
      current = null;
      detach(prior);
      if (chart === null || chart === undefined) {
        clearOwned('차트 없음');
        return;
      }
      if (!chart || !chart.model || !chart.api || !chart.canvas || !chart.container || typeof chart.container.addEventListener !== 'function' || typeof chart.container.removeEventListener !== 'function') throw new TypeError('Live CanvasChart required');
      const token = {chart, model: chart.model, api: chart.api, container: chart.container, canvas: chart.canvas, generation, onRender: null, onExploration: null};
      token.onRender = event => {
        if (!ownsChart(token) || event?.target !== token.chart.canvas) return;
        token.canvas = event.target;
        syncToken(token);
      };
      token.onExploration = event => {
        if (!ownsChart(token) || event?.target !== token.chart.canvas) return;
        token.canvas = event.target;
        syncToken(token);
      };
      current = token;
      token.container.addEventListener('aster:render', token.onRender);
      if (!ownsChart(token)) {
        detach(token);
        return;
      }
      token.container.addEventListener('aster:exploration', token.onExploration);
      if (!ownsChart(token)) {
        detach(token);
        return;
      }
      syncToken(token);
    },
    sync() {
      if (!disposed && current) syncToken(current);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      const prior = current;
      current = null;
      detach(prior);
      clearRoot(root);
      keyedRows.clear();
    },
  };
  return api;
}
