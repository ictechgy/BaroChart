import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';
import {createWasmHarness, wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

const cargoAvailable = existsSync(join(rustupBinDirectory(process.env), 'cargo'));
const wasmAvailability = wasmTargetAvailable();
const requireWasm = process.env.REQUIRE_WASM === '1';
const skipReason = !cargoAvailable ? 'rustup cargo is unavailable'
  : !wasmAvailability.available ? wasmAvailability.reason
    : false;
const skip = requireWasm ? false : skipReason;

test('WASM harness compares nativeInit with the Node VM and reports staged unavailable errors', {
  skip,
}, async t => {
  const harness = await createWasmHarness();
  t.after(() => harness.dispose());

  const comparison = await harness.compare('nativeInit', [0, null]);
  assert.equal(comparison.equal, true);
  assert.equal(comparison.javascript, 0);
  assert.equal(comparison.rust.status, 0);
  assert.equal(comparison.rust.value, 0);
  const nonzeroComparison = await harness.compare('nativeInit', [1, null]);
  assert.equal(nonzeroComparison.equal, true);
  assert.equal(nonzeroComparison.rust.value, 1);
  const recordComparison = await harness.compare('nativeInit', [1, {}]);
  assert.equal(recordComparison.equal, true, 'arguments must belong to the VM realm');

  const unavailable = await harness.call('nativeSelfTest', []);
  assert.equal(unavailable.status, 2);
  assert.deepEqual(unavailable.error, {
    name: 'UnavailableError',
    message: 'nativeSelfTest is not available in the Rust backend',
    code: null,
  });
  assert.equal((await harness.call('__bcMathForTest', ['log', 2])).status, 2, 'release build must not expose debug probes');
});

test('WASM calls refresh memory views after growth and release the owned engine once', {
  skip,
}, async t => {
  const harness = await createWasmHarness();
  t.after(() => harness.dispose());
  harness.instance.exports.memory.grow(1);

  assert.equal((await harness.call('nativeInit', [1, null])).value, 1);
  await harness.dispose();
  assert.equal(harness.hostReleaseCount, 1);
  assert.equal(harness.unexpectedReleaseCount, 0);
});

test('WASM ABI rejects malformed pointer ranges without trapping or leaking', {
  skip,
}, async t => {
  const harness = await createWasmHarness();
  t.after(() => harness.dispose());
  const {instance, engine} = harness;
  const output = harness.allocate(12);
  try {
    const status = instance.exports.bc_call(engine, 0xfffffff0, 64, 0, 0, 1, output);
    assert.equal(status, 6);
    const invalidOutput = instance.exports.bc_call(engine, 0, 0, 0, 0, 1, 0xfffffff0);
    assert.equal(invalidOutput, 6);
  } finally {harness.free(output, 12)}
});

test('debug WASM probes execute V8 math and Intl time-zone imports through the ABI', {
  skip,
}, async t => {
  const harness = await createWasmHarness({profile: 'debug', targetDirectory: 'artifacts/rust-wasm/harness-debug-target'});
  t.after(() => harness.dispose());
  const allocationBaseline = (await harness.call('__bcAllocationStatsForTest', [])).value;

  const mathCases = [
    ['log', 8, undefined, Math.log(8)],
    ['exp', 1.25, undefined, Math.exp(1.25)],
    ['hypot', 3, 4, Math.hypot(3, 4)],
  ];
  for (const [operation, left, right, expected] of mathCases) {
    const args = right === undefined ? [operation, left] : [operation, left, right];
    assert.equal((await harness.call('__bcMathForTest', args)).value, expected);
  }
  assert.deepEqual(harness.importCalls, {
    js_log: 1, js_exp: 1, js_hypot: 1, zone_resolve: 0, zone_offset_seconds: 0,
  });

  assert.equal((await harness.call('__bcZoneResolveForTest', ['Etc/UTC'])).value, 'UTC');
  const offset = await harness.call('__bcZoneOffsetForTest', ['America/New_York', 1_700_000_000_000]);
  assert.equal(offset.value, -18_000);
  const invalidOffset = await harness.call('__bcZoneOffsetForTest', ['Not/A_Real_Zone', 1_700_000_000_000]);
  assert.equal(invalidOffset.status, 1);
  assert.equal(invalidOffset.error.name, 'TypeError');
  const invalidZone = await harness.call('__bcZoneResolveForTest', ['Not/A_Real_Zone']);
  assert.equal(invalidZone.status, 1);
  assert.equal(invalidZone.error.name, 'TypeError');
  assert.deepEqual(harness.importCalls, {
    js_log: 1, js_exp: 1, js_hypot: 1, zone_resolve: 2, zone_offset_seconds: 2,
  });
  assert.deepEqual((await harness.call('__bcAllocationStatsForTest', [])).value, allocationBaseline,
                   'owned input, descriptor, and result buffers must all be freed');
  await harness.dispose();
  assert.equal(harness.hostReleaseCount, 1);
  assert.equal(harness.unexpectedReleaseCount, 0);
});
