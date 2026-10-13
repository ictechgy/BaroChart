import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartAPI, ChartModel, FIELDS, builtinIndicators, seededColumns} from '../src/core/index.mjs';

const T = Date.UTC(2026, 2, 9, 9, 30);
// Small-period parameters and deterministic input are the established mixed,
// tiny-price and flat-volume fixtures from the independent indicator tests.
const params = {period:5, atrPeriod:4, fast:3, slow:7, signal:3, conversion:3,
 base:5, span:7, displacement:4, stochPeriod:4, smoothK:2, smoothD:2, sessionMs:1800000};
const channels = {
 sma:['value'], ema:['value'], wma:['value'], rsi:['value'], atr:['value'],
 macd:['macd','signal','histogram'], bollinger:['middle','upper','lower'],
 donchian:['middle','upper','lower'], stochastic:['k','d'], roc:['value'],
 williamsR:['value'], cci:['value'], obv:['value'], vwap:['value'], mfi:['value'],
 cmf:['value'], adx:['adx','plusDI','minusDI'], dema:['value'], tema:['value'],
 hma:['value'], keltner:['middle','upper','lower'], supertrend:['value','direction'],
 ichimoku:['tenkan','kijun','spanA','spanB','chikou'], trix:['value'],
 ppo:['ppo','signal','histogram'], stochRSI:['k','d'], adl:['value'],
 chaikin:['value'], forceIndex:['value'], volumeOscillator:['value'],
 vortex:['plus','minus'], pivots:['pivot','r1','s1','r2','s2'],
 parabolicSAR:['value','direction'],
};
const studies = Object.entries(channels).map(([name, outputs]) => ({id:name, name, params, outputs}));

function fixture(rows, specifications = studies, bindSeries = false) {
 const model = new ChartModel({store:new BarStore(rows.map(row => ({...row})))});
 // Exercise multiple checkpoint boundaries without requiring a large corpus.
 model.indicators.checkpointSize = 8;
 const api = new ChartAPI(model);
 try {
  for (const [i, study] of specifications.entries()) {
   api.addIndicator(study.id, study.name, study.params);
   if (bindSeries && i % 3 !== 2) api.addSeries({id:study.id+'-line', type:'line',
    panel:'price', indicator:study.id, output:study.outputs[0], visible:i % 3 === 0});
  }
 } catch (error) {model.dispose(); throw error;}
 return {model, api};
}

function exactVector(actual, expected, label) {
 assert.equal(actual.length, expected.length, label+' length');
 for (let i = 0; i < expected.length; i++) {
  // Object.is deliberately distinguishes -0 and preserves NaN warm-up gaps.
  assert.ok(Object.is(actual[i], expected[i]), `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
 }
}

function exactSource(store, rows, label) {
 assert.equal(store.length, rows.length, label+' source length');
 for (const key of FIELDS) exactVector(store.columns[key].subarray(0, store.length), rows.map(row => row[key]), label+'/'+key);
}

function snapshots(model, specifications = studies) {
 return Object.fromEntries(specifications.map(study => {
  const result = model.indicators.get(study.id);
  assert.deepEqual(Object.keys(result.outputs).sort(), [...study.outputs].sort(), study.id+' output names');
  return [study.id, {outputs:Object.fromEntries(study.outputs.map(output =>
   [output, Float64Array.from(result.outputs[output])])), plotOffsets:{...result.plotOffsets}}];
 }));
}

function matchesFresh(compacted, rows, label, specifications = studies) {
 // The oracle never compacts, consumes a compacted output, or restores a saved
 // checkpoint. Every comparison starts from a separate suffix-only store and
 // newly constructed studies, including after each subsequent data mutation.
 const fresh = fixture(rows, specifications);
 try {
  exactSource(compacted.model.store, rows, label);
  const expected = snapshots(fresh.model, specifications), actual = snapshots(compacted.model, specifications);
  for (const study of specifications) {
   assert.deepEqual(actual[study.id].plotOffsets, expected[study.id].plotOffsets, label+'/'+study.id+' offsets');
   for (const output of study.outputs) {
    const vector = expected[study.id].outputs[output];
    exactVector(actual[study.id].outputs[output], vector, label+'/'+study.id+'/'+output+' raw');
    exactVector(compacted.api.indicatorValues(study.id, output),
     Array.from(vector, value => Number.isNaN(value) ? null : value), label+'/'+study.id+'/'+output+' public');
   }
  }
 } finally {fresh.model.dispose();}
}

function corpus(factor) {
 const columns = seededColumns(113, 7931);
 return Array.from({length:113}, (_, i) => Object.fromEntries(FIELDS.map(key => [key,
  key === 'time' ? T+i*60000 : factor === 0 ? (i % 2 ? -0 : 0)
   : key === 'volume' ? columns[key][i] : columns[key][i]*factor])));
}

for (const [label, factor] of [['mixed',1], ['tiny-price',1e-12], ['flat-zero-volume',0]]) {
 test(`compaction restarts all 33 visible, hidden and unbound builtins against a fresh ${label} suffix`, t => {
  assert.equal(studies.length, 33);
  assert.deepEqual([...builtinIndicators.keys()].sort(), Object.keys(channels).sort(), 'every current builtin is covered');
  const input = corpus(factor), rows = input.slice(-45).map(row => ({...row}));
  const f = fixture(input, studies, true); t.after(() => f.model.dispose());
  const store = f.model.store, entries = new Map(f.model.indicators.entries);
  const priorOutputs = new Map([...entries].map(([id, entry]) => [id, entry.arrays]));
  assert.ok(f.model.series.some(series => series.visible === false), 'hidden study series fixture');
  assert.ok(studies.some(study => !f.model.series.some(series => series.indicator === study.id)), 'unbound study fixture');
  for (const entry of entries.values()) assert.ok(entry.checkpoints.size > 1, 'full history populated checkpoints');

  const receipt = f.api.compactData({keepLastBars:rows.length, studyHistory:'restart'});
  assert.equal(f.model.store, store, 'source owner identity survives');
  assert.equal(store.capacity, 64, 'retained capacity is next power of two');
  assert.equal(receipt.removed, 68);
  assert.equal(receipt.length, 45);
  exactSource(store, rows, 'immediate suffix');
  // Assert lazy reset before any read can hide an uncleared cache by recomputing.
  for (const [id, entry] of entries) {
   assert.equal(f.model.indicators.entries.get(id), entry, id+' entry retained');
   assert.equal(entry.checkpoints.size, 0, id+' checkpoints released');
   assert.notEqual(entry.arrays, priorOutputs.get(id), id+' old output owner released');
   assert.deepEqual(entry.arrays, [], id+' output capacity released');
   assert.equal(entry.length, 0, id+' calculated length reset');
   assert.equal(entry.dirty, 0, id+' recomputation starts at suffix origin');
   assert.equal(entry.invalidated, true, id+' old convergence cannot be reused');
  }
  matchesFresh(f, rows, label+' restart');
  assert.ok(Number.isNaN(f.model.indicators.get('ema').outputs.value[0]), 'EMA warm-up restarts');
  for (const entry of entries.values()) {
   assert.equal(entry.arrays[0].length, 64, 'recomputed outputs have retained capacity');
   assert.deepEqual([...entry.checkpoints.keys()], [0,8,16,24,32,40], 'checkpoint indexes restart at zero');
  }

  const appended = {...rows.at(-1), time:rows.at(-1).time+60000};
  if (factor) Object.assign(appended, {open:102*factor, high:108*factor, low:99*factor, close:106*factor, volume:29});
  rows.push(appended); f.api.applyDataEvent({kind:'append', bar:appended});
  matchesFresh(f, rows, label+' append');
  const updated = {...rows.at(-1)};
  if (factor) Object.assign(updated, {low:97*factor, close:98*factor, volume:31});
  else Object.assign(updated, {open:0, high:0, low:-0, close:-0, volume:-0});
  rows[rows.length-1] = updated; f.api.applyDataEvent({kind:'update', bar:updated});
  matchesFresh(f, rows, label+' current replacement');
  // Correct inside a nonzero checkpoint block, then the new history origin.
  for (const index of [10,0]) {
   const corrected = {...rows[index]};
   if (factor) Object.assign(corrected, {open:93*factor, high:119*factor, low:87*factor, close:115*factor, volume:47+index});
   else Object.assign(corrected, {open:-0, high:0, low:-0, close:0, volume:0});
   rows[index] = corrected; f.api.applyDataEvent({kind:'correction', bar:corrected});
   matchesFresh(f, rows, label+' historical correction '+index);
  }
 });
}

test('raw retained OHLCV preserves signed zero, including UTC time, through repeated compaction', t => {
 const input = Array.from({length:20}, (_, i) => ({time:i === 2 ? -0 : i-2,
  open:-0, high:0, low:-0, close:i % 2 ? 0 : -0, volume:i % 2 ? -0 : 0}));
 const specs = studies.filter(study => ['sma','ichimoku'].includes(study.name));
 const f = fixture(input, specs); t.after(() => f.model.dispose());
 let rows = input.slice(2);
 f.api.compactData({keepLastBars:18, studyHistory:'restart'});
 exactSource(f.model.store, rows, 'signed-zero suffix');
 assert.ok(Object.is(f.model.store.columns.time[0], -0), 'retained time is negative zero');
 matchesFresh(f, rows, 'signed-zero studies', specs);
 assert.ok(Object.is(f.model.indicators.get('ichimoku').outputs.chikou[0], -0), 'raw study output is negative zero');
 assert.ok(Number.isNaN(f.model.indicators.get('sma').outputs.value[0]), 'raw warm-up remains NaN');
 for (const keep of [16,1]) {
  rows = rows.slice(-keep); f.api.compactData({keepLastBars:keep, studyHistory:'restart'});
  assert.equal(f.model.store.capacity, 16, 'minimum capacity is sixteen');
  matchesFresh(f, rows, 'repeated suffix '+keep, specs);
 }
});

test('history and session-sensitive restarts intentionally differ from sliced full-history values', t => {
 const close = [50,10,40,20,30,12,18,24,36];
 const input = close.map((value, i) => ({time:T+Math.floor(i/3)*86400000+(i%3)*60000,
  open:value-1, high:value+4, low:value-2, close:value, volume:i+1}));
 const calendar = JSON.stringify({timezone:'UTC', weekdays:[0,1,2,3,4,5,6], windows:[{open:'09:00',close:'16:00'}]});
 const specs = [
  {id:'ema', name:'ema', params:{period:3}, outputs:['value']},
  {id:'obv', name:'obv', params:{}, outputs:['value']},
  {id:'adl', name:'adl', params:{}, outputs:['value']},
  {id:'anchored', name:'vwap', params:{anchorTime:T,source:'close',deviation:2}, outputs:['value','upper','lower','deviation','volume']},
  {id:'session', name:'vwap', params:{calendar,source:'close',deviation:2}, outputs:['value','upper','lower','deviation','volume']},
  {id:'pivots', name:'pivots', params:{calendar}, outputs:['pivot','r1','s1','r2','s2']},
 ];
 const f = fixture(input, specs, true); t.after(() => f.model.dispose());
 const before = snapshots(f.model, specs), rows = input.slice(4);
 f.api.compactData({keepLastBars:rows.length, studyHistory:'restart'});
 matchesFresh(f, rows, 'session restart', specs);
 const after = snapshots(f.model, specs);
 for (const study of specs) {
  const output = study.outputs[0];
  assert.notDeepEqual(after[study.id].outputs[output], before[study.id].outputs[output].slice(4),
   study.id+' cannot preserve discarded-history state');
 }
 // Scalar expectations use the literal retained bars, not an Aster definition,
 // checkpoint, or output. The cutoff lands in the middle of an observed day.
 exactVector(after.ema.outputs.value, [NaN,NaN,20,22,29], 'independent restarted EMA');
 exactVector(after.obv.outputs.value, [0,-6,1,9,18], 'independent restarted OBV');
 let total = 0;
 exactVector(after.adl.outputs.value, rows.map(row => total += (2*row.close-row.high-row.low)/(row.high-row.low)*row.volume), 'independent restarted ADL');
 for (let i = 0; i < rows.length; i++) {
  for (const id of ['anchored','session']) {
   const selected = rows.slice(id === 'session' && i >= 2 ? 2 : 0, i+1);
   const volume = selected.reduce((sum, row) => sum+row.volume, 0);
   const mean = selected.reduce((sum, row) => sum+row.close*row.volume, 0)/volume;
   const variance = selected.reduce((sum, row) => sum+row.volume*(row.close-mean)**2, 0)/volume;
   const expected = [mean,mean+2*Math.sqrt(variance),mean-2*Math.sqrt(variance),Math.sqrt(variance),volume];
   for (const [j, output] of specs.find(study => study.id === id).outputs.entries()) {
    const actual = after[id].outputs[output][i];
    assert.ok(Math.abs(actual-expected[j]) <= Math.max(1,Math.abs(expected[j]))*1e-12,
     `${id}/${output}[${i}] independent two-pass variance`);
   }
  }
 }
 const pivot = (34+10+12)/3;
 for (const [i, output] of specs.at(-1).outputs.entries()) {
  const level = [pivot,2*pivot-10,2*pivot-34,pivot+34-10,pivot-34+10][i];
  exactVector(after.pivots.outputs[output], [NaN,NaN,level,level,level], 'independent partial-session '+output);
 }
 const appended = {time:T+3*86400000, open:20, high:25, low:13, close:21, volume:11};
 rows.push(appended); f.api.applyDataEvent({kind:'append', bar:appended});
 matchesFresh(f, rows, 'new calendar session after restart', specs);
 rows[rows.length-1] = {...appended, close:14, volume:13};
 f.api.applyDataEvent({kind:'update', bar:rows.at(-1)});
 matchesFresh(f, rows, 'calendar current replacement after restart', specs);
 rows[0] = {...rows[0], high:55, low:8, close:42, volume:19};
 f.api.applyDataEvent({kind:'correction', bar:rows[0]});
 matchesFresh(f, rows, 'partial calendar session correction after restart', specs);
});
