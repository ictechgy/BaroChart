// Stateful bundle/WASM comparison. Every scenario owns exactly one realm and engine.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {parseLossless, stringifyLossless} from '../trace/bcjson.mjs';
import {createWasmHarness} from './wasm-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VECTOR_DIRECTORY = join(ROOT, 'test/fixtures/rust-core-vectors');
const hash = text => createHash('sha256').update(text).digest('hex');

/** This corpus uses the supported Node 22 oracle; Node 26 has a reproduced JSON.parse defect. */
export function assertOracleRuntime(runtime = process.versions) {
  assert.equal(runtime.node?.split('.')[0], '22', 'Core conformance requires the pinned Node 22 oracle');
}

// Only data enters the realm. defineProperty preserves own __proto__ and undefined.
const MATERIALIZE = `globalThis.__bcMaterialize=function build(node){
 const tag=node[0],value=node[1];
 if(tag==='u')return undefined;if(tag==='z')return null;if(tag==='n')return Number(value);
 if(tag==='b'||tag==='s')return value;if(tag==='a')return value.map(build);
 const object={};for(const [key,child] of value)Object.defineProperty(object,key,{value:build(child),writable:true,enumerable:true,configurable:true});return object;
};`;

function dataTree(value) {
  if (value === undefined) return ['u'];
  if (value === null) return ['z'];
  if (typeof value === 'number') return ['n', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['s', value];
  if (typeof value === 'boolean') return ['b', value];
  if (Array.isArray(value)) return ['a', value.map(dataTree)];
  assert.equal(Object.getPrototypeOf(value), Object.prototype, 'oracle arguments must be plain data');
  return ['o', Object.keys(value).map(key => [key, dataTree(value[key])])];
}

/** Evaluates the actual shipped bundle once and reuses its state for every call. */
export async function createJavaScriptOracle() {
  assertOracleRuntime();
  const context = vm.createContext({Intl});
  vm.runInContext(await readFile(join(ROOT, 'native/Resources/aster-core.js'), 'utf8'), context, {timeout: 5_000});
  vm.runInContext(MATERIALIZE, context);
  return {
    call(name, args) {
      const callable = context[name];
      if (typeof callable !== 'function') return {status: 'missing'};
      const tree = JSON.stringify(dataTree(args));
      const realmArgs = vm.runInContext(`__bcMaterialize(JSON.parse(${JSON.stringify(tree)}))`, context);
      try {return {status: 0, value: Reflect.apply(callable, context, realmArgs)}}
      catch (error) {return {status: error.name === 'UnavailableError' ? 2 : 1, error: {name: error.name, message: error.message, code: error.code ?? null}}}
    },
  };
}

function outcomeText(outcome) {
  return stringifyLossless(outcome.status === 0 ? {status: 0, value: outcome.value} : {status: outcome.status, error: outcome.error});
}

/** Runs the calls and observations in one fixture without recreating either side. */
export async function runScenario(scenario) {
  assertOracleRuntime();
  assert.equal(scenario.metadata?.schema, 'aster.rust-core-vectors', 'fixture schema');
  assert.equal(scenario.metadata?.version, 1, 'fixture version');
  const manifestText = await readFile(join(VECTOR_DIRECTORY, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const bundle = await readFile(join(ROOT, 'native/Resources/aster-core.js'));
  assert.equal(scenario.metadata.bundleSha256, hash(bundle), 'fixture bundle drift');
  assert.equal(scenario.metadata.oracleCommit, manifest.oracleCommit, 'fixture oracle drift');
  const javascript = await createJavaScriptOracle();
  const rust = await createWasmHarness();
  const results = [];
  try {
    for (const [index, call] of scenario.calls.entries()) {
      assert.ok([undefined, 'parity', 'rust-policy'].includes(call.comparison), 'unknown comparison policy');
      if (call.comparison === 'rust-policy') {
        assert.equal(manifest.functions.find(entry => entry.name === call.name)?.status, 'reject', 'only explicit unavailable names may bypass the JS oracle');
      }
      const args = parseLossless(call.arguments);
      assert.ok(Array.isArray(args), 'fixture arguments must be an array');
      const actual = await rust.call(call.name, args);
      const actualText = outcomeText(actual);
      const oracle = call.comparison === 'rust-policy' ? null : javascript.call(call.name, args);
      const oracleText = oracle && outcomeText(oracle);
      const expected = call.expected;
      const equal = actualText === expected && (oracleText === null || oracleText === expected);
      results.push({index, name: call.name, comparison: call.comparison ?? 'parity', equal, expected, actual: actualText, oracle: oracleText});
    }
  } finally {await rust.dispose()}
  return {schema: 'aster.rust-core-conformance-result', version: 1, suite: scenario.suite, name: scenario.name,
    metadata: scenario.metadata, manifestSha256: hash(manifestText), execution: {node: process.version, v8: process.versions.v8, icu: process.versions.icu, tz: process.versions.tz, platform: process.platform, arch: process.arch},
    equal: results.every(result => result.equal), results};
}

export async function readScenarios() {
  const paths = (await readdir(VECTOR_DIRECTORY)).filter(path => path.endsWith('.jsonl') && !path.endsWith('.leaf.jsonl')).sort();
  return (await Promise.all(paths.map(async path => (await readFile(join(VECTOR_DIRECTORY, path), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))))).flat();
}

async function main() {
  const args = process.argv.slice(2);
  const scenarios = await readScenarios();
  const manifest = JSON.parse(await readFile(join(VECTOR_DIRECTORY, 'manifest.json'), 'utf8'));
  if (args.includes('--list')) {
    process.stdout.write(JSON.stringify({manifest, suites: scenarios.map(({suite, name}) => ({suite, name}))}, null, 2) + '\n');
    return;
  }
  const suitesAt = args.indexOf('--suite');
  const requested = suitesAt >= 0 ? args[suitesAt + 1]?.split(',') : null;
  assert.ok(suitesAt < 0 || requested?.length, '--suite requires names');
  const selected = requested ? scenarios.filter(value => requested.includes(value.suite)) : scenarios;
  assert.ok(selected.length, 'no matching conformance scenarios');
  if (requested) for (const name of requested) assert.ok(selected.some(value => value.suite === name), `suite missing: ${name}`);
  const reports = [];
  for (const scenario of selected) reports.push(await runScenario(scenario));
  const output = JSON.stringify(reports, null, 2) + '\n';
  const outputAt = args.indexOf('--output');
  assert.ok(outputAt < 0 || args[outputAt + 1] && !args[outputAt + 1].startsWith('--'), '--output requires a file');
  if (outputAt >= 0) await writeFile(resolve(args[outputAt + 1]), output);
  process.stdout.write(output);
  if (reports.some(report => !report.equal)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
