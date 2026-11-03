import test from 'node:test';
import assert from 'node:assert/strict';
import { BarStore } from '../src/core/index.mjs';
import {
  applyLightweightBar,
  lightweightBarToBaro,
  lightweightBarsToBaro,
  lightweightSecondsToMilliseconds,
} from '../examples/web/lightweight-migration.mjs';

test('converts Lightweight Charts seconds to exact UTC milliseconds and preserves OHLCV', () => {
  assert.equal(lightweightSecondsToMilliseconds(1_700_000_000), 1_700_000_000_000);
  assert.equal(Object.is(lightweightSecondsToMilliseconds(-0), -0), true);
  assert.deepEqual(lightweightBarToBaro({
    time: 1_700_000_000,
    open: 10,
    high: 13,
    low: 9,
    close: 12,
    volume: 42,
  }), { time: 1_700_000_000_000, open: 10, high: 13, low: 9, close: 12, volume: 42 });

  const negativeZero = lightweightBarToBaro({ time: -0, open: -0, high: 1, low: -0, close: 0, volume: -0 });
  for (const field of ['time', 'open', 'low', 'volume']) {
    assert.equal(Object.is(negativeZero[field], -0), true, `${field} preserves negative zero`);
  }
  const store = new BarStore([negativeZero]);
  for (const field of ['time', 'open', 'low', 'volume']) {
    assert.equal(Object.is(store.columns[field][0], -0), true, `${field} remains negative zero in BarStore`);
  }
});

test('requires explicit volume data or a caller volume policy', () => {
  const candle = { time: 1, open: 10, high: 13, low: 9, close: 12 };
  assert.throws(() => lightweightBarToBaro(candle), /volume/i);
  assert.deepEqual(lightweightBarToBaro(candle, { volumeForBar: () => 0 }), {
    time: 1000, open: 10, high: 13, low: 9, close: 12, volume: 0,
  });
  assert.deepEqual(lightweightBarsToBaro([candle], { volumeForBar: () => 7 }), [{
    time: 1000, open: 10, high: 13, low: 9, close: 12, volume: 7,
  }]);
});

test('rejects unsupported time values, non-finite fields, invalid candles and unordered batches', () => {
  for (const time of ['2024-01-01', { year: 2024, month: 1, day: 1 }, 1.5, NaN, Infinity, 9e15]) {
    assert.throws(() => lightweightSecondsToMilliseconds(time));
  }
  assert.throws(() => lightweightSecondsToMilliseconds(8_640_000_000_001), /range|exact|safe/i);
  assert.throws(() => lightweightBarToBaro({ time: 1, open: 1, high: Infinity, low: 0, close: 1, volume: 0 }));
  assert.throws(() => lightweightBarToBaro({ time: 1, open: 4, high: 3, low: 2, close: 3, volume: 0 }));
  assert.throws(() => lightweightBarsToBaro([
    { time: 2, open: 1, high: 2, low: 0, close: 1, volume: 1 },
    { time: 1, open: 1, high: 2, low: 0, close: 1, volume: 1 },
  ]), /increasing|order/i);
});

test('applies an append, latest update, and historical correction to BarStore', () => {
  const store = new BarStore([
    { time: 1_000, open: 1, high: 2, low: 0, close: 1, volume: 1 },
    { time: 2_000, open: 2, high: 3, low: 1, close: 2, volume: 2 },
  ]);
  assert.equal(applyLightweightBar(store, { time: 3, open: 3, high: 4, low: 2, close: 3, volume: 3 }), 'append');
  assert.equal(applyLightweightBar(store, { time: 3, open: 3, high: 5, low: 2, close: 4, volume: 4 }), 'update');
  assert.equal(applyLightweightBar(store, { time: 1, open: 1, high: 3, low: 0, close: 2, volume: 5 }), 'correction');
  assert.deepEqual(store.at(0), { time: 1_000, open: 1, high: 3, low: 0, close: 2, volume: 5 });
  assert.deepEqual(store.at(2), { time: 3_000, open: 3, high: 5, low: 2, close: 4, volume: 4 });
  const snapshot = {
    version: store.version,
    columns: Object.fromEntries(Object.keys(store.columns).map(field => [field, Array.from(store.columns[field].slice(0, store.length))])),
  };
  assert.throws(() => applyLightweightBar(store, { time: 4, open: 3, high: Infinity, low: 2, close: 3, volume: 1 }));
  assert.throws(() => applyLightweightBar(store, { time: 0, open: 1, high: 2, low: 0, close: 1, volume: 1 }), /unknown|order|older/i);
  assert.equal(store.version, snapshot.version);
  assert.deepEqual(Object.fromEntries(Object.keys(store.columns).map(field => [field, Array.from(store.columns[field].slice(0, store.length))])), snapshot.columns);
});
