import test from 'node:test';
import assert from 'node:assert/strict';
import {hoverOptions, hoverCases, hoverPoint, distribution, heartbeatSummary, summarizePointerSamples, validateHoverCase} from '../benchmarks/hover.mjs';

test('hover harness defaults define eight isolated dense fixtures', () => {
  const options = hoverOptions(), cases = hoverCases(options);
  assert.equal(options.bars, 100000); assert.equal(options.lineSeries, 32); assert.equal(options.seed, 42);
  assert.equal(options.warmup, 20); assert.equal(options.samples, 80); assert.equal(options.heartbeatMs, 8);
  assert.equal(cases.length, 8); assert.equal(new Set(cases.map(row => JSON.stringify(row))).size, 8);
  assert.throws(() => hoverOptions({samples: 0}), RangeError);
  assert.throws(() => hoverOptions({dprs: [1, 1]}), RangeError);
  assert.throws(() => hoverOptions({renderers: ['auto']}), RangeError);
});
test('all measurement pointer points stay in the price plot and move each time', () => {
  let previous;
  for (let index = 0; index < 100; index++) {
    const point = hoverPoint(index);
    assert.ok(point.x > 12 && point.x < 1118 && point.y > 12 && point.y < 666);
    assert.notDeepEqual(point, previous); previous = point;
  }
  assert.throws(() => hoverPoint(-1), RangeError);
});
test('distributions discard nonfinite telemetry without mutating input', () => {
  const values = [9, 1, NaN, 4, Infinity], before = [...values], stats = distribution(values);
  assert.deepEqual(values, before); assert.equal(stats.count, 3); assert.equal(stats.p50, 4); assert.equal(stats.p95, 9);
  assert.equal(distribution([]).p95, null);
});
test('heartbeat includes its final unfinished interval and rejects missing final samples', () => {
  const heartbeat = {requestedIntervalMs: 8, raw: [{gapMs: 8, final: false}, {gapMs: 55, final: true}]};
  assert.equal(heartbeatSummary(heartbeat).max, 55); assert.equal(heartbeatSummary(heartbeat).finalIntervalMs, 55);
  assert.throws(() => heartbeatSummary({raw: [{gapMs: 8, final: false}]}), /final heartbeat/);
});
test('pointer summaries remove warmup and keep event latency separate from readback', () => {
  const raw = [{pointerToRenderMs: 99, readbackMs: 90, renderEventAt: 100},
    {pointerToRenderMs: 3, readbackMs: 12, renderEventAt: 117}, {pointerToRenderMs: 5, readbackMs: 20, renderEventAt: 134}];
  const summary = summarizePointerSamples(raw, 1);
  assert.equal(summary.samples, 2); assert.equal(summary.metrics.pointerToRenderMs.max, 5);
  assert.equal(summary.metrics.readbackMs.max, 20); assert.equal(summary.metrics.rafRenderIntervalsMs.p50, 17);
});
test('case verdict requires trusted pointer events, real RAF renders and released resources', () => {
  const sample = {event: {isTrusted: true, pointerType: 'mouse', buttons: 0}, raf: {timestamp: 10},
    rendererKind: 'canvas', pointerToRenderMs: 2, renderEventAt: 12, readbackEnd: 13, point: {x: 80, y: 60}, crosshair: {x: 80, y: 60}};
  const row = {conditions: {renderer: 'canvas'}, pointer: {raw: [sample], final: {unchangedView: true, errors: []}},
    cleanup: {canvases: 0, storeSubscriptions: 0, chartListeners: 0, framePending: false, modelDisposed: true,
      chartDisposed: true, liveAllocatedGLBufferBytes: 0, liveAllocatedGLTextureBytes: 0, rendererDisposed: null},
    protocolEvents: {externalRequests: [], exceptions: [], crashes: []},
    microbenchmarks: [{raw: [{}], heartbeat: {raw: [{final: true}]}}]};
  assert.equal(validateHoverCase(row, {warmup: 0, samples: 1}).status, 'pass');
  sample.event.isTrusted = false; assert.ok(validateHoverCase(row, {warmup: 0, samples: 1}).failures.includes('Real idle mouse pointer events'));
  sample.event.isTrusted = true; row.cleanup.storeSubscriptions = 1;
  assert.ok(validateHoverCase(row, {warmup: 0, samples: 1}).failures.includes('Owned cleanup'));
  row.cleanup.storeSubscriptions = 0; row.cleanup.liveAllocatedGLRenderbufferRGBAEquivalentBytes = 4096;
  assert.ok(validateHoverCase(row, {warmup: 0, samples: 1}).failures.includes('Owned cleanup'));
});
