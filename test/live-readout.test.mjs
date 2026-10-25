import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_SYMBOLS} from '../src/core/index.mjs';
import {createLiveReadout} from '../examples/web/live-readout.mjs';
import {fixture, event} from './helpers/customization-dom.mjs';

const bars = Array.from({length: 8}, (_, index) => ({
  time: Date.UTC(2026, 2, 1, 14, index),
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 1000 + index,
}));

function readoutFixture(t) {
  const dom = fixture(t), root = dom.node('section'), explorer = {
    readout: dom.node(),
    live: dom.node(),
    controls: [],
  };
  const model = dom.makeModel();
  model.store.setData(bars);
  const chart = dom.create({
    dataExplorer: explorer,
    rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
  }, model).chart;
  chart.api.removeSeries('price');
  chart.api.addSeries({id: 'candles', type: 'candles', panel: 'price'});
  chart.api.addSeries({id: 'close-line', type: 'line', panel: 'price', source: 'close', color: '#f0b755', label: 'Close'});
  chart.api.addSeries({id: 'volume-line', type: 'line', panel: 'price', source: 'volume', label: 'Volume'});
  chart.api.addSeries({id: 'hidden', type: 'line', panel: 'price', source: 'close', visible: false});
  chart.drawNow();
  return {dom, root, model, chart, readout: createLiveReadout({root})};
}

function text(root) {
  return root.textContent;
}

test('live readout builds stable keyed rows and renders latest plus pointer values', t => {
  const h = readoutFixture(t), {root, chart, model, readout} = h;
  const originalDataAt = chart.api.dataAt.bind(chart.api);
  let queries = 0;
  chart.api.dataAt = (...args) => {queries++; return originalDataAt(...args);};
  assert.doesNotThrow(() => readout.bind(chart));
  assert.equal(queries, 1, 'one cached snapshot query is enough for the selected bar');
  assert.match(text(root), /최신 봉/);
  assert.match(root.children[0].children[0].textContent, /최신 봉/);
  assert.match(text(root), /시가|고가|저가|종가|거래량/);
  assert.match(text(root), /Close/);
  assert.match(text(root), /Volume/);
  assert.doesNotMatch(text(root), /hidden/);
  assert.equal(root.children.filter(node => node.getAttribute('data-readout-series') === 'candles').length, 0);

  const row = root.children.flatMap(node => node.children).find(node => node.getAttribute('data-readout-series') === 'close-line');
  assert.ok(row, 'series rows expose a stable data-readout-series key');
  const first = row;
  const layout = chart.timeLayout.layout;
  const panel = layout.panels[0];
  model.crosshair = {x: layout.x(2), y: (panel.top + panel.bottom) / 2};
  event(chart.canvas, 'aster:render');
  assert.equal(queries, 2, 'pointer updates still query one selected snapshot');
  assert.match(root.children[0].children[0].textContent, /십자선/);
  const second = root.children.flatMap(node => node.children).find(node => node.getAttribute('data-readout-series') === 'close-line');
  assert.strictEqual(second, first, 'pointer updates retain keyed row nodes');
  assert.match(text(root), /십자선/);
  readout.destroy();
});
test('keyboard selection has priority and exact missing times stay empty', t => {
  const h = readoutFixture(t), {root, chart, model, readout} = h;
  readout.bind(chart);
  chart.setDataExploration(true);
  chart.canvas.focus();
  chart.explorer.time = bars[1].time;
  chart.explorer.generation++;
  chart.publishExploration(true);
  assert.match(text(root), /키보드 선택/);
  assert.match(text(root), /2026/);
  assert.match(text(root), /봉 2 \/ 8/);
  chart.explorer.time = bars[1].time - 1;
  chart.explorer.generation++;
  chart.publishExploration(true);
  const keyboardCard = root.children[0].children[0];
  assert.match(keyboardCard.textContent, /선택한 봉|데이터 없음|없음/);
  assert.doesNotMatch(keyboardCard.textContent, /2026/);
  readout.destroy();
});

test('cached sync never invokes indicator calculation and pending clears stale values', t => {
  const h = readoutFixture(t), {root, chart, model, readout} = h;
  chart.api.addIndicator('ema-study', 'ema', {period: 3});
  chart.api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema-study', output: 'value', label: 'EMA'});
  chart.api.dataAt({index: bars.length - 1}, {indicatorMode: 'cached'});
  const original = model.indicators.get;
  model.indicators.get = () => { throw new Error('lazy study read'); };
  try {
    readout.bind(chart);
    assert.doesNotThrow(() => event(chart.canvas, 'aster:render'));
    const row = root.children.flatMap(node => node.children).find(node => node.getAttribute('data-readout-series') === 'ema-line');
    assert.ok(row);
    model.store.update(0, {...model.store.at(0), high: 1001, close: 999});
    event(chart.canvas, 'aster:render');
    assert.match(row.textContent, /계산 대기|—/);
  } finally {
    model.indicators.get = original;
    readout.destroy();
  }
});

test('rebind and destroy retire old canvas events', t => {
  const h = readoutFixture(t), {root, chart, dom, readout} = h;
  readout.bind(chart);
  const oldCanvas = chart.canvas;
  const next = dom.create({
    rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
  }).chart;
  next.api.setData(bars);
  next.api.addSeries({id: 'next', type: 'line', panel: 'price'});
  next.drawNow();
  readout.bind(next);
  const before = text(root);
  event(oldCanvas, 'aster:render');
  assert.equal(text(root), before);
  readout.destroy();
  event(next.canvas, 'aster:render');
  assert.equal(root.children.length, 0);
});

test('binding and sync do not render, invalidate, or intercept keyboard events', t => {
  const h = readoutFixture(t), {chart, readout} = h;
  let renders = 0, invalidations = 0;
  chart.drawNow = () => {renders++;};
  chart.invalidate = () => {invalidations++;};
  readout.bind(chart);
  readout.sync();
  assert.equal(renders, 0);
  assert.equal(invalidations, 0);
  assert.equal(chart.canvas.events.get('keydown')?.size ?? 0, 1, 'the helper does not add a keyboard listener');
  readout.destroy();
});

test('reentrant row DOM hooks cannot let an older sync overwrite a newer binding', t => {
  const h = readoutFixture(t), {root, chart, dom, readout} = h;
  const next = dom.create({
    rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
  }).chart;
  next.api.setData(bars);
  next.api.addSeries({id: 'new-series', type: 'line', panel: 'price', source: 'close'});
  next.drawNow();
  const seriesHost = root.children[2];
  let rebound = false;
  seriesHost.onAppend = () => {
    if (rebound) return;
    rebound = true;
    readout.bind(next);
  };
  readout.bind(chart);
  assert.equal(rebound, true);
  const before = root.textContent;
  event(chart.canvas, 'aster:render');
  assert.equal(root.textContent, before);
  assert.equal(root.children[2].children.find(node => node.getAttribute('data-readout-series') === 'new-series')?.getAttribute('data-readout-status'), 'value');
  readout.destroy();
});

test('timezone, full precision titles, signed zero, scientific values, and gaps are readable', t => {
  const h = readoutFixture(t), {root, chart, readout} = h;
  chart.api.setSymbol({...DEMO_SYMBOLS.us});
  const values = new Float64Array(bars.length).fill(1e-10);
  values[0] = -0;
  values[2] = NaN;
  chart.api.addSeries({id: 'external', type: 'area', panel: 'price', values, symbolId: 'EXT', label: 'External'});
  chart.drawNow();
  readout.bind(chart);
  const external = root.children[2].children.find(node => node.getAttribute('data-readout-series') === 'external');
  assert.ok(external);
  assert.match(external.textContent, /1e-10/);
  assert.equal(external.children[2].getAttribute('title'), '원본 값 1e-10');
  assert.match(root.children[0].children[0].textContent, /America\/New_York/);
  chart.setDataExploration(true);
  chart.explorer.time = bars[2].time;
  chart.explorer.generation++;
  chart.publishExploration(true);
  assert.match(external.textContent, /—/);
  readout.destroy();
});

test('row churn prunes removed IDs, reuses visible nodes, and follows model series order', t => {
  const h = readoutFixture(t), {root, chart, readout} = h;
  readout.bind(chart);
  const seriesHost = root.children[2];
  const volumeRow = seriesHost.children.find(node => node.getAttribute('data-readout-series') === 'volume-line');
  let previous = 'close-line';
  for (let index = 0; index < 24; index++) {
    chart.api.removeSeries(previous);
    const next = `churn-${index}`;
    chart.api.addSeries({id: next, type: 'line', panel: 'price', source: 'close'});
    chart.drawNow();
    previous = next;
    assert.equal(seriesHost.children.length, 2);
    assert.equal(seriesHost.children.filter(node => node.style.display === 'none').length, 0);
  }
  assert.strictEqual(seriesHost.children.find(node => node.getAttribute('data-readout-series') === 'volume-line'), volumeRow);
  assert.deepEqual(seriesHost.children.map(node => node.getAttribute('data-readout-series')), ['volume-line', previous]);

  chart.api.removeSeries(previous);
  chart.api.addSeries({id: previous, type: 'line', panel: 'price', source: 'close'});
  chart.drawNow();
  assert.deepEqual(seriesHost.children.map(node => node.getAttribute('data-readout-series')), ['volume-line', previous]);
  assert.strictEqual(seriesHost.children[0], volumeRow, 'a still-visible series keeps its keyed node when order changes');
  const volumeSeries = chart.model.series.find(series => series.id === 'volume-line');
  const churnSeries = chart.model.series.find(series => series.id === previous);
  chart.model.series = [churnSeries, volumeSeries];
  chart.drawNow();
  assert.deepEqual(seriesHost.children.map(node => node.getAttribute('data-readout-series')), [previous, 'volume-line']);
  assert.strictEqual(seriesHost.children[1], volumeRow, 'reordering moves the existing visible node');
  readout.destroy();
});

test('rebind prunes the prior model and rejects disposed or foreign API owners', t => {
  const h = readoutFixture(t), {root, chart, dom, model, readout} = h;
  readout.bind(chart);
  const before = root.textContent;
  const foreignModel = dom.makeModel();
  foreignModel.store.setData(bars);
  foreignModel.addSeries({id: 'foreign', type: 'line', panel: 'price'});
  chart.api.model = foreignModel;
  readout.sync();
  assert.equal(root.textContent, before, 'a foreign API owner cannot publish into the current readout');
  chart.api.model = model;
  model.dispose();
  readout.sync();
  assert.equal(root.textContent, before, 'a disposed model cannot publish another snapshot');

  const next = dom.create({
    rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
  }).chart;
  next.api.setData(bars);
  next.api.addSeries({id: 'replacement', type: 'line', panel: 'price'});
  next.drawNow();
  readout.bind(next);
  assert.deepEqual(root.children[2].children.map(node => node.getAttribute('data-readout-series')), ['replacement']);
  readout.destroy();
});

test('identical sync values do not repeat DOM text or attribute writes', t => {
  const h = readoutFixture(t), {root, chart, readout} = h;
  readout.bind(chart);
  const card = root.children[0].children[0], label = card.children[0], time = card.children[1];
  const row = root.children[2].children[0], value = row.children[2];
  let textWrites = 0;
  for (const node of [label, time, value]) node.onText = () => {textWrites++;};
  let attributes = 0;
  row.onAttribute = () => {attributes++;};
  readout.sync();
  assert.equal(textWrites, 0);
  assert.equal(attributes, 0);
  readout.destroy();
});

test('financial readout rounds visible prices while retaining exact raw titles', t => {
  const {root,chart,model,readout}=readoutFixture(t),last=model.store.at(model.store.length-1);
  model.symbol={id:'TEST',currency:'USD',volumeUnit:'shares',timezone:'UTC',priceDecimals:2};
  model.store.update(model.store.length-1,{...last,close:108.1234567});
  readout.bind(chart);
  const card=root.children[0].children[0],fields=card.children[2].children;
  const close=fields.find(field=>field.children[1].getAttribute('data-readout-value')==='close').children[1];
  assert.equal(close.textContent,'108.12');assert.equal(close.getAttribute('title'),'원본 값 108.1234567');
  const sourceRow=root.children[2].children.find(row=>row.getAttribute('data-readout-series')==='close-line');
  assert.equal(sourceRow.children[2].textContent,'108.12');assert.equal(sourceRow.children[2].getAttribute('title'),'원본 값 108.1234567');
  readout.destroy();
});

test('custom studies clearly require an explicit read and never run through the live display', t => {
  const {root,chart,readout}=readoutFixture(t);let calls=0;
  chart.model.indicators.register('custom-readout',()=>({outputs:['value'],create(){return{step(bar){calls++;return[bar.close];},snapshot(){return null;},restore(){}};}}));
  chart.api.addIndicator('custom','custom-readout');chart.api.addSeries({id:'custom-line',label:'Custom',type:'line',panel:'price',indicator:'custom'});
  const before=calls;readout.bind(chart);
  const row=root.children[2].children.find(node=>node.getAttribute('data-readout-series')==='custom-line');
  assert.equal(row.children[2].textContent,'자동 조회 미지원');assert.equal(row.getAttribute('data-readout-status'),'unsupported-cache');assert.equal(calls,before);
  readout.destroy();
});

test('indicator labels avoid repeated IDs while retaining output and duplicate disambiguation', t => {
  const h = readoutFixture(t), {root, chart, readout} = h;
  chart.api.addIndicator('rsi', 'rsi');
  chart.api.addSeries({id: 'rsi-value', type: 'line', panel: 'price', indicator: 'rsi', output: 'value', label: 'rsi'});
  chart.api.addSeries({id: 'rsi-signal', type: 'line', panel: 'price', indicator: 'rsi', output: 'value', label: 'rsi'});
  chart.api.addIndicator('bb', 'bollinger');
  chart.api.addSeries({id: 'bb-upper', type: 'line', panel: 'price', indicator: 'bb', output: 'upper', label: 'Upper'});
  chart.api.addIndicator('macd', 'macd');
  chart.api.addSeries({id: 'extra-1-macd', type: 'line', panel: 'price', indicator: 'macd', output: 'macd', label: 'extra-1-macd'});
  readout.bind(chart);
  const labels = root.children[2].children.map(node => node.children[1].textContent);
  assert.ok(labels.includes('rsi · #2') || labels.includes('rsi'));
  assert.ok(labels.every(label => !/rsi · rsi · value/iu.test(label)));
  assert.ok(labels.includes('Upper'));
  assert.ok(labels.includes('extra-1-macd'));
  assert.ok(labels.every(label => !/upper · bb · upper/iu.test(label)));
  assert.ok(labels.every(label => !/extra-1-macd · macd/iu.test(label)));
  readout.destroy();
});

test('fallback keeps the stable container binding and ignores the retired canvas', t => {
  const h = readoutFixture(t), {root, chart, model, readout} = h;
  readout.bind(chart);
  const container = chart.container, oldCanvas = chart.canvas;
  assert.equal(container.events.get('aster:render')?.size ?? 0, 1);
  chart.fallback('test');
  const context = new Proxy({}, {get: () => () => {}});
  chart.canvas.getContext = () => context;
  chart.ctx = context;
  assert.notStrictEqual(chart.canvas, oldCanvas);
  assert.equal(container.events.get('aster:render')?.size ?? 0, 1);
  assert.equal(oldCanvas.events.get('aster:render')?.size ?? 0, 0);
  const replacement = {...model.store.at(model.store.length - 1), high: 1000, close: 999};
  model.store.update(model.store.length - 1, replacement);
  chart.drawNow();
  assert.match(root.textContent, /종가999/);
  const current = root.textContent;
  oldCanvas.dispatchEvent(new Event('aster:render', {bubbles: true}));
  assert.equal(root.textContent, current);
  readout.destroy();
});
