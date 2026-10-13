import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {calculationJobStats} from '../../src/web/calculation-job.mjs';
import {watchdog} from './calculation-deadline-fixture.mjs';

const HOST = new URL('./async-resample-worker-host.mjs', import.meta.url);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  // A Worker can fail before prepare() attaches its await or before it is claimed.
  promise.catch(() => {});
  return {promise, resolve, reject};
}

export function dedicatedCalculationWorkers(t, hooks = {}) {
  const instances = [], baseline = calculationJobStats();
  let prepared, preparedMode = false;
  const dispose = async () => {
    // Fallback cleanup is deliberately separate from production terminateCalls.
    await Promise.all(instances.map(adapter => adapter.node.terminate()));
  };
  t.after(dispose);
  const create = (url, reportReady) => {
    const ready = deferred(), exited = deferred();
    const node = new Worker(HOST, {workerData: {url: String(url), reportReady}});
    const adapter = {
      node, url: String(url), threadId: node.threadId, onmessage: null, onerror: null,
      claimed: false, ready: false, ended: false, failure: null,
      terminateCalls: 0, posts: 0, cleanupFinished: false, request: null,
      readyPromise: ready.promise, exited: exited.promise,
      postMessage(data, transfer) {
        this.posts++;
        this.request = data;
        hooks.beforeSend?.(data, adapter);
        node.postMessage(data, transfer);
        hooks.afterSend?.(data, adapter);
      },
      terminate() {
        this.terminateCalls++;
        hooks.terminating?.(adapter);
        return node.terminate().then(async code => {
          await hooks.terminated?.(adapter);
          this.cleanupFinished = true;
          return code;
        });
      },
    };
    // Track ownership before hooks or asynchronous readiness can fail.
    instances.push(adapter);
    const fail = error => {
      adapter.failure ??= error;
      ready.reject(error);
      adapter.onerror?.(error);
    };
    node.on('message', data => {
      try {
        if (data?.__asterTestHost === 'ready') {
          assert.equal(data.threadId, adapter.threadId);
          assert.equal(adapter.ready, false, 'one readiness handshake');
          adapter.ready = true; ready.resolve(adapter); return;
        }
        if (data?.__asterTestHost === 'dispatch') { hooks.processing?.(adapter); return; }
        hooks.beforeReceive?.(data, adapter);
        if (hooks.shouldDeliver?.(data, adapter) !== false) adapter.onmessage?.({data});
        hooks.afterReceive?.(data, adapter);
      } catch (error) { fail(error); }
    });
    node.on('error', fail);
    node.on('exit', code => {
      adapter.ended = true;
      if (!adapter.ready) ready.reject(adapter.failure ?? new Error('Worker exited before module readiness'));
      exited.resolve(code);
    });
    hooks.created?.(adapter);
    return adapter;
  };
  return {
    instances, dispose,
    async prepare(url) {
      assert.equal(instances.length, 0, 'prepare one dedicated Worker per fixture');
      preparedMode = true;
      prepared = create(url, true);
      try { return await watchdog(prepared.readyPromise, 'Worker module readiness'); }
      catch (error) { await dispose(); throw error; }
    },
    factory(url) {
      const adapter = preparedMode ? prepared : create(url, false);
      assert.equal(adapter.url, String(url), 'prepared Worker matches the production entry');
      assert.equal(adapter.claimed, false, 'prepared Worker is never reused');
      assert.equal(adapter.ended, false, 'Worker is still alive when ownership transfers');
      if (adapter.failure) throw adapter.failure;
      if (preparedMode) assert.equal(adapter.ready, true, 'module readiness is a setup precondition');
      adapter.claimed = true;
      return adapter;
    },
    async clean() {
      // Assert production ownership before any fallback termination can hide a bug.
      for (const adapter of instances) {
        assert.equal(adapter.claimed, true, 'production claimed its dedicated Worker');
        assert.ok(adapter.threadId > 0, 'actual separate worker thread');
        assert.equal(adapter.terminateCalls, 1, 'one production-owned termination');
        assert.equal(adapter.onmessage, null, 'message handler detached');
        assert.equal(adapter.onerror, null, 'error handler detached');
        if (adapter.failure) throw adapter.failure;
      }
      await watchdog(Promise.all(instances.map(adapter => adapter.exited)), 'production Worker termination');
      assert.deepEqual(calculationJobStats(), baseline, 'logical reservations released');
    },
  };
}
