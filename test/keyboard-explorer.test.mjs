import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, ChartModel} from '../src/core/index.mjs';
import {KeyboardDataExplorer, explorerInputAllowed} from '../src/renderers/keyboard-explorer.mjs';

const bars = Array.from({length: 6}, (_, i) => ({
  time: 1700000000000 + [0, 1, 3, 4, 8, 9][i] * 60000,
  open: 10 + i, high: 14 + i, low: 9 + i, close: 12 + i, volume: 100 + i,
}));
const off = {active: false, time: null, index: null, seriesId: null, phase: 'off', text: ''};
const stale = error => error?.name === 'StaleSourceError' || /disposed/i.test(error?.message);

function fixture(t, {input = bars, price = true} = {}) {
  const model = new ChartModel(), api = new ChartAPI(model);
  api.setData(input);
  if (price) api.addSeries({id: 'price', type: 'line', panel: 'price'});
  const explorer = new KeyboardDataExplorer(api), queries = [];
  const dataAt = api.dataAt.bind(api);
  api.dataAt = (query, options) => {queries.push({query: {...query}, options}); return dataAt(query, options);};
  t.after(() => {explorer.dispose(); model.dispose();});
  return {model, api, explorer, queries, store: model.store};
}

function lazy(f, effect = () => {}) {
  let armed = false, steps = 0;
  f.api.registerIndicator('keyboard-custom', () => ({
    outputs: ['value'],
    create: () => ({step(bar, index) {steps++; if (armed) effect(index); return [bar.close];}, snapshot: () => ({}), restore() {}}),
  }));
  f.api.addIndicator('custom', 'keyboard-custom');
  f.api.addSeries({id: 'custom-line', type: 'line', panel: 'price', indicator: 'custom'});
  return {
    dirty() {f.store.update(0, {...f.store.at(0)}); steps = 0; armed = true;},
    disarm() {armed = false;},
    steps: () => steps,
  };
}

function at(explorer, index) {
  explorer.key('Home');
  for (let i = 0; i < index; i++) explorer.key('ArrowRight');
}

function scalarSnapshot(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['active', 'index', 'phase', 'seriesId', 'text', 'time']);
  for (const value of Object.values(snapshot)) assert.ok(value === null || ['boolean', 'number', 'string'].includes(typeof value));
  assert.ok(snapshot.text.length <= 4096);
  assert.ok(['off', 'selected', 'changed', 'missing', 'read', 'error'].includes(snapshot.phase));
}

test('exploration starts off and ignores keys without querying or warming lazy studies', t => {
  const f = fixture(t), computation = lazy(f);
  computation.dirty();
  assert.deepEqual(f.explorer.snapshot(), off);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Escape']) assert.equal(f.explorer.key(key), false);
  assert.equal(f.explorer.changed(), false);
  assert.throws(() => f.explorer.read(), /enable/i);
  assert.throws(() => f.explorer.setActive('true'), TypeError);
  assert.deepEqual(f.explorer.snapshot(), off);
  assert.equal(f.queries.length, 0);
  assert.equal(computation.steps(), 0);
});

test('first selection floors the visible end and clamps to stored bars', t => {
  const f = fixture(t);
  for (const [to, expected] of [[2.8, 2], [-5, 0], [999, bars.length - 1]]) {
    f.model.view = {from: to - 10, to};
    const result = f.explorer.setActive(true);
    assert.equal(result.index, expected);
    assert.equal(result.time, bars[expected].time);
    assert.equal(result.seriesId, 'price');
    assert.equal(result.phase, 'selected');
    scalarSnapshot(result);
    f.explorer.setActive(false);
  }
  assert.equal(f.queries.length, 0);
});

test('bar and visible-series navigation is cheap, clamped, and leaves chart navigation untouched', t => {
  const f = fixture(t), computation = lazy(f);
  f.api.addSeries({id: 'hidden', type: 'line', panel: 'price', visible: false});
  f.api.addSeries({id: 'volume', type: 'line', panel: 'price', source: 'volume'});
  computation.dirty();
  const before = {view: {...f.model.view}, crosshair: f.model.crosshair, follow: f.model.follow, version: f.store.version};
  f.explorer.setActive(true);
  f.explorer.key('Home');
  f.explorer.key('ArrowLeft');
  assert.equal(f.explorer.snapshot().time, bars[0].time);
  f.explorer.key('ArrowRight');
  f.explorer.key('ArrowRight');
  assert.equal(f.explorer.snapshot().time, bars[2].time, 'stored gaps are skipped without synthesizing time');
  f.explorer.key('ArrowDown');
  assert.equal(f.explorer.snapshot().seriesId, 'custom-line');
  f.explorer.key('ArrowDown');
  f.explorer.key('ArrowDown');
  assert.equal(f.explorer.snapshot().seriesId, 'volume', 'hidden series is skipped and selection does not wrap');
  f.explorer.key('ArrowUp');
  f.explorer.key('ArrowUp');
  f.explorer.key('ArrowUp');
  assert.equal(f.explorer.snapshot().seriesId, 'price');
  f.explorer.key('End');
  f.explorer.key('ArrowRight');
  assert.equal(f.explorer.snapshot().time, bars.at(-1).time);
  assert.equal(f.explorer.key('a'), false);
  assert.deepEqual({view: f.model.view, crosshair: f.model.crosshair, follow: f.model.follow, version: f.store.version}, before);
  assert.equal(f.queries.length, 0);
  assert.equal(computation.steps(), 0);
});

test('selection retains exact stored time through append, prepend, correction and retained reset', t => {
  const f = fixture(t);
  f.explorer.setActive(true);
  at(f.explorer, 2);
  const selected = bars[2].time;
  f.store.append({...bars.at(-1), time: bars.at(-1).time + 60000});
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().time, selected);
  assert.equal(f.explorer.snapshot().index, 2);
  f.store.prepend([{...bars[0], time: bars[0].time - 60000}]);
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().time, selected);
  assert.equal(f.explorer.snapshot().index, 3);
  f.store.update(3, {...f.store.at(3), close: 15});
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().time, selected);
  assert.equal(f.explorer.snapshot().phase, 'changed');
  f.api.setData(bars.slice(1));
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().time, selected);
  assert.equal(f.explorer.snapshot().index, 1);
  assert.equal(f.queries.length, 0);
});

test('missing timestamps do not snap to adjacent bars; Home and End recover explicitly', t => {
  const f = fixture(t);
  f.explorer.setActive(true);
  at(f.explorer, 2);
  f.api.setData(bars.filter((_, i) => i !== 2));
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().phase, 'missing');
  assert.equal(f.explorer.snapshot().index, -1);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']) f.explorer.key(key);
  assert.equal(f.explorer.snapshot().time, bars[2].time);
  assert.equal(f.explorer.read().phase, 'missing');
  assert.equal(f.queries.length, 0);
  assert.match(f.explorer.snapshot().text, /Home or End/);
  f.explorer.key('Home');
  assert.equal(f.explorer.snapshot().time, bars[0].time);
  assert.equal(f.explorer.snapshot().phase, 'selected');
  f.explorer.key('End');
  assert.equal(f.explorer.snapshot().time, bars.at(-1).time);
});

test('empty store stays unselected after data arrives until an explicit endpoint selection', t => {
  const f = fixture(t, {input: []});
  f.explorer.setActive(true);
  assert.equal(f.explorer.snapshot().time, null);
  assert.match(f.explorer.snapshot().text, /No stored bars/);
  assert.equal(f.explorer.read().phase, 'missing');
  f.api.setData(bars);
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().time, null);
  assert.equal(f.explorer.snapshot().phase, 'missing');
  f.explorer.key('End');
  assert.equal(f.explorer.snapshot().time, bars.at(-1).time);
  assert.equal(f.queries.length, 0);
});

test('hidden or removed selected series falls back only among visible configured series', t => {
  const f = fixture(t);
  f.api.addSeries({id: 'hidden', type: 'line', panel: 'price', visible: false});
  f.api.addSeries({id: 'second', type: 'line', panel: 'price'});
  f.explorer.setActive(true);
  f.explorer.key('ArrowDown');
  assert.equal(f.explorer.snapshot().seriesId, 'second');
  f.api.setSeries('second', {visible: false});
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().seriesId, 'price');
  f.api.removeSeries('price');
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().seriesId, null);
  assert.match(f.explorer.snapshot().text, /No visible series/);
  f.explorer.key('ArrowDown');
  assert.equal(f.explorer.snapshot().seriesId, null);
  f.api.setSeries('second', {visible: true});
  f.explorer.changed();
  assert.equal(f.explorer.snapshot().seriesId, 'second');
  assert.equal(f.queries.length, 0);
});

test('Enter and explicit read query exact time once each and expose primary OHLCV plus selected binding', t => {
  const f = fixture(t);
  f.api.addAxis({id: 'right', panel: 'price', side: 'right'});
  f.api.setSeries('price', {axisId: 'right'});
  f.explorer.setActive(true);
  at(f.explorer, 2);
  assert.equal(f.explorer.key('Enter'), true);
  let result = f.explorer.snapshot();
  assert.equal(result.phase, 'read');
  assert.match(result.text, /Open 12; high 16; low 11; close 14; volume 102/);
  assert.match(result.text, /Series price; panel price; axis right/);
  assert.match(result.text, /source index 2; source time 1700000180000 UTC ms/);
  assert.match(result.text, /Current plotted values, cutoff 5; revised data, not historical arrival-time truth/);
  assert.deepEqual(f.queries, [{query: {time: bars[2].time, match: 'exact'}, options: undefined}]);
  result = f.explorer.read();
  assert.equal(result.phase, 'read');
  assert.equal(f.queries.length, 2);
  scalarSnapshot(result);
});

for (const [offset, index, sourceIndex, status] of [[2, 3, 1, 'value'], [-2, 2, 4, 'value'], [2, 0, null, 'outside-source'], [-2, 5, null, 'outside-source']]) {
  test(`read preserves plot offset ${offset} and source position at displayed index ${index}`, t => {
    const f = fixture(t);
    f.api.setSeries('price', {offset});
    f.explorer.setActive(true);
    at(f.explorer, index);
    const result = f.explorer.read();
    assert.match(result.text, new RegExp(`; ${status}; value ${sourceIndex === null ? 'unavailable' : bars[sourceIndex].close}; plot offset ${offset}; source index ${sourceIndex ?? 'none'}; source time ${sourceIndex === null ? 'none' : bars[sourceIndex].time} UTC ms`));
    assert.equal(result.index, index);
    assert.equal(result.time, bars[index].time);
  });
}

test('non-finite gaps keep source position while finite precision and signed zero remain raw', t => {
  const f = fixture(t, {price: false});
  f.api.addSeries({id: 'external', type: 'line', panel: 'price', values: new Float64Array([NaN, NaN, -0, 1.0000000000000002, 4, 5])});
  f.explorer.setActive(true);
  for (const index of [0, 1]) {
    at(f.explorer, index);
    assert.match(f.explorer.read().text, new RegExp(`non-finite; value unavailable; plot offset 0; source index ${index}; source time ${bars[index].time}`));
  }
  at(f.explorer, 2);
  assert.match(f.explorer.read().text, /value; value -0;/);
  at(f.explorer, 3);
  assert.match(f.explorer.read().text, /value; value 1\.0000000000000002;/);
});

test('read without visible series still exposes stored primary values', t => {
  const f = fixture(t);
  f.api.setSeries('price', {visible: false});
  f.explorer.setActive(true);
  const result = f.explorer.read();
  assert.equal(result.phase, 'read');
  assert.equal(result.seriesId, null);
  assert.match(result.text, /Open 15; high 19; low 14; close 17; volume 105/);
  assert.match(result.text, /No visible series/);
});

test('hidden lazy study is not evaluated by an explicit read', t => {
  const f = fixture(t), computation = lazy(f);
  f.api.setSeries('custom-line', {visible: false});
  computation.dirty();
  f.explorer.setActive(true);
  assert.equal(f.explorer.read().phase, 'read');
  assert.equal(f.queries.length, 1);
  assert.equal(computation.steps(), 0);
});

test('live changes clear stale readout without reading or executing dirty indicators', t => {
  const f = fixture(t), computation = lazy(f);
  f.explorer.setActive(true);
  f.explorer.read();
  assert.equal(f.queries.length, 1);
  computation.dirty();
  assert.equal(f.explorer.changed(), true);
  assert.equal(f.explorer.snapshot().phase, 'changed');
  assert.match(f.explorer.snapshot().text, /Data or display changed/);
  assert.doesNotMatch(f.explorer.snapshot().text, /Open \d/);
  for (let i = 0; i < 4; i++) f.explorer.changed();
  assert.equal(f.queries.length, 1);
  assert.equal(computation.steps(), 0);
  f.explorer.read();
  assert.equal(f.queries.length, 2);
  assert.ok(computation.steps() > 0);
});

test('snapshots are bounded scalar-owned values and remain detached from later changes', t => {
  const f = fixture(t);
  f.explorer.setActive(true);
  const selected = f.explorer.snapshot(), held = {...selected};
  selected.time = -1;
  selected.seriesId = 'outside';
  selected.text = 'outside';
  assert.deepEqual(f.explorer.snapshot(), held);
  const result = f.explorer.read(), read = {...result};
  scalarSnapshot(result);
  f.explorer.key('Home');
  assert.deepEqual(result, read);
  const query = f.api.dataAt;
  f.api.dataAt = (...args) => {const value = query(...args); value.series[0].panel = 'p'.repeat(5000); return value;};
  assert.equal(f.explorer.read().text.length, 4096);
  f.explorer.dispose();
  assert.deepEqual(result, read);
  assert.deepEqual(f.explorer.snapshot(), off);
});

for (const action of ['disable', 'dispose', 'owner', 'selection', 'changed', 'source', 'display']) {
  test(`trusted lazy callback ${action} rejects stale in-flight readout publication`, t => {
    const f = fixture(t);
    let replacement;
    const computation = lazy(f, () => {
      computation.disarm();
      if (action === 'disable') f.explorer.setActive(false);
      if (action === 'dispose') f.explorer.dispose();
      if (action === 'owner') {replacement = new ChartModel(); f.api.model = replacement;}
      if (action === 'selection') f.explorer.key('Home');
      if (action === 'changed') f.explorer.changed();
      if (action === 'source') f.store.update(0, {...f.store.at(0), close: 13});
      if (action === 'display') f.api.setPanel('price', {label: 'Changed'});
    });
    t.after(() => replacement?.dispose());
    f.explorer.setActive(true);
    computation.dirty();
    assert.throws(() => f.explorer.read(), stale);
    assert.equal(f.queries.length, 1);
    assert.equal(f.explorer.busy, false);
    assert.notEqual(f.explorer.snapshot().phase, 'read');
    assert.doesNotMatch(f.explorer.snapshot().text, /Open \d/);
    if (action === 'disable' || action === 'dispose') assert.deepEqual(f.explorer.snapshot(), off);
    if (action === 'dispose') {assert.equal(f.explorer.api, null); assert.equal(f.explorer.model, null);}
    if (action === 'selection') assert.equal(f.explorer.snapshot().time, bars[0].time);
    if (action === 'changed') assert.equal(f.explorer.snapshot().phase, 'changed');
    if (action === 'disable') {f.explorer.setActive(true); assert.equal(f.explorer.read().phase, 'read');}
  });
}

test('same-explorer read reentry fails before a second query and releases busy state for retry', t => {
  const f = fixture(t);
  const computation = lazy(f, () => {computation.disarm(); f.explorer.read();});
  f.explorer.setActive(true);
  computation.dirty();
  assert.throws(() => f.explorer.read(), /already running/i);
  assert.equal(f.queries.length, 1);
  assert.equal(f.explorer.busy, false);
  assert.equal(f.explorer.snapshot().phase, 'error');
  assert.match(f.explorer.snapshot().text, /Press Enter to retry/);
  assert.equal(f.explorer.read().phase, 'read');
  assert.equal(f.queries.length, 2);
});

test('failed reads publish a bounded retry message and propagate the original failure', t => {
  const f = fixture(t), failure = new Error('trusted failure ' + 'x'.repeat(5000));
  const computation = lazy(f, () => {computation.disarm(); throw failure;});
  f.explorer.setActive(true);
  computation.dirty();
  assert.throws(() => f.explorer.read(), error => error === failure);
  const result = f.explorer.snapshot();
  assert.equal(result.phase, 'error');
  assert.doesNotMatch(result.text, /trusted failure/);
  scalarSnapshot(result);
  assert.equal(f.explorer.busy, false);
  assert.equal(f.explorer.read().phase, 'read');
});

test('Escape resets selection without query and dispose drops API/model references idempotently', t => {
  const f = fixture(t);
  f.explorer.setActive(true);
  assert.equal(f.explorer.key('Escape'), true);
  assert.deepEqual(f.explorer.snapshot(), off);
  f.explorer.setActive(true);
  f.explorer.dispose();
  f.explorer.dispose();
  assert.equal(f.explorer.api, null);
  assert.equal(f.explorer.model, null);
  assert.deepEqual(f.explorer.snapshot(), off);
  assert.equal(f.explorer.changed(), false);
  assert.throws(() => f.explorer.key('Enter'), /disposed/i);
  assert.throws(() => f.explorer.read(), /disposed/i);
  assert.throws(() => f.explorer.setActive(true), /disposed/i);
  assert.equal(f.queries.length, 0);
  assert.notEqual(f.model.disposed, true, 'explorer does not own the host model lifetime');
});

test('input eligibility is canvas-only and ignores consumed, composing or modified input without consuming it', () => {
  const canvas = {}, child = {}, other = {};
  let consumed = 0;
  const event = patch => ({target: canvas, defaultPrevented: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {consumed++;}, stopPropagation() {consumed++;}, ...patch});
  assert.equal(explorerInputAllowed(event(), canvas), true);
  for (const patch of [{target: child}, {target: other}, {target: null}, {defaultPrevented: true}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}, {shiftKey: true}]) {
    assert.equal(explorerInputAllowed(event(patch), canvas), false, JSON.stringify(patch));
  }
  assert.equal(consumed, 0);
});
