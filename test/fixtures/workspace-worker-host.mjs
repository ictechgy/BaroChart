import {parentPort, threadId} from 'node:worker_threads';
import {defineIndicatorModule} from '../../src/core/index.mjs';

// A genuinely statically linked module shared by this owner fixture and its
// separate Worker VM. Own-property output names and -0 are intentional.
export const WORKSPACE_TEST_MODULE = 'test.workspace-own-keys@1/signed';
defineIndicatorModule({id: 'test.workspace-own-keys', version: 1, stateVersion: 1, indicators: {
  signed: {
    causal: true,
    factory({sign = 0, shift = 0} = {}) {
      const outputs = ['toString', 'valueOf', 'hasOwnProperty'];
      return {outputs, plotOffsets: Object.fromEntries(outputs.map(key => [key, shift])), create() {
        return {
          step: bar => [Object.is(sign, -0) ? bar.close : -bar.close, -bar.close, bar.volume],
          snapshot: () => 0,
          restore(state) {if (state !== 0) throw new TypeError('Workspace fixture checkpoint');},
        };
      }};
    },
    validateCheckpoint(_params, state) {
      if (state !== 0) throw new TypeError('Workspace fixture checkpoint');
    },
  },
}});

if (parentPort) {
  if (threadId === 0) throw new Error('Real separate Worker thread required');
  const {computeWorkspaceRequest} = await import('../../src/web/workspace-worker.mjs');
  parentPort.on('message', request => {
    parentPort.postMessage({__workspaceTestHost: 'dispatch', threadId});
    try {const packet=computeWorkspaceRequest(request);const transfer=packet.entries.flatMap(p=>{const r=p.result;return [...r.arrays.map(a=>a.buffer),r.checkpoints.indices.buffer,r.checkpoints.offsets.buffer,r.checkpoints.bytes.buffer];});parentPort.postMessage(packet,transfer);}
    catch (error) {
      parentPort.postMessage({schema: 'aster.workspace-error', version: 1, jobId: request?.jobId,
        kind: 'workspace', message: String(error.message).slice(0, 256)});
    }
  });
}
