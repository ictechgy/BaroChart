import {safeCheckpointStringify,safeCheckpointParse,validateCheckpointState} from '../core/checkpoint-validation.mjs';
const MAX_BYTES=33554432,MAX_HISTORY=4194304;
function frame(packet){
 if(!packet||!(packet.indices instanceof Uint32Array)||!(packet.offsets instanceof Uint32Array)||!(packet.bytes instanceof Uint8Array)||packet.indices.length>MAX_HISTORY+1||packet.offsets.length!==packet.indices.length+1||packet.offsets[0]!==0||packet.offsets.at(-1)!==packet.bytes.length||packet.bytes.length>MAX_BYTES)throw new TypeError('Checkpoint stream shape');
 for(let i=0;i<packet.indices.length;i++)if(packet.indices[i]>MAX_HISTORY||i&&packet.indices[i]<=packet.indices[i-1]||packet.offsets[i]>=packet.offsets[i+1])throw new TypeError('Checkpoint boundaries');
}
function context(packet,length,block){
 if(!Number.isSafeInteger(length)||length<0||length>MAX_HISTORY||!Number.isSafeInteger(block)||block<1||block>MAX_HISTORY)throw new RangeError('Checkpoint history context');
 const count=length===0?0:Math.floor(length/block)+1;
 if(packet.indices.length!==count)throw new TypeError('Checkpoint history count');
 for(let i=0;i<count;i++)if(packet.indices[i]!==i*block)throw new TypeError('Checkpoint history boundary');
}
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
export class LazyCheckpoints {
 constructor(packet){frame(packet);this.packet=packet;this.overrides=new Map();this.deleted=new Set();this.cache=new Map();this.decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});}
 ordinal(index){const a=this.packet.indices;let from=0,to=a.length;while(from<to){const mid=(from+to)>>>1;if(a[mid]<index)from=mid+1;else to=mid;}return a[from]===index?from:-1;}
 has(index){return this.overrides.has(index)||!this.deleted.has(index)&&this.ordinal(index)>=0;}
 decodeRecord(i,name,params){const {bytes,offsets,indices}=this.packet,state=safeCheckpointParse(this.decoder.decode(bytes.subarray(offsets[i],offsets[i+1])));if(name!==undefined)validateCheckpointState(name,params??{},state,indices[i]);return state;}
 validate(length,block=256,name,params){frame(this.packet);context(this.packet,length,block);for(let i=0;i<this.packet.indices.length;i++)this.decodeRecord(i,name,params);return this;}
 async validateAsync(length,block=256,name,params,options={}){
  frame(this.packet);context(this.packet,length,block);
  const {signal,maxRecordsPerSlice=32,maxSliceMs=4,yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0)),onProgress,checkOwner}=options;
  if(!Number.isSafeInteger(maxRecordsPerSlice)||maxRecordsPerSlice<1||maxRecordsPerSlice>4096||!Number.isFinite(maxSliceMs)||maxSliceMs<=0||typeof yieldTask!=='function'||checkOwner!==undefined&&typeof checkOwner!=='function')throw new RangeError('Checkpoint validation slice');
  const now=()=>globalThis.performance?.now?.()??Date.now(),total=this.packet.indices.length;let since=now(),slice=0;
  const aborted=()=>{if(signal?.aborted){const error=new Error('Checkpoint validation aborted');error.name='AbortError';throw error;}checkOwner?.();};
  aborted();for(let i=0;i<total;i++){
   aborted();this.decodeRecord(i,name,params);aborted();slice++;
   if(slice>=maxRecordsPerSlice||now()-since>=maxSliceMs){try{onProgress?.({completed:i+1,total});}catch{}aborted();if(i+1<total){await yieldTask();aborted();}slice=0;since=now();}
  }
  aborted();try{onProgress?.({completed:total,total});}catch{}aborted();return this;
 }
 get(index){if(this.overrides.has(index))return this.overrides.get(index);if(this.deleted.has(index))return undefined;if(this.cache.has(index))return this.cache.get(index);const i=this.ordinal(index);if(i<0)return undefined;const state=this.decodeRecord(i);if(this.cache.size>=32)this.cache.clear();this.cache.set(index,state);return state;}
 set(index,state){this.overrides.set(index,state);if(this.ordinal(index)>=0)this.deleted.add(index);this.cache.delete(index);return this;}
 delete(index){const existed=this.has(index);this.overrides.delete(index);if(this.ordinal(index)>=0)this.deleted.add(index);this.cache.delete(index);return existed;}
 clear(){this.packet={indices:new Uint32Array(),offsets:new Uint32Array(1),bytes:new Uint8Array()};this.overrides.clear();this.deleted.clear();this.cache.clear();}
 *keys(){for(const index of this.packet.indices)if(this.overrides.has(index)||!this.deleted.has(index))yield index;for(const index of this.overrides.keys())if(this.ordinal(index)<0)yield index;}
 *[Symbol.iterator](){for(const index of this.keys())yield [index,this.get(index)];}
 get size(){return this.packet.indices.length-this.deleted.size+this.overrides.size;}
}
