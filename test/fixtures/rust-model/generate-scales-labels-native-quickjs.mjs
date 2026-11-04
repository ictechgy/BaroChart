#!/usr/bin/env node
// Linux GNU Rust 시험이 checked-in V8/JSC 문자열을 빌려 쓰지 않도록, 같은 공개
// ChartModel/createLayout 입력을 vendored QuickJS에서 다시 계산하는 작은 실행기다.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [fixturePath] = process.argv.slice(2);
assert(fixturePath, 'usage: generate-scales-labels-native-quickjs.mjs FIXTURE');
// Node only prepares the input; vendored QuickJS computes every oracle value.
assert.equal(process.versions.node.split('.')[0], '22', `native axis oracle requires Node 22 (got ${process.version})`);

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const QUICKJS_DIR = resolve(ROOT, 'native/android/quickjs');
const QUICKJS_HOST_SOURCE = resolve(ROOT, 'rust/tools/conformance/quickjs-host.c');
const QUICKJS_HOST = resolve(ROOT, 'artifacts/native-axis-oracle/quickjs-host');
const BUNDLE = readFileSync(resolve(ROOT, 'native/Resources/aster-core.js'), 'utf8');

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
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
  .filter(row => row.kind === 'axis' && row.expected !== null);

const cases = rows
  .map(row => ({
    scenarioId: row.scenarioId,
    input: JSON.parse(row.input),
    oracleModel: row.oracleModel,
  }));
assert(cases.length > 0, 'fixture contains no successful axis vectors');
for (const row of cases) {
  assert(row.oracleModel, `${row.scenarioId}: missing independent model input`);
}

// quickjs-host.c는 완성 값을 문자열 하나로 받으므로 JSONL을 마지막 표현식으로 돌린다.
const script = `${BUNDLE}
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
function encodeNumber(value) {
  if (Number.isNaN(value)) return {$f64: 'NaN'};
  if (value === Infinity) return {$f64: 'Infinity'};
  if (value === -Infinity) return {$f64: '-Infinity'};
  if (Object.is(value, -0)) return {$f64: '-0'};
  bitBuffer.setFloat64(0, value, false);
  return {$f64: bitBuffer.getBigUint64(0, false).toString(16).padStart(16, '0')};
}
function wire(value) {
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) return value.map(wire);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).map(key => [key, wire(value[key])]));
}
const rowText = row => JSON.stringify(wire(row));
cases.map(({scenarioId, input: rawInput, oracleModel: rawOracleModel}) => {
  const input = decode(rawInput);
  const oracleModel = decode(rawOracleModel);
  const bars = oracleModel.barValues
    ? oracleModel.barValues.map((value, index) => ({
      time: 1_700_000_000_000 + index * 60_000,
      open: value, high: value, low: value, close: value, volume: 1,
    }))
    : (() => {
      const close = oracleModel.storeFirstClose ?? oracleModel.values.find(Number.isFinite) ?? 1;
      return oracleModel.values.map((_, index) => ({
        time: 1_700_000_000_000 + index * 60_000,
        open: close, high: close, low: close, close, volume: 1,
      }));
    })();
  const panel = {
    id: 'price', scale: input.scale, padding: input.padding, inverted: input.inverted,
  };
  if (input.range !== null) panel.range = input.range;
  if (input.base !== null) panel.base = input.base;
  const model = new Aster.ChartModel({store: new Aster.BarStore(bars), panels: [panel]});
  try {
    model.addSeries({
      id: 'axis-source', type: oracleModel.seriesType, panel: 'price',
      ...(oracleModel.baseline === null ? {} : {baseline: oracleModel.baseline}),
      ...(oracleModel.values === null ? {} : {values: Float64Array.from(oracleModel.values)}),
    });
    model.setVisibleRange(0, bars.length - 1);
    const axis = Aster.createLayout(model, 800, 500).axis('price');
    const result = {
      min: axis.min, max: axis.max, base: axis.base, top: axis.top, bottom: axis.bottom,
      lo: axis.lo, hi: axis.hi,
      y: input.samples.map(value => axis.y(value)),
      price: input.screen_samples.map(value => axis.price(value)),
      transform: input.samples.map(value => axis.transform(value)),
      inverse: input.samples.map(value => axis.inverse(axis.transform(value))),
    };
    return JSON.stringify({scenarioId, expectedNativeQuickJs: rowText(result)});
  } finally {
    model.dispose();
  }
}).join('\\n')
`;

const scriptPath = `${fixturePath}.${process.pid}.native-quickjs.js`;
try {
  writeFileSync(scriptPath, script);
  const result = spawnSync(quickjsHost, [scriptPath], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error(`QuickJS oracle failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').trim()}`);
  }
  const output = result.stdout.trimEnd();
  const outputRows = output ? output.split('\n') : [];
  assert.equal(outputRows.length, cases.length, `QuickJS returned ${outputRows.length} rows for ${cases.length} axis vectors`);
  const seen = new Set();
  for (const line of outputRows) {
    const row = JSON.parse(line);
    assert(!seen.has(row.scenarioId), `QuickJS duplicated ${row.scenarioId}`);
    assert.equal(typeof row.expectedNativeQuickJs, 'string', `${row.scenarioId}: missing wire output`);
    seen.add(row.scenarioId);
  }
  process.stdout.write(`${output}\n`);
} finally {
  rmSync(scriptPath, {force: true});
}
