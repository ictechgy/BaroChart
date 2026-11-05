// JavaScriptCore companion for the log-axis fixture. This deliberately uses the public
// BarStore/ChartModel/createLayout API so its output describes the same model as the V8 oracle.
import {BarStore, ChartModel, createLayout} from '../../../src/core/index.mjs';

const WIDTH = 800, HEIGHT = 500;
const scenarios = JSON.parse(arguments[0] ?? '[]');
const bitBuffer = new DataView(new ArrayBuffer(8));

function encodeNumber(value) {
  if (Number.isNaN(value)) return {$f64: 'NaN'};
  if (value === Infinity) return {$f64: 'Infinity'};
  if (value === -Infinity) return {$f64: '-Infinity'};
  if (Object.is(value, -0)) return {$f64: '-0'};
  bitBuffer.setFloat64(0, value, false);
  return {$f64: bitBuffer.getBigUint64(0, false).toString(16).padStart(16, '0')};
}
function wire(value) {
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) return value.map(wire);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).map(key => [key, wire(value[key])]));
}
const rowText = row => JSON.stringify(wire(row));

for (const scenario of scenarios) {
  const bars = scenario.barValues
    ? scenario.barValues.map((value, index) => ({
      time: 1_700_000_000_000 + index * 60_000,
      open: value,
      high: value,
      low: value,
      close: value,
      volume: 1,
    }))
    : (() => {
      const close = scenario.storeFirstClose ?? scenario.values.find(Number.isFinite) ?? 1;
      return scenario.values.map((_, index) => ({
        time: 1_700_000_000_000 + index * 60_000,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      }));
    })();
  let model;
  try {
    model = new ChartModel({
      store: new BarStore(bars),
      panels: [{
        id: 'price',
        scale: scenario.scale,
        padding: scenario.padding,
        inverted: scenario.inverted ?? false,
        ...(scenario.range === undefined ? {} : {range: scenario.range}),
      }],
    });
    model.addSeries({
      id: 'axis-source',
      type: scenario.seriesType ?? 'line',
      panel: 'price',
      ...(scenario.baseline === undefined ? {} : {baseline: scenario.baseline}),
      ...(scenario.values === undefined ? {} : {values: Float64Array.from(scenario.values)}),
    });
    model.setVisibleRange(0, bars.length - 1);
    const axis = createLayout(model, WIDTH, HEIGHT).axis('price');
    const screenSamples = scenario.screenSamples ?? [12, 239, 466, -895, 1378];
    const result = {
      min: axis.min,
      max: axis.max,
      base: axis.base,
      top: axis.top,
      bottom: axis.bottom,
      lo: axis.lo,
      hi: axis.hi,
      y: scenario.samples.map(value => axis.y(value)),
      price: screenSamples.map(value => axis.price(value)),
      transform: scenario.samples.map(value => axis.transform(value)),
      inverse: scenario.samples.map(value => axis.inverse(axis.transform(value))),
    };
    print(JSON.stringify({scenarioId: scenario.id, expectedJsc: rowText(result)}));
  } finally {
    model?.dispose();
  }
}
