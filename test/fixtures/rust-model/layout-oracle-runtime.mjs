// Shared, Node/JSC-compatible fixture runner. It talks to the actual public model/layout API.
import {BarStore, ChartModel, createLayout, seededColumns} from '../../../src/core/index.mjs';
import {labelMetrics} from '../../../src/core/labels.mjs';

const START = 1_700_000_000_000;
const FRAME_WIDTH = 800;
const FRAME_HEIGHT = 480;

const smallBars = Array.from({length: 12}, (_, index) => {
  const close = 96 + index * 1.25;
  return {
    time: START + [0, 60_000, 120_000, 180_000, 300_000, 360_000, 420_000, 540_000, 600_000, 660_000, 720_000, 900_000][index],
    open: close - 0.5,
    high: close + 2,
    low: close - 2,
    close,
    volume: (index + 1) * (index % 3 + 1),
  };
});

export const layoutScenarios = [
  {
    id: 'multi-axis-320-large-font',
    data: {bars: smallBars},
    model: {
      theme: {font: '320px monospace'},
      panels: [
        {id: 'price', weight: 3, scale: 'log', inverted: true, padding: 0.08, axisVisible: true, axisSide: 'right'},
        {id: 'volume', weight: 1, scale: 'linear', axisVisible: false, axisSide: 'left'},
      ],
      axes: [
        {id: 'return', panel: 'price', side: 'left', scale: 'percent', base: 100, range: [90, 110], padding: 0, width: 48, label: 'Return', precision: 4, tickFormat: 'scientific', prefix: '~', suffix: '%'},
        {id: 'hidden', panel: 'price', side: 'right', scale: 'log', range: [1, 1000], padding: 0, visible: false, width: 32},
      ],
      axisWidth: 82,
      visibleBars: 12,
    },
    series: [
      {id: 'price-bars', type: 'candles', panel: 'price'},
      {id: 'returns', type: 'line', panel: 'price', axisId: 'return', values: [90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112]},
      {id: 'volume-bars', type: 'histogram', panel: 'volume', source: 'volume'},
    ],
    size: {width: 320, height: 240},
    view: [0, 11],
    queries: {
      xIndices: [0, 3.5, 11],
      screenFractions: [0, 0.5, 1],
      axes: [
        {panel: 'price', axisId: null, prices: [96, 100, 110, 111], screenFractions: [0, 0.5, 1]},
        {panel: 'price', axisId: 'return', prices: [90, 100, 110], screenFractions: [0, 0.5, 1]},
        {panel: 'price', axisId: 'hidden', prices: [1, 10, 1000], screenFractions: [0, 0.5, 1]},
        {panel: 'volume', axisId: null, prices: [0, 20, 120], screenFractions: [0, 0.5, 1]},
      ],
      points: [
        {panel: 'price', axisId: null, time: smallBars[3].time, price: 101},
        {panel: 'price', axisId: 'return', time: smallBars[7].time, price: 104},
      ],
      fromScreen: [
        {panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5},
        {panel: 'price', axisId: 'return', xFraction: 1, yFraction: 1},
      ],
      drawings: [
        {panel: 'price', axisId: null},
        {panel: 'price', axisId: 'return', seriesId: 'returns'},
        {panel: 'volume', axisId: null, seriesId: 'volume-bars'},
        {panel: 'price', axisId: 'hidden', seriesId: 'missing-series'},
      ],
    },
    mutations: [],
  },
  {
    id: 'live-layout-after-pan',
    data: {bars: smallBars},
    model: {panels: [{id: 'price', weight: 1}], visibleBars: 10},
    series: [{id: 'bars', type: 'candles', panel: 'price'}],
    size: {width: 800, height: 480},
    view: [0, 10],
    queries: {
      xIndices: [0, 5, 10],
      screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [96, 100, 110], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: smallBars[4].time, price: 102}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null}],
    },
    mutations: [{kind: 'pan', delta: 2, refresh: true}],
  },
  {
    id: 'live-layout-after-visibility-change',
    data: {bars: smallBars},
    model: {panels: [{id: 'price', weight: 1}], visibleBars: 10},
    series: [{id: 'bars', type: 'candles', panel: 'price'}, {id: 'line', type: 'line', panel: 'price'}],
    size: {width: 800, height: 480},
    view: [0, 10],
    queries: {
      xIndices: [0, 5, 10],
      screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [96, 100, 110], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: smallBars[4].time, price: 102}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null, seriesId: 'line'}, {panel: 'price', axisId: null, seriesId: 'bars'}],
    },
    mutations: [{kind: 'visibility', seriesId: 'line', visible: false, refresh: true}],
  },
  {
    id: 'live-layout-after-store-time-change',
    data: {bars: smallBars},
    model: {panels: [{id: 'price', weight: 1}], visibleBars: 10},
    series: [{id: 'bars', type: 'candles', panel: 'price'}],
    size: {width: 800, height: 480},
    view: [0, 10],
    queries: {
      xIndices: [0, 5, 10],
      screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [96, 100, 110], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: smallBars[4].time, price: 102}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null, seriesId: 'bars'}],
    },
    mutations: [{kind: 'set-data', bars: smallBars.map((bar, index) => ({...bar, time: bar.time + 7_200_000})), refresh: true}],
  },
  {
    id: 'indicator-lazy-revision-and-index-update',
    data: {seed: 0x5eed, barCount: 128},
    indicators: [{id: 'sma-study', name: 'sma', params: {period: 8}}],
    model: {panels: [{id: 'price', weight: 1}], visibleBars: 96},
    series: [{id: 'sma-line', type: 'line', panel: 'price', indicator: 'sma-study'}],
    size: {width: 960, height: 540},
    view: [24, 120],
    queries: {
      xIndices: [24, 64, 120],
      screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [90, 100, 110, 120], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: START + 64 * 60_000, price: 100}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null, seriesId: 'sma-line'}],
    },
    mutations: [{kind: 'update-close', index: 127, delta: 17, refresh: true}],
  },
  {
    id: 'volume-aggregation-and-finite-gaps',
    data: {seed: 0x5eed, barCount: 256},
    model: {panels: [{id: 'volume', weight: 1, axisVisible: false}], axisWidth: 64, visibleBars: 200},
    series: [
      {id: 'volume-aggregate', type: 'histogram', panel: 'volume', source: 'volume'},
      {id: 'custom-gapped', type: 'line', panel: 'volume', values: ['NaN', 1, 2, 'NaN', 4, 5, 6, 'NaN', 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255]},
    ],
    size: {width: 360, height: 240},
    view: [0, 80],
    queries: {
      xIndices: [0, 40, 80], screenFractions: [0, 0.5, 1],
      axes: [{panel: 'volume', axisId: null, prices: [0, 50, 300], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'volume', axisId: null, time: START + 40 * 60_000, price: 50}],
      fromScreen: [{panel: 'volume', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'volume', axisId: null, seriesId: 'volume-aggregate'}],
    },
    mutations: [],
  },
  {
    id: 'block-cache-threshold-65536-and-update',
    data: {seed: 0x5eed, barCount: 65_536},
    model: {panels: [{id: 'price', weight: 1}], visibleBars: 512},
    series: [{id: 'close-line', type: 'line', panel: 'price', source: 'close'}],
    size: {width: 1024, height: 600},
    view: [65_024, 65_535],
    queries: {
      xIndices: [65_024, 65_280, 65_535], screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [80, 100, 120], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: START + 65_280 * 60_000, price: 100}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null, seriesId: 'close-line'}],
    },
    mutations: [{kind: 'update-close', index: 65_535, delta: 7, refresh: true}],
  },
  {
    id: 'log-inverted-wide-padding-v8-jsc',
    data: {bars: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((close, index) => ({time: START + index * 60_000, open: close, high: close, low: close, close, volume: 1}))},
    model: {panels: [{id: 'price', weight: 1, scale: 'log', inverted: true, padding: 0.11}], visibleBars: 10},
    series: [{id: 'bars', type: 'candles', panel: 'price'}],
    size: {width: 800, height: 480},
    view: [0, 9],
    queries: {
      xIndices: [0, 5, 9], screenFractions: [0, 0.5, 1],
      axes: [{panel: 'price', axisId: null, prices: [0.01, 1, 2, Math.E, 1e150, 1e300], screenFractions: [0, 0.5, 1]}],
      points: [{panel: 'price', axisId: null, time: START + 5 * 60_000, price: 2}],
      fromScreen: [{panel: 'price', axisId: null, xFraction: 0.5, yFraction: 0.5}],
      drawings: [{panel: 'price', axisId: null}],
    },
    mutations: [],
  },
  ...[
    {id: 'layout-size-minimum-valid', width: 100, height: 80},
    {id: 'layout-size-maximum-valid', width: 16_384, height: 16_384},
    {id: 'layout-size-width-below-minimum', width: 99, height: 80},
    {id: 'layout-size-height-below-minimum', width: 100, height: 79},
    {id: 'layout-size-width-above-maximum', width: 16_385, height: 80},
    {id: 'layout-size-height-above-maximum', width: 100, height: 16_385},
    {id: 'layout-size-width-nan', width: '$NaN', height: 80},
    {id: 'layout-size-width-infinity', width: '$Infinity', height: 80},
    {id: 'layout-size-height-infinity', width: 100, height: '$Infinity'},
  ].map(({id, width, height}) => ({
    id,
    data: {bars: []},
    model: {panels: [{id: 'price', weight: 1}]},
    series: [],
    size: {width, height},
    view: null,
    queries: {xIndices: [], screenFractions: [], axes: [], points: [], fromScreen: [], drawings: []},
    mutations: [],
  })),
];

function specialNumber(value) {
  if (value === '$NaN') return NaN;
  if (value === '$Infinity') return Infinity;
  if (value === '$-Infinity') return -Infinity;
  return value;
}

export function scenarioInput(scenario) {
  const input = {...scenario, size: {...scenario.size}};
  input.size.width = specialNumber(input.size.width);
  input.size.height = specialNumber(input.size.height);
  return input;
}

export function scenarioBars(data) {
  if (data.bars) return data.bars;
  const columns = seededColumns(data.barCount, data.seed);
  return Array.from({length: data.barCount}, (_, index) => ({
    time: columns.time[index],
    open: columns.open[index],
    high: columns.high[index],
    low: columns.low[index],
    close: columns.close[index],
    volume: columns.volume[index],
  }));
}

function fixtureNumber(value) {
  if (value === '$NaN') return NaN;
  if (value === '$Infinity') return Infinity;
  if (value === '$-Infinity') return -Infinity;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  return value;
}

function fixtureValue(value) {
  if (typeof value === 'number' || typeof value === 'string' && ['NaN', 'Infinity', '-Infinity'].includes(value)) {
    return fixtureNumber(value);
  }
  if (Array.isArray(value)) return value.map(fixtureValue);
  return value;
}

function clean(value) {
  if (typeof value === 'function') return undefined;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return {$f64: 'NaN'};
    if (value === Infinity) return {$f64: 'Infinity'};
    if (value === -Infinity) return {$f64: '-Infinity'};
    if (Object.is(value, -0)) return {$f64: '-0'};
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, value, false);
    return {$f64: bits.getBigUint64(0, false).toString(16).padStart(16, '0')};
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = clean(child);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return value;
}

export function rowText(value) {
  return JSON.stringify(clean(value));
}

function stripWidths(model) {
  let left = 0, right = 0;
  for (const panel of model.panels) {
    let rowLeft = 0, rowRight = 0;
    if (panel.axisVisible !== false) {
      if (panel.axisSide === 'left') rowLeft = model.axisWidth;
      else rowRight = model.axisWidth;
    }
    for (const axis of model.axes) {
      if (axis.panel !== panel.id || !axis.visible) continue;
      if (axis.side === 'left') rowLeft += axis.width ?? model.axisWidth;
      else rowRight += axis.width ?? model.axisWidth;
    }
    left = Math.max(left, rowLeft);
    right = Math.max(right, rowRight);
  }
  return [left, right];
}

function axisTag(axis) {
  if (!axis) return null;
  return {id: axis.id, panel: axis.panel, axisId: axis.axisId, scale: axis.scale, side: axis.side, visible: axis.visible};
}

function cacheSnapshot(model, store, scenario) {
  const start = Math.max(0, Math.floor(model.view.from));
  const end = Math.max(start, Math.min(store.length, Math.ceil(model.view.to + 1)));
  return model.series.map(series => {
    const index = series.rangeIndex;
    let indexState = null;
    if (index) {
      indexState = {
        kind: index.constructor.name,
        size: index.size,
        length: index.length ?? store.length,
        blockSize: index.blockSize ?? null,
        finiteCounts: index.finiteCounts,
        bytes: index.bytes,
        hasGaps: index.hasGaps(start, end),
      };
    }
    return {
      id: series.id,
      dirtyFrom: series.dirtyFrom,
      revision: series.revision,
      rangeIndex: indexState,
    };
  });
}

function indicatorSnapshot(model, scenario) {
  return (scenario.indicators ?? []).map(({id}) => {
    const entry = model.indicators.entries.get(id);
    return {
      id,
      revision: entry?.revision,
      dirty: entry?.dirty,
      dirtyTo: entry?.dirtyTo,
      length: entry?.length,
      computedFrom: entry?.computedFrom,
      computedUntil: entry?.computedUntil,
    };
  });
}

function layoutQueries(layout, model, store, scenario) {
  const queries = scenario.queries;
  const x = queries.xIndices.map(index => layout.x(index));
  const index = queries.screenFractions.map(fraction => {
    const panel = layout.panels[0];
    return layout.index(panel.left + fraction * (panel.right - panel.left));
  });
  const axes = queries.axes.map(request => {
    const axis = layout.axis(request.panel, request.axisId ?? null);
    if (!axis) return {panel: request.panel, axisId: request.axisId ?? null, axis: null};
    return {
      panel: request.panel,
      axisId: request.axisId ?? null,
      axis: axisTag(axis),
      y: request.prices.map(value => axis.y(fixtureNumber(value))),
      transform: request.prices.map(value => axis.transform(fixtureNumber(value))),
      inverse: request.prices.map(value => axis.inverse(axis.transform(fixtureNumber(value)))),
      price: request.screenFractions.map(fraction => axis.price(axis.top + fraction * (axis.bottom - axis.top))),
    };
  });
  const points = queries.points.map(point => ({
    panel: point.panel,
    axisId: point.axisId ?? null,
    value: layout.toScreen({time: point.time, price: fixtureNumber(point.price)}, point.panel, point.axisId ?? null),
  }));
  const fromScreen = queries.fromScreen.map(point => {
    const panel = layout.panels.find(candidate => candidate.id === point.panel);
    const sx = panel.left + point.xFraction * (panel.right - panel.left);
    const axis = layout.axis(point.panel, point.axisId ?? null);
    const sy = axis.top + point.yFraction * (axis.bottom - axis.top);
    try {
      return {panel: point.panel, axisId: point.axisId ?? null, value: layout.fromScreen(sx, sy, point.panel, point.axisId ?? null)};
    } catch (error) {
      return {panel: point.panel, axisId: point.axisId ?? null, error: {name: error.name, message: error.message}};
    }
  });
  const drawings = queries.drawings.map(drawing => ({
    panel: drawing.panel,
    axisId: drawing.axisId ?? null,
    seriesId: drawing.seriesId ?? null,
    axis: axisTag(layout.drawingAxis({...drawing, axisId: drawing.axisId ?? null})),
  }));
  return {x, index, axes, points, fromScreen, drawings};
}

function layoutAux(model, scenario) {
  const [leftStrip, rightStrip] = stripWidths(model);
  const stripFactor = Math.min(1, (scenario.size.width - 32) / (leftStrip + rightStrip || 1));
  const footer = Math.min(scenario.size.height - 24, Math.max(38, Math.ceil(labelMetrics(model.theme.font).height + 20)));
  return {
    leftStrip,
    rightStrip,
    stripFactor,
    footer,
    plotLeft: 12 + leftStrip * stripFactor,
    plotRight: Math.max(12 + leftStrip * stripFactor + 20, scenario.size.width - rightStrip * stripFactor),
  };
}

function layoutState(layout, model, store, scenario, aux) {
  return {
    layout: clean(layout),
    derived: {
      ...aux,
      caches: cacheSnapshot(model, store, scenario),
      indicators: indicatorSnapshot(model, scenario),
      queries: layoutQueries(layout, model, store, scenario),
    },
  };
}

function buildModel(store, scenario) {
  const model = new ChartModel({store, ...scenario.model});
  for (const indicator of scenario.indicators ?? []) {
    model.indicators.add(indicator.id, indicator.name, fixtureValue(indicator.params ?? {}));
  }
  for (const definition of scenario.series) {
    const options = {...definition};
    if (Object.hasOwn(options, 'values')) options.values = Float64Array.from(options.values, fixtureNumber);
    model.addSeries(options);
  }
  if (scenario.view) model.setVisibleRange(scenario.view[0], scenario.view[1]);
  return model;
}

function applyMutation(model, store, mutation) {
  switch (mutation.kind) {
    case 'pan':
      model.pan(mutation.delta);
      break;
    case 'visibility': {
      const series = model.series.find(item => item.id === mutation.seriesId);
      series.visible = mutation.visible;
      break;
    }
    case 'update-close': {
      const bar = store.at(mutation.index);
      const close = bar.close + mutation.delta;
      store.update(mutation.index, {
        ...bar,
        open: Math.max(bar.open, close) === bar.open ? bar.open : close,
        high: Math.max(bar.high, close),
        low: Math.min(bar.low, close),
        close,
      });
      break;
    }
    case 'set-data':
      store.setData(mutation.bars);
      break;
    default:
      throw new TypeError(`Unknown fixture mutation: ${mutation.kind}`);
  }
}

function buildScenarioModel(store, scenario) {
  store.setData(scenarioBars(scenario.data));
  return buildModel(store, scenario);
}

export function runLayoutScenarios(scenarios = layoutScenarios) {
  const store = new BarStore();
  const rows = [];
  for (const scenario of scenarios) {
    let model;
    const size = {width: specialNumber(scenario.size.width), height: specialNumber(scenario.size.height)};
    const input = {...scenarioInput(scenario), data: scenario.data, size};
    try {
      model = buildScenarioModel(store, scenario);
      const layout = createLayout(model, size.width, size.height);
      const aux = layoutAux(model, scenario);
      const steps = [{kind: 'initial', state: layoutState(layout, model, store, scenario, aux)}];
      for (const mutation of scenario.mutations) {
        applyMutation(model, store, mutation);
        const oldLayout = layoutState(layout, model, store, scenario, aux);
        let refreshed = null;
        if (mutation.refresh) {
          const nextLayout = createLayout(model, size.width, size.height);
          refreshed = layoutState(nextLayout, model, store, scenario, layoutAux(model, scenario));
        }
        steps.push({kind: mutation.kind, oldLayout, refreshed});
      }
      rows.push({scenarioId: scenario.id, input: rowText(input), expected: rowText({steps}), error: null});
    } catch (error) {
      rows.push({
        scenarioId: scenario.id,
        input: rowText(input),
        expected: null,
        error: {name: error.name, message: error.message},
      });
    } finally {
      model?.dispose();
    }
  }
  return rows;
}

export {FRAME_HEIGHT, FRAME_WIDTH, START};
