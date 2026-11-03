import { BarStore, ChartModel, createChart } from '../../src/index.mjs';

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

/** Convert Lightweight Charts numeric Unix seconds to BaroChart UTC milliseconds. */
export function lightweightSecondsToMilliseconds(seconds) {
  if (!Number.isSafeInteger(seconds)) {
    throw new TypeError('Lightweight Charts time must be a safe integer Unix second');
  }
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MILLISECONDS) {
    throw new RangeError('Lightweight Charts time is outside the exact UTC millisecond Date range');
  }
  return milliseconds;
}

function finiteField(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite`);
  }
  return value;
}

/** Convert a numeric-time Lightweight Charts candlestick row to BaroChart OHLCV. */
export function lightweightBarToBaro(row, { volumeForBar } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Lightweight Charts bar object required');
  }
  const time = lightweightSecondsToMilliseconds(row.time);
  const open = finiteField(row.open, 'open');
  const high = finiteField(row.high, 'high');
  const low = finiteField(row.low, 'low');
  const close = finiteField(row.close, 'close');
  const volume = Object.hasOwn(row, 'volume')
    ? finiteField(row.volume, 'volume')
    : typeof volumeForBar === 'function'
      ? finiteField(volumeForBar(row), 'volume policy result')
      : undefined;
  if (volume === undefined) {
    throw new TypeError('BaroChart requires volume; provide row.volume or an explicit volumeForBar policy');
  }
  if (volume < 0 || low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    throw new RangeError('Invalid OHLCV envelope');
  }
  return { time, open, high, low, close, volume };
}

/** Convert a chronological array of numeric-time Lightweight Charts rows. */
export function lightweightBarsToBaro(rows, options) {
  if (!Array.isArray(rows)) throw new TypeError('Lightweight Charts bars must be an array');
  const bars = rows.map(row => lightweightBarToBaro(row, options));
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].time <= bars[index - 1].time) {
      throw new RangeError('Lightweight Charts bars must be strictly increasing');
    }
  }
  return bars;
}

/** Append, replace the latest bar, or correct an existing historical bar. */
export function applyLightweightBar(store, row, options) {
  if (!store || typeof store.lowerBound !== 'function' || typeof store.append !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('BarStore-compatible target required');
  }
  const bar = lightweightBarToBaro(row, options);
  const index = store.lowerBound(bar.time);
  if (index < store.length && store.columns.time[index] === bar.time) {
    store.update(index, bar);
    return index === store.length - 1 ? 'update' : 'correction';
  }
  if (index !== store.length) {
    throw new RangeError('Cannot insert an unknown earlier bar; reload ordered history before applying it');
  }
  store.append(bar);
  return 'append';
}

/** Mount the local migration example page and return its host cleanup function. */
export function mountLightweightMigrationDemo(documentRef = globalThis.document, windowRef = globalThis.window) {
  const container = documentRef?.getElementById('chart');
  const status = documentRef?.getElementById('status');
  const updateButton = documentRef?.getElementById('update-last');
  if (!container || !status || !updateButton) throw new Error('Migration example page elements are missing');

  const sourceRows = [
    { time: 1_730_000_000, open: 100, high: 104, low: 98, close: 102, volume: 850 },
    { time: 1_730_000_060, open: 102, high: 106, low: 101, close: 105, volume: 920 },
    { time: 1_730_000_120, open: 105, high: 108, low: 103, close: 104, volume: 760 },
    { time: 1_730_000_180, open: 104, high: 109, low: 102, close: 108, volume: 1_120 },
  ];
  const store = new BarStore(lightweightBarsToBaro(sourceRows));
  const model = new ChartModel({ store });
  model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
  model.fit();
  const chart = createChart(container, model, { renderer: 'canvas' });
  let disposed = false;
  let updates = 0;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    updateButton.removeEventListener('click', updateLast);
    windowRef?.removeEventListener('pagehide', onPageHide);
    windowRef?.removeEventListener('pageshow', onPageShow);
    chart.destroy({ disposeModel: true });
  };
  const updateLast = () => {
    if (disposed) return;
    const last = sourceRows.at(-1);
    const current = store.at(store.length - 1);
    const close = current.close + (updates % 2 === 0 ? 1 : -1);
    const next = { ...last, high: Math.max(last.high, close), low: Math.min(last.low, close), close };
    sourceRows[sourceRows.length - 1] = next;
    applyLightweightBar(store, next);
    updates += 1;
    status.textContent = `Applied update to the latest bar (${updates}).`;
  };
  updateButton.addEventListener('click', updateLast);
  const onPageHide = event => {
    if (!event.persisted) cleanup();
  };
  const onPageShow = event => {
    if (event.persisted && !chart.disposed) chart.resize();
  };
  windowRef?.addEventListener('pagehide', onPageHide);
  windowRef?.addEventListener('pageshow', onPageShow);
  return cleanup;
}

// Importing this module in Node or from another page is inert. Only its own page opts in.
if (typeof document !== 'undefined' && document.documentElement?.dataset.example === 'lightweight-migration') {
  mountLightweightMigrationDemo(document, window);
}
