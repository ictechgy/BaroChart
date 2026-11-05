import assert from 'node:assert/strict';

const wasm = await import('barochart/wasm');
const asset = await import('barochart/wasm-asset');
const migration = await import('barochart/wasm-migration');
const workerEntry = await import('barochart/wasm-worker-entry');

assert.equal(typeof wasm.loadRustBackend, 'function');
assert.equal(typeof wasm.createRustChart, 'function');
assert.equal(typeof wasm.RustSession, 'function');
assert.equal(typeof asset.defaultWasmURL, 'function');
assert.equal(typeof migration.captureJavaScriptMigration, 'function');
assert.deepEqual(Object.keys(workerEntry), []);
assert.equal(asset.defaultWasmURL().protocol, 'file:');
assert.equal(typeof globalThis.Worker, 'undefined');
console.log(JSON.stringify({
  wasmExports: Object.keys(wasm).sort(),
  migrationExports: Object.keys(migration).sort(),
  workerEntryExports: Object.keys(workerEntry).sort(),
  wasmURL: asset.defaultWasmURL().pathname,
  ssrSafe: true,
}));
