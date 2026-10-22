// Bounded synchronous Node state exploration, using modeled DOM/RAF and a
// non-raster renderer. No browser, GPU, heap-leak or wall-clock soak claim.
import assert from 'node:assert/strict';
import {ChartModel, ChartAPI, buildScene, FIELDS} from '../src/core/index.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';

const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const T = 1700000000000, STEP = 60000;
const bar = (time, close, volume = 1) => ({time, open:close, high:close + 1, low:close - 1, close, volume});
function apply(rows, event) {
 if (event.kind === 'append') {assert(event.bar.time > rows.at(-1).time); rows.push({...event.bar});}
 else {
  const index = (event.bar.time - T) / STEP;
  assert(Number.isSafeInteger(index) && rows[index]?.time === event.bar.time);
  if (event.kind === 'update') assert.equal(index, rows.length - 1);
  rows[index] = {...event.bar};
 }
}
function modelFor(rows) {
 const m = new ChartModel(); m.store.setData(rows);
 m.indicators.add('ema', 'ema', {period:5});
 m.addSeries({id:'price', type:'candles', panel:'price'});
 m.addSeries({id:'ema', type:'line', panel:'price', indicator:'ema'});
 m.setVisibleRange(Math.max(-.5, rows.length - 80.5), rows.length - .5);
 return m;
}
export function runStreamingLifecycle({charts = 4, shared = false, rounds = 256, seed = 42} = {}) {
 assert(Number.isSafeInteger(charts) && charts >= 1 && charts <= 8);
 assert.equal(typeof shared, 'boolean');
 assert(Number.isSafeInteger(rounds) && rounds >= 128 && rounds <= 8192);
 assert(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff);
 const keys = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'];
 const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
 const frames = new Map(), groups = [], retired = [];
 const stats = {rounds, charts, shared, seed, packets:0, accepted:0, applied:0, cancelled:0,
  queueRejections:0, pausedRejections:0, restores:0, pendingRestores:0, ringWraps:0,
  remounts:0, modelsCreated:0, modelsDisposed:0, chartsCreated:0, chartsDestroyed:0,
  renders:0, cacheReuseChecks:0, checks:0, valuesChecked:0, rangeChecks:0, publications:0, maxPending:0,
  maxFrames:0, maxStoredBars:0, finalRows:[]};
 let serial = 0, step = -1; const rng = random(seed);
 class Canvas extends EventTarget {
  constructor() {super(); this.style = {}; this.width = this.height = 0;}
  setAttribute() {} focus() {} setPointerCapture() {}
  getBoundingClientRect() {return {left:0, top:0};}
  remove() {this.removed = true;}
 }
 const cleanupChart = chart => {
  if (chart.disposed) return;
  chart.destroy(); stats.chartsDestroyed++;
  assert.equal(chart.listeners.length, 0); assert.equal(chart.frame, null);
  assert.equal(chart.lastScene, null); assert.equal(chart.timings.length, 0);
  assert.equal(chart.renderMetrics, null); assert.equal(chart.timeLayout, null);
  for (const key of ['base', 'state', 'items', 'drawingCommands']) assert.equal(chart.sceneCache[key], null);
  assert.equal(chart.sceneCache.selected, undefined);
  assert.equal(chart.controller.pointers.size, 0); assert.equal(chart.controller.gesture, null);
  assert.equal(chart.canvas.width, 0); assert.equal(chart.canvas.height, 0);
  assert.equal(chart.canvas.removed, true); assert.equal(chart.renderer.disposed, 1);
  retired.push(chart);
 };
 const makeChart = model => {
  const chart = new CanvasChart({append() {}, clientWidth:600, clientHeight:320}, model, {
   dpr:() => 1, observeResize:false, layerCaching:true, rasterCaching:'never',
   rendererFactory:() => ({kind:'test', disposed:0, render() {assert.equal(this.disposed, 0); stats.renders++;}, dispose() {this.disposed++;}}),
  }); stats.chartsCreated++; return chart;
 };
 const attach = (g, model) => {
  g.model = model; g.api = new ChartAPI(model); g.baseListeners = model.store.listeners.size;
  stats.modelsCreated++; g.publications = 0;
  g.off = model.store.subscribe(() => {g.publications++; stats.publications++;});
  g.charts = Array.from({length:shared ? charts : 1}, () => makeChart(model));
 };
 const ledger = g => {
  const s = g.api.dataIngestionStats();
  for (const k of ['accepted', 'applied', 'cancelled']) assert.equal(s[k], g.counts[k], k);
  assert.equal(s.accepted, s.applied + s.cancelled + s.pendingEvents);
  assert.equal(s.pendingEvents, g.pending.length); assert.equal(s.pendingBytes, g.pending.length * 49);
  assert.equal(s.nextSequence, 100 + g.counts.accepted); assert.equal(s.ownedBytes, 7 * 49);
  assert.equal(s.rejectedPackets, g.counts.rejected);
  assert.equal(g.model.store.listeners.size, g.baseListeners + 1 + g.charts.length);
  assert.equal(g.model.store.listenerErrors.length, 0);
  assert.equal(g.model.follow, true);
  assert.deepEqual(g.model.view, {from:g.rows.length - 31.5, to:g.rows.length - .5});
  stats.maxPending = Math.max(stats.maxPending, s.pendingEvents);
  stats.maxStoredBars = Math.max(stats.maxStoredBars, g.rows.length);
 };
 const drain = (g, n) => {
  const before = g.model.store.version, publications = g.publications;
  const take = Math.min(n, g.pending.length), head = g.model.dataIngestion.head;
  const expected = g.pending.slice(0, take), receipt = g.api.drainDataEvents(n);
  assert.equal(receipt.events, take); assert.equal(g.model.store.version, before + (take ? 1 : 0));
  assert.equal(g.publications, publications + (take ? 1 : 0));
  if (take) {
   assert.equal(receipt.firstSequence, expected[0].sequence);
   assert.equal(receipt.lastSequence, expected.at(-1).sequence);
   if (head + take >= 7) stats.ringWraps++;
   for (const event of expected) apply(g.rows, event);
   g.pending.splice(0, take); g.counts.applied += take; stats.applied += take;
  }
  ledger(g);
 };
 const flush = () => {
  stats.maxFrames = Math.max(stats.maxFrames, frames.size); assert(frames.size <= charts);
  const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(0);
  assert.equal(frames.size, 0);
  for (const g of groups) for (const c of g.charts) {
   assert.equal(c.lastError, null); assert(c.lastScene?.commands.length > 0);
   assert.equal(c.lastScene.stats.storedBars, g.rows.length); assert.equal(c.frame, null);
  }
 };
 const check = g => {
  stats.checks++; ledger(g); assert.equal(g.model.store.length, g.rows.length);
  let ema = NaN, sum = 0; const actual = g.model.seriesData(g.model.series[1]);
  assert.equal(actual.values.length, g.rows.length);
  for (let i = 0; i < g.rows.length; i++) {
   for (const key of FIELDS) {assert(Object.is(g.model.store.columns[key][i], g.rows[i][key])); stats.valuesChecked++;}
   if (i < 5) sum += g.rows[i].close;
   if (i === 4) ema = sum / 5;
   else if (i > 4) ema += (g.rows[i].close - ema) / 3;
   if (i < 4) assert(Number.isNaN(actual.values[i]));
   else assert(Math.abs(actual.values[i] - ema) <= Math.max(1, Math.abs(ema)) * 2e-12, `independent EMA at ${i}`);
   stats.valuesChecked++;
  }
  for (const [a, b] of [[0, g.rows.length], [Math.max(0, g.rows.length - 33), g.rows.length]]) {
   let min = Infinity, max = -Infinity, count = 0;
   for (let i = a; i < b; i++) if (Number.isFinite(actual.values[i])) {min = Math.min(min, actual.values[i]); max = Math.max(max, actual.values[i]); count++;}
   assert.deepEqual(actual.index.query(a, b), {min, max, sum:0}); assert.equal(actual.index.finiteCount(a, b), count); stats.rangeChecks++;
  }
  const fresh = modelFor(g.rows);
  try {
   fresh.setVisibleRange(g.model.view.from, g.model.view.to);
   assert.deepEqual(g.model.indicators.get('ema').outputs.value, fresh.indicators.get('ema').outputs.value);
   for (const chart of g.charts) assert.deepEqual(chart.lastScene.commands, buildScene(fresh, chart.container.clientWidth, chart.container.clientHeight).commands);
  } finally {fresh.dispose(); assert.equal(fresh.store.listeners.size, 0);}
 };
 try {
  globalThis.document = {createElement:() => new Canvas()};
  globalThis.requestAnimationFrame = fn => {frames.set(++serial, fn); return serial;};
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  for (let i = 0; i < (shared ? 1 : charts); i++) {
   const rows = Array.from({length:31}, (_, j) => bar(T + j * STEP, 50 + i + j / 8));
   const g = {rows, pending:[], counts:{accepted:0, applied:0, cancelled:0, rejected:0}}; groups.push(g);
   attach(g, modelFor(rows)); g.api.configureDataIngestion({streamId:'soak:' + i, generation:1, firstSequence:100, maxQueuedEvents:7, maxQueuedBytes:343, maxBatchEvents:3});
  }
  flush(); for (const g of groups) check(g);
  for (step = 0; step < rounds; step++) {
   for (const [i, g] of groups.entries()) {
    const projected = g.rows.slice(); for (const e of g.pending) apply(projected, e);
    const events = [];
    for (let j = 0, n = 1 + Math.floor(rng() * 4); j < n; j++) {
     const r = rng(), kind = r < .35 ? 'append' : r < .7 ? 'update' : 'correction';
     const time = kind === 'append' ? projected.at(-1).time + STEP : kind === 'update' ? projected.at(-1).time : projected[Math.floor(rng() * projected.length)].time;
     const event = {kind, bar:bar(time, 10 + Math.floor(rng() * 1600) / 16, step % 5 ? 1 + step % 13 : -0)};
     apply(projected, event); events.push(event);
    }
    const sequence = 100 + g.counts.accepted;
    const packet = {streamId:'soak:' + i, generation:1, firstSequence:sequence, events}; stats.packets++;
    if (step % 31 === 0) {
     g.api.pauseDataIngestion(); assert.throws(() => g.api.enqueueDataEvents(packet), e => e.code === 'PAUSED');
     g.counts.rejected++; stats.pausedRejections++; g.api.resumeDataIngestion();
    }
    if (events.length > 7 - g.pending.length) {
     const before = g.model.dataIngestion.prefix();
     assert.throws(() => g.api.enqueueDataEvents(packet), e => e.code === 'QUEUE_BUDGET');
     assert.deepEqual(g.model.dataIngestion.prefix(), before); g.counts.rejected++; stats.queueRejections++;
    } else {
     g.api.enqueueDataEvents(packet); g.pending.push(...events.map((e, j) => ({kind:e.kind, bar:{...e.bar}, sequence:sequence + j})));
     g.counts.accepted += events.length; stats.accepted += events.length;
     for (const e of events) {e.bar.close = -99999; e.bar.volume = 99999;} // The queue owns its snapshot.
    }
    ledger(g);
    if (step % 127 === 63) {
     const document = g.api.saveDataIngestion(), old = g.model, oldSession = old.dataIngestion, oldView = {...old.view};
     if (g.pending.length) stats.pendingRestores++;
     for (const c of g.charts) cleanupChart(c); g.off(); old.dispose(); stats.modelsDisposed++;
     assert.equal(old.store.listeners.size, 0); assert.equal(oldSession.model, null); assert.equal(oldSession.kinds, null); assert.deepEqual(oldSession.columns, {});
     attach(g, modelFor(g.rows)); g.model.setVisibleRange(oldView.from, oldView.to);
     g.api.loadDataIngestion(document); assert.equal(g.api.saveDataIngestion(), document); stats.restores++;
    }
    if (step % 29 === 17) {
     const receipt = g.api.cancelDataEvents(); assert.equal(receipt.events, g.pending.length);
     g.counts.cancelled += g.pending.length; stats.cancelled += g.pending.length; g.pending.length = 0;
    }
    drain(g, 1 + Math.floor(rng() * 3));
    if (step % 7 === 3) {
     const index = Math.floor(rng() * g.charts.length); cleanupChart(g.charts[index]);
     g.charts[index] = makeChart(g.model); stats.remounts++;
    }
    if (step % 19 === 0) for (const c of g.charts) {c.container.clientWidth = 600 + (step % 3) * 10; c.resize();}
    ledger(g);
   }
   flush();
   if (step % 16 === 15) {
    const held = groups.flatMap(g => g.charts.map(chart => ({chart, base:chart.sceneCache.base, commands:structuredClone(chart.lastScene.commands)})));
    for (const {chart} of held) chart.invalidate('hover');
    flush();
    for (const {chart, base, commands} of held) {
     assert.equal(chart.sceneCache.base, base); assert.equal(chart.renderMetrics.baseRedrawn, false);
     assert.equal(chart.renderMetrics.drawingsRedrawn, false); assert.deepEqual(chart.lastScene.commands, commands);
     stats.cacheReuseChecks++;
    }
   }
   if (step % 32 === 31) for (const g of groups) check(g);
  }
  for (const g of groups) while (g.pending.length) drain(g, 3);
  flush(); for (const g of groups) {check(g); stats.finalRows.push(g.rows.length);}
  assert(stats.queueRejections > 0 && stats.pausedRejections > 0 && stats.cancelled > 0 && stats.pendingRestores > 0 && stats.ringWraps > 0);
 } catch (error) {
  error.message += `\nstreaming lifecycle seed=${seed} shared=${shared} charts=${charts} step=${step}`;
  error.partial = {...stats, step}; throw error;
 } finally {
  try {
   for (const g of groups) {
    for (const c of g.charts ?? []) cleanupChart(c); g.off?.();
    if (g.model && !g.model.disposed) {g.model.dispose(); stats.modelsDisposed++;}
    if (g.model) assert.equal(g.model.store.listeners.size, 0);
   }
   assert.equal(frames.size, 0); assert.equal(stats.chartsCreated, stats.chartsDestroyed); assert.equal(stats.modelsCreated, stats.modelsDisposed);
   for (const c of retired) {assert.equal(c.renderer.disposed, 1); assert.equal(c.lastScene, null); assert.equal(c.frame, null); assert.equal(c.canvas.width, 0);}
  } finally {
   for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
 }
 return {...stats, scope:'Deterministic operation-count run with modeled DOM/RAF, actual CanvasChart/scene cache/ingestion and non-raster renderer. Independent OHLCV/ledger/EMA and scalar range checks plus fresh-implementation scene comparison. Retained destroyed references deliberately checked; no heap collection, real browser/GPU, duration or performance claim.'};
}
