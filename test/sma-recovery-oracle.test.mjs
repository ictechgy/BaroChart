import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators, FIELDS} from '../src/core/index.mjs';
import {safeCheckpointParse, safeCheckpointStringify, validateCheckpointState} from '../src/core/checkpoint-validation.mjs';

// Independent reference for a recovery/rebase: visit the current source window
// oldest first and add raw Float64 values. This is deliberately neither an exact
// real-number sum nor a compensated/scaled mean. Overflow remains a NaN gap even
// when dividing the mathematical sum by the period would yield a finite value.
function fifoReference(rows, period, source = 'close') {
  let finiteRun = 0;
  return rows.map((row, i) => {
    const value = row[source];
    finiteRun = Number.isFinite(value) ? finiteRun + 1 : 0;
    if (finiteRun < period) return NaN;
    if (period === 1) return value;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += rows[j][source];
    return Number.isFinite(sum) ? sum / period : NaN;
  });
}

// Separate, pre-fix ordinary-market baseline. It does not call a production
// helper and intentionally keeps the legacy recurrence/rounding order.
function legacyReference(rows, period, source = 'close') {
  const window = [];
  let sum = 0;
  return rows.map(row => {
    const value = row[source];
    if (!Number.isFinite(value)) {window.length = 0; sum = 0; return NaN;}
    if (window.length < period) sum += value;
    else sum += value - window.shift();
    window.push(value);
    return window.length === period ? sum / period : NaN;
  });
}

function bar(index, close) {
  return {time: index * 60000, open: close, high: close, low: close, close, volume: 1};
}
const rowsOf = values => values.map((value, index) => bar(index, value));

function marketRows(count, start = 0) {
  let seed = 0x45cc702b;
  const next = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;};
  return Array.from({length: count}, (_, i) => {
    const close = 100 + (next() % 15001) / 100;
    const open = close + ((next() % 201) - 100) / 100;
    return {...bar(start + i, close), open, high: Math.max(open, close) + 2.1,
      low: Math.min(open, close) - 1.7, volume: (next() % 100001) / 10};
  });
}

function compare(actual, expected, label, exact = false) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const got = actual[i], want = expected[i], point = `${label}[${i}]`;
    if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${point}: expected NaN, got ${got}`);
    else if (exact) assert.ok(Object.is(got, want), `${point}: expected ${Object.is(want, -0) ? '-0' : want}, got ${Object.is(got, -0) ? '-0' : got}`);
    else {
      assert.ok(Number.isFinite(got), `${point}: expected finite, got ${got}`);
      const tolerance = 1e-12 + 1e-12 * Math.abs(want);
      assert.ok(Math.abs(got - want) <= tolerance, `${point}: ${got} != ${want}, tolerance ${tolerance}`);
    }
  }
}

function definition(params = {}) {
  const def = builtinIndicators.get('sma')(params);
  assert.deepEqual(def.outputs, ['value']);
  assert.deepEqual(def.plotOffsets, {});
  return def;
}

function stream(rows, params = {}) {
  const instance = definition(params).create();
  return rows.map((row, i) => {
    const output = instance.step(row, i);
    assert.equal(output.length, 1, `output arity at ${i}`);
    return output[0];
  });
}

function fixture(t, rows, params = {}, checkpointSize = 4) {
  const store = new BarStore(rows), engine = new IndicatorEngine(store, {checkpointSize});
  t.after(() => engine.dispose());
  engine.add('s', 'sma', params);
  return {store, engine, check(label, expectedRows = rows, exact = false) {
    const result = engine.get('s');
    assert.deepEqual(Object.keys(result.outputs), ['value']);
    assert.deepEqual(result.plotOffsets, {});
    compare(result.outputs.value, fifoReference(expectedRows, params.period ?? 20, params.source ?? 'close'), label, exact);
    return result;
  }};
}

const analyticCases = [
  {name: 'period-one opposite large values', period: 1, values: [-1e308, 1e308], expected: [-1e308, 1e308]},
  {name: 'positive raw-sum overflow and finite-window recovery', period: 2, values: [1e308, 1e308, 1, 1], expected: [NaN, NaN, 5e307, 1]},
  {name: 'negative raw-sum overflow and finite-window recovery', period: 2, values: [-1e308, -1e308, -1, -1], expected: [NaN, NaN, -5e307, -1]},
  {name: 'positive dominant eviction', period: 2, values: [1e16, 1, 2], expected: [NaN, 5e15, 1.5]},
  {name: 'negative dominant eviction', period: 2, values: [-1e16, -1, -2], expected: [NaN, -5e15, -1.5]},
  {name: 'positive cancellation and consecutive eviction', period: 3, values: [1e35, -1e35, 1, 0, 0], expected: [NaN, NaN, 1 / 3, -1e35 / 3, 1 / 3]},
  {name: 'negative cancellation and consecutive eviction', period: 3, values: [-1e35, 1e35, -1, 0, 0], expected: [NaN, NaN, -1 / 3, 1e35 / 3, -1 / 3]},
];

for (const {name, period, values, expected} of analyticCases) {
  test(`SMA analytic ${name}: independent reference and direct definition`, () => {
    const rows = rowsOf(values);
    compare(fifoReference(rows, period), expected, `${name}/analytic reference`, true);
    compare(stream(rows, {period}), expected, `${name}/definition`, true);
  });
  test(`SMA analytic ${name}: engine emits only finite values or NaN`, t => {
    const rows = rowsOf(values), f = fixture(t, rows, {period});
    compare(f.check(name, rows, true).outputs.value, expected, `${name}/engine`, true);
  });
}

test('SMA period 1 preserves every finite source including signed zero and subnormals', t => {
  const rows = rowsOf([-0, 0, -Number.MIN_VALUE, Number.MIN_VALUE, -1e308, 1e308, -0]);
  for (const source of ['close', 'open', 'high', 'low']) {
    const expected = rows.map(row => row[source]);
    compare(stream(rows, {period: 1, source}), expected, `period-one ${source}`, true);
    compare(fixture(t, rows, {period: 1, source}).check(source, rows, true).outputs.value, expected, `engine ${source}`, true);
  }
  const volumeRows = [0, -0, Number.MIN_VALUE, 12, 0].map((volume, i) => ({...bar(i, 3), volume}));
  compare(stream(volumeRows, {period: 1, source: 'volume'}), volumeRows.map(row => row.volume), 'signed-zero volume', true);
  fixture(t, volumeRows, {period: 1, source: 'volume'}).check('engine signed-zero volume', volumeRows, true);
});

test('SMA raw FIFO semantics do not promise exact-real cancellation of huge, small, opposite-huge', t => {
  const rows = rowsOf([1e35, 1, -1e35, 0, 0, 3]);
  const expected = fifoReference(rows, 3);
  assert.equal(expected[2], 0, 'raw Float64 addition loses the unit; exact-real mean would be 1/3');
  assert.equal(expected[5], 1, 'ordinary finite window recovers after both huge values leave');
  compare(stream(rows, {period: 3}), expected, 'raw FIFO contract', true);
  fixture(t, rows, {period: 3}).check('engine raw FIFO contract', rows, true);
});

test('SMA forced rebase walks a rotated ring in FIFO rather than physical array order', () => {
  const params = {period: 3}, instance = definition(params).create();
  const old = {r: {a: [-1e35, 1e35, 1], head: 0, sum: NaN}};
  validateCheckpointState('sma', params, old, 3);
  instance.restore(old);
  // Replacing a[0] advances head to 1. Physical iteration would sum to 1,
  // but FIFO [1e35, 1, -1e35] sums to 0 under the narrow recovery contract.
  assert.equal(instance.step(bar(3, -1e35), 3)[0], 0);
  const expected = fifoReference(rowsOf([-1e35, 1e35, 1, -1e35, 2, 3, 4]), 3).slice(4);
  compare([2, 3, 4].map((value, i) => instance.step(bar(i + 4, value), i + 4)[0]), expected, 'rotated recovery', true);
});

test('SMA ordinary market data retains legacy baseline, source selection and p-1 warm-up', t => {
  const rows = marketRows(257);
  for (const period of [1, 2, 7, 20, 64]) for (const source of FIELDS) {
    const params = {period, source}, expected = legacyReference(rows, period, source);
    const actual = fixture(t, rows, params).check(`market/${source}/${period}`).outputs.value;
    compare(actual, expected, `legacy engine/${source}/${period}`);
    compare(stream(rows, params), expected, `legacy definition/${source}/${period}`);
    assert.ok(Array.from(actual.subarray(0, period - 1)).every(Number.isNaN), 'p-1 warm-up samples remain gaps');
    assert.ok(Number.isFinite(actual[period - 1]), 'first complete window is finite');
  }
  compare(stream(rows), legacyReference(rows, 20), 'default period and close');
  fixture(t, rows).check('engine defaults');
});

test('SMA analytic constant, rising and alternating windows keep current-inclusive alignment', t => {
  for (const values of [Array(29).fill(7), Array.from({length: 29}, (_, i) => i - 14), Array.from({length: 29}, (_, i) => i % 2 ? -8 : 12)]) {
    const rows = rowsOf(values);
    for (const period of [2, 3, 7, 20]) {
      compare(stream(rows, {period}), fifoReference(rows, period), `ordinary analytic ${period}`, true);
      fixture(t, rows, {period}).check(`ordinary analytic engine ${period}`, rows, true);
    }
  }
});

test('SMA append and repeated current replacement recover across nonzero checkpoints', t => {
  const rows = rowsOf([2, 2, 2, 2, 1e308]), f = fixture(t, rows, {period: 2}, 2);
  f.check('initial before overflow', rows, true);
  for (const value of [1e308, 1, 1, 1e16, 1, 2]) {
    const row = bar(rows.length, value);
    rows.push(row); f.store.append(row); f.check(`append ${rows.length}`, rows);
  }
  assert.equal(f.engine.get('s').outputs.value.at(-1), 1.5, 'dominant eviction recovers the exact small window');
  const index = rows.length - 1;
  for (const value of [3, 1e308, -1e308, 2, 3]) {
    rows[index] = bar(index, value); f.store.upsert(rows[index]);
    const result = f.check(`current replacement ${value}`, rows);
    assert.equal(result.computedFrom, Math.floor(index / 2) * 2, 'restores the nonzero checkpoint');
    assert.equal(result.outputs.value.at(-1), (1 + value) / 2, 'current window is rebuilt without accumulating old replacements');
  }
});

test('SMA historical corrections introduce and remove overflowing windows without stale gaps', t => {
  const rows = rowsOf(Array(35).fill(1)), f = fixture(t, rows, {period: 2}, 4);
  for (const index of [0, 3, 4, 7, 8, 27, 28]) {
    for (const value of [1e308, -1e308, 1]) {
      for (const at of [index, index + 1]) {
        rows[at] = bar(at, value); f.store.update(at, rows[at]);
        const result = f.check(`correction ${at}/${value}`, rows, true);
        assert.equal(result.computedFrom, Math.floor(at / 4) * 4);
      }
      const actual = f.engine.get('s').outputs.value;
      assert.equal(actual[index + 3], 1, 'first all-small window recovers');
      if (Math.abs(value) === 1e308) assert.ok(Number.isNaN(actual[index + 1]), 'same-sign overflow is a gap');
    }
  }
});

test('SMA prepend, shorter reset, empty reset and refill restart recovery and warm-up', t => {
  const all = rowsOf([1e308, 1e308, 1, 1, 2, 3, 4, 5]);
  const rows = all.slice(3), f = fixture(t, rows, {period: 2}, 2);
  f.check('initial suffix', rows, true);
  rows.unshift(...all.slice(0, 3)); f.store.prepend(all.slice(0, 3)); f.check('prepend overflow history', rows, true);
  for (const values of [[9], [-1e308, -1e308, -1, -1], [], [1e16, 1, 2], []]) {
    rows.splice(0, rows.length, ...rowsOf(values)); f.store.setData(rows);
    f.check(`reset ${values.length}`, rows, true);
  }
  for (const value of [1e308, 1e308, 1, 1]) {
    const row = bar(rows.length, value); rows.push(row); f.store.append(row);
    f.check(`refill ${rows.length}`, rows, true);
  }
});

test('SMA snapshots keep the legacy ring shape and independently restore every recovery boundary', () => {
  for (const {name, period, values, expected} of analyticCases) {
    const rows = rowsOf(values), params = {period}, def = definition(params);
    for (let split = 0; split <= rows.length; split++) {
      const original = def.create();
      for (let i = 0; i < split; i++) original.step(rows[i], i);
      const snapshot = original.snapshot(), preserved = structuredClone(snapshot);
      assert.deepEqual(Object.keys(snapshot), split ? ['r'] : [], `${name}: checkpoint root keys`);
      if (split) assert.deepEqual(Object.keys(snapshot.r).sort(), ['a', 'head', 'sum'], `${name}: legacy ring keys`);
      assert.equal(validateCheckpointState('sma', params, snapshot, split), snapshot);
      const portable = safeCheckpointParse(safeCheckpointStringify(snapshot));
      assert.deepEqual(portable, snapshot, `${name}: exact codec round trip`);
      for (let i = split; i < rows.length; i++) original.step(rows[i], i);
      assert.deepEqual(snapshot, preserved, `${name}: detached snapshot`);
      const restored = def.create(); restored.restore(portable);
      compare(rows.slice(split).map((row, i) => restored.step(row, split + i)[0]), expected.slice(split), `${name}/restore ${split}`, true);
      assert.deepEqual(portable, preserved, `${name}: restore does not mutate its input`);
    }
  }
});

for (const sum of [Infinity, -Infinity, NaN]) test(`SMA reads an old ${sum} rolling-sum checkpoint and recovers`, () => {
  const params = {period: 2}, instance = definition(params).create();
  const state = {r: {a: [1e308, 1e308], head: 0, sum}};
  assert.equal(validateCheckpointState('sma', params, state, 2), state, 'old nonfinite sum remains readable');
  const portable = safeCheckpointParse(safeCheckpointStringify(state));
  instance.restore(portable);
  compare([1, 1, 3].map((value, i) => instance.step(bar(i + 2, value), i + 2)[0]), [5e307, 1, 2], 'legacy nonfinite sum recovery', true);
  assert.deepEqual(portable, state, 'legacy checkpoint is not consumed');
});

test('SMA old nonfinite warm-up sums recover without shortening warm-up', () => {
  for (const sum of [Infinity, -Infinity, NaN]) {
    const params = {period: 3}, state = {r: {a: [2], head: 0, sum}}, instance = definition(params).create();
    validateCheckpointState('sma', params, state, 1); instance.restore(state);
    compare([4, 6].map((value, i) => instance.step(bar(i + 1, value), i + 1)[0]), [NaN, 4], 'legacy warm-up recovery', true);
  }
});

test('SMA ordinary snapshots restore before warm-up and after multiple ring rotations', () => {
  const rows = marketRows(73), params = {period: 7, source: 'open'}, def = definition(params);
  for (const split of [0, 1, 6, 7, 8, 16, 32, 64]) {
    const original = def.create();
    for (let i = 0; i < split; i++) original.step(rows[i], i);
    const snapshot = original.snapshot(), preserved = structuredClone(snapshot);
    validateCheckpointState('sma', params, snapshot, split);
    for (const branch of [rows, rows.map((row, i) => i < split ? row : {...row, open: 50 + i / 10})]) {
      const restored = def.create(); restored.restore(snapshot);
      const actual = branch.slice(split).map((row, i) => restored.step(row, split + i)[0]);
      compare(actual, fifoReference(branch, 7, 'open').slice(split), `ordinary restored FIFO ${split}`);
      compare(actual, legacyReference(branch, 7, 'open').slice(split), `ordinary restored legacy ${split}`);
      assert.deepEqual(snapshot, preserved, `independent restored branch ${split}`);
    }
  }
});

test('SMA period-one legacy nonfinite sums and nonfinite inputs preserve the next finite value', () => {
  for (const sum of [Infinity, -Infinity, NaN]) {
    const params = {period: 1}, state = {r: {a: [1e308], head: 0, sum}}, instance = definition(params).create();
    validateCheckpointState('sma', params, state, 1); instance.restore(state);
    assert.ok(Object.is(instance.step(bar(1, -0), 1)[0], -0), 'legacy sum does not change the next signed zero');
    for (const invalid of [NaN, Infinity, -Infinity]) {
      assert.ok(Number.isNaN(instance.step(bar(2, invalid), 2)[0]));
      assert.deepEqual(instance.snapshot(), {r: {a: [], head: 0, sum: 0}});
      assert.ok(Object.is(instance.step(bar(3, -0), 3)[0], -0), 'period one restarts immediately with the exact source');
    }
  }
});

test('SMA nonfinite selected sources reset the ring and require a fresh complete window', () => {
  // BarStore correctly rejects nonfinite OHLCV; direct steps isolate the
  // builtin reset contract without weakening the public data validation.
  for (const source of FIELDS) for (const invalid of [NaN, Infinity, -Infinity]) {
    const params = {period: 3, source}, instance = definition(params).create();
    const values = [1e308, 1e308, invalid, 2, 4, 6, 8];
    const rows = values.map((value, i) => ({...bar(i, 19), [source]: value}));
    const actual = rows.map((row, i) => {
      const value = instance.step(row, i)[0];
      if (i === 2) assert.deepEqual(instance.snapshot(), {r: {a: [], head: 0, sum: 0}}, 'reset ring');
      return value;
    });
    compare(actual, [NaN, NaN, NaN, NaN, NaN, 4, 6], `${source}/${invalid} reset`, true);
    compare(actual, fifoReference(rows, 3, source), `${source}/${invalid} reference`, true);
  }
});
