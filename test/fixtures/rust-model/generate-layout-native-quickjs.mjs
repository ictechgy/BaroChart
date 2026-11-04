#!/usr/bin/env node
// Linux GNU layout 시험용 독립 oracle. fixture 입력과 검토된 layout runtime을
// public ChartModel/createLayout 번들 + vendored QuickJS에서 그대로 실행한다.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [fixturePath] = process.argv.slice(2);
assert(fixturePath, 'usage: generate-layout-native-quickjs.mjs FIXTURE');
// Node only prepares the input; all model/layout values come from QuickJS below.
assert.equal(process.versions.node.split('.')[0], '22', `native layout oracle requires Node 22 (got ${process.version})`);

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const QUICKJS_DIR = resolve(ROOT, 'native/android/quickjs');
const QUICKJS_HOST_SOURCE = resolve(ROOT, 'rust/tools/conformance/quickjs-host.c');
const QUICKJS_HOST = resolve(ROOT, 'artifacts/native-axis-oracle/quickjs-host');
const BUNDLE = readFileSync(resolve(ROOT, 'native/Resources/aster-core.js'), 'utf8');
const RUNTIME = readFileSync(resolve(ROOT, 'test/fixtures/rust-model/layout-oracle-runtime.mjs'), 'utf8')
  .replace(/^import [^\n]*\n/gm, '')
  .replace(/^export \{[^\n]*\};?\n?/gm, '')
  .replace(/^export /gm, '');

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').trim()}`);
  }
}

function buildQuickjsHost() {
  if (existsSync(QUICKJS_HOST)) return QUICKJS_HOST;
  mkdirSync(dirname(QUICKJS_HOST), {recursive: true});
  const cc = process.env.CC ?? 'cc';
  const version = readFileSync(resolve(QUICKJS_DIR, 'VERSION'), 'utf8').trim();
  const objectPath = `${QUICKJS_HOST}.${process.pid}.o`;
  const partialPath = `${QUICKJS_HOST}.${process.pid}.partial`;
  const sources = ['quickjs', 'dtoa', 'libregexp', 'libunicode', 'cutils'];
  try {
    run(cc, [
      '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_GNU_SOURCE',
      '-isystem', QUICKJS_DIR, '-c', QUICKJS_HOST_SOURCE, '-o', objectPath,
    ]);
    run(cc, [
      '-std=gnu11', '-O2', '-Werror', '-D_GNU_SOURCE', `-DCONFIG_VERSION="${version}"`,
      '-I', QUICKJS_DIR, objectPath,
      ...sources.map(name => resolve(QUICKJS_DIR, `${name}.c`)),
      '-lm', '-pthread', '-o', partialPath,
    ]);
    renameSync(partialPath, QUICKJS_HOST);
  } finally {
    rmSync(objectPath, {force: true});
    rmSync(partialPath, {force: true});
  }
  return QUICKJS_HOST;
}

const quickjsHost = buildQuickjsHost();
const rows = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))
  .filter(row => row.kind === 'layout');
assert.equal(rows.length, 17, `expected 17 layout vectors, got ${rows.length}`);
const cases = rows.map(row => ({scenarioId: row.scenarioId, input: JSON.parse(row.input)}));

// layout-oracle-runtime.mjs is pure fixture logic; its Node imports/exports are
// stripped above and its public API names are supplied by the bundled Aster object.
const driver = `
const cases = ${JSON.stringify(cases)};
const bitBuffer = new DataView(new ArrayBuffer(8));
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$f64') {
    const marker = value.$f64;
    if (marker === 'NaN') return NaN;
    if (marker === 'Infinity') return Infinity;
    if (marker === '-Infinity') return -Infinity;
    if (marker === '-0') return -0;
    bitBuffer.setBigUint64(0, BigInt('0x' + marker), false);
    return bitBuffer.getFloat64(0, false);
  }
  return Object.fromEntries(keys.map(key => [key, decode(value[key])]));
}
const scenarios = cases.map(({input}) => decode(input));
const rows = runLayoutScenarios(scenarios);
rows.map(row => JSON.stringify({
  scenarioId: row.scenarioId,
  expectedNativeQuickJs: row.expected,
  errorNativeQuickJs: row.error,
})).join('\\n')
`;
const script = [
  BUNDLE,
  'const {BarStore, ChartModel, createLayout, seededColumns} = Aster; const {labelMetrics} = Aster;',
  RUNTIME,
  driver,
].join('\n');

const scriptPath = `${fixturePath}.${process.pid}.native-quickjs.js`;
try {
  writeFileSync(scriptPath, script);
  const result = spawnSync(quickjsHost, [scriptPath], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error(`QuickJS layout oracle failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').trim()}`);
  }
  const output = result.stdout.trimEnd();
  const outputRows = output ? output.split('\n').map(line => JSON.parse(line)) : [];
  assert.equal(outputRows.length, rows.length, `QuickJS returned ${outputRows.length} rows for ${rows.length} layout vectors`);
  const seen = new Set();
  for (const row of outputRows) {
    assert(!seen.has(row.scenarioId), `QuickJS duplicated ${row.scenarioId}`);
    assert.equal(typeof row.scenarioId, 'string', 'QuickJS row missing scenarioId');
    assert(Object.hasOwn(row, 'expectedNativeQuickJs'), `${row.scenarioId}: missing expected output`);
    assert(Object.hasOwn(row, 'errorNativeQuickJs'), `${row.scenarioId}: missing error output`);
    seen.add(row.scenarioId);
  }
  assert.equal(seen.size, rows.length, 'QuickJS layout oracle scenario coverage');
  process.stdout.write(`${output}\n`);
} finally {
  rmSync(scriptPath, {force: true});
}
