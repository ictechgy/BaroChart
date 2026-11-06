import assert from 'node:assert/strict';
import test from 'node:test';
import {createWasmHarness, wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

const availability = wasmTargetAvailable();
const skip = process.env.REQUIRE_WASM === '1' ? false : availability.available ? false : availability.reason;

test('WASM web ABI exposes a versioned executable capability contract and stats', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  assert.equal(harness.webAbiVersion(), 1);
  const capabilities = harness.webCapabilities();
  assert.equal(capabilities.status, 0);
  assert.equal(capabilities.value.schema, 'barochart.web-wasm.capabilities');
  assert.equal(capabilities.value.version, 1);
  assert.equal(capabilities.value.abi, 1);
  assert.equal(capabilities.value.transfer, 'f64-le');
  assert.equal(capabilities.value.packetVersion, 1);
  assert.ok(capabilities.value.implemented.includes('nativeInit'));
  assert.ok(capabilities.value.implemented.includes('nativeScenePacket'));
  assert.ok(capabilities.value.unavailable.includes('nativeRegisterIndicatorSource'));
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const stats = harness.webMemoryStats();
  assert.equal(stats.status, 0);
  assert.equal(typeof stats.value.requestedLiveBytes, 'number');
  assert.equal(typeof stats.value.requestedPeakBytes, 'number');
  assert.equal(typeof stats.value.byteBuffers, 'number');
});

test('WASM web read returns exact little-endian float64 bits from a real indicator buffer', {skip}, async t => {
  const harness = await createWasmHarness({profile: 'release', targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  const options = {
    panels: [{id: 'price'}],
    series: [],
  };
  assert.equal((await harness.call('nativeInit', [4, options])).status, 0);
  const rows = [
    {time: 1, open: 1, high: 2, low: 0, close: 1, volume: 1},
    {time: 2, open: 1, high: 3, low: 0, close: 2, volume: 1},
    {time: 3, open: 2, high: 4, low: 1, close: 3, volume: 1},
    {time: 4, open: 3, high: 5, low: 2, close: 4, volume: 1},
  ];
  assert.equal((await harness.call('nativeCommand', ['setData', [rows]])).status, 0);
  assert.equal((await harness.call('nativeCommand', ['addIndicator', ['s', 'sma', {period: 2}]] )).status, 0);
  const result = harness.webCall('nativeIndicatorBuffer', ['s', 'value', 0, 4]);
  assert.equal(result.status, 0);
  assert.equal(result.value.byteLength, 32);
  const view = new DataView(result.value.buffer, result.value.byteOffset, result.value.byteLength);
  assert.equal(view.getBigUint64(0, true), 0x7ff8000000000000n);
  assert.equal(view.getFloat64(8, true), 1.5);
  assert.equal(view.getFloat64(16, true), 2.5);
  assert.equal(view.getFloat64(24, true), 3.5);
});

test('debug WASM web read preserves signed zero, NaN payload and infinity bits', {skip}, async t => {
  const harness = await createWasmHarness({profile: 'debug', targetDirectory: 'artifacts/rust-wasm/harness-debug-target'});
  t.after(() => harness.dispose());
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const result = harness.webCall('__bcReadF64ForTest', []);
  assert.equal(result.status, 0);
  const view = new DataView(result.value.buffer, result.value.byteOffset, result.value.byteLength);
  assert.equal(view.getBigUint64(0, true), 0n);
  assert.equal(view.getBigUint64(8, true), 0x8000000000000000n);
  assert.equal(view.getBigUint64(16, true), 0x7ff8000000000042n);
  assert.equal(view.getBigUint64(24, true), 0x7ff0000000000000n);
});

test('WASM web packet boundary rejects malformed input without publishing numeric bytes', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const result = harness.webPacket({not: 'an array'});
  assert.equal(result.status, 6);
  assert.equal(result.numbers.byteLength, 0);
  assert.equal(result.metadata.byteLength > 0, true);
  const error = JSON.parse(new TextDecoder().decode(result.metadata));
  assert.equal(error.name, 'TypeError');
  assert.equal(typeof error.message, 'string');
});

test('WASM web write rejects an invalid source pointer and leaves didWrite at zero', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const result = harness.instance.exports.bc_web_write_f64(
    harness.engine, 0xfffffff0, 4, 0, 0, 1, 0xfffffff0, 2, 0, 0,
  );
  assert.equal(result, 6);
});

test('WASM web write rejects input above the advertised transfer bound before core dispatch', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  const limit = harness.webCapabilities().value.maxTransfer;
  const atLimit = harness.webWriteF64('__bounded_transfer_probe__', [], new Float64Array(limit));
  assert.equal(atLimit.status, 2, 'an in-bound request reaches the unavailable core operation');
  const oversized = harness.webWriteF64('__bounded_transfer_probe__', [], new Float64Array(limit + 1));
  assert.deepEqual(oversized, {status: 6, didWrite: 0, error: undefined});
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0, 'rejection leaves the engine usable');
});

test('WASM web write rejects source aliases into name and args without touching input or core', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const bytes = new Uint8Array(harness.instance.exports.memory.buffer);
  const descriptor = pointer => {
    const view = new DataView(harness.instance.exports.memory.buffer);
    return {pointer: view.getUint32(pointer, true), length: view.getUint32(pointer + 4, true), capacity: view.getUint32(pointer + 8, true)};
  };
  const readRaw = (pointer, length) => Array.from(bytes.slice(pointer, pointer + length));
  const name = new TextEncoder().encode('nativeAsyncTargetBuffer'), args = new TextEncoder().encode('[0,0,1]');
  for (const [label, sourceAlias] of [['name', 'name'], ['args', 'args']]) {
    const namePointer = harness.allocate(name.length), argsPointer = harness.allocate(args.length), didWrite = harness.allocate(4), error = harness.allocate(12);
    try {
      bytes.set(name, namePointer); bytes.set(args, argsPointer); new DataView(harness.instance.exports.memory.buffer).setUint32(didWrite, 9, true);
      const beforeName = readRaw(namePointer, name.length), beforeArgs = readRaw(argsPointer, args.length);
      const sourcePointer = sourceAlias === 'name' ? namePointer : argsPointer;
      const status = harness.instance.exports.bc_web_write_f64(harness.engine, namePointer, name.length, argsPointer, args.length, 1, sourcePointer, 1, didWrite, error);
      assert.equal(status, 6, label);
      assert.equal(new DataView(harness.instance.exports.memory.buffer).getUint32(didWrite, true), 0, `${label}: didWrite`);
      assert.deepEqual(readRaw(namePointer, name.length), beforeName, `${label}: name bytes`);
      assert.deepEqual(readRaw(argsPointer, args.length), beforeArgs, `${label}: args bytes`);
      assert.deepEqual(descriptor(error), {pointer: 0, length: 0, capacity: 0}, `${label}: canonical empty error`);
    } finally {harness.free(namePointer, name.length); harness.free(argsPointer, args.length); harness.free(didWrite, 4); harness.free(error, 12);}
  }
});

test('WASM web write rejects receipt aliases inside name and args before zeroing them', {skip}, async t => {
  const harness = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => harness.dispose());
  assert.equal((await harness.call('nativeInit', [0, null])).status, 0);
  const bytes = new Uint8Array(harness.instance.exports.memory.buffer);
  const name = new TextEncoder().encode('nativeAsyncTargetBuffer'), args = new TextEncoder().encode('[0,0,1]');
  for (const [label, receiptAlias] of [['name', 'name'], ['args', 'args']]) {
    const namePointer = harness.allocate(name.length), argsPointer = harness.allocate(args.length), error = harness.allocate(12);
    try {
      bytes.set(name, namePointer); bytes.set(args, argsPointer);
      const beforeName = Array.from(bytes.slice(namePointer, namePointer + name.length));
      const beforeArgs = Array.from(bytes.slice(argsPointer, argsPointer + args.length));
      const receipt = receiptAlias === 'name' ? namePointer : argsPointer;
      const status = harness.instance.exports.bc_web_write_f64(harness.engine, namePointer, name.length, argsPointer, args.length, 1, 0, 0, receipt, error);
      assert.equal(status, 6, label);
      assert.deepEqual(Array.from(bytes.slice(namePointer, namePointer + name.length)), beforeName, `${label}: name bytes`);
      assert.deepEqual(Array.from(bytes.slice(argsPointer, argsPointer + args.length)), beforeArgs, `${label}: args bytes`);
    } finally {harness.free(namePointer, name.length); harness.free(argsPointer, args.length); harness.free(error, 12);}
  }
});

test('WASM web write succeeds against a real async target and preserves exact receipt bits', {skip}, async t => {
  const source = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  const target = await createWasmHarness({targetDirectory: 'artifacts/rust-wasm/harness-target'});
  t.after(() => {source.dispose(); target.dispose();});
  assert.equal((await source.call('nativeInit', [4, null])).status, 0);
  assert.equal((await target.call('nativeInit', [4, null])).status, 0);
  const admission = await source.call('nativePrepareBegin', ['{"kind":"columns","length":4,"visibleBars":3}']);
  assert.equal(admission.status, 0);
  const descriptor = JSON.parse(admission.value);
  assert.equal((await target.call('nativePrepareCreate', [descriptor.metadataJSON])).status, 0);
  const bits = [0x3ff0000000000000n, 0x8000000000000000n, 0x7ff8000000000042n, 0x4008000000000000n];
  const result = target.webWriteF64Bits('nativeAsyncTargetBuffer', [0, 0, 4], bits);
  assert.deepEqual(result, {status: 0, didWrite: 1, error: undefined});
  assert.equal((await target.call('nativeAsyncRelease', [descriptor.ticket])).status, 0);
});
