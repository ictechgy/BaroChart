#!/usr/bin/env node
// Reproduce both momentum fixtures from the real JS factories, including signed-zero params.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {builtinIndicators} from '../../../src/core/indicators.mjs';
import {validateIndicatorParams} from '../../../src/core/indicator-params.mjs';
import {stringifyLossless} from '../../../scripts/trace/bcjson.mjs';

const oracleCommit = 'bf851d9fda8547180207de165c46ff8dc7c09b1b';
const bundleSha256 = '007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512';
const sourceSha256 = '31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790';
for (const [path, expected] of [['../../../native/Resources/aster-core.js', bundleSha256], ['../../../src/core/indicators.mjs', sourceSha256]]) {
  assert.equal(createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex'), expected);
}
const runtime = {node: process.version, v8: process.versions.v8, unicode: process.versions.unicode};
const metadata = {version: 1, oracleCommit, bundleSha256, sourceSha256, seed: 'cold-bars-v1', numberDialect: 'Ecma', platform: `${process.platform}-${process.arch}`, runtime, icu: process.versions.icu, tzdata: process.versions.tz};
const cases = [
  ['rsi', {period: 3}], ['atr', {period: 3}], ['donchian', {period: 3}], ['aroon', {period: 3}],
  ['stochastic', {period: 3, smoothK: 2, smoothD: 2}], ['roc', {period: 3}], ['williamsR', {period: 3}], ['cci', {period: 3}], ['adx', {period: 3}],
  ['keltner', {period: 3, atrPeriod: 2, multiplier: 2}], ['supertrend', {period: 3, multiplier: 2}],
  ['ichimoku', {conversion: 2, base: 3, span: 4, displacement: -0}],
  ['stochRSI', {period: 3, stochPeriod: 3, smoothK: 2, smoothD: 2}], ['parabolicSAR', {step: 0.02, max: 0.2}],
];
const closes = [10, 11, 9, 12, 8, 13, 7, 14];
const bars = closes.map((close, index) => ({time: index, open: close - 0.25, high: close + 1 + index % 2 * 0.5, low: close - 1 - index % 3 * 0.25, close, volume: index === 4 ? 0 : index + 1}));
const bits = value => {if (Number.isNaN(value)) return 'NaN';const buffer = Buffer.alloc(8);buffer.writeDoubleBE(value);return buffer.toString('hex')};
const cold = [{schema: 'barochart.rust-indicator-oracle', ...metadata, group: 'momentum-range', rustBaseCommit: 'f6831d5c56c2b0b1427d46c27227099ed0b09248', bars: {close: closes, open: 'close-0.25', high: 'close+1+(index%2)*0.5', low: 'close-1-(index%3)*0.25', volume: 'index===4?0:index+1'}}];
const rows = [{schema: 'barochart.rust-indicator-output-bits', ...metadata}];
for (const [program, params] of cases) {
  validateIndicatorParams(params);
  const definition = builtinIndicators.get(program)(params), state = definition.create();
  const outputs = bars.map((bar, index) => state.step(bar, index));
  cold.push({program, ...(program === 'ichimoku' ? {paramsLossless: stringifyLossless(params)} : {params}), lastBits: outputs.at(-1).map(bits), snapshotLossless: stringifyLossless(state.snapshot()), outputs: definition.outputs, offsetsLossless: stringifyLossless(definition.plotOffsets ?? {})});
  rows.push({program, rowsBits: outputs.map(row => row.map(value => Number.isNaN(value) ? null : bits(value)))});
}
for (const [name, generated] of [['momentum-cold', cold], ['momentum-rows', rows]]) {
  const url = new URL(`${name}.jsonl`, import.meta.url);
  if (process.argv.includes('--check')) {
    const stored = (await readFile(url, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(generated.slice(1), stored.slice(1), `${name} values/order changed`);
    assert.equal(stored[0].icu, '77.1');
    assert.equal(stored[0].tzdata, '2025b');
  } else {
    // Refuse to replace an existing expectation with a changed numeric result.
    const stored = (await readFile(url, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(generated.slice(1), stored.slice(1), `${name}: adjudicate changed values before recording`);
    await writeFile(url, generated.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
}
process.stdout.write(`Momentum oracle reproduced 14 programs / 112 steps; Node ${process.version}, ICU ${process.versions.icu}, tz ${process.versions.tz}\n`);
