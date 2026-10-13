import {IndicatorEngine} from '../core/indicators.mjs';
import {FIELDS,validateBar} from '../core/data.mjs';
import {safeCheckpointStringify} from '../core/checkpoint-validation.mjs';
import {paramDefinition,paramLayout,paramVector,PARAM_CHECKPOINT_BYTES,PARAM_RECORD_BYTES} from './indicator-params-protocol.mjs';
export function computeIndicatorParamsRequest(request,{checkpointBytes=PARAM_CHECKPOINT_BYTES,sourceValidated=false}={}){
 if(!Number.isSafeInteger(checkpointBytes)||checkpointBytes<0||checkpointBytes>PARAM_CHECKPOINT_BYTES)throw new RangeError('Parameter checkpoint budget');
 if(!request||request.schema!=='aster.params-request'||request.version!==1||request.kind!=='indicator-params'||!Number.isSafeInteger(request.jobId)||request.jobId<1)throw new TypeError('Parameter request protocol');
 const {binding:b,columns}=request;if(!b||!Number.isSafeInteger(b.length)||b.length<0||b.length>4194304||!Number.isSafeInteger(b.capacity)||b.capacity<16||b.capacity<b.length||b.capacity>4194304||(b.capacity&(b.capacity-1))||b.checkpointSize!==256)throw new RangeError('Parameter request dimensions');
 const buffers=new Set();for(const field of FIELDS)paramVector(columns[field],Float64Array,b.length,buffers);
 let previous=-Infinity;const bar={};for(let i=0;!sourceValidated&&i<b.length;i++){for(const field of FIELDS)bar[field]=columns[field][i];validateBar(bar,previous);previous=bar.time;}
 const def=paramDefinition(b.name,b.params,b.module),layout=paramLayout(def),store={length:b.length,capacity:b.capacity,columns,_subscribeInternal:()=>()=>{}},engine=new IndicatorEngine(store,{checkpointSize:b.checkpointSize});
 const parts=[],indices=[],offsets=[0],encoder=new TextEncoder();let bytes=0;
 // Encode at each fresh-calculation checkpoint, never retain decoded history.
 const checkpoints={get(){return undefined;},has(){return false;},set(index,state){const text=safeCheckpointStringify(state);if(text.length>PARAM_RECORD_BYTES)throw new RangeError('Parameter checkpoint record byte limit');const part=encoder.encode(text);if(part.length>PARAM_RECORD_BYTES||bytes+part.length>checkpointBytes)throw new RangeError('Parameter checkpoint byte limit');parts.push(part);indices.push(index);offsets.push(bytes+=part.length);},keys(){return indices.values();},delete(){throw new Error('Unexpected fresh checkpoint deletion');}};
 const entry={def,name:b.name,params:{...b.params},dirty:0,dirtyTo:b.length,invalidated:true,length:0,arrays:[],checkpoints,revision:0};engine.entries.set(b.id,entry);
 try{engine.get(b.id);const joined=new Uint8Array(bytes);let at=0;for(const part of parts){joined.set(part,at);at+=part.length;}return {schema:'aster.params-result',version:1,jobId:request.jobId,kind:'indicator-params',binding:b,result:{...layout,arrays:entry.arrays,checkpoints:{indices:Uint32Array.from(indices),offsets:Uint32Array.from(offsets),bytes:joined},revision:entry.revision,computedFrom:entry.computedFrom??0,computedUntil:entry.computedUntil??b.length,dirty:b.length,dirtyTo:0,invalidated:false,length:b.length}};}finally{engine.dispose();}
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=({data})=>{try{const packet=computeIndicatorParamsRequest(data),r=packet.result;self.postMessage(packet,[...r.arrays.map(a=>a.buffer),r.checkpoints.indices.buffer,r.checkpoints.offsets.buffer,r.checkpoints.bytes.buffer]);}catch(error){self.postMessage({schema:'aster.params-error',version:1,jobId:data?.jobId,kind:'indicator-params',message:String(error.message).slice(0,256)});}};
