import {FIELDS,validateBar} from './data.mjs';
import {RESOURCE_LIMITS,sizeLimit} from './contracts.mjs';
import {SessionCalendar,marketDate,shiftDate} from './markets.mjs';
import {resamplePlanResolver} from './resample-plan.mjs';

const RESAMPLE_BYTES=256*1024*1024,RESAMPLE_DATES=4096,RESAMPLE_SEGMENTS=64,RESAMPLE_TOTAL_SEGMENTS=16384;
const resampleTypedPrototype=Object.getPrototypeOf(Float64Array.prototype),resampleTypedLength=Object.getOwnPropertyDescriptor(resampleTypedPrototype,'length').get,resampleTypedBuffer=Object.getOwnPropertyDescriptor(resampleTypedPrototype,'buffer').get;
function resampleShared(value){return typeof SharedArrayBuffer!=='undefined'&&resampleTypedBuffer.call(value) instanceof SharedArrayBuffer;}
function resampleTime(value,label) {if(!Number.isSafeInteger(value)||Math.abs(value)>8640000000000000)throw new RangeError(label+': exact UTC milliseconds required');return value;}
function resampleBudget(bytes) {if(!Number.isSafeInteger(bytes)||bytes>RESAMPLE_BYTES)throw new RangeError('Resampling typed storage limit: 256 MiB');}
function resampleVector(value,length,label) {if(!(value instanceof Float64Array)||resampleTypedLength.call(value)<length||resampleShared(value))throw new TypeError(label+': non-shared Float64Array required');return value;}
function resampleCopy(vector,length,Type=Float64Array) {const copy=new Type(length);for(let i=0;i<length;i++)copy[i]=vector[i];return copy;}
function resampleCalendar(calendar,kinds) {
 if(!(calendar instanceof SessionCalendar))throw new TypeError('SessionCalendar required');
 const timezone=calendar.timezone,provider=calendar.provider,dates=new Map();let totalSegments=0;
 const local=new SessionCalendar(timezone,date=>{
  if(dates.size>=RESAMPLE_DATES)throw new RangeError('Resampling calendar date limit: 4096');
  const supplied=provider(date),segmentCount=Array.isArray(supplied)?supplied.length:-1;if(segmentCount<0||segmentCount>RESAMPLE_SEGMENTS)throw new RangeError('Resampling calendar segments limit: 64 per date');
  totalSegments+=segmentCount;if(totalSegments>RESAMPLE_TOTAL_SEGMENTS)throw new RangeError('Resampling total calendar segment limit: 16384');
  const windows=[];for(let i=0;i<segmentCount;i++){const s=supplied[i];if(!s||typeof s!=='object')throw new TypeError('Calendar segment required');const {open,close,kind='regular'}=s;if(typeof open!=='string'||typeof close!=='string'||typeof kind!=='string')throw new TypeError('Calendar segment strings required');windows.push({open,close,kind});}
  dates.set(date,true);return windows;
 },{maxCachedDays:RESAMPLE_DATES});
 let active=null;
 return time=>{
  if(active&&time>=active.open&&time<active.close)return active;
  const day=marketDate(time,timezone),windows=[];
  for(const date of [shiftDate(day,-1),day,shiftDate(day,1)])for(const s of local.sessions(date))if(kinds.has(s.kind))windows.push(s);
  windows.sort((a,b)=>a.open-b.open);
  for(let i=1;i<windows.length;i++)if(windows[i].open<windows[i-1].close)throw new RangeError('Overlapping selected calendar sessions');
  active=windows.find(s=>time>=s.open&&time<s.close)??null;
  if(!active)throw new RangeError('Source bar outside selected session');return active;
 };
}

export function resampleOHLCV(input,options) {return resampleWithResolver(input,options,(calendar,selected)=>resampleCalendar(calendar,selected));}
// Internal worker entry: UTC plans have already been bounded and validated by
// the transport. This still validates the plan again before using its resolver.
export function resampleFromSessions(input,options,plan) {return resampleWithResolver(input,options,()=>resamplePlanResolver(plan));}
function resampleWithResolver(input,options,resolveSessions) {
 if(!input||!options)throw new TypeError('Resampling input and explicit options required');
 const {columns,length}=input,{sourceIntervalMs:source,targetIntervalMs:target,calendar,kinds,asOf,partialTarget}=options;
 sizeLimit(length,RESOURCE_LIMITS.maxBars,'Resampling source length');resampleBudget(length*122);
 if(!Number.isSafeInteger(source)||source<1||source>86400000||!Number.isSafeInteger(target)||target<source||target>86400000||target%source!==0)throw new RangeError('Exact intraday intervals with target a source multiple required');
 resampleTime(asOf,'asOf');if(!['reject','omit','include-unconfirmed'].includes(partialTarget))throw new TypeError('Explicit partialTarget policy required');
 const kindCount=Array.isArray(kinds)?kinds.length:0;
 if(!kindCount||kindCount>RESAMPLE_SEGMENTS)throw new TypeError('Explicit bounded session kinds required');
 const selected=new Set(),snapshot={};for(let i=0;i<kindCount;i++){const kind=kinds[i];if(typeof kind!=='string'||!kind.length||kind.length>128)throw new TypeError('Explicit bounded session kinds required');selected.add(kind);}
 if(!columns||typeof columns!=='object')throw new TypeError('OHLCV columns required');
 // Capture before calling trusted calendar providers; later host edits cannot
 // change the values validated and aggregated by this operation.
 for(const field of FIELDS)snapshot[field]=resampleCopy(resampleVector(columns[field],length,field),length);
 const sessionAt=resolveSessions(calendar,selected),row={};let previous=-Infinity;
 for(let i=0;i<length;i++){
  for(const field of FIELDS)row[field]=snapshot[field][i];validateBar(row,previous);previous=row.time;
  const close=resampleTime(row.time+source,'Source close'),session=sessionAt(row.time),delta=row.time-session.open;
  if(delta%source!==0)throw new RangeError('Source time off session grid');
  const start=session.open+Math.floor(delta/target)*target,end=Math.min(session.close,start+target);
  resampleTime(start,'Target open');resampleTime(end,'Target close');
  if(close>session.close||close>end)throw new RangeError('Source bar crosses session or target boundary');
 }
 let output=null,count=0;
 function pass(write) {
  let group=null,index=0;
  const finish=()=>{
   if(!group)return;
   const complete=group.first===group.time&&group.last+source===group.end&&(group.end-group.time)%source===0&&group.to-group.from===(group.end-group.time)/source;
   if(!complete&&partialTarget==='reject')throw new RangeError('Incomplete target source coverage');
   if(complete||partialTarget==='include-unconfirmed'){
    if(write){for(const field of FIELDS)output.columns[field][index]=group[field];output.endTime[index]=group.end;output.availableAt[index]=complete?group.end:NaN;output.sourceFrom[index]=group.from;output.sourceTo[index]=group.to;output.complete[index]=Number(complete);output.confirmed[index]=Number(complete&&group.end<=asOf);}
    index++;
   }
  };
  for(let i=0;i<length;i++){
   const time=snapshot.time[i];if(time+source>asOf)break;
   const session=sessionAt(time),start=session.open+Math.floor((time-session.open)/target)*target,end=Math.min(session.close,start+target);
   if(!group||group.time!==start){finish();group={time:start,end,first:time,last:time,from:i,to:i+1,open:snapshot.open[i],high:snapshot.high[i],low:snapshot.low[i],close:snapshot.close[i],volume:snapshot.volume[i]};}
   else {group.high=Math.max(group.high,snapshot.high[i]);group.low=Math.min(group.low,snapshot.low[i]);group.close=snapshot.close[i];group.volume+=snapshot.volume[i];group.last=time;group.to=i+1;}
   if(!Number.isFinite(group.volume))throw new RangeError('Resampled volume overflow');
  }
  finish();return index;
 }
 count=pass(false);
 output={columns:Object.fromEntries(FIELDS.map(field=>[field,new Float64Array(count)])),length:count,endTime:new Float64Array(count),availableAt:new Float64Array(count),sourceFrom:new Uint32Array(count),sourceTo:new Uint32Array(count),complete:new Uint8Array(count),confirmed:new Uint8Array(count),sourceIntervalMs:source,targetIntervalMs:target,asOf};
 pass(true);return output;
}

export function alignConfirmedByTime(decisionTimes,values,timing) {
 if(!timing||!(Array.isArray(decisionTimes)||decisionTimes instanceof Float64Array))throw new TypeError('Decision times and confirmation timing required');
 const decisionLength=Array.isArray(decisionTimes)?decisionTimes.length:resampleTypedLength.call(decisionTimes);
 if(decisionTimes instanceof Float64Array)resampleVector(decisionTimes,decisionLength,'Decision times');
 const {length,endTime,availableAt,complete,confirmed,asOf}=timing;
 sizeLimit(length,RESOURCE_LIMITS.maxBars,'Confirmation length');sizeLimit(decisionLength,RESOURCE_LIMITS.maxBars,'Decision length');resampleBudget(length*26+decisionLength*16);resampleTime(asOf,'asOf');
 resampleVector(values,length,'Values');if(resampleTypedLength.call(values)!==length)throw new RangeError('Values and timing length must match');
 resampleVector(endTime,length,'End times');resampleVector(availableAt,length,'Availability');
 if(!(complete instanceof Uint8Array)||!(confirmed instanceof Uint8Array)||resampleTypedLength.call(complete)!==length||resampleTypedLength.call(confirmed)!==length)throw new TypeError('Exact-length Uint8 confirmation flags required');
 if(resampleShared(complete)||resampleShared(confirmed))throw new TypeError('Non-shared confirmation flags required');
 const ends=resampleCopy(endTime,length),available=resampleCopy(availableAt,length),flags=resampleCopy(confirmed,length,Uint8Array),coverage=resampleCopy(complete,length,Uint8Array),data=resampleCopy(values,length),decisions=new Float64Array(decisionLength);
 let previous=-Infinity,previousAvailable=-Infinity;
 for(let i=0;i<length;i++){
  const end=resampleTime(ends[i],'End time'),at=available[i],value=data[i];if(end<=previous)throw new RangeError('Strictly increasing end times required');previous=end;
  if(coverage[i]>1||flags[i]>1||value===Infinity||value===-Infinity)throw new TypeError('Valid confirmation flags and finite or NaN values required');
  if(flags[i]){if(!coverage[i]||at!==end||at>asOf||at<=previousAvailable)throw new RangeError('Inconsistent confirmed availability');previousAvailable=at;}
  else if(!Number.isNaN(at))throw new RangeError('Unconfirmed availability must be NaN');
 }
 previous=-Infinity;
 for(let i=0;i<decisions.length;i++){const time=resampleTime(decisionTimes[i],'Decision time');if(time<=previous)throw new RangeError('Strictly increasing decision times required');decisions[i]=time;previous=time;}
 const result=new Float64Array(decisions.length);let cursor=0,last=NaN;
 for(let i=0;i<decisions.length;i++){while(cursor<length&&ends[cursor]<=decisions[i]){if(flags[cursor])last=data[cursor];cursor++;}result[i]=last;}
 return result;
}
