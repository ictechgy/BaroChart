import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, buildScene} from '../src/core/index.mjs';

function modelWithVolumes(inverted = false) {
  const bars = [10, 30, 20, 40].map((volume, i) => ({time: 1700000000000 + i * 60000, open: 100, high: 110, low: 90, close: 105, volume}));
  const model = new ChartModel({store: new BarStore(bars), panels: [{id: 'price', range: [0, 50], padding: 0, inverted}]});
  model.addSeries({id: 'v', type: 'histogram', panel: 'price', source: 'volume', color: '#012345'});
  return model;
}

test('volume histogram retains real positive height under inverted price coordinates', () => {
  const model = modelWithVolumes(true);
  try {
    const scene = buildScene(model, 1000, 400), p = scene.layout.panels[0];
    const bars = scene.commands.find(c => c.op === 'rects' && c.color === '#012345').coords;
    for (let i = 0; i < 4; i++) {
      const expectedY = Math.min(p.y(0), p.y([10, 30, 20, 40][i]));
      const expectedHeight = Math.abs(p.y(0) - p.y([10, 30, 20, 40][i]));
      assert.equal(bars[i * 4 + 1], expectedY);
      assert.equal(bars[i * 4 + 3], expectedHeight);
    }
  } finally {model.dispose();}
});

test('volume histogram explicit baseline and plot offset agree with individually anchored values', () => {
  const model = modelWithVolumes();
  try {
    model.series[0].baseline = 15; model.series[0].offset = 1;
    const scene = buildScene(model, 1000, 400), p = scene.layout.panels[0];
    const coords = scene.commands.find(c => c.op === 'rects' && c.color === '#012345').coords;
    assert.equal(coords[1], Math.min(p.y(15), p.y(10)));
    assert.equal(coords[3], Math.abs(p.y(15) - p.y(10)));
    const center = coords[0] + coords[2] / 2;
    assert.equal(center, scene.layout.x(1));
  } finally {model.dispose();}
});

test('percent crosshair labels use the same units as ticks, including inverted scales', () => {
  for (const inverted of [false, true]) {
    const model = new ChartModel({store: new BarStore([{time: 1, open: 100, high: 120, low: 80, close: 110, volume: 1}]), panels: [{id: 'price', scale: 'percent', base: 100, range: [80, 120], padding: 0, inverted}]});
    try {
      model.addSeries({id: 'p', type: 'candles', panel: 'price'});
      let scene = buildScene(model, 1000, 400), p = scene.layout.panels[0];
      model.crosshair = {x: scene.layout.x(0), y: p.y(110)};
      scene = buildScene(model, 1000, 400);
      assert.equal(scene.commands.filter(c => c.op === 'text' && c.color === model.theme.crosshair).at(-1).text, '10.00%');
    } finally {model.dispose();}
  }
});

test('narrow LOD never connects a line across interior missing timestamp values', () => {
  const bars = Array.from({length: 1000}, (_, i) => ({time: 1700000000000 + i * 60000, open: 100, high: 110, low: 90, close: 100, volume: 1}));
  const model = new ChartModel({store: new BarStore(bars)}), values = new Float64Array(1000).fill(100);
  values.fill(NaN, 4, 8); model.addSeries({id: 'foreign', type: 'line', panel: 'price', values, color: '#13579b'}); model.fit();
  try {
    for (const width of [300, 1600]) {
      const scene = buildScene(model, width, 400), paths = scene.commands.filter(c => c.op === 'path' && c.color === '#13579b');
      const markers=scene.commands.filter(c=>c.color==='#13579b'&&c.op==='lines').flatMap(c=>Array.from({length:c.coords.length/4},(_,i)=>c.coords.slice(i*4,i*4+4))).filter(c=>Math.abs(c[2]-c[0])>0&&Math.abs(c[2]-c[0])<=.5+1e-10&&c[1]===c[3]);
      assert.equal(paths.length+markers.length,2,'missing run remains separate paths or isolated glyphs at either zoom');
      const left = scene.layout.x(4), right = scene.layout.x(7);
      assert.ok(paths.every(c => !(c.points[0] < left && c.points[c.points.length - 2] > right)));
    }
  } finally {model.dispose();}
});
