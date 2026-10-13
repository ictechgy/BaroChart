import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';

// Node-only callback/ownership coverage. EventTarget dispatches synchronously;
// the deterministic RAF queue and renderer do not claim browser/pixel coverage.
function fixture(t, options = {}) {
  const keys = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const frames = new Map(), calls = [];
  let serial = 0;
  class Canvas extends EventTarget {
    constructor() {super(); this.style = {}; this.width = 0; this.height = 0;}
    setAttribute() {}
    remove() {this.removed = true;}
  }
  const globals = {
    document: {createElement: () => new Canvas()},
    requestAnimationFrame: callback => {const id = ++serial; frames.set(id, callback); return id;},
    cancelAnimationFrame: id => frames.delete(id),
  };
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: globals[key],
  });
  const model = new ChartModel(), modelListenerCount = model.store.listeners.size;
  const renderer = {
    kind: 'test',
    render() {calls.push('render');},
    dispose() {calls.push('dispose');},
  };
  const chart = new CanvasChart({append() {}, clientWidth: 400, clientHeight: 240}, model, {
    dpr: () => 1, interactive: false, observeResize: false, layerCaching: false,
    rendererFactory: () => renderer, ...options,
  });
  t.after(() => {
    try {chart.destroy(); model.dispose();}
    finally {
      frames.clear();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  return {
    chart, model, frames, calls, modelListenerCount,
    get scheduled() {return serial;},
    flush() {
      const entry = frames.entries().next();
      assert.equal(entry.done, false, 'Expected a pending frame');
      const [id, callback] = entry.value;
      frames.delete(id);
      callback(0);
    },
  };
}

function assertReleased(f, disposeModel) {
  assert.equal(f.chart.disposed, true);
  assert.equal(Boolean(f.model.disposed), disposeModel);
  assert.equal(f.model.store.listeners.size, disposeModel ? 0 : f.modelListenerCount);
  assert.equal(f.chart.frame, null);
  assert.equal(f.frames.size, 0);
  assert.equal(f.chart.canvas.removed, true);
  assert.equal(f.chart.canvas.width, 0);
  assert.equal(f.chart.canvas.height, 0);
  assert.equal(f.chart.lastScene, null);
  assert.equal(f.chart.renderMetrics, null);
  assert.equal(f.chart.timings.length, 0);
  assert.equal(f.calls.filter(call => call === 'dispose').length, 1);
}

for (const pending of [true, false]) for (const disposeModel of [true, false]) {
  test(`state observer teardown leaves no RAF: pending=${pending}, disposeModel=${disposeModel}`, t => {
    const f = fixture(t);
    if (!pending) f.flush();
    const scheduled = f.scheduled;
    f.chart.canvas.addEventListener('aster:state', () => f.chart.destroy({disposeModel}), {once: true});
    f.chart.api.setVisibleRange(0, 20);
    assertReleased(f, disposeModel);
    assert.equal(f.scheduled, scheduled, 'Teardown must not be followed by a new frame');
    f.chart.destroy();
    f.chart.resize();
    assertReleased(f, disposeModel);
  });
}

test('guarded state observer reentry still schedules exactly one frame', t => {
  const f = fixture(t);
  f.flush();
  const scheduled = f.scheduled;
  let states = 0;
  f.chart.canvas.addEventListener('aster:state', () => {
    if (states++ === 0) f.chart.api.pan(1);
  });
  f.chart.api.pan(1);
  assert.equal(states, 2);
  assert.equal(f.frames.size, 1);
  assert.equal(f.scheduled, scheduled + 1);
  f.flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.chart.frame, null);
  assert.equal(f.calls.filter(call => call === 'render').length, 2);
});

test('render observer teardown leaves renderer state fully released', t => {
  const f = fixture(t);
  f.chart.canvas.addEventListener('aster:render', () => f.chart.destroy({disposeModel: true}), {once: true});
  f.flush();
  assertReleased(f, true);
  assert.deepEqual(f.calls, ['render', 'dispose']);
});

for (const scheduled of [true, false]) {
  test(`DPR callback teardown cannot render or recreate released state: scheduled=${scheduled}`, t => {
    const f = fixture(t, {dpr: () => {f.chart.destroy({disposeModel: true}); return 1;}});
    let renderEvents = 0;
    f.chart.canvas.addEventListener('aster:render', () => renderEvents++);
    if (scheduled) f.flush();
    else f.chart.drawNow();
    assert.deepEqual(f.calls, ['dispose']);
    assert.equal(renderEvents, 0);
    assertReleased(f, true);
  });
}
