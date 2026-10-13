import test from 'node:test';
import assert from 'node:assert/strict';
import {runCalculationJob, runDedicatedCalculationWorker, calculationJobStats} from '../src/web/calculation-job.mjs';
import {dedicatedCalculationWorkers} from './helpers/dedicated-calculation-workers.mjs';
import {withCalculationDeadline} from './helpers/calculation-deadline-fixture.mjs';

const ENTRY = new URL('../src/web/resample-worker.mjs', import.meta.url);
const baseline = {activeJobs: 0, reservedBytes: 0};

test('total deadline includes dedicated Worker factory startup before the first post', async t => {
  const workers = dedicatedCalculationWorkers(t);
  await withCalculationDeadline(500, async clock => {
    let factories = 0;
    await assert.rejects(runCalculationJob({timeoutMs: 500}, async context => {
      context.reserve(64);
      return runDedicatedCalculationWorker({}, ENTRY, {workerFactory(url) {
        factories++;
        const worker = workers.factory(url);
        clock.advanceTo(500); // Time spent in the caller's synchronous factory.
        return worker;
      }}, context);
    }), {name: 'TimeoutError'});
    assert.equal(factories, 1);
    assert.equal(workers.instances.length, 1);
    assert.equal(workers.instances[0].posts, 0, 'expired startup cannot send the request');
    await workers.clean();
    assert.deepEqual(calculationJobStats(), baseline);
  });
});

test('prepared Worker is released by fixture cleanup when the job never claims it', async t => {
  const workers = dedicatedCalculationWorkers(t), prepared = await workers.prepare(ENTRY);
  const controller = new AbortController(); controller.abort();
  let entered = false;
  await assert.rejects(runCalculationJob({signal: controller.signal}, () => {entered = true; return workers.factory(ENTRY);}), {name: 'AbortError'});
  assert.equal(entered, false);
  assert.equal(prepared.claimed, false);
  assert.equal(prepared.posts, 0);
  await workers.dispose();
  assert.equal(prepared.ended, true);
  assert.equal(prepared.terminateCalls, 0, 'fixture cleanup is not production termination evidence');
  assert.deepEqual(calculationJobStats(), baseline);
});

test('module import failure rejects readiness and cleans up an unclaimed Worker', async t => {
  const workers = dedicatedCalculationWorkers(t);
  await assert.rejects(workers.prepare(new URL('./helpers/nonexistent-worker-module.mjs', import.meta.url)), /Cannot find module/);
  assert.equal(workers.instances.length, 1);
  const [worker] = workers.instances;
  assert.equal(worker.ready, false);
  assert.equal(worker.claimed, false);
  assert.equal(worker.ended, true);
  assert.equal(worker.posts, 0);
  assert.equal(worker.terminateCalls, 0);
  assert.deepEqual(calculationJobStats(), baseline);
});
