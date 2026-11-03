import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {createJavaScriptOracle, readScenarios, runScenario} from '../scripts/rust/core-conformance.mjs';
import {wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

test('native manifest matches the actual bundle census, Rust table and command arities', async () => {
  const text = await readFile(new URL('../native/Resources/aster-core.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('./fixtures/rust-core-vectors/manifest.json', import.meta.url), 'utf8'));
  const context = vm.createContext({Intl});
  vm.runInContext(text, context);
  const names = Object.keys(context).filter(name => name.startsWith('native') && typeof context[name] === 'function').sort();
  assert.equal(names.length, 100);
  assert.deepEqual(manifest.functions.map(row => row.name).sort(), names);
  assert.equal(manifest.bundleSha256, createHash('sha256').update(text).digest('hex'));
  const rust = await readFile(new URL('../rust/crates/barochart-bridge/src/manifest.rs', import.meta.url), 'utf8');
  const entries = [...rust.matchAll(/name:\s*"([^"]+)",\s*status:\s*FunctionStatus::(\w+),\s*handler:\s*(Some\((\w+)\)|None)/g)].map(([, name, status, , handler]) => ({name, status: status.toLowerCase(), handler: handler ?? null}));
  assert.deepEqual(entries, manifest.functions.map(({name, status, handler}) => ({name, status, handler})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const api = await readFile(new URL('../src/core/api.mjs', import.meta.url), 'utf8');
  const arity = api.match(/const arity=\{([^}]+)\}/)[1];
  const commands = arity.split(',').map(entry => {const [name, maxArguments] = entry.split(':');return {name, maxArguments: Number(maxArguments)}});
  assert.equal(commands.length, 65);
  assert.deepEqual(manifest.commands.map(({name, maxArguments}) => ({name, maxArguments})), commands);
});

test('oracle materializes arguments in its realm while preserving ordered special values', async () => {
  const oracle = await createJavaScriptOracle();
  const value = Object.defineProperty({z: undefined, n: -0}, '__proto__', {value: {x: 1}, enumerable: true});
  const outcome = oracle.call('nativeEcho', [value]);
  assert.equal(outcome.status, 0);
  assert.equal(Object.hasOwn(outcome.value, '__proto__'), true);
  assert.equal(Object.hasOwn(outcome.value, 'z'), true);
  assert.equal(Object.is(outcome.value.n, -0), true);
  assert.deepEqual(Object.keys(outcome.value), ['z', 'n', '__proto__']);
  assert.equal(oracle.call('nativeInit', [0, {}]).status, 0);
});

const availability = wasmTargetAvailable();
test('stateful A0 scenarios compare actual bundle calls and Rust WASM outcomes', {
  skip: process.env.REQUIRE_WASM === '1' ? false : !availability.available && availability.reason,
}, async () => {
  const scenarios = (await readScenarios()).filter(scenario => scenario.suite === 'a0');
  assert.equal(scenarios.length, 2);
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    assert.equal(result.equal, true, JSON.stringify(result.results.filter(value => !value.equal)));
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  }
});
