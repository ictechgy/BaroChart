import test from 'node:test';
import assert from 'node:assert/strict';
import {runStreamingLifecycle} from '../benchmarks/streaming-lifecycle.mjs';
for (const shared of [false, true]) for (const seed of [42, 2026]) {
 test(`queued streaming and chart/model remount composition: shared=${shared}, seed=${seed}`, t => {
  const result = runStreamingLifecycle({charts:4, shared, rounds:256, seed});
  assert.equal(result.chartsCreated, result.chartsDestroyed);
  assert.equal(result.modelsCreated, result.modelsDisposed);
  assert.equal(result.accepted, result.applied + result.cancelled);
  assert.equal(result.cacheReuseChecks, 64);
  assert(result.renders > 100 && result.ringWraps > 20 && result.pendingRestores > 0);
  t.diagnostic(JSON.stringify(result));
 });
}
test('streaming lifecycle rejects unbounded configurations before global mutation', () => {
 const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
 for (const options of [{charts:0}, {charts:9}, {rounds:127}, {rounds:8193}, {shared:'yes'}, {seed:-1}]) assert.throws(() => runStreamingLifecycle(options));
 assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), before);
});
