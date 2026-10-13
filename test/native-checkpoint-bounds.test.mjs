import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeCheckpointBudget, NativeCheckpointMap, NativeCheckpointEntries, NATIVE_CHECKPOINT_RECORD_BYTES, NATIVE_CHECKPOINT_TOTAL_BYTES} from '../src/core/native-checkpoints.mjs';
import {BarStore, FIELDS, seededColumns} from '../src/core/data.mjs';
import {IndicatorEngine, builtinIndicators} from '../src/core/indicators.mjs';
import {checkpointFixtureName, checkpointProbe} from './fixtures/native-checkpoint-bounds-module.mjs';

const RECORD_BYTES = 262144, TOTAL_BYTES = 33554432;
const state = (index = 0, payload = null) => ({index, payload});
const records = (options = {}, params = {}) => new NativeCheckpointMap(checkpointFixtureName, params, options);
const jsonBytes = value => JSON.stringify(value).length * 2;
function exactRecord(index, token = 'x', bytes = RECORD_BYTES) {
  const available = bytes / 2 - JSON.stringify(state(index, '')).length;
  const tokenChars = JSON.stringify(token).length - 2;
  const value = state(index, token.repeat(Math.floor(available / tokenChars)) + 'x'.repeat(available % tokenChars));
  assert.equal(jsonBytes(value), bytes);
  return value;
}
function assertAccounting(budget, ...maps) {
  assert.equal(budget.usedBytes, maps.reduce((sum, map) => sum + map.encodedBytes, 0));
}

// A record is charged for its actual JSON UTF-16 storage, not UTF-8 or the
// length of the source string. Every case accepts equality and rejects +2B.
for (const [label, token] of [['ASCII', 'x'], ['quote escape', '"'], ['backslash escape', '\\'], ['control escape', '\0'], ['newline escape', '\n'], ['BMP Unicode', '한'], ['surrogate pair', '🚀']]) {
  test(`native checkpoint exact 256KiB boundary: ${label}`, () => {
    const budget = new NativeCheckpointBudget(), map = records({budget});
    const original = exactRecord(0, token);
    assert.equal(map.set(0, original), map);
    assert.equal(map.encodedBytes, RECORD_BYTES);
    assert.equal(budget.usedBytes, RECORD_BYTES);
    assert.deepEqual(map.get(0), original);
    assert.throws(() => map.set(0, state(0, original.payload + 'x')), /record.*limit/i);
    assert.equal(map.size, 1);
    assert.deepEqual(map.get(0), original);
    assertAccounting(budget, map);
    map.clear();
    assert.equal(budget.usedBytes, 0);
  });
}

test('native checkpoint byte accounting includes keys, escapes and safe-number markers', () => {
  const budget = new NativeCheckpointBudget(), map = records({budget});
  const original = state(0, {'한국 🚀"\\\n': [NaN, Infinity, -Infinity, -0, 0, null, true, false, '\u2028']});
  const text = JSON.stringify(original, (_key, value) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
    ? {$asterNumber: Object.is(value, -0) ? '-0' : String(value)} : value);
  map.set(0, original);
  assert.equal(map.encodedBytes, text.length * 2);
  assert.equal(budget.usedBytes, text.length * 2);
  const decoded = map.get(0), numbers = Object.values(decoded.payload)[0];
  assert.deepEqual(decoded, original);
  assert.ok(Number.isNaN(numbers[0]));
  assert.equal(numbers[1], Infinity);
  assert.equal(numbers[2], -Infinity);
  assert.ok(Object.is(numbers[3], -0));
  assert.ok(!Object.is(numbers[4], -0));
});

test('native checkpoints own input, validator state and every read independently', () => {
  const budget = new NativeCheckpointBudget(), params = {label: 'original'}, map = records({budget}, params);
  const shared = {value: 1}, original = state(0, {left: shared, right: shared, array: [[2]]});
  const expected = structuredClone(original);
  map.set(0, original);
  assert.notEqual(checkpointProbe.lastState, original);
  assert.notEqual(checkpointProbe.lastState.payload, original.payload);
  assert.ok(Object.isFrozen(checkpointProbe.lastParams));
  params.label = 'changed';
  original.payload.left.value = 20;
  original.payload.array[0].push(30);
  checkpointProbe.lastState.payload.left.value = 40;
  assert.deepEqual(map.get(0), expected);
  const bytes = budget.usedBytes, calls = checkpointProbe.calls;
  for (let i = 0; i < 20; i++) {
    const decoded = map.get(0);
    assert.deepEqual(decoded, expected);
    assert.notEqual(decoded.payload.left, decoded.payload.right);
    decoded.payload.array[0][0] = 99;
    decoded.payload.left.value = 99;
  }
  const [entry] = [...map];
  entry[1].payload.array.push('changed through iteration');
  assert.deepEqual(map.get(0), expected);
  assert.equal(map.get(256), undefined);
  assert.equal(map.has(0), true);
  assert.equal(map.has(256), false);
  assert.equal(checkpointProbe.calls, calls);
  assert.equal(budget.usedBytes, bytes);
  map.validateHistory(1);
  assert.equal(checkpointProbe.lastParams.label, 'original');
});

function malformedStates() {
  let effects = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {enumerable: true, get() {effects++; throw new Error('Accessor executed');}});
  const arrayAccessor = [0];
  Object.defineProperty(arrayAccessor, '0', {enumerable: true, get() {effects++; throw new Error('Array accessor executed');}});
  const toJSON = {toJSON() {effects++; throw new Error('toJSON executed');}};
  const cycle = {}; cycle.self = cycle;
  let deep = 0; for (let i = 0; i < 40; i++) deep = {nested: deep};
  const sparse = []; sparse.length = 2; sparse[1] = 1;
  const extraArray = [1]; extraArray.extra = 2;
  const symbolArray = [1]; symbolArray[Symbol('extra')] = 2;
  const hiddenArray = [1]; Object.defineProperty(hiddenArray, 'hidden', {value: 2});
  const hiddenObject = {}; Object.defineProperty(hiddenObject, 'hidden', {value: 2});
  const symbolObject = {[Symbol('hidden')]: 2};
  const inherited = Object.create({value: 1}); inherited.own = 2;
  const customArray = [1]; Object.setPrototypeOf(customArray, null);
  const bad = [
    ['undefined', undefined], ['function', () => 1], ['bigint', 1n], ['symbol', Symbol('value')],
    ['Date', new Date(0)], ['Map', new Map()], ['typed array', new Float64Array([1])], ['boxed number', new Number(1)],
    ['inherited prototype', inherited], ['custom array prototype', customArray], ['accessor', accessor], ['array accessor', arrayAccessor],
    ['toJSON', toJSON], ['sparse array', sparse], ['array fields', extraArray], ['array symbol', symbolArray],
    ['array hidden field', hiddenArray], ['object hidden field', hiddenObject], ['object symbol', symbolObject],
    ['cycle', cycle], ['depth', deep], ['lone high surrogate', '\ud800'], ['lone low surrogate', '\udfff'],
    ['malformed surrogate pair', '\ud800x'], ['invalid Unicode key', {'\ud800': 1}],
  ];
  for (const key of ['__proto__', 'prototype', 'constructor', 'toJSON', '$asterNumber']) {
    bad.push(['reserved key ' + key, Object.defineProperty({}, key, {value: 'NaN', enumerable: true})]);
  }
  bad.push(['raw nested number marker', [{nested: {$asterNumber: '-0'}}]]);
  return {bad: bad.map(([label, payload]) => [label, {index: 0, payload}]), effects: () => effects};
}

test('native checkpoints reject malformed structure before stringify or validator callbacks', () => {
  const budget = new NativeCheckpointBudget(), map = records({budget});
  const previous = state(0, ['preserved']); map.set(0, previous);
  const previousBytes = budget.usedBytes, {bad, effects} = malformedStates();
  bad.push(['oversized string', state(0, 'x'.repeat(RECORD_BYTES / 2))]);
  for (const [label, invalid] of bad) {
    const stringify = JSON.stringify, before = checkpointProbe.calls;
    let calls = 0;
    try {
      JSON.stringify = (...args) => {calls++; return stringify(...args);};
      assert.throws(() => map.set(0, invalid), {name: /TypeError|RangeError/}, label);
    } finally {JSON.stringify = stringify;}
    assert.equal(calls, 0, label + ' reached JSON.stringify');
    assert.equal(checkpointProbe.calls, before, label + ' reached the module validator');
    assert.equal(map.size, 1, label);
    assert.equal(map.encodedBytes, previousBytes, label);
    assert.equal(budget.usedBytes, previousBytes, label);
    assert.deepEqual(map.get(0), previous, label);
  }
  assert.equal(effects(), 0);
});

test('native checkpoints accept null-prototype data while decoding plain detached records', () => {
  const input = Object.assign(Object.create(null), {index: 0, payload: Object.assign(Object.create(null), {value: [1, 2]})});
  const map = records(); map.set(0, input);
  assert.deepEqual(map.get(0), state(0, {value: [1, 2]}));
  input.payload.value[0] = 9;
  assert.equal(map.get(0).payload.value[0], 1);
});

test('native checkpoint schemas reject invalid builtin and linked module states atomically', () => {
  const budget = new NativeCheckpointBudget(), map = new NativeCheckpointMap('ema', {period: 20}, {budget});
  const valid = {e: {count: 20, sum: 0, value: 1}};
  map.set(0, {}).set(256, valid);
  const before = budget.usedBytes;
  for (const invalid of [{}, {e: {count: 21, sum: 0, value: 1}}, {e: {count: 1, sum: 0, value: 1}},
    {e: {count: 20, sum: 0, value: Infinity}}, {e: {count: 20, sum: 0, value: '1'}}, {...valid, extra: 1}]) {
    assert.throws(() => map.set(256, invalid), /checkpoint/i);
    assert.deepEqual(map.get(256), valid);
    assert.equal(budget.usedBytes, before);
  }
  assert.throws(() => map.set(0, valid), /checkpoint/i);
  const moduleMap = records({budget});
  assert.throws(() => moduleMap.set(0, {index: 1, payload: null}), /fixture checkpoint/i);
  assert.throws(() => moduleMap.set(0, {index: 0}), /fixture checkpoint/i);
  assert.equal(moduleMap.size, 0);
  assert.equal(moduleMap.encodedBytes, 0);
  assert.equal(budget.usedBytes, before);
  assert.throws(() => new NativeCheckpointMap('not-a-builtin', {}).set(0, {}), /builtin name/i);
});

for (const mode of ['reject', 'mutate', 'replace', 'async', 'throw']) {
  test(`native checkpoint rejects module validator ${mode} without retaining input`, () => {
    const budget = new NativeCheckpointBudget(), keeper = records({budget}), map = records({budget}, {mode});
    keeper.set(0, state(0, 'unaffected'));
    const input = state(0, {nested: [NaN, -0]}), before = structuredClone(input), bytes = budget.usedBytes;
    assert.throws(() => map.set(0, input), /checkpoint|synchronous/i);
    assert.deepEqual(input, before);
    assert.equal(map.size, 0);
    assert.equal(map.encodedBytes, 0);
    assert.equal(budget.usedBytes, bytes);
    assert.deepEqual(keeper.get(0), state(0, 'unaffected'));
  });
}

test('validator-only hidden and symbol metadata never become stored checkpoint fields', () => {
  for (const mode of ['hidden', 'symbol']) {
    const budget = new NativeCheckpointBudget(), map = records({budget}, {mode}), original = state(0, {value: 1});
    map.set(0, original);
    assert.ok(Reflect.ownKeys(checkpointProbe.lastState).length > Reflect.ownKeys(original).length);
    assert.deepEqual(map.get(0), original);
    assert.deepEqual(Reflect.ownKeys(map.get(0)), ['index', 'payload']);
    assert.equal(map.encodedBytes, jsonBytes(original));
    assert.equal(map.validateHistory(1), map);
    assert.deepEqual(Reflect.ownKeys(map.get(0)), ['index', 'payload']);
    assertAccounting(budget, map);
  }
});

test('native checkpoint shared budget charges only replacement deltas and releases delete/clear', () => {
  const budget = new NativeCheckpointBudget(128), a = records({budget}), b = records({budget});
  a.set(0, exactRecord(0, 'a', 52)); b.set(0, exactRecord(0, 'b', 76));
  assert.equal(budget.usedBytes, 128);
  a.set(0, exactRecord(0, 'c', 52));
  assert.equal(a.size, 1);
  assert.equal(budget.usedBytes, 128);
  const aBefore = a.get(0), bBefore = b.get(0);
  assert.throws(() => a.set(0, exactRecord(0, 'd', 54)), /total.*limit/i);
  assert.throws(() => a.set(256, state(256)), /total.*limit/i);
  assert.deepEqual(a.get(0), aBefore); assert.deepEqual(b.get(0), bBefore);
  assert.equal(a.size, 1); assert.equal(budget.usedBytes, 128);
  a.set(0, exactRecord(0, 'e', 48));
  b.set(0, exactRecord(0, 'f', 80));
  assert.equal(budget.usedBytes, 128);
  assertAccounting(budget, a, b);
  assert.equal(a.delete(256), false);
  assert.equal(a.delete(0), true);
  assert.equal(a.delete(0), false);
  assert.equal(a.encodedBytes, 0);
  assert.equal(budget.usedBytes, 80);
  a.clear(); assert.equal(budget.usedBytes, 80);
  b.clear(); assert.equal(budget.usedBytes, 0);
  b.clear(); assert.equal(budget.usedBytes, 0);
  a.set(0, exactRecord(0, 'x', 128));
  assert.equal(budget.usedBytes, 128);
  assertAccounting(budget, a, b);
});

test('native checkpoint default aggregate 32MiB cap is shared across maps at equality', () => {
  assert.equal(NATIVE_CHECKPOINT_RECORD_BYTES, RECORD_BYTES);
  assert.equal(NATIVE_CHECKPOINT_TOTAL_BYTES, TOTAL_BYTES);
  const budget = new NativeCheckpointBudget(), a = records({budget, block: 1}), b = records({budget, block: 1});
  assert.equal(budget.maxBytes, TOTAL_BYTES);
  try {
    // Only 128 small checkpoint indices, with independently measured full-size
    // records, exercise the real cap rather than a reduced test substitute.
    for (let i = 0; i < 128; i++) (i < 64 ? a : b).set(i, exactRecord(i));
    assert.equal(a.encodedBytes, TOTAL_BYTES / 2);
    assert.equal(b.encodedBytes, TOTAL_BYTES / 2);
    assert.equal(budget.usedBytes, TOTAL_BYTES);
    assert.throws(() => b.set(128, state(128)), /total.*limit/i);
    assert.equal(b.size, 64);
    assert.equal(budget.usedBytes, TOTAL_BYTES);
    a.set(0, exactRecord(0, 'z'));
    assert.equal(budget.usedBytes, TOTAL_BYTES);
    assert.equal(a.delete(0), true);
    b.set(128, exactRecord(128));
    assert.equal(budget.usedBytes, TOTAL_BYTES);
    assertAccounting(budget, a, b);
    a.clear(); assert.equal(budget.usedBytes, 65 * RECORD_BYTES);
  } finally {a.clear(); b.clear();}
  assert.equal(budget.usedBytes, 0);
});

test('native checkpoint context, budget, index and history bounds reject malformed numbers', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '128', TOTAL_BYTES + 1]) assert.throws(() => new NativeCheckpointBudget(value));
  const emptyBudget = new NativeCheckpointBudget(0), empty = records({budget: emptyBudget});
  assert.throws(() => empty.set(0, state()), /total.*limit/i);
  assert.equal(empty.size, 0); assert.equal(emptyBudget.usedBytes, 0);
  for (const block of [0, -1, 1.5, NaN, Infinity, '256', 4194305]) assert.throws(() => records({block}));
  for (const budget of [null, {}, new Map()]) assert.throws(() => records({budget}));
  for (const name of ['', null, 1]) assert.throws(() => new NativeCheckpointMap(name, {}));
  assert.throws(() => records({}, {period: undefined}));
  const map = records();
  for (const index of [-1, 1, 255, 257, 1.5, NaN, Infinity, '0', 0n, 4194305]) {
    assert.throws(() => map.set(index, state(0)), /index/i);
    assert.equal(map.size, 0);
  }
  for (const length of [-1, 1.5, NaN, Infinity, '0', 4194305]) assert.throws(() => map.validateHistory(length), /history length/i);
  map.set(4194304, state(4194304));
  assert.equal(map.has(4194304), true);
});

test('native checkpoint iteration is ordered and history requires every exact block boundary', () => {
  const map = records(), before = checkpointProbe.calls;
  assert.equal(map.validateHistory(0), map);
  assert.throws(() => map.validateHistory(1), /history count/i);
  map.set(512, state(512, 'last')).set(0, state(0, 'first')).set(256, state(256, 'middle'));
  const validated = checkpointProbe.calls;
  assert.deepEqual([...map.keys()], [0, 256, 512]);
  assert.deepEqual([...map], [[0, state(0, 'first')], [256, state(256, 'middle')], [512, state(512, 'last')]]);
  assert.equal(checkpointProbe.calls, validated);
  assert.ok(validated > before);
  assert.equal(map.validateHistory(512), map);
  assert.equal(map.validateHistory(767), map);
  for (const length of [0, 1, 255, 256, 511, 768]) assert.throws(() => map.validateHistory(length), /history count/i);
  map.delete(0); map.set(768, state(768));
  assert.throws(() => map.validateHistory(512), /history boundary/i);
  const custom = records({block: 64});
  custom.set(128, state(128)).set(64, state(64)).set(0, state(0));
  assert.equal(custom.validateHistory(128), custom);
  assert.equal(custom.validateHistory(191), custom);
  assert.throws(() => custom.set(256 + 1, state(257)), /index/i);
});

test('native checkpoint history validation rejects later validator mutation without changing records or budget', () => {
  const budget = new NativeCheckpointBudget(), map = records({budget});
  map.set(0, state(0, [1])).set(256, state(256, [2]));
  const previous = [...map], bytes = budget.usedBytes;
  checkpointProbe.mutateHistory = true;
  try {assert.throws(() => map.validateHistory(300), /mutated/i);}
  finally {checkpointProbe.mutateHistory = false;}
  assert.deepEqual([...map], previous);
  assert.equal(budget.usedBytes, bytes);
  assert.equal(map.validateHistory(300), map);
});

function compareOutputs(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), label);
  for (const key of Object.keys(expected)) {
    assert.equal(actual[key].length, expected[key].length, label + ':' + key);
    for (let i = 0; i < expected[key].length; i++) {
      const a = actual[key][i], e = expected[key][i];
      assert.ok(Object.is(a, e) || Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(e)), `${label}:${key}[${i}] ${a} != ${e}`);
    }
  }
}
function builtinTarget(names, block = 256, params = {}) {
  const store = new BarStore(), engine = new IndicatorEngine(store, {checkpointSize: block}), budget = new NativeCheckpointBudget();
  engine.entries = new NativeCheckpointEntries();
  for (const name of names) {
    engine.add(name, name, params);
    // add() on an empty store calculates no rows; the native map is installed
    // before the first snapshot. The ordinary engine implementation is intact.
    const entry = engine.entries.get(name);
    entry.checkpoints = new NativeCheckpointMap(name, params, {budget, block});
    engine.entries.set(name, entry);
  }
  return {store, engine, budget, names, params, block};
}
function compareFresh(target, phase) {
  const {store, engine, budget, names, params, block} = target;
  const freshStore = new BarStore(), fresh = new IndicatorEngine(freshStore, {checkpointSize: block});
  freshStore.setColumns(store.columns, store.length);
  try {
    for (const name of names) {
      const actual = engine.get(name), expected = fresh.add(name, name, params);
      compareOutputs(actual.outputs, expected.outputs, phase + ':' + name);
      assert.deepEqual(actual.plotOffsets, expected.plotOffsets, phase + ':' + name);
      const map = engine.entries.get(name).checkpoints;
      assert.equal(map.validateHistory(store.length), map);
      assert.deepEqual([...map.keys()], store.length ? Array.from({length: Math.floor(store.length / block) + 1}, (_, i) => i * block) : []);
    }
    assertAccounting(budget, ...[...engine.entries.values()].map(entry => entry.checkpoints));
  } finally {fresh.dispose();}
}

test('all builtin native checkpoints match fresh engine across initial, update, append, correction and reset', () => {
  const target = builtinTarget([...builtinIndicators.keys()]), columns = seededColumns(1025, 713);
  const row = i => Object.fromEntries(FIELDS.map(key => [key, columns[key][i]]));
  try {
    target.store.setColumns(columns, 511); compareFresh(target, 'initial 511');
    for (const i of [511, 512]) {target.store.append(row(i)); compareFresh(target, 'append ' + i);}
    for (const i of [512, 512, 255, 256, 0]) {
      const bar = target.store.at(i);
      target.store.update(i, {...bar, close: bar.high, volume: bar.volume + 3});
      compareFresh(target, 'update/correction ' + i);
    }
    target.store.applyEvents([{kind: 'correction', bar: {...target.store.at(257), close: target.store.at(257).low}}, {kind: 'append', bar: row(513)}]);
    compareFresh(target, 'batch correction and append');
    target.store.setColumns(columns, 1024); compareFresh(target, 'reset exact boundary');
    const retainedMaps = [...target.engine.entries.values()].map(entry => entry.checkpoints);
    target.store.setData([]); compareFresh(target, 'empty reset');
    assert.deepEqual([...target.engine.entries.values()].map(entry => entry.checkpoints), retainedMaps);
    assert.equal(target.budget.usedBytes, 0);
    target.store.setColumns(columns, 257); compareFresh(target, 'reload after empty');
  } finally {
    target.engine.dispose();
  }
  assert.equal(target.budget.usedBytes, 0);
  assert.equal(target.store.listeners.size, 0);
});

test('custom checkpoint block keeps long warm-up, zero-volume and flat builtin outputs aligned', () => {
  const target = builtinTarget(['ema', 'rsi', 'macd', 'stochRSI', 'donchian', 'bollinger', 'vwap', 'pivots', 'parabolicSAR'], 64, {period: 1000});
  const bars = Array.from({length: 257}, (_, i) => ({time: i * 60000, open: 0, high: 0, low: 0, close: 0, volume: 0}));
  try {
    target.store.setData(bars.slice(0, 256)); compareFresh(target, 'flat warm-up');
    target.store.append(bars[256]); compareFresh(target, 'flat append');
    target.store.update(64, {...bars[64], high: 2, close: 2, volume: 10}); compareFresh(target, 'non-flat correction');
  } finally {
    target.engine.dispose();
  }
  assert.equal(target.budget.usedBytes, 0);
});


test('native checkpoint clear is reusable while dispose is terminal and idempotent', () => {
  const budget = new NativeCheckpointBudget(), map = records({budget});
  map.set(0, state(0, [1]));
  map.clear();
  assert.equal(budget.usedBytes, 0);
  assert.equal(map.validateHistory(0), map);
  map.set(0, state(0, [2]));
  assert.deepEqual(map.get(0), state(0, [2]));
  map.clear = () => {throw new Error('Overridden clear must not run');};
  map.dispose();
  map.dispose();
  assert.equal(map.size, 0);
  assert.equal(map.encodedBytes, 0);
  assert.equal(budget.usedBytes, 0);
  assert.throws(() => map.get(0), /disposed/i);
  assert.throws(() => map.set(0, state()), /disposed/i);
  assert.throws(() => map.validateHistory(0), /disposed/i);
  assert.equal(budget.usedBytes, 0);
});

for (const operation of ['clear', 'delete', 'set', 'dispose']) {
  for (const method of ['set', 'validateHistory']) {
    test(`native checkpoint ${method} rejects ${operation} reentry and preserves the nested action`, () => {
      const budget = new NativeCheckpointBudget(), map = records({budget});
      map.set(0, state(0, 'old')).set(256, state(256, 'old suffix'));
      let reentered = 0;
      checkpointProbe.onValidate = () => {
        checkpointProbe.onValidate = null;
        reentered++;
        if (operation === 'clear') map.clear();
        else if (operation === 'delete') map.delete(0);
        else if (operation === 'set') map.set(256, state(256, 'new suffix'));
        else map.dispose();
      };
      try {
        assert.throws(() => method === 'set' ? map.set(0, state(0, 'outer candidate')) : map.validateHistory(300), /changed during validation|disposed/i);
      } finally {checkpointProbe.onValidate = null;}
      assert.equal(reentered, 1);
      if (operation === 'dispose') {
        assert.equal(map.size, 0);
        assert.equal(budget.usedBytes, 0);
        assert.throws(() => map.get(0), /disposed/i);
      } else {
        const expected = operation === 'clear' ? [] : operation === 'delete'
          ? [[256, state(256, 'old suffix')]]
          : [[0, state(0, 'old')], [256, state(256, 'new suffix')]];
        assert.deepEqual([...map], expected);
        assert.equal(budget.usedBytes, expected.reduce((sum, [, value]) => sum + jsonBytes(value), 0));
        assertAccounting(budget, map);
      }
      map.dispose();
      assert.equal(budget.usedBytes, 0);
    });
  }
}

test('owned native entries release only retired checkpoint maps and preserve output vectors', () => {
  const budget = new NativeCheckpointBudget(), entries = new NativeCheckpointEntries();
  const checkpointMaps = [records({budget}), records({budget}), records({budget})];
  for (const [index, map] of checkpointMaps.entries()) map.set(0, state(0, index));
  const vectors = checkpointMaps.map((_, index) => new Float64Array([index, NaN, -0]));
  const saved = vectors.map(vector => vector.slice());
  const owned = checkpointMaps.map((checkpoints, index) => ({checkpoints, arrays: [vectors[index]]}));
  const originalBytes = budget.usedBytes;
  let callbacks = 0;
  for (const map of checkpointMaps) {
    map.clear = map.dispose = () => {callbacks++; throw new Error('Public cleanup override ran');};
  }
  assert.equal(entries.set('first', owned[0]), entries);
  entries.set('first', owned[0]);
  assert.equal(budget.usedBytes, originalBytes);
  assert.deepEqual(checkpointMaps[0].get(0), state(0, 0));
  entries.set('first', owned[1]);
  assert.throws(() => checkpointMaps[0].get(0), /disposed/i);
  assert.equal(budget.usedBytes, checkpointMaps[1].encodedBytes + checkpointMaps[2].encodedBytes);
  assert.equal(entries.delete('missing'), false);
  entries.set('second', owned[2]);
  assert.equal(entries.delete('first'), true);
  assert.equal(entries.delete('first'), false);
  assert.throws(() => checkpointMaps[1].set(0, state()), /disposed/i);
  assert.equal(budget.usedBytes, checkpointMaps[2].encodedBytes);
  entries.clear();
  entries.clear();
  assert.throws(() => checkpointMaps[2].validateHistory(0), /disposed/i);
  assert.equal(budget.usedBytes, 0);
  assert.equal(entries.size, 0);
  assert.equal(callbacks, 0);
  for (let i = 0; i < vectors.length; i++) assert.deepEqual(vectors[i], saved[i]);
});

test('native entry retirement does not invoke arbitrary checkpoint fields or ordinary Map cleanup', () => {
  const entries = new NativeCheckpointEntries(), ordinary = new Map([[0, state()]]);
  let callbacks = 0;
  ordinary.clear = ordinary.dispose = () => {callbacks++; throw new Error('Foreign cleanup ran');};
  entries.set('foreign', {checkpoints: ordinary});
  entries.set('accessor', {get checkpoints() {callbacks++; throw new Error('Checkpoint getter ran');}});
  entries.set('accessor', {checkpoints: ordinary});
  entries.delete('foreign');
  entries.clear();
  assert.equal(callbacks, 0);
  assert.equal(ordinary.size, 1);
});

test('ordinary engine remove and dispose release owned native budgets without clearing held outputs', () => {
  const target = builtinTarget(['ema', 'rsi', 'bollinger']);
  target.store.setColumns(seededColumns(512, 29));
  const held = target.names.map(name => target.engine.get(name).outputs);
  const snapshots = held.map(outputs => Object.fromEntries(Object.entries(outputs).map(([name, values]) => [name, values.slice()])));
  const maps = target.names.map(name => target.engine.entries.get(name).checkpoints);
  const before = target.budget.usedBytes, removedBytes = maps[0].encodedBytes;
  target.engine.remove('ema');
  assert.equal(target.budget.usedBytes, before - removedBytes);
  assert.throws(() => maps[0].get(0), /disposed/i);
  target.engine.dispose();
  assert.equal(target.budget.usedBytes, 0);
  assert.equal(target.store.listeners.size, 0);
  for (let i = 0; i < maps.length; i++) {
    assert.throws(() => maps[i].get(0), /disposed/i);
    assert.deepEqual(held[i], snapshots[i]);
  }
});


test('native entry ownership rejects aliases and retired maps without losing live accounting', () => {
  const budget = new NativeCheckpointBudget(), checkpoints = records({budget});
  checkpoints.set(0, state());
  const original = {checkpoints}, entries = new NativeCheckpointEntries([['one', original]]), bytes = budget.usedBytes;
  assert.throws(() => entries.set('two', {checkpoints}), /ownership/i);
  assert.equal(entries.has('two'), false);
  assert.equal(entries.get('one'), original);
  assert.equal(budget.usedBytes, bytes);
  const replacement = {checkpoints, arrays: [new Float64Array([1])]};
  entries.set('one', replacement);
  assert.equal(entries.get('one'), replacement);
  assert.deepEqual(checkpoints.get(0), state());
  assert.equal(budget.usedBytes, bytes);
  entries.delete('one');
  assert.throws(() => entries.set('retired', {checkpoints}), /ownership/i);
  assert.equal(entries.size, 0);
  assert.equal(budget.usedBytes, 0);
});

test('native entry retirement tracks its captured map despite later entry-field changes', () => {
  const budget = new NativeCheckpointBudget(), checkpoints = records({budget}), entry = {checkpoints};
  checkpoints.set(0, state(0, 'owned'));
  const entries = new NativeCheckpointEntries([['owned', entry]]);
  entry.checkpoints = new Map();
  entries.delete('owned');
  assert.equal(budget.usedBytes, 0);
  assert.throws(() => checkpoints.get(0), /disposed/i);
  // A prototype-only impostor has no private native records and must not make
  // retirement invoke a captured method with the wrong private-field brand.
  entries.set('impostor', {checkpoints: Object.create(NativeCheckpointMap.prototype)});
  entries.clear();
  assert.equal(entries.size, 0);
});

test('native checkpoint budget charging ignores public replacement callbacks and rejects ledger impostors', () => {
  const budget = new NativeCheckpointBudget(48), map = records({budget});
  let calls = 0;
  budget.replace = () => {calls++; throw new Error('Public ledger callback ran');};
  map.set(0, exactRecord(0, 'x', 48));
  assert.throws(() => map.set(256, state(256)), /total.*limit/i);
  map.clear();
  assert.equal(budget.usedBytes, 0);
  assert.equal(calls, 0);
  assert.throws(() => records({budget: Object.create(NativeCheckpointBudget.prototype)}), /context/i);
});

test('native entry constructor validates the complete final ownership set before adopting input maps',()=>{
 const budget=new NativeCheckpointBudget(),a=records({budget}),b=records({budget});a.set(0,state());b.set(0,state());const bytes=budget.usedBytes;
 assert.throws(()=>new NativeCheckpointEntries([['x',{checkpoints:a}],['x',{checkpoints:b}],['y',{checkpoints:b}]]),/ownership/);
 assert.deepEqual(a.get(0),state());assert.deepEqual(b.get(0),state());assert.equal(budget.usedBytes,bytes);
 // Map-compatible duplicate ids choose the final value; a shadowed input never
 // becomes owned and therefore must remain available to its original caller.
 const entries=new NativeCheckpointEntries([['x',{checkpoints:a}],['x',{checkpoints:b}]]);entries.clear();
 assert.deepEqual(a.get(0),state());assert.throws(()=>b.get(0),/disposed/);a.dispose();assert.equal(budget.usedBytes,0);
});
test('native checkpoint ownership cannot be shared across entry registries',()=>{
 const budget=new NativeCheckpointBudget(),map=records({budget});map.set(0,state());const first=new NativeCheckpointEntries([['one',{checkpoints:map}]]),second=new NativeCheckpointEntries();
 assert.throws(()=>second.set('one',{checkpoints:map}),/ownership/);assert.throws(()=>new NativeCheckpointEntries([['one',{checkpoints:map}]]),/ownership/);
 second.clear();assert.deepEqual(map.get(0),state());assert.equal(first.size,1);assert.equal(budget.usedBytes,map.encodedBytes);
 first.clear();assert.equal(budget.usedBytes,0);assert.throws(()=>second.set('one',{checkpoints:map}),/ownership/);
});
test('native entry constructor iterator failure leaves all checkpoint ownership with callers',()=>{
 const budget=new NativeCheckpointBudget(),a=records({budget}),b=records({budget});a.set(0,state());b.set(0,state());const bytes=budget.usedBytes;
 function* broken(){yield ['a',{checkpoints:a}];throw Error('iterator failed');}
 assert.throws(()=>new NativeCheckpointEntries(broken()),/iterator failed/);assert.equal(budget.usedBytes,bytes);assert.deepEqual(a.get(0),state());
 const entries=new NativeCheckpointEntries([['a',{checkpoints:a}],['b',{checkpoints:b}]]);entries.clear();assert.equal(budget.usedBytes,0);
});
