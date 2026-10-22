import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/index.mjs';
import {sharedModelFixture, sharedModelVerdict, sharedModelCheckIds} from './shared-model-browser-fixture.mjs';
import {runSharedModelBrowser, sharedModelBrowserVerdict, sharedModelRuntimeSource} from './shared-model-browser.mjs';
import {modeledChartDOM} from './helpers/shared-model-dom.mjs';

async function runFixture({api = A, serialized = false} = {}) {
  const dom = modeledChartDOM(), descriptors = ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    const run = serialized ? Function('return (' + sharedModelFixture.toString() + ')')() : sharedModelFixture;
    const report = await run(api, {settle: dom.settle});
    for (const [key, descriptor] of descriptors) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor, key + ' restored');
    assert.equal(dom.root.children.length, 0, 'fixture host nodes removed');
    return {report, rasterCalls: dom.rasterCalls, pending: dom.frames.size, observers: dom.observers.size};
  } finally {dom.restore();}
}

test('actual shared-model/chart/group fixture passes all phases with modeled Canvas only', async () => {
  const {report, rasterCalls, pending, observers} = await runFixture();
  assert.deepEqual(report.checks.map(row => row.id), sharedModelCheckIds);
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).status, 'pass', JSON.stringify(report));
  assert.equal(report.execution, 'modeled-node'); assert.equal(report.status, 'passed');
  assert.ok(rasterCalls > 0); assert.equal(pending, 0); assert.equal(observers, 0);
  assert.equal(sharedModelVerdict(report).status, 'fail', 'modeled execution never qualifies as browser evidence');
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).actualBrowser, false);
});

test('serialized fixture has no module-closure dependency and preserves all assertions', async () => {
  const {report} = await runFixture({serialized: true});
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).status, 'pass', JSON.stringify(report));
  const source = sharedModelRuntimeSource();
  assert.match(source, /import\('\/src\/index\.mjs'\)/); assert.match(source, /execution: 'browser'/);
  assert.doesNotThrow(() => Function('return async () => {' + source + '}'));
});

async function runDefaultSettle({keepBusy = false} = {}) {
  const dom = modeledChartDOM(), observers = [];
  try {
    // Browser-order model: per-callback microtasks, then initial nonzero RO
    // delivery after the entire RAF batch. This is still not a real browser.
    globalThis.ResizeObserver = class {
      constructor(callback) {this.callback = callback; this.initial = false; this.live = true; observers.push(this);}
      observe() {this.initial = true;} unobserve() {} disconnect() {this.live = false;}
    };
    const originalRAF = globalThis.requestAnimationFrame, originalObserver = globalThis.ResizeObserver;
    let created = 0, done = false, report, failure;
    const api = {...A, createChart(...args) {const chart = A.createChart(...args);
      if (keepBusy && created++ === 0) {const draw = chart.drawNow.bind(chart); chart.drawNow = (...input) => {const result = draw(...input); chart.invalidate(); return result;};}
      return chart;}};
    sharedModelFixture(api).then(value => {report = value; done = true;}, error => {failure = error; done = true;});
    for (let frame = 0; frame < 200 && !done; frame++) {
      for (const [id, callback] of [...dom.frames]) {if (!dom.frames.delete(id)) continue; callback(frame);
        for (let i = 0; i < 5; i++) await Promise.resolve();}
      for (const observer of observers) if (observer.live && observer.initial) {observer.initial = false; observer.callback([]);}
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    assert.equal(done, true, 'default settle finishes within bounded modeled pump');
    if (failure) throw failure;
    assert.equal(globalThis.requestAnimationFrame, originalRAF); assert.equal(globalThis.ResizeObserver, originalObserver);
    assert.equal(dom.frames.size, 0); assert.equal(observers.filter(observer => observer.live).length, 0);
    return report;
  } finally {dom.restore();}
}
test('default settle waits for initial ResizeObserver redraws with per-callback microtasks', async () => {
  const report = await runDefaultSettle();
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).status, 'pass', JSON.stringify(report));
});
test('default settle fails after bounded nonquiescent frames and still cleans ownership', async () => {
  const report = await runDefaultSettle({keepBusy: true});
  assert.equal(report.status, 'failed'); assert.match(report.errors.join(';'), /within 20 frame fences/);
  assert.equal(report.cleanup.frames, 0); assert.equal(report.cleanup.observers, 0);
  assert.deepEqual(report.cleanup.subscriptions, [0, 0]);
});

// Actual-model negative controls alter only per-test instances/dependencies.
// They prove that the fixture rejects broken behavior, not just report text.
const faults = [
  ['stale shared sibling frame', 'update.current', (chart, index) => {if (index === 1) {
    const draw = chart.drawNow.bind(chart), initialVersion = chart.model.store.version;
    chart.drawNow = (...args) => chart.model.store.version === initialVersion ? draw(...args) : chart.lastScene?.stats;
  }}],
  ['corrupted correction data', 'update.correction', (chart, index) => {if (index === 0) {
    const apply = chart.api.applyDataEvent.bind(chart.api);
    chart.api.applyDataEvent = event => apply(event.kind === 'correction' ? {...event, bar: {...event.bar, volume: event.bar.volume + 1}} : event);
  }}],
  ['detaching chart disposes shared model', 'detach.ownership', (chart, index) => {if (index === 0) {
    const destroy = chart.destroy.bind(chart); chart.destroy = () => destroy({disposeModel: true});
  }}],
  ['retired raster pixels survive', 'detach.ownership', (chart, index) => {if (index === 0) {
    const destroy = chart.destroy.bind(chart); chart.destroy = () => {destroy(); chart.canvas.width = chart.canvas.height = 10;};
  }}],
  ['detaching sibling cancels foreign drawing', 'ownership.preserved', (chart, index) => {if (index === 1) {
    const destroy = chart.destroy.bind(chart); chart.destroy = () => {chart.controller.cancel(); destroy();};
  }}],
  ['replacement never renders current state', 'recreate.range', (chart, index) => {if (index === 3) chart.drawNow = () => {}; }]
];
for (const [label, assertion, mutate] of faults) test('negative control: ' + label, async () => {
  let created = 0;
  const api = {...A, createChart(...args) {const chart = A.createChart(...args); mutate(chart, created++); return chart;}};
  const {report} = await runFixture({api});
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some(check => check.id === assertion && check.passed === false), JSON.stringify(report));
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).status, 'fail');
});

test('negative control: omitted range publication fails forward synchronization', async () => {
  class BrokenGroup extends A.TimeRangeGroup {syncFrom() {return {published: false};}}
  const {report} = await runFixture({api: {...A, TimeRangeGroup: BrokenGroup}});
  assert.ok(report.checks.some(row => row.id === 'range.forward' && row.passed === false), JSON.stringify(report));
  assert.equal(sharedModelVerdict(report, {requireBrowser: false}).status, 'fail');
});

// This copy is SYNTHETIC browser-shaped input for validator/runner tests. It
// must never be saved or advertised as measured browser output.
async function syntheticBrowserFixture() {const {report} = await runFixture(); report.execution = 'browser'; return report;}
const accepts = report => sharedModelVerdict(report).status === 'pass';

test('complete synthetic browser-shaped report validates; malformed roots do not', async () => {
  assert.equal(accepts(await syntheticBrowserFixture()), true);
  for (const report of [undefined, null, {}, [], {status: 'passed'}, {execution: 'browser'}]) assert.equal(accepts(report), false);
});
for (const id of sharedModelCheckIds) test('report rejects missing or false required assertion ' + id, async () => {
  const report = await syntheticBrowserFixture(), index = report.checks.findIndex(row => row.id === id);
  report.checks[index].passed = false; assert.equal(accepts(report), false);
  report.checks.splice(index, 1); assert.equal(accepts(report), false);
});
test('report rejects duplicate, reordered, truthy and unexpected assertions', async () => {
  for (const mutate of [r => r.checks.push(r.checks[0]), r => r.checks.reverse(), r => r.checks[0].passed = 1,
    r => r.checks[0].id = 'unrelated', r => r.errors = ['error'], r => delete r.errors, r => delete r.cleanup,
    r => r.execution = 'unrun', r => r.status = 'running', r => r.schema = 'unknown']) {
    const report = await syntheticBrowserFixture(); mutate(report); assert.equal(accepts(report), false);
  }
});
for (const key of ['frames', 'observers', 'observedTargets', 'canvases', 'cacheEntries', 'cacheBytes', 'groups'])
  test('cleanup requires own numeric zero: ' + key, async () => {
    const report = await syntheticBrowserFixture();
    for (const value of [1, -1, '0', null, NaN, undefined]) {report.cleanup[key] = value; assert.equal(accepts(report), false);}
    delete report.cleanup[key]; Object.setPrototypeOf(report.cleanup, {[key]: 0}); assert.equal(accepts(report), false);
  });
for (const key of ['disposed', 'frame', 'listeners', 'pixels', 'attached', 'scene', 'timeLayout', 'layers', 'cache', 'metrics', 'timings', 'pointers', 'gesture', 'reserved'])
  test('retained destroyed-chart evidence cannot omit ' + key, async () => {
    const report = await syntheticBrowserFixture(); delete report.cleanup.retired[0][key]; assert.equal(accepts(report), false);
  });
test('cleanup rejects truncated/extra retained charts or incorrect model ownership', async () => {
  for (const mutate of [r => r.cleanup.retired.pop(), r => r.cleanup.retired.push(r.cleanup.retired[0]), r => r.cleanup.subscriptions.pop(),
    r => r.cleanup.subscriptions[0] = 1, r => r.cleanup.modelsDisposed[0] = false, r => r.cleanup.modelsDisposed = []]) {
    const report = await syntheticBrowserFixture(); mutate(report); assert.equal(accepts(report), false);
  }
});

async function fakeRunner({failure = null, protocol = null, fixture = null} = {}) {
  const calls = [], listeners = new Map(), browser = {sessionId: 'owned',
    on(name, fn) {listeners.set(name, fn);},
    async send(name) {calls.push(name); if (failure === 'send') throw Error('send failed');},
    async navigate() {calls.push('navigate'); if (failure === 'navigate') throw Error('navigate failed');},
    async evaluate() {calls.push('evaluate'); if (failure === 'evaluate') throw Error('evaluate failed');
      if (protocol) listeners.get(protocol.name)(protocol.event, {sessionId: protocol.session ?? 'owned'});
      return fixture ?? await syntheticBrowserFixture();},
    async close() {calls.push('browser.close'); if (failure === 'browser.close') throw Error('close failed');
      return {terminationConfirmed: failure !== 'browser.unconfirmed', profileRemoved: true};}}
  const report = await runSharedModelBrowser({output: null}, {
    async startFixtureServer(root, source) {calls.push('server.start'); assert.ok(root.endsWith('/')); assert.match(source, /__sharedModelResult/);
      if (failure === 'server.start') throw Error('server failed');
      return {origin: 'http://127.0.0.1:12345', async close() {calls.push('server.close'); if (failure === 'server.close') throw Error('server close failed');}};},
    async launchBrowser(options) {calls.push('browser.launch'); assert.equal(options.timeoutMs, 15000);
      if (failure === 'browser.launch') throw Error('launch failed'); return browser;}
  });
  return {report, calls};
}
test('runner lifecycle succeeds only with complete fixture/protocol/cleanup evidence (fake transport)', async () => {
  const {report, calls} = await fakeRunner(); assert.equal(report.verdict.status, 'pass', JSON.stringify(report));
  assert.deepEqual(calls, ['server.start', 'browser.launch', 'Network.enable', 'Inspector.enable', 'navigate', 'evaluate', 'browser.close', 'server.close']);
  assert.match(report.fixtureSHA256, /^[0-9a-f]{64}$/);
});
for (const failure of ['server.start', 'browser.launch', 'send', 'navigate', 'evaluate', 'browser.close', 'browser.unconfirmed', 'server.close'])
  test('runner fails closed and cleans all acquired resources after ' + failure, async () => {
    const {report, calls} = await fakeRunner({failure}); assert.equal(report.verdict.status, 'fail', JSON.stringify(report));
    if (failure !== 'server.start') assert.equal(calls.at(-1), 'server.close');
    if (!['server.start', 'browser.launch'].includes(failure)) assert.equal(calls.filter(name => name === 'browser.close').length, 1);
  });
for (const [name, event] of [['Runtime.exceptionThrown', {exceptionDetails: {text: 'bad'}}], ['Inspector.targetCrashed', {}],
  ['Runtime.consoleAPICalled', {type: 'error'}], ['Network.requestWillBeSent', {request: {url: 'https://external.invalid/data'}}]])
  test('runner cannot pass after ' + name, async () => {
    const {report} = await fakeRunner({protocol: {name, event}}); assert.equal(report.verdict.status, 'fail');
  });
test('unrelated session events do not taint owned target; malformed protocol evidence fails', async () => {
  const {report} = await fakeRunner({protocol: {name: 'Runtime.exceptionThrown', event: {}, session: 'unrelated'}});
  assert.equal(report.verdict.status, 'pass');
  for (const key of Object.keys(report.protocol)) {const copy = structuredClone(report); delete copy.protocol[key]; assert.equal(sharedModelBrowserVerdict(copy).status, 'fail');}
  assert.equal(sharedModelBrowserVerdict(null).status, 'fail');
});
test('runner never promotes a modeled fixture to browser qualification', async () => {
  const {report: fixture} = await runFixture(), {report} = await fakeRunner({fixture});
  assert.equal(report.verdict.status, 'fail'); assert.equal(report.verdict.actualBrowser, false);
});
