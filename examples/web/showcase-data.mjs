import {seededColumns} from '../../src/core/index.mjs';

const SOURCE_BAR_COUNT = 1800;
const SOURCE_INTERVAL_MS = 60_000;
const SHOWCASE_SEED = 0x5a17cafe;

export const SHOWCASE_INTERVALS = Object.freeze([1, 5, 15]);
export const SHOWCASE_START_TIME = Date.UTC(2026, 0, 5, 14, 30);

function sourceColumns() {
  const columns = seededColumns(SOURCE_BAR_COUNT, SHOWCASE_SEED);
  for (let i = 0; i < SOURCE_BAR_COUNT; i++) columns.time[i] = SHOWCASE_START_TIME + i * SOURCE_INTERVAL_MS;
  return columns;
}

export function createShowcaseBars(intervalMinutes = 5) {
  if (!SHOWCASE_INTERVALS.includes(intervalMinutes)) throw new RangeError('Showcase interval must be 1, 5, or 15 minutes');

  const columns = sourceColumns();
  const step = intervalMinutes;
  const bars = new Array(SOURCE_BAR_COUNT / step);
  for (let bucket = 0; bucket < bars.length; bucket++) {
    const from = bucket * step;
    const to = from + step;
    let high = columns.high[from];
    let low = columns.low[from];
    let volume = 0;
    for (let i = from; i < to; i++) {
      high = Math.max(high, columns.high[i]);
      low = Math.min(low, columns.low[i]);
      volume += columns.volume[i];
    }
    bars[bucket] = {
      time: columns.time[from],
      open: columns.open[from],
      high,
      low,
      close: columns.close[to - 1],
      volume,
    };
  }
  return bars;
}
