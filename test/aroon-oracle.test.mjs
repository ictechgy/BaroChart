import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators, FIELDS} from '../src/core/index.mjs';

const OUTPUTS = ['up', 'down', 'oscillator'];

// Independent, intentionally naive reference: scan each complete window from
// newest to oldest, accepting only strictly better prices. Equal highs/lows,
// including +0 and -0, therefore keep the most recent bar. No production
// rolling helpers, checkpoints, or output arrays participate in the oracle.
function scanAroon(bars, period) {
  const result = Object.fromEntries(OUTPUTS.map(name => [name, Array(bars.length).fill(NaN)]));
  for (let i = period; i < bars.length; i++) {
    let highIndex = i, lowIndex = i;
    for (let j = i - 1; j >= i - period; j--) {
      if (bars[j].high > bars[highIndex].high) highIndex = j;
      if (bars[j].low < bars[lowIndex].low) lowIndex = j;
    }
    const up = 100 * (period - (i - highIndex)) / period;
    const down = 100 * (period - (i - lowIndex)) / period;
    result.up[i] = up;
    result.down[i] = down;
    result.oscillator[i] = up - down;
  }
  return result;
}

function bar(index, high, low, volume = 0) {
  // Half-before-add keeps even opposite Number.MAX_VALUE prices finite.
  const middle = high / 2 + low / 2;
  return {time: index * 60000, open: middle, high, low, close: middle, volume};
}

function mixedBars(count, start = 0) {
  let state = 0x62a9b31d;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({length: count}, (_, i) => {
    const high = (next() % 17) + 1, low = -(next() % 19) - 1;
    return bar(start + i, high, low, next() % 1000);
  });
}

function compare(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), OUTPUTS, `${label}: output names`);
  for (const name of OUTPUTS) {
    assert.equal(actual[name].length, expected[name].length, `${label}.${name}: length`);
    for (let i = 0; i < expected[name].length; i++) {
      const got = actual[name][i], want = expected[name][i], point = `${label}.${name}[${i}]`;
      if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${point}: warm-up must be NaN, got ${got}`);
      else {
        assert.ok(Number.isFinite(got), `${point}: finite output, got ${got}`);
        assert.ok(Math.abs(got - want) <= 1e-12, `${point}: ${got} != ${want}`);
        const minimum = name === 'oscillator' ? -100 : 0;
        assert.ok(got >= minimum && got <= 100, `${point}: bounded percentage`);
      }
    }
  }
}

function fixture(t, bars, period, checkpointSize = 8) {
  const store = new BarStore(bars);
  const engine = new IndicatorEngine(store, {checkpointSize});
  t.after(() => engine.dispose());
  engine.add('a', 'aroon', {period});
  return {store, engine, check(label, rows = bars) {
    const actual = engine.get('a');
    compare(actual.outputs, scanAroon(rows, period), label);
    return actual;
  }};
}

test('Aroon explicit interval-window fixture includes the oldest endpoint and newest ties', t => {
  const highs = [9, 4, 9, 3, 2, 1, 0];
  const lows = [-9, -4, -3, -9, -2, -1, 0];
  const rows = highs.map((high, i) => bar(i, high, lows[i]));
  const f = fixture(t, rows, 3);
  const expected = {
    up: [NaN, NaN, NaN, 200 / 3, 100 / 3, 0, 0],
    down: [NaN, NaN, NaN, 100, 200 / 3, 100 / 3, 0],
    oscillator: [NaN, NaN, NaN, 200 / 3 - 100, 100 / 3 - 200 / 3, -100 / 3, 0],
  };
  compare(scanAroon(rows, 3), expected, 'hand-calculated reference');
  compare(f.engine.get('a').outputs, expected, 'hand-calculated production');
});

const corpora = [
  ['mixed', mixedBars(113)],
  ['rising', Array.from({length: 81}, (_, i) => bar(i, i + 4, i))],
  ['falling', Array.from({length: 81}, (_, i) => bar(i, 4 - i, -i))],
  ['flat', Array.from({length: 81}, (_, i) => bar(i, 7, 7))],
  ['repeated ties', Array.from({length: 81}, (_, i) => bar(i, [7, 2, 7, 4, 1][i % 5], [-8, -3, -2, -8, -1][i % 5]))],
  ['subnormal finite', Array.from({length: 81}, (_, i) => bar(i, (i % 5 + 1) * Number.MIN_VALUE, -(i % 7 + 1) * Number.MIN_VALUE))],
  ['extreme finite', Array.from({length: 81}, (_, i) => bar(i, [Number.MAX_VALUE, 1e308, 1, 0][i % 4], [-1e308, -Number.MAX_VALUE, -1, -0][i % 4]))],
  ['signed zero ties', Array.from({length: 81}, (_, i) => ({time: i * 60000, open: i % 2 ? -0 : 0, high: i % 2 ? -0 : 0, low: i % 2 ? 0 : -0, close: i % 2 ? 0 : -0, volume: i % 2 ? -0 : 0}))],
];

for (const [name, rows] of corpora) {
  test(`Aroon independent ${name} vectors for periods 1, 2, 7 and 25`, t => {
    for (const period of [1, 2, 7, 25]) {
      const f = fixture(t, rows, period);
      f.check(`${name}/period=${period}`);
      if (name === 'flat' || name === 'signed zero ties') {
        const output = f.engine.get('a').outputs;
        for (let i = period; i < rows.length; i++) {
          assert.equal(output.up[i], 100);
          assert.equal(output.down[i], 100);
          assert.equal(output.oscillator[i], 0);
        }
      }
    }
  });
}

test('Aroon uses stored bar count despite large and irregular time gaps', t => {
  const regular = mixedBars(57);
  let time = -86400000;
  const gapped = regular.map((row, i) => ({...row, time: time += [1, 60000, 86400000, 31 * 86400000][i % 4]}));
  const f = fixture(t, gapped, 7);
  compare(f.engine.get('a').outputs, scanAroon(regular, 7), 'irregular time gaps');
});

test('Aroon default period is 25 and invalid periods leave no partial entry', t => {
  const rows = mixedBars(31), store = new BarStore(rows), engine = new IndicatorEngine(store);
  t.after(() => engine.dispose());
  compare(engine.add('default', 'aroon').outputs, scanAroon(rows, 25), 'default period');
  for (const period of [0, -1, 1.5, 10001, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity, '25', null]) {
    assert.throws(() => engine.add('bad', 'aroon', {period}), undefined, `invalid period ${String(period)}`);
    assert.equal(engine.entries.has('bad'), false, 'failed add must be atomic');
  }
  compare(engine.get('default').outputs, scanAroon(rows, 25), 'after invalid parameters');
});

test('Aroon maximum period 10000 first emits at index 10000', t => {
  // Only two complete oracle windows and one nonzero checkpoint: this checks
  // the real maximum without a quadratic warm-up scan or large benchmark.
  const rows = Array.from({length: 10002}, (_, i) => bar(i, 20000 - i, -20000 + i));
  rows[10001] = bar(10001, 20001, -20001);
  const f = fixture(t, rows, 10000, 10001), actual = f.check('maximum period').outputs;
  assert.ok(Number.isNaN(actual.up[9999]));
  assert.equal(actual.up[10000], 0);
  assert.equal(actual.down[10000], 0);
  assert.equal(actual.up[10001], 100);
  assert.equal(actual.down[10001], 100);
});

test('Aroon append, repeated current replacements and historical corrections match fresh scans', t => {
  const all = mixedBars(85), rows = all.slice(0, 48), period = 7;
  const f = fixture(t, rows, period);
  f.check('initial');
  for (const row of all.slice(48, 65)) {
    rows.push(row); f.store.append(row); f.check(`append ${rows.length - 1}`);
  }
  const last = rows.length - 1;
  for (const [high, low] of [[100, -100], [2, -2], [17, -19], [0, -0], [100, -100]]) {
    rows[last] = bar(last, high, low, 3);
    f.store.upsert(rows[last]);
    const result = f.check(`replace current ${high}/${low}`);
    assert.equal(result.computedFrom, 64, 'same-bar replacement restores the nonzero checkpoint');
  }
  // Corrections on both sides of checkpoint boundaries remove old extrema
  // as well as create new ones, exposing stale state and premature reuse.
  for (const index of [0, 7, 8, 9, 31, 32, 33, 56]) {
    const original = rows[index];
    for (const replacement of [bar(index, 200 + index, -200 - index, 4), original]) {
      rows[index] = replacement; f.store.update(index, replacement);
      const result = f.check(`correct ${index}`);
      assert.equal(result.computedFrom, Math.floor(index / 8) * 8);
    }
  }
  for (const row of all.slice(65)) {
    rows.push(row); f.store.append(row); f.check(`append after correction ${rows.length - 1}`);
  }
});

test('Aroon prepend, shorter reset, empty reset and refill restart the correct warm-up', t => {
  const all = mixedBars(61), rows = all.slice(11), f = fixture(t, rows, 7);
  f.check('initial suffix');
  const prefix = all.slice(0, 11);
  f.store.prepend(prefix); rows.unshift(...prefix); f.check('prepend');
  for (const replacement of [mixedBars(4, 100), mixedBars(8, 200), [], mixedBars(23, 300), []]) {
    rows.splice(0, rows.length, ...replacement); f.store.setData(rows); f.check(`reset ${rows.length}`);
  }
  for (const row of mixedBars(11, 400)) {
    rows.push(row); f.store.append(row); f.check(`refill ${rows.length}`);
  }
});

test('Aroon restored snapshots match fresh scans at warm-up and mature boundaries', () => {
  const period = 7, rows = mixedBars(57), factory = builtinIndicators.get('aroon');
  assert.equal(typeof factory, 'function');
  const definition = factory({period});
  for (const split of [0, 1, 6, 7, 8, 16, 32, 56]) {
    const source = definition.create();
    for (let i = 0; i < split; i++) source.step(rows[i], i);
    const snapshot = source.snapshot(), preserved = structuredClone(snapshot);
    // Advancing the original must not change its previously returned snapshot.
    for (let i = split; i < rows.length; i++) source.step(rows[i], i);
    assert.deepEqual(snapshot, preserved, `snapshot ownership at ${split}`);
    for (const branch of [rows, rows.map((row, i) => i < split ? row : bar(i, i % 3 ? 8 : 90, i % 4 ? -6 : -90))]) {
      const restored = definition.create(), expected = scanAroon(branch, period);
      restored.restore(snapshot);
      const actual = Object.fromEntries(OUTPUTS.map(name => [name, []]));
      for (let i = split; i < branch.length; i++) {
        const values = restored.step(branch[i], i);
        assert.equal(values.length, OUTPUTS.length);
        OUTPUTS.forEach((name, j) => actual[name].push(values[j]));
      }
      compare(actual, Object.fromEntries(OUTPUTS.map(name => [name, expected[name].slice(split)])), `restored ${split}`);
      assert.deepEqual(snapshot, preserved, `restore must not consume or mutate snapshot at ${split}`);
    }
  }
});

test('Aroon keeps BarStore finite-field validation and unchanged outputs after rejected input', t => {
  const rows = mixedBars(19), f = fixture(t, rows, 7);
  const version = f.store.version;
  for (const field of FIELDS) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      assert.throws(() => f.store.update(10, {...rows[10], [field]: invalid}), /finite/i);
      assert.throws(() => f.store.append({...bar(19, 5, -5), [field]: invalid}), /finite/i);
      assert.equal(f.store.version, version, `${field}: failed validation is atomic`);
    }
  }
  f.check('after rejected nonfinite OHLCV');
});
