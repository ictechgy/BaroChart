import {FIELDS,validateBar} from '../core/data.mjs';
import {resamplePlanResolver} from '../core/resample-plan.mjs';
const resamplePacketProto=Object.getPrototypeOf(Float64Array.prototype),resamplePacketLength=Object.getOwnPropertyDescriptor(resamplePacketProto,'length').get,resamplePacketBuffer=Object.getOwnPropertyDescriptor(resamplePacketProto,'buffer').get,resamplePacketOffset=Object.getOwnPropertyDescriptor(resamplePacketProto,'byteOffset').get,resamplePacketTag=Object.getOwnPropertyDescriptor(resamplePacketProto,Symbol.toStringTag).get,resamplePacketBufferBytes=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
function packetRecord(value,keys,label){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain record');const copy={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data fields');copy[key]=d.value;}if(keys.some(key=>!Object.hasOwn(copy,key)))throw new TypeError(label+' missing fields');return copy;}
function packetVector(value,Type,length,buffers){if(resamplePacketTag.call(value)!==Type.name||resamplePacketLength.call(value)!==length)throw new TypeError('Result typed array type/length');const buffer=resamplePacketBuffer.call(value);if(typeof SharedArrayBuffer!=='undefined'&&buffer instanceof SharedArrayBuffer)throw new TypeError('Shared result buffer');if(resamplePacketOffset.call(value)!==0||resamplePacketBufferBytes.call(buffer)!==length*Type.BYTES_PER_ELEMENT||buffers.has(buffer))throw new RangeError('Result buffer size, alias or overlap');buffers.add(buffer);return value;}
export async function validateResamplePacket(packet,expected,context){
 context.check();context.current();
 const schema=Object.getOwnPropertyDescriptor(packet??{},'schema');if(schema&&Object.hasOwn(schema,'value')&&schema.value==='aster.resample-error'){
  const error=packetRecord(packet,['schema','version','jobId','kind','message'],'Worker error');if(error.version!==1||error.jobId!==expected.jobId||error.kind!=='resample'||typeof error.message!=='string'||error.message.length>256)throw new TypeError('Worker error binding');throw new Error(error.message);
 }
 const p=packetRecord(packet,['schema','version','jobId','kind','binding','result'],'Worker result');if(p.schema!=='aster.resample-result'||p.version!==1||p.jobId!==expected.jobId||p.kind!=='resample')throw new TypeError('Worker result protocol/binding');
 const binding=packetRecord(p.binding,['length','sourceIntervalMs','targetIntervalMs','asOf','partialTarget'],'Result binding');for(const key of Object.keys(binding))if(!Object.is(binding[key],expected.binding[key]))throw new TypeError('Result request binding');
 const r=packetRecord(p.result,['columns','length','endTime','availableAt','sourceFrom','sourceTo','complete','confirmed','sourceIntervalMs','targetIntervalMs','asOf'],'Resampling result');
 if(!Number.isSafeInteger(r.length)||r.length<0||r.length>binding.length||!Object.is(r.asOf,binding.asOf)||r.sourceIntervalMs!==binding.sourceIntervalMs||r.targetIntervalMs!==binding.targetIntervalMs)throw new RangeError('Result length/interval/asOf binding');
 const cols=packetRecord(r.columns,FIELDS,'Result OHLCV'),buffers=new Set(),vectors=[];
 for(const field of FIELDS)vectors.push([field,packetVector(cols[field],Float64Array,r.length,buffers),Float64Array,true]);
 for(const [key,Type] of [['endTime',Float64Array],['availableAt',Float64Array],['sourceFrom',Uint32Array],['sourceTo',Uint32Array],['complete',Uint8Array],['confirmed',Uint8Array]])vectors.push([key,packetVector(r[key],Type,r.length,buffers),Type,false]);
 const result={columns:{},length:r.length,sourceIntervalMs:binding.sourceIntervalMs,targetIntervalMs:binding.targetIntervalMs,asOf:binding.asOf};let done=0;const total=r.length*12+binding.length;context.progress('validate',0,total);
 for(const [key,from,Type,column] of vectors){const to=new Type(r.length);if(column)result.columns[key]=to;else result[key]=to;for(let start=0;start<r.length;start+=16384){context.check();context.current();const end=Math.min(r.length,start+16384);for(let i=start;i<end;i++)to[i]=from[i];done+=end-start;context.progress('validate',done,total);await context.yield();}}
 const sessionAt=resamplePlanResolver(expected.plan),times=expected.times,source=binding.sourceIntervalMs,target=binding.targetIntervalMs;let group=null,index=0;
 const finish=()=>{
  if(!group)return;const complete=times[group.from]===group.time&&times[group.to-1]+source===group.end&&(group.end-group.time)%source===0&&group.to-group.from===(group.end-group.time)/source;
  if(!complete&&binding.partialTarget==='reject')throw new RangeError('Incomplete target source coverage');
  if(complete||binding.partialTarget==='include-unconfirmed'){
   if(index>=result.length)throw new RangeError('Missing resampled target');const row={};for(const field of FIELDS)row[field]=result.columns[field][index];validateBar(row,index?result.columns.time[index-1]:-Infinity);
   if(row.time!==group.time||result.endTime[index]!==group.end||result.sourceFrom[index]!==group.from||result.sourceTo[index]!==group.to||result.complete[index]!==Number(complete)||result.confirmed[index]!==Number(complete)||complete&&result.availableAt[index]!==group.end||!complete&&!Number.isNaN(result.availableAt[index]))throw new RangeError('Result temporal coverage/confirmation binding');index++;
  }
 };
 for(let start=0;start<times.length;start+=16384){const stop=Math.min(times.length,start+16384);for(let i=start;i<stop;i++){
  const time=times[i],session=sessionAt(time),delta=time-session.open,targetTime=session.open+Math.floor(delta/target)*target,end=Math.min(session.close,targetTime+target);
  if(delta%source||time+source>end||time+source>session.close)throw new RangeError('Source/session grid or boundary');
  if(time+source<=binding.asOf){if(!group||group.time!==targetTime){finish();group={time:targetTime,end,from:i,to:i+1};}else group.to=i+1;}
 }done+=stop-start;context.progress('validate',done,total);await context.yield();}
 finish();if(index!==result.length)throw new RangeError('Unexpected extra resampled targets');context.progress('validate',total,total);return result;
}
