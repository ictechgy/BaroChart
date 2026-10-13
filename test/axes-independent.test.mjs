import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, ChartAPI, createLayout, buildScene, alignSeriesByTime,
  InteractionController, drawingGeometry, drawingHitTest} from '../src/core/index.mjs';
import {SceneCache} from '../src/core/frame-cache.mjs';
import {formatAxisValue, createCrosshairCommands} from '../src/core/scene-parts.mjs';

const T = 1700000000000, W = 800, H = 500;
const foreign = [1000, 1250, NaN, 1750, 2000, NaN, 2500, NaN, 3000, NaN, NaN, 3750];
// Expected geometry uses literal fixture dimensions/ranges, never the chart's
// mapping functions. One left 64px strip and the primary right 82px strip.
const xAt = index => 76 + (index + .5) / 12 * 642;
const yB = value => 12 + (5000 - value) / 4000 * 454;
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
function fixture() {
  const bars = Array.from({length: 12}, (_, index) => ({time: T + index * 60000,
    open: 110 + index, high: 140 + index, low: 100 + index, close: 120 + index, volume: 50 + index}));
  const model = new ChartModel({store: new BarStore(bars), visibleBars: 12,
    panels: [{id: 'price', range: [100, 200], padding: 0, precision: 2}],
    axes: [{id: 'B', panel: 'price', side: 'left', width: 64, range: [1000, 5000], padding: 0,
      precision: 3, prefix: 'B:', suffix: ' units'}]});
  const controller = new InteractionController(model, () => ({width: W, height: H}));
  const api = new ChartAPI(model, {controller});
  api.setSymbol({id: 'PRIMARY-A', exchange: 'TEST', timezone: 'UTC', currency: 'USD', volumeUnit: 'shares',
    priceDecimals: 2, tickSize: .01, adjustment: 'raw'});
  api.addSeries({id: 'A-candle', type: 'candles', panel: 'price', upColor: '#009900', downColor: '#990000'});
  api.addSeries({id: 'B-line', type: 'line', panel: 'price', axisId: 'B', symbolId: 'FOREIGN-B', label: 'B actual',
    values: new Float64Array(foreign), color: '#0000ff'});
  return {bars, model, controller, api};
}
function assertFiniteCoordinates(scene) {
  for (const command of scene.commands) {
    for (const number of [...(command.coords ?? []), ...(command.points ?? []), ...(command.clip ?? [])]) assert.ok(Number.isFinite(number));
    for (const name of ['x', 'y', 'w', 'h']) if (name in command) assert.ok(Number.isFinite(command[name]));
  }
}
function renderOrDomainError(run) {
  try {assertFiniteCoordinates(run());} catch (error) {if (!(error instanceof RangeError)) throw error;}
}

test('independent axes map literal prices, strips and inverse time independently', () => {
  const {model} = fixture();
  try {
    const layout = createLayout(model, W, H), primary = layout.axis('price'), b = layout.axis('price', 'B');
    assert.deepEqual([primary.left, primary.right, primary.top, primary.bottom], [76, 718, 12, 466]);
    near(primary.y(125), 352.5); near(b.y(3000), 239); near(b.y(1750), 380.875);
    near(b.price(239), 3000); near(layout.x(2), 209.75);
    assert.deepEqual(layout.fromScreen(209.75, 239, 'price', 'B'), {time: T + 120000, price: 3000});
    assert.deepEqual([b.axisLeft, b.axisRight], [12, 76]);
  } finally {model.dispose();}
});

test('left/right/hidden axes preserve price units and reclaim their label strips', () => {
  const {model, api} = fixture();
  try {
    api.addAxis({id: 'C', panel: 'price', side: 'right', width: 96, range: [1, 100], padding: 0, precision: 1, tickFormat: 'scientific', prefix: 'C:'});
    let layout = createLayout(model, W, H);
    assert.deepEqual([layout.panels[0].left, layout.panels[0].right], [76, 622]);
    assert.equal(formatAxisValue(model, layout.axis('price', 'C'), 12.5), 'C:1.3e+1');
    api.setAxis('B', {visible: false}); layout = createLayout(model, W, H);
    assert.equal(layout.panels[0].left, 12); near(layout.axis('price', 'B').y(3000), 239);
    const scene = buildScene(model, W, H);
    assert.ok(!scene.commands.some(command => command.op === 'text' && command.text.startsWith('B:')));
    assertFiniteCoordinates(scene);
  } finally {model.dispose();}
});

test('log and inverted percent axes use independently calculated domains and labels', () => {
  const {model, api} = fixture();
  try {
    api.setAxis('B', {scale: 'log', range: [100, 10000], prefix: '', suffix: ''});
    let b = createLayout(model, W, H).axis('price', 'B');
    near(b.y(1000), 239); near(b.price(239), 1000);
    api.setAxis('B', {scale: 'percent', range: [1000, 5000], base: 2000, inverted: true, precision: 1});
    b = createLayout(model, W, H).axis('price', 'B');
    near(b.y(1000), 12); near(b.y(5000), 466); near(b.price(239), 3000);
    assert.equal(formatAxisValue(model, b, 3000), '50.0%');
    assert.equal(formatAxisValue(model, b, 1000), '-50.0%');
  } finally {model.dispose();}
});

test('exact timestamp gaps and offset crosshairs never substitute foreign values for primary OHLCV', () => {
  const {model, api, bars} = fixture();
  try {
    const joined = alignSeriesByTime(bars.map(bar => bar.time), [{time: T, value: 1000}, {time: T + 60000, value: 1250},
      {time: T + 90000, value: 999999}, {time: T + 180000, value: 1750}, {time: T + 240000, value: 2000},
      {time: T + 360000, value: 2500}, {time: T + 480000, value: 3000}, {time: T + 660000, value: 3750}]);
    assert.deepEqual(joined, new Float64Array(foreign));
    api.setSeriesValues('B-line', joined);
    model.crosshair = {x: xAt(2), y: 239}; let result = api.crosshairValues(W, H);
    assert.equal(result.index, 2); assert.equal(result.time, T + 120000);
    assert.deepEqual(result.primary, {symbolId: 'PRIMARY-A', bar: {time: T + 120000, open: 112, high: 142, low: 102, close: 122, volume: 52}});
    assert.deepEqual(result.series.find(series => series.id === 'B-line'), {id: 'B-line', label: 'B actual', symbolId: 'FOREIGN-B', panel: 'price', axisId: 'B', value: null, sourceIndex: 2, sourceTime: null});
    assert.equal(result.axes.find(axis => axis.id === 'B').formatted, 'B:3000.000 units');
    model.crosshair.x = xAt(3); result = api.crosshairValues(W, H);
    assert.equal(result.series.find(series => series.id === 'B-line').value, 1750);
    assert.equal(result.primary.bar.close, 123);
    api.setSeries('B-line', {offset: 2}); model.crosshair.x = xAt(3); result = api.crosshairValues(W, H);
    assert.deepEqual([result.series[1].value, result.series[1].sourceIndex, result.series[1].sourceTime], [1250, 1, T + 60000]);
    assert.equal(result.primary.bar.close, 123);
  } finally {model.dispose();}
});

test('foreign NaN gaps split visible paths and candles retain literal primary geometry', () => {
  const {model} = fixture();
  try {
    const scene = buildScene(model, W, H), paths = scene.commands.filter(command => command.op === 'path' && command.color === '#0000ffff');
    assert.equal(paths.length, 2);
    [xAt(0), yB(1000), xAt(1), yB(1250)].forEach((value, index) => near(paths[0].points[index], value));
    [xAt(3), yB(1750), xAt(4), yB(2000)].forEach((value, index) => near(paths[1].points[index], value));
    const wick = scene.commands.find(command => command.op === 'lines' && command.color === '#009900ff');
    near(wick.coords[1], 284.4); near(wick.coords[3], 466);
    assertFiniteCoordinates(scene);
  } finally {model.dispose();}
});

test('orphan drawings hide on series removal/rebinding and reconnect only to their original axis', () => {
  const {model, api} = fixture();
  try {
    const id = api.addDrawing({type: 'horizontal', seriesId: 'B-line', points: [{time: T + 120000, price: 3000}]});
    let drawing = model.drawings.items[0]; assert.equal(drawing.axisId, 'B');
    near(drawingGeometry(drawing, createLayout(model, W, H))[0].coords[1], 239);
    api.removeSeries('B-line'); assert.deepEqual(drawingGeometry(drawing, createLayout(model, W, H)), []);
    assert.equal(drawingHitTest(model.drawings, createLayout(model, W, H), 300, 239), null);
    api.addSeries({id: 'B-line', panel: 'price', type: 'line', axisId: null, symbolId: 'FOREIGN-B', values: new Float64Array(foreign)});
    assert.deepEqual(drawingGeometry(drawing, createLayout(model, W, H)), []);
    api.setSeries('B-line', {axisId: 'B'}); near(drawingGeometry(drawing, createLayout(model, W, H))[0].coords[1], 239);
    api.setSeries('B-line', {visible: false}); assert.deepEqual(drawingGeometry(drawing, createLayout(model, W, H)), []);
    api.setSeries('B-line', {visible: true}); api.selectDrawing(id);
    assert.equal(drawingHitTest(model.drawings, createLayout(model, W, H), 300, 239).id, id);
    api.deleteDrawing(id); assert.throws(() => api.removeAxis('B'), /referenced|history/);
  } finally {model.dispose();}
});

test('v1 legacy and v2 bound documents load atomically including history and selection', () => {
  const {model, api} = fixture();
  try {
    api.loadDrawings(JSON.stringify({schema: 'aster.drawings', version: 1, drawings: [{id: 'legacy', type: 'horizontal', panel: 'price', points: [{time: T, price: 125}]}]}));
    assert.equal(JSON.parse(api.saveDrawings()).version, 1);
    near(drawingGeometry(model.drawings.items[0], createLayout(model, W, H))[0].coords[1], 352.5);
    api.addDrawing({id: 'bound', type: 'horizontal', seriesId: 'B-line', points: [{time: T, price: 3000}]});
    const valid = api.saveDrawings(); assert.equal(JSON.parse(valid).version, 2);
    const selected = model.drawings.selected, undo = model.drawings.undoStack.length, redo = model.drawings.redoStack.length;
    for (const change of [doc => {doc.drawings[1].seriesId = 'missing';}, doc => {doc.drawings[1].axisId = 'missing';},
      doc => {doc.drawings[1].panel = 'missing';}, doc => {doc.version = 1;}, doc => {doc.drawings[1].id = 'legacy';}]) {
      const invalid = JSON.parse(valid); change(invalid); assert.throws(() => api.loadDrawings(JSON.stringify(invalid)));
      assert.equal(api.saveDrawings(), valid); assert.equal(model.drawings.selected, selected);
      assert.equal(model.drawings.undoStack.length, undo); assert.equal(model.drawings.redoStack.length, redo);
    }
    api.loadDrawings(valid); assert.equal(api.saveDrawings(), valid);
  } finally {model.dispose();}
});

test('controller creation, selection, keyboard editing and undo/redo preserve foreign price units', () => {
  const {model, api, controller} = fixture();
  try {
    api.setDrawingTarget({seriesId: 'B-line'}); controller.setTool('trendline');
    controller.down(1, xAt(2), yB(2000)); controller.move(1, xAt(4), yB(3000)); controller.up(1);
    const original = model.drawings.items[0]; assert.equal(original.axisId, 'B'); assert.equal(original.seriesId, 'B-line');
    near(original.points[0].price, 2000); near(original.points[1].price, 3000);
    assert.equal(original.points[0].time, T + 120000); assert.equal(original.points[1].time, T + 240000);
    controller.setTool('select'); controller.down(2, xAt(2), yB(2000)); controller.move(2, xAt(2), yB(2500)); controller.up(2);
    near(model.drawings.items[0].points[0].price, 2500); near(model.drawings.items[0].points[1].price, 3000);
    api.undo(); near(model.drawings.items[0].points[0].price, 2000); api.redo(); near(model.drawings.items[0].points[0].price, 2500);
    api.selectDrawing(original.id); controller.key('ArrowUp'); near(model.drawings.items[0].points[0].price, 2500 + 4000 / 454);
    api.undo(); near(model.drawings.items[0].points[0].price, 2500); api.redo(); near(model.drawings.items[0].points[0].price, 2500 + 4000 / 454);
  } finally {model.dispose();}
});

test('public series rebinding updates future drawing target while old drawing remains orphaned', () => {
  const {model, api, controller} = fixture();
  try {
    const old = api.addDrawing({type: 'horizontal', seriesId: 'B-line', points: [{time: T, price: 3000}]});
    api.addAxis({id: 'C', panel: 'price', range: [10, 50], padding: 0});
    api.setDrawingTarget({seriesId: 'B-line'}); api.setSeries('B-line', {axisId: 'C'});
    assert.equal(controller.drawingTarget.axisId, 'C');
    assert.deepEqual(drawingGeometry(model.drawings.items.find(d => d.id === old), createLayout(model, W, H)), []);
    controller.setTool('horizontal'); controller.down(1, 200, 239); controller.up(1);
    assert.equal(model.drawings.items.at(-1).axisId, 'C'); near(model.drawings.items.at(-1).points[0].price, 30);
    api.removeSeries('B-line'); assert.equal(controller.drawingTarget, null);
  } finally {model.dispose();}
});

test('successful empty-axis removal clears its target and rejected referenced-axis removal preserves it', () => {
  const {model, api, controller} = fixture();
  try {
    api.setDrawingTarget({seriesId: 'B-line'}); const target = {...controller.drawingTarget};
    assert.throws(() => api.removeAxis('B'), /referenced/); assert.deepEqual(controller.drawingTarget, target);
    api.addAxis({id: 'empty', panel: 'price', range: [10, 50], padding: 0});
    api.setDrawingTarget({axisId: 'empty'}); api.removeAxis('empty'); assert.equal(controller.drawingTarget, null);
    controller.setTool('horizontal'); controller.down(1, 200, 239); controller.up(1);
    assert.equal(model.drawings.items.at(-1).axisId ?? null, null); near(model.drawings.items.at(-1).points[0].price, 150);
  } finally {model.dispose();}
});

test('indicator removal clears the target of its removed series and keeps bound drawings orphaned', () => {
  const {model, api, controller} = fixture();
  try {
    api.addIndicator('ema-target', 'ema', {period: 2});
    api.addSeries({id: 'ema-line', panel: 'price', type: 'line', indicator: 'ema-target', axisId: 'B'});
    api.setDrawingTarget({seriesId: 'ema-line'});
    const id = api.addDrawing({type: 'horizontal', seriesId: 'ema-line', points: [{time: T + 120000, price: 3000}]});
    api.removeIndicator('ema-target'); assert.equal(controller.drawingTarget, null);
    assert.deepEqual(drawingGeometry(model.drawings.items.find(drawing => drawing.id === id), createLayout(model, W, H)), []);
    assert.ok(!model.series.some(series => series.id === 'ema-line'));
  } finally {model.dispose();}
});

test('public rebinding/removal cancels an active bound edit and restores its uncommitted anchors', () => {
  for (const operation of ['rebind', 'removeSeries', 'removeIndicator']) {
    const {model, api, controller} = fixture();
    try {
      let seriesId = 'B-line';
      if (operation === 'removeIndicator') {
        api.addIndicator('edit-ema', 'ema', {period: 2});
        api.addSeries({id: 'edit-ema-line', type: 'line', panel: 'price', axisId: 'B', indicator: 'edit-ema'}); seriesId = 'edit-ema-line';
      }
      if(operation==='rebind')api.addAxis({id:'C',panel:'price',range:[10,50],padding:0,visible:false});
      const id = api.addDrawing({type: 'horizontal', seriesId, points: [{time: T + 120000, price: 3000}]});
      controller.setTool('select'); controller.down(1, xAt(2), 239); controller.move(1, xAt(2), yB(3500));
      near(model.drawings.items.find(drawing => drawing.id === id).points[0].price, 3500);
      assert.ok(model.drawings.transaction); const undo = model.drawings.undoStack.length;
      if (operation === 'rebind') api.setSeries(seriesId, {axisId: 'C'});
      else if (operation === 'removeSeries') api.removeSeries(seriesId);
      else api.removeIndicator('edit-ema');
      assert.equal(controller.gesture, null); assert.equal(controller.pointers.size, 0); assert.equal(model.drawings.transaction, null);
      assert.equal(model.drawings.undoStack.length, undo);
      const drawing = model.drawings.items.find(item => item.id === id); near(drawing.points[0].price, 3000);
      assert.equal(drawing.axisId, 'B'); assert.deepEqual(drawingGeometry(drawing, createLayout(model, W, H)), []);
    } finally {model.dispose();}
  }
});

test('manual positive log ranges cannot emit invalid coordinates for nonpositive visible values', () => {
  const {model, api} = fixture();
  try {renderOrDomainError(() => {api.setAxis('B', {scale: 'log', range: [1, 100], prefix: '', suffix: ''});
    api.setSeriesValues('B-line', [-1, 0, 1, 10, 100, 1, 1, 1, 1, 1, 1, 1]); return buildScene(model, W, H);});
  } finally {model.dispose();}
});

test('degenerate extreme domains either stay finite or reject deterministically', () => {
  const {model, api} = fixture();
  try {renderOrDomainError(() => {api.setAxis('B', {range: null, padding: 0});
    api.setSeriesValues('B-line', new Float64Array(12).fill(1e308)); return buildScene(model, W, H);});
  } finally {model.dispose();}
});

test('finite huge values cannot overflow screen coordinates under a narrow manual linear range', () => {
  const {model, api} = fixture();
  try {renderOrDomainError(() => {api.setAxis('B', {range: [0, 1], padding: 0});
    api.setSeriesValues('B-line', new Float64Array(12).fill(1e308)); return buildScene(model, W, H);});
  } finally {model.dispose();}
});

test('tiny finite percent bases cannot overflow mapped values outside a manual range', () => {
  const {model, api} = fixture();
  try {renderOrDomainError(() => {api.setAxis('B', {scale: 'percent', range: [Number.MIN_VALUE, Number.MIN_VALUE * 2], base: Number.MIN_VALUE, padding: 0});
    api.setSeriesValues('B-line', new Float64Array(12).fill(3000)); return buildScene(model, W, H);});
  } finally {model.dispose();}
});

test('formatter outputs are bounded and throwing callbacks preserve the previous cached base', () => {
  const {model, api} = fixture(), cache = new SceneCache();
  try {
    api.setAxis('B', {formatter: () => 'x'.repeat(256)}); assert.ok(buildScene(model, W, H).commands.some(c => c.fullText?.length === 256 && c.text.endsWith('…')));
    cache.frame(model, W, H); const previous = cache.base;
    api.setAxis('B', {formatter: () => 'x'.repeat(257)}); assert.throws(() => cache.frame(model, W, H)); assert.equal(cache.base, previous);
    api.setAxis('B', {formatter: () => {throw Error('fixture formatter failure');}});
    assert.throws(() => cache.frame(model, W, H), /fixture formatter failure/); assert.equal(cache.base, previous);
    api.setAxis('B', {formatter: value => `value:${value}`}); assert.equal(cache.frame(model, W, H).baseChanged, true);
    model.priceFormatter = () => 'x'.repeat(257); assert.throws(() => buildScene(model, W, H));
  } finally {model.dispose();}
});

test('axis/series/drawing records reject malicious prototypes and unsupported keys before mutation', () => {
  const {model, api} = fixture();
  try {
    const before = api.inspect();
    const validAxis = {id: 'bad', panel: 'price'}, validSeries = {id: 'bad', type: 'line', panel: 'price'},
      validDrawing = {type: 'horizontal', panel: 'price', axisId: 'B', seriesId: 'B-line', points: [{time: T, price: 3000}]};
    for (const [run, options] of [[value => api.addAxis(value), validAxis], [value => api.addSeries(value), validSeries], [value => api.addDrawing(value), validDrawing]]) {
      assert.throws(() => run(Object.assign(Object.create({polluted: true}), options)));
      assert.throws(() => run({...options, unexpected: true}));
      assert.throws(() => run(JSON.parse(JSON.stringify(options).slice(0, -1) + ',"__proto__":{}}')));
    }
    assert.deepEqual(api.inspect(), before);
    api.addDrawing({...validDrawing, id: 'edit-target'}); const saved = api.saveDrawings();
    assert.throws(() => api.editDrawing('edit-target', Object.assign(Object.create({polluted: true}), {axisId: null, seriesId: null})));
    assert.equal(api.saveDrawings(), saved);
  } finally {model.dispose();}
});

test('axis resource limits and rejected domain patches are atomic', () => {
  const {model, api} = fixture();
  try {
    const before = JSON.stringify(model.axes);
    for (const patch of [{precision: 19}, {width: 257}, {width: 19}, {range: [1, Infinity]}, {scale: 'percent', base: 0}, {side: 'center'}, {prefix: 'x'.repeat(65)}]) {
      assert.throws(() => api.setAxis('B', patch)); assert.equal(JSON.stringify(model.axes), before);
    }
    for (let index = 0; index < 63; index++) api.addAxis({id: 'axis-' + index, panel: 'price', visible: false});
    assert.equal(model.axes.length, 64); assert.throws(() => api.addAxis({id: 'overflow', panel: 'price'}), /limit/i);
    assert.equal(model.axes.length, 64);
  } finally {model.dispose();}
});

test('cached hover uses its existing layout without reading source arrays or recalculating ranges', () => {
  const {model, controller} = fixture(), cache = new SceneCache();
  try {
    const first = cache.frame(model, W, H), originalSeriesData = model.seriesData, originalQuery = model.store.index.query;
    model.seriesData = () => {throw Error('hover recomputed source range');}; model.store.index.query = () => {throw Error('hover queried source range');};
    controller.layout = () => {throw Error('idle hover rebuilt layout');};
    try {
      for (let index = 0; index < 20; index++) {
        controller.move(1, xAt(index % 12), 239); const frame = cache.frame(model, W, H);
        assert.equal(frame.baseChanged, false); assert.equal(frame.base.layout, first.base.layout);
        const labels = frame.hover.commands.filter(command => command.op === 'text').map(command => command.fullText??command.text);
        assert.deepEqual(labels, ['150.00', 'B:3000.000 units']);
      }
    } finally {model.seriesData = originalSeriesData; model.store.index.query = originalQuery;}
  } finally {model.dispose();}
});

test('axis, series style, theme and streaming changes invalidate cached scenes with literal new output', () => {
  const {model, api} = fixture(), cache = new SceneCache();
  try {
    cache.frame(model, W, H); assert.equal(cache.frame(model, W, H).baseChanged, false);
    for (const patch of [{precision: 1}, {side: 'right'}, {visible: false}, {visible: true}, {width: 90}, {prefix: 'NEW:'}, {range: [1000, 9000]}]) {
      api.setAxis('B', patch); assert.equal(cache.frame(model, W, H).baseChanged, true); assert.equal(cache.frame(model, W, H).baseChanged, false);
    }
    api.setSeries('B-line', {color: '#ff0000', label: 'new label'}); let frame = cache.frame(model, W, H);
    assert.equal(frame.baseChanged, true); assert.ok(frame.base.commands.some(command => command.color === '#ff0000ff'));
    api.setTheme({grid: '#123456'}); frame = cache.frame(model, W, H); assert.equal(frame.baseChanged, true);
    assert.ok(frame.base.commands.some(command => command.color === '#123456ff'));
    model.crosshair = {x: (frame.base.layout.panels[0].left + frame.base.layout.panels[0].right) / 2, y: 239};
    api.setTheme({crosshair: '#abcdef'}); frame = cache.frame(model, W, H); assert.equal(frame.baseChanged, false);
    assert.ok(frame.hover.commands.filter(command=>command.op!=='box').every(command => command.color === '#abcdefff'));
    model.store.update(0, {time: T, open: 111, high: 150, low: 101, close: 140, volume: 55});
    frame = cache.frame(model, W, H); assert.equal(frame.baseChanged, true); assertFiniteCoordinates(frame.scene);
    api.setSeriesValues('B-line', new Float64Array(12).fill(5000)); frame = cache.frame(model, W, H); assert.equal(frame.baseChanged, true);
    near(frame.base.layout.axis('price', 'B').y(5000), 239);
  } finally {model.dispose();}
});

test('cached crosshair labels preserve independent axis identity when primary axis is hidden', () => {
  const {model, api} = fixture();
  try {
    api.setPanel('price', {axisVisible: false}); model.crosshair = {x: 200, y: 239};
    const commands = createCrosshairCommands(model, createLayout(model, W, H));
    assert.deepEqual(commands.filter(command => command.op === 'text').map(command => command.fullText??command.text), ['B:3000.000 units']);
    const result = api.crosshairValues(W, H);
    assert.equal(result.primary.symbolId, 'PRIMARY-A'); assert.equal(result.axes.find(axis => axis.id === 'B').formatted, 'B:3000.000 units');
  } finally {model.dispose();}
});

test('finite Double projections also stay representable by native/GPU display floats',()=>{
 const {model,api}=fixture();try{api.setAxis('B',{range:[0,1],padding:0});api.setSeriesValues('B-line',new Float64Array(12).fill(1e38));assert.throws(()=>buildScene(model,W,H),/projection overflow/i);assert.equal(model.series.find(s=>s.id==='B-line').values[0],1e38);}finally{model.dispose();}
});

test('unprojectable raw drawing prices remain saved without invalid display coordinates',()=>{
 const {model,api}=fixture();try{api.setAxis('B',{range:[0,1],padding:0});const id=api.addDrawing({type:'horizontal',panel:'price',seriesId:'B-line',points:[{time:T,price:1e38}]});const d=model.drawings.items.find(d=>d.id===id),layout=createLayout(model,W,H);assert.deepEqual(drawingGeometry(d,layout),[]);assert.equal(JSON.parse(api.saveDrawings()).drawings[0].points[0].price,1e38);}finally{model.dispose();}
});
