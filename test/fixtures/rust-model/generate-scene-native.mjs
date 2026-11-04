#!/usr/bin/env node
// scene-log의 host-dependent Math.log/exp를 같은 public Aster API에서 다시 계산한다.
// fixture 입력은 scene generator가 기록한 원본이며, Rust 기대값을 읽거나 변환하지 않는다.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [fixturePath, engine = 'quickjs'] = process.argv.slice(2);
assert(fixturePath, 'usage: generate-scene-native.mjs FIXTURE [quickjs|jsc]');
assert(['quickjs', 'jsc'].includes(engine), `unknown scene oracle engine ${engine}`);
assert.equal(process.versions.node.split('.')[0], '22', `native scene oracle requires Node 22 (got ${process.version})`);

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const BUNDLE = readFileSync(resolve(ROOT, 'native/Resources/aster-core.js'), 'utf8');
const sceneRows = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))
  .filter(row => row.kind === 'scene');
const rows = sceneRows.filter(row => row.id === 'scene-log');
assert.equal(rows.length, 1, `expected one scene-log row, got ${rows.length}`);

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').trim()}`);
  }
}

function buildQuickjsHost() {
  const quickjsDir = resolve(ROOT, 'native/android/quickjs');
  const hostSource = resolve(ROOT, 'rust/tools/conformance/quickjs-host.c');
  const host = resolve(ROOT, 'artifacts/native-axis-oracle/quickjs-host');
  if (existsSync(host)) return host;
  mkdirSync(dirname(host), {recursive: true});
  const cc = process.env.CC ?? 'cc';
  const version = readFileSync(resolve(quickjsDir, 'VERSION'), 'utf8').trim();
  const objectPath = `${host}.${process.pid}.o`;
  const partialPath = `${host}.${process.pid}.partial`;
  const sources = ['quickjs', 'dtoa', 'libregexp', 'libunicode', 'cutils'];
  try {
    run(cc, [
      '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_GNU_SOURCE',
      '-isystem', quickjsDir, '-c', hostSource, '-o', objectPath,
    ]);
    run(cc, [
      '-std=gnu11', '-O2', '-Werror', '-D_GNU_SOURCE', `-DCONFIG_VERSION="${version}"`,
      '-I', quickjsDir, objectPath,
      ...sources.map(name => resolve(quickjsDir, `${name}.c`)),
      '-lm', '-pthread', '-o', partialPath,
    ]);
    renameSync(partialPath, host);
  } finally {
    rmSync(objectPath, {force: true});
    rmSync(partialPath, {force: true});
  }
  return host;
}

const runtime = engine === 'jsc'
  ? (process.env.JSC_PATH ?? '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc')
  : buildQuickjsHost();
if (engine === 'jsc') assert(existsSync(runtime), `JavaScriptCore shell not found at ${runtime}`);

// Earlier scene inputs also construct stores. Replay that original call order
// so the geometry identity in the full scene remains part of the comparison.
const logIndex = sceneRows.findIndex(row => row.id === 'scene-log');
const cases = sceneRows.slice(0, logIndex + 1).map(row => ({scenarioId: row.id, input: row.input}));
const driver = `
const cases = ${JSON.stringify(cases)};
const bits = new DataView(new ArrayBuffer(8));
function f64(value) {
  bits.setFloat64(0, value, false);
  return bits.getBigUint64(0, false).toString(16).padStart(16, '0');
}
function fromF64(hex) {
  bits.setBigUint64(0, BigInt('0x' + hex), false);
  return bits.getFloat64(0, false);
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$f64') return fromF64(value.$f64);
  if (keys.length === 1 && keys[0] === '$undefined') return undefined;
  if (keys.length === 1 && keys[0] === '$f64array') return Float64Array.from(value.$f64array, fromF64);
  if (keys.length === 1 && keys[0] === '$object') {
    return Object.fromEntries(value.$object.map(entry => [entry[0], decode(entry[1])]));
  }
  return Object.fromEntries(keys.map(key => [key, decode(value[key])]));
}
function encode(value) {
  if (typeof value === 'number') return {$f64: f64(value)};
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return {$undefined: true};
  if (value instanceof Float64Array) return {$f64array: Array.from(value, f64)};
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return {$object: Object.entries(value)
      .filter(([, child]) => typeof child !== 'function')
      .map(([key, child]) => [key, encode(child)])};
  }
  throw new TypeError('Unsupported scene oracle value');
}
cases.map(({scenarioId, input: rawInput}) => {
  const spec = decode(rawInput);
  const store = new Aster.BarStore(spec.bars);
  const model = new Aster.ChartModel({store, ...(spec.model ?? {})});
  try {
    for (const definition of spec.series ?? []) {
      const options = {...definition};
      if (Array.isArray(options.values)) options.values = Float64Array.from(options.values);
      model.addSeries(options);
    }
    for (const drawing of spec.drawings ?? []) model.drawings.add(drawing);
    if (spec.symbol) new Aster.ChartAPI(model).setSymbol(spec.symbol);
    const scene = Aster.buildScene(model, spec.width, spec.height, spec.flags);
    const output = JSON.stringify({scenarioId, expectedNative: JSON.stringify(encode(scene))});
    model.dispose();
    if (scenarioId !== 'scene-log') return null;
    return typeof print === 'function' ? (print(output), output) : output;
  } catch (error) {
    model.dispose();
    throw error;
  }
}).filter(value => value !== null)[0]
`;
const script = [BUNDLE, driver].join('\n');
const scriptPath = `${fixturePath}.${process.pid}.${engine}.native.js`;
try {
  writeFileSync(scriptPath, script);
  const command = runtime;
  const args = engine === 'jsc' ? ['-m', scriptPath] : [scriptPath];
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error(`${engine} scene oracle failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').trim()}`);
  }
  const outputRows = result.stdout.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(outputRows.length, rows.length, `${engine} returned ${outputRows.length} rows for ${rows.length} scene vectors`);
  assert.equal(outputRows[0].scenarioId, 'scene-log', `${engine} returned wrong scene row`);
  assert.equal(typeof outputRows[0].expectedNative, 'string', `${engine} scene output missing wire`);
  process.stdout.write(`${JSON.stringify(outputRows[0])}\n`);
} finally {
  rmSync(scriptPath, {force: true});
}
