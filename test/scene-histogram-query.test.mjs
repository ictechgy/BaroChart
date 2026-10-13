import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Copy into test/ for normal npm test use. The override also permits red/green
// execution against preserved and candidate source trees without editing either.
const {BarStore, BlockRangeIndex, ChartModel, FIELDS, applyDataEvent, buildScene, seededColumns} = await import(
  process.env.ASTER_SOURCE_ROOT
    ? pathToFileURL(resolve(process.env.ASTER_SOURCE_ROOT, 'src/core/index.mjs')).href
    : '../src/core/index.mjs'
);

const COLOR = '#e43ad7', WIDTH = 397, HEIGHT = 263;
const bits = values => Buffer.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));

function valuesFor(length, pattern) {
  return Float64Array.from({length}, (_, i) => {
    if (pattern === 'empty') return NaN;
    const phase = Math.floor(i / 1024) % 5;
    if (pattern === 'mixed' && (phase === 1 || phase === 2 && i % 3 === 0 || phase === 3 && i % 1024 < 91)) return NaN;
    // Deliberately not Float32-exact, with tiny values and signed zero.
    return i % 257 === 0 ? -0 : (Math.sin(i * .071) * 3 + .123456789012345) * 1e-12;
  });
}

function fixture(length, type, pattern, offset = 0, inverted = false) {
  const store = new BarStore();
  store.setColumns(seededColumns(length));
  const model = new ChartModel({store, panels: [{id: 'price', weight: 1, padding: 0}],
    axes: [{id: 'values', panel: 'price', side: 'left', width: 47, padding: 0, inverted}]});
  model.addSeries({id: 'subject', type, panel: 'price', axisId: 'values', color: COLOR,
    width: 1.75, baseline: -1.23456789012345e-13, offset, values: valuesFor(length, pattern)});
  model.fit();
  return model;
}

function bucketInfo(model, series, scene, values) {
  const panel = scene.layout.panels.find(p => p.id === series.panel);
  const from = Math.min(model.store.length, Math.max(0, Math.floor(model.view.from - series.offset)));
  const to = Math.max(from, Math.min(model.store.length, Math.ceil(model.view.to + 1 - series.offset)));
  const count = Math.min(to - from, Math.max(1, Math.floor(panel.right - panel.left)));
  const buckets = [];
  for (let k = 0; k < count; k++) {
    const a = from + Math.floor(k * (to - from) / count);
    const b = from + Math.floor((k + 1) * (to - from) / count), end = Math.min(b, values.length);
    let finite = 0, min = Infinity, max = -Infinity;
    for (let i = a; i < end; i++) if (Number.isFinite(values[i])) {
      finite++; min = Math.min(min, values[i]); max = Math.max(max, values[i]);
    }
    buckets.push({a, b, end, finite, min, max});
  }
  return {from, to, count, panel, buckets};
}

// Scan-only oracle: no range-index method supplies values or extrema. Matching
// uses strict equality (Object.is for numeric leaves), not rounded snapshots.
function expectedSeriesCommands(model, series, scene, values, info) {
  const {panel, count, buckets} = info, axis = scene.layout.axis(series.panel, series.axisId);
  const clip = [panel.left, panel.top, panel.right - panel.left, panel.bottom - panel.top];
  const rects = [], coords = [], paths = [];
  let path = [];
  const flush = () => {
    if (path.length === 2) coords.push(path[0] - .25, path[1], path[0] + .25, path[1]);
    else if (path.length) paths.push(path);
    path = [];
  };
  const rect = (x, value, width) => {
    const baseline = axis.y(series.baseline ?? 0), y = axis.y(value);
    rects.push(x - width / 2, Math.min(baseline, y), width, Math.max(1, Math.abs(baseline - y)));
  };
  for (const {a, b, end, finite, min, max} of buckets) {
    if (!finite) { flush(); continue; }
    if (finite !== end - a) {
      const width = Math.max(1, Math.abs(scene.layout.x(a + 1) - scene.layout.x(a)) * .8);
      for (let i = a; i < end; i++) {
        if (!Number.isFinite(values[i])) { flush(); continue; }
        const x = scene.layout.x(i + series.offset);
        if (series.type === 'histogram') rect(x, values[i], width);
        else path.push(x, axis.y(values[i]));
      }
    } else {
      const x = scene.layout.x((a + b - 1) / 2 + series.offset), last = values[end - 1];
      if (series.type === 'histogram') rect(x, last, Math.max(1, (panel.right - panel.left) / count * .8));
      else {
        path.push(x, axis.y(last));
        if (b - a > 1 && max !== min) coords.push(x, axis.y(min), x, axis.y(max));
      }
    }
  }
  flush();
  const commands = [];
  if (rects.length) commands.push({op: 'rects', coords: rects, color: series.color, clip});
  for (const points of paths) commands.push({op: 'path', points, color: series.color, width: series.width,
    fill: series.type === 'area' ? series.fill ?? '#7898ff22' : null,
    baseline: series.type === 'area' ? axis.y(series.baseline ?? 0) : undefined, clip});
  if (coords.length) commands.push({op: 'lines', coords, color: series.color, width: series.width, clip, dash: null});
  return commands;
}

function checkScene(model, {width = WIDTH, expectedPolicy = model.store.length >= 65536} = {}) {
  const series = model.series[0], {values, index} = model.seriesData(series);
  assert.ok(values instanceof Float64Array);
  assert.equal(index instanceof BlockRangeIndex, expectedPolicy);
  const sourceBits = bits(values), columns = Object.fromEntries(FIELDS.map(k => [k, model.store.columns[k]]));
  const columnBits = Object.fromEntries(FIELDS.map(k => [k, bits(columns[k])]));
  const version = model.store.version, view = {...model.view}, calls = [], query = index.query;
  index.query = function (from, to) { calls.push([from, to]); return query.call(this, from, to); };
  let scene;
  try { scene = buildScene(model, width, HEIGHT, {crosshair: false, drawings: false}); }
  finally { delete index.query; }
  const info = bucketInfo(model, series, scene, values);
  const expectedCalls = [[info.from, info.to]];
  if (series.type !== 'histogram') for (const b of info.buckets)
    if (b.finite && b.finite === b.end - b.a) expectedCalls.push([b.a, b.end]);
  assert.deepEqual(calls, expectedCalls, series.type === 'histogram'
    ? 'histogram must retain only its autoscale extrema query'
    : 'line/area must retain every finite-bucket extrema query');
  assert.deepEqual(scene.commands.filter(c => c.color === COLOR),
    expectedSeriesCommands(model, series, scene, values, info), 'scan-oracle coordinates must remain bit-exact');
  assert.equal(model.seriesData(series).index, index, 'render must reuse the warmed range index');
  assert.equal(model.seriesData(series).values.buffer, values.buffer);
  assert.deepEqual(bits(values), sourceBits, 'all Float64 bits, including NaN and signed zero, must be unchanged');
  for (const key of FIELDS) {
    assert.equal(model.store.columns[key], columns[key]);
    assert.deepEqual(bits(columns[key]), columnBits[key], key + ' source column must be unchanged');
  }
  assert.equal(model.store.version, version);
  assert.deepEqual(model.view, view);
  assert.equal(scene.stats.storedBars, model.store.length);
  assert.equal(scene.stats.commandCount, scene.commands.length);
  const axis = scene.layout.axis(series.panel, series.axisId);
  for (let i = info.from; i < info.to; i++) if (Number.isFinite(values[i])) {
    assert.ok(axis.min <= values[i] && axis.max >= values[i], 'autoscale must include the complete source envelope');
  }
  if (series.type === 'histogram' || series.type === 'area')
    assert.ok(axis.min <= series.baseline && axis.max >= series.baseline, 'autoscale must include baseline');
  return {scene, info};
}

for (const length of [65535, 65536, 65537]) {
  for (const [pattern, offset, inverted] of [['finite', 0, false], ['mixed', 17, true], ['empty', -13, true]]) {
    test(`histogram uses only autoscale query at ${length}, ${pattern}, offset ${offset}`, () => {
      const model = fixture(length, 'histogram', pattern, offset, inverted);
      try {
        const {scene, info} = checkScene(model);
        if (pattern === 'empty') assert.equal(scene.commands.filter(c => c.color === COLOR).length, 0);
        else assert.ok(info.buckets.some(b => b.finite === b.end - b.a && b.finite > 1));
        if (pattern === 'mixed') {
          assert.ok(info.buckets.some(b => b.finite > 0 && b.finite < b.end - b.a));
          assert.ok(info.buckets.some(b => b.finite === 0));
        }
      } finally { model.dispose(); }
    });
  }
  for (const type of ['line', 'area']) for (const pattern of ['finite', 'mixed']) {
    test(`${type} keeps exact dense extrema at ${length}, ${pattern}`, () => {
      const model = fixture(length, type, pattern, pattern === 'mixed' ? -11 : 7, true);
      try {
        const {scene, info} = checkScene(model);
        assert.ok(info.buckets.some(b => b.finite === b.end - b.a && b.max > b.min));
        assert.ok(scene.commands.some(c => c.color === COLOR && c.op === 'lines'));
      } finally { model.dispose(); }
    });
  }
}

test('histogram singleton buckets preserve the last sample, offset and inverted nonzero baseline', () => {
  const model = fixture(29, 'histogram', 'finite', -3, true);
  try {
    model.setSeriesValues('subject', Float64Array.from({length: 29}, (_, i) => i % 4 === 0 ? NaN : (i - 14) * 1e-13));
    const {info} = checkScene(model);
    assert.ok(info.buckets.every(b => b.end - b.a === 1));
  } finally { model.dispose(); }
});

test('source histogram stays query-light across current update, correction, threshold append, prepend and reset', () => {
  const model = fixture(65535, 'histogram', 'finite', 0, false);
  model.removeSeries('subject');
  model.addSeries({id: 'subject', type: 'histogram', panel: 'price', axisId: 'values', color: COLOR,
    width: 1.75, baseline: -1.23456789012345e-13, source: 'close'});
  try {
    checkScene(model);
    const last = model.store.at(model.store.length - 1);
    applyDataEvent(model.store, {kind: 'update', bar: {...last, close: last.high}});
    checkScene(model);
    const old = model.store.at(31);
    applyDataEvent(model.store, {kind: 'correction', bar: {...old, low: old.low - .123456789012345}});
    checkScene(model);
    applyDataEvent(model.store, {kind: 'append', bar: {...model.store.at(65534), time: last.time + 60000}});
    checkScene(model, {expectedPolicy: true});
    const first = model.store.at(0);
    applyDataEvent(model.store, {kind: 'prepend', bars: [{...first, time: first.time - 60000}]});
    checkScene(model, {expectedPolicy: true});
    applyDataEvent(model.store, {kind: 'reset', columns: seededColumns(65535, 71)});
    checkScene(model, {expectedPolicy: false});
  } finally { model.dispose(); }
});
