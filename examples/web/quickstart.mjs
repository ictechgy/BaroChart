import { BarStore, ChartModel, createChart } from '../../src/index.mjs';

const store = new BarStore([
  { time: 1700000000000, open: 100, high: 103, low: 99, close: 102, volume: 500 },
  { time: 1700000060000, open: 102, high: 104, low: 101, close: 103, volume: 650 },
  { time: 1700000120000, open: 103, high: 105, low: 102, close: 104, volume: 700 },
  { time: 1700000180000, open: 104, high: 106, low: 103, close: 105, volume: 800 },
]);
const model = new ChartModel({ store });
model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
model.indicators.add('ema3', 'ema', { period: 3 });
model.addSeries({
  id: 'ema3', type: 'line', panel: 'price',
  indicator: 'ema3', color: '#f0b755',
});
model.fit();
const chart = createChart(document.getElementById('chart'), model, {
  renderer: 'canvas',
});

// Same timestamp replaces the last bar; a later timestamp appends.
store.upsert({
  time: 1700000180000, open: 104, high: 107,
  low: 103, close: 106, volume: 900,
});

// Preserve the chart across back/forward-cache navigation; dispose on exit.
window.addEventListener('pagehide', event => {
  if (!event.persisted) chart.destroy({ disposeModel: true });
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !chart.disposed) chart.resize();
});
