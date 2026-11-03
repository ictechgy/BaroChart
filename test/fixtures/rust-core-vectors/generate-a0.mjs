import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createJavaScriptOracle} from '../../../scripts/rust/core-conformance.mjs';
import {parseLossless, stringifyLossless} from '../../../scripts/trace/bcjson.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../../native/Resources/aster-core.js', import.meta.url));
const metadata = {schema: 'aster.rust-core-vectors', version: 1, oracleCommit: manifest.oracleCommit,
  bundleSha256: createHash('sha256').update(source).digest('hex'), seed: 42, dialect: 'Ecma',
  runtime: {node: process.version, v8: process.versions.v8, icu: process.versions.icu, tz: process.versions.tz, platform: process.platform, arch: process.arch},
  scope: 'A0 transport/count-only init and vacant cleanup; no chart-state parity claim'};
const inputs = [
  ['nativeEcho', '[]'], ['nativeEcho', '[undefined]'], ['nativeEcho', '[-0]'],
  ['nativeEcho', '[NaN]'], ['nativeEcho', '[Infinity]'], ['nativeEcho', '[-Infinity]'],
  ['nativeEcho', '[{"2":2,"1":1,"__proto__":{"x":-0},"z":undefined,"a":"\\ud800"}]'],
  ['nativeReleaseDataIngestion', '[]'], ['nativeReleaseFrameCaches', '[]'],
  ['nativeReleaseFrameCache', '[undefined]'], ['nativeAsyncRelease', '[123]'],
  ['nativeWorkspaceSourceAbort', '[1]'], ['nativeWorkspaceSourceAbort', '[0]'],
  ['nativeWorkspaceSourceAbort', '["1"]'], ['nativeParamsSourceAbort', '[1]'],
  ['nativeParamsSourceStatus', '[1]'], ['nativeParamsSourceAbort', '[9007199254740992]'],
  ['nativeParamsSourceStatus', '[]'], ['nativeInit', '[0,null]'], ['nativeInit', '[-0,{}]'],
  ['nativeInit', '[1,{}]'], ['nativeInit', '[NaN,false]'], ['nativeInit', '[NaN,null]'],
  ['nativeInit', '[-1,null]'], ['nativeInit', '[0.5,null]'], ['nativeInit', '[4194305,null]'],
  ['nativeEcho', '[{"afterFailure":true,"n":-0}]'], ['nativeReleaseDataIngestion', '[]'],
];
const oracle = await createJavaScriptOracle();
const calls = inputs.map(([name, argumentsText]) => {
  const outcome = oracle.call(name, parseLossless(argumentsText));
  return {name, arguments: argumentsText, expected: stringifyLossless(outcome)};
});
const rejections = manifest.functions.filter(entry => entry.status === 'reject').map(({name}) => ({
  name, arguments: '[]', comparison: 'rust-policy', expected: stringifyLossless({status: 2, error: {
    name: 'UnavailableError', message: name === 'nativeRegisterIndicatorSource'
      ? 'Indicator source registration requires the javaScript backend' : `${name} is not available in the Rust backend`,
    code: name === 'nativeRegisterIndicatorSource' ? 'JAVASCRIPT_BACKEND_REQUIRED' : null,
  }}),
}));
const text = [
  {metadata, suite: 'a0', name: 'ordered-values-init-errors-vacant-cleanup', calls},
  {metadata, suite: 'a0', name: 'explicit-unavailable-policy', calls: rejections},
].map(value => JSON.stringify(value)).join('\n') + '\n';
const path = directory + 'a0.jsonl';
if (process.argv.includes('--check')) {
  // Runtime metadata is part of the recorded oracle; another supported Node version may verify values.
  const stored = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const current = text.trim().split('\n').map(line => JSON.parse(line));
  for (let i = 0; i < stored.length; i++) current[i].metadata.runtime = stored[i].metadata.runtime;
  if (JSON.stringify(current) !== JSON.stringify(stored)) throw new Error('A0 vectors are stale');
} else await writeFile(path, text);
process.stdout.write(`A0 oracle: ${calls.length} parity calls and ${rejections.length} explicit policy calls\n`);
