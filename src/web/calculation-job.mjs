// Shared owner-side lifecycle for bounded, dedicated-worker calculations.
const CALCULATION_JOB_BYTES=256*1024*1024,CALCULATION_TOTAL_BYTES=512*1024*1024;
let calculationActiveJobs=0,calculationReservedBytes=0,calculationNextId=0;
export function calculationJobStats(){return {activeJobs:calculationActiveJobs,reservedBytes:calculationReservedBytes};}
function calculationError(name,message){const error=new Error(message);error.name=name;return error;}
export async function runCalculationJob(options,work){
 const signal=options.signal;if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('Calculation AbortSignal required');if(signal?.aborted)throw calculationError('AbortError','Calculation cancelled');
 const timeout=options.timeoutMs??30000;if(!Number.isFinite(timeout)||timeout<=0||timeout>120000)throw new RangeError('Calculation timeout: 0..120000ms');
 const onProgress=options.onProgress;if(onProgress!==undefined&&typeof onProgress!=='function')throw new TypeError('Calculation progress callback required');
 const now=()=>performance.now(),started=now(),deadline=started+timeout,cleanups=[],stoppers=new Set();let stopped=null,reserved=0,registered=false,committed=false,timer,publication;
 // Amortize cheap units without starving timers on fast/coarse clocks. This is
 // cooperative: a single provider call, allocation or chunk is not preemptible.
 let sliceStarted=started,sliceUnits=0;
 const stop=error=>{if(stopped||committed)return;stopped=error;for(const fn of stoppers){try{fn(error);}catch{}}};
 const cancel=()=>stop(calculationError('AbortError','Calculation cancelled'));
 const check=()=>{if(!committed&&signal?.aborted)cancel();if(!committed&&now()>=deadline)stop(calculationError('TimeoutError','Calculation timeout'));if(stopped)throw stopped;};
 const context={id:++calculationNextId,check,publish(fn){if(publication||typeof fn!=='function')throw new TypeError('Calculation publication hook');publication=fn;},current:()=>{},guard(){context.current();},reserve(bytes){check();if(reserved)throw new Error('Calculation budget already reserved');if(!Number.isSafeInteger(bytes)||bytes<1||bytes>CALCULATION_JOB_BYTES||calculationActiveJobs>=2||calculationReservedBytes+bytes>CALCULATION_TOTAL_BYTES)throw calculationError('RangeError','Calculation job or in-flight byte budget exceeded');reserved=bytes;calculationActiveJobs++;calculationReservedBytes+=bytes;},onStop(fn){stoppers.add(fn);if(stopped)fn(stopped);return ()=>stoppers.delete(fn);},cleanup(fn){cleanups.push(fn);},async yield(){check();context.current();if(++sliceUnits>=8||now()-sliceStarted>=1){await new Promise(resolve=>setTimeout(resolve,0));sliceStarted=now();sliceUnits=0;}check();context.current();},progress(phase,done,total){try{onProgress?.({phase,done,total});}catch{}check();context.current();}};
 const detach=()=>{if(registered){registered=false;signal.removeEventListener('abort',cancel);}};
 let result,error;
 try{
  timer=setTimeout(()=>stop(calculationError('TimeoutError','Calculation timeout')),timeout);
  if(signal){registered=true;signal.addEventListener('abort',cancel,{once:true});}check();result=await work(context);check();
 }catch(failure){error=stopped??failure;}
 // Terminate and drop transport ownership before the final source/publication
 // check. Cleanup callbacks can reenter; no user callback follows that check.
 for(const cleanup of cleanups.reverse()){try{await cleanup();}catch(failure){error??=failure;}}
 try{detach();check();if(!error){context.current();check();context.guard();if(publication)result=publication();committed=true;}}catch(failure){error??=stopped??failure;}
 clearTimeout(timer);stoppers.clear();cleanups.length=0;context.current=()=>{};context.guard=()=>{};publication=null;
 if(reserved){calculationReservedBytes-=reserved;calculationActiveJobs--;reserved=0;}
 if(error)throw error;return result;
}
export function runDedicatedCalculationWorker(request,url,options,context,transfer){
 return new Promise((resolve,reject)=>{
  let worker,done=false,unstop=()=>{},termination;
  const finish=(error,packet)=>{if(done)return;done=true;unstop();try{if(worker){worker.onmessage=null;worker.onerror=null;}}catch(failure){error??=failure;}error?reject(error):resolve(packet);};
  context.cleanup(async()=>{unstop();if(worker){let failure;try{worker.onmessage=null;worker.onerror=null;}catch(error){failure=error;}try{termination??=worker.terminate();await termination;}catch(error){failure??=error;}finally{worker=null;}if(failure)throw failure;}});
  try{
   context.check();const factory=options.workerFactory;if(factory!==undefined&&typeof factory!=='function')throw new TypeError('Worker factory required');
   worker=factory?factory(url):new Worker(url,{type:'module'});context.check();context.current();
   if(!worker||typeof worker.postMessage!=='function'||typeof worker.terminate!=='function')throw new TypeError('Dedicated Worker interface required');
   unstop=context.onStop(error=>finish(error));if(done)return;
   worker.onerror=event=>finish(new Error(typeof event?.message==='string'?event.message.slice(0,256):'Calculation Worker failed'));
   worker.onmessage=event=>{if(done)return;try{context.check();context.current();finish(null,event.data);}catch(error){finish(error);}};
   worker.postMessage(request,transfer);context.check();context.current();
  }catch(error){finish(error);}
 });
}
