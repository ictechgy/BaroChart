import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, ChartAPI, createLayout} from '../src/core/index.mjs';
import {AsyncCapture, AsyncPrepared} from '../src/core/async-state.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {modelRequest, installRecomputed} from '../src/web/worker-state.mjs';

// Literal UTC bars include a gap. Index movement must preserve timestamp identity.
const bars = (count, start = 0) => Array.from({length: count}, (_, i) => ({
  time: 1700000000000 + (start + i) * 60000 + (start + i >= 10 ? 3600000 : 0),
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: i + 1,
}));
function model(t, {initial = [], follow = true, offset = 0} = {}) {
  const m = new ChartModel({store: new BarStore(initial), visibleBars: 20});
  t.after(() => m.dispose());
  m.addSeries({id: 'price', type: 'candles', panel: 'price'});
  m.indicators.add('ema', 'ema', {period: 3});
  m.addSeries({id: 'ema', type: 'line', panel: 'price', indicator: 'ema', offset});
  m.follow = follow;
  if (!follow) m.view = {from: 3.25, to: 18.75};
  return m;
}
function prepared(t, source, event, latestUI = () => {}) {
  const capture = new AsyncCapture(source, event), stage = new AsyncPrepared(capture.metadataJSON);
  t.after(() => { capture.release(); stage.dispose(); });
  for (let slot = 0; slot < capture.buffers.length; slot++) {
    const n = capture.buffers[slot].length;
    stage.target(slot, 0, n).set(capture.buffer(slot, 0, n));
  }
  for (let e = 0; e < capture.checkpoints.length; e++)
    for (let i = 0; i < capture.checkpoints[e].keys.length; i++)
      stage.checkpoint(e, capture.checkpoint(e, i, 1));
  stage.start();
  for (let i = 0; !stage.step(64).complete; i++) assert.ok(i < 1000, 'bounded preparation');
  latestUI();
  return stage.finish(capture.ui(null, {width: 800, height: 480})).model;
}
for (const path of ['store', 'api', 'prepared']) for (const follow of [false, true])
  for (const count of [1, 30]) for (const offset of [0, 4]) {
    test(`${path} first prepend ${count} bars follows=${follow}, offset=${offset}`, t => {
      const source = model(t, {follow, offset}), before = {...source.view}, input = bars(count);
      let result = source;
      if (path === 'prepared') result = prepared(t, source, {kind: 'prepend', bars: input});
      else if (path === 'api') new ChartAPI(source).applyDataEvent({kind: 'prepend', bars: input});
      else source.store.prepend(input);
      const expected = follow ? {from: count + offset - .5 - 20, to: count + offset - .5} : before;
      assert.deepEqual(result.view, expected, 'initial-page logical range');
      assert.equal(result.follow, follow);
      if (follow) {
        const layout = createLayout(result, 800, 480), panel = layout.panels[0];
        const x = layout.toScreen({time: input.at(-1).time, price: input.at(-1).close}, 'price').x;
        assert.ok(x >= panel.left && x <= panel.right, 'latest actual candle center is inside plot');
      }
      assert.deepEqual(Array.from(result.store.columns.time.subarray(0, count)), input.map(b => b.time));
      if (path === 'prepared') {
        assert.equal(source.store.length, 0, 'source is not consumed by candidate');
        assert.deepEqual(source.view, before);
      }
    });
  }
for (const path of ['api', 'prepared']) for (const follow of [false, true]) {
  test(`${path} existing history retains UTC anchors across backfill and live append, follow=${follow}`, t => {
    const source = model(t, {initial: bars(40, 20), follow}), before = {...source.view};
    const anchorIndex = 7, anchorTime = source.store.at(anchorIndex).time;
    const points = [{time: anchorTime, price: 107}];
    source.drawings.add({id: 'analysis', type: 'horizontal', points});
    const backfill = bars(20), event = {kind: 'prepend', bars: backfill};
    const result = path === 'prepared' ? prepared(t, source, event) : (new ChartAPI(source).applyDataEvent(event), source);
    assert.deepEqual(result.view, {from: before.from + 20, to: before.to + 20});
    assert.equal(result.store.at(anchorIndex + 20).time, anchorTime);
    assert.deepEqual(result.drawings.items[0].points, points);
    assert.equal(result.follow, follow);
    const shifted = {...result.view}, last = result.store.at(result.store.length - 1);
    result.store.append({...last, time: last.time + 60000});
    assert.deepEqual(result.view, follow ? {from: shifted.from + 1, to: shifted.to + 1} : shifted);
  });
}
test('empty prepared prepend uses the latest explicit UI range and follow choice', t => {
  const source = model(t), expected = {from: 1.25, to: 16.75};
  const result = prepared(t, source, {kind: 'prepend', bars: bars(30)}, () => {
    source.view = {...expected}; source.follow = false;
  });
  assert.deepEqual(result.view, expected);
  assert.equal(result.follow, false);
});
test('shared empty store preserves each model’s own follow policy', t => {
  const a = model(t), b = new ChartModel({store: a.store, visibleBars: 12});
  t.after(() => b.dispose());
  b.follow = false; b.view = {from: 2.5, to: 14.5};
  a.store.prepend(bars(30));
  assert.deepEqual(a.view, {from: 9.5, to: 29.5});
  assert.deepEqual(b.view, {from: 2.5, to: 14.5});
});
test('empty prepend is a no-op; reset retains the established fit contract', t => {
  const m = model(t), before = {...m.view}, version = m.store.version;
  m.store.prepend([]);
  assert.deepEqual(m.view, before); assert.equal(m.store.version, version);
  m.store.setData(bars(30));
  assert.deepEqual(m.view, {from: -.5, to: 29.5});
});
for (const empty of [false, true]) for (const follow of [false, true])
  test(`prepared worker packet publication preserves view policy, empty=${empty}, follow=${follow}`, async t => {
    const m = model(t, {initial: empty ? [] : bars(40, 20), follow, offset: 4});
    const before = {...m.view}, event = {kind: 'prepend', bars: bars(20)}, options = modelRequest(m);
    const packet = await computeRequest({columns: m.store.columns, length: m.store.length, options, event});
    assert.deepEqual(m.view, before, 'calculation alone never publishes a viewport');
    installRecomputed(m, packet, event, options);
    assert.deepEqual(m.view, empty
      ? follow ? {from: 3.5, to: 23.5} : before
      : {from: before.from + 20, to: before.to + 20});
    assert.equal(m.follow, follow);
    const prior = {...m.view}, row = m.store.at(0);
    new ChartAPI(m).applyDataEvent({kind: 'correction', bar: {...row, volume: row.volume + 1}});
    assert.deepEqual(m.view, prior, 'value correction never moves history');
  });
test('prepared empty prepend with no bars does not reinterpret the current range', t => {
  const m = model(t), expected = {...m.view};
  const result = prepared(t, m, {kind: 'prepend', bars: []});
  assert.deepEqual(result.view, expected);
});
test('empty worker publication with no bars does not reinterpret the current range', async t => {
  const m = model(t), expected = {...m.view}, event = {kind: 'prepend', bars: []}, options = modelRequest(m);
  const packet = await computeRequest({columns: m.store.columns, length: 0, options, event});
  installRecomputed(m, packet, event, options);
  assert.deepEqual(m.view, expected);
  assert.equal(m.follow, true);
});
for (const path of ['api', 'prepared', 'worker']) for (const empty of [false, true])
  test(`${path} rejected history page leaves source data/view/history untouched, empty=${empty}`, async t => {
    const m = model(t, {initial: empty ? [] : bars(40, 20), follow: empty});
    m.drawings.add({id: 'analysis', type: 'horizontal', points: [{time: 1700000000000, price: 100}]});
    const before = {view: m.view, follow: m.follow, columns: m.store.columns, version: m.store.version,
      length: m.store.length, items: m.drawings.items, history: m.drawings.undoStack};
    // Valid leading row followed by an invalid row (empty) or an overlapping
    // timestamp (nonempty). Admission must not publish the valid prefix alone.
    const page = empty ? [bars(1)[0], {...bars(1, 1)[0], volume: -1}] : [bars(1)[0], m.store.at(0)];
    const event = {kind: 'prepend', bars: page};
    let notifications = 0;
    const api = new ChartAPI(m, {invalidate() { notifications++; }});
    if (path === 'api') assert.throws(() => api.applyDataEvent(event), {name: 'RangeError', message: empty ? 'Invalid OHLCV envelope' : 'Prepend must precede existing history without overlap'});
    else if (path === 'prepared') assert.throws(() => prepared(t, m, event), {name: 'RangeError', message: empty ? 'Invalid OHLCV envelope' : 'Prepend must precede existing history without overlap'});
    else await assert.rejects(computeRequest({columns: m.store.columns, length: m.store.length,
      options: modelRequest(m), event}), {name: 'RangeError', message: empty ? 'Invalid OHLCV envelope' : 'Prepend must precede existing history without overlap'});
    assert.strictEqual(m.view, before.view);
    assert.equal(m.follow, before.follow);
    assert.strictEqual(m.store.columns, before.columns);
    assert.equal(m.store.version, before.version);
    assert.equal(m.store.length, before.length);
    assert.strictEqual(m.drawings.items, before.items);
    assert.strictEqual(m.drawings.undoStack, before.history);
    assert.equal(notifications, 0);
  });
