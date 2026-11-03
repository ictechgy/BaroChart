#!/usr/bin/env node
// 정적 pressure factory의 cold-fold / restore 오라클 벡터를 생성한다.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORACLE_COMMIT = 'bf851d9';
const BUNDLE_SHA256 = '007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512';
const SOURCES = {
  'src/core/indicators.mjs': '31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790',
  'src/core/trusted-studies.mjs': '6b312890a68984a26e2a73b82ada5d2e57123345b6949af5c1f700a010b325bf',
  'src/core/indicator-modules.mjs': '8bb53b156bae724b67d1f6fe66498e9394c804dbee0ef76b3eb2a30076e5a3e7',
  'src/core/checkpoint-validation.mjs': '6607c2b3adb1c24ad3133711b72b8e7f63bad1b195be19f3bc944ce66000b463',
  'src/core/indicator-params.mjs': 'fb323f348b5204e39c85e31f5a88fd1b0ab08af71d2ae81fa04f820a0bd96519',
  'src/core/data.mjs': '4abba0d1ea3fd2e73d3cca968ba09b17a40f14f4a479bc260a55a230b9134d0b',
};
const SCHEMA = 'aster.rust-indicator-linked';
const SCHEMA_VERSION = 1;
const SEED = 41;
const NAME = 'aster.volume-direction@1/pressure';
const [
  {resolveIndicatorFactory},
  {indicatorModule},
  {validateIndicatorParams},
  {safeCheckpointStringify},
  {seededColumns},
] = await Promise.all([
  import(pathToFileURL(resolve(ROOT, 'src/core/indicators.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/indicator-modules.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/indicator-params.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/checkpoint-validation.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/data.mjs'))),
]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, expected] of Object.entries(SOURCES)) {
  assert.equal(sha256(await readFile(resolve(ROOT, path))), expected, `${path} changed from the reviewed oracle`);
}
assert.equal(
  sha256(await readFile(resolve(ROOT, 'native/Resources/aster-core.js'))),
  BUNDLE_SHA256,
  'bundled oracle changed from the reviewed JS commit',
);

const metadata = {
  schema: SCHEMA,
  schemaVersion: SCHEMA_VERSION,
  oracleCommit: ORACLE_COMMIT,
  bundleSha256: BUNDLE_SHA256,
  sourceSha256: SOURCES,
  seed: SEED,
  numberDialect: 'Ecma',
  runtime: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  tz: process.versions.tz,
};

const descriptor = indicatorModule(NAME);
assert.deepEqual(descriptor, {
  id: 'aster.volume-direction',
  version: 1,
  stateVersion: 1,
  exportName: 'pressure',
  causal: true,
});

function barsFromSeed(length, seed) {
  const columns = seededColumns(length, seed);
  return Array.from({length}, (_, index) => Object.fromEntries(
    ['time', 'open', 'high', 'low', 'close', 'volume']
      .map(field => [field, columns[field][index]])
  ));
}

function bar(time, open, high, low, close, volume) {
  return {time, open, high, low, close, volume};
}

function vector(scenarioId, params, bars) {
  validateIndicatorParams(params);
  const factory = resolveIndicatorFactory(NAME);
  assert.equal(typeof factory, 'function', 'pressure must be a static linked factory');
  const definition = factory(params);
  const state = definition.create();
  const outputs = [];
  const snapshots = [safeCheckpointStringify(state.snapshot())];
  bars.forEach((current, index) => {
    outputs.push(safeCheckpointStringify(state.step(current, index)));
    snapshots.push(safeCheckpointStringify(state.snapshot()));
  });
  return {
    ...metadata,
    scenarioId,
    name: NAME,
    params: safeCheckpointStringify(params),
    descriptor: safeCheckpointStringify(descriptor),
    outputNames: [...definition.outputs],
    plotOffsets: safeCheckpointStringify(definition.plotOffsets),
    bars: bars.map(safeCheckpointStringify),
    outputs,
    snapshots,
  };
}

const ordinary = [
  bar(0, 10, 11, 9, 10, 5),
  bar(1, 10, 12, 9, 11, 7),
  bar(2, 11, 12, 10, 11, 8),
  bar(3, 11, 12, 8, 9, 9),
];
const signedZero = [
  bar(0, 10, 11, 9, 10, 5),
  bar(1, 10, 12, 9, 11, 7),
  bar(2, 11, 13, 10, 12, 8),
  bar(3, 12, 14, 11, 13, 9),
];
const overflow = [
  bar(0, 0, 0, 0, 0, Number.MAX_VALUE),
  bar(1, 1, 1, 0, 1, Number.MAX_VALUE),
  bar(2, 2, 2, 1, 2, Number.MAX_VALUE),
];

const vectors = [
  vector('pressure.factor1.shift2.measured', {factor: 1, shift: 2}, ordinary),
  vector('pressure.factor-negative-zero.shift-negative-zero', {factor: -0, shift: -0}, signedZero),
  vector('pressure.factor-half.seed41.checkpoints0-256-512', {factor: 0.5, shift: -0}, barsFromSeed(513, SEED)),
  vector('pressure.cumulative-output-infinity-left-for-engine', {factor: 1, shift: 0}, overflow),
];

if (process.argv.includes('--check')) {
  const path = resolve(ROOT, 'test/fixtures/rust-indicators/linked-oracle.jsonl');
  assert.equal(await readFile(path, 'utf8'), vectors.map(vector => JSON.stringify(vector)).join('\n') + '\n');
  process.stdout.write(`linked oracle fresh: ${vectors.length} vectors\n`);
} else if (process.argv.includes('--write')) {
  const destination = resolve(ROOT, 'test/fixtures/rust-indicators');
  await mkdir(destination, {recursive: true});
  await writeFile(
    resolve(destination, 'linked-oracle.jsonl'),
    vectors.map(vector => JSON.stringify(vector)).join('\n') + '\n',
  );
  process.stdout.write(`${vectors.length} linked pressure vectors\n`);
} else {
  process.stdout.write(`${JSON.stringify({vectors: vectors.length, ...metadata})}\n`);
}
