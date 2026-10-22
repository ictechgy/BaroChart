import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartAPI, ChartModel, FIELDS, builtinIndicators, seededColumns} from '../src/core/index.mjs';

const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const row = (time, close, volume = 1) => ({time, open:close, high:close + 1, low:close - 1, close, volume});
function scan(values, a, b) {
 let min = Infinity, max = -Infinity, count = 0;
 for (let i = a; i < b; i++) if (Number.isFinite(values[i])) {
  min = Math.min(min, values[i]); max = Math.max(max, values[i]); count++;
 }
 return {min, max, count};
}
function ranges(index, values, length, rng) {
 for (let q = 0; q < 16; q++) {
  const a = Math.floor(rng() * length), b = Math.min(length, a + Math.floor(rng() * 97));
  const expected = scan(values, a, b);
  assert.deepEqual(index.query(a, b), {min:expected.min, max:expected.max, sum:0});
  assert.equal(index.finiteCount(a, b), expected.count);
 }
}

// Direct scalar scan is independent of either index implementation. These sizes
// cross both 32-row blocks and the small/blocked series-cache policy boundary.
for (const initial of [31, 32, 33, 65535, 65536, 65537]) test(`mixed raw streaming and compaction, initial ${initial}`, t => {
 const rng = random(391237 + initial), model = new ChartModel();
 t.after(() => model.dispose()); model.store.setColumns(seededColumns(initial));
 model.addSeries({id:'raw', type:'line', panel:'price'});
 const peer = new ChartModel({store:model.store}); t.after(() => peer.dispose());
 peer.addSeries({id:'peer', type:'line', panel:'price'});
 const api = new ChartAPI(model), series = model.series[0];
 let expected = Array.from(model.store.columns.close.subarray(0, initial));
 model.seriesData(series); peer.seriesData(peer.series[0]);
 for (let turn = 0; turn < 18; turn++) {
  const events = [], last = model.store.at(model.store.length - 1); let appended = 0;
  for (let j = 0, n = 1 + Math.floor(rng() * 40); j < n; j++) {
   const append = rng() < .4, i = append ? expected.length : Math.floor(rng() * model.store.length);
   const time = append ? last.time + (++appended) * 60000 : model.store.columns.time[i];
   const close = Math.floor(rng() * 200) - 100;
   events.push({kind:append ? 'append' : 'correction', bar:row(time, close)});
   expected[i] = close;
  }
  model.store.applyEvents(events);
  // Current-bar updates after a batch must coalesce with earlier corrections.
  const i = model.store.length - 1, close = turn % 2 ? -17 : 23;
  model.store.update(i, row(model.store.columns.time[i], close)); expected[i] = close;
  if (turn % 3 !== 2) continue;
  for (const owner of [peer, model]) {
   const data = owner.seriesData(owner.series[0]);
   assert.deepEqual(Array.from(data.values), expected);
   ranges(data.index, expected, expected.length, rng);
  }
  assert.equal(model.store.listenerErrors.length, 0);
 }
 const heldColumns = model.store.columns, heldIndex = model.seriesData(series).index;
 const heldCopy = heldColumns.close.slice(), version = model.store.version;
 // A failing batch after a valid staged edit must preserve all publication state.
 const edit = row(model.store.columns.time[0], 999);
 assert.throws(() => model.store.applyEvents([{kind:'correction', bar:edit}, {kind:'append', bar:edit}]), /increasing/);
 assert.equal(model.store.columns, heldColumns); assert.equal(model.store.version, version);
 assert.deepEqual(heldColumns.close, heldCopy); assert.equal(model.seriesData(series).index, heldIndex);
 assert.throws(() => api.compactData({keepLastBars:expected.length - 19, studyHistory:'restart'}), /exclusive/);
 peer.dispose();
 api.compactData({keepLastBars:expected.length - 19, studyHistory:'restart'}); expected = expected.slice(19);
 assert.deepEqual(heldColumns.close, heldCopy, 'retired columns remain readable');
 const compacted = model.seriesData(series); assert.notEqual(compacted.index, heldIndex);
 assert.deepEqual(Array.from(compacted.values), expected); ranges(compacted.index, expected, expected.length, rng);
 const next = row(model.store.at(model.store.length - 1).time + 60000, -333);
 model.store.append(next); expected.push(-333);
 const final = model.seriesData(series); ranges(final.index, expected, expected.length, rng);
 assert.equal(final.index.query(expected.length - 1, expected.length).min, -333);
 assert.equal(model.store.listenerErrors.length, 0);
 model.dispose(); assert.equal(model.store.listeners.size, 0);
});

const params = {period:5, atrPeriod:4, fast:3, slow:7, signal:3, conversion:3,
 base:5, span:7, displacement:4, stochPeriod:4, smoothK:2, smoothD:2, sessionMs:1800000};
// This is a fresh-implementation equivalence oracle, not independent formulas.
// It targets dirty/checkpoint/cache composition; dedicated formula tests remain.
for (const name of builtinIndicators.keys()) test(`deferred ${name} cache matches fresh after mixed streaming and restart`, t => {
 const rng = random(8765), make = time => row(time, 10 + rng() * 90, Math.floor(rng() * 20));
 let rows = Array.from({length:33}, (_, i) => make(1700000000000 + i * 60000));
 const model = new ChartModel({store:new BarStore(rows)}); t.after(() => model.dispose());
 model.indicators.checkpointSize = 8; model.indicators.add('x', name, params);
 for (const output of Object.keys(model.indicators.get('x').outputs)) model.addSeries({id:output, type:'line', panel:'price', indicator:'x', output});
 for (const s of model.series) model.seriesData(s);
 for (let round = 0; round < 18; round++) {
  if (round % 5 === 0) {
   const added = Array.from({length:3}, (_, i) => make(rows.at(-1).time + (i + 1) * 60000));
   const replacement = make(added[1].time);
   model.store.applyEvents([...added.map(bar => ({kind:'append', bar})), {kind:'correction', bar:replacement}]);
   added[1] = replacement; rows.push(...added);
  } else {
   const i = Math.floor(rng() * rows.length); rows[i] = make(rows[i].time); model.store.update(i, rows[i]);
  }
  if (round === 10) {
   new ChartAPI(model).compactData({keepLastBars:rows.length - 7, studyHistory:'restart'}); rows = rows.slice(7);
  }
  if (round % 3 !== 2) continue;
  if (round % 2 === 0) model.indicators.get('x');
  const fresh = new ChartModel({store:new BarStore(rows)});
  try {
   fresh.indicators.checkpointSize = 8;
   const expected = fresh.indicators.add('x', name, params).outputs;
   for (const s of model.series) {
    const data = model.seriesData(s), want = expected[s.output];
    assert.equal(data.values.length, want.length);
    for (let i = 0; i < want.length; i++) assert.ok(Object.is(data.values[i], want[i]), `${name}/${s.output}[${i}] round ${round}`);
    ranges(data.index, want, want.length, rng);
   }
   for (const key of FIELDS) assert.deepEqual(Array.from(model.store.columns[key].subarray(0, rows.length)), rows.map(r => r[key]));
   assert.equal(model.store.listenerErrors.length, 0);
  } finally {fresh.dispose(); assert.equal(fresh.store.listeners.size, 0);}
 }
 model.dispose(); assert.equal(model.store.listeners.size, 0);
});
