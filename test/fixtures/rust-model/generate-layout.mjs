#!/usr/bin/env node
// Generate exact public ChartModel/createLayout vectors under pinned Node/V8 and local JSC.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {layoutScenarios, runLayoutScenarios} from './layout-oracle-runtime.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ORACLE_COMMIT = 'cbc4b296cfdba25f597f04d1aea238f221019bce';
const BUNDLE_SHA256 = '007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512';
const SOURCES = {
  'src/core/model.mjs': '64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad',
  'src/core/data.mjs': '4abba0d1ea3fd2e73d3cca968ba09b17a40f14f4a479bc260a55a230b9134d0b',
  'src/core/block-index.mjs': 'c0524cb1d7d82ebaacbb39a505147fd2033a05428de055db9ee3221f2421f57a',
  'src/core/scene-parts.mjs': 'ce945b315c563e6f7cdce960f198159d7cf82253dbd0333953d8d7d685ff929d',
  'src/core/labels.mjs': 'a5f47cd2a29aead2ee553a2acf2f6c3125205b353c29ad956f304391bad93ffa',
  'src/core/contracts.mjs': '832a919e16aa29f5c5655210308256e6195c032fc9e4831176e4adf53e4b78e2',
  'test/fixtures/rust-model/layout-oracle-runtime.mjs': '5f19fe81c8a4cdc2b8b3f01751f1914437f86b8c8178f2c9c28349e58df94980',
};
const SCHEMA = 'aster.rust-model-layout';
const SCHEMA_VERSION = 1;
const PINNED_NODE = 'v22.20.0';
const PINNED_V8 = '12.4.254.21-node.33';
const DIALECT = 'Ecma';
const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, expected] of Object.entries(SOURCES)) {
  assert.equal(sha256(await readFile(resolve(ROOT, path))), expected, `${path} changed from the reviewed layout oracle`);
}
assert.equal(
  sha256(await readFile(resolve(ROOT, 'native/Resources/aster-core.js'))),
  BUNDLE_SHA256,
  'native bundle changed from the recorded JS source snapshot',
);

const writeFixture = process.argv.includes('--write');
const checkFixture = process.argv.includes('--check');
assert(!(writeFixture && checkFixture), 'Choose either --write or --check');
if (writeFixture || checkFixture) {
  assert.equal(process.version, PINNED_NODE, `Fixture oracle requires Node ${PINNED_NODE}`);
  assert.equal(process.versions.v8, PINNED_V8, `Fixture oracle requires V8 ${PINNED_V8}`);
}

const metadata = {
  schema: SCHEMA,
  schemaVersion: SCHEMA_VERSION,
  oracleCommit: ORACLE_COMMIT,
  bundleSha256: BUNDLE_SHA256,
  sourceSha256: SOURCES,
  numberDialect: DIALECT,
  runtime: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  tz: process.versions.tz,
  seed: 0x5eed,
  jscOracle: 'system JavaScriptCore CLI',
};

const v8Rows = runLayoutScenarios(layoutScenarios);
if (!writeFixture && !checkFixture) {
  process.stdout.write(`${JSON.stringify({scenarios: v8Rows.length, ...metadata})}\n`);
} else {
  const jscOutput = execFileSync(
    JSC,
    ['-m', resolve(ROOT, 'test/fixtures/rust-model/generate-layout-jsc.mjs'), '--', JSON.stringify(layoutScenarios)],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024},
  );
  const jscRows = jscOutput.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(jscRows.length, v8Rows.length, 'JavaScriptCore oracle missed a layout scenario');
  const jscById = new Map(jscRows.map(row => [row.scenarioId, row]));
  const rows = v8Rows.map(row => {
    const jsc = jscById.get(row.scenarioId);
    assert.ok(jsc, `JavaScriptCore oracle missed ${row.scenarioId}`);
    const result = {...metadata, kind: 'layout', ...row};
    if (row.expected !== jsc.expected || JSON.stringify(row.error) !== JSON.stringify(jsc.error)) {
      result.expectedJsc = jsc.expected;
      result.errorJsc = jsc.error;
    }
    return result;
  });
  const fixture = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const destination = resolve(ROOT, 'test/fixtures/rust-model');
  const fixturePath = resolve(destination, 'layout-oracle.jsonl');
  if (writeFixture) {
    await mkdir(destination, {recursive: true});
    await writeFile(fixturePath, fixture);
  } else {
    assert.equal(
      await readFile(fixturePath, 'utf8'),
      fixture,
      'Fixture is stale; regenerate it with the pinned Node 22 oracle using --write',
    );
  }
  process.stdout.write(`${rows.length} layout vectors; ${rows.filter(row => row.expectedJsc !== undefined).length} dual-runtime goldens\n`);
}
