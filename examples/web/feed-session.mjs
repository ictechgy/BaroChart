import {BarStore, ChartAPI, FIELDS, validateBar, RESOURCE_LIMITS} from '../../src/core/index.mjs';

// App-owned recipe. The transport must provide one contiguous sequence shared by
// its snapshot watermark and deltas; timestamps alone cannot establish freshness.
function sequence(value){if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Feed sequence must be a nonnegative safe integer');return value;}
function eventCopy(value){
 if(!value||!['update','append','correction'].includes(value.kind))throw new TypeError('Feed event kind');
 const bar=Object.fromEntries(FIELDS.map(key=>[key,value.bar?.[key]]));validateBar(bar);
 return {sequence:sequence(value.sequence),kind:value.kind,bar};
}
function untilAbort(promise,signal){
 return new Promise((resolve,reject)=>{
  const cancel=()=>{signal.removeEventListener('abort',cancel);reject(new DOMException('Cancelled','AbortError'));};
  if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(error);});
 });
}

export function createFeedSession(api,{loadSnapshot,subscribe,onState=()=>{},maxBufferedEvents=128,maxBars=100000}={}){
 if(!(api instanceof ChartAPI)||typeof loadSnapshot!=='function'||typeof subscribe!=='function'||typeof onState!=='function')throw new TypeError('Feed API, snapshot, subscription and state callback required');
 if(!Number.isSafeInteger(maxBufferedEvents)||maxBufferedEvents<1||maxBufferedEvents>4096||!Number.isSafeInteger(maxBars)||maxBars<1||maxBars>RESOURCE_LIMITS.maxBars)throw new RangeError('Feed buffer/source budget');
 let active=null,generation=0,disposed=false;
 let state=Object.freeze({status:'idle',generation,lastSequence:null,applied:0,duplicates:0,buffered:0,error:null});
 const current=run=>active===run&&!disposed&&!run.controller.signal.aborted;
 const notify=(run,status,error=null)=>{state=Object.freeze({status,generation:run?.generation??generation,lastSequence:run?.cursor??state.lastSequence,applied:run?.applied??state.applied,duplicates:run?.duplicates??state.duplicates,buffered:run?.queue.length??0,error:error?String(error.message??error).slice(0,180):null});onState(state);};
 function retire(run){
  if(!run)return;if(active===run)active=null;
  run.controller.abort();run.queue.length=0;
  if(run.transport&&!run.transportClosed){run.transportClosed=true;run.transport.close();}
 }
 function fail(run,error){if(!current(run))return;retire(run);notify(run,'error',error);}
 function sourceCurrent(run){
  if(api.model!==run.model||run.model.disposed||run.model.store!==run.store||run.store.version!==run.version)throw new Error('Feed source changed outside this session');
 }
 function apply(run,fn){
  sourceCurrent(run);const version=run.store.version;fn();
  if(run.store.version!==version+1)throw new Error('Feed source changed during publication');
  run.version=run.store.version;
 }
 function drain(run){
  if(run.draining)return;run.draining=true;
  try{
   while(current(run)&&run.queue.length){
    const event=run.queue.shift();
    if(event.sequence<=run.cursor){run.duplicates++;continue;}
    if(event.sequence!==run.cursor+1)throw new Error('Feed sequence gap; reconnect with a new snapshot');
    if(event.kind==='append'&&run.store.length>=maxBars)throw new RangeError('Feed source bar budget');
    apply(run,()=>api.applyDataEvent({kind:event.kind,bar:event.bar}));
    if(!current(run))return;run.cursor=event.sequence;run.applied++;
   }
  }finally{run.draining=false;}
  if(current(run))notify(run,'live');
 }
 function receive(run,value){
  if(!current(run))return;
  try{
   const event=eventCopy(value);
   if(run.queue.length>=maxBufferedEvents)throw new RangeError('Feed snapshot buffer limit; reconnect explicitly');
   run.queue.push(event);if(run.phase==='live')drain(run);
  }catch(error){fail(run,error);}
 }
 async function connect(){
  if(disposed)throw new Error('Feed session closed');
  retire(active);
  const run={generation:++generation,controller:new AbortController(),model:api.model,store:api.model.store,version:api.model.store.version,queue:[],cursor:null,applied:0,duplicates:0,phase:'snapshot',draining:false,transport:null,transportClosed:false};
  active=run;notify(run,'loading');
  try{
   if(!current(run))return false;
   const transport=subscribe({signal:run.controller.signal,onEvent:value=>receive(run,value),onClose:error=>fail(run,error??new Error('Feed connection closed; reconnect explicitly'))});
   if(!transport||typeof transport.close!=='function'||!transport.ready?.then)throw new TypeError('Feed subscription must return ready and close');
   run.transport=transport;
   if(!current(run))retire(run);
   await untilAbort(transport.ready,run.controller.signal);
   if(!current(run))return false;
   const snapshot=await untilAbort(loadSnapshot({signal:run.controller.signal}),run.controller.signal);
   if(!current(run))return false;
   const cursor=sequence(snapshot?.lastSequence);
   if(!Array.isArray(snapshot?.bars)||snapshot.bars.length>maxBars)throw new RangeError('Feed snapshot bar budget');
   const staged=new BarStore(snapshot.bars,{maxBars}),events=[];let last=cursor,duplicates=0;
   for(const event of run.queue){
    if(event.sequence<=last){duplicates++;continue;}
    if(event.sequence!==last+1)throw new Error('Feed sequence gap in snapshot buffer');
    events.push({kind:event.kind,bar:event.bar});last=event.sequence;
   }
   if(events.length)staged.applyEvents(events);
   sourceCurrent(run);run.queue.length=0;run.cursor=last;run.applied=events.length;run.duplicates=duplicates;
   apply(run,()=>api.setColumns(staged.columns,staged.length));
   if(!current(run))return false;
   run.phase='live';drain(run);return current(run);
  }catch(error){if(current(run))fail(run,error);return false;}
 }
 return {
  connect,
  disconnect(){const run=active;retire(run);if(!disposed)notify(run,'disconnected');},
  dispose(){if(disposed)return;const run=active;disposed=true;retire(run);notify(run,'closed');},
  snapshot(){return state;},
 };
}
