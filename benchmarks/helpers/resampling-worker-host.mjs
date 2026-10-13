import {parentPort,workerData,threadId} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
globalThis.self={onmessage:null,postMessage(data,transfer=[]){parentPort.postMessage(data,transfer);}};
await import(workerData.url);
parentPort.on('message',data=>{const start=performance.now();self.onmessage({data});parentPort.postMessage({__asterMeasurement:true,threadId,computeAndResponsePostMs:performance.now()-start});});
