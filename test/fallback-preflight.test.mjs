import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/customization-dom.mjs';

function liveState(chart, model, frames) {
  return {
    canvas: chart.canvas,
    renderer: chart.renderer,
    listeners: chart.listeners.slice(),
    frame: chart.frame,
    frames: [...frames],
    transaction: model.drawings.transaction,
    items: model.drawings.items,
    fallbackReason: chart.fallbackReason,
  };
}

function assertUnchanged(chart, model, frames, before) {
  assert.equal(chart.canvas, before.canvas);
  assert.equal(chart.renderer, before.renderer);
  assert.deepEqual(chart.listeners, before.listeners);
  assert.equal(chart.frame, before.frame);
  assert.deepEqual([...frames], before.frames);
  assert.equal(model.drawings.transaction, before.transaction);
  assert.equal(model.drawings.items, before.items);
  assert.equal(chart.fallbackReason, before.fallbackReason);
}

const listenerCount = node => [...node.events.values()].reduce((count, listeners) => count + listeners.size, 0);

for (const failure of ['null', 'throw']) test(`failed ${failure} fallback preflight leaves live state and drawing journal untouched`, t => {
    const f = fixture(t), errors = [], {chart, model} = f.create({
      interactive: true,
      onError: error => errors.push(error),
      rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
    });
    chart.controller.setTool('horizontal');
    chart.controller.down(1, 100, 100);
    const old = chart.canvas, originalClone = old.cloneNode.bind(old);
    let staged;
    old.cloneNode = () => {
      const replacement = staged = originalClone();
      replacement.width = 300;
      replacement.height = 150;
      replacement.getContext = () => {
        if (failure === 'throw') throw Error('staged context failure');
        return null;
      };
      return replacement;
    };
    const before = liveState(chart, model, f.frames);
    assert.throws(() => chart.fallback(`preflight ${failure}`), failure === 'throw' ? /staged context failure/ : /Canvas fallback unavailable/);
    assertUnchanged(chart, model, f.frames, before);
    assert.equal(chart.container.children[0], old);
    assert.equal(chart.controller.pointers.size, 1);
    assert.deepEqual(errors, []);
    assert.equal(staged.isConnected, false);
    assert.equal(staged.width, 0);
    assert.equal(staged.height, 0);
    assert.equal(listenerCount(staged), 0);
});

test('fallback retries after a staged context becomes available', t => {
  const f = fixture(t), {chart} = f.create({rendererFactory: () => ({kind: 'test', render() {}, dispose() {}})});
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let attempts = 0;
  old.cloneNode = () => {
    const replacement = originalClone();
    replacement.getContext = () => ++attempts === 1 ? null : {};
    return replacement;
  };
  assert.throws(() => chart.fallback('first attempt'), /Canvas fallback unavailable/);
  assert.equal(chart.canvas, old);
  chart.fallback('retry');
  assert.notEqual(chart.canvas, old);
  assert.equal(chart.rendererKind, 'canvas');
  assert.equal(chart.fallbackReason, 'retry');
  assert.equal(attempts, 2);
});

test('destroy during staged fallback cannot resurrect the chart', t => {
  const f = fixture(t), renderer = {kind: 'test', render() {}, dispose() {this.disposed = true;}}, {chart} = f.create({rendererFactory: () => renderer});
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let staged;
  old.cloneNode = () => {
    const replacement = staged = originalClone();
    replacement.width = 300;
    replacement.height = 150;
    replacement.getContext = () => {
      chart.destroy();
      return null;
    };
    return replacement;
  };
  chart.fallback('destroy while staging');
  assert.equal(chart.disposed, true);
  assert.equal(chart.canvas, old);
  assert.equal(chart.canvas.isConnected, false);
  assert.equal(renderer.disposed, true);
  assert.equal(staged.isConnected, false);
  assert.equal(staged.width, 0);
  assert.equal(staged.height, 0);
  assert.equal(listenerCount(staged), 0);
});

test('nested staged fallback owns the newest replacement', t => {
  const f = fixture(t), reasons = [], {chart} = f.create({
    onFallback: reason => reasons.push(reason),
    rendererFactory: () => ({kind: 'test', render() {}, dispose() {}}),
  });
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let stages = 0;
  old.cloneNode = () => {
    const replacement = originalClone();
    if (++stages === 1) chart.fallback('inner');
    replacement.getContext = () => ({});
    return replacement;
  };
  chart.fallback('outer');
  assert.equal(stages, 2);
  assert.equal(chart.canvas.isConnected, true);
  assert.notEqual(chart.canvas, old);
  assert.equal(chart.rendererKind, 'canvas');
  assert.equal(chart.fallbackReason, 'inner');
  assert.deepEqual(reasons, ['inner']);
});

test('destroy from the removed canvas hook cannot reconnect the staged replacement', t => {
  const f = fixture(t), renderer = {kind: 'test', render() {}, dispose() {this.disposed = true;}}, {chart, model, container} = f.create({
    rendererFactory: () => renderer,
  });
  chart.controller.setTool('horizontal');
  chart.controller.down(1, 100, 100);
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let replacement;
  old.cloneNode = () => replacement = originalClone();
  old.onRemove = () => {
    old.onRemove = null;
    chart.destroy();
  };

  chart.fallback('destroy during DOM swap');

  assert.equal(chart.disposed, true);
  assert.equal(container.children.length, 0);
  assert.equal(replacement.isConnected, false);
  assert.equal(replacement.width, 0);
  assert.equal(replacement.height, 0);
  assert.equal(listenerCount(replacement), 0);
  assert.equal(listenerCount(old), 0);
  assert.equal(model.drawings.transaction, null);
  assert.equal(f.frames.size, 0);
  assert.equal(renderer.disposed, true);
});

test('nested fallback from the removed canvas hook keeps only the newest owned canvas connected', t => {
  const f = fixture(t), reasons = [], renderer = {kind: 'test', render() {}, dispose() {this.disposals = (this.disposals ?? 0) + 1;}}, {chart, container} = f.create({
    onFallback: reason => reasons.push(reason),
    rendererFactory: () => renderer,
  });
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let outer, inner;
  old.cloneNode = () => {
    outer = originalClone();
    const outerClone = outer.cloneNode.bind(outer);
    outer.cloneNode = () => inner = outerClone();
    return outer;
  };
  old.onRemove = () => {
    old.onRemove = null;
    chart.fallback('inner');
  };

  chart.fallback('outer');

  assert.equal(chart.canvas, inner);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], inner);
  assert.equal(inner.isConnected, true);
  assert.equal(outer.isConnected, false);
  assert.equal(outer.width, 0);
  assert.equal(outer.height, 0);
  assert.equal(listenerCount(outer), 0);
  assert.ok(listenerCount(inner) > 0);
  assert.equal(renderer.disposals, 1);
  assert.equal(chart.fallbackReason, 'inner');
  assert.deepEqual(reasons, ['inner']);
});

test('removed canvas hook can retarget the published replacement without a late DOM move', t => {
  const f = fixture(t), {chart, container} = f.create({rendererFactory: () => ({kind: 'test', render() {}, dispose() {}})}), target = f.node();
  const old = chart.canvas;
  old.onRemove = () => {
    old.onRemove = null;
    target.append(chart.canvas);
  };

  chart.fallback('retarget replacement');

  assert.equal(container.children.length, 0);
  assert.equal(target.children.length, 1);
  assert.equal(target.children[0], chart.canvas);
  assert.equal(chart.canvas.isConnected, true);
  assert.equal(chart.rendererKind, 'canvas');
  assert.equal(chart.fallbackReason, 'retarget replacement');
});

test('removed canvas hook can retarget the public chart without leaking its obsolete staged canvas', t => {
  const f = fixture(t), {chart, container} = f.create({rendererFactory: () => ({kind: 'test', render() {}, dispose() {}})}), foreign = f.create().chart.canvas;
  const old = chart.canvas, originalClone = old.cloneNode.bind(old);
  let replacement;
  old.cloneNode = () => replacement = originalClone();
  old.onRemove = () => {
    old.onRemove = null;
    chart.canvas = foreign;
  };

  chart.fallback('retarget chart');

  assert.equal(chart.canvas, foreign);
  assert.equal(foreign.isConnected, true);
  assert.equal(container.children.length, 0);
  assert.equal(replacement.isConnected, false);
  assert.equal(replacement.width, 0);
  assert.equal(replacement.height, 0);
  assert.equal(listenerCount(replacement), 0);
  assert.throws(() => chart.fallback('stale retry'), /owner changed/i);
});
