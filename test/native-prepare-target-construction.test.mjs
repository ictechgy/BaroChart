import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const bundle = await buildNativeBundle({modulePaths: [new URL('./fixtures/native-workspace-module.mjs', import.meta.url).pathname]});
const fixture = await readFile(new URL('./fixtures/native-prepare-target-construction.js', import.meta.url), 'utf8');
// Fixed independently of the fixture: every case gets a fresh target VM.
const scenarios = [
  'ordinary admission and finish',
  'nested workspace create is busy',
  'nested params create is busy',
  'nested prepare create is busy',
  'nested async create is busy',
  'factory throw releases reservation',
  'workspace disposal cannot release construction reservation',
  'params disposal cannot release construction reservation',
  'unrelated disposal preserves admitted transfer',
];
const expectedBars = [
  {time: 1700000000000, open: 100, high: 103, low: 99, close: 102, volume: 11},
  {time: 1700000060000, open: 102, high: 105, low: 101, close: 104, volume: 13},
];
for (const scenario of scenarios) test('prepare target construction: ' + scenario, () => {
  const context = vm.createContext({nativePrepareConstructionScenario: scenario, Intl: undefined});
  vm.runInContext(bundle, context, {timeout: 5000});
  const result = JSON.parse(vm.runInContext(fixture, context, {timeout: 5000}));
  assert.equal(result.case, 'native-prepare-target-construction');
  assert.equal(result.modeledUTC, false);
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.scenario, scenario);
  assert.equal(row.checks, row.assertions.length);
  assert.ok(row.checks >= 12, 'each case checks admission, ownership, transfer and output');
  const failed = row.assertions.filter(assertion => !assertion.passed);
  assert.deepEqual(failed, [], JSON.stringify({scenario, failed, observations: row.observations}, null, 2));
  assert.deepEqual(row.observations.finished.bars, expectedBars);
  assert.deepEqual(row.observations.finished.outputs, {value: [102, 104], toString: [103, 105]});
  assert.equal(row.passed, true);
  assert.equal(result.passed, true);
  assert.equal(context.nativeModel, undefined);
  assert.equal(context.nativeAPI, undefined);
  assert.equal(context.nativeInput, undefined);
  assert.equal(context.nativeSize, undefined);
});
