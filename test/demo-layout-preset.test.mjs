import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,builtinIndicators} from '../src/core/index.mjs';
import {captureDemoLayout,stringifyDemoLayout,parseDemoLayout,presetOptions,MAX_DEMO_LAYOUT_BYTES} from '../examples/web/demo-layout-preset.mjs';

function baseModel(options={}) {
  const model = new ChartModel({store: new BarStore(), panels: [
    {id: 'price', weight: 3, ...(options.price ?? {})},
    {id: 'volume', weight: 1, ...(options.volume ?? {})},
    ...(options.panels ?? []),
  ], axes: options.axes ?? [], precision: options.precision ?? 2, axisWidth: options.axisWidth ?? 85});
  const api = new ChartAPI(model);
  api.addSeries({id: 'price', type: options.priceType ?? 'candles', panel: 'price'});
  api.addSeries({id: 'volume', type: 'histogram', source: 'volume', panel: 'volume'});
  return {model, api};
}

function dispose(model) { model?.dispose(); }

test('round trips every canonical builtin with params, styles and -0', () => {
  const {model} = baseModel({price: {range: [-0, 200]}});
  try {
    for (const [index, name] of [...builtinIndicators.keys()].entries()) {
      const id = `i-${index}`;
      model.indicators.add(id, name, name === 'ema' ? {period: 7} : {});
      const entry = model.indicators.entries.get(id);
      for (const output of entry.def.outputs) model.addSeries({
        id: `${id}-${output}`,
        type: output === 'histogram' ? 'histogram' : 'line',
        panel: 'price', indicator: id, output,
        color: '#12345678', fill: '#abcdef', width: 2, offset: -0,
      });
    }
    const preset = captureDemoLayout(model, {market: 'us', count: 100000, light: true});
    assert.equal(preset.layout.indicators.length, 35);
    assert.equal(preset.layout.panels[0].range[0], -0);
    const text = stringifyDemoLayout(preset), parsed = parseDemoLayout(text);
    assert.deepEqual(parsed, preset);
    assert.ok(text.includes('"$asterNumber":"-0"'));
    const options = presetOptions(parsed, model);
    assert.equal(options.theme.background, '#f8fafc');
    assert.equal(options.precision, model.precision);
    assert.equal(options.axisWidth, model.axisWidth);
    assert.notStrictEqual(options.panels, parsed.layout.panels);
    assert.notStrictEqual(options.series, parsed.layout.series);
  } finally { dispose(model); }
});

test('rejects malformed, untrusted, unsupported and over-limit documents', () => {
  const valid = {schema: 'barochart.main-demo-layout', version: 1, market: 'us', count: 10000, light: false, layout: {
    panels: [{id: 'price'}, {id: 'volume'}],
    axes: [],
    series: [{id: 'price', type: 'candles', panel: 'price'}, {id: 'volume', type: 'histogram', source: 'volume', panel: 'volume'}],
    indicators: [],
  }};
  for (const text of [
    '{bad', JSON.stringify({...valid, schema: 'aster.workspace'}),
    JSON.stringify({...valid, extra: true}),
    JSON.stringify({...valid, layout: {...valid.layout, extra: true}}),
    '{"schema":"barochart.main-demo-layout","schema":"barochart.main-demo-layout","version":1}',
    JSON.stringify({...valid, layout: {...valid.layout, indicators: [{id: 'x', name: 'ema', params: {}, module: {id: 'x'}}]}}),
    JSON.stringify({...valid, layout: {...valid.layout, series: [...valid.layout.series, {id: 'x', type: 'line', panel: 'price', values: [1]}]}}),
    JSON.stringify({...valid, managed: {panels: ['price'], axes: []}}),
    JSON.stringify({...valid, managed: {panels: ['missing'], axes: []}}),
    JSON.stringify({...valid, managed: {panels: [], axes: ['missing']}}),
    JSON.stringify({...valid, managed: {panels: ['price'], axes: [], extra: true}}),
  ]) assert.throws(() => parseDemoLayout(text));
  const tooManyPanels = {...valid, layout: {...valid.layout, panels: [...valid.layout.panels, ...Array.from({length: 31}, (_, i) => ({id: `p-${i}`}))]}};
  assert.throws(() => stringifyDemoLayout(tooManyPanels), /panel|limit/i);
  const tooLong = 'x'.repeat(MAX_DEMO_LAYOUT_BYTES + 1);
  assert.throws(() => parseDemoLayout(tooLong), /limit/i);
});

test('old files default to empty managed ownership and canonicalize it on save', () => {
  const old = {schema: 'barochart.main-demo-layout', version: 1, market: 'us', count: 10000, light: false, layout: {
    panels: [{id: 'price'}, {id: 'volume'}], axes: [],
    series: [{id: 'price', type: 'candles', panel: 'price'}, {id: 'volume', type: 'histogram', source: 'volume', panel: 'volume'}], indicators: [],
  }};
  const parsed = parseDemoLayout(JSON.stringify(old));
  assert.deepEqual(parsed.managed, {panels: [], axes: []});
  assert.deepEqual(parseDemoLayout(stringifyDemoLayout(parsed)).managed, {panels: [], axes: []});
});

test('capture is detached and omits generated drawing-only resources', () => {
  const {model, api} = baseModel({panels: [{id: 'generated', weight: 1}], axes: [{id: 'generated-axis', panel: 'generated'}]});
  const generatedPanelIds = new Set(['generated']), generatedAxisIds = new Set(['generated-axis']);
  try {
    model.drawings.add({id: 'history-only', type: 'horizontal', panel: 'generated', axisId: 'generated-axis', points: [{time: 0, price: 1}]});
    const before = {panels: model.panels.map(panel => ({...panel})), axes: model.axes.map(axis => ({...axis})), series: model.series.map(series => ({...series}))};
    const preset = captureDemoLayout(model, {market: 'kr', count: 10000, light: false, generatedPanelIds, generatedAxisIds});
    assert.deepEqual(preset.layout.panels.map(panel => panel.id), ['price', 'volume']);
    assert.deepEqual(preset.layout.axes, []);
    assert.deepEqual(model.panels.map(panel => ({...panel})), before.panels);
    assert.deepEqual(model.axes.map(axis => ({...axis})), before.axes);
    assert.deepEqual(model.series.map(series => ({...series})), before.series);
    assert.equal(generatedPanelIds.has('generated'), true);
    assert.equal(generatedAxisIds.has('generated-axis'), true);
    void api;
  } finally { dispose(model); }
});

test('capture removes owned synthetic ranges but keeps manual ranges and styles', () => {
  const {model} = baseModel({panels: [
    {id: 'synthetic', weight: 1, range: [0, 100], label: 'synthetic'},
    {id: 'manual', weight: 1, range: [0, 100], label: 'manual'},
  ]});
  const synthetic = model.panels.find(panel => panel.id === 'synthetic');
  try {
    const syntheticPanelRanges = new Map([['synthetic', {model, range: synthetic.range.slice(), rangeRef: synthetic.range}]]);
    const preset = captureDemoLayout(model, {market: 'crypto', count: 1000000, light: true, syntheticPanelRanges});
    assert.equal(Object.hasOwn(preset.layout.panels.find(panel => panel.id === 'synthetic'), 'range'), false);
    assert.deepEqual(preset.layout.panels.find(panel => panel.id === 'manual').range, [0, 100]);
    assert.equal(preset.layout.panels.find(panel => panel.id === 'synthetic').label, 'synthetic');
  } finally { dispose(model); }
});

test('explicit empty panels and axes survive capture and managed ownership stays empty', () => {
  const {model} = baseModel({panels: [{id: 'notes', weight: 1, label: 'Empty notes'}], axes: [{id: 'notes-axis', panel: 'notes', label: 'Notes'}]});
  try {
    const preset = captureDemoLayout(model, {market: 'us', count: 10000, light: false, generatedPanelIds: new Set(), generatedAxisIds: new Set()});
    assert.deepEqual(preset.managed, {panels: [], axes: []});
    assert.deepEqual(preset.layout.panels.map(panel => panel.id), ['price', 'volume', 'notes']);
    assert.deepEqual(preset.layout.axes.map(axis => axis.id), ['notes-axis']);
    const roundtrip = parseDemoLayout(stringifyDemoLayout(preset));
    assert.deepEqual(roundtrip.managed, {panels: [], axes: []});
    assert.deepEqual(roundtrip.layout.panels.map(panel => panel.id), ['price', 'volume', 'notes']);
  } finally { model.dispose(); }
});

test('bound generated resources round trip their managed ownership', () => {
  const {model} = baseModel({panels: [{id: 'generated', weight: 1}], axes: [{id: 'generated-axis', panel: 'generated'}]});
  try {
    model.indicators.add('extra', 'ema');
    model.addSeries({id: 'extra-line', type: 'line', panel: 'generated', axisId: 'generated-axis', indicator: 'extra'});
    const preset = captureDemoLayout(model, {market: 'us', count: 10000, light: false, generatedPanelIds: new Set(['generated']), generatedAxisIds: new Set(['generated-axis'])});
    assert.deepEqual(preset.managed, {panels: ['generated'], axes: ['generated-axis']});
    const roundtrip = parseDemoLayout(stringifyDemoLayout(preset));
    assert.deepEqual(roundtrip.managed, preset.managed);
    assert.deepEqual(presetOptions(roundtrip).panels.map(panel => panel.id), ['price', 'volume', 'generated']);
  } finally { model.dispose(); }
});

test('preset options retain referenced current, undo and redo resources without mutating either input', () => {
  const {model} = baseModel({panels: [{id: 'old', weight: 2}], axes: [{id: 'old-axis', panel: 'old', side: 'left', range: [1, 10]}]});
  model.setPanelOrder(['price','old','volume']);
  const drawing = {id: 'old-drawing', type: 'horizontal', panel: 'old', axisId: 'old-axis', seriesId: 'old-series', points: [{time: 0, price: 5}]};
  model.drawings.items = [drawing];
  model.drawings.undoStack = [[drawing]];
  model.drawings.redoStack = [[drawing]];
  const preset = captureDemoLayout(model, {market: 'us', count: 10000, light: false});
  preset.layout.panels = preset.layout.panels.filter(panel => panel.id !== 'old');
  preset.layout.axes = [];
  preset.layout.series = preset.layout.series.filter(series => series.id !== 'old-series');
  const beforePreset = stringifyDemoLayout(preset), beforeModel = {panels: model.panels.map(panel => ({...panel})), axes: model.axes.map(axis => ({...axis}))};
  try {
    const options = presetOptions(preset, model);
    assert.deepEqual(options.panels.map(panel => panel.id), ['price', 'volume', 'old']);
    assert.equal(options.axes[0].id, 'old-axis');
    assert.equal(options.axes[0].panel, 'old');
    assert.equal(options.series.some(series => series.id === 'old-series'), false);
    assert.equal(stringifyDemoLayout(preset), beforePreset);
    assert.deepEqual(model.panels.map(panel => ({...panel})), beforeModel.panels);
    assert.deepEqual(model.axes.map(axis => ({...axis})), beforeModel.axes);
  } finally { dispose(model); }
});

test('retained resources append after a deliberately reordered preset', () => {
  const {model} = baseModel({panels: [{id: 'old', weight: 2}], axes: [{id: 'old-axis', panel: 'old'}]});
  const drawing = {id: 'old-drawing', type: 'horizontal', panel: 'old', axisId: 'old-axis', points: [{time: 0, price: 5}]};
  model.drawings.items = [drawing];
  const preset = captureDemoLayout(model, {market: 'us', count: 10000, light: false});
  preset.layout.panels = [preset.layout.panels[1], preset.layout.panels[0]];
  preset.layout.axes = [];
  try {
    const options = presetOptions(preset, model);
    assert.deepEqual(options.panels.map(panel => panel.id), ['volume', 'price', 'old']);
    assert.deepEqual(options.axes.map(axis => axis.id), ['old-axis']);
  } finally { model.dispose(); }
});

test('referenced axis conflict is rejected atomically', () => {
  const {model} = baseModel({panels: [{id: 'old', weight: 2}], axes: [{id: 'old-axis', panel: 'old'}]});
  const drawing = {id: 'old-drawing', type: 'horizontal', panel: 'old', axisId: 'old-axis', points: [{time: 0, price: 5}]};
  model.drawings.items = [drawing];
  const preset = captureDemoLayout(model, {market: 'us', count: 10000, light: false});
  preset.layout.panels = preset.layout.panels.filter(panel => panel.id !== 'old');
  preset.layout.axes = [{id: 'old-axis', panel: 'price'}];
  const beforePreset = stringifyDemoLayout(preset), beforeModel = stringifyDemoLayout(captureDemoLayout(model, {market: 'us', count: 10000, light: false}));
  try { assert.throws(() => presetOptions(preset, model), /axis|panel|conflict/i); }
  finally {
    assert.equal(stringifyDemoLayout(preset), beforePreset);
    assert.equal(stringifyDemoLayout(captureDemoLayout(model, {market: 'us', count: 10000, light: false})), beforeModel);
    dispose(model);
  }
});

test('default market precision and axis width are used without a current model', () => {
  const {model} = baseModel();
  try {
    const preset = captureDemoLayout(model, {market: 'crypto', count: 1000000, light: false});
    const options = presetOptions(preset);
    assert.equal(options.precision, 12);
    assert.equal(options.axisWidth, 125);
    assert.equal(options.theme.background, '#0c1320');
  } finally { dispose(model); }
});

test('null auto ranges remain distinct from manual ranges', () => {
  const preset = {schema: 'barochart.main-demo-layout', version: 1, market: 'us', count: 10000, light: false, layout: {
    panels: [{id: 'price', range: null}, {id: 'volume'}], axes: [],
    series: [{id: 'price', type: 'candles', panel: 'price'}, {id: 'volume', type: 'histogram', source: 'volume', panel: 'volume'}], indicators: [],
  }};
  const parsed = parseDemoLayout(stringifyDemoLayout(preset));
  assert.equal(parsed.layout.panels[0].range, null);
  assert.equal(presetOptions(parsed).panels[0].range, null);
});
