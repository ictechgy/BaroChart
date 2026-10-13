import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators, FIELDS} from '../src/core/index.mjs';
import {safeCheckpointParse, safeCheckpointStringify, validateCheckpointState} from '../src/core/checkpoint-validation.mjs';

// Full-source oracle, independent of production state, snapshots and helpers.
// Keep an explicit candidate seed and rescan its raw Float64 sum oldest first.
// An overflowing seed discards its earlier inputs but retains the current one.
// This intentionally is not an exact-real or scaled full-history EMA.
function sourceReference(rows, period, source = 'close') {
  const alpha = 2 / (period + 1);
  let seed = [], previous;
  return rows.map(row => {
    const current = row[source];
    if (!Number.isFinite(current)) {seed = []; previous = undefined; return NaN;}
    if (period === 1) return current === 0 ? 0 : current;
    if (previous === undefined) {
      seed.push(current);
      const sum = seed.reduce((total, value) => total + value, 0);
      if (!Number.isFinite(sum)) {seed = [current]; return NaN;}
      if (seed.length < period) return NaN;
      previous = sum / period;
      seed = [];
    } else {
      const usual = previous + alpha * (current - previous);
      previous = Number.isFinite(usual) ? usual : (1 - alpha) * previous + alpha * current;
      // With finite endpoints a failed weighted recurrence is not a valid EMA.
      // The recoverable policy starts a new seed at this same finite input.
      if (!Number.isFinite(previous)) {seed = [current]; previous = undefined; return NaN;}
    }
    return previous;
  });
}

// Frozen ordinary-path arithmetic from before EMA recovery. Deliberately not
// the weighted alternative: changing every step to that expression changes bits.
function legacyReference(rows, period, source = 'close') {
  let count = 0, sum = 0, previous = NaN;
  return rows.map(row => {
    const value = row[source];
    if (!Number.isFinite(value)) {count = 0; sum = 0; previous = NaN; return NaN;}
    if (count < period) {sum += value; count++; if (count === period) previous = sum / period;}
    else previous += (2 / (period + 1)) * (value - previous);
    return previous;
  });
}

function bar(index, close) {
  return {time: index * 60000, open: close, high: close, low: close, close, volume: 1};
}
const rowsOf = values => values.map((value, index) => bar(index, value));

function marketRows(count) {
  let seed = 0x164172b3;
  const next = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;};
  return Array.from({length: count}, (_, i) => {
    const close = 100 + (next() % 100003) / 997;
    const open = close + ((next() % 401) - 200) / 103;
    return {...bar(i, close), open, high: Math.max(open, close) + 2.9,
      low: Math.min(open, close) - 1.3, volume: (next() % 10007) / 31};
  });
}

function compare(actual, expected, label, exact = true) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const got = actual[i], want = expected[i], point = `${label}[${i}]`;
    if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${point}: expected NaN, got ${got}`);
    else {
      assert.ok(Number.isFinite(got), `${point}: expected finite ${want}, got ${got}`);
      if (exact) assert.ok(Object.is(got, want), `${point}: expected ${Object.is(want, -0) ? '-0' : want}, got ${Object.is(got, -0) ? '-0' : got}`);
      else assert.ok(Math.abs(got - want) <= Math.max(Number.MIN_VALUE, Math.abs(want) * 16 * Number.EPSILON), `${point}: ${got} != ${want}`);
    }
  }
}

function definition(params = {}) {
  const def = builtinIndicators.get('ema')(params);
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
  engine.add('e', 'ema', params);
  return {store, engine, check(label, expectedRows = rows) {
    const result = engine.get('e');
    assert.deepEqual(Object.keys(result.outputs), ['value']);
    assert.deepEqual(result.plotOffsets, {});
    compare(result.outputs.value, sourceReference(expectedRows, params.period ?? 20, params.source ?? 'close'), label);
    return result;
  }};
}

const analyticCases = [
  {name: 'period-one opposite huge inputs', period: 1, values: [-1e308, 1e308, -1e308], expected: [-1e308, 1e308, -1e308]},
  {name: 'period-one keeps a small finite source after huge inputs', period: 1, values: [1e308, 1, -1e308, -1], expected: [1e308, 1, -1e308, -1]},
  {name: 'positive overflowing seed retains the current input', period: 2, values: [1e308, 1e308, 1, 1], expected: [NaN, NaN, 5e307, 1e308 / 6]},
  {name: 'negative overflowing seed retains the current input', period: 2, values: [-1e308, -1e308, -1, -1], expected: [NaN, NaN, -5e307, -1e308 / 6]},
  {name: 'partial seed overflow before final count', period: 3, values: [1e308, 1e308, 1, 1, 1], expected: [NaN, NaN, NaN, 1e308 / 3, 1e308 / 6]},
  {name: 'repeated partial seed overflow restarts warm-up each time', period: 3, values: [-1e308, -1e308, -1e308, -1, -1, -1], expected: [NaN, NaN, NaN, NaN, -1e308 / 3, -1e308 / 6]},
  {name: 'overflowing mature difference keeps continuous positive EMA', period: 3, values: [-5e307, -5e307, -5e307, 1.4e308, 0, 0], expected: [NaN, NaN, -5e307, 4.5e307, 2.25e307, 1.125e307]},
  {name: 'overflowing mature difference keeps continuous negative EMA', period: 3, values: [5e307, 5e307, 5e307, -1.4e308, 0, 0], expected: [NaN, NaN, 5e307, -4.5e307, -2.25e307, -1.125e307]},
  {name: 'weighted fallback uses period-two alpha rather than a midpoint', period: 2, values: [-8e307, -8e307, 1.4e308, 0], expected: [NaN, -8e307, 1e308 / 3 * 2, 1e308 / 9 * 2]},
  {name: 'weighted fallback uses period-five alpha rather than a midpoint', period: 5, values: [-3e307, -3e307, -3e307, -3e307, -3e307, 1.7e308, 0], expected: [NaN, NaN, NaN, NaN, -3e307, 1.1e308 / 3, 1.1e308 / 9 * 2]},
];

for (const {name, period, values, expected} of analyticCases) {
  test(`EMA analytic ${name}: independent reference and direct definition`, () => {
    const rows = rowsOf(values);
    compare(sourceReference(rows, period), expected, `${name}/analytic reference`, false);
    compare(stream(rows, {period}), expected, `${name}/definition`, false);
  });
  test(`EMA analytic ${name}: engine emits finite values or NaN`, t => {
    const rows = rowsOf(values), f = fixture(t, rows, {period}, 2);
    compare(f.check(name).outputs.value, expected, `${name}/engine`, false);
  });
}

test('EMA raw seed overflow deliberately differs from a scaled full-history mean', () => {
  const rows = rowsOf([1e308, 1e308, 1, 1]), actual = stream(rows, {period: 2});
  assert.ok(Number.isNaN(actual[1]), 'a mathematically representable 1e308 mean does not bypass raw seed overflow');
  assert.equal(actual[2], 5e307, 'the current overflow-causing sample becomes the first replacement seed');
  assert.ok(actual[3] > 1e307, 'recovered EMA retains history instead of behaving as a moving window');
});

test('EMA partial overflow resets all seed state before the original maturity boundary', () => {
  const params = {period: 4}, instance = definition(params).create();
  assert.ok(Number.isNaN(instance.step(bar(0, 1e308), 0)[0]));
  assert.ok(Number.isNaN(instance.step(bar(1, 1e308), 1)[0]));
  assert.deepEqual(instance.snapshot(), {e: {count: 1, sum: 1e308, value: NaN}});
  assert.ok(Number.isNaN(instance.step(bar(2, -1e308), 2)[0]));
  assert.deepEqual(instance.snapshot(), {e: {count: 2, sum: 0, value: NaN}});
  assert.ok(Number.isNaN(instance.step(bar(3, 4), 3)[0]), 'original fourth input is still warm-up');
  assert.equal(instance.step(bar(4, 8), 4)[0], 3, 'four inputs after reseeding use the unchanged raw sum');
  assert.equal(validateCheckpointState('ema', params, instance.snapshot(), 5).e.count, 4);
});

test('EMA mature fallback keeps its full count and the next finite recurrence', () => {
  const params = {period: 3}, instance = definition(params).create();
  for (let i = 0; i < 3; i++) instance.step(bar(i, -5e307), i);
  assert.equal(instance.snapshot().e.count, 3);
  const recovered = instance.step(bar(3, 1.4e308), 3)[0];
  compare([recovered], [4.5e307], 'weighted fallback', false);
  assert.deepEqual(instance.snapshot(), {e: {count: 3, sum: 0, value: recovered}}, 'canonical mature state does not reseed');
  assert.equal(instance.step(bar(4, 0), 4)[0], recovered / 2, 'ordinary EMA continues immediately');
});

test('EMA period greater than one ordinary sources and warm-up are bitwise legacy-compatible', t => {
  const rows = marketRows(257);
  for (const period of [2, 3, 7, 20, 64]) for (const source of FIELDS) {
    const params = {period, source}, expected = legacyReference(rows, period, source);
    compare(sourceReference(rows, period, source), expected, `oracle/${source}/${period}`);
    compare(stream(rows, params), expected, `definition/${source}/${period}`);
    const actual = fixture(t, rows, params).check(`engine/${source}/${period}`).outputs.value;
    compare(actual, expected, `legacy engine/${source}/${period}`);
    assert.ok(Array.from(actual.subarray(0, period - 1)).every(Number.isNaN));
    assert.ok(Number.isFinite(actual[period - 1]), 'first current-inclusive seed is complete');
  }
  compare(stream(rows), legacyReference(rows, 20), 'default period and close');
  fixture(t, rows).check('engine default parameters');
});

test('EMA period greater than one finite signed-zero and subnormal paths retain legacy arithmetic', t => {
  const values = [-0, 0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 0, -0, 1e308, 1, 0];
  const rows = rowsOf(values);
  for (const period of [2, 3]) {
    const expected = legacyReference(rows, period);
    compare(stream(rows, {period}), expected, `finite legacy/${period}`);
    compare(fixture(t, rows, {period}).check(`signed engine/${period}`).outputs.value, expected, `signed legacy engine/${period}`);
  }
});

test('EMA period one returns every finite source exactly while keeping zero normalization', t => {
  const values = [-0, 0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e308, 1, -1e308, -1, 0];
  for (const source of FIELDS) {
    const rows = values.map((value, i) => ({...bar(i, 17), [source]: value}));
    compare(stream(rows, {period: 1, source}), values.map(value => value === 0 ? 0 : value), `exact period-one/${source}`);
    const instance = definition({period: 1, source}).create();
    rows.forEach((row, i) => {
      const value = row[source] === 0 ? 0 : row[source];
      assert.ok(Object.is(instance.step(row, i)[0], value));
      assert.deepEqual(instance.snapshot(), {e: {count: 1, sum: 0, value}}, 'period-one stores the finite source in canonical state');
    });
  }
  const rows = marketRows(257);
  for (const source of FIELDS) {
    const expected = rows.map(row => row[source] === 0 ? 0 : row[source]);
    compare(fixture(t, rows, {period: 1, source}).check(`period-one market/${source}`).outputs.value, expected, `period-one selected field/${source}`);
  }
  const extremeRows = rowsOf(values), f = fixture(t, extremeRows, {period: 1});
  f.check('period-one huge, tiny, signed-zero engine');
  assert.equal(stream(rowsOf([1e308, 1]), {period: 1})[1], 1, 'huge-to-small finite cancellation is repaired');
  assert.equal(stream(rowsOf([-1e308, -1]), {period: 1})[1], -1, 'negative huge-to-small cancellation is repaired');
});

test('EMA recovery uses the selected field without weakening aggregate volume validation', () => {
  for (const source of FIELDS) {
    // Direct definitions can isolate time/volume selection without admitting
    // unordered timestamps or negative volume through public BarStore input.
    const rows = [1e308, 1e308, 1, 1].map((value, i) => ({...bar(i, 17), [source]: value}));
    compare(stream(rows, {period: 2, source}), sourceReference(rows, 2, source), `selected recovery/${source}`);
  }
  const rows = [1e308, 1e308, 1, 1].map((volume, i) => ({...bar(i, 17), volume}));
  assert.throws(() => new BarStore(rows), /Volume sum overflow/, 'engine inputs still obey the existing aggregate-volume limit');
});

test('EMA append and repeated current replacement replay nonzero checkpoints', t => {
  const rows = rowsOf([-5e307, -5e307, -5e307, -5e307, -5e307]), f = fixture(t, rows, {period: 3}, 2);
  f.check('initial negative mature EMA');
  for (const value of [1.4e308, 0, -1.7e308, 1.7e308, 1, 2]) {
    const row = bar(rows.length, value); rows.push(row); f.store.append(row);
    f.check(`append ${rows.length}`);
  }
  const index = rows.length - 1;
  for (const value of [1.7e308, -1.7e308, 0, -0, 3, 1.7e308]) {
    rows[index] = bar(index, value); f.store.upsert(rows[index]);
    assert.equal(f.check(`replace current ${value}`).computedFrom, Math.floor(index / 2) * 2);
  }
});

test('EMA historical corrections introduce and remove partial seed overflow around checkpoints', t => {
  const rows = rowsOf(Array(45).fill(1)), f = fixture(t, rows, {period: 12}, 4);
  for (const index of [0, 3, 4, 7, 8, 10]) {
    for (const sign of [1, -1]) {
      for (const at of [index, index + 1]) {
        rows[at] = bar(at, sign * 1e308); f.store.update(at, rows[at]);
        assert.equal(f.check(`seed correction ${at}/${sign}`).computedFrom, Math.floor(at / 4) * 4);
      }
      const actual = f.engine.get('e').outputs.value;
      assert.ok(Number.isNaN(actual[index + 11]), 'overflow-causing input is the first new seed');
      assert.ok(Number.isFinite(actual[index + 12]), 'reseed matures after twelve retained finite inputs');
      for (const at of [index, index + 1]) {rows[at] = bar(at, 1); f.store.update(at, rows[at]); f.check(`remove overflow ${at}`);}
      compare(f.engine.get('e').outputs.value, legacyReference(rows, 12), 'all corrections removed');
    }
  }
});

test('EMA historical mature corrections introduce and remove weighted fallback without stale suffixes', t => {
  const rows = rowsOf(Array(37).fill(-5e307)), f = fixture(t, rows, {period: 3}, 4);
  for (const index of [3, 4, 7, 8, 31, 32]) {
    for (const value of [1.4e308, -5e307]) {
      rows[index] = bar(index, value); f.store.update(index, rows[index]);
      assert.equal(f.check(`mature correction ${index}/${value}`).computedFrom, Math.floor(index / 4) * 4);
    }
  }
});

test('EMA prepend, shorter reset, empty reset and refill restart the intended seed', t => {
  const all = rowsOf([1e308, 1e308, 1, 1, 2, 3, 4, 5]), rows = all.slice(3);
  const f = fixture(t, rows, {period: 3}, 2);
  f.check('initial suffix');
  rows.unshift(...all.slice(0, 3)); f.store.prepend(all.slice(0, 3)); f.check('prepend overflow history');
  for (const values of [[9], [-1e308, -1e308, -1, -1, -1], [], [-5e307, -5e307, -5e307, 1.4e308, 0], []]) {
    rows.splice(0, rows.length, ...rowsOf(values)); f.store.setData(rows); f.check(`reset ${values.length}`);
  }
  for (const value of [1e308, 1e308, 1, 1, 1]) {
    const row = bar(rows.length, value); rows.push(row); f.store.append(row); f.check(`refill ${rows.length}`);
  }
});

test('EMA snapshots preserve the legacy schema and detached recovery at every analytic split', () => {
  for (const {name, period, values} of analyticCases) {
    const rows = rowsOf(values), params = {period}, def = definition(params), expected = sourceReference(rows, period);
    for (let split = 0; split <= rows.length; split++) {
      const original = def.create();
      for (let i = 0; i < split; i++) original.step(rows[i], i);
      const snapshot = original.snapshot(), preserved = structuredClone(snapshot);
      assert.deepEqual(Object.keys(snapshot), split ? ['e'] : [], `${name}: root schema`);
      if (split) assert.deepEqual(Object.keys(snapshot.e).sort(), ['count', 'sum', 'value'], `${name}: smoothing schema`);
      assert.equal(validateCheckpointState('ema', params, snapshot, split), snapshot);
      const portable = safeCheckpointParse(safeCheckpointStringify(snapshot));
      assert.deepEqual(portable, snapshot, `${name}: exact codec round trip`);
      for (let i = split; i < rows.length; i++) original.step(rows[i], i);
      assert.deepEqual(snapshot, preserved, `${name}: detached snapshot`);
      const restored = def.create(); restored.restore(portable);
      compare(rows.slice(split).map((row, i) => restored.step(row, split + i)[0]), expected.slice(split), `${name}/restore ${split}`);
      assert.deepEqual(portable, preserved, `${name}: restore does not mutate input`);
    }
  }
});

test('EMA ordinary checkpoints restore independent source branches bitwise', () => {
  const rows = marketRows(81), params = {period: 7, source: 'open'}, def = definition(params);
  for (const split of [0, 1, 6, 7, 8, 16, 32, 64]) {
    const original = def.create();
    for (let i = 0; i < split; i++) original.step(rows[i], i);
    const snapshot = original.snapshot(), preserved = structuredClone(snapshot);
    validateCheckpointState('ema', params, snapshot, split);
    for (const branch of [rows, rows.map((row, i) => i < split ? row : {...row, open: 50 + i / 103})]) {
      const restored = def.create(); restored.restore(snapshot);
      compare(branch.slice(split).map((row, i) => restored.step(row, split + i)[0]), legacyReference(branch, 7, 'open').slice(split), `ordinary branch/${split}`);
      assert.deepEqual(snapshot, preserved, 'restored branches do not consume the checkpoint');
    }
  }
});

for (const sum of [Infinity, -Infinity, NaN]) {
  test(`EMA validated legacy partial ${sum} sum reseeds before the next finite input`, () => {
    const params = {period: 3};
    for (const count of [0, 1, 2]) {
      const state = {e: {count, sum, value: NaN}}, instance = definition(params).create();
      assert.equal(validateCheckpointState('ema', params, state, 3), state);
      const portable = safeCheckpointParse(safeCheckpointStringify(state)); instance.restore(portable);
      compare([2, 4, 6, 8].map((value, i) => {
        const result = instance.step(bar(i + 3, value), i + 3)[0];
        if (i === 0) assert.deepEqual(instance.snapshot(), {e: {count: 1, sum: 2, value: NaN}}, 'poison is removed before consumption');
        return result;
      }), [NaN, NaN, 4, 6], `legacy partial/${count}/${sum}`);
      assert.deepEqual(portable, state, 'legacy state remains independently owned');
    }
  });
  test(`EMA validated mature finite value ignores stale ${sum} seed sum`, () => {
    const params = {period: 3}, state = {e: {count: 3, sum, value: 12}}, instance = definition(params).create();
    assert.equal(validateCheckpointState('ema', params, state, 3), state);
    instance.restore(safeCheckpointParse(safeCheckpointStringify(state)));
    compare([20, 4, 2].map((value, i) => instance.step(bar(i + 3, value), i + 3)[0]), [16, 10, 6], 'finite mature value must continue');
    assert.equal(instance.snapshot().e.count, 3);
    const hugeState = {e: {count: 3, sum, value: -5e307}};
    validateCheckpointState('ema', params, hugeState, 3); instance.restore(hugeState);
    compare([instance.step(bar(3, 1.4e308), 3)[0]], [4.5e307], 'stale mature sum does not suppress weighted fallback', false);
    assert.equal(instance.snapshot().e.count, 3, 'fallback remains mature despite stale seed sum');
  });
}

test('EMA validated mature NaN checkpoints restart a complete seed with unchanged schema', () => {
  for (const period of [1, 2, 3]) for (const sum of [0, 17, Infinity, -Infinity, NaN]) {
    const params = {period}, state = {e: {count: period, sum, value: NaN}}, instance = definition(params).create();
    assert.equal(validateCheckpointState('ema', params, state, period), state);
    instance.restore(safeCheckpointParse(safeCheckpointStringify(state)));
    const rows = rowsOf([2, 4, 6, 8, 10]);
    compare(rows.map((row, i) => instance.step(row, period + i)[0]), legacyReference(rows, period), `legacy mature NaN/${period}/${sum}`);
    assert.deepEqual(Object.keys(instance.snapshot().e).sort(), ['count', 'sum', 'value']);
  }
});

test('EMA infinite legacy values remain rejected by checkpoint validation', () => {
  for (const value of [Infinity, -Infinity]) {
    assert.throws(() => validateCheckpointState('ema', {period: 3}, {e: {count: 3, sum: 0, value}}, 3), /smoothing state/);
  }
});

test('EMA nonfinite selected sources reset partial and mature states and restart warm-up', () => {
  // Public BarStore rejects these inputs; direct steps check only EMA's existing
  // reset contract and do not weaken public finite-field validation.
  for (const source of FIELDS) for (const invalid of [NaN, Infinity, -Infinity]) for (const prefix of [[1e308, 1e308], [2, 4, 6]]) {
    const params = {period: 3, source}, instance = definition(params).create();
    const values = [...prefix, invalid, 2, 4, 6, 8], rows = values.map((value, i) => ({...bar(i, 19), [source]: value}));
    const actual = rows.map((row, i) => {
      const value = instance.step(row, i)[0];
      if (i === prefix.length) assert.deepEqual(instance.snapshot(), {e: {count: 0, sum: 0, value: NaN}});
      return value;
    });
    compare(actual, sourceReference(rows, 3, source), `nonfinite reset/${source}/${invalid}`);
    compare(actual.slice(prefix.length), [NaN, NaN, NaN, 4, 6], 'full warm-up after invalid source');
  }
  const rows = rowsOf([-0, NaN, -0, Infinity, -0, -Infinity, -0]);
  compare(stream(rows, {period: 1}), legacyReference(rows, 1), 'period-one reset preserves legacy signed-zero arithmetic');
});
