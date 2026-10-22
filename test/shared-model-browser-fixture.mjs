// Serialized by shared-model-browser.mjs; keep this function self-contained.
// Node contract tests run the same SDK paths with a modeled DOM/Canvas/RAF.
// Only the explicit browser runner can establish actual browser execution.
export async function sharedModelFixture(A, {execution = 'modeled-node', settle = null} = {}) {
  const checks = [], errors = [], charts = [], hosts = [], models = [];
  const report = {schema: 'barochart-shared-model-v1', execution, status: 'running', checks, errors, cleanup: null};
  const check = (id, value) => {checks.push({id, passed: !!value}); if (!value) throw new Error('Shared-model assertion: ' + id);};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fields = ['time', 'open', 'high', 'low', 'close', 'volume'];
  const rows = Array.from({length: 64}, (_, i) => ({time: 1700000000000 + i * 60000,
    open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4, volume: 100 + i}));
  const oracle = rows.map(row => ({...row})), independent = rows.map(row => ({...row}));
  const originals = ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const nativeRAF = globalThis.requestAnimationFrame.bind(globalThis), nativeCancel = globalThis.cancelAnimationFrame.bind(globalThis);
  const NativeObserver = globalThis.ResizeObserver, frames = new Set(), observers = new Map();
  const budget = new A.LayerCacheBudget(16 * 1024 * 1024);
  let group, shared, linked, baseline;
  const pending = () => ({frames: frames.size, observers: observers.size,
    observedTargets: [...observers.values()].reduce((n, targets) => n + targets.size, 0),
    canvases: hosts.reduce((n, host) => n + host.querySelectorAll('canvas').length, 0),
    cacheEntries: budget.entries.size, cacheBytes: budget.usedBytes});
  const retired = chart => ({disposed: chart.disposed, frame: chart.frame, listeners: chart.listeners.length,
    pixels: chart.canvas.width * chart.canvas.height * 4, attached: !!chart.canvas.parentNode,
    scene: !!chart.lastScene, timeLayout: !!chart.timeLayout, layers: !!chart.layerSurfaces,
    cache: !!chart.sceneCache.base || !!chart.sceneCache.state || !!chart.sceneCache.items || !!chart.sceneCache.drawingCommands,
    metrics: !!chart.renderMetrics, timings: chart.timings.length, pointers: chart.controller.pointers.size,
    gesture: !!chart.controller.gesture, reserved: budget.entries.has(chart)});
  const isRetired = chart => {const r = retired(chart); return r.disposed === true && r.frame === null &&
    Object.entries(r).every(([key, value]) => ['disposed', 'frame'].includes(key) || value === 0 || value === false);};
  const sourceMatches = (model, expected) => model.store.length === expected.length && expected.every((row, i) => fields.every(key => Object.is(model.store.at(i)[key], row[key])));
  const sceneMatches = chart => {
    const m = chart.model, binding = chart.timeLayout, scene = chart.lastScene;
    // A current model alone is insufficient: observe the last completed frame.
    return !chart.disposed && chart.lastError === null && scene?.stats.storedBars === m.store.length &&
      binding?.store === m.store && binding.version === m.store.version && binding.from === m.view.from && binding.to === m.view.to &&
      same(scene.commands, A.buildScene(m, chart.size().width, chart.size().height).commands);
  };
  // ResizeObserver's initial delivery follows RAF. A fixed double-RAF fence
  // can resolve before redraws enqueued by that delivery in the next frame.
  // Require two consecutive idle frame fences, with a bounded failure path.
  const pause = settle ?? (async () => {
    let idle = 0;
    for (let turn = 0; turn < 20; turn++) {
      await new Promise(resolve => nativeRAF(resolve));
      idle = frames.size === 0 ? idle + 1 : 0;
      if (idle === 2) return;
    }
    throw new Error('Shared-model frames did not quiesce within 20 frame fences');
  });
  const makeModel = data => {const model = new A.ChartModel({store: new A.BarStore(data)}); models.push(model);
    model.addSeries({id: 'price', type: 'candles', panel: 'price'}); model.indicators.add('ema', 'ema', {period: 5});
    model.addSeries({id: 'ema', type: 'line', panel: 'price', indicator: 'ema'}); model.fit(); return model;};
  const makeChart = model => {const host = document.createElement('section'); host.style.cssText = 'width:640px;height:280px';
    document.getElementById('root').append(host); hosts.push(host);
    const chart = A.createChart(host, model, {renderer: 'canvas', dpr: () => 1, rasterCaching: 'always', cacheBudget: budget,
      onError: error => errors.push(String(error?.message ?? error))}); charts.push(chart); return chart;};
  const verify = async (id, active) => {await pause(); check(id, sourceMatches(shared, oracle) && sourceMatches(linked, independent) && active.every(sceneMatches));};
  const apply = (chart, kind, index, changes) => {const bar = {...oracle[index], ...changes};
    chart.api.applyDataEvent({kind, bar}); if (kind === 'append') oracle.push(bar); else oracle[index] = bar;};
  const cleanup = async () => {
    const failures = [];
    for (const chart of charts) try {chart.destroy();} catch (e) {failures.push('chart: ' + e.message);}
    try {group?.dispose();} catch (e) {failures.push('group: ' + e.message);}
    for (const model of models) try {model.dispose();} catch (e) {failures.push('model: ' + e.message);}
    for (const host of hosts) host.remove();
    try {await pause();} catch (e) {failures.push('settle: ' + e.message);}
    errors.push(...failures);
    report.cleanup = {...pending(), groups: group?.size ?? 0, subscriptions: models.map(m => m.store.listeners.size),
      modelsDisposed: models.map(m => m.disposed === true), retired: charts.map(retired)};
  };
  try {
    globalThis.requestAnimationFrame = callback => {let id; id = nativeRAF(time => {frames.delete(id); callback(time);}); frames.add(id); return id;};
    globalThis.cancelAnimationFrame = id => {frames.delete(id); return nativeCancel(id);};
    globalThis.ResizeObserver = class extends NativeObserver {
      constructor(callback) {super(callback); observers.set(this, new Set());}
      observe(target, options) {super.observe(target, options); observers.get(this).add(target);}
      unobserve(target) {super.unobserve(target); observers.get(this)?.delete(target);}
      disconnect() {super.disconnect(); observers.delete(this);}
    };
    shared = makeModel(rows); linked = makeModel(independent); baseline = models.map(m => m.store.listeners.size);
    const a = makeChart(shared), b = makeChart(shared), c = makeChart(linked);
    group = new A.TimeRangeGroup({mode: 'view', missing: 'clip'});
    group.add(a, {publish: true, receive: true}); group.add(c, {publish: true, receive: true});
    check('setup.identities', a.model === b.model && a.model !== c.model && a.canvas !== b.canvas && a.sceneCache !== b.sceneCache);
    check('setup.listeners', shared.store.listeners.size === baseline[0] + 2 && linked.store.listeners.size === baseline[1] + 1 && group.size === 2);
    await verify('setup.scenes', [a, b, c]);
    check('setup.raster', charts.every(chart => chart.rendererKind === 'canvas' && chart.renderMetrics?.cacheMode === 'raster' && chart.renderMetrics.cachedPixelBytes > 0 && budget.entries.has(chart)));
    check('setup.resources', same(pending(), {frames: 0, observers: 3, observedTargets: 3, canvases: 3, cacheEntries: 3, cacheBytes: 3 * 640 * 280 * 8}));

    apply(a, 'update', 63, {close: 116.5, volume: 900}); await verify('update.current', [a, b, c]);
    apply(b, 'append', 63, {time: oracle[63].time + 60000, close: 117, high: 118}); await verify('update.append', [a, b, c]);
    apply(a, 'correction', 12, {close: 104.5, volume: 700}); await verify('update.correction', [a, b, c]);

    // TimeRangeGroup accepts one representative per model. Shared-model views
    // are the same object; API view changes need an explicit sibling redraw.
    a.api.setVisibleRange(8.5, 40.5); b.invalidate(); await pause();
    check('range.forward', same(shared.view, {from: 8.5, to: 40.5}) && same(linked.view, shared.view) &&
      group.status(c)?.applied === true && group.status(c).stale === false && [a, b, c].every(sceneMatches));
    c.api.setVisibleRange(18.5, 50.5); b.invalidate(); await pause();
    check('range.reverse', same(shared.view, {from: 18.5, to: 50.5}) && same(linked.view, shared.view) &&
      group.status(a)?.applied === true && group.status(a).stale === false && [a, b, c].every(sceneMatches));

    apply(b, 'update', 64, {volume: 901});
    check('detach.pending', a.frame !== null && b.frame !== null);
    a.destroy(); a.destroy();
    check('detach.ownership', isRetired(a) && !shared.disposed && !b.disposed && b.frame !== null &&
      shared.store.listeners.size === baseline[0] + 1 && group.size === 1 && budget.entries.has(b) &&
      pending().frames === 1 && pending().observers === 2 && pending().cacheEntries === 2);
    await verify('detach.survivor', [b, c]);
    const replacement = makeChart(shared); group.add(replacement, {publish: true, receive: true}); await pause();
    check('recreate.identity', replacement !== a && replacement.canvas !== a.canvas && replacement.model === b.model && isRetired(a));
    check('recreate.listeners', shared.store.listeners.size === baseline[0] + 2 && group.size === 2 && pending().observers === 3 && pending().canvases === 3);
    replacement.api.setVisibleRange(4.5, 30.5); b.invalidate(); await pause();
    check('recreate.range', same(shared.view, {from: 4.5, to: 30.5}) && same(linked.view, shared.view) &&
      group.status(c)?.applied === true && group.status(c).stale === false && [replacement, b, c].every(sceneMatches));
    apply(replacement, 'correction', 20, {close: 106.5, volume: 777}); await verify('recreate.update', [replacement, b, c]);

    replacement.api.setTool('trendline'); replacement.controller.down(71, 100, 80); replacement.controller.move(71, 200, 140);
    const transaction = shared.drawings.transaction;
    check('ownership.started', !!transaction && replacement.controller.gesture?.kind === 'create');
    b.destroy();
    check('ownership.preserved', shared.drawings.transaction === transaction && isRetired(b) && !shared.disposed &&
      shared.store.listeners.size === baseline[0] + 1 && replacement.controller.gesture?.kind === 'create');
    replacement.controller.up(71); await pause();
    check('ownership.committed', shared.drawings.transaction === null && shared.drawings.items.length === 1 &&
      shared.drawings.undoStack.length === 1 && sceneMatches(replacement));

    replacement.invalidate(); c.invalidate(); replacement.destroy(); c.destroy(); await pause();
    check('teardown.charts', charts.every(isRetired) && group.size === 0 && models.every((m, i) => !m.disposed && m.store.listeners.size === baseline[i]) &&
      Object.values(pending()).every(value => value === 0));
    shared.dispose(); linked.dispose(); shared.dispose(); linked.dispose();
    check('teardown.models', models.every(m => m.disposed === true && m.store.listeners.size === 0));
    check('teardown.diagnostics', errors.length === 0 && group.diagnostics.length === 0);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; errors.push(String(error?.message ?? error));
  } finally {
    try {await cleanup();} finally {
      for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
  if (errors.length) report.status = 'failed';
  return report;
}

export const sharedModelCheckIds = Object.freeze([
  'setup.identities', 'setup.listeners', 'setup.scenes', 'setup.raster', 'setup.resources',
  'update.current', 'update.append', 'update.correction', 'range.forward', 'range.reverse',
  'detach.pending', 'detach.ownership', 'detach.survivor', 'recreate.identity', 'recreate.listeners',
  'recreate.range', 'recreate.update', 'ownership.started', 'ownership.preserved', 'ownership.committed',
  'teardown.charts', 'teardown.models', 'teardown.diagnostics'
]);

// Strict evidence validation: missing fields, omitted phases and modeled runs
// cannot silently qualify as browser evidence.
export function sharedModelVerdict(report, {requireBrowser = true} = {}) {
  const errors = [], fail = (ok, message) => {if (!ok) errors.push(message);};
  fail(report?.schema === 'barochart-shared-model-v1', 'Missing or unsupported schema');
  fail(report?.status === 'passed', 'Fixture did not pass');
  fail(requireBrowser ? report?.execution === 'browser' : ['browser', 'modeled-node'].includes(report?.execution), 'Execution scope does not qualify');
  fail(Array.isArray(report?.errors) && report.errors.length === 0, 'Runtime errors missing or nonzero');
  fail(Array.isArray(report?.checks) && report.checks.length === sharedModelCheckIds.length &&
    sharedModelCheckIds.every((id, i) => report.checks[i]?.id === id && report.checks[i]?.passed === true), 'Required assertion sequence incomplete or failed');
  const cleanup = report?.cleanup;
  for (const key of ['frames', 'observers', 'observedTargets', 'canvases', 'cacheEntries', 'cacheBytes', 'groups'])
    fail(cleanup != null && Object.hasOwn(cleanup, key) && cleanup[key] === 0, 'Cleanup ' + key + ' missing or nonzero');
  for (const [key, expected] of [['subscriptions', 0], ['modelsDisposed', true]])
    fail(Array.isArray(cleanup?.[key]) && cleanup[key].length === 2 && cleanup[key].every(value => value === expected), 'Model ' + key + ' incomplete');
  const zero = ['listeners', 'pixels', 'timings', 'pointers'], absent = ['attached', 'scene', 'timeLayout', 'layers', 'cache', 'metrics', 'gesture', 'reserved'];
  fail(Array.isArray(cleanup?.retired) && cleanup.retired.length === 4 && cleanup.retired.every(row => row?.disposed === true && row.frame === null &&
    zero.every(key => row[key] === 0) && absent.every(key => row[key] === false)), 'Retired chart ownership incomplete');
  return {status: errors.length ? 'fail' : 'pass', errors, actualBrowser: errors.length === 0 && report.execution === 'browser',
    scope: 'Bounded Canvas API/range/lifecycle correctness only. No trusted-input, pixel comparison, GPU, heap-leak, endurance or FPS claim.'};
}
