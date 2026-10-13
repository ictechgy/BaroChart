import {createElement as h, StrictMode, createRef, useState} from 'react';
import {createRoot, hydrateRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AsterChart} from 'barochart/react';
import {ChartModel, BarStore, seededColumns} from 'barochart/core';
import {LayerCacheBudget} from 'barochart/canvas';
import {prepareChartModel, recomputeInWorker, runChartWorker} from 'barochart/worker';

// Browser lifecycle instrumentation observes real SDK resources; it never
// replaces the adapter, model, renderer or React with a test implementation.
const nativeRAF = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
const pendingRAF = new Set(), observers = new Set(), observed = new Map();
const NativeObserver = window.ResizeObserver;
const NativeWorker = window.Worker, workerResources = new Map();
window.Worker = class extends NativeWorker {
  constructor(url, workerOptions) {
    super(url, workerOptions);
    const entry = {url: String(url), type: workerOptions?.type, posts: 0, progress: 0, packets: 0, errors: [], terminated: 0};
    workerResources.set(this, entry);
    this.addEventListener('message', event => {if (event.data?.progress) entry.progress++; if (event.data?.packet) entry.packets++;});
    this.addEventListener('error', event => entry.errors.push(event.message));
  }
  postMessage(...args) {workerResources.get(this).posts++; return super.postMessage(...args);}
  terminate() {const result = super.terminate(); workerResources.get(this).terminated++; return result;}
};
const glResources = {}, glMethods = [];
for (const kind of ['Buffer', 'Texture', 'Renderbuffer', 'Framebuffer', 'VertexArray', 'Shader', 'Program']) {
  const prototype = WebGL2RenderingContext.prototype, createName = 'create' + kind, deleteName = 'delete' + kind;
  const create = prototype[createName], destroy = prototype[deleteName], ledger = glResources[kind] = {live: new Set(), created: 0, deleted: 0};
  prototype[createName] = function(...args) {const resource = create.apply(this, args); if (resource) {ledger.live.add(resource); ledger.created++;} return resource;};
  prototype[deleteName] = function(resource) {if (ledger.live.delete(resource)) ledger.deleted++; return destroy.call(this, resource);};
  glMethods.push(() => {prototype[createName] = create; prototype[deleteName] = destroy;});
}
window.requestAnimationFrame = callback => {let id; id = nativeRAF(time => {pendingRAF.delete(id); callback(time);}); pendingRAF.add(id); return id;};
window.cancelAnimationFrame = id => {pendingRAF.delete(id); return nativeCancel(id);};
window.ResizeObserver = class extends NativeObserver {
  constructor(callback) {super(callback); observers.add(this); observed.set(this, new Set());}
  observe(target, options) {observed.get(this).add(target); return super.observe(target, options);}
  unobserve(target) {observed.get(this).delete(target); return super.unobserve(target);}
  disconnect() {observed.get(this).clear(); observers.delete(this); return super.disconnect();}
};

const report = {checks: 0, tests: [], errors: [], expectedErrors: [], warnings: [], resources: {}, ssr: null};
const roots = new Set(), hosts = new Set();
let assertionFailures = [];
const pause = async () => {await new Promise(resolve => nativeRAF(() => nativeRAF(resolve))); await new Promise(resolve => setTimeout(resolve, 0));};
function assert(value, message) {report.checks++; if (!value) {assertionFailures.push(message); throw new Error(message);}}
function equal(actual, expected, message) {assert(Object.is(actual, expected), `${message}: ${actual} != ${expected}`);}
function bars(n = 40) {return Array.from({length: n}, (_, i) => ({time: 1700000000000 + i * 60000, open: 100 + i,
  high: 102 + i, low: 99 + i, close: 101 + i, volume: 100 + i}));}
const dpr = () => 1, options = {dpr}, errors = [];
const onError = error => {errors.push(error.message); report.expectedErrors.push(error.message);};
function model(data = bars()) {const m = new ChartModel({store: new BarStore(data)}); m.addSeries({id: 'price', type: 'candles', panel: 'price'}); return m;}
function bindingModel(suffix = '') {
  const m = model(); m.addAxis({id: 'b-axis' + suffix, panel: 'price', padding: 0, range: [1000, 2000]});
  m.addAxis({id: 'c-axis' + suffix, panel: 'price', padding: 0, range: [1e-12, 2e-12], tickFormat: 'scientific'});
  m.addSeries({id: 'b', type: 'line', panel: 'price', axisId: 'b-axis' + suffix, values: Float64Array.from({length: 40}, (_, i) => 1200 + i * 10)});
  m.addSeries({id: 'c', type: 'line', panel: 'price', axisId: 'c-axis' + suffix, values: Float64Array.from({length: 40}, (_, i) => 1.2e-12 + i * 1e-14)});
  m.fit(); return m;
}
function beginBoundEdit(chart, id = 'bound-c') {
  chart.api.setTool('select'); chart.drawNow(); const layout = chart.lastScene.layout, axis = layout.axis('price', 'c-axis');
  const x = layout.x(12), y = axis.y(1.5e-12); chart.controller.down(71, x, y);
  equal(chart.controller.gesture?.kind, 'edit', 'actual controller starts bound edit'); equal(chart.controller.gesture?.id, id, 'selected bound drawing');
  chart.controller.move(71, x + 10, y + 10); return {x, y};
}
function bindingDrawing(api, m, id = 'bound-c') {api.addDrawing({id, type: 'horizontal', panel: 'price', seriesId: 'c', points: [{time: m.store.at(10).time, price: 1.5e-12}]});}
const workerURL = route => new URL(route, location.href);
function workerRequest() {
  const input = bars(32), columns = Object.fromEntries(['time', 'open', 'high', 'low', 'close', 'volume'].map(field => [field, Float64Array.from(input, row => row[field])]));
  return {columns, length: 32, options: {series: [{id: 'price', type: 'candles', panel: 'price'}]}};
}
async function rejected(promise, predicate, message) {
  let reason; try {await promise;} catch (error) {reason = error;}
  assert(reason && predicate(reason), `${message}: ${reason?.name}: ${reason?.message}`); return reason;
}
function workerDelta(start, expected, message) {
  const entries = [...workerResources.values()].slice(start); equal(entries.length, expected, `${message} native Workers created`);
  for (const entry of entries) {equal(entry.type, 'module', `${message} real module worker`); equal(entry.terminated, 1, `${message} terminated exactly once`);}
  report.workerCases ??= []; report.workerCases.push({name: message, entries: entries.map(entry => ({...entry, errors: [...entry.errors]}))}); return entries;
}
function mount(props = {}, strict = false) {
  const host = document.createElement('section'); host.style.cssText = 'width:640px;'; document.getElementById('tests').append(host);
  const root = createRoot(host), ref = createRef(); roots.add(root); hosts.add(host);
  const render = async next => {flushSync(() => root.render(strict ? h(StrictMode, null, h(AsterChart, {...next, ref})) : h(AsterChart, {...next, ref}))); await pause();};
  const unmount = async () => {flushSync(() => root.unmount()); roots.delete(root); await pause(); host.remove(); hosts.delete(host);};
  return {host, root, ref, render, unmount, props: {options, onError, ...props}};
}
function live(f) {assert(f.ref.current?.chart && f.ref.current?.model && f.ref.current?.api, 'mounted handle has all getters'); return f.ref.current;}
function cleaned(context, owned = true, subscriptions = owned ? 0 : 2) {
  equal(context.chart.disposed, true, 'chart destroyed'); equal(context.chart.frame, null, 'no chart RAF');
  equal(context.chart.canvas.width, 0, 'canvas pixel width released'); equal(context.chart.canvas.height, 0, 'canvas pixel height released');
  equal(context.chart.listeners.length, 0, 'chart input listeners removed'); equal(context.chart.lastScene, null, 'scene released');
  equal(context.chart.layerSurfaces, null, 'raster surfaces released');
  if (context.chart.renderer) {equal(context.chart.renderer.disposed, true, 'WebGL renderer disposed'); equal(context.chart.renderer.packed, null, 'GPU packed buffer released');
    equal(context.chart.renderer.atlas.width, 0, 'glyph atlas pixel width released'); equal(context.chart.renderer.colorCanvas.width, 0, 'GPU color canvas pixels released');}
  equal(context.model.store.listeners.size, subscriptions, 'store subscriptions returned to ownership baseline');
  equal(Boolean(context.model.disposed), owned, 'model ownership respected');
}
function zeroResources() {equal(document.querySelectorAll('canvas').length, 0, 'no mounted canvases'); equal(observers.size, 0, 'no active ResizeObservers'); equal(pendingRAF.size, 0, 'no requested RAF');
  equal([...workerResources.values()].filter(entry => entry.terminated === 0).length, 0, 'all created native module Workers terminated');
  for (const [kind, ledger] of Object.entries(glResources)) equal(ledger.live.size, 0, `no live GL ${kind} objects`);}
async function test(name, action) {
  const start = report.checks; assertionFailures = [];
  // Callback exceptions are intentionally isolated by the SDK. Collect assertion
  // failures separately so the adapter cannot swallow a failing QA expectation.
  try {await action(); await pause(); zeroResources(); if (assertionFailures.length) throw new Error(assertionFailures.join('; ')); report.tests.push({name, pass: true, checks: report.checks - start});}
  catch (error) {report.tests.push({name, pass: false, checks: report.checks - start, error: error.stack});
    for (const root of roots) {try {flushSync(() => root.unmount());} catch {} } roots.clear();
    for (const [worker, entry] of workerResources) if (entry.terminated === 0) worker.terminate();
    for (const host of hosts) host.remove(); hosts.clear(); await pause();}
}

async function run() {
  await test('StrictMode repeated lifecycle and cleanup ordering', async () => {
    const made = [], contexts = [], cleanup = [];
    const createModel = () => {const m = model(); made.push(m); return m;};
    for (let i = 0; i < 8; i++) {
      const f = mount({createModel, onReady: context => {contexts.push(context); return () => {equal(context.chart.disposed, false, 'setup cleanup before destroy'); cleanup.push(context);};}}, true);
      await f.render(f.props); const handle = live(f); equal(f.host.querySelectorAll('canvas').length, 1, 'one active canvas in StrictMode');
      equal(handle.model.store.listeners.size, 3, 'one chart store subscription'); equal(observers.size, 1, 'one ResizeObserver');
      await f.unmount(); equal(f.ref.current, null, 'React clears ref'); equal(handle.chart, null, 'retained handle chart null');
      equal(handle.model, null, 'retained handle model null'); equal(handle.api, null, 'retained handle API null');
    }
    equal(made.length, 16, 'StrictMode exercises two creations per mount'); equal(contexts.length, 16, 'onReady per lifecycle');
    equal(cleanup.length, contexts.length, 'every ready cleanup called once'); contexts.forEach(c => cleaned(c));
  });
  await test('initial controlled props precede onReady', async () => {
    let ready = 0;
    const f = mount({data: bars(), theme: {background: '#102030'}, tool: 'trendline', text: 'hello', visibleRange: [2, 22], drawingTarget: {panel: 'price', seriesId: 'price'},
      onReady: ({chart, model}) => {ready++; equal(model.store.length, 40, 'initial data ready'); equal(model.theme.background, '#102030ff', 'initial theme ready');
        equal(chart.controller.tool, 'trendline', 'tool ready'); equal(chart.controller.text, 'hello', 'text ready'); equal(model.view.from, 2, 'range ready');
        equal(chart.controller.drawingTarget.seriesId, 'price', 'target ready');}});
    await f.render(f.props); live(f); equal(ready, 1, 'one ready'); await f.unmount();
  });
  await test('copied bars and dataRevision without recreation', async () => {
    const data = bars(), f = mount({data}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    data[0].close = 100.5; await f.render({...f.props}); equal(handle.model.store.at(0).close, 101, 'same identity alone does not reapply');
    await f.render({...f.props, dataRevision: 1}); equal(handle.model.store.at(0).close, 100.5, 'revision reapplies mutated bars');
    equal(handle.chart, chart, 'data revisions preserve chart'); equal(f.ref.current, handle, 'handle identity stable');
    const replacement = bars(45); await f.render({...f.props, data: replacement}); equal(handle.model.store.length, 45, 'new data identity applied');
    equal(handle.chart, chart, 'replacement preserves chart'); await f.unmount();
  });
  await test('typed columns copied, attached and same-buffer revision', async () => {
    const columns = seededColumns(64, 42), data = {columns, length: 64}, f = mount({data});
    const sourceBytes = Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, value.byteLength]));
    await f.render(f.props); const handle = live(f), chart = handle.chart;
    for (const key of Object.keys(columns)) {equal(columns[key].byteLength, sourceBytes[key], `${key} attached`); assert(handle.model.store.columns[key].buffer !== columns[key].buffer, `${key} copied`);}
    const before = handle.model.store.at(0).close, next = (columns.high[0] + columns.low[0]) / 2; columns.close[0] = next;
    equal(handle.model.store.at(0).close, before, 'source mutation does not affect copied store');
    await f.render({...f.props, dataRevision: 'tick-1'}); equal(handle.model.store.at(0).close, next, 'same-buffer revision updates copied store');
    equal(handle.chart, chart, 'same chart'); for (const key of Object.keys(columns)) equal(columns[key].byteLength, sourceBytes[key], `${key} still attached`); await f.unmount();
  });
  await test('inline primitive options/themes stable and omitted props preserve imperative state', async () => {
    const data = bars(), f = mount({data, theme: {background: '#112233'}}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    for (let i = 0; i < 10; i++) await f.render({...f.props, options: {dpr}, theme: {background: '#112233'}});
    equal(handle.chart, chart, 'equal inline options/theme do not recreate');
    handle.api.setTool('horizontal'); handle.api.setText('imperative'); handle.api.setTheme({background: '#223344'}); handle.api.setVisibleRange(5, 25);
    await f.render({options, onError}); equal(handle.chart, chart, 'omission preserves chart'); equal(handle.model.theme.background, '#223344ff', 'omission preserves theme');
    equal(chart.controller.tool, 'horizontal', 'omission preserves tool'); equal(chart.controller.text, 'imperative', 'omission preserves text'); equal(handle.model.view.from, 5, 'omission preserves view');
    equal(handle.model.store.length, 40, 'omission preserves data'); await f.unmount();
  });
  await test('inline column/target wrappers and callbacks preserve imperative streaming', async () => {
    const columns = seededColumns(100000, 42), f = mount({data: {columns, length: 100000}, drawingTarget: {panel: 'price', seriesId: 'price'}});
    await f.render(f.props); const handle = live(f), chart = handle.chart;
    const last = handle.model.store.at(99999); handle.api.applyDataEvent({kind: 'append', bar: {...last, time: last.time + 60000}}); await pause();
    const version = handle.model.store.version, frames = chart.timings.length;
    for (let i = 0; i < 12; i++) await f.render({...f.props, data: {columns: {...columns}, length: 100000}, options: {dpr}, theme: {background: '#0c1320'},
      drawingTarget: {panel: 'price', seriesId: 'price'}, onRender: () => {}, onState: () => {}});
    equal(handle.chart, chart, 'inline wrapper rerenders preserve chart'); equal(handle.model.store.version, version, 'same column refs preserve store version');
    equal(handle.model.store.length, 100001, 'same column wrappers do not reset appended stream');
    assert(chart.timings.length <= frames + 2, 'inline wrappers do not cause unbounded frame feedback'); await f.unmount();
  });
  await test('theme, tool, target and range updates through current API', async () => {
    const f = mount({data: bars()}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    await f.render({...f.props, theme: {grid: '#556677'}, tool: 'text', text: 'updated', drawingTarget: {panel: 'price'}, visibleRange: [3, 23]});
    equal(handle.chart, chart, 'controlled updates preserve chart'); equal(handle.model.theme.grid, '#556677ff', 'partial theme');
    equal(chart.controller.tool, 'text', 'tool update'); equal(chart.controller.text, 'updated', 'text update'); equal(handle.model.view.to, 23, 'range update');
    await f.render({...f.props, visibleRange: null, drawingTarget: null}); equal(handle.model.view.from, -.5, 'null range fits'); equal(handle.model.view.to, 39.5, 'fit literal extent');
    equal(chart.controller.drawingTarget, null, 'null target clears'); await f.unmount();
  });
  await test('owned factory init-only identity and recreation freshness', async () => {
    const contexts = [], madeA = [], madeB = [];
    const a = () => {const m = model(); madeA.push(m); return m;}, b = () => {const m = model(); madeB.push(m); return m;};
    const f = mount({createModel: a, onReady: c => {contexts.push(c);}}); await f.render(f.props); const handle = live(f), first = handle.chart;
    await f.render({...f.props, createModel: b}); equal(handle.chart, first, 'factory identity alone no recreation'); equal(madeB.length, 0, 'replacement factory not called yet');
    await f.render({...f.props, createModel: b, resetKey: 1}); assert(handle.chart !== first, 'reset recreates'); equal(madeB.length, 1, 'latest factory used on reset'); cleaned(contexts[0]);
    const second = handle.chart; await f.render({...f.props, createModel: b, resetKey: 1, options: {dpr, interactive: false}});
    assert(handle.chart !== second, 'constructor field change recreates'); equal(madeB.length, 2, 'fresh owned model each constructor lifecycle'); cleaned(contexts[1]);
    equal(f.ref.current, handle, 'ref handle stays stable across recreation'); await f.unmount(); contexts.forEach(c => cleaned(c));
  });
  await test('every constructor option and owned renderer change recreates cleanly', async () => {
    const contexts = [], factory = () => model(), f = mount({createModel: factory, onReady: c => {contexts.push(c);}});
    await f.render(f.props); const handle = live(f);
    const changes = [{dpr: () => 1}, {interactive: false}, {observeResize: false}, {layerCaching: false},
      {maxCachedPixels: 1024}, {rasterCaching: 'never'}, {cacheBudget: new LayerCacheBudget(1024 * 1024)}];
    let currentOptions = options;
    for (const patch of changes) {const previous = handle.chart; currentOptions = {...currentOptions, ...patch};
      await f.render({...f.props, options: currentOptions}); assert(handle.chart !== previous, `constructor field ${Object.keys(patch)[0]} recreates`);
      cleaned(contexts[contexts.length - 2]); equal(handle.model.disposed, undefined, 'new owned model alive');}
    const previous = handle.chart, previousModel = handle.model;
    await f.render({...f.props, options: currentOptions, renderer: 'webgl2'}); assert(handle.chart !== previous, 'owned renderer change recreates');
    assert(handle.model !== previousModel, 'owned renderer change gets fresh factory model'); equal(handle.chart.rendererKind, 'webgl2', 'owned real WebGL renderer');
    await f.unmount(); contexts.forEach(c => cleaned(c));
  });
  await test('borrowed model swap and renderer changes preserve model ownership', async () => {
    const a = model(), b = model(), contexts = []; const f = mount({model: a, onReady: c => {contexts.push(c);}});
    await f.render(f.props); const handle = live(f), first = handle.chart;
    await f.render({...f.props, model: b}); equal(handle.model, b, 'model swapped'); assert(handle.chart !== first, 'new chart for new model'); cleaned(contexts[0], false);
    await f.render({...f.props, model: b, renderer: 'webgl2'}); equal(handle.model, b, 'borrowed model preserved through renderer change');
    equal(handle.chart.rendererKind, 'webgl2', 'real WebGL2 created'); cleaned(contexts[1], false, 3); await f.unmount(); contexts.forEach(c => cleaned(c, false)); a.dispose(); b.dispose();
  });
  await test('borrowed general series array contract and explicit invalidation', async () => {
    const borrowed = model(), values = Float64Array.from({length: 40}, (_, i) => i + 200);
    borrowed.addSeries({id: 'external', type: 'line', panel: 'price', values}); const f = mount({model: borrowed});
    await f.render(f.props); const handle = live(f); equal(borrowed.series[1].values, values, 'direct model general values borrowed');
    values[3] = 250; borrowed.setSeriesValues('external', values); handle.chart.invalidate(); await pause(); equal(borrowed.series[1].values, values, 'explicit model update retains array');
    await f.render({...f.props, renderer: 'webgl2'}); equal(handle.model, borrowed, 'adapter retains borrowed model'); equal(borrowed.series[1].values, values, 'renderer change retains values');
    equal(values.byteLength, 320, 'values buffer remains attached'); await f.unmount(); equal(borrowed.store.listeners.size, 2, 'borrowed baseline subscriptions'); borrowed.dispose();
  });
  await test('callbacks use latest committed functions without recreation', async () => {
    let oldRender = 0, newRender = 0, oldState = 0, newState = 0, dispose = 0;
    const f = mount({data: bars(), onRender: () => oldRender++, onState: () => oldState++}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    const beforeRender = oldRender, beforeState = oldState;
    await f.render({...f.props, onRender: (context, event) => {newRender++; equal(context.chart, chart, 'latest render context'); equal(event.type, 'aster:render', 'render event'); equal(event.target, chart.canvas, 'render event target');},
      onState: (context, event) => {newState++; equal(context.model, handle.model, 'latest state context'); equal(event.type, 'aster:state', 'state event');}, onDispose: () => dispose++});
    chart.invalidate(); await pause(); equal(handle.chart, chart, 'callback change no recreation'); equal(oldRender, beforeRender, 'old render not reused'); equal(oldState, beforeState, 'old state not reused');
    assert(newRender > 0 && newState > 0, 'latest event callbacks invoked'); await f.unmount(); equal(dispose, 1, 'latest disposal callback');
  });
  await test('event callback errors isolated and onError replacement', async () => {
    const received = [], f = mount({data: bars()}); await f.render(f.props); const chart = live(f).chart;
    await f.render({...f.props, onRender: () => {throw new Error('render callback failure');}, onState: () => {throw new Error('state callback failure');}, onError: e => received.push(e.message)});
    chart.invalidate(); await pause(); assert(received.includes('render callback failure') && received.includes('state callback failure'), 'latest onError receives callback errors');
    equal(chart.disposed, false, 'event callback throw leaves live chart'); await f.render({...f.props, onError: () => {throw new Error('error callback failure');}, onState: () => {throw new Error('ignored by error handler');}});
    chart.invalidate(); await pause(); equal(chart.disposed, false, 'onError exception isolated'); await f.unmount();
  });
  await test('real WebGL context loss fallback keeps event callbacks', async () => {
    let fallback = 0, render = 0, oldFallback = 0; const f = mount({data: bars(), renderer: 'webgl2', onFallback: () => oldFallback++});
    await f.render(f.props); const handle = live(f), chart = handle.chart, originalCanvas = chart.canvas;
    equal(chart.rendererKind, 'webgl2', 'WebGL2 before context loss');
    await f.render({...f.props, onFallback: reason => {fallback++; assert(typeof reason === 'string' && reason.length > 0, 'fallback reason');}, onRender: () => render++});
    const extension = chart.renderer.gl.getExtension('WEBGL_lose_context'); assert(extension, 'context loss extension available'); extension.loseContext();
    for (let i = 0; i < 8 && chart.rendererKind !== 'canvas'; i++) await pause(); await pause();
    equal(chart.rendererKind, 'canvas', 'context loss falls back'); equal(handle.chart, chart, 'same chart wrapper'); assert(chart.canvas !== originalCanvas, 'fallback replaces canvas');
    equal(oldFallback, 0, 'old fallback not reused'); equal(fallback, 1, 'latest fallback called once'); assert(render > 0, 'host event listener survives fallback canvas replacement'); await f.unmount();
  });
  await test('real ResizeObserver dimensions and safe host attributes', async () => {
    const f = mount({data: bars(), id: 'safe-host', className: 'qa-chart', 'data-test': 'forwarded', 'aria-label': 'qa price', style: {height: 180, width: 500}});
    await f.render(f.props); const chart = live(f).chart; equal(chart.canvas.width, 500, 'CSS width observed'); equal(chart.canvas.height, 180, 'CSS height observed');
    equal(chart.container.id, 'safe-host', 'id forwarded'); equal(chart.container.getAttribute('data-test'), 'forwarded', 'data attribute forwarded'); equal(chart.container.getAttribute('aria-label'), 'qa price', 'ARIA forwarded');
    await f.render({...f.props, style: {height: 240, width: 540}}); await pause(); equal(chart.canvas.width, 540, 'resized width'); equal(chart.canvas.height, 240, 'resized height');
    equal(chart.container.querySelectorAll('canvas').length, 1, 'one canvas after resizing'); await f.unmount();
  });
  await test('three simultaneous charts have independent cleanup and cache budget', async () => {
    const budget = new LayerCacheBudget(32 * 1024 * 1024), contexts = [], fixtures = [];
    for (let i = 0; i < 3; i++) {const f = mount({data: bars(512), options: {dpr, rasterCaching: 'always', cacheBudget: budget}, onReady: c => {contexts.push(c);}}); fixtures.push(f); await f.render(f.props);}
    equal(document.querySelectorAll('canvas').length, 3, 'three current canvases'); equal(observers.size, 3, 'three independent observers'); assert(budget.usedBytes > 0, 'real raster budget allocations');
    await fixtures[1].unmount(); equal(observers.size, 2, 'one cleanup leaves two observers'); equal(contexts[0].chart.disposed, false, 'first chart lives'); equal(contexts[2].chart.disposed, false, 'third chart lives');
    await fixtures[0].unmount(); await fixtures[2].unmount(); equal(budget.usedBytes, 0, 'cache budget fully released'); contexts.forEach(c => cleaned(c));
  });
  await test('100k imperative streaming and corrections avoid React recreation', async () => {
    let ready = 0; const f = mount({data: {columns: seededColumns(100000, 42), length: 100000}, onReady: () => {ready++;}});
    await f.render(f.props); const handle = live(f), chart = handle.chart, m = handle.model; equal(m.store.length, 100000, '100k loaded');
    for (let i = 0; i < 20; i++) {const last = m.store.at(m.store.length - 1); handle.api.applyDataEvent({kind: 'append', bar: {...last, time: last.time + 60000}});}
    const last = m.store.at(m.store.length - 1), corrected = (last.high + last.low) / 2;
    handle.api.applyDataEvent({kind: 'update', bar: {...last, close: corrected}}); await pause();
    equal(m.store.length, 100020, 'twenty ticks appended'); equal(m.store.at(m.store.length - 1).close, corrected, 'last bar correction'); equal(ready, 1, 'no React recreation per tick');
    equal(handle.chart, chart, 'same chart/API'); assert(chart.timings.length > 0 && !chart.lastError, 'actual frame rendered'); await f.unmount();
  });
  await test('SSR and real hydration with no allocations or warnings', async () => {
    const ssr = await (await fetch('/ssr.json')).json(); report.ssr = ssr; equal(ssr.factories, 0, 'server does not call factory'); equal(ssr.hasCanvas, false, 'server emits no canvas');
    equal(ssr.html, ssr.expected, 'server host markup exact');
    const host = document.getElementById('hydrate'), ref = createRef(), made = [], recoverable = [];
    host.innerHTML = ssr.html; const props = {id: 'hydrated-chart', className: 'hydrated', style: {height: 180}, 'data-qa': 'ssr', ref,
      createModel: () => {const m = model(); made.push(m); return m;}, onError};
    const root = hydrateRoot(host, h(StrictMode, null, h(AsterChart, props)), {onRecoverableError: error => recoverable.push(error.message)}); roots.add(root);
    await pause(); await pause(); assert(ref.current?.chart, 'hydrated chart created'); equal(host.querySelectorAll('canvas').length, 1, 'one hydrated canvas'); equal(recoverable.length, 0, 'zero recoverable hydration errors');
    flushSync(() => root.unmount()); roots.delete(root); await pause(); host.innerHTML = ''; made.forEach(m => equal(m.disposed, true, 'hydration owned model disposed'));
  });
  await test('factory failure null handle and resetKey recovery', async () => {
    let fail = true, ready = 0; const f = mount({createModel: () => {if (fail) throw new Error('factory failure'); return model();}, onReady: () => {ready++;}});
    await f.render(f.props); const handle = f.ref.current; assert(handle, 'failure still exposes stable getter object'); equal(handle.chart, null, 'failed chart getter null'); equal(handle.model, null, 'failed model getter null');
    fail = false; await f.render({...f.props, resetKey: 1}); live(f); equal(f.ref.current, handle, 'handle stable through recovery'); equal(ready, 1, 'recovered ready'); await f.unmount();
  });
  await test('invalid ownership/model failures clean resources', async () => {
    const borrowed = model(); let disposedCallback = 0; const f = mount({model: borrowed, createModel: () => model(), onDispose: () => disposedCallback++});
    await f.render(f.props); equal(f.ref.current.chart, null, 'conflicting ownership rejected'); equal(borrowed.disposed, undefined, 'borrowed model not disposed on rejection'); equal(borrowed.store.listeners.size, 2, 'borrowed baseline retained');
    await f.render({...f.props, createModel: undefined, resetKey: 1}); live(f); await f.unmount(); equal(disposedCallback, 1, 'only actual created context disposed'); borrowed.dispose();
    const invalid = mount({createModel: () => ({})}); await invalid.render(invalid.props); equal(invalid.ref.current.model, null, 'non-model rejected'); await invalid.unmount();
    const dead = model(); dead.dispose(); const retired = mount({model: dead}); await retired.render(retired.props); equal(retired.ref.current.model, null, 'disposed model rejected'); await retired.unmount();
  });
  await test('constructor context failure disposes owned model and recovers', async () => {
    const made = []; let disposed = 0; const f = mount({createModel: () => {const m = model(); made.push(m); return m;}, onDispose: () => disposed++});
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...rest) {return kind === '2d' ? null : getContext.call(this, kind, ...rest);};
    try {await f.render(f.props);} finally {HTMLCanvasElement.prototype.getContext = getContext;}
    equal(f.ref.current.chart, null, 'constructor failure chart null'); equal(made[0].disposed, true, 'constructor failure owned model disposed'); equal(made[0].store.listeners.size, 0, 'constructor failure listeners removed');
    equal(disposed, 0, 'no disposal context callback before successful construction'); equal(f.host.querySelectorAll('canvas').length, 0, 'failed constructor canvas removed');
    await f.render({...f.props, resetKey: 'recover'}); live(f); await f.unmount(); equal(disposed, 1, 'successful context disposed once');
  });
  await test('throwing setup cleanup/onDispose cannot prevent teardown', async () => {
    let context, cleanups = 0, disposals = 0; const f = mount({data: bars(), onReady: c => {context = c; return () => {cleanups++; equal(c.chart.disposed, false, 'throwing cleanup before chart destroy'); throw new Error('cleanup failure');};},
      onDispose: c => {disposals++; equal(c.chart.disposed, true, 'onDispose after chart destroy'); equal(Boolean(c.model.disposed), false, 'owned model still live for onDispose'); throw new Error('dispose callback failure');}});
    await f.render(f.props); await f.unmount(); equal(cleanups, 1, 'cleanup once'); equal(disposals, 1, 'dispose once'); cleaned(context);
    assert(errors.includes('cleanup failure') && errors.includes('dispose callback failure'), 'cleanup failures reported');
  });
  await test('onReady callback exceptions and unsupported async return isolated', async () => {
    const throwing = mount({onReady: () => {throw new Error('ready callback failure');}}); await throwing.render(throwing.props); live(throwing); await throwing.unmount();
    const asynchronous = mount({onReady: () => Promise.resolve()}); await asynchronous.render(asynchronous.props); live(asynchronous); await asynchronous.unmount();
    assert(errors.includes('ready callback failure'), 'ready throw reported'); assert(errors.includes('onReady must return a synchronous cleanup function or undefined'), 'async return rejected');
  });
  await test('invalid controlled data preserves valid store and recovers', async () => {
    const f = mount({data: bars()}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    await f.render({...f.props, data: [{time: 1, open: 5, high: 4, low: 3, close: 5, volume: 1}]}); equal(handle.model.store.length, 40, 'invalid data preserves prior valid store');
    await f.render({...f.props, data: bars(50), dataRevision: 2}); equal(handle.model.store.length, 50, 'valid data recovery'); equal(handle.chart, chart, 'data failure no recreation'); await f.unmount();
  });
  await test('same invalid columns report once and revision explicitly retries', async () => {
    const messages = [], columns = seededColumns(32, 42); columns.close[0] = columns.high[0] + 10;
    const f = mount({data: {columns, length: 32}, onError: e => messages.push(e.message)}); await f.render(f.props); live(f);
    for (let i = 0; i < 6; i++) await f.render({...f.props, data: {columns: {...columns}, length: 32}});
    equal(messages.length, 1, 'unchanged invalid column key reports once');
    await f.render({...f.props, dataRevision: 1}); equal(messages.length, 2, 'changed revision retries once');
    columns.close[0] = (columns.high[0] + columns.low[0]) / 2; await f.render({...f.props, dataRevision: 2}); equal(f.ref.current.model.store.length, 32, 'fixed same buffer recovers via revision'); await f.unmount();
  });
  await test('invalid controlled props do not repeat through onError React feedback', async () => {
    const cases = [{name: 'theme', props: {theme: {background: 'invalid-color'}}}, {name: 'range', props: {visibleRange: [2, 2]}},
      {name: 'tool', props: {tool: 'invalid-tool'}}, {name: 'text', props: {text: 123}}];
    report.feedback = [];
    for (const entry of cases) {
      const columns = seededColumns(32, 42), messages = [], host = document.createElement('section'), ref = createRef();
      host.style.width = '640px'; document.getElementById('tests').append(host); hosts.add(host); const root = createRoot(host); roots.add(root); let renders = 0;
      function Consumer() {const [revision, setRevision] = useState(0); renders++;
        return h(AsterChart, {...entry.props, ref, 'data-feedback': revision, data: {columns: {...columns}, length: 32},
          options: {dpr}, drawingTarget: {panel: 'price', seriesId: 'price'},
          onError: error => {messages.push(error.message); if (messages.length < 8) setRevision(value => value + 1);}});}
      flushSync(() => root.render(h(Consumer))); await pause(); await pause(); await pause();
      const frames = ref.current?.chart?.timings.length ?? 0; report.feedback.push({prop: entry.name, errorCalls: messages.length, consumerRenders: renders, frames, messages});
      flushSync(() => root.unmount()); roots.delete(root); host.remove(); hosts.delete(host); await pause();
    }
    for (const result of report.feedback) equal(result.errorCalls, 1, `invalid ${result.prop} attempted once despite feedback rerender`);
  });
  await test('undefined optional theme fields are harmless after a valid theme', async () => {
    const messages = [], f = mount({data: bars(), theme: {background: '#112233'}, onError: error => messages.push(error.message)});
    await f.render(f.props); const handle = live(f), chart = handle.chart;
    await f.render({...f.props, theme: {background: undefined}}); equal(messages.length, 0, 'explicit undefined optional field does not error');
    equal(handle.model.theme.background, '#112233ff', 'undefined background leaves current color'); equal(handle.chart, chart, 'undefined theme field does not recreate'); await f.unmount();
  });
  await test('borrowed owner can dispose from onDispose after chart unsubscribes', async () => {
    const borrowed = model(); let context, called = 0;
    const f = mount({model: borrowed, onDispose: c => {called++; context = c; equal(c.chart.disposed, true, 'borrowed chart already destroyed');
      equal(c.model.store.listeners.size, 2, 'chart already unsubscribed'); c.model.dispose();}});
    await f.render(f.props); await f.unmount(); equal(called, 1, 'borrowed disposal callback once'); equal(context.model.disposed, true, 'owner disposal succeeded');
    equal(borrowed.store.listeners.size, 0, 'owner model fully unsubscribed');
  });
  await test('default height and constructor option failure resources', async () => {
    const f = mount(); await f.render(f.props); equal(live(f).chart.canvas.height, 320, 'default host height'); await f.unmount();
    const failed = mount({options: {dpr: 1}}); await failed.render(failed.props); equal(failed.ref.current.chart, null, 'invalid DPR constructor failure'); await failed.unmount();
  });
  await test('binding props and ref API preserve unrelated targets and stale-prop removal state', async () => {
    const m = bindingModel(), callbackErrors = [], states = []; let readyTarget;
    const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}, onError: e => callbackErrors.push(e.message),
      onReady: ({chart}) => {readyTarget = {...chart.controller.drawingTarget};}, onState: ({chart}) => states.push(chart.controller.drawingTarget?.seriesId ?? null)});
    await f.render(f.props); const handle = live(f), chart = handle.chart; equal(readyTarget.axisId, 'c-axis', 'onReady sees controlled C axis');
    bindingDrawing(handle.api, m); handle.api.selectDrawing('bound-c'); const b = m.series.find(s => s.id === 'b'), c = m.series.find(s => s.id === 'c');
    handle.api.removeSeries('b'); await pause(); equal(chart.controller.drawingTarget.seriesId, 'c', 'unrelated B removal preserves C'); equal(m.drawings.selected, 'bound-c', 'unrelated selection preserved');
    handle.api.addSeries({id: 'b', type: 'line', panel: 'price', axisId: 'b-axis', values: b.values}); equal(chart.controller.drawingTarget.seriesId, 'c', 'B restoration does not force target');
    handle.api.removeSeries('c'); await pause(); equal(chart.controller.drawingTarget, null, 'active C removal clears target');
    for (let i = 0; i < 4; i++) await f.render({...f.props, drawingTarget: {panel: 'price', seriesId: 'c'}, options: {dpr}, theme: {background: '#0c1320'}});
    equal(chart.controller.drawingTarget, null, 'unchanged stale C prop does not reinstate removed target'); equal(callbackErrors.length, 0, 'stale target rerenders do not report repeated binding errors');
    handle.api.addSeries({id: 'c', type: 'line', panel: 'price', axisId: 'c-axis', values: c.values}); equal(chart.controller.drawingTarget, null, 'C restoration leaves primary choice');
    await f.render({...f.props, drawingTarget: {panel: 'price', seriesId: 'b'}}); await f.render(f.props); equal(chart.controller.drawingTarget.seriesId, 'c', 'changed prop explicitly restores C choice');
    handle.api.setSeries('c', {axisId: 'b-axis'}); equal(chart.controller.drawingTarget.axisId, 'b-axis', 'series rebind updates current target axis');
    await f.render({...f.props, drawingTarget: {panel: 'price', seriesId: 'c'}}); equal(chart.controller.drawingTarget.axisId, 'b-axis', 'same target prop preserves API-rebound axis');
    equal(m.drawings.items[0].axisId, 'c-axis', 'existing drawing retains original binding'); handle.api.setSeries('c', {axisId: 'c-axis'});
    handle.api.addAxis({id: 'free-axis', panel: 'price', range: [1, 2]});
    const axisProps = {...f.props, drawingTarget: {panel: 'price', axisId: 'free-axis'}}; await f.render(axisProps); handle.api.removeAxis('free-axis');
    await f.render({...axisProps, drawingTarget: {panel: 'price', axisId: 'free-axis'}, options: {dpr}}); equal(chart.controller.drawingTarget, null, 'stale removed axis prop stays cleared');
    equal(handle.chart, chart, 'all binding API changes preserve React chart'); assert(states.includes('c') && states.includes(null), 'onState observes current target transitions');
    equal(callbackErrors.length, 0, 'binding flow reports no unexpected errors'); await f.unmount(); equal(m.store.listeners.size, 2, 'borrowed model subscriptions preserved'); m.dispose();
  });
  await test('binding model swaps keep stable ref and use new-model axis identity', async () => {
    const a = bindingModel(), b = bindingModel('-next'), contexts = [];
    const f = mount({model: a, drawingTarget: {panel: 'price', seriesId: 'c'}, onReady: c => {contexts.push(c);}}); await f.render(f.props);
    const handle = live(f), original = handle.chart; bindingDrawing(handle.api, a); beginBoundEdit(original);
    await f.render({...f.props, model: b}); equal(f.ref.current, handle, 'stable forwarded handle'); assert(handle.chart !== original, 'model swap gets new chart');
    equal(handle.model, b, 'ref points to new borrowed model'); equal(handle.chart.controller.drawingTarget.axisId, 'c-axis-next', 'same series prop resolves new model axis');
    equal(original.controller.gesture, null, 'old edit canceled on model swap'); equal(a.drawings.items[0].points[0].price, 1.5e-12, 'old model edit restored');
    equal(contexts.length, 2, 'onReady per model lifecycle'); cleaned(contexts[0], false); await f.unmount(); cleaned(contexts[1], false); a.dispose(); b.dispose();
  });
  await test('valid drawing rebind cancels old edit pointer and has independent undo/redo', async () => {
    for (const renderer of ['canvas', 'webgl2']) {
      const m = bindingModel(), f = mount({model: m, renderer, drawingTarget: {panel: 'price', seriesId: 'c'}}); await f.render(f.props);
      const handle = live(f), chart = handle.chart; bindingDrawing(handle.api, m); const original = handle.api.saveDrawings(), undoLength = m.drawings.undoStack.length;
      const point = beginBoundEdit(chart); handle.api.editDrawing('bound-c', {seriesId: 'b', axisId: 'b-axis', points: [{time: 1700000600000, price: 1500}]});
      equal(chart.controller.gesture, null, renderer + ' rebind cancels gesture'); equal(chart.controller.pointers.size, 0, 'old pointer ownership cleared'); equal(m.drawings.transaction, null, 'edit transaction closed');
      equal(m.drawings.items[0].axisId, 'b-axis', 'new B binding'); equal(m.drawings.items[0].points[0].price, 1500, 'literal B anchor'); equal(m.drawings.undoStack.length, undoLength + 1, 'one separate rebind history entry');
      const rebound = handle.api.saveDrawings(); chart.controller.move(71, point.x + 40, point.y + 40); equal(handle.api.saveDrawings(), rebound, 'same pointer cannot resume old C edit');
      chart.controller.cancel(); equal(handle.api.saveDrawings(), rebound, 'cancel cannot roll back committed rebind'); handle.api.undo(); equal(handle.api.saveDrawings(), original, 'undo restores original C binding and anchor');
      handle.api.redo(); equal(handle.api.saveDrawings(), rebound, 'redo restores B rebind'); chart.drawNow(); assert(!chart.lastError, 'actual rebound renderer succeeds'); await f.unmount(); m.dispose();
    }
  });
  await test('invalid rebind and affected axis changes preserve active edit atomically', async () => {
    const m = bindingModel();
    // Removing an invisible, unrelated axis leaves the shared plot margins and
    // C projection unchanged. Visible-axis removal is guarded in the next test.
    m.setAxis('b-axis', {visible: false});
    const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}}); await f.render(f.props);
    const handle = live(f), chart = handle.chart; bindingDrawing(handle.api, m); const original = handle.api.saveDrawings(), point = beginBoundEdit(chart);
    const gesture = chart.controller.gesture, transaction = m.drawings.transaction, selection = m.drawings.selected;
    const snapshot = () => JSON.stringify({items: m.drawings.items, undo: m.drawings.undoStack, redo: m.drawings.redoStack, axes: m.axes, selected: m.drawings.selected});
    for (const action of [() => handle.api.editDrawing('bound-c', {seriesId: 'b', axisId: 'c-axis'}),
      () => handle.api.editDrawing('bound-c', {seriesId: 'b', axisId: 'b-axis', points: [{time: 1700000600000, price: NaN}]}),
      () => handle.api.setAxis('c-axis', {range: [.9e-12, 2.1e-12]})]) {
      const before = snapshot(); let failure; try {action();} catch (error) {failure = error;} assert(failure instanceof Error, 'invalid/affected operation throws');
      equal(snapshot(), before, 'failed operation keeps data, history, axis and selection'); equal(chart.controller.gesture, gesture, 'failed operation preserves gesture object');
      equal(m.drawings.transaction, transaction, 'failed operation preserves transaction'); equal(chart.controller.pointers.has(71), true, 'failed operation preserves same pointer');
    }
    handle.api.removeSeries('b'); handle.api.removeAxis('b-axis'); equal(chart.controller.gesture, gesture, 'unrelated B axis removal preserves C gesture');
    equal(chart.controller.drawingTarget.seriesId, 'c', 'unrelated B axis removal preserves C target'); equal(m.drawings.selected, selection, 'unrelated B removal preserves selection');
    const beforeMove = JSON.stringify(m.drawings.items); chart.controller.move(71, point.x + 20, point.y + 20); assert(JSON.stringify(m.drawings.items) !== beforeMove, 'same pointer still edits after failed/unrelated changes');
    chart.controller.cancel(); equal(handle.api.saveDrawings(), original, 'cancel restores original C drawing'); handle.api.undo(); equal(m.drawings.items.length, 0, 'undo removes committed original drawing');
    handle.api.redo(); equal(handle.api.saveDrawings(), original, 'redo restores original C drawing'); await f.unmount(); m.dispose();
  });
  await test('active-create edits reject uncommitted ID and manual groups retain history contract', async () => {
    const m = bindingModel(), f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}}); await f.render(f.props);
    const handle = live(f), chart = handle.chart; handle.api.setTool('horizontal'); chart.drawNow(); const layout = chart.lastScene.layout, x = layout.x(10), y = layout.axis('price', 'c-axis').y(1.5e-12);
    chart.controller.down(71, x, y); const id = chart.controller.gesture.id, transaction = m.drawings.transaction; let failure;
    try {handle.api.editDrawing(id, {seriesId: 'b', axisId: 'b-axis', points: [{time: 1700000600000, price: 1500}]});} catch (error) {failure = error;}
    assert(failure instanceof Error && failure.message.includes('committed'), 'uncommitted active-create ID is rejected'); equal(m.drawings.transaction, transaction, 'create transaction retained');
    equal(chart.controller.gesture?.kind, 'create', 'create gesture retained'); chart.controller.move(71, x + 10, y + 10); chart.controller.cancel(); equal(m.drawings.items.length, 0, 'create cancel removes tentative drawing');
    equal(m.drawings.undoStack.length, 0, 'failed tentative edit adds no history'); m.drawings.begin(); bindingDrawing(handle.api, m, 'group-c');
    handle.api.addDrawing({id: 'group-b', type: 'horizontal', panel: 'price', seriesId: 'b', points: [{time: 1700000600000, price: 1500}]});
    handle.api.editDrawing('group-c', {points: [{time: 1700000600000, price: 1.6e-12}]}); equal(m.drawings.undoStack.length, 0, 'manual group stays uncommitted');
    m.drawings.commit(); equal(m.drawings.undoStack.length, 1, 'manual group commits one history entry'); handle.api.undo(); equal(m.drawings.items.length, 0, 'group undone together');
    handle.api.redo(); equal(m.drawings.items.length, 2, 'group redone together'); equal(m.drawings.items.find(d => d.id === 'group-c').points[0].price, 1.6e-12, 'group C literal anchor restored'); await f.unmount(); m.dispose();
  });
  await test('genuine worker publication retains target changed during progress and latest ref state', async () => {
    const m = bindingModel(), targets = []; const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'b'}, onState: ({chart}) => targets.push(chart.controller.drawingTarget?.seriesId ?? null)});
    await f.render(f.props); const handle = live(f), chart = handle.chart; bindingDrawing(handle.api, m); handle.api.selectDrawing('bound-c'); const document = handle.api.saveDrawings(), version = m.store.version;
    let progress = 0, changed = false, versionAtTargetChange;
    await recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.5}}, {workerURL: new URL('/worker.js', location.href), timeoutMs: 10000,
      onProgress: () => {progress++; if (!changed) {changed = true; versionAtTargetChange = m.store.version; handle.api.setDrawingTarget({panel: 'price', seriesId: 'c'});}}});
    await pause(); assert(progress > 0 && changed, 'real module worker delivered progress before publication'); equal(versionAtTargetChange, version, 'target changed before store publication');
    equal(m.store.version, version + 1, 'one atomic correction published'); equal(m.store.at(4).close, 105.5, 'literal correction installed');
    equal(handle.chart, chart, 'same React chart through async publication'); equal(handle.model, m, 'same model getter'); equal(chart.controller.drawingTarget.seriesId, 'c', 'latest target survives publication');
    equal(chart.controller.drawingTarget.axisId, 'c-axis', 'latest target axis survives publication'); equal(handle.api.saveDrawings(), document, 'drawing document survives publication');
    equal(m.drawings.selected, 'bound-c', 'selection survives publication'); await f.render({...f.props, drawingTarget: {panel: 'price', seriesId: 'b'}});
    equal(chart.controller.drawingTarget.seriesId, 'c', 'unchanged original prop does not reset newer API target'); assert(targets.includes('c'), 'onState callback observes current publication target');
    equal(chart.lastError, null, 'actual published frame succeeds'); report.asyncBinding = {progress, versionAtTargetChange, versionAfter: m.store.version, targetAfter: {...chart.controller.drawingTarget}, close: m.store.at(4).close};
    await f.unmount(); m.dispose();
  });
  await test('onState sees committed rebind and guarded nested mutation retains separate undo entries', async () => {
    const m = bindingModel(), observations = []; let watch = false, nested = false;
    const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}, onState: ({chart}) => {
      if (!watch) return; const drawing = m.drawings.items.find(d => d.id === 'bound-c');
      observations.push({axis: drawing?.axisId, price: drawing?.points[0].price, pointerCount: chart.controller.pointers.size,
        gesture: chart.controller.gesture, transaction: m.drawings.transaction, target: {...chart.controller.drawingTarget}, history: m.drawings.undoStack.length});
      if (!nested) {nested = true; chart.api.addDrawing({id: 'nested-c', type: 'horizontal', panel: 'price', seriesId: 'c', points: [{time: 1700000600000, price: 1.7e-12}]});}
    }});
    await f.render(f.props); const handle = live(f), chart = handle.chart; bindingDrawing(handle.api, m); const original = handle.api.saveDrawings(), beforeHistory = m.drawings.undoStack.length;
    beginBoundEdit(chart); watch = true; handle.api.editDrawing('bound-c', {seriesId: 'b', axisId: 'b-axis', points: [{time: 1700000600000, price: 1500}]}); watch = false;
    equal(observations.length, 2, 'one outer and one guarded nested completed notification');
    equal(observations[0]?.history, beforeHistory + 1, 'outer history committed before its callback'); equal(observations[1]?.history, beforeHistory + 2, 'nested history committed before its callback');
    for (const state of observations) {equal(state.axis, 'b-axis', 'listener only sees completed B binding'); equal(state.price, 1500, 'listener only sees completed B price');
      equal(state.pointerCount, 0, 'listener sees cleared pointer ownership'); equal(state.gesture, null, 'listener sees ended gesture'); equal(state.transaction, null, 'listener sees committed transaction');
      equal(state.target.seriesId, 'c', 'creation target remains unrelated C');}
    equal(m.drawings.undoStack.length, beforeHistory + 2, 'outer and nested have separate history'); equal(m.drawings.items.length, 2, 'outer write retains nested drawing');
    handle.api.undo(); equal(m.drawings.items.length, 1, 'first undo removes only nested addition'); equal(m.drawings.items[0].axisId, 'b-axis', 'outer rebind remains after nested undo');
    handle.api.undo(); equal(handle.api.saveDrawings(), original, 'second undo restores original C'); handle.api.redo(); equal(m.drawings.items[0].axisId, 'b-axis', 'first redo restores outer rebind');
    handle.api.redo(); equal(m.drawings.items.find(d => d.id === 'nested-c').points[0].price, 1.7e-12, 'second redo restores nested addition');
    report.reentrantBinding = observations.map(({axis, price, pointerCount, target, history}) => ({axis, price, pointerCount, target, history})); await f.unmount(); m.dispose();
  });
  await test('worker publication preserves onState observer viewport and target updates', async () => {
    const m = bindingModel(), publicationVersion = m.store.version + 1; let changed = false, calls = 0;
    const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'b'}, onState: ({chart, model}) => {
      calls++; if (!changed && model.store.version === publicationVersion) {changed = true; chart.api.setVisibleRange(4, 9); chart.api.setDrawingTarget({panel: 'price', seriesId: 'c'});}
    }});
    await f.render(f.props); const handle = live(f), chart = handle.chart;
    await recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.75}}, {workerURL: new URL('/worker.js', location.href), timeoutMs: 10000}); await pause();
    assert(changed, 'real publication triggers onState observer update'); equal(m.store.version, publicationVersion, 'one correction publication'); equal(m.store.at(4).close, 105.75, 'literal second correction');
    equal(m.view.from, 4, 'observer viewport from survives outer publication'); equal(m.view.to, 14, 'core minimum ten-bar span preserved for requested [4,9]'); equal(m.follow, false, 'observer follow choice survives publication');
    equal(chart.controller.drawingTarget.seriesId, 'c', 'observer target survives publication'); equal(handle.chart, chart, 'ref chart unchanged');
    report.workerObserver = {calls, publicationVersion, from: m.view.from, to: m.view.to, follow: m.follow, target: {...chart.controller.drawingTarget}};
    await f.unmount(); m.dispose();
  });
  await test('public target/tool changes notify only their fully completed state', async () => {
    const m = bindingModel(), observed = []; let watching = false;
    const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}, onState: ({chart}) => {
      if (watching) observed.push({tool: chart.controller.tool, target: chart.controller.drawingTarget?.seriesId, pointers: chart.controller.pointers.size,
        gesture: chart.controller.gesture, transaction: m.drawings.transaction, price: m.drawings.items[0]?.points[0].price});
    }});
    await f.render(f.props); const handle = live(f), chart = handle.chart; bindingDrawing(handle.api, m); beginBoundEdit(chart);
    watching = true; handle.api.setDrawingTarget({panel: 'price', seriesId: 'b'}); watching = false;
    equal(observed.length, 1, 'public target change has one completed notification'); equal(observed[0]?.target, 'b', 'target callback sees new B choice'); equal(observed[0]?.price, 1.5e-12, 'target callback sees restored original anchor');
    equal(observed[0]?.pointers, 0, 'target callback sees canceled pointer'); equal(observed[0]?.gesture, null, 'target callback sees canceled gesture'); equal(observed[0]?.transaction, null, 'target callback sees closed transaction');
    observed.length = 0; beginBoundEdit(chart); watching = true; handle.api.setTool('horizontal'); watching = false;
    equal(observed.length, 1, 'public tool change has one completed notification'); equal(observed[0]?.tool, 'horizontal', 'tool callback sees new tool'); equal(observed[0]?.target, 'b', 'tool preserves current B target');
    equal(observed[0]?.price, 1.5e-12, 'tool callback sees restored original anchor'); equal(observed[0]?.pointers, 0, 'tool callback sees cleared pointer'); equal(observed[0]?.gesture, null, 'tool callback sees canceled gesture');
    equal(observed[0]?.transaction, null, 'tool callback sees closed transaction'); equal(m.drawings.undoStack.length, 1, 'canceling edits through controls adds no history'); await f.unmount(); m.dispose();
  });
  await test('global plot-margin changes are rejected during another-axis edit without pointer drift', async () => {
    for (const variant of ['width-and-other-panel', 'remove-left-axis']) {
      const m = bindingModel();
      if (variant === 'width-and-other-panel') m.addPanel({id: 'osc', weight: 1, axisVisible: false, axisSide: 'left'});
      else m.setAxis('b-axis', {side: 'left', width: 120});
      const f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}}); await f.render(f.props); const handle = live(f), chart = handle.chart;
      bindingDrawing(handle.api, m); const point = beginBoundEdit(chart), gesture = chart.controller.gesture, transaction = m.drawings.transaction;
      if (variant === 'remove-left-axis') handle.api.removeSeries('b');
      const actions = variant === 'width-and-other-panel' ? [() => handle.api.setAxis('b-axis', {width: 120}), () => handle.api.setPanel('osc', {axisVisible: true})] : [() => handle.api.removeAxis('b-axis')];
      for (const action of actions) {
        const before = JSON.stringify({axes: m.axes, panels: m.panels, items: m.drawings.items, undo: m.drawings.undoStack}); let failure;
        try {action();} catch (error) {failure = error;}
        assert(failure instanceof Error, 'actual shared plot-margin change rejected'); equal(JSON.stringify({axes: m.axes, panels: m.panels, items: m.drawings.items, undo: m.drawings.undoStack}), before, 'rejected plot-margin mutation atomic');
        equal(chart.controller.gesture, gesture, 'plot-margin guard retains active gesture'); equal(m.drawings.transaction, transaction, 'plot-margin guard retains transaction');
        const drawing = JSON.stringify(m.drawings.items[0]); chart.controller.move(71, point.x + 10, point.y + 10); equal(JSON.stringify(m.drawings.items[0]), drawing, 'same input coordinate has no raw anchor drift');
      }
      chart.controller.cancel(); equal(m.drawings.items[0].points[0].price, 1.5e-12, 'cancel restores independent C price'); await f.unmount(); m.dispose();
    }
  });
  await test('real publication keeps observer custom-series values and fresh autoscale index', async () => {
    const m = bindingModel(); m.setAxis('c-axis', {range: undefined}); const publicationVersion = m.store.version + 1;
    const values = new Float64Array(40).fill(1.25e-12); values[4] = 9e-12; let changed = false;
    const f = mount({model: m, onState: ({chart, model}) => {if (!changed && model.store.version === publicationVersion) {changed = true; chart.api.setSeriesValues('c', values);}}});
    await f.render(f.props); const handle = live(f), chart = handle.chart;
    await recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.5}}, {workerURL: workerURL('/worker.js'), timeoutMs: 10000}); await pause(); chart.drawNow();
    assert(changed, 'real worker publication invokes series owner update'); equal(m.series.find(series => series.id === 'c').values[4], 9e-12, 'latest observer value survives');
    const axis = chart.lastScene.layout.axis('price', 'c-axis'); equal(axis.min, 1.25e-12, 'fresh range index literal minimum'); equal(axis.max, 9e-12, 'fresh range index literal maximum');
    assert(!chart.lastError, 'actual scene renders observer custom values'); await f.unmount(); m.dispose();
  });
  await test('viewport change cancels old drawing projection on the next same-pointer move', async () => {
    const m = bindingModel(), f = mount({model: m, drawingTarget: {panel: 'price', seriesId: 'c'}}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    bindingDrawing(handle.api, m); const committed = handle.api.saveDrawings(), history = m.drawings.undoStack.length, oldView = {...m.view}, point = beginBoundEdit(chart);
    handle.api.zoom(.9); const nextView = {...m.view}; assert(nextView.from !== oldView.from || nextView.to !== oldView.to, 'actual viewport zoom changes projection'); chart.drawNow();
    chart.controller.move(71, point.x + 10, point.y + 10);
    equal(chart.controller.gesture, null, 'same pointer cannot edit with an old viewport projection'); equal(chart.controller.pointers.size, 0, 'projection cancellation clears pointer ownership');
    equal(m.drawings.transaction, null, 'projection cancellation closes transaction'); equal(handle.api.saveDrawings(), committed, 'projection cancellation restores committed raw anchors');
    equal(m.drawings.undoStack.length, history, 'projection cancellation creates no history'); equal(m.view.from, nextView.from, 'new viewport from preserved'); equal(m.view.to, nextView.to, 'new viewport to preserved');
    equal(m.drawings.selected, 'bound-c', 'projection cancellation preserves selection'); equal(chart.controller.drawingTarget.seriesId, 'c', 'projection cancellation preserves target'); await f.unmount(); m.dispose();
  });
  for (const field of ['tool', 'text', 'drawingTarget', 'visibleRange', 'data']) await test(`omitted ${field} preserves imperative state and same-value re-control applies`, async () => {
    const borrowed = field === 'drawingTarget' ? bindingModel() : null;
    const initial = {tool: 'trendline', text: 'controlled text', drawingTarget: {panel: 'price', seriesId: 'c'}, visibleRange: [2, 22], data: bars(40)}[field];
    const f = mount({...borrowed ? {model: borrowed} : {}, data: bars(40), [field]: initial}); await f.render(f.props);
    const handle = live(f), chart = handle.chart, omitted = {...f.props}; delete omitted[field]; await f.render(omitted);
    if (field === 'tool') handle.api.setTool('horizontal');
    if (field === 'text') handle.api.setText('imperative text');
    if (field === 'drawingTarget') handle.api.setDrawingTarget({panel: 'price', seriesId: 'b'});
    if (field === 'visibleRange') handle.api.setVisibleRange(5, 25);
    if (field === 'data') handle.api.setData(bars(50));
    await f.render({...omitted});
    if (field === 'tool') equal(chart.controller.tool, 'horizontal', 'omitted tool leaves imperative choice');
    if (field === 'text') equal(chart.controller.text, 'imperative text', 'omitted text leaves imperative choice');
    if (field === 'drawingTarget') equal(chart.controller.drawingTarget.seriesId, 'b', 'omitted target leaves imperative choice');
    if (field === 'visibleRange') equal(handle.model.view.from, 5, 'omitted range leaves imperative choice');
    if (field === 'data') equal(handle.model.store.length, 50, 'omitted data leaves imperative store');
    await f.render({...f.props, [field]: initial});
    if (field === 'tool') equal(chart.controller.tool, 'trendline', 'same tool regains control');
    if (field === 'text') equal(chart.controller.text, 'controlled text', 'same text regains control');
    if (field === 'drawingTarget') equal(chart.controller.drawingTarget?.seriesId, 'c', 'same target regains control');
    if (field === 'visibleRange') {equal(handle.model.view.from, 2, 'same range from regains control'); equal(handle.model.view.to, 22, 'same range to regains control');}
    if (field === 'data') equal(handle.model.store.length, 40, 'same copied input regains control');
    equal(handle.chart, chart, 're-control does not recreate chart'); await f.unmount(); borrowed?.dispose();
  });
  for (const invalid of ['extra-key', 'prototype']) await test(`invalid target ${invalid} corrected with same IDs retries once`, async () => {
    const borrowed = bindingModel(), failures = [], prototype = {inherited: true};
    const invalidTarget = () => invalid === 'extra-key' ? {panel: 'price', seriesId: 'c', extra: 1} : Object.assign(Object.create(prototype), {panel: 'price', seriesId: 'c'});
    const f = mount({model: borrowed, drawingTarget: invalidTarget(), onError: e => failures.push(e.message)}); await f.render(f.props); const handle = live(f), chart = handle.chart;
    equal(chart.controller.drawingTarget, null, 'invalid target not installed');
    for (let i = 0; i < 4; i++) await f.render({...f.props, drawingTarget: invalidTarget(), options: {dpr}});
    equal(failures.length, 1, 'same invalid shape/prototype reports once');
    await f.render({...f.props, drawingTarget: {panel: 'price', seriesId: 'c'}}); equal(chart.controller.drawingTarget?.seriesId, 'c', 'valid same IDs target is retried');
    equal(chart.controller.drawingTarget?.axisId, 'c-axis', 'valid retry binds correct axis'); equal(failures.length, 1, 'valid correction adds no error'); equal(handle.chart, chart, 'shape correction preserves chart'); await f.unmount(); borrowed.dispose();
  });
  await test('unsupported rejected onReady thenables route rejection to onError without async cleanup', async () => {
    const unhandled = [], listener = event => unhandled.push(String(event.reason?.message ?? event.reason)); window.addEventListener('unhandledrejection', listener);
    let asyncCleanupCalls = 0; const cases = [{name: 'Promise', result: () => Promise.reject(new Error('async-ready rejection')), rejection: 'async-ready rejection'},
      {name: 'thenable', result: () => ({then(_resolve, reject) {reject(new Error('thenable-ready rejection'));}}), rejection: 'thenable-ready rejection'},
      {name: 'fulfilled cleanup', result: () => Promise.resolve(() => asyncCleanupCalls++), rejection: null}];
    const observed = [];
    try {
      for (const entry of cases) {const failures = [], f = mount({onReady: () => entry.result(), onError: error => failures.push(error.message)});
        await f.render(f.props); live(f); await pause(); await f.unmount(); observed.push({name: entry.name, errors: failures});
      }
    } finally {window.removeEventListener('unhandledrejection', listener);}
    for (let i = 0; i < cases.length; i++) {assert(observed[i].errors.includes('onReady must return a synchronous cleanup function or undefined'), 'unsupported async return diagnosed');
      if (cases[i].rejection) assert(observed[i].errors.includes(cases[i].rejection), 'unsupported thenable rejection routed to onError');}
    equal(unhandled.length, 0, 'unsupported thenables cause no global unhandled rejection'); equal(asyncCleanupCalls, 0, 'fulfilled async cleanup is never installed'); report.asyncReadyDiagnostics = observed;
  });
  await test('low-level Worker rejects malformed options before native allocation', async () => {
    const start = workerResources.size, request = workerRequest(), url = workerURL('/worker.js');
    for (const signal of [null, {aborted: false}, {aborted: 'false', addEventListener() {}, removeEventListener() {}}])
      await rejected(runChartWorker(request, {workerURL: url, signal}), error => error instanceof TypeError, 'malformed signal rejected');
    for (const timeoutMs of [0, -1, NaN, Infinity, 120001, '5'])
      await rejected(runChartWorker(request, {workerURL: url, timeoutMs}), error => error instanceof RangeError, 'malformed timeout rejected');
    for (const onProgress of [null, 42, {}])
      await rejected(runChartWorker(request, {workerURL: url, onProgress}), error => error instanceof TypeError, 'malformed progress rejected');
    const aborted = new AbortController(); aborted.abort(); await rejected(runChartWorker(request, {workerURL: url, signal: aborted.signal}), error => error.name === 'AbortError', 'pre-aborted signal rejected');
    workerDelta(start, 0, 'invalid options and pre-abort');
  });
  await test('actual Worker registration failure and synchronous abort both terminate without posting', async () => {
    let start = workerResources.size, removed = 0; const failure = new Error('intentional listener registration failure');
    const signal = {aborted: false, addEventListener() {throw failure;}, removeEventListener() {removed++;}};
    await rejected(runChartWorker(workerRequest(), {workerURL: workerURL('/worker.js'), signal}), error => error === failure, 'listener registration error preserved');
    equal(removed, 1, 'registration failure attempts listener cleanup'); equal(workerDelta(start, 1, 'registration throws')[0].posts, 0, 'registration failure posts no request');
    start = workerResources.size; removed = 0;
    const raceSignal = {aborted: false, addEventListener(_kind, cancel) {this.aborted = true; cancel();}, removeEventListener() {removed++;}};
    await rejected(runChartWorker(workerRequest(), {workerURL: workerURL('/worker.js'), signal: raceSignal}), error => error.name === 'AbortError', 'abort during registration preserved');
    equal(removed, 1, 'synchronous abort removes listener'); equal(workerDelta(start, 1, 'abort during registration')[0].posts, 0, 'settled abort skips native post');
  });
  await test('actual Worker removal failure preserves post error and cannot skip termination', async () => {
    let start = workerResources.size, removals = 0; const cleanup = new Error('intentional listener removal failure');
    const signal = {aborted: false, addEventListener() {}, removeEventListener() {removals++; throw cleanup;}};
    await rejected(runChartWorker({...workerRequest(), nonCloneable() {}}, {workerURL: workerURL('/worker.js'), signal}), error => error.name === 'DataCloneError', 'real native post error wins over removal error');
    equal(removals, 1, 'failed post still removes listener'); equal(workerDelta(start, 1, 'removal and native post error')[0].posts, 1, 'one native post attempt');
    start = workerResources.size; removals = 0;
    await rejected(runChartWorker(workerRequest(), {workerURL: workerURL('/worker.js'), signal}), error => error === cleanup, 'normal packet surfaces cleanup failure');
    equal(removals, 1, 'normal packet removes listener'); const entry = workerDelta(start, 1, 'removal after normal packet')[0]; equal(entry.packets, 1, 'genuine worker produced complete packet');
    assert(entry.progress > 0, 'genuine worker emitted progress before packet');
  });
  await test('real worker URL returns exact copied columns and settled handler ignores late progress', async () => {
    const start = workerResources.size, request = workerRequest(), progress = [];
    const packet = await runChartWorker(request, {workerURL: workerURL('/worker.js'), onProgress: value => progress.push(value), timeoutMs: 10000});
    equal(packet.store.length, 32, 'real packet length');
    for (const field of ['time', 'open', 'high', 'low', 'close', 'volume']) {
      equal(request.columns[field].byteLength, 256, `${field} source remains attached`); assert(packet.store.columns[field].buffer !== request.columns[field].buffer, `${field} reply separately allocated`);
      for (let i = 0; i < 32; i++) {
        const expected = {time: 1700000000000 + i * 60000, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100 + i}[field];
        equal(packet.store.columns[field][i], expected, `${field} independent literal row ${i}`);
      }
    }
    assert(progress.length > 0, 'actual worker progress delivered'); const worker = [...workerResources.keys()][start], count = progress.length;
    // Native worker has terminated. This one synthetic callback invocation tests
    // only the settled-event guard; it supplies no computation or fake packet.
    worker.onmessage({data: {progress: {phase: 'late', done: 1, total: 1}}}); equal(progress.length, count, 'settled callback ignores later progress');
    const entry = workerDelta(start, 1, 'exact copied columns')[0]; equal(entry.posts, 1, 'one actual request posted'); equal(entry.packets, 1, 'one actual packet received');
  });
  await test('real AbortController cancels delayed genuine SDK worker without publication', async () => {
    const start = workerResources.size, controller = new AbortController();
    const pending = runChartWorker(workerRequest(), {workerURL: workerURL('/worker-slow.js'), signal: controller.signal, timeoutMs: 10000});
    setTimeout(() => controller.abort(), 20); await rejected(pending, error => error.name === 'AbortError', 'active native worker abort');
    const entry = workerDelta(start, 1, 'active AbortController')[0]; equal(entry.posts, 1, 'abort follows native request post'); equal(entry.packets, 0, 'abort returns no packet');
  });
  await test('real native Worker timeout reports TimeoutError and terminates', async () => {
    const start = workerResources.size;
    await rejected(runChartWorker(workerRequest(), {workerURL: workerURL('/worker-slow.js'), timeoutMs: 20}), error => error.name === 'TimeoutError' && error.message === 'Calculation timeout', 'native worker timeout');
    const entry = workerDelta(start, 1, 'actual timeout')[0]; equal(entry.posts, 1, 'timeout follows native request post'); equal(entry.packets, 0, 'timed out native worker produces no packet');
  });
  await test('genuine SDK worker error packet rejects and terminates exactly once', async () => {
    const start = workerResources.size, request = workerRequest(); request.columns.high[0] = 98;
    await rejected(runChartWorker(request, {workerURL: workerURL('/worker.js'), timeoutMs: 10000}), error => error.message === 'Invalid OHLCV envelope', 'real worker calculation failure preserved');
    const entry = workerDelta(start, 1, 'actual calculation failure')[0]; equal(entry.posts, 1, 'invalid input is actually posted'); equal(entry.packets, 0, 'worker does not emit success packet');
  });
  await test('delayed real recomputation rejects stale source while preserving new committed data', async () => {
    const start = workerResources.size, m = model(bars(32)), f = mount({model: m}); await f.render(f.props); const handle = live(f), version = m.store.version;
    const pending = recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.5}}, {workerURL: workerURL('/worker-slow.js'), timeoutMs: 10000});
    handle.api.applyDataEvent({kind: 'correction', bar: {...m.store.at(4), volume: 777}});
    await rejected(pending, error => error.message === 'Data/configuration changed; stale worker result discarded', 'stale reply rejected');
    equal(m.store.version, version + 1, 'only local correction committed'); equal(m.store.at(4).volume, 777, 'new local volume preserved'); equal(m.store.at(4).close, 105, 'stale worker close not published');
    const entry = workerDelta(start, 1, 'stale real correction')[0]; equal(entry.packets, 1, 'genuine stale packet actually arrived before rejection');
    await f.unmount(); m.dispose();
  });
  await test('high-level original signal registration failure creates no Worker or late deadline rejection', async () => {
    const start = workerResources.size, unhandled = [], listener = event => unhandled.push(String(event.reason?.message ?? event.reason)); window.addEventListener('unhandledrejection', listener);
    const m = model(bars(32)), version = m.store.version, snapshot = JSON.stringify(m.store.at(4)), failures = [];
    try {
      for (const helper of ['prepare', 'recompute']) {
        const failure = new Error(`${helper} original signal registration failure`); let removed = 0;
        const signal = {aborted: false, addEventListener() {throw failure;}, removeEventListener() {removed++;}};
        const operation = helper === 'prepare' ? prepareChartModel(workerRequest(), {workerURL: workerURL('/worker.js'), signal, timeoutMs: 20})
          : recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.5}}, {workerURL: workerURL('/worker.js'), signal, timeoutMs: 20});
        await rejected(operation, error => error === failure, `${helper} original registration reason preserved`); equal(removed, 1, `${helper} attempted original listener cleanup`); failures.push(failure.message);
      }
      await new Promise(resolve => setTimeout(resolve, 50)); equal(unhandled.length, 0, 'failed registration clears deadline without late global rejection');
      equal(m.store.version, version, 'failed high-level setup does not publish'); equal(JSON.stringify(m.store.at(4)), snapshot, 'failed high-level setup leaves source unchanged'); workerDelta(start, 0, 'high-level original registration throws');
      report.highLevelSignalRegistration = {failures, unhandled};
    } finally {window.removeEventListener('unhandledrejection', listener); m.dispose();}
  });
  await test('high-level original signal removal failure preserves calculation error and rejects before publication', async () => {
    let start = workerResources.size, removals = 0; const cleanup = new Error('high-level original listener removal failure');
    const signal = {aborted: false, addEventListener() {}, removeEventListener() {removals++; throw cleanup;}};
    const invalid = workerRequest(); invalid.columns.high[0] = 98;
    await rejected(prepareChartModel(invalid, {workerURL: workerURL('/worker.js'), signal, timeoutMs: 10000}), error => error.message === 'Invalid OHLCV envelope', 'prepare calculation error wins over original removal failure');
    equal(removals, 1, 'prepare original signal removed once'); workerDelta(start, 1, 'high-level removal with worker error');
    const m = model(bars(32)), version = m.store.version, snapshot = JSON.stringify(m.store.at(4)); start = workerResources.size; removals = 0;
    try {
      await rejected(recomputeInWorker(m, {kind: 'correction', bar: {...m.store.at(4), close: 105.5}}, {workerURL: workerURL('/worker.js'), signal, timeoutMs: 10000}), error => error === cleanup, 'recompute successful computation surfaces original cleanup failure');
      equal(removals, 1, 'recompute original signal removed once'); equal(m.store.version, version, 'original removal failure precedes publication'); equal(JSON.stringify(m.store.at(4)), snapshot, 'original removal failure leaves source data atomic');
      equal(workerDelta(start, 1, 'high-level removal before publication')[0].packets, 1, 'real prepared packet arrived before removal failure');
    } finally {m.dispose();}
  });
  const allowedErrors = ['factory failure', 'Pass model or createModel, not both', 'Expected a live ChartModel', 'Canvas 2D unavailable',
    'cleanup failure', 'dispose callback failure', 'ready callback failure', 'onReady must return a synchronous cleanup function or undefined',
    'Invalid OHLCV envelope', 'DPR/error callback'];
  report.errors = report.expectedErrors.filter(message => !allowedErrors.includes(message));
  await pause(); report.resources = {canvases: document.querySelectorAll('canvas').length, resizeObservers: observers.size, raf: pendingRAF.size,
    workers: {created: workerResources.size, terminated: [...workerResources.values()].filter(entry => entry.terminated === 1).length,
      live: [...workerResources.values()].filter(entry => entry.terminated === 0).length, mock: false},
    gl: Object.fromEntries(Object.entries(glResources).map(([kind, ledger]) => [kind, {live: ledger.live.size, created: ledger.created, deleted: ledger.deleted}])),
    passed: report.tests.filter(t => t.pass).length, failed: report.tests.filter(t => !t.pass).length};
  window.requestAnimationFrame = nativeRAF; window.cancelAnimationFrame = nativeCancel; window.ResizeObserver = NativeObserver; window.Worker = NativeWorker;
  glMethods.forEach(restore => restore());
  return report;
}
globalThis.__reactQA = {run, ready: true};
