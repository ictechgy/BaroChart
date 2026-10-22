import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const shipped = await readFile(new URL('../native/Resources/aster-core.js', import.meta.url), 'utf8');
test('checked-in native SDK resource exactly matches the canonical generator', async () => {
  assert.ok(shipped === await buildNativeBundle(),
    'Regenerate with: node scripts/build-native.mjs --bundle-only --output native/Resources/aster-core.js');
});
test('checked-in native SDK resource executes metadata and drawing regressions', async () => {
  const context = vm.createContext({});
  vm.runInContext(shipped, context, {timeout: 5000});
  const fixture = await readFile(new URL('./fixtures/native-resource-parity.js', import.meta.url), 'utf8');
  const result = JSON.parse(vm.runInContext(fixture, context, {timeout: 5000}));
  assert.deepEqual(result, {case: 'native-resource-parity', passed: true, checks: 9,
    scenarios: ['optional symbol metadata', 'unselected keyboard cycle', 'collapsed ellipse stroke', 'cleanup'],
    modeledUTC: false});
});
