import {modelRequest,configurationKey,hydrateModel,installRecomputed,requestOptionsSnapshot,validatePreparedPacketAsync} from './worker-state.mjs';
import {UnsupportedIndicatorError} from '../core/indicator-modules.mjs';
import {acquireDataIngestionLease,dataIngestionBatchLimits} from '../core/ingestion.mjs';
const aborted=()=>new DOMException('Calculation cancelled','AbortError');
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const malformedWorkerReply=()=>new TypeError('Malformed Calculation Worker response');
function validProgress(value){return record(value)&&own(value,'done')&&Number.isFinite(value.done)&&value.done>=0&&own(value,'total')&&Number.isFinite(value.total)&&value.total>=0&&value.done<=value.total&&(!own(value,'phase')||typeof value.phase==='string'&&value.phase.length>0);}
async function operationDeadline(options,work){
 const timeoutMs=options.timeoutMs===undefined?30000:options.timeoutMs;
 if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw new RangeError('Calculation timeout must be positive and at most 120000ms');
 const originalSignal=options.signal;if(originalSignal!==undefined&&(!originalSignal||typeof originalSignal.addEventListener!=='function'||typeof originalSignal.removeEventListener!=='function'||typeof originalSignal.aborted!=='boolean'))throw new TypeError('Calculation AbortSignal required');if(originalSignal?.aborted)throw aborted();
 const controller=new AbortController(),timeoutError=new Error('Calculation timeout');timeoutError.name='TimeoutError';
 const now=()=>globalThis.performance?.now?.()??Date.now(),expires=now()+timeoutMs;let stoppedError=null,rejectStopped,commitStarted=false,listenerAttempted=false,listenerRemoved=false;
 const stopped=new Promise((_resolve,reject)=>{rejectStopped=reject;});
 // Registration can throw or abort before the race is installed. Its rejection
 // is still returned through stoppedError, and never left unobserved internally.
 stopped.catch(()=>{});
 const stop=error=>{if(stoppedError||commitStarted)return;stoppedError=error;controller.abort();rejectStopped(error);};
 const cancel=()=>stop(aborted()),timer=setTimeout(()=>stop(timeoutError),timeoutMs);
 const check=()=>{if(!stoppedError&&!commitStarted&&originalSignal?.aborted)cancel();if(!stoppedError&&!commitStarted&&now()>=expires)stop(timeoutError);if(stoppedError)throw stoppedError;};
 // Cancellation is checked immediately before the atomic publication point.
 // Reentrant observer cancellation after commit starts cannot undo that commit.
 const detach=()=>{if(listenerAttempted&&!listenerRemoved){listenerRemoved=true;originalSignal.removeEventListener('abort',cancel);}};
 // Signal methods/getters may synchronously reenter host APIs. Detach and read
 // its final abort status before validating the source, with no signal callback
 // between that validation and the publication point.
 const commit=validateSource=>{check();clearTimeout(timer);detach();check();validateSource?.();commitStarted=true;};
 let result,failed=false,failure;
 try{if(originalSignal){listenerAttempted=true;originalSignal.addEventListener('abort',cancel,{once:true});if(originalSignal.aborted)cancel();}check();result=await Promise.race([work({...options,signal:controller.signal,timeoutMs},check,commit),stopped]);}
 catch(error){failed=true;failure=stoppedError??error;if(!commitStarted)controller.abort();}
 finally{clearTimeout(timer);try{detach();}catch(error){if(!failed){failed=true;failure=error;}}}
 if(failed)throw failure;return result;
}
export function runChartWorker(request,{signal,onProgress=()=>{},timeoutMs=30000,workerURL}={}){
 return new Promise((resolve,reject)=>{
  if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw new RangeError('Calculation timeout must be positive and at most 120000ms');
  if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('Calculation AbortSignal required');
  if(typeof onProgress!=='function')throw new TypeError('Calculation progress callback required');
  if(signal?.aborted){reject(aborted());return;}
  let worker,timeout,settled=false,listenerAttempted=false;
  const finish=(error,packet)=>{
   if(settled)return;settled=true;clearTimeout(timeout);
   // Cleanup failure must neither skip termination nor hide the operation error.
   try{if(listenerAttempted)signal.removeEventListener('abort',cancel);}catch(cleanup){error??=cleanup;}
   try{const termination=worker?.terminate?.();if(termination&&typeof termination.then==='function')Promise.resolve(termination).catch(()=>{});}catch(cleanup){error??=cleanup;}
   error?reject(error):resolve(packet);
  };
  const cancel=()=>finish(aborted());
  try{
   // Keep the default constructor literal so module-worker aware bundlers can emit it.
   worker=workerURL===undefined?new Worker(new URL('./compute-worker.mjs',import.meta.url),{type:'module'}):new Worker(workerURL,{type:'module'});
   const timeoutError=new Error('Calculation timeout');timeoutError.name='TimeoutError';
   timeout=setTimeout(()=>finish(timeoutError),timeoutMs);
   if(signal){listenerAttempted=true;signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();}
   if(settled)return;
   worker.onerror=e=>finish(new Error(e.message||'Worker failed'));
   worker.onmessage=event=>{if(settled)return;try{
    const data=event&&typeof event==='object'?event.data:undefined;if(!record(data))throw malformedWorkerReply();
    const keys=['progress','error','packet'].filter(key=>own(data,key));if(keys.length!==1)throw malformedWorkerReply();
    const [key]=keys;
    if(key==='progress'){if(!validProgress(data.progress))throw malformedWorkerReply();try{onProgress(data.progress);}catch{}return;}
    if(key==='error'){
     if(typeof data.error!=='string'||data.error.length===0||data.error.length>256)throw malformedWorkerReply();
     if(own(data,'errorName')&&typeof data.errorName!=='string'||own(data,'errorCode')&&typeof data.errorCode!=='string')throw malformedWorkerReply();
     const error=data.errorName==='UnsupportedIndicatorError'&&data.errorCode==='UNSUPPORTED_INDICATOR_MODULE'?new UnsupportedIndicatorError(''):new Error(data.error);if(error instanceof UnsupportedIndicatorError)error.message=data.error.slice(0,256);finish(error);return;
    }
    if(!record(data.packet))throw malformedWorkerReply();finish(null,data.packet);
   }catch(error){finish(error);}};
   worker.postMessage(request);
  }catch(error){finish(error);}
 });
}
export async function prepareChartModel(request,options={}){
 return operationDeadline(options,async(active,check,commit)=>{
  check();const expected=requestOptionsSnapshot(request.options??{}),snapshot={...request,options:expected};check();const packet=await runChartWorker(snapshot,active);check();const validation=await validatePreparedPacketAsync(packet,expected,active);check();
  const model=hydrateModel(packet,expected,validation);try{commit();return model;}catch(error){model.dispose();throw error;}
 });
}
export async function recomputeInWorker(model,event,options={}){
 const release=acquireDataIngestionLease(model);try{return await operationDeadline(options,async(active,check,commit)=>{
  check();if(model.disposed)throw new Error('Model disposed');const eventSnapshot=structuredClone(event);const sourceStore=model.store,version=sourceStore.version,key=configurationKey(model),expected=requestOptionsSnapshot(modelRequest(model)),request={columns:Object.fromEntries(Object.entries(sourceStore.columns).map(([k,a])=>[k,a.subarray(0,sourceStore.length)])),length:sourceStore.length,event:eventSnapshot,options:expected};
  const current=()=>{check();if(model.disposed||model.store!==sourceStore||sourceStore.version!==version||configurationKey(model)!==key)throw new Error('Data/configuration changed; stale worker result discarded');modelRequest(model);};
  const batchLimits=dataIngestionBatchLimits(model,eventSnapshot);if(batchLimits)request.batchLimits=batchLimits;const packet=await runChartWorker(request,active);current();const validation=await validatePreparedPacketAsync(packet,expected,active);current();installRecomputed(model,packet,eventSnapshot,expected,validation,()=>{commit(current);release();});return model;
 });}finally{release?.();}
}

export {resampleOHLCVAsync} from './resample-async.mjs';
export {setIndicatorParamsAsync} from './indicator-params-async.mjs';

export {prepareWorkspaceAsync} from './workspace-async.mjs';
