import {safeCheckpointStringify} from '../core/checkpoint-validation.mjs';
import {LazyCheckpoints} from '../core/lazy-checkpoints.mjs';
export {LazyCheckpoints};
const MAX_BYTES=33554432,MAX_HISTORY=4194304;
// Transfer a byte stream instead of tens of thousands of JS object graphs.
// Installation validates every record without retaining the decoded objects.
export function encodeCheckpoints(checkpoints){
 if(!Number.isSafeInteger(checkpoints.size)||checkpoints.size<0||checkpoints.size>MAX_HISTORY+1)throw new RangeError('Checkpoint count limit');
 const indices=new Uint32Array(checkpoints.size),offsets=new Uint32Array(checkpoints.size+1),parts=[],encoder=new TextEncoder();let size=0,i=0;
 for(const [index,state] of [...checkpoints].sort((a,b)=>a[0]-b[0])){
  if(!Number.isSafeInteger(index)||index<0||index>MAX_HISTORY||i&&index<=indices[i-1])throw new TypeError('Checkpoint index');
  const bytes=encoder.encode(safeCheckpointStringify(state));size+=bytes.length;if(size>MAX_BYTES)throw new RangeError('Checkpoint byte limit');indices[i]=index;offsets[++i]=size;parts.push(bytes);
 }
 if(i!==indices.length)throw new TypeError('Checkpoint count');
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return {indices,offsets,bytes};
}
