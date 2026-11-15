import {loadRustBackend} from './wasm/backend.mjs';
import {createRustChart} from './wasm/chart.mjs';
import {snapshotRustChartCreation} from './rust-default-options.mjs';

function abortError(){const error=new Error('Rust chart creation aborted');error.name='AbortError';return error;}
function recordCleanup(error,work){
 let result;try{result=work();}catch(cleanupError){appendCleanup(error,cleanupError);return;}
 Promise.resolve(result).catch(cleanupError=>appendCleanup(error,cleanupError));
}
function appendCleanup(error,cleanupError){
 const prior=Array.isArray(error.cleanupErrors)?error.cleanupErrors:[];
 if(prior.includes(cleanupError))return;
 Object.defineProperty(error,'cleanupErrors',{value:Object.freeze([...prior,cleanupError]),configurable:true});
 if(!Object.hasOwn(error,'cause'))Object.defineProperty(error,'cause',{value:cleanupError,configurable:true});
}
function abortable(value,signal,{abort,late}={}){
 if(!signal)return Promise.resolve(value);
 const task=Promise.resolve(value);
 if(signal.aborted){const error=abortError();if(abort)recordCleanup(error,abort);task.then(value=>{if(late)recordCleanup(error,()=>late(value));},_error=>undefined);return Promise.reject(error);}
 return new Promise((resolve,reject)=>{
  let settled=false,cancellation=null;
  const onAbort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);cancellation=abortError();if(abort)recordCleanup(cancellation,abort);reject(cancellation);};
  signal.addEventListener('abort',onAbort,{once:true});
  task.then(value=>{if(settled){if(cancellation&&late)recordCleanup(cancellation,()=>late(value));return;}settled=true;signal.removeEventListener('abort',onAbort);resolve(value);},error=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);reject(error);});
 });
}
async function cleanup(chart,closeSession){
 const errors=[];
 try{if(chart)await chart.destroy();}catch(error){errors.push(error);}
 try{await closeSession();}catch(error){errors.push(error);}
 if(errors.length===1)throw errors[0];
 if(errors.length>1)throw new AggregateError(errors,'Rust chart cleanup failed',{cause:errors[0]});
}
function creationFailure(primary,cleanupError){
 const cleanupErrors=cleanupError instanceof AggregateError?[...cleanupError.errors]:[cleanupError];
 return new AggregateError([primary,...cleanupErrors],'Rust chart creation and cleanup failed',{cause:primary});
}

/** Creates one Rust-owned session and chart. The returned owner is the only lifecycle owner. */
export function createBaroChart(container,options={}){return createBaroChartFromSnapshot(snapshotRustChartCreation(container,options));}
export async function createBaroChartFromSnapshot(snapshot){
 const {container,backend:backendInput,load,session:sessionOptions,prepare,prepareOptions,view,signal}=snapshot;
 let session,chart,sessionClosePromise=null;
 const closeSession=()=>{if(!session)return Promise.resolve();if(!sessionClosePromise)sessionClosePromise=Promise.resolve().then(()=>session.close());return sessionClosePromise;};
 try{
  const backend=backendInput===undefined
   ?await abortable(loadRustBackend({...load,signal}),signal)
   :await abortable(backendInput,signal);
  if(!backend||backend.backend!=='rust-wasm'||typeof backend.createSession!=='function')throw new TypeError('Rust backend required');
  const creating=Promise.resolve().then(()=>backend.createSession({...sessionOptions,signal}));
  session=await abortable(creating,signal,{late:value=>value?.close?.()});
  if(!session||typeof session.close!=='function')throw new TypeError('Rust session required');
  if(prepare!==undefined){
   if(typeof session.prepareData!=='function')throw new TypeError('Rust prepared session required');
   await abortable(Promise.resolve().then(()=>session.prepareData(prepare,{...prepareOptions,signal})),signal,{abort:closeSession});
  }
  if(signal?.aborted)throw abortError();
  chart=await abortable(createRustChart(container,session,view),signal,{abort:closeSession,late:value=>cleanup(value,closeSession)});
  if(signal?.aborted)throw abortError();
 }catch(error){
  let cleanupFailed=false,cleanupError;try{await cleanup(chart,closeSession);}catch(failure){cleanupFailed=true;cleanupError=failure;}
  if(cleanupFailed&&error?.name==='AbortError'){
   const failures=cleanupError instanceof AggregateError?cleanupError.errors:[cleanupError];
   for(const failure of failures)appendCleanup(error,failure);
   throw error;
  }
  if(cleanupFailed)throw creationFailure(error,cleanupError);
  throw error;
 }
 let closed=false,destroyPromise=null;
 return Object.freeze({
  backend:'rust-wasm',session,chart,
  get closed(){return closed;},
  destroy(){if(destroyPromise)return destroyPromise;closed=true;destroyPromise=cleanup(chart,closeSession);return destroyPromise;},
 });
}
