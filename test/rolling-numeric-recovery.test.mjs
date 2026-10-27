import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, IndicatorEngine, builtinIndicators} from '../src/core/index.mjs';

function bar(index, close) {
  return {time: index * 60000, open: close, high: close, low: close, close, volume: 1};
}

function definition(name, period = 2) {
  return builtinIndicators.get(name)({period});
}

function stream(name, values) {
  const instance = definition(name).create();
  return values.map((value, index) => instance.step(bar(index, value), index));
}

function assertFlatOutput(name, output, value, label) {
  if (name === 'bollinger') assert.deepEqual(output, [value, value, value], label);
  else assert.deepEqual(output, [0], label);
}

for (const sign of [1, -1]) test(`rolling statistics recover when a ${sign > 0 ? 'positive' : 'negative'} dominant value leaves`, () => {
  const flat = sign, values = [sign * 1e16, flat, flat, flat];
  const bollinger = stream('bollinger', values);
  const cci = stream('cci', values);

  assert.ok(bollinger[0].every(Number.isNaN));
  assert.ok(Number.isFinite(bollinger[1][0]));
  assertFlatOutput('bollinger', bollinger[2], flat, 'first flat Bollinger window');
  assertFlatOutput('bollinger', bollinger[3], flat, 'subsequent flat Bollinger window');
  assert.ok(Number.isNaN(cci[0][0]));
  assert.ok(Number.isFinite(cci[1][0]));
  assertFlatOutput('cci', cci[2], flat, 'first flat CCI window');
  assertFlatOutput('cci', cci[3], flat, 'subsequent flat CCI window');
});

test('Bollinger keeps a finite constant window when p * mean overflows', () => {
  for (const value of [1e308, -1e308]) {
    const outputs = stream('bollinger', [value, value, value, value]);
    assert.ok(outputs[0].every(Number.isNaN));
    for (let index = 1; index < outputs.length; index++) {
      assertFlatOutput('bollinger', outputs[index], value, `${value}/${index}`);
    }
  }
});

const boundedWorkCases = [
  {name: 'huge constant', period: 64, value: () => 1e308},
  {name: 'odd balanced', period: 65, value: index => index % 2 ? -1 : 1},
];
for (const {name, period, value} of boundedWorkCases) test(`Bollinger ordinary eviction work stays constant for ${name} windows`, () => {
  // Coercions count actual ring-value reads without a wall-clock assertion.
  const counter = {coercions: 0}, counted = number => ({
    [Symbol.toPrimitive]() {counter.coercions++; return number;},
  }), instance = definition('bollinger', period).create();
  for (let index = 0; index < period; index++) instance.step(bar(index, counted(value(index))), index);
  counter.coercions = 0;
  const steps = 32;
  for (let index = period; index < period + steps; index++) {
    const output = instance.step(bar(index, counted(value(index))), index);
    assert.ok(output.every(Number.isFinite), `${period}/${index} finite output`);
  }
  assert.ok(counter.coercions <= steps * 12,
    `period ${period} performed ${counter.coercions} numeric coercions for ${steps} evictions`);
});

for (const name of ['bollinger', 'cci']) test(`${name} snapshot restore recovers the same flat window as a cold instance`, () => {
  for (const sign of [1, -1]) {
    const flat = sign, values = [sign * 1e16, flat, flat, flat], def = definition(name);
    const original = def.create();
    original.step(bar(0, values[0]), 0);
    original.step(bar(1, values[1]), 1);
    const snapshot = original.snapshot(), preserved = structuredClone(snapshot);
    const restored = def.create();
    restored.restore(snapshot);

    assertFlatOutput(name, restored.step(bar(2, flat), 2), flat, `${sign}/restored first flat window`);
    assertFlatOutput(name, restored.step(bar(3, flat), 3), flat, `${sign}/restored second flat window`);
    assert.deepEqual(snapshot, preserved, 'restore does not consume its input');

    const cold = def.create();
    cold.step(bar(1, flat), 1);
    assertFlatOutput(name, cold.step(bar(2, flat), 2), flat, `${sign}/cold flat window`);
  }
});

for (const sign of [1, -1]) test(`indicator engine recovers ${sign > 0 ? 'positive' : 'negative'} dominant values across append, update, and correction`, t => {
  const flat = sign, rows = Array.from({length: 8}, (_, index) => bar(index, flat));
  const store = new BarStore(rows), engine = new IndicatorEngine(store, {checkpointSize: 2});
  t.after(() => engine.dispose());
  engine.add('bb', 'bollinger', {period: 2});
  engine.add('cci', 'cci', {period: 2});

  const assertRecovered = (index, label) => {
    const bb = engine.get('bb'), cci = engine.get('cci');
    assert.equal(bb.outputs.middle[index], flat, `${label}/middle`);
    assert.equal(bb.outputs.upper[index], flat, `${label}/upper`);
    assert.equal(bb.outputs.lower[index], flat, `${label}/lower`);
    assert.equal(cci.outputs.value[index], 0, `${label}/cci`);
    return {bb, cci};
  };

  const dominant = sign * 1e16;
  rows.push(bar(rows.length, dominant)); store.append(rows.at(-1));
  rows.push(bar(rows.length, flat)); store.append(rows.at(-1));
  rows.push(bar(rows.length, flat)); store.append(rows.at(-1));
  assertRecovered(rows.length - 1, 'append eviction');

  const last = rows.length - 1;
  rows[last] = bar(last, dominant); store.update(last, rows[last]);
  rows[last] = bar(last, flat); store.update(last, rows[last]);
  const updated = assertRecovered(last, 'current update');
  assert.equal(updated.bb.computedFrom, Math.floor(last / 2) * 2);
  assert.equal(updated.cci.computedFrom, Math.floor(last / 2) * 2);

  const corrected = 4;
  rows[corrected] = bar(corrected, dominant); store.update(corrected, rows[corrected]);
  const correction = assertRecovered(corrected + 2, 'historical correction eviction');
  assert.equal(correction.bb.computedFrom, corrected);
  assert.equal(correction.cci.computedFrom, corrected);
  rows[corrected] = bar(corrected, flat); store.update(corrected, rows[corrected]);
  assertRecovered(corrected + 2, 'correction removal');
});
