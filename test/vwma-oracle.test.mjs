import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators, FIELDS} from '../src/core/index.mjs';

// Independent window oracle: every answer is rebuilt from source OHLCV rows.
// Raw Float64 products (including underflow to zero) are formed before summing.
// No production rolling helper, checkpoint, or previous output is reused.
function sumWindowTerms(terms) {
  let total = 0, correction = 0;
  for (const term of terms) {
    if (!Number.isFinite(term)) return NaN;
    const next = total + term;
    if (!Number.isFinite(next)) return NaN;
    correction += Math.abs(total) >= Math.abs(term)
      ? (total - next) + term : (term - next) + total;
    total = next;
  }
  const result = total + correction;
  return Number.isFinite(result) ? result : NaN;
}

function scanVwma(rows, period, compensated = true) {
  const output = Array(rows.length).fill(NaN);
  const sum = compensated ? sumWindowTerms : terms => terms.reduce((a, b) => a + b, 0);
  for (let i = period - 1; i < rows.length; i++) {
    const window = rows.slice(i - period + 1, i + 1);
    const products = window.map(row => row.close * row.volume);
    const magnitude = sum(products.map(Math.abs));
    const volume = sum(window.map(row => row.volume));
    const numerator = sum(products);
    const result = numerator / volume;
    if (Number.isFinite(magnitude) && Number.isFinite(volume) && volume > 0 && Number.isFinite(result)) output[i] = result;
  }
  return output;
}

function bar(index, close, volume = 1) {
  return {time: index * 60000, open: close, high: close, low: close, close, volume};
}
const rowsOf = pairs => pairs.map(([close, volume], i) => bar(i, close, volume));

function mixedBars(count, start = 0) {
  let state = 0x72dce941;
  const next = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state;};
  return Array.from({length: count}, (_, i) => {
    const close = ((next() % 16001) - 8000) / 8;
    const open = close + ((next() % 101) - 50) / 4;
    return {...bar(start + i, close, next() % 1000), open, high: Math.max(open, close) + 10, low: Math.min(open, close) - 10};
  });
}

function compare(actual, expected, label, exact = false) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const got = actual[i], want = expected[i], point = `${label}[${i}]`;
    if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${point}: expected NaN, got ${got}`);
    else if (exact) assert.ok(Object.is(got, want), `${point}: expected exactly ${Object.is(want, -0) ? '-0' : want}, got ${got}`);
    else {
      assert.ok(Number.isFinite(got), `${point}: expected finite output, got ${got}`);
      // Ordinary-value comparisons allow explicit absolute and relative error.
      const tolerance = 1e-12 + 1e-12 * Math.abs(want);
      assert.ok(Math.abs(got - want) <= tolerance, `${point}: ${got} != ${want} (tolerance ${tolerance})`);
    }
  }
}

function definition(period) {
  const factory = builtinIndicators.get('vwma');
  assert.equal(typeof factory, 'function', 'VWMA is a builtin');
  const def = factory(period === undefined ? undefined : {period});
  assert.deepEqual(def.outputs, ['value']);
  assert.deepEqual(def.plotOffsets, {});
  return def;
}

function stream(rows, period) {
  const instance = definition(period).create();
  return rows.map((row, i) => {
    const values = instance.step(row, i);
    assert.equal(values.length, 1, `stream output arity at ${i}`);
    return values[0];
  });
}

function fixture(t, rows, period, checkpointSize = 8) {
  const store = new BarStore(rows), engine = new IndicatorEngine(store, {checkpointSize});
  t.after(() => engine.dispose());
  engine.add('v', 'vwma', period === undefined ? {} : {period});
  return {store, engine, check(label, source = rows, ordinary = true) {
    const result = engine.get('v');
    assert.deepEqual(Object.keys(result.outputs), ['value'], `${label}: output names`);
    assert.deepEqual(result.plotOffsets, {}, `${label}: plot offsets`);
    compare(result.outputs.value, scanVwma(source, period ?? 20), label);
    if (ordinary) compare(result.outputs.value, scanVwma(source, period ?? 20, false), `${label}/naive scan`);
    return result;
  }};
}

test('VWMA uses close and the current-inclusive p-bar window, first emitting at p-1', t => {
  const rows = rowsOf([[0, 1], [6, 1], [12, 1], [999, 0], [24, 2]])
    .map(row => ({...row, open: row.close + 100, high: row.close + 200, low: row.close - 300}));
  const expected = [NaN, NaN, 6, 9, 20], f = fixture(t, rows, 3);
  compare(scanVwma(rows, 3), expected, 'hand-calculated oracle', true);
  compare(f.check('hand-calculated production').outputs.value, expected, 'hand-calculated production', true);
  compare(stream(rows, 3), expected, 'hand-calculated stream', true);
});

for (const [name, rows] of [
  ['mixed positive and negative closes', mixedBars(113)],
  ['rising', Array.from({length: 61}, (_, i) => bar(i, i - 20, i % 7))],
  ['falling', Array.from({length: 61}, (_, i) => bar(i, 20 - i, i % 5 + 1))],
  ['constant', Array.from({length: 61}, (_, i) => bar(i, -7, i % 9))],
  ['alternating signs', Array.from({length: 61}, (_, i) => bar(i, i % 2 ? -8 : 12, i % 4 + 1))],
]) {
  test(`VWMA independent ${name} vectors for periods 1, 2, 7 and 20`, t => {
    for (const period of [1, 2, 7, 20]) {
      fixture(t, rows, period).check(`${name}/period=${period}`);
      compare(stream(rows, period), scanVwma(rows, period), `${name}/stream/period=${period}`);
    }
  });
}

test('VWMA zero-volume bars occupy window positions and all-zero windows are gaps', t => {
  const rows = rowsOf([[15, 0], [-20, -0], [30, 0], [12, 2], [500, 0], [999, 0], [15, 3], [-15, 3], [0, 0]]);
  const expected = [NaN, NaN, NaN, 12, 12, 12, 15, 0, 0];
  compare(scanVwma(rows, 3), expected, 'zero-volume oracle', true);
  compare(fixture(t, rows, 3).check('zero-volume windows').outputs.value, expected, 'zero-volume windows', true);
});

test('VWMA signed zeros and negative underflowed ratios retain raw Float64 semantics', t => {
  const rows = rowsOf([[-0, 1], [0, 1], [-Number.MIN_VALUE, 1], [0, 1], [0, -0], [7, 0], [-0, 0]]);
  const expected = [NaN, 0, -0, -0, 0, NaN, NaN];
  compare(scanVwma(rows, 2), expected, 'signed-zero oracle', true);
  compare(fixture(t, rows, 2).check('signed zeros', rows, false).outputs.value, expected, 'signed zeros', true);
  compare(stream(rows, 2), expected, 'signed-zero stream', true);
});

test('VWMA period 1 keeps product underflow instead of replacing the result with close', t => {
  const rows = rowsOf([[Number.MIN_VALUE, .5], [-Number.MIN_VALUE, .5], [1e-300, 1e-30], [-1e-300, 1e-30], [Number.MIN_VALUE, 1], [1e-300, 1]]);
  const expected = [0, 0, 0, 0, Number.MIN_VALUE, 1e-300];
  compare(scanVwma(rows, 1), expected, 'raw underflow oracle', true);
  compare(fixture(t, rows, 1).check('raw underflow', rows, false).outputs.value, expected, 'raw underflow', true);
  compare(stream(rows, 1), expected, 'raw underflow stream', true);
});

test('VWMA dominant finite volume and numerator eviction recover exactly', t => {
  for (const [label, pairs] of [
    ['volume', [[0, 1e16], [1, 1], [1, 2]]],
    ['numerator', [[1e16, 1], [1, 1], [1, 1]]],
    ['negative numerator', [[-1e16, 1], [1, 1], [1, 1]]],
  ]) {
    const rows = rowsOf(pairs), f = fixture(t, rows.slice(0, 2), 2, 2);
    f.store.append(rows[2]);
    const actual = f.check(`dominant ${label} eviction`, rows, false).outputs.value;
    assert.equal(scanVwma(rows, 2)[2], 1, `${label}: independent final window`);
    assert.equal(actual[2], 1, `${label}: incremental final value`);
    assert.equal(stream(rows, 2)[2], 1, `${label}: streamed final value`);
  }
});

test('VWMA compensated finite cancellation preserves small terms and sign reversals', t => {
  const rows = rowsOf([[1e16, 1], [1, 1], [-1e16, 1], [3, 1], [2, 1], [4, 1]]);
  const actual = fixture(t, rows, 3).check('finite cancellation', rows, false).outputs.value;
  assert.equal(scanVwma(rows, 3)[2], 1 / 3);
  assert.equal(actual[2], 1 / 3, 'small retained term survives opposite large products');
  assert.equal(actual[5], 3, 'both large products have left the window');
  const reversals = rowsOf([[Number.MAX_VALUE / 8, 1], [-Number.MAX_VALUE / 8, 1], [7, 1], [9, 1]]);
  const reversed = fixture(t, reversals, 2).check('large finite sign reversal', reversals, false).outputs.value;
  assert.equal(reversed[1], 0);
  assert.equal(reversed[3], 8);
});

test('VWMA product overflow gaps last only while the offending bar remains in the window', t => {
  for (const close of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const rows = rowsOf([[close, 2], [2, 1], [4, 1], [6, 1]]);
    const expected = [NaN, NaN, 3, 5];
    compare(scanVwma(rows, 2), expected, 'product overflow oracle', true);
    compare(fixture(t, rows, 2).check('product overflow', rows, false).outputs.value, expected, 'product overflow engine', true);
    compare(stream(rows, 2), expected, 'product overflow stream', true);
    compare(stream(rows, 1), [NaN, 2, 4, 6], 'period-1 overflow has no close shortcut', true);
  }
});

test('VWMA conservative absolute-product overflow is a gap even when signed products cancel', t => {
  // The absolute-product sum policy makes this independent of signed addition
  // order: huge cancellation cannot turn an overflowing-magnitude window valid.
  const huge = Number.MAX_VALUE * .75;
  for (const signs of [[1, -1], [-1, 1], [1, 1], [-1, -1]]) {
    const rows = rowsOf([[signs[0] * huge, 1], [signs[1] * huge, 1], [0, 1], [6, 1], [9, 1]]);
    const expected = [NaN, NaN, NaN, signs[1] * huge / 3, 5];
    compare(scanVwma(rows, 3), expected, 'absolute-product overflow oracle', true);
    compare(fixture(t, rows, 3).check('absolute-product overflow', rows, false).outputs.value, expected, 'absolute-product overflow engine', true);
    compare(stream(rows, 3), expected, 'absolute-product overflow stream', true);
  }
});

test('VWMA definition handles volume-sum overflow and recovers after eviction', () => {
  // BarStore rejects a globally overflowing volume total before calculation.
  // Direct definition steps isolate the builtin's finite-input window policy.
  const rows = rowsOf([[0, Number.MAX_VALUE], [0, Number.MAX_VALUE], [2, 1], [2, 1]]);
  const expected = [NaN, NaN, 2 / Number.MAX_VALUE, 2];
  compare(scanVwma(rows, 2), expected, 'volume-sum overflow oracle', true);
  compare(stream(rows, 2), expected, 'volume-sum overflow stream', true);
});

test('VWMA compensated magnitude distinguishes the finite maximum from rounded-away overflow', t => {
  const max = Number.MAX_VALUE, small = 2 ** 969;
  const finite = rowsOf([[max / 2, 1], [-max / 2, 1], [0, 1], [0, 1]]);
  compare(fixture(t, finite, 4).check('finite maximum magnitude', finite, false).outputs.value,
    [NaN, NaN, NaN, 0], 'exactly maximum magnitude is allowed', true);

  // Each small term alone rounds away from MAX_VALUE. Together they cross
  // the overflow rounding boundary, so an uncompensated scan misses the gap.
  assert.equal(max + small + small, max);
  assert.equal(max + (small + small), Infinity);
  const rows = rowsOf([[max / 2, 1], [-max / 2, 1], [small, 1], [small, 1], [0, 1], [0, 1], [0, 1], [0, 1]]);
  const expected = [NaN, NaN, NaN, NaN, (-max / 2 + 2 ** 970) / 4, 2 ** 968, 2 ** 967, 0];
  compare(scanVwma(rows, 4), expected, 'compensated boundary oracle', true);
  assert.ok(Number.isFinite(scanVwma(rows, 4, false)[3]), 'naive scan intentionally differs at the boundary');
  compare(fixture(t, rows, 4).check('compensated overflow boundary', rows, false).outputs.value,
    expected, 'compensated overflow boundary engine', true);
  compare(stream(rows, 4), expected, 'compensated overflow boundary stream', true);
});

test('VWMA uses stored bar count despite large and irregular time gaps', t => {
  const regular = mixedBars(57);
  let time = -86400000;
  const gapped = regular.map((row, i) => ({...row, time: time += [1, 60000, 86400000, 31 * 86400000][i % 4]}));
  compare(fixture(t, gapped, 7).check('irregular time gaps').outputs.value, scanVwma(regular, 7), 'same stored bars');
});

test('VWMA defaults to period 20 and invalid periods leave no partial entry', t => {
  const rows = mixedBars(31), f = fixture(t, rows);
  f.check('default period');
  compare(stream(rows), scanVwma(rows, 20), 'default factory period');
  for (const period of [0, -1, 1.5, 10001, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity, '20', null]) {
    assert.throws(() => f.engine.add('bad', 'vwma', {period}), undefined, `invalid period ${String(period)}`);
    assert.equal(f.engine.entries.has('bad'), false, 'failed add must be atomic');
    assert.throws(() => definition(period), undefined, `factory invalid period ${String(period)}`);
  }
  f.check('after invalid parameters');
});

test('VWMA maximum period 10000 first emits at index 9999', t => {
  // Only two complete oracle windows. A large checkpoint size avoids treating
  // this contract boundary as a checkpoint-copy or quadratic benchmark.
  const rows = Array.from({length: 10001}, (_, i) => bar(i, i === 10000 ? 20000 : 0, 1));
  const actual = fixture(t, rows, 10000, 10001).check('maximum period').outputs.value;
  assert.ok(Number.isNaN(actual[9998]));
  assert.equal(actual[9999], 0);
  assert.equal(actual[10000], 2);
});

test('VWMA append, repeated current replacements and historical corrections match source scans', t => {
  const all = mixedBars(85), rows = all.slice(0, 48), f = fixture(t, rows, 7);
  f.check('initial');
  for (const row of all.slice(48, 65)) {
    rows.push(row); f.store.append(row); f.check(`append ${rows.length - 1}`);
  }
  const last = rows.length - 1;
  for (const [close, volume] of [[99, 1000], [-99, 2], [0, 0], [1, 1e16], [-0, -0], [99, 1000]]) {
    rows[last] = bar(last, close, volume);
    f.store.upsert(rows[last]);
    const actual = f.check(`replace current ${close}/${volume}`);
    assert.equal(actual.computedFrom, 64, 'same-bar replacement restores a nonzero checkpoint');
  }
  for (const index of [0, 7, 8, 9, 31, 32, 33, 56]) {
    const original = rows[index];
    for (const replacement of [bar(index, 200 + index, 0), bar(index, -300 - index, 2000), original]) {
      rows[index] = replacement; f.store.update(index, replacement);
      const actual = f.check(`correct ${index}`);
      assert.equal(actual.computedFrom, Math.floor(index / 8) * 8);
    }
  }
  for (const row of all.slice(65)) {
    rows.push(row); f.store.append(row); f.check(`append after correction ${rows.length - 1}`);
  }
});

test('VWMA corrections can introduce and remove overflowing products without stale gaps', t => {
  const rows = Array.from({length: 35}, (_, i) => bar(i, 4, 1)), f = fixture(t, rows, 3);
  for (const index of [7, 8, 9, 24, 32]) {
    rows[index] = bar(index, Number.MAX_VALUE, 2); f.store.update(index, rows[index]);
    const broken = f.check(`introduce overflow ${index}`, rows, false).outputs.value;
    for (let i = index; i < Math.min(index + 3, rows.length); i++) assert.ok(Number.isNaN(broken[i]));
    if (index + 3 < rows.length) assert.equal(broken[index + 3], 4, 'recovers at first untainted window');
    rows[index] = bar(index, 4, 1); f.store.update(index, rows[index]);
    const repaired = f.check(`remove overflow ${index}`).outputs.value;
    for (let i = 2; i < repaired.length; i++) assert.equal(repaired[i], 4);
  }
});

test('VWMA prepend, shorter reset, empty reset and refill restart the correct warm-up', t => {
  const all = mixedBars(61), rows = all.slice(11), f = fixture(t, rows, 7);
  f.check('initial suffix');
  const prefix = all.slice(0, 11);
  f.store.prepend(prefix); rows.unshift(...prefix); f.check('prepend');
  for (const replacement of [mixedBars(4, 100), mixedBars(7, 200), [], mixedBars(23, 300), []]) {
    rows.splice(0, rows.length, ...replacement); f.store.setData(rows); f.check(`reset ${rows.length}`);
  }
  for (const row of mixedBars(11, 400)) {
    rows.push(row); f.store.append(row); f.check(`refill ${rows.length}`);
  }
});

test('VWMA restored snapshots match fresh scans and retain independent ownership', () => {
  const period = 7, rows = mixedBars(57), def = definition(period);
  // Include checkpoints before/at full warm-up and after ring wrap-around.
  for (const split of [0, 1, 6, 7, 8, 16, 32, 56]) {
    const source = def.create();
    for (let i = 0; i < split; i++) source.step(rows[i], i);
    const snapshot = source.snapshot(), preserved = structuredClone(snapshot);
    for (let i = split; i < rows.length; i++) source.step(rows[i], i);
    assert.deepEqual(snapshot, preserved, `snapshot ownership at ${split}`);
    for (const branch of [rows, rows.map((row, i) => i < split ? row : bar(i, i % 3 ? -6 : 19, i % 4 ? 2 : 0))]) {
      const restored = def.create();
      restored.restore(snapshot);
      const actual = branch.slice(split).map((row, j) => restored.step(row, split + j)[0]);
      compare(actual, scanVwma(branch, period).slice(split), `restored ${split}`);
      assert.deepEqual(snapshot, preserved, `restore does not consume or mutate snapshot at ${split}`);
    }
  }
});

test('VWMA snapshots preserve dominant, overflowed and zero-volume window recovery', () => {
  const huge = Number.MAX_VALUE * .75;
  for (const pairs of [
    [[0, 1e16], [1, 1], [1, 2], [1, 1]],
    [[1e16, 1], [1, 1], [1, 1], [1, 1]],
    [[Number.MAX_VALUE, 2], [2, 1], [4, 1], [6, 1]],
    [[huge, 1], [-huge, 1], [0, 1], [6, 1]],
    [[0, 0], [7, -0], [-6, 2], [2, 2]],
  ]) {
    const rows = rowsOf(pairs), def = definition(2), expected = scanVwma(rows, 2);
    for (const split of [1, 2, 3]) {
      const source = def.create();
      for (let i = 0; i < split; i++) source.step(rows[i], i);
      const snapshot = source.snapshot(), saved = structuredClone(snapshot), restored = def.create();
      restored.restore(snapshot);
      const actual = rows.slice(split).map((row, j) => restored.step(row, split + j)[0]);
      compare(actual, expected.slice(split), `extreme restored ${split}`, true);
      assert.deepEqual(snapshot, saved, 'extreme snapshot ownership');
    }
  }
});

test('VWMA keeps BarStore finite-field and nonnegative-volume validation atomic', t => {
  const rows = mixedBars(19), f = fixture(t, rows, 7), version = f.store.version;
  for (const field of FIELDS) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      assert.throws(() => f.store.update(10, {...rows[10], [field]: invalid}), /finite/i);
      assert.throws(() => f.store.append({...bar(19, 5, 3), [field]: invalid}), /finite/i);
      assert.equal(f.store.version, version, `${field}: failed validation is atomic`);
    }
  }
  assert.throws(() => f.store.update(10, {...rows[10], volume: -1}), /OHLCV/i);
  assert.equal(f.store.version, version);
  f.check('after rejected invalid OHLCV');
});
