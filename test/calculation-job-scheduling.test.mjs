import test from 'node:test';
import assert from 'node:assert/strict';
import {runCalculationJob, calculationJobStats} from '../src/web/calculation-job.mjs';

// Tests in this file deliberately run serially because the production API reads
// global clocks/timers. The fake only observes scheduling decisions and resume
// boundaries; the final tests separately verify actual macrotask fairness.
async function fakeScheduler(work) {
  const saved = Object.fromEntries(['performance', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const savedDateNow = Object.getOwnPropertyDescriptor(Date, 'now');
  const baseline = calculationJobStats();
  const pending = new Map();
  let nextId = 0;
  const clock = {now: 0, wall: 0, zeroCalls: [], zeroRuns: 0, onResume: null};
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => clock.now}});
  Object.defineProperty(Date, 'now', {configurable: true, value: () => clock.wall});
  Object.defineProperty(globalThis, 'setTimeout', {configurable: true, value: (callback, delay = 0, ...args) => {
    const id = ++nextId;
    pending.set(id, {callback, delay});
    if (delay === 0) {
      clock.zeroCalls.push(clock.now);
      queueMicrotask(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clock.zeroRuns++;
        clock.onResume?.();
        callback(...args);
      });
    }
    return id;
  }});
  Object.defineProperty(globalThis, 'clearTimeout', {configurable: true, value: id => pending.delete(id)});
  try {
    await work(clock);
    assert.deepEqual(calculationJobStats(), baseline, 'job reservations returned to baseline');
    assert.equal(pending.size, 0, 'job timeout and yield handles are no longer pending');
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) Object.defineProperty(globalThis, key, descriptor);
    Object.defineProperty(Date, 'now', savedDateNow);
  }
}

function watchedSignal() {
  const controller = new AbortController();
  const {signal} = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const counts = {added: 0, removed: 0};
  signal.addEventListener = (...args) => { counts.added++; return add(...args); };
  signal.removeEventListener = (...args) => { counts.removed++; return remove(...args); };
  return {controller, signal, counts};
}

test('seven cheap units coalesce without allocating a yield timer and check current on both sides', async () => {
  await fakeScheduler(async clock => {
    const signal = watchedSignal();
    const baseline = calculationJobStats();
    const cleanup = [];
    const result = await runCalculationJob({signal: signal.signal}, async context => {
      context.reserve(128);
      assert.deepEqual(calculationJobStats(), {activeJobs: baseline.activeJobs + 1, reservedBytes: baseline.reservedBytes + 128});
      context.cleanup(() => cleanup.push('first'));
      context.cleanup(() => cleanup.push('second'));
      let checks = 0;
      context.current = () => checks++;
      for (let i = 0; i < 7; i++) {
        const before = checks;
        await context.yield();
        assert.equal(checks - before, 2, `unit ${i + 1} checks source before and after`);
      }
      return 'result';
    });
    assert.equal(result, 'result');
    assert.equal(clock.zeroCalls.length, 0);
    assert.deepEqual(cleanup, ['second', 'first']);
    assert.deepEqual(signal.counts, {added: 1, removed: 1});
  });
});

test('a stalled monotonic clock still forces one timer after every eight units', async () => {
  await fakeScheduler(async clock => {
    let started = 0;
    const resumedAt = [];
    clock.onResume = () => resumedAt.push(started);
    await runCalculationJob({}, async context => {
      context.reserve(1);
      for (started = 1; started <= 24; started++) await context.yield();
    });
    assert.deepEqual(resumedAt, [8, 16, 24]);
    assert.equal(clock.zeroCalls.length, 3);
    assert.equal(clock.zeroRuns, 3);
  });
});

test('the one-millisecond boundary uses the monotonic clock and resets after resume', async () => {
  await fakeScheduler(async clock => {
    clock.onResume = () => { clock.now += 99; };
    await runCalculationJob({timeoutMs: 1000}, async context => {
      await context.yield();
      clock.wall = 9e15;
      clock.now = 0.999;
      await context.yield();
      assert.equal(clock.zeroCalls.length, 0, 'wall-clock movement and sub-budget work do not force a timer');
      clock.wall = -9e15;
      clock.now = 1;
      await context.yield();
      assert.equal(clock.zeroCalls.length, 1, 'exactly 1 ms forces a timer');
      assert.equal(clock.now, 100);
      clock.now = 100.999;
      await context.yield();
      assert.equal(clock.zeroCalls.length, 1, 'timer waiting time is excluded from the next slice');
      clock.now = 101;
      await context.yield();
      assert.equal(clock.zeroCalls.length, 2);
    });
    assert.deepEqual(clock.zeroCalls, [1, 101]);
  });
});

for (const boundary of ['before-fast-path', 'after-fast-path', 'after-timer']) {
  for (const mode of ['abort', 'timeout', 'stale']) {
    test(`${mode} at ${boundary} rejects without continuing and releases lifecycle ownership`, async () => {
      await fakeScheduler(async clock => {
        const signal = watchedSignal();
        const timeoutMs = boundary === 'after-fast-path' ? 0.5 : 10;
        const staleError = Object.assign(new Error('Source changed'), {name: 'StaleSourceError'});
        let stale = false, completed = 0, cleanups = 0, stops = 0, currentCalls = 0;
        const invalidate = () => {
          if (mode === 'abort') signal.controller.abort();
          if (mode === 'timeout') clock.now = timeoutMs;
          if (mode === 'stale') stale = true;
        };
        if (boundary === 'after-timer') clock.onResume = invalidate;
        const result = runCalculationJob({signal: signal.signal, timeoutMs}, async context => {
          context.reserve(256);
          context.cleanup(() => cleanups++);
          context.onStop(() => stops++);
          context.current = () => {
            if (stale) throw staleError;
            currentCalls++;
            if (boundary === 'after-fast-path' && currentCalls === 1) invalidate();
          };
          if (boundary === 'before-fast-path') invalidate();
          const units = boundary === 'after-timer' ? 8 : 1;
          for (let i = 0; i < units; i++) {
            await context.yield();
            completed++;
          }
          assert.fail('invalidated work must not reach its result');
        });
        await assert.rejects(result, error => mode === 'stale' ? error === staleError : error.name === (mode === 'abort' ? 'AbortError' : 'TimeoutError'));
        assert.equal(completed, boundary === 'after-timer' ? 7 : 0);
        assert.equal(clock.zeroCalls.length, boundary === 'after-timer' ? 1 : 0);
        assert.equal(cleanups, 1);
        assert.equal(stops, mode === 'stale' ? 0 : 1);
        assert.deepEqual(signal.counts, {added: 1, removed: 1});
      });
    });
  }
}

test('a deadline crossing in a later cheap unit is observed without waiting for the slice cap', async () => {
  await fakeScheduler(async clock => {
    let completed = 0;
    await assert.rejects(runCalculationJob({timeoutMs: 0.75}, async context => {
      context.reserve(64);
      for (let i = 0; i < 6; i++) {
        clock.now += 0.25;
        await context.yield();
        completed++;
      }
    }), {name: 'TimeoutError'});
    assert.equal(completed, 2);
    assert.equal(clock.zeroCalls.length, 0);
  });
});

test('ordinary work and cleanup errors still return reserved counters after coalesced units', async () => {
  for (const failureAt of ['work', 'cleanup']) {
    await fakeScheduler(async clock => {
      const original = new Error(`${failureAt} failed`);
      let cleaned = 0;
      await assert.rejects(runCalculationJob({}, async context => {
        context.reserve(512);
        context.cleanup(() => { cleaned++; if (failureAt === 'cleanup') throw original; });
        for (let i = 0; i < 3; i++) await context.yield();
        if (failureAt === 'work') throw original;
      }), error => error === original);
      assert.equal(cleaned, 1);
      assert.equal(clock.zeroCalls.length, 0);
    });
  }
});

test('a real pending timer can cancel by the eighth unit even when the monotonic clock is stalled', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const baseline = calculationJobStats();
  const controller = new AbortController();
  let started = 0, completed = 0, observedStarted = null, cleaned = 0;
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => 0}});
  const timer = setTimeout(() => { observedStarted = started; controller.abort(); }, 0);
  try {
    await assert.rejects(runCalculationJob({signal: controller.signal, timeoutMs: 1000}, async context => {
      context.reserve(1024);
      context.cleanup(() => cleaned++);
      for (let i = 0; i < 10_000; i++) {
        started++;
        await context.yield();
        completed++;
      }
    }), {name: 'AbortError'});
    assert.ok(observedStarted >= 1 && observedStarted <= 8, `pending timer observed ${observedStarted} units`);
    assert.ok(completed < observedStarted, 'the interrupted yield does not let work continue');
    assert.equal(cleaned, 1);
    assert.deepEqual(calculationJobStats(), baseline);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(globalThis, 'performance', descriptor);
  }
});

test('the real deadline timer remains live during coalesced work with a stalled monotonic clock', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const baseline = calculationJobStats();
  let completed = 0, cleanups = 0, stops = 0;
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => 0}});
  try {
    await assert.rejects(runCalculationJob({timeoutMs: 5}, async context => {
      context.reserve(1024);
      context.cleanup(() => cleanups++);
      context.onStop(() => stops++);
      for (let i = 0; i < 10_000; i++) { await context.yield(); completed++; }
    }), {name: 'TimeoutError'});
    assert.ok(completed < 10_000);
    assert.equal(cleanups, 1);
    assert.equal(stops, 1);
    assert.deepEqual(calculationJobStats(), baseline);
  } finally {
    Object.defineProperty(globalThis, 'performance', descriptor);
  }
});
