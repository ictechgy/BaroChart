import test from 'node:test';
import assert from 'node:assert/strict';
import {safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';
import {createLayoutMemory,LAYOUT_STORAGE_KEY} from '../examples/web/layout-memory.mjs';
import {MAX_DEMO_LAYOUT_BYTES} from '../examples/web/demo-layout-preset.mjs';

const preset = (range = [-0, 200]) => ({
  schema: 'barochart.main-demo-layout', version: 1, market: 'us', count: 10000, light: false,
  layout: {
    panels: [{id: 'price', range}, {id: 'volume'}], axes: [],
    series: [{id: 'price', type: 'candles', panel: 'price'}, {id: 'volume', type: 'histogram', source: 'volume', panel: 'volume'}],
    indicators: [],
  },
});

function storageFixture(initial = undefined) {
  const values = new Map(initial === undefined ? [] : [[LAYOUT_STORAGE_KEY, initial]]);
  const calls = [];
  return {
    values, calls,
    storage: {
      getItem(key) { calls.push(['get', key]); return values.get(key) ?? null; },
      setItem(key, value) { calls.push(['set', key, value]); values.set(key, value); },
      removeItem(key) { calls.push(['remove', key]); values.delete(key); },
    },
  };
}

test('layout memory reads the owned key without writing and preserves -0 through a save', () => {
  const fake = storageFixture(), statuses = [], memory = createLayoutMemory({
    getStorage: () => fake.storage, getPreset: () => preset(), onStatus: message => statuses.push(message), delay: 5,
  });
  assert.deepEqual(memory.read(), {enabled: true, preset: null});
  assert.deepEqual(fake.calls, [['get', LAYOUT_STORAGE_KEY]]);
  assert.equal(memory.changed(), true);
  assert.equal(memory.flush(), true);
  assert.equal(fake.calls.filter(call => call[0] === 'set').length, 1);
  const document = safeCheckpointParse(fake.values.get(LAYOUT_STORAGE_KEY));
  assert.equal(document.schema, 'barochart.main-demo-memory');
  assert.equal(document.enabled, true);
  assert.equal(document.preset.layout.panels[0].range[0], -0);
  assert.deepEqual(statuses, ['레이아웃을 저장했습니다.']);
  memory.dispose();
});

test('startup read followed by a clean flush is read-only', () => {
  const fake = storageFixture(), memory = createLayoutMemory({
    getStorage: () => fake.storage, getPreset: () => { throw new Error('must not capture'); },
  });
  assert.deepEqual(memory.read(), {enabled: true, preset: null});
  assert.equal(memory.flush(), true);
  assert.equal(fake.calls.filter(call => call[0] === 'set').length, 0);
  memory.dispose();
});

test('rapid explicit changes coalesce and flush captures the latest valid preset', () => {
  const fake = storageFixture(); let current = preset([0, 100]);
  const memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => current, delay: 50});
  memory.read();
  memory.changed(); current = preset([1, 99]); memory.changed();
  assert.equal(memory.flush(), true);
  assert.equal(fake.calls.filter(call => call[0] === 'set').length, 1);
  assert.equal(safeCheckpointParse(fake.values.get(LAYOUT_STORAGE_KEY)).preset.layout.panels[0].range[0], 1);
  memory.dispose();
});

test('invalid stored data falls back safely and a quota failure leaves the last good record intact', () => {
  const fake = storageFixture('{bad'), statuses = [];
  const memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => preset(), onStatus: message => statuses.push(message)});
  assert.deepEqual(memory.read(), {enabled: true, preset: null});
  memory.changed();
  assert.equal(memory.flush(), true);
  const previous = fake.values.get(LAYOUT_STORAGE_KEY);
  fake.storage.setItem = () => { throw new Error('private quota detail'); };
  assert.equal(memory.changed(), true);
  assert.equal(memory.flush(), false);
  assert.equal(fake.values.get(LAYOUT_STORAGE_KEY), previous);
  assert.equal(statuses.some(message => /유효하지 않아/.test(message)), true);
  assert.equal(statuses.some(message => /저장에 실패/.test(message)), true);
  assert.equal(statuses.some(message => /private|quota/i.test(message)), false);
  memory.dispose();
});

test('opt out persists a disabled sentinel, clear only touches its key, and dispose cancels pending work', () => {
  const fake = storageFixture(), memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => preset(), delay: 5});
  fake.values.set('unrelated', 'keep');
  memory.read(); memory.changed();
  assert.equal(memory.setEnabled(false), true);
  assert.equal(memory.enabled, false);
  const disabled = safeCheckpointParse(fake.values.get(LAYOUT_STORAGE_KEY));
  assert.deepEqual(disabled, {schema: 'barochart.main-demo-memory', version: 1, enabled: false, preset: null});
  assert.equal(memory.clear(), true);
  assert.equal(fake.values.has(LAYOUT_STORAGE_KEY), true);
  assert.equal(fake.values.get('unrelated'), 'keep');
  const before = fake.calls.length;
  memory.changed(); memory.dispose();
  assert.equal(fake.calls.length, before);
});

test('denied storage and a null or invalid current preset do not overwrite storage', () => {
  const fake = storageFixture(), statuses = [], values = [null, {...preset(), layout: {...preset().layout, panels: []}}]; let current = values[0];
  const memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => current, onStatus: message => statuses.push(message)});
  memory.read();
  memory.changed();
  assert.equal(memory.flush(), false);
  current = values[1]; memory.changed(); assert.equal(memory.flush(), false);
  fake.storage.setItem = () => { throw new Error('denied'); }; current = preset();
  memory.changed();
  assert.equal(memory.flush(), false);
  assert.equal(fake.calls.filter(call => call[0] === 'set').length, 0);
  assert.equal(statuses.some(message => /준비된 뒤/.test(message)), true);
  assert.equal(statuses.some(message => /저장에 실패/.test(message)), true);
  memory.dispose();
});

test('oversized stored input is rejected before parsing and remains untouched', () => {
  const oversized = 'x'.repeat(MAX_DEMO_LAYOUT_BYTES + 257), fake = storageFixture(oversized), statuses = [];
  const memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => preset(), onStatus: message => statuses.push(message)});
  assert.deepEqual(memory.read(), {enabled: true, preset: null});
  assert.equal(fake.values.get(LAYOUT_STORAGE_KEY), oversized);
  assert.equal(fake.calls.filter(call => call[0] === 'set' || call[0] === 'remove').length, 0);
  assert.equal(statuses.some(message => /유효하지 않아/.test(message)), true);
  memory.dispose();
});

test('failed enable changes preserve state, dirty intent, and the last good record', () => {
  const fake = storageFixture(), current = preset([2, 80]);
  const memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => current});
  memory.read(); memory.changed(); assert.equal(memory.flush(), true);
  const previous = fake.values.get(LAYOUT_STORAGE_KEY), oldPreset = memory.read().preset;
  memory.changed();
  fake.storage.setItem = () => { throw new Error('quota'); };
  assert.equal(memory.setEnabled(false), false);
  assert.equal(memory.enabled, true);
  assert.strictEqual(memory.read().preset, oldPreset);
  assert.equal(fake.values.get(LAYOUT_STORAGE_KEY), previous);
  fake.storage.setItem = (key, value) => fake.values.set(key, value);
  assert.equal(memory.flush(), true, 'dirty intent remains available for an explicit retry');
  memory.dispose();
});

test('clear is a single sentinel write and preserves state when that write fails', () => {
  const fake = storageFixture(), memory = createLayoutMemory({getStorage: () => fake.storage, getPreset: () => preset()});
  memory.read(); memory.changed(); assert.equal(memory.flush(), true);
  const previous = fake.values.get(LAYOUT_STORAGE_KEY), oldPreset = memory.read().preset;
  fake.storage.removeItem = () => { throw new Error('must not remove'); };
  fake.storage.setItem = () => { throw new Error('denied'); };
  assert.equal(memory.clear(), false);
  assert.equal(memory.enabled, true);
  assert.strictEqual(memory.read().preset, oldPreset);
  assert.equal(fake.values.get(LAYOUT_STORAGE_KEY), previous);

  fake.storage.setItem = (key, value) => fake.values.set(key, value);
  assert.equal(memory.clear(), true);
  assert.deepEqual(safeCheckpointParse(fake.values.get(LAYOUT_STORAGE_KEY)), {schema: 'barochart.main-demo-memory', version: 1, enabled: false, preset: null});
  memory.dispose();
});
