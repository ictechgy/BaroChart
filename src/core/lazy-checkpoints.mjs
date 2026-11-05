import {safeCheckpointParse,validateCheckpointState} from './checkpoint-validation.mjs';

const MAX_BYTES=33554432,MAX_HISTORY=4194304;
const states=new WeakMap();
const mapGet=Map.prototype.get,mapSet=Map.prototype.set,mapDelete=Map.prototype.delete,mapClear=Map.prototype.clear,mapHas=Map.prototype.has,mapKeys=Map.prototype.keys,mapValues=Map.prototype.values;
const setAdd=Set.prototype.add,setDelete=Set.prototype.delete,setClear=Set.prototype.clear,setHas=Set.prototype.has;
const typedProto=Object.getPrototypeOf(Uint8Array.prototype),typedBuffer=Object.getOwnPropertyDescriptor(typedProto,'buffer').get,arrayBufferBytes=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get,sharedBufferBytes=typeof SharedArrayBuffer==='function'?Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,'byteLength').get:null;

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
function state(value){const result=states.get(value);if(!result)throw new TypeError('Lazy checkpoint owner');return result;}
function bufferBytes(buffer){if(buffer instanceof ArrayBuffer)return arrayBufferBytes.call(buffer);if(sharedBufferBytes&&buffer instanceof SharedArrayBuffer)return sharedBufferBytes.call(buffer);throw new TypeError('Checkpoint backing buffer');}
function retainedBytes(packet){const seen=new Set();let total=0;for(const array of [packet.indices,packet.offsets,packet.bytes]){const buffer=typedBuffer.call(array);if(!seen.has(buffer)){seen.add(buffer);total+=bufferBytes(buffer);}}return total;}
function ordinal(source,index){const a=source.packet.indices;let from=0,to=a.length;while(from<to){const mid=(from+to)>>>1;if(a[mid]<index)from=mid+1;else to=mid;}return a[from]===index?from:-1;}

/** Internal native-workspace accounting view for an authentic lazy store. */
export function lazyCheckpointSource(value){
 const source=states.get(value);if(!source)return null;
 const {packet,overrides,deleted}=source,buffers=[typedBuffer.call(packet.indices),typedBuffer.call(packet.offsets),typedBuffer.call(packet.bytes)];
 return {
  count:packet.indices.length-deleted.size+overrides.size,
  baseCount:packet.indices.length,
  overrideCount:overrides.size,
  deletedCount:deleted.size,
  retainedBytes:retainedBytes(packet),
  revision:source.revision,
  refs:[packet.indices,packet.offsets,packet.bytes,...buffers,...buffers.map(bufferBytes)],
  values:()=>mapValues.call(overrides),
 };
}

/** Encoded checkpoint storage used by worker-hydrated models. */
export class LazyCheckpoints {
 constructor(packet){
  frame(packet);
  const owned=Object.freeze({indices:packet.indices,offsets:packet.offsets,bytes:packet.bytes});
  states.set(this,{packet:owned,overrides:new Map(),deleted:new Set(),decoder:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),revision:0});
  Object.defineProperty(this,'cache',{value:new Map(),enumerable:true});
 }
 ordinal(index){return ordinal(state(this),index);}
 has(index){const source=state(this);return mapHas.call(source.overrides,index)||!setHas.call(source.deleted,index)&&ordinal(source,index)>=0;}
 decodeRecord(i,name,params){const source=state(this),{bytes,offsets,indices}=source.packet,value=safeCheckpointParse(source.decoder.decode(bytes.subarray(offsets[i],offsets[i+1])));if(name!==undefined)validateCheckpointState(name,params??{},value,indices[i]);return value;}
 validate(length,block=256,name,params){const source=state(this);frame(source.packet);context(source.packet,length,block);for(let i=0;i<source.packet.indices.length;i++)this.decodeRecord(i,name,params);return this;}
 async validateAsync(length,block=256,name,params,options={}){
  const source=state(this);frame(source.packet);context(source.packet,length,block);
  const {signal,maxRecordsPerSlice=32,maxSliceMs=4,yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0)),onProgress,checkOwner}=options;
  if(!Number.isSafeInteger(maxRecordsPerSlice)||maxRecordsPerSlice<1||maxRecordsPerSlice>4096||!Number.isFinite(maxSliceMs)||maxSliceMs<=0||typeof yieldTask!=='function'||checkOwner!==undefined&&typeof checkOwner!=='function')throw new RangeError('Checkpoint validation slice');
  const now=()=>globalThis.performance?.now?.()??Date.now(),total=source.packet.indices.length;let since=now(),slice=0;
  const aborted=()=>{if(signal?.aborted){const error=new Error('Checkpoint validation aborted');error.name='AbortError';throw error;}checkOwner?.();};
  aborted();for(let i=0;i<total;i++){
   aborted();this.decodeRecord(i,name,params);aborted();slice++;
   if(slice>=maxRecordsPerSlice||now()-since>=maxSliceMs){try{onProgress?.({completed:i+1,total});}catch{}aborted();if(i+1<total){await yieldTask();aborted();}slice=0;since=now();}
  }
  aborted();try{onProgress?.({completed:total,total});}catch{}aborted();return this;
 }
 get(index){const source=state(this);if(mapHas.call(source.overrides,index))return mapGet.call(source.overrides,index);if(setHas.call(source.deleted,index))return undefined;if(mapHas.call(this.cache,index))return mapGet.call(this.cache,index);const i=ordinal(source,index);if(i<0)return undefined;const value=this.decodeRecord(i);if(this.cache.size>=32)mapClear.call(this.cache);mapSet.call(this.cache,index,value);return value;}
 set(index,value){const source=state(this);mapSet.call(source.overrides,index,value);if(ordinal(source,index)>=0)setAdd.call(source.deleted,index);mapDelete.call(this.cache,index);source.revision++;return this;}
 delete(index){const source=state(this),existed=this.has(index);mapDelete.call(source.overrides,index);if(ordinal(source,index)>=0)setAdd.call(source.deleted,index);mapDelete.call(this.cache,index);source.revision++;return existed;}
 clear(){const source=state(this);source.packet=Object.freeze({indices:new Uint32Array(),offsets:new Uint32Array(1),bytes:new Uint8Array()});mapClear.call(source.overrides);setClear.call(source.deleted);mapClear.call(this.cache);source.revision++;}
 *keys(){const source=state(this);for(const index of source.packet.indices)if(mapHas.call(source.overrides,index)||!setHas.call(source.deleted,index))yield index;for(const index of mapKeys.call(source.overrides))if(ordinal(source,index)<0)yield index;}
 *[Symbol.iterator](){for(const index of this.keys())yield [index,this.get(index)];}
 get size(){const source=state(this);return source.packet.indices.length-source.deleted.size+source.overrides.size;}
}
