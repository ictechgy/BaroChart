import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, buildScene, seededColumns} from '../src/core/index.mjs';
import {SceneCache} from '../src/renderers/scene-cache.mjs';

function setup() {
  const store = new BarStore(); store.setColumns(seededColumns(1000));
  const model = new ChartModel({store}); model.addSeries({id: 'p', type: 'candles', panel: 'price'});
  model.indicators.add('e', 'ema'); model.addSeries({id: 'e', type: 'line', panel: 'price', indicator: 'e'});
  model.drawings.add({type: 'trendline', points: [{time: store.at(800).time, price: store.at(800).close}, {time: store.at(950).time, price: store.at(950).close}]});
  return {model, store, cache: new SceneCache()};
}
function matchesFull(frame, model, width = 1000, height = 600) {
  const full = buildScene(model, width, height);
  assert.deepEqual(frame.scene.commands, full.commands);
  assert.deepEqual(frame.scene.stats, full.stats);
  assert.equal(frame.scene.background, full.background);
  assert.equal(frame.scene.layout.geometryKey, full.layout.geometryKey);
}

test('hover and leave reuse stable data/axis/drawing commands and agree with full scene', () => {
  const {model, cache} = setup();
  try {
    const initial = cache.frame(model, 1000, 600), base = initial.base;
    for (const cursor of [{x: 200, y: 200}, {x: 450, y: 300}, null]) {
      model.crosshair = cursor; const frame = cache.frame(model, 1000, 600);
      assert.equal(frame.base, base); assert.equal(frame.baseChanged, false); assert.equal(frame.drawingsChanged, false);
      assert.equal(frame.drawings.commands, initial.drawings.commands); matchesFull(frame, model);
    }
  } finally {model.dispose();}
});

test('drawing edits, selection, undo and reload invalidate drawings while reusing data', () => {
  const {model, cache} = setup();
  try {
    const first = cache.frame(model, 1000, 600), drawing = model.drawings.items[0], saved = model.drawings.save();
    for (const mutation of [() => {model.drawings.selected = null;}, () => model.drawings.edit(drawing.id, {points: drawing.points.map(p => ({...p, price: p.price + 1}))}), () => model.drawings.undo(), () => model.drawings.load(saved)]) {
      mutation(); const frame = cache.frame(model, 1000, 600); assert.equal(frame.base, first.base); assert.equal(frame.baseChanged, false); matchesFull(frame, model);
    }
  } finally {model.dispose();}
});

test('pan, zoom, streaming, scales, direct style, dimensions and formatter invalidations cannot retain stale data', () => {
  const {model, store, cache} = setup();
  try {
    cache.frame(model, 1000, 600);
    const mutations = [() => model.pan(-30), () => model.zoom(.5), () => store.update(900, {...store.at(900), high: 300, close: 300}), () => model.setPanel('price', {inverted: true}), () => {model.theme.background = '#ffffff';}, () => {model.series[0].upColor = '#010203';}, () => {model.timeFormatter = t => 'T' + t;}];
    for (const mutation of mutations) {mutation(); const frame = cache.frame(model, 1000, 600); assert.equal(frame.baseChanged, true); matchesFull(frame, model);}
    const resized = cache.frame(model, 800, 500); assert.equal(resized.baseChanged, true); matchesFull(resized, model, 800, 500);
    const forced = cache.frame(model, 800, 500, {forceBase: true}); assert.equal(forced.baseChanged, true);
  } finally {model.dispose();}
});

test('formatter errors do not publish a new cached state and clear drops retained scene/history references', () => {
  const {model, cache} = setup();
  try {
    const prior = cache.frame(model, 1000, 600).base;
    model.priceFormatter = () => {throw Error('fixture formatter failure');};
    assert.throws(() => cache.frame(model, 1000, 600), /fixture formatter failure/); assert.equal(cache.base, prior);
    model.priceFormatter = null; matchesFull(cache.frame(model, 1000, 600), model);
    cache.clear(); assert.equal(cache.base, null); assert.equal(cache.items, null); assert.equal(cache.drawingCommands, null);
  } finally {model.dispose();}
});
