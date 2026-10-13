import {FIELDS,validateBar} from './data.mjs';
import {RESOURCE_LIMITS,identifier} from './contracts.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from './checkpoint-validation.mjs';
import {IngestionError} from './ingestion-error.mjs';
const INGESTION_KINDS=['append','update','correction'],INGESTION_BYTES=49,INGESTION_MAX_EVENTS=4096;
const ingestionPolicyKeys=['streamId','generation','firstSequence','maxQueuedEvents','maxQueuedBytes','maxBatchEvents','maxStoredBars','maxStoreBytes'];
const ingestionCounterKeys=['accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','peakPendingEvents','peakPendingBytes','lastAppliedSequence','lastCancelledSequence'];
const ingestionModelLeases=new WeakMap();
export function assertDataIngestionIdle(model){if(ingestionModelLeases.get(model))throw new IngestionError('BUSY','Model has an active async ingestion fence');}
export function acquireDataIngestionLease(model){
 const releaseSession=model.dataIngestion?.acquireLease();ingestionModelLeases.set(model,(ingestionModelLeases.get(model)??0)+1);let released=false;
 return()=>{if(released)return;released=true;try{releaseSession?.();}finally{const remaining=(ingestionModelLeases.get(model)??1)-1;if(remaining)ingestionModelLeases.set(model,remaining);else ingestionModelLeases.delete(model);}};
}
export function dataIngestionBatchLimits(model,event,length,capacity){
 if(event?.kind!=='batch'||!model.dataIngestion)return null;
 const policy=model.dataIngestion.policy;
 if(length===undefined){length=model.store.length+event.events.reduce((n,e)=>n+Number(e.kind==='append'),0);capacity=model.store.capacity;while(capacity<length)capacity*=2;}
 if(length>policy.maxStoredBars||96*capacity>policy.maxStoreBytes)throw new IngestionError('STORE_BUDGET','Batch exceeds configured stored-row/capacity-byte budget');
 return {maxBars:policy.maxStoredBars,maxStoreBytes:policy.maxStoreBytes};
}
// Snapshot only own data descriptors. Getters are not invoked. Proxy traps may
// still reenter, so each mutating caller checks owner/source identity afterwards.
function ingestionRecord(value,keys,label){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new IngestionError('INVALID_INPUT',label+' object required');
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new IngestionError('INVALID_INPUT',label+' plain object required');
 const result={};for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string'||!keys.includes(key))throw new IngestionError('INVALID_INPUT',label+' unsupported field');
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new IngestionError('INVALID_INPUT',label+' data properties required');
  result[key]=descriptor.value;
 }return result;
}
function ingestionInteger(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new IngestionError('INVALID_INPUT',label+' integer range');return value;}
export function snapshotIngestionEvents(input){
 if(!Array.isArray(input))throw new IngestionError('INVALID_INPUT','1–4096 ordered events required');
 const count=Object.getOwnPropertyDescriptor(input,'length')?.value;
 if(!Number.isSafeInteger(count)||count<1||count>INGESTION_MAX_EVENTS)throw new IngestionError('INVALID_INPUT','1–4096 ordered events required');
 const keys=Reflect.ownKeys(input);if(keys.length!==count+1||keys.some(k=>k!=='length'&&(typeof k!=='string'||!Number.isSafeInteger(Number(k))||String(Number(k))!==k||Number(k)<0||Number(k)>=count)))throw new IngestionError('INVALID_INPUT','Dense event array required');
 const result=[];for(let i=0;i<count;i++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new IngestionError('INVALID_INPUT','Event array data entries required');
  const row=ingestionRecord(descriptor.value,['kind','bar'],'Event');if(!INGESTION_KINDS.includes(row.kind))throw new IngestionError('INVALID_INPUT','Ordered append/update/correction required');
  const bar=ingestionRecord(row.bar,FIELDS,'OHLCV');try{validateBar(bar);}catch(cause){throw new IngestionError('INVALID_INPUT',cause.message,cause);}result.push({kind:row.kind,bar});
 }if(Object.getOwnPropertyDescriptor(input,'length')?.value!==count)throw new IngestionError('INVALID_INPUT','Event array length changed during snapshot');return result;
}
function ingestionPolicy(model,input,allowBudgetMismatch=false){
 const row=ingestionRecord(input,ingestionPolicyKeys,'Ingestion policy');try{identifier(row.streamId,'Stream id');}catch(cause){throw new IngestionError('INVALID_INPUT',cause.message,cause);}
 const policy={streamId:row.streamId,generation:row.generation,firstSequence:row.firstSequence??0,maxQueuedEvents:row.maxQueuedEvents??4096,maxQueuedBytes:row.maxQueuedBytes??262144,maxBatchEvents:row.maxBatchEvents??128,maxStoredBars:row.maxStoredBars??model.store.maxBars,maxStoreBytes:row.maxStoreBytes??96*RESOURCE_LIMITS.maxBars};
 for(const key of ['generation','firstSequence'])ingestionInteger(policy[key],0,Number.MAX_SAFE_INTEGER,key);
 ingestionInteger(policy.maxQueuedEvents,1,4096,'maxQueuedEvents');ingestionInteger(policy.maxQueuedBytes,49,16777216,'maxQueuedBytes');ingestionInteger(policy.maxBatchEvents,1,4096,'maxBatchEvents');
 ingestionInteger(policy.maxStoredBars,0,model.store.maxBars,'maxStoredBars');ingestionInteger(policy.maxStoreBytes,1536,96*RESOURCE_LIMITS.maxBars,'maxStoreBytes');
 if(!allowBudgetMismatch&&(model.store.length>policy.maxStoredBars||model.store.bytes>policy.maxStoreBytes))throw new IngestionError('STORE_BUDGET','Current history exceeds ingestion admission budget');return Object.freeze(policy);
}
function ingestionLastError(value){if(value===null)return null;const row=ingestionRecord(value,['code','message'],'Last error');if(typeof row.code!=='string'||!/^[A-Z_]{1,64}$/.test(row.code)||typeof row.message!=='string'||row.message.length>256)throw new IngestionError('INVALID_DOCUMENT','Last error shape');return {...row};}

/** Internal model-owned state. The host schedules drains; no timers or feeds. */
export class DataIngestion {
 constructor(model,options,{allowBudgetMismatch=false}={}){
  const source=model.store,version=source.version,owner=model.dataIngestion;
  this.policy=ingestionPolicy(model,options,allowBudgetMismatch);this.model=model;this.store=source;this.sourceVersion=version;this.head=0;this.count=0;
  this.capacity=Math.min(this.policy.maxQueuedEvents,Math.floor(this.policy.maxQueuedBytes/INGESTION_BYTES));
  this.columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(this.capacity)]));this.kinds=new Uint8Array(this.capacity);
  this.nextSequence=this.policy.firstSequence;this.firstPendingSequence=this.nextSequence;this.paused=false;this.draining=false;this.leased=false;this.closed=false;this.lastError=null;this.epoch=0;
  this.counters={accepted:0,applied:0,cancelled:0,rejectedPackets:0,rejectedEvents:0,failedDrains:0,peakPendingEvents:0,peakPendingBytes:0,lastAppliedSequence:null,lastCancelledSequence:null};
  if(model.disposed||model.store!==source||source.version!==version||model.dataIngestion!==owner)throw new IngestionError('SOURCE_CHANGED','Owner changed while configuring ingestion');
 }
 active(){if(this.closed||!this.model||this.model.disposed||this.model.dataIngestion!==this)throw new IngestionError('CLOSED','Ingestion session closed or replaced');}
 idle(){this.active();if(this.leased||this.draining)throw new IngestionError('BUSY','Ingestion has an active async lease or drain');}
 source(){
  this.active();if(this.model.store!==this.store||this.store.version!==this.sourceVersion){
   if(this.count){this.paused=true;this.lastError={code:'SOURCE_CHANGED',message:'Source changed outside ingestion while payload is pending'};throw new IngestionError(this.lastError.code,this.lastError.message);}
   this.store=this.model.store;this.sourceVersion=this.store.version;
  }
 }
 rejection(error,count=0){if(!this.closed){if(this.counters.rejectedPackets<Number.MAX_SAFE_INTEGER)this.counters.rejectedPackets++;this.counters.rejectedEvents=Math.min(Number.MAX_SAFE_INTEGER,this.counters.rejectedEvents+count);}throw error instanceof IngestionError?error:new IngestionError('INVALID_INPUT',String(error.message).slice(0,256),error);}
 enqueue(packet){
  let events=[];try{
   this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();
   const version=this.store.version,next=this.nextSequence,epoch=this.epoch,row=ingestionRecord(packet,['streamId','generation','firstSequence','events'],'Packet');events=snapshotIngestionEvents(row.events);
   this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();
   if(this.store.version!==version||this.nextSequence!==next||this.epoch!==epoch)throw new IngestionError('SOURCE_CHANGED','Owner/cursor changed during packet snapshot');
   if(row.streamId!==this.policy.streamId||row.generation!==this.policy.generation)throw new IngestionError('STREAM_MISMATCH','Packet stream/generation mismatch');
   ingestionInteger(row.firstSequence,0,Number.MAX_SAFE_INTEGER,'firstSequence');if(row.firstSequence!==this.nextSequence)throw new IngestionError('SEQUENCE_MISMATCH','Packet firstSequence must equal nextSequence');
   if(events.length>this.capacity-this.count)throw new IngestionError('QUEUE_BUDGET','Packet exceeds queued event/typed-byte budget');
   if(this.nextSequence>Number.MAX_SAFE_INTEGER-events.length||this.counters.accepted>Number.MAX_SAFE_INTEGER-events.length)throw new IngestionError('SEQUENCE_LIMIT','Sequence/counter limit');
   for(let i=0;i<events.length;i++){const at=(this.head+this.count+i)%this.capacity,e=events[i];for(const k of FIELDS)this.columns[k][at]=e.bar[k];this.kinds[at]=INGESTION_KINDS.indexOf(e.kind);}
   const firstSequence=this.nextSequence;if(!this.count)this.firstPendingSequence=firstSequence;this.count+=events.length;this.nextSequence+=events.length;this.counters.accepted+=events.length;this.epoch++;
   this.counters.peakPendingEvents=Math.max(this.counters.peakPendingEvents,this.count);this.counters.peakPendingBytes=this.counters.peakPendingEvents*INGESTION_BYTES;
   return {events:events.length,firstSequence,nextSequence:this.nextSequence,pendingEvents:this.count,pendingBytes:this.count*INGESTION_BYTES};
  }catch(error){return this.rejection(error,events.length);}
 }
 prefix(count=this.count){const result=[];for(let i=0;i<count;i++){const at=(this.head+i)%this.capacity;result.push({kind:INGESTION_KINDS[this.kinds[at]],bar:Object.fromEntries(FIELDS.map(k=>[k,this.columns[k][at]]))});}return result;}
 drain(maxEvents=this.policy.maxBatchEvents){
  this.idle();if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();ingestionInteger(maxEvents,1,this.policy.maxBatchEvents,'Drain count');
  if(!this.count)return {events:0,appended:0,from:this.store.length,to:this.store.length,version:this.store.version,length:this.store.length,capacity:this.store.capacity,bytes:this.store.bytes,firstSequence:null,lastSequence:null};
  const n=Math.min(maxEvents,this.count),events=this.prefix(n),firstSequence=this.firstPendingSequence;this.draining=true;let committed=false;
  try{
   if(events.some(e=>e.kind==='append')&&this.model.series.some(s=>s.values))throw new IngestionError('EXTERNAL_ALIGNMENT','Length-changing ingestion requires host realignment of external values');
   const receipt=this.store._applyEvents(events,{maxBars:this.policy.maxStoredBars,maxStoreBytes:this.policy.maxStoreBytes},()=>{
    // Pure/no-throw ledger commit before the store's observer publication. No
    // callbacks occur here; nested enqueue/cancel sees already-applied payload.
    this.head=(this.head+n)%this.capacity;this.count-=n;this.firstPendingSequence+=n;this.counters.applied+=n;this.counters.lastAppliedSequence=firstSequence+n-1;this.sourceVersion=this.store.version+1;this.epoch++;committed=true;
   });return {...receipt,firstSequence,lastSequence:firstSequence+n-1};
  }catch(cause){
   if(committed)throw cause;
   this.counters.failedDrains=Math.min(Number.MAX_SAFE_INTEGER,this.counters.failedDrains+1);this.paused=true;this.lastError={code:'DRAIN_FAILED',message:String(cause.message).slice(0,256)};throw new IngestionError('DRAIN_FAILED',this.lastError.message,cause);
  }finally{this.draining=false;}
 }
 pause(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');this.paused=true;this.epoch++;return this.stats();}
 resume(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');this.store=this.model.store;this.sourceVersion=this.store.version;this.paused=false;this.lastError=null;this.epoch++;return this.stats();}
 cancel(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');const events=this.count,firstSequence=events?this.firstPendingSequence:null,lastSequence=events?firstSequence+events-1:null;this.counters.cancelled+=events;if(events)this.counters.lastCancelledSequence=lastSequence;this.count=0;this.head=0;this.firstPendingSequence=this.nextSequence;this.epoch++;return {events,firstSequence,lastSequence};}
 sourceStatus(){const changed=this.count>0&&(this.model.store!==this.store||this.store.version!==this.sourceVersion);return {paused:this.paused||changed,lastError:changed?{code:'SOURCE_CHANGED',message:'Source changed outside ingestion while payload is pending'}:this.lastError?{...this.lastError}:null};}
 stats(){this.active();const status=this.sourceStatus();return {policy:{...this.policy},state:this.leased||this.draining?'busy':status.paused?'paused':'running',nextSequence:this.nextSequence,...this.counters,pendingEvents:this.count,pendingBytes:this.count*INGESTION_BYTES,ownedBytes:this.capacity*INGESTION_BYTES,lastError:status.lastError,storedBars:this.model.store.length,storeBytes:this.model.store.bytes};}
 save(){this.active();const status=this.sourceStatus();return safeCheckpointStringify({schema:'aster.ingestion',version:1,policy:{...this.policy},state:status.paused?'paused':'running',nextSequence:this.nextSequence,counters:{...this.counters},lastError:status.lastError,pending:{firstSequence:this.firstPendingSequence,events:this.prefix()}});}
 acquireLease(){this.idle();if(this.count)throw new IngestionError('PENDING_DATA','Drain or cancel pending data before async preparation');this.leased=true;this.epoch++;let released=false;return()=>{if(!released){released=true;this.leased=false;this.epoch++;}};}
 dispose(){if(this.closed)return;this.counters.cancelled+=this.count;if(this.count)this.counters.lastCancelledSequence=this.firstPendingSequence+this.count-1;this.count=0;this.head=0;this.firstPendingSequence=this.nextSequence;this.closed=true;this.leased=false;this.columns={};this.kinds=null;this.model=null;this.store=null;}
}
export function restoreDataIngestion(model,text,{allowBudgetMismatch=false}={}){
 const owner=model.dataIngestion,source=model.store,version=source.version;
 const doc=ingestionRecord(safeCheckpointParse(text),['schema','version','policy','state','nextSequence','counters','lastError','pending'],'Ingestion document');
 if(doc.schema!=='aster.ingestion'||doc.version!==1||!['running','paused'].includes(doc.state))throw new IngestionError('INVALID_DOCUMENT','Ingestion schema/version/state');
 const candidate=new DataIngestion(model,doc.policy,{allowBudgetMismatch});try{
  const counters=ingestionRecord(doc.counters,ingestionCounterKeys,'Counters');for(const key of ingestionCounterKeys){if(key.startsWith('last')){if(counters[key]!==null)ingestionInteger(counters[key],0,Number.MAX_SAFE_INTEGER,key);}else ingestionInteger(counters[key],0,Number.MAX_SAFE_INTEGER,key);}
  const pending=ingestionRecord(doc.pending,['firstSequence','events'],'Pending');if(!Array.isArray(pending.events)||pending.events.length>candidate.capacity)throw new IngestionError('INVALID_DOCUMENT','Pending count');
  ingestionInteger(doc.nextSequence,0,Number.MAX_SAFE_INTEGER,'Next sequence');ingestionInteger(pending.firstSequence,0,Number.MAX_SAFE_INTEGER,'Pending sequence');
  if(counters.accepted!==counters.applied+counters.cancelled+pending.events.length||candidate.policy.firstSequence+counters.accepted!==doc.nextSequence||pending.firstSequence+pending.events.length!==doc.nextSequence||counters.peakPendingEvents<pending.events.length||counters.peakPendingEvents>candidate.capacity||counters.peakPendingBytes!==counters.peakPendingEvents*INGESTION_BYTES||['lastAppliedSequence','lastCancelledSequence'].some(k=>counters[k]!==null&&(counters[k]<candidate.policy.firstSequence||counters[k]>=doc.nextSequence)))throw new IngestionError('INVALID_DOCUMENT','Ingestion cursor/counter conservation');
  for(const [count,key] of [[counters.applied,'lastAppliedSequence'],[counters.cancelled,'lastCancelledSequence']])if(count===0?counters[key]!==null:counters[key]===null||counters[key]<candidate.policy.firstSequence+count-1||counters[key]>=pending.firstSequence)throw new IngestionError('INVALID_DOCUMENT','Ingestion completed cursor');
  const completed=counters.applied+counters.cancelled;if(completed&&Math.max(counters.lastAppliedSequence??-1,counters.lastCancelledSequence??-1)!==pending.firstSequence-1||counters.applied>0&&counters.cancelled>0&&counters.lastAppliedSequence===counters.lastCancelledSequence||counters.accepted>0&&counters.peakPendingEvents===0||counters.failedDrains>0&&counters.accepted===0||counters.rejectedPackets===0&&counters.rejectedEvents!==0||counters.rejectedEvents>counters.rejectedPackets*4096)throw new IngestionError('INVALID_DOCUMENT','Ingestion history/counter bounds');
  const events=pending.events.length?snapshotIngestionEvents(pending.events):[];for(let i=0;i<events.length;i++){for(const k of FIELDS)candidate.columns[k][i]=events[i].bar[k];candidate.kinds[i]=INGESTION_KINDS.indexOf(events[i].kind);}
  candidate.count=events.length;candidate.firstPendingSequence=pending.firstSequence;candidate.nextSequence=doc.nextSequence;candidate.counters={...counters};candidate.paused=doc.state==='paused';candidate.lastError=ingestionLastError(doc.lastError);
  if(!candidate.paused&&candidate.lastError!==null)throw new IngestionError('INVALID_DOCUMENT','Running ingestion cannot retain a paused error');
  if(model.disposed||model.dataIngestion!==owner||model.store!==source||source.version!==version)throw new IngestionError('SOURCE_CHANGED','Owner changed during ingestion restoration');return candidate;
 }catch(error){candidate.dispose();throw error;}
}
