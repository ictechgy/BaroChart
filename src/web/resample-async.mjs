import {BarStore,FIELDS} from '../core/data.mjs';
import {SessionCalendar,marketDate,shiftDate} from '../core/markets.mjs';
import {RESOURCE_LIMITS,sizeLimit} from '../core/contracts.mjs';
import {validateResamplePlan} from '../core/resample-plan.mjs';
import {runCalculationJob,runDedicatedCalculationWorker} from './calculation-job.mjs';
import {validateResamplePacket} from './resample-packet.mjs';
const asyncResampleTyped=Object.getPrototypeOf(Float64Array.prototype),asyncResampleLength=Object.getOwnPropertyDescriptor(asyncResampleTyped,'length').get,asyncResampleBuffer=Object.getOwnPropertyDescriptor(asyncResampleTyped,'buffer').get,asyncResampleTag=Object.getOwnPropertyDescriptor(asyncResampleTyped,Symbol.toStringTag).get;
function asyncResampleVector(value,length){if(asyncResampleTag.call(value)!=='Float64Array'||asyncResampleLength.call(value)<length||typeof SharedArrayBuffer!=='undefined'&&asyncResampleBuffer.call(value) instanceof SharedArrayBuffer)throw new TypeError('Non-shared Float64 source columns required');return value;}
function asyncResampleTime(time){if(!Number.isSafeInteger(time)||Math.abs(time)>8640000000000000)throw new RangeError('Exact UTC milliseconds required');return time;}
function asyncStoreSlot(store,key){const d=Object.getOwnPropertyDescriptor(store,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Managed store own data slots required');return d.value;}
function asyncResampleStale(){const error=new Error('Source changed; async resampling discarded');error.name='StaleSourceError';return error;}
function asyncResampleOptions(options){
 const {sourceIntervalMs,targetIntervalMs,kinds,asOf,partialTarget}=options;
 if(!Number.isSafeInteger(sourceIntervalMs)||sourceIntervalMs<1||sourceIntervalMs>86400000||!Number.isSafeInteger(targetIntervalMs)||targetIntervalMs<sourceIntervalMs||targetIntervalMs>86400000||targetIntervalMs%sourceIntervalMs)throw new RangeError('Exact intraday source/target intervals required');
 asyncResampleTime(asOf);if(!['reject','omit','include-unconfirmed'].includes(partialTarget))throw new TypeError('Explicit partialTarget policy required');
 const count=Array.isArray(kinds)?kinds.length:0;if(!count||count>64)throw new TypeError('Explicit bounded kinds required');const copy=[];for(let i=0;i<count;i++){const kind=kinds[i];if(typeof kind!=='string'||!kind.length||kind.length>128)throw new TypeError('Session kind string required');copy.push(kind);}
 return {sourceIntervalMs,targetIntervalMs,kinds:copy,asOf,partialTarget};
}
// Conservative JSON/UTF-8 accounting without constructing an escaped document.
function asyncResampleStringBytes(value){let bytes=2;for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code<32)bytes+=6;else if(code===34||code===92)bytes+=2;else if(code<128)bytes++;else if(code<2048)bytes+=2;else if(code>=0xd800&&code<=0xdbff&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else if(code>=0xd800&&code<=0xdfff)bytes+=6;else bytes+=3;}return bytes;}
async function asyncResampleCalendar(calendar,times,sourceIntervalMs,kinds,context){
 if(!(calendar instanceof SessionCalendar))throw new TypeError('SessionCalendar required');
 const timezone=calendar.timezone,provider=calendar.provider;
 if(!times.length){context.progress('calendar',0,0);return {schema:'aster.utc-sessions',version:1,from:0,to:0,segments:[]};}
 const from=times[0],to=asyncResampleTime(times[times.length-1]+sourceIntervalMs),first=marketDate(from,timezone),last=marketDate(to-1,timezone);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(first)||!/^\d{4}-\d{2}-\d{2}$/.test(last))throw new RangeError('Portable calendar date range');
 const days=(Date.parse(last+'T12:00:00Z')-Date.parse(first+'T12:00:00Z'))/86400000+3;if(!Number.isSafeInteger(days)||days<1||days>4096)throw new RangeError('Async calendar date range limit: 4096');
 context.progress('calendar',0,days);
 let segmentsCount=0,planBytes=512;const selected=new Set(kinds),segments=[];
 const local=new SessionCalendar(timezone,date=>{context.check();context.current();const supplied=provider(date),count=Array.isArray(supplied)?supplied.length:-1;context.check();context.current();if(count<0||count>64||(segmentsCount+=count)>16384)throw new RangeError('Async calendar segment limit');const copy=[];for(let i=0;i<count;i++){const segment=supplied[i];if(!segment||typeof segment!=='object')throw new TypeError('Calendar segment required');const {open,close,kind='regular'}=segment;if(typeof open!=='string'||typeof close!=='string'||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(open)||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(close)||typeof kind!=='string'||!kind.length||kind.length>128)throw new TypeError('Bounded calendar clock/kind strings required');copy.push({open,close,kind});}return copy;},{maxCachedDays:4096});
 let date=shiftDate(first,-1);
 for(let i=0;i<days;i++,date=shiftDate(date,1)){context.check();context.current();for(const s of local.sessions(date))if(selected.has(s.kind)){planBytes+=64+String(s.open).length+String(s.close).length+asyncResampleStringBytes(s.kind);if(planBytes>2*1024*1024)throw new RangeError('UTC session plan byte limit: 2 MiB');segments.push({open:s.open,close:s.close,kind:s.kind});}context.progress('calendar',i+1,days);await context.yield();}
 segments.sort((a,b)=>a.open-b.open);const plan=validateResamplePlan({schema:'aster.utc-sessions',version:1,from,to,segments});
 return plan;
}
export function resampleOHLCVAsync(source,options={}){
 return runCalculationJob(options,async context=>{
  const config=asyncResampleOptions(options),calendar=options.calendar,factory=options.workerFactory;
  if(factory!==undefined&&typeof factory!=='function')throw new TypeError('Worker factory required');
  // Literal default constructor lets module-worker aware bundlers emit the entry.
  const transport={workerFactory:factory??(()=>new Worker(new URL('./resample-worker.mjs',import.meta.url),{type:'module'}))};context.check();
  if(!source||typeof source!=='object')throw new TypeError('Explicit async source mode required');
  const kind=source.kind;let input,length,store,version,sourceColumns,arrays;
  if(kind==='store'){
   store=source.store;if(!(store instanceof BarStore))throw new TypeError('Actual BarStore required');sourceColumns=asyncStoreSlot(store,'columns');length=asyncStoreSlot(store,'length');version=asyncStoreSlot(store,'version');input=sourceColumns;
  }else if(kind==='immutable-columns'){input=source.columns;length=source.length;}else throw new TypeError('Async source kind: store or immutable-columns');
  sizeLimit(length,RESOURCE_LIMITS.maxBars,'Async source length');context.reserve(length*252+4*1024*1024);
  if(!input||typeof input!=='object')throw new TypeError('OHLCV source columns required');
  arrays=FIELDS.map(field=>asyncResampleVector(store?asyncStoreSlot(input,field):input[field],length));
  if(store)context.current=()=>{if(asyncStoreSlot(store,'columns')!==sourceColumns||asyncStoreSlot(store,'length')!==length||asyncStoreSlot(store,'version')!==version||FIELDS.some((field,i)=>asyncStoreSlot(sourceColumns,field)!==arrays[i]))throw asyncResampleStale();};
  context.check();context.current();context.progress('snapshot',0,length*6);const owned={},times=new Float64Array(length);let done=0,previous=-Infinity;
  for(let fieldIndex=0;fieldIndex<FIELDS.length;fieldIndex++){
   const field=FIELDS[fieldIndex],from=arrays[fieldIndex],to=new Float64Array(length);owned[field]=to;
   for(let start=0;start<length;start+=16384){context.check();context.current();const end=Math.min(length,start+16384);for(let i=start;i<end;i++){const value=from[i];to[i]=value;if(fieldIndex===0){asyncResampleTime(value);asyncResampleTime(value+config.sourceIntervalMs);if(value<=previous)throw new RangeError('Strict source time order required');previous=value;times[i]=value;}}done+=end-start;context.progress('snapshot',done,length*6);await context.yield();}
  }
  context.check();context.current();const plan=await asyncResampleCalendar(calendar,times,config.sourceIntervalMs,config.kinds,context);context.check();context.current();
  const binding={length,sourceIntervalMs:config.sourceIntervalMs,targetIntervalMs:config.targetIntervalMs,asOf:config.asOf,partialTarget:config.partialTarget};
  const request={schema:'aster.resample-request',version:1,jobId:context.id,kind:'resample',binding,columns:owned,options:config,sessions:plan};
  context.progress('compute',0,1);const packet=await runDedicatedCalculationWorker(request,new URL('./resample-worker.mjs',import.meta.url),transport,context,FIELDS.map(field=>owned[field].buffer));context.progress('compute',1,1);
  return validateResamplePacket(packet,{jobId:context.id,binding,plan,times},context);
 });
}
