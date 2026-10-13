import {parentPort, workerData, threadId} from 'node:worker_threads';
if (!parentPort || threadId === 0) throw new Error('Real separate worker thread required');
globalThis.self = {
  onmessage: null,
  postMessage(data, transfer = []) { parentPort.postMessage(data, transfer); },
};
await import(workerData.url);
if (typeof globalThis.self.onmessage !== 'function') throw new Error('Worker module did not install its message handler');
parentPort.on('message', data => {
  parentPort.postMessage({__asterTestHost: 'dispatch', threadId});
  globalThis.self.onmessage?.({data});
});
// Test setup only: online precedes module evaluation, so it is not readiness.
if (workerData.reportReady) parentPort.postMessage({__asterTestHost: 'ready', threadId});
