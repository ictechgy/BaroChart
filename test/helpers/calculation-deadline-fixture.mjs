import assert from 'node:assert/strict';
import {setTimeout as realSetTimeout, clearTimeout as realClearTimeout} from 'node:timers';

// Infrastructure waits use the real clock, independently of the operation's
// logical deadline. These are watchdogs, never evidence of an operation timeout.
export async function watchdog(promise, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`Test fixture watchdog: ${label}`)), timeoutMs);
    })]);
  } finally { realClearTimeout(timer); }
}

// Only the job's existing deadline timer is controlled. Yield timers and Worker
// startup are real. Callers run serially and settle their operation before exit.
export async function withCalculationDeadline(timeoutMs, work) {
  const saved = Object.fromEntries(['performance', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 0, deadline, registrations = 0, cleared = false;
  const clock = {
    advanceTo(value) {
      assert.ok(Number.isFinite(value) && value >= now, 'monotonic test clock');
      now = value;
    },
    expire() {
      assert.ok(deadline?.active, 'a live production deadline timer was registered');
      this.advanceTo(timeoutMs);
      deadline.active = false;
      deadline.callback();
    },
  };
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => now}});
  Object.defineProperty(globalThis, 'setTimeout', {configurable: true, value(callback, delay = 0, ...args) {
    if (delay !== timeoutMs) return realSetTimeout(callback, delay, ...args);
    assert.equal(++registrations, 1, 'one end-to-end deadline, never restarted');
    deadline = {active: true, callback: () => callback(...args)};
    return deadline;
  }});
  Object.defineProperty(globalThis, 'clearTimeout', {configurable: true, value(handle) {
    if (deadline && handle === deadline) { deadline.active = false; cleared = true; }
    else realClearTimeout(handle);
  }});
  try {
    await work(clock);
    assert.equal(registrations, 1, 'the production job armed its original deadline');
    assert.equal(cleared, true, 'the production job cleared its deadline handle');
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) Object.defineProperty(globalThis, key, descriptor);
  }
}

export function assertMatchingResult(packet, request, schema) {
  assert.ok(request, 'a production request was actually sent');
  assert.equal(packet?.schema, schema, 'a computed success packet, not ready/dispatch/error');
  assert.equal(packet.version, 1);
  assert.equal(packet.jobId, request.jobId, 'reply belongs to this invocation');
  assert.equal(packet.kind, request.kind);
  assert.deepEqual(packet.binding, request.binding);
  assert.ok(packet.result && typeof packet.result === 'object');
}

// Attach a rejection handler immediately, including while awaiting a real packet.
export function observeOperation(promise) {
  let settled = false;
  const outcome = promise.then(value => ({value}), error => ({error})).then(result => {settled = true; return result;});
  return {
    outcome,
    get settled() { return settled; },
    async beforeSettlement(event, label) {
      return watchdog(Promise.race([event, outcome.then(result => {
        if (result.error) throw result.error;
        throw new Error('Operation settled before ' + label);
      })]), label);
    },
  };
}
