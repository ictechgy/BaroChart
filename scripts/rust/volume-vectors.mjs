#!/usr/bin/env node
// M3 거래량 리프 오라클 벡터를 만든다. `node scripts/rust/volume-vectors.mjs --write`로 생성한다.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORACLE_COMMIT = 'bf851d9';
const SOURCE_SHA256 = '31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790';
const BUNDLE_SHA256 = '007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512';
const SCHEMA = 'aster.rust-indicator-volume';
const SCHEMA_VERSION = 1;
const SEED = 41;
const [
  {builtinIndicators},
  {validateIndicatorParams},
  {safeCheckpointStringify},
  {seededColumns},
] = await Promise.all([
  import(pathToFileURL(resolve(ROOT, 'src/core/indicators.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/indicator-params.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/checkpoint-validation.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/data.mjs'))),
]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(resolve(ROOT, 'src/core/indicators.mjs'));
const bundle = await readFile(resolve(ROOT, 'native/Resources/aster-core.js'));
assert.equal(sha256(source), SOURCE_SHA256, 'JS indicator source changed from the reviewed oracle');
assert.equal(sha256(bundle), BUNDLE_SHA256, 'bundled oracle changed from the reviewed source commit');

const metadata = {
  schema: SCHEMA,
  schemaVersion: SCHEMA_VERSION,
  oracleCommit: ORACLE_COMMIT,
  sourceSha256: SOURCE_SHA256,
  bundleSha256: BUNDLE_SHA256,
  seed: SEED,
  numberDialect: 'Ecma',
  runtime: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  tz: process.versions.tz,
};

const baseParams = {
  obv: {},
  mfi: {},
  cmf: {},
  adl: {},
  chaikin: {},
  forceIndex: {},
  volumeOscillator: {},
  vortex: {},
};
const compactParams = {
  obv: {zeta: 2, alpha: -0},
  mfi: {period: 1, zeta: 2},
  cmf: {period: 1, zeta: 2},
  adl: {zeta: 2, alpha: -0},
  chaikin: {fast: 1, slow: 2, zeta: 2},
  forceIndex: {period: 1, zeta: 2},
  volumeOscillator: {fast: 1, slow: 2, zeta: 2},
  vortex: {period: 1, zeta: 2},
};

function barsFromSeed(length, seed) {
  const columns = seededColumns(length, seed);
  return Array.from({length}, (_, index) => Object.fromEntries(
    ['time', 'open', 'high', 'low', 'close', 'volume']
      .map(field => [field, columns[field][index]])
  ));
}

function makeBar(index, open, high, low, close, volume) {
  return {time: index, open, high, low, close, volume};
}

function edgeBars() {
  const min = Number.MIN_VALUE, max = Number.MAX_VALUE;
  return [
    makeBar(0, 0, 0, 0, 0, 0),
    makeBar(1, -0, 0, -0, -0, -0),
    makeBar(2, min, min, 0, min, min),
    makeBar(3, 1, 2, 0, 2, 1),
    makeBar(4, 2, 3, 1, 1, -1),
    makeBar(5, -1, 0, -2, -1, 0),
    makeBar(6, max / 4, max / 2, 0, max / 2, max / 4),
    makeBar(7, max / 2, max, 0, max, max),
    makeBar(8, max, max, max / 2, max / 2, max),
    makeBar(9, -max, 0, -max, -max, -max),
    makeBar(10, 0, min, -min, -0, min),
    makeBar(11, 1, 1, 1, 1, 0),
    makeBar(12, 4, 5, 2, 3, 2),
    makeBar(13, 3, 4, 1, 4, 3),
    makeBar(14, 4, 5, 0, 1, 4),
    makeBar(15, 1, 2, 0, 0, 5),
  ];
}

function reverseObjectOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, reverseObjectOrder(child)])
      .reverse(),
  );
}

function vector(kind, params, bars, scenarioId, suite, {prefixBars = [], reorderRestore = false} = {}) {
  const factory = builtinIndicators.get(kind);
  assert.equal(typeof factory, 'function', `missing actual JS factory for ${kind}`);
  validateIndicatorParams(params);
  const definition = factory(params);
  const indicator = definition.create();
  prefixBars.forEach((bar, index) => indicator.step(bar, index));
  if (reorderRestore) indicator.restore(reverseObjectOrder(indicator.snapshot()));
  const output = [];
  const snapshots = [safeCheckpointStringify(indicator.snapshot())];
  bars.forEach((bar, index) => {
    output.push(safeCheckpointStringify(indicator.step(bar, prefixBars.length + index)));
    snapshots.push(safeCheckpointStringify(indicator.snapshot()));
  });
  return {
    ...metadata,
    suite,
    scenarioId,
    kind,
    params: safeCheckpointStringify(params),
    prefixBars: prefixBars.map(safeCheckpointStringify),
    startIndex: prefixBars.length,
    bars: bars.map(safeCheckpointStringify),
    outputs: output,
    snapshots,
    outputNames: [...definition.outputs],
  };
}

const cold = [];
for (const [kind, params] of Object.entries(baseParams)) {
  cold.push(vector(kind, params, barsFromSeed(320, SEED), `${kind}.default.seed${SEED}`, 'cold'));
}
for (const [kind, params] of Object.entries(compactParams)) {
  cold.push(vector(kind, params, barsFromSeed(40, SEED), `${kind}.period-edge.seed${SEED}`, 'cold'));
}
const edges = Object.keys(baseParams).map(kind => vector(
  kind,
  compactParams[kind],
  edgeBars(),
  `${kind}.signedzero-subnormal-negative-huge-max`,
  'edge',
));
edges.push(vector(
  'chaikin',
  {fast: 2, slow: 3},
  [makeBar(1, 1e308, 1e308, 0, 1e308, 1e308)],
  'chaikin.imported-reordered-smoother-nonfinite-reset',
  'edge',
  {
    prefixBars: [makeBar(0, 1, 2, 0, 1, 1)],
    reorderRestore: true,
  },
));

function jsonLines(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

if (process.argv.includes('--check')) {
  const destination = resolve(ROOT, 'test/fixtures/rust-indicators');
  assert.equal(await readFile(resolve(destination, 'volume-cold.jsonl'), 'utf8'), jsonLines(cold));
  assert.equal(await readFile(resolve(destination, 'volume-edge.jsonl'), 'utf8'), jsonLines(edges));
  process.stdout.write(`volume oracle fresh: ${cold.length} cold / ${edges.length} edge vectors\n`);
} else if (process.argv.includes('--write')) {
  const destination = resolve(ROOT, 'test/fixtures/rust-indicators');
  await mkdir(destination, {recursive: true});
  await writeFile(resolve(destination, 'volume-cold.jsonl'), jsonLines(cold));
  await writeFile(resolve(destination, 'volume-edge.jsonl'), jsonLines(edges));
  process.stdout.write(`${cold.length} cold vectors; ${edges.length} edge vectors\n`);
} else {
  process.stdout.write(`${JSON.stringify({cold: cold.length, edge: edges.length, ...metadata})}\n`);
}
