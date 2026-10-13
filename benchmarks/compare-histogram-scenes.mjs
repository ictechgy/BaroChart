import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// Run serially, outside benchmark samples. No timings from this correctness
// harness should be presented as performance measurements.
assert.ok(process.argv[2], 'Pass BASELINE_ROOT and optional CANDIDATE_ROOT');
const baselineRoot = resolve(process.argv[2]);
const candidateRoot = resolve(process.argv[3] ?? '.');
const baseline = await import(pathToFileURL(resolve(baselineRoot, 'src/core/index.mjs')).href);
const candidate = await import(pathToFileURL(resolve(candidateRoot, 'src/core/index.mjs')).href);
const counters = {scenes: 0, commands: 0, numericLeaves: 0, sourceSnapshots: 0};

function exact(actual, expected, path = 'result') {
  if (typeof actual === 'number' || typeof expected === 'number') {
    counters.numericLeaves++;
    assert.ok(Object.is(actual, expected), `${path}: ${String(actual)} differs from ${String(expected)}`);
  } else if (Array.isArray(actual) || Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && Array.isArray(expected), path + ' array type');
    assert.equal(actual.length, expected.length, path + ' array length');
    for (let i = 0; i < actual.length; i++) exact(actual[i], expected[i], path + '[' + i + ']');
  } else if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    assert.deepEqual(keys, Object.keys(expected), path + ' object keys');
    for (const key of keys) exact(actual[key], expected[key], path + '.' + key);
  } else assert.ok(Object.is(actual, expected), path + ': primitive mismatch');
}

function externalValues(length, pattern, phase = 0) {
  return Float64Array.from({length}, (_, i) => {
    if (pattern === 'empty') return NaN;
    const section = Math.floor((i + phase) / 1024) % 5;
    if (pattern === 'mixed' && (section === 1 || section === 2 && i % 3 === 0 || section === 3 && i % 1024 < 91)) return NaN;
    return i % 257 === 0 ? -0 : (Math.cos((i + phase) * .031) * 4 + .123456789012345) * 1e-12;
  });
}

function fixture(api, length, pattern) {
  const store = new api.BarStore(); store.setColumns(api.seededColumns(length, 82));
  const model = new api.ChartModel({store, panels: [
    {id: 'price', weight: 3, padding: 0, scale: length === 65536 ? 'log' : 'linear'},
    {id: 'studies', weight: 2, padding: 0, inverted: true},
  ], axes: [{id: 'tiny', panel: 'studies', side: 'left', width: 49, padding: .05,
    inverted: length !== 65535, scale: length === 65537 ? 'percent' : 'linear', base: 1e-12, precision: 12}]});
  model.addSeries({id: 'candles', type: 'candles', panel: 'price'});
  model.addSeries({id: 'source-histogram', type: 'histogram', panel: 'price', source: 'close', baseline: 100, offset: 5});
  model.indicators.add('ema-study', 'ema', {period: 13});
  model.addSeries({id: 'indicator-histogram', type: 'histogram', panel: 'studies', indicator: 'ema-study', baseline: 101, offset: -7});
  for (const [type, offset, color] of [['histogram', 17, '#ea307c'], ['line', -11, '#15b5dc'], ['area', 0, '#b574e5']])
    model.addSeries({id: 'external-' + type, type, panel: 'studies', axisId: 'tiny', offset, color,
      baseline: -1.23456789012345e-13, values: externalValues(length, pattern)});
  model.crosshair = {x: 203.125, y: 103.75};
  model.fit();
  return model;
}

function sourceDigest(api, model) {
  const hash = createHash('sha256');
  for (const field of api.FIELDS) {
    const values = model.store.columns[field];
    assert.ok(values instanceof Float64Array);
    hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  for (const series of model.series) if (!['candles', 'ohlc'].includes(series.type)) {
    const values = model.seriesData(series).values;
    assert.ok(values instanceof Float64Array);
    hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  return hash.digest('hex');
}

function layoutData(value, key = '') {
  // geometryIdentity is a per-process owner identity, not projected geometry.
  // Compare every other key entry, including timeVersion, without rounding.
  if (key === 'geometryKey') {
    const parts = JSON.parse(value); parts[4] = '<owner-identity>'; return parts;
  }
  if (Array.isArray(value)) return value.map(v => layoutData(v));
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, layoutData(v, k)]));
  return value;
}

function projectionSamples(model, layout) {
  const indices = [-.5, 0, 31.5, model.store.length / 2, model.store.length - .5];
  return {
    x: indices.map(i => [layout.x(i), layout.index(layout.x(i))]),
    axes: layout.panels.flatMap(panel => panel.axes.map(axis => {
      const values = [axis.min, (axis.min + axis.max) / 2, axis.max];
      return values.map(price => {
        const point = {time: model.store.timeAtIndex(model.store.length / 2 + .125), price};
        const screen = layout.toScreen(point, panel.id, axis.axisId);
        return {y: axis.y(price), inverse: axis.price(axis.y(price)), transformed: axis.transform(price),
          screen, back: layout.fromScreen(screen.x, screen.y, panel.id, axis.axisId)};
      });
    })),
  };
}

function compare(models, name, width, height) {
  const before = [sourceDigest(baseline, models[0]), sourceDigest(candidate, models[1])];
  assert.equal(before[0], before[1], name + ' input bytes');
  const scenes = [baseline.buildScene(models[0], width, height), candidate.buildScene(models[1], width, height)];
  exact(scenes[1].commands, scenes[0].commands, name + '.commands');
  exact(scenes[1].stats, scenes[0].stats, name + '.stats');
  exact(layoutData(scenes[1].layout), layoutData(scenes[0].layout), name + '.layout');
  exact(projectionSamples(models[1], scenes[1].layout), projectionSamples(models[0], scenes[0].layout), name + '.projections');
  exact([scenes[1].width, scenes[1].height, scenes[1].background],
    [scenes[0].width, scenes[0].height, scenes[0].background], name + '.frame');
  assert.equal(sourceDigest(baseline, models[0]), before[0], name + ' baseline source immutability');
  assert.equal(sourceDigest(candidate, models[1]), before[1], name + ' candidate source immutability');
  counters.scenes++; counters.commands += scenes[0].commands.length; counters.sourceSnapshots += 4;
}

function mutate(api, model, stage, pattern) {
  const last = model.store.at(model.store.length - 1);
  if (stage === 'current-update') api.applyDataEvent(model.store, {kind: 'update', bar: {...last, close: last.high}});
  else if (stage === 'historical-correction') {
    const bar = model.store.at(31);
    api.applyDataEvent(model.store, {kind: 'correction', bar: {...bar, close: bar.low, high: bar.high + .123456789012345}});
    for (const s of model.series.filter(s => s.values)) {
      const values = s.values.slice(); values[32] = pattern === 'empty' ? NaN : 2.3456789012345e-12;
      model.setSeriesValues(s.id, values);
    }
  } else if (stage === 'append-threshold') {
    api.applyDataEvent(model.store, {kind: 'append', bar: {...last, time: last.time + 60000}});
    for (const s of model.series.filter(s => s.values)) {
      const values = new Float64Array(model.store.length); values.set(s.values);
      values[values.length - 1] = pattern === 'empty' ? NaN : -1.87654321098765e-12;
      model.setSeriesValues(s.id, values);
    }
  } else if (stage === 'prepend') {
    const first = model.store.at(0);
    api.applyDataEvent(model.store, {kind: 'prepend', bars: [{...first, time: first.time - 60000}]});
    for (const s of model.series.filter(s => s.values)) {
      const values = new Float64Array(model.store.length); values.set(s.values, 1);
      values[0] = pattern === 'empty' ? NaN : 1.87654321098765e-12;
      model.setSeriesValues(s.id, values);
    }
  } else if (stage === 'reset-below-threshold') {
    api.applyDataEvent(model.store, {kind: 'reset', columns: api.seededColumns(65535, 73)});
    for (const s of model.series.filter(s => s.values)) model.setSeriesValues(s.id, externalValues(model.store.length, pattern, 31));
  } else if (stage === 'recent-zoom') model.setVisibleRange(model.store.length - 250.25, model.store.length - .5);
}

const stages = ['initial', 'current-update', 'historical-correction', 'append-threshold', 'prepend', 'reset-below-threshold', 'recent-zoom'];
for (const length of [65535, 65536, 65537]) for (const pattern of ['finite', 'mixed', 'empty']) {
  const models = [fixture(baseline, length, pattern), fixture(candidate, length, pattern)];
  try {
    for (const stage of stages) {
      mutate(baseline, models[0], stage, pattern); mutate(candidate, models[1], stage, pattern);
      compare(models, `${length}/${pattern}/${stage}`, stage === 'recent-zoom' ? 1200 : 431, stage === 'recent-zoom' ? 700 : 407);
    }
    console.log(`PASS ${length}/${pattern}: ${stages.length} exact scene comparisons`);
  } finally { for (const model of models) model.dispose(); }
}
console.log(JSON.stringify({status: 'PASS', baselineRoot, candidateRoot, ...counters,
  equality: 'Object.is numeric leaves; complete commands/stats and non-function layout fields; sampled projection functions',
  normalizedField: 'layout.geometryKey[4] per-process owner identity only',
  measurement: 'Correctness only. No benchmark, renderer, native execution or physical display claim.'}, null, 2));
