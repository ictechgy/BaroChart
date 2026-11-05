import {runRustParamsJob} from './params-job.mjs';
import {runRustPrepareJob} from './prepare-job.mjs';
import {runRustMigrationJob} from './migration-job.mjs';
import {runRustCaptureJob} from './capture-job.mjs';

const READ_COMMANDS=new Set(['dataAt','crosshairSnapshot','crosshairValues','indicatorValues','indicatorValueAt','saveStudies','positionMetrics','saveDrawings','saveDataIngestion','dataIngestionStats','inspect']);
const WEB_QUERIES=new Set(['web.capabilities','web.presentationState','web.configuration','web.drawingsState','web.indicatorCatalog','web.layoutCapture','web.layoutReferences']);
const INTERACTIONS=new Set(['nativePointer','nativeWheel','nativeKey','nativeTool','nativeHoverExit','nativeResize','nativeView']);
const PARAMS_OPERATIONS=['Begin','Step','Check','Receive','ArmWrite','Checkpoint','Validate','Prepare','Publish','Status','Abort'].map(suffix=>'web.paramsSource'+suffix);
const MIGRATION_OPERATIONS=[...['Begin','Step','UiBegin','UiNext','Check','Finish','Abort'].map(suffix=>'web.migrationSource'+suffix),...['Create','Start','Step','UiBegin','UiChunk','UiFinish','Abort'].map(suffix=>'web.migrationTarget'+suffix)];
const CORE_OPERATIONS=['nativeInit','nativeCommand','nativeScenePacket','nativeSaveWorkspace','nativePrepareBegin','nativePrepareCreate','nativeAsyncBuffer','nativeAsyncTargetBuffer','nativeAsyncStart','nativeAsyncStep','nativeAsyncUIBegin','nativeAsyncUINext','nativeAsyncUICheck','nativeAsyncUIImportBegin','nativeAsyncUIImportChunk','nativeAsyncUIImportEnd','nativeAsyncFinish','nativeAsyncRelease','nativeParamsTargetCreate','nativeParamsTargetStart','nativeParamsTargetStep','nativeParamsTargetDescriptor','nativeParamsTargetCheckpoint','nativeWorkspaceTargetCreate','nativeWorkspaceTargetFinish'];
function checkActorCapabilities(actor){if(CORE_OPERATIONS.some(name=>!actor.initialCapabilities?.implemented?.includes(name)))throw new RustSessionError('Required Rust actor job protocol is unavailable',{code:'CAPABILITY_MISMATCH'});}
function checkCapabilities(capabilities){
 if(capabilities?.schema!=='aster.web-wasm.capabilities'||capabilities.version!==1||[...WEB_QUERIES,'web.applyLayoutFrame',...PARAMS_OPERATIONS,...MIGRATION_OPERATIONS].some(name=>!capabilities.implemented?.includes(name))||!capabilities.typedReads?.includes('web.dataColumn')||!Number.isSafeInteger(capabilities.maxTransfer)||capabilities.maxTransfer<1||capabilities.maxTransfer>262144)throw new RustSessionError('Required Rust web protocol is unavailable',{code:'CAPABILITY_MISMATCH'});
 return capabilities;
}
function owned(value){return structuredClone(value);}
function immutable(value){
 const stack=[value],seen=new Set();
 while(stack.length){const next=stack.pop();if(!next||typeof next!=='object'||seen.has(next))continue;seen.add(next);if(ArrayBuffer.isView(next))throw new TypeError('Bulk arrays are not presentation snapshots');for(const child of Object.values(next))stack.push(child);Object.freeze(next);}
 return value;
}
export class RustSessionError extends Error {
 constructor(message,{code='SESSION',cause}={}){super(message,{cause});this.name='RustSessionError';this.code=code;}
}

/** Stable asynchronous owner of one actor and at most one attached view. */
export class RustSession {
 #actor;#chain=Promise.resolve();#state=null;#revision=0;#nextCommand=1;#listeners=new Set();#closed=false;#desynced=false;#quarantined=false;#closePromise=null;#view=null;#lastOutcome=null;#notificationErrors=0;#createActor;#registration=0;#job=null;#maxTransfer;
 constructor(actor,{createActor,maxTransfer=262144}={}){this.#actor=actor;this.#createActor=createActor;this.#maxTransfer=maxTransfer;}
 get backend(){return 'rust-wasm';}
 get generation(){return this.#actor.generation;}
 get closed(){return this.#closed;}
 get quarantined(){return this.#quarantined||this.#actor.quarantined===true;}
 get requiresResync(){return this.#desynced;}
 get notificationErrors(){return this.#notificationErrors;}
 get activeJob(){return this.#job?.kind??null;}
 get lastOutcome(){return this.#lastOutcome?Object.freeze({...this.#lastOutcome}):null;}
 #check(mutation=false,admitted=false){
  if(this.#closed)throw new RustSessionError('Rust session is closed',{code:'CLOSED'});
  if(this.quarantined)throw new RustSessionError('Rust session is quarantined; recreate it explicitly',{code:'QUARANTINED'});
  if(mutation&&this.#desynced)throw new RustSessionError('Rust session requires explicit resync before another mutation',{code:'RESYNC_REQUIRED'});
  if(mutation&&!admitted&&this.#job&&this.#job.kind!=='params')throw new RustSessionError('Rust candidate job owns the source safe point',{code:'JOB_BUSY'});
 }
 #enqueue(work){const task=this.#chain.then(work);this.#chain=task.catch(()=>{});return task;}
 #fatal(error){if(error?.quarantine===true||error?.quarantined===true||this.#actor.quarantined===true)this.#quarantined=true;}
 #prepareSnapshot(value,generation=this.generation,revision=this.#revision){
  if(value?.schema!=='aster.web-wasm.presentation'||value.version!==1||!value.data||!value.view)throw new RustSessionError('Invalid Rust presentation snapshot',{code:'BAD_SNAPSHOT'});
  return immutable({...owned(value),generation,revision});
 }
 #publish(value){return this.#installSnapshot(this.#prepareSnapshot(value));}
 #installSnapshot(snapshot){
  this.#state=snapshot;
  for(const listener of [...this.#listeners]){
   if(this.#closed)break;if(!this.#listeners.has(listener))continue;
   try{const result=listener(snapshot);if(result&&typeof result.then==='function')result.catch(()=>{this.#notificationErrors++;});}catch{this.#notificationErrors++;}
  }
  return snapshot;
 }
 snapshot(){this.#check();return this.#state;}
 subscribe(listener,{emitCurrent=false}={}){
  this.#check();if(typeof listener!=='function')throw new TypeError('Snapshot listener required');
  this.#listeners.add(listener);
  if(emitCurrent&&this.#state){try{const value=listener(this.#state);if(value?.then)value.catch(()=>{this.#notificationErrors++;});}catch{this.#notificationErrors++;}}
  return ()=>this.#listeners.delete(listener);
 }
 async resync(){return this.#enqueue(async()=>{this.#check();try{const state=await this.#actor.call('web.presentationState',[]);this.#check();const result=this.#publish(state);this.#desynced=false;return result;}catch(error){this.#fatal(error);this.#desynced=true;throw error;}});}
 async invoke(name,args=[]){
  if(!INTERACTIONS.has(name))throw new TypeError('Supported Rust chart interaction required');
  return this.#mutate(name,args);
 }
 async #mutate(name,args=[]){
  if(typeof name!=='string'||!Array.isArray(args))throw new TypeError('Rust function name and argument array required');
  this.#check(true);
  const input=owned(args);
  return this.#enqueue(async()=>{
   this.#check(true,true);
   if(!Number.isSafeInteger(this.#nextCommand)||!Number.isSafeInteger(this.#revision+1))throw new RustSessionError('Rust session sequence exhausted',{code:'SEQUENCE_EXHAUSTED'});
   const outcome={id:this.#nextCommand++,operation:name,phase:'prepared',status:null};this.#lastOutcome=outcome;
   let value,primary;
   try{outcome.phase='entered';value=await this.#actor.call(name,input);outcome.status=0;}catch(error){primary=error;outcome.status=error?.status??null;this.#fatal(error);}
   if(this.#closed){outcome.phase='closed';throw primary??new RustSessionError('Rust session is closed',{code:'CLOSED'});}
   if(this.quarantined){outcome.phase='quarantined';throw primary??new RustSessionError('Rust session is quarantined',{code:'QUARANTINED'});}
   this.#revision++;
   try{const state=await this.#actor.call('web.presentationState',[]);this.#check();this.#publish(state);outcome.phase=primary?'failed':'completed';}
   catch(error){this.#fatal(error);this.#desynced=true;outcome.phase='resync-required';if(primary)throw primary;throw new RustSessionError('Rust command completed but presentation requires explicit resync',{code:'RESYNC_REQUIRED',cause:error});}
   if(primary)throw primary;return value;
  });
 }
 async command(operation,args=[]){
  if(typeof operation!=='string'||!Array.isArray(args))throw new TypeError('Rust command and argument array required');
  if(operation==='registerIndicator'||operation==='registerIndicatorSource')return this.registerIndicatorSource();
  if(!READ_COMMANDS.has(operation))return this.#mutate('nativeCommand',[operation,args]);
  const input=owned(args);return this.#enqueue(async()=>{this.#check();try{return await this.#actor.call('nativeCommand',[operation,input]);}catch(error){this.#fatal(error);throw error;}});
 }
 async query(name,args=[]){
  if(!WEB_QUERIES.has(name)||!Array.isArray(args))throw new TypeError('Read-only Rust web query required');
  const input=owned(args);return this.#enqueue(async()=>{this.#check();try{return await this.#actor.call(name,input);}catch(error){this.#fatal(error);throw error;}});
 }
 async packet(args){if(this.#job?.safePoint)throw new RustSessionError('Rust scene requests are paused at the migration safe point',{code:'JOB_BUSY'});const input=owned(args);return this.#enqueue(async()=>{this.#check();try{return {...await this.#actor.packet(input),generation:this.generation,revision:this.#revision};}catch(error){this.#fatal(error);throw error;}});}
 async readDataColumn(field,start,count,expectedVersion=this.#state?.data.version){
  if(!Number.isSafeInteger(count)||count<0||count>this.#maxTransfer)throw new RangeError('Negotiated Rust data transfer limit');
  return this.#enqueue(async()=>{this.#check();try{return await this.#actor.readF64('web.dataColumn',[field,start,count,expectedVersion]);}catch(error){this.#fatal(error);throw error;}});
 }
 async exportColumns({maxBars=Number.MAX_SAFE_INTEGER}={}){
  if(!Number.isSafeInteger(maxBars)||maxBars<0)throw new RangeError('Data export limit');
  return this.#enqueue(async()=>{
   this.#check();
   try{
    const before=await this.#actor.call('web.presentationState',[]);this.#check();
    const {length,version}=before.data;
    if(!Number.isSafeInteger(length)||length<0||length>maxBars)throw new RangeError('Data export bar limit');
    const columns={};
    for(const field of ['time','open','high','low','close','volume']){
     const values=new Float64Array(length);
     for(let start=0;start<length;start+=this.#maxTransfer){this.#check();const count=Math.min(this.#maxTransfer,length-start),chunk=await this.#actor.readF64('web.dataColumn',[field,start,count,version]);this.#check();if(chunk.length!==count)throw new RustSessionError('Data export length mismatch',{code:'BAD_EXPORT'});values.set(chunk,start);}
     columns[field]=values;
    }
    const after=await this.#actor.call('web.presentationState',[]);this.#check();
    if(after.data.length!==length||!Object.is(after.data.version,version))throw new RustSessionError('Data export source changed',{code:'STALE_EXPORT'});
    return {columns,length,version,generation:this.generation};
   }catch(error){this.#fatal(error);throw error;}
  });
 }
 async memoryStats(){return this.#enqueue(async()=>{this.#check();return this.#actor.memoryStats();});}
 #protocol(method,name,args=[],values){
  const input=owned(args),buffer=values?.slice();
  return this.#enqueue(async()=>{this.#check();try{const result=await this.#actor[method](name,input,...(buffer?[buffer]:[]));this.#check();return result;}catch(error){this.#fatal(error);throw error;}});
 }
 async setIndicatorParams(id,params,options={}){
  this.#check(true);
  if(this.#job)throw new RustSessionError('A Rust session job is already active',{code:'JOB_BUSY'});
  const signal=options.signal;
  if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');
  const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const job={kind:'params',controller};this.#job=job;
  const port={
   call:(name,args)=>name==='web.paramsSourcePublish'?this.#mutate(name,args):this.#protocol('call',name,args),
   readF64:(name,args)=>this.#protocol('readF64',name,args),
   writeF64:(name,args,values)=>this.#protocol('writeF64',name,args,values),
   createTargetActor:()=>{this.#check();if(!this.#createActor)throw new RustSessionError('Session has no candidate actor factory',{code:'NO_ACTOR_FACTORY'});return this.#createActor({signal:controller.signal});},
   nextRegistration:()=>{if(!Number.isSafeInteger(this.#registration+1))throw new RustSessionError('Rust job registration exhausted',{code:'SEQUENCE_EXHAUSTED'});return ++this.#registration;},
   revision:()=>this.#revision,paramsChunkLimit:Math.min(this.#maxTransfer,16384),paramsStepLimit:16384,
  };
  try{return await runRustParamsJob(port,id,params,{...options,signal:controller.signal});}
  catch(error){if(error?.resyncRequired)this.#desynced=true;this.#fatal(error);throw error;}
  finally{signal?.removeEventListener('abort',cancel);if(this.#job===job)this.#job=null;}
 }
 async applyLayoutFrame(frame){return this.#mutate('web.applyLayoutFrame',[frame]);}
 async registerIndicatorSource(){this.#check();throw new RustSessionError('Custom indicator source requires the JavaScript backend',{code:'JAVASCRIPT_BACKEND_REQUIRED'});}
 async saveWorkspace(binding){return this.#protocol('call','nativeSaveWorkspace',[binding]);}
 async #promoteActor(candidate,job){
  return this.#enqueue(async()=>{
   this.#check();if(this.#job!==job||job.controller.signal.aborted)throw new DOMException('Rust candidate activation aborted','AbortError');
   if(!candidate||candidate===this.#actor||typeof candidate.call!=='function'||typeof candidate.close!=='function')throw new TypeError('Independent Rust candidate actor required');
   checkActorCapabilities(candidate);
   const capabilities=checkCapabilities(await candidate.call('web.capabilities',[]));
   const value=await candidate.call('web.presentationState',[]),revision=this.#revision+1;
   if(!Number.isSafeInteger(revision))throw new RustSessionError('Rust session sequence exhausted',{code:'SEQUENCE_EXHAUSTED'});
   const snapshot=this.#prepareSnapshot(value,candidate.generation,revision),view=this.#view;
   let staged;
   try{
    if(view){
     if(typeof view.promotionSize!=='function'||typeof view.stagePresentation!=='function')throw new RustSessionError('Attached view cannot stage a Rust candidate',{code:'VIEW_PROMOTION_UNSUPPORTED'});
     const size=view.promotionSize(),packet=await candidate.packet(['scene',null,size.width,size.height]);
     staged=view.stagePresentation({...packet,generation:candidate.generation,revision},snapshot);
    }
    this.#check();if(this.#job!==job||job.controller.signal.aborted||this.#view!==view)throw new DOMException('Rust candidate activation aborted','AbortError');
    staged?.commit();
   }catch(error){staged?.discard();throw error;}
   const previous=this.#actor;this.#actor=candidate;this.#revision=revision;this.#maxTransfer=capabilities.maxTransfer;this.#desynced=false;
   job.accepted=true;this.#installSnapshot(snapshot);
   try{await previous.close();}catch{this.#notificationErrors++;}
   return snapshot;
  });
 }
 async #candidateJob(kind,run,options={},activate=null){
  this.#check(true);if(this.#job)throw new RustSessionError('A Rust session job is already active',{code:'JOB_BUSY'});
  const signal=options.signal;
  if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');
  const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const job={kind,controller,accepted:false,safePoint:false};this.#job=job;const view=this.#view;let paused=false;
  const port={
   call:(name,args)=>this.#protocol('call',name,args),readF64:(name,args)=>this.#protocol('readF64',name,args),
   createTargetActor:()=>{this.#check();if(!this.#createActor)throw new RustSessionError('Session has no candidate actor factory',{code:'NO_ACTOR_FACTORY'});return this.#createActor({signal:controller.signal});},
   nextRegistration:()=>{if(!Number.isSafeInteger(this.#registration+1))throw new RustSessionError('Rust job registration exhausted',{code:'SEQUENCE_EXHAUSTED'});return ++this.#registration;},
   revision:()=>this.#revision+1,
  };
  try{
   await view?.flush?.();
   job.safePoint=true;if(view?.pausePresentation){view.pausePresentation();paused=true;}
   await this.#enqueue(()=>this.#check());
   const result=await run(port,{...options,signal:controller.signal,activate:activate??(async candidate=>{const snapshot=await this.#promoteActor(candidate.actor,job);candidate.handoff();return snapshot;})});
   if(activate)return result;
   return {status:'committed',generation:this.generation,snapshot:this.snapshot()};
  }catch(error){this.#fatal(error);throw error;}
  finally{signal?.removeEventListener('abort',cancel);if(this.#job===job)this.#job=null;if(paused)view.resumePresentation?.();}
 }
 async prepareData(input,options={}){return this.#candidateJob('prepare',(port,settings)=>runRustPrepareJob(port,input,settings),options);}
 async recreate({binding={key:'barochart-web',revision:'1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'},...options}={}){
  return this.#candidateJob('migration',async(port,settings)=>{const document=await port.call('nativeSaveWorkspace',[binding]);return runRustMigrationJob(port,document,binding,settings);},options);
 }
 async withMigrationCapture(binding,{consume,activate,...options}={}){
  if(typeof consume!=='function'||typeof activate!=='function')throw new TypeError('Migration consume and activation callbacks required');
  return this.#candidateJob('migration',async(port,settings)=>{const document=await port.call('nativeSaveWorkspace',[binding]);return runRustCaptureJob(port,document,binding,{...settings,consume});},options,activate);
 }
 claimView(view){this.#check();if(!view||this.#view)throw new RustSessionError('Rust session already has an attached view',{code:'VIEW_ATTACHED'});this.#view=view;}
 releaseView(view){if(this.#view===view)this.#view=null;}
 close(){
  if(this.#closePromise)return this.#closePromise;
  this.#closed=true;this.#job?.controller.abort();this.#listeners.clear();const view=this.#view;this.#view=null;
  this.#closePromise=Promise.resolve().then(async()=>{try{view?.onSessionClose?.();}finally{await this.#actor.close();}});
  return this.#closePromise;
 }
}

export async function openRustSession(actor,{count=0,options=null,createActor}={}){
 try{
  checkActorCapabilities(actor);
  const capabilities=await actor.call('web.capabilities',[]);
  checkCapabilities(capabilities);
  await actor.call('nativeInit',[count,options]);
  const session=new RustSession(actor,{createActor,maxTransfer:capabilities.maxTransfer});await session.resync();return session;
 }catch(error){try{await actor.close();}catch{}throw error;}
}

/** Adopt an already prepared private actor without resetting its model. */
export async function adoptRustSession(actor,{createActor}={}){
 try{checkActorCapabilities(actor);const capabilities=checkCapabilities(await actor.call('web.capabilities',[]));const session=new RustSession(actor,{createActor,maxTransfer:capabilities.maxTransfer});await session.resync();return session;}
 catch(error){try{await actor.close();}catch{}throw error;}
}
