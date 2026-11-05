import {seededColumns} from '../../src/core/data.mjs';
import {demoCalendar} from '../../src/core/markets.mjs';

const DEMO_MARKETS = new Set(['us', 'kr', 'crypto']);
const DATA_FIELDS = Object.freeze(['time', 'open', 'high', 'low', 'close', 'volume']);
const MAX_DEMO_DATA_COUNT = 4_194_304;

function countValue(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEMO_DATA_COUNT) throw new RangeError('Demo data count limit');
  return value;
}

function progressCallback(value) {
  if (value === undefined) return () => {};
  if (typeof value !== 'function') throw new TypeError('Demo data progress callback required');
  return value;
}

/**
 * Generate the exact synthetic OHLCV columns historically produced by the
 * example model worker.  This is data preparation only: no ChartModel,
 * indicator engine, or render state is created here.
 */
export function makeDemoData({market, count, onProgress} = {}) {
  if (!DEMO_MARKETS.has(market)) throw new TypeError('Demo market');
  const n = countValue(count);
  const report = progressCallback(onProgress);
  const columns = seededColumns(n, 42);
  const calendar = demoCalendar(market);
  let written = 0;
  let date = '2026-01-01';
  let nextProgress = 0;
  while (written < n) {
    for (const session of calendar.sessions(date).filter(value => value.kind === 'regular')) {
      for (let time = session.open; time < session.close && written < n; time += 60000) columns.time[written++] = time;
    }
    if (written >= nextProgress) {
      report({phase: 'data', done: written, total: n});
      nextProgress = written + Math.max(10000, n / 20);
    }
    date = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  const factor = market === 'kr' ? 700 : market === 'crypto' ? 1e-10 : 1;
  if (factor !== 1) for (const key of ['open', 'high', 'low', 'close']) {
    for (let index = 0; index < n; index++) columns[key][index] *= factor;
  }
  return columns;
}

export {DATA_FIELDS, MAX_DEMO_DATA_COUNT};
