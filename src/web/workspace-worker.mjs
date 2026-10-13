import {FIELDS,validateBar} from '../core/data.mjs';
import {readWorkspaceDocument} from '../core/workspace.mjs';
import {computeIndicatorParamsRequest} from './indicator-params-worker.mjs';
import {PARAM_CHECKPOINT_BYTES,paramVector} from './indicator-params-protocol.mjs';
export function computeWorkspaceRequest(request){
 if(!request||request.schema!=='aster.workspace-request'||request.version!==1||request.kind!=='workspace'||!Number.isSafeInteger(request.jobId)||request.jobId<1)throw new TypeError('Workspace request protocol');
 const doc=readWorkspaceDocument(request.text),{length}=doc.source,capacity=request.capacity;if(!Number.isSafeInteger(capacity)||capacity<16||capacity<length||capacity>4194304||(capacity&(capacity-1)))throw new RangeError('Workspace capacity');
 const columns=request.columns,buffers=new Set();for(const field of FIELDS)paramVector(columns[field],Float64Array,length,buffers);const bar={};let previous=-Infinity;for(let i=0;i<length;i++){for(const f of FIELDS)bar[f]=columns[f][i];validateBar(bar,previous);previous=bar.time;}if(length&&(columns.time[0]!==doc.source.firstTime||columns.time[length-1]!==doc.source.lastTime))throw new TypeError('Workspace source extent');
 let remaining=PARAM_CHECKPOINT_BYTES;const entries=[];for(const study of doc.indicators){const binding={id:study.id,name:study.name,params:study.params,module:study.module,length,capacity,checkpointSize:256};const packet=computeIndicatorParamsRequest({schema:'aster.params-request',version:1,jobId:request.jobId,kind:'indicator-params',binding,columns},{checkpointBytes:remaining,sourceValidated:true});remaining-=packet.result.checkpoints.bytes.byteLength;entries.push(packet);}
 return {schema:'aster.workspace-result',version:1,jobId:request.jobId,kind:'workspace',entries};
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=({data})=>{try{const packet=computeWorkspaceRequest(data),transfer=packet.entries.flatMap(p=>{const r=p.result;return [...r.arrays.map(a=>a.buffer),r.checkpoints.indices.buffer,r.checkpoints.offsets.buffer,r.checkpoints.bytes.buffer];});self.postMessage(packet,transfer);}catch(error){self.postMessage({schema:'aster.workspace-error',version:1,jobId:data?.jobId,kind:'workspace',message:String(error.message).slice(0,256)});}};
