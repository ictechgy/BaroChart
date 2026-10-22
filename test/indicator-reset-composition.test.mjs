import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators, portableSessionCalendar} from '../src/core/index.mjs';

const minute = 60000, origin = Date.parse('2026-10-18T00:00:00Z');
const params = {period: 5, atrPeriod: 4, fast: 3, slow: 7, signal: 3, conversion: 3,
  base: 5, span: 7, displacement: 4, stochPeriod: 4, smoothK: 2, smoothD: 2, sessionMs: 30 * minute};
const bar = (i, price = 100 + i % 11, volume = (i % 7 + 7) % 7) => ({time: origin + i * minute,
  open: price, high: price + 1, low: price - 1, close: price, volume});
const calendar = portableSessionCalendar({timezone: 'UTC', weekdays: [0, 1, 2, 3, 4, 5, 6],
  windows: [{open: '00:00', close: '00:20'}, {open: '00:30', close: '02:00'}]});
const specs = [...builtinIndicators.keys()].map(name => ({label: name, name, params}));
specs.push({label: 'calendar VWAP', name: 'vwap', params: {calendar, deviation: 2}},
  {label: 'anchored calendar VWAP', name: 'vwap', params: {calendar, deviation: 2, anchorTime: origin + 10 * minute}},
  {label: 'calendar pivots', name: 'pivots', params: {calendar}});

// Exact fresh-engine equivalence, not an independent indicator-formula oracle.
// Unlike a fresh engine fed from the possibly broken store, expected rows here
// are maintained separately and checked before calculating expected outputs.
function lifecycle(spec, checkpointSize, {makeEngine = (store, options) => new IndicatorEngine(store, options), alter = () => {}} = {}) {
  let expected = Array.from({length: 35}, (_, i) => bar(i));
  const store = new BarStore(expected), engine = makeEngine(store, {checkpointSize}), stages = [];
  const reset = rows => {expected = rows; store.setData(rows);};
  const check = stage => {
    const label = `${spec.label}, checkpoint ${checkpointSize}, ${stage}`;
    assert.deepEqual(Array.from({length: store.length}, (_, i) => store.at(i)), expected, label + ': source');
    assert.deepEqual(store.listenerErrors, [], label + ': listener errors');
    const freshStore = new BarStore(expected), fresh = new IndicatorEngine(freshStore, {checkpointSize});
    try {
      const want = fresh.add('study', spec.name, spec.params), actual = engine.get('study');
      alter(stage, {store, engine, actual});
      assert.deepEqual(actual.outputs, want.outputs, label + ': outputs');
      assert.deepEqual(actual.plotOffsets, want.plotOffsets, label + ': plot offsets');
      stages.push(stage);
    } finally {fresh.dispose(); assert.equal(freshStore.listeners.size, 0, label + ': fresh cleanup');}
  };
  try {
    engine.add('study', spec.name, spec.params);
    reset([]); check('empty reset');
    expected.push(bar(0, 300)); store.append(expected[0]); check('append after empty');
    for (let i = 1; i < 18; i++) {expected.push(bar(i, 300 + i)); store.append(expected.at(-1));}
    check('refill with deferred reads');
    reset(Array.from({length: 19}, (_, i) => bar(200 + i * 5))); check('shorter reset with gaps');
    const prefix = [bar(190), bar(191)]; expected = [...prefix, ...expected]; store.prepend(prefix); check('prepend after reset');
    expected[0] = bar(190, 111, 12); expected[expected.length - 1] = bar(290, 90, 0);
    store.update(0, expected[0]); store.update(expected.length - 1, expected.at(-1)); check('deferred head and tail corrections');
    reset(Array.from({length: 65}, (_, i) => bar(i * 30))); check('longer reset across session dates');
    const appended = bar(1950, 123, 2), updated = {...appended, volume: 6}, corrected = {...expected[7], open: 101, close: 101, high: 102, low: 100};
    store.applyEvents([{kind: 'append', bar: appended}, {kind: 'update', bar: updated}, {kind: 'correction', bar: corrected}]);
    expected.push(updated); expected[7] = corrected; check('append update correction batch');
    assert.equal(stages.length, 8); return stages;
  } finally {engine.dispose(); assert.equal(store.listeners.size, 0, 'incremental cleanup');}
}

for (const spec of specs) test(`${spec.label}: empty/refill/reset/prepend/deferred correction composition`, () => {
  // Dense checkpoints, a non-power-of-two boundary, and a history-sized block.
  for (const size of [1, 7, 64]) assert.equal(lifecycle(spec, size).length, 8);
});

test('negative control: dropping only reset invalidation is detected', t => {
  let failure;
  try {lifecycle(specs.find(spec => spec.name === 'ema'), 7, {makeEngine(store, options) {
    const subscribe = store._subscribeInternal.bind(store);
    store._subscribeInternal = callback => subscribe(change => {if (change.kind !== 'reset') callback(change);});
    return new IndicatorEngine(store, options);
  }});} catch (error) {failure = error;}
  assert.ok(failure instanceof assert.AssertionError); assert.match(failure.message, /shorter reset with gaps: outputs/);
  t.diagnostic(failure.stack);
});

test('negative control: corrupted post-correction output cannot pass fresh equivalence', t => {
  assert.throws(() => lifecycle(specs.find(spec => spec.name === 'ema'), 7, {alter(stage, {actual}) {
    if (stage === 'deferred head and tail corrections') actual.outputs.value[7] += 1;
  }}), error => {t.diagnostic(error.stack); return error instanceof assert.AssertionError && /deferred head and tail corrections: outputs/.test(error.message);});
});
