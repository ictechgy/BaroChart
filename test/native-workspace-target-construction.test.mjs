import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const bundle = await buildNativeBundle({modulePaths: [new URL('./fixtures/native-workspace-module.mjs', import.meta.url).pathname]});
const fixture = await readFile(new URL('./fixtures/native-workspace-target-construction.js', import.meta.url), 'utf8');
// Deliberately independent fixed coverage oracle, with one fresh VM per case.
const scenarios = [
  'ordinary admission and recovery',
  'nested workspace create is busy',
  'nested async create is busy',
  'nested prepared create is busy',
  'nested params create is busy',
  'dispose during construction cancels outer',
  'factory throw releases reservation',
  'cancelled outer preserves workspace replacement',
  'cancelled outer preserves params replacement',
  'post-construction vacancy failure releases reservation',
  'cleanup exception releases reservation',
  'cleanup exception preserves workspace replacement',
];
for (const scenario of scenarios) test('workspace target construction: ' + scenario, () => {
  const context = vm.createContext({nativeWorkspaceConstructionScenario: scenario, Intl: undefined});
  vm.runInContext(bundle, context, {timeout: 5000});
  const result = JSON.parse(vm.runInContext(fixture, context, {timeout: 5000}));
  assert.equal(result.case, 'native-workspace-target-construction');
  assert.equal(result.modeledUTC, false);
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.scenario, scenario);
  assert.equal(row.checks, row.assertions.length);
  assert.ok(row.checks >= 6, 'each scenario exercises admission, ownership and cleanup');
  const failed = row.assertions.filter(assertion => !assertion.passed);
  assert.deepEqual(failed, [], JSON.stringify({scenario, failed, observations: row.observations}, null, 2));
  assert.equal(row.passed, true);
  assert.equal(result.passed, true);
  assert.equal(context.nativeModel, undefined);
  assert.equal(context.nativeAPI, undefined);
  assert.equal(context.nativeInput, undefined);
  assert.equal(context.nativeSize, undefined);
});
