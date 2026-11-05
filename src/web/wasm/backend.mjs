import {loadRustModule} from './runtime.mjs';
import {createRustActor} from './actor.mjs';
import {openRustSession,adoptRustSession} from './session.mjs';
import {defaultWasmURL} from './asset.mjs';

function aborted(){return new DOMException('Rust session creation aborted','AbortError');}
function signalCheck(signal){if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');}
const FIELDS=['time','open','high','low','close','volume'];
const yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0));
// Workspace metadata uses the checkpoint wire's signed-zero marker.
const workspaceMetadata=value=>JSON.stringify(value,(_key,item)=>typeof item==='number'&&Object.is(item,-0)?{$asterNumber:'-0'}:item);
function dataField(record,name){const descriptor=Object.getOwnPropertyDescriptor(record,name);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError('Rust migration requires own data properties');return descriptor.value;}
function snapshotColumns(columns){
 if(!columns||typeof columns!=='object')throw new TypeError('Workspace columns required');
 const source=Object.fromEntries(FIELDS.map(field=>[field,dataField(columns,field)])),length=source.time?.length;
 if(!Number.isSafeInteger(length)||length<0||length>4194304)throw new RangeError('Workspace bar count');
 const owned={};
 for(const field of FIELDS){const values=source[field];if(!(values instanceof Float64Array)||values.length!==length||typeof SharedArrayBuffer!=='undefined'&&values.buffer instanceof SharedArrayBuffer)throw new TypeError('Workspace owned Float64 columns required');owned[field]=values.slice();}
 return {columns:owned,length};
}
function snapshotStoreSource(source,size,length){
 if(!source||typeof source!=='object'||!size||typeof size!=='object')throw new TypeError('Workspace source and size descriptors required');
 const store=Object.fromEntries(['length','maxBars','timeframeMs','timeOrigin','version','timeVersion'].map(name=>[name,dataField(source,name)]));
 const dimensions=Object.fromEntries(['width','height'].map(name=>[name,dataField(size,name)]));
 if(store.length!==length||!Number.isSafeInteger(store.maxBars)||store.maxBars<length||store.maxBars>4194304||typeof store.timeframeMs!=='number'||!Number.isFinite(store.timeframeMs)||store.timeframeMs<=0||typeof store.timeOrigin!=='number'||!Number.isFinite(store.timeOrigin)||['version','timeVersion'].some(name=>!Number.isSafeInteger(store[name])||store[name]<0||store[name]>=Number.MAX_SAFE_INTEGER))throw new RangeError('Workspace source descriptor');
 if(['width','height'].some(name=>typeof dimensions[name]!=='number'||!Number.isFinite(dimensions[name])||dimensions[name]<1||dimensions[name]>32768)||dimensions.width*dimensions.height>16777216)throw new RangeError('Workspace size descriptor');
 return {source:store,size:dimensions};
}
async function withOwnedActor(createActor,setup,{signal,timeoutMs=120000}={}){
 signalCheck(signal);if(signal?.aborted)throw aborted();
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw new RangeError('Rust session creation timeout');
 const controller=new AbortController();let actor,stopped=false,rejectStop;
 const stop=new Promise((_resolve,reject)=>{rejectStop=reject;});
 const cancel=(error=aborted())=>{if(stopped)return;stopped=true;controller.abort();rejectStop(error);if(actor)void actor.close().catch(()=>{});};
 const onAbort=()=>cancel(),timer=setTimeout(()=>{const error=new Error('Rust session creation timed out');error.name='TimeoutError';cancel(error);},timeoutMs);
 signal?.addEventListener('abort',onAbort,{once:true});
 const check=()=>{if(stopped)throw aborted();};
 const task=(async()=>{try{actor=await createActor({signal:controller.signal});check();const session=await setup(actor,check);if(stopped){await session.close();throw aborted();}return session;}catch(error){if(actor)try{await actor.close();}catch{}throw error;}})();
 try{return await Promise.race([task,stop]);}
 catch(error){if(actor)try{await actor.close();}catch{}throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
async function fillColumns(actor,columns,length,check,onProgress){
 for(let slot=0;slot<FIELDS.length;slot++)for(let offset=0;offset<length;offset+=16384){
  check();const count=Math.min(16384,length-offset);
  if(await actor.writeF64('nativeAsyncTargetBuffer',[slot,offset,count],columns[FIELDS[slot]].subarray(offset,offset+count))!==true)throw new Error('Rust workspace input was not accepted');
  await onProgress?.({phase:'transfer',slot,done:offset+count,total:length});await yieldControl();
 }
}
async function computeWorkspace(actor,name,check,onProgress){
 check();await actor.call(name==='nativeAsyncStep'?'nativeAsyncStart':'web.migrationTargetStart',[]);
 for(;;){check();const raw=await actor.call(name,[16384]),progress=typeof raw==='string'?JSON.parse(raw):raw;if(!progress||typeof progress.complete!=='boolean')throw new TypeError('Rust workspace progress');await onProgress?.(progress);if(progress.complete)return;await yieldControl();}
}

/** Compiled code is shared; every created session owns a new Worker and memory. */
export async function loadRustBackend({source,wasmURL,workerURL,signal,timeoutMs}={}){
 signalCheck(signal);
 if(source!==undefined&&wasmURL!==undefined)throw new TypeError('Choose source or wasmURL');
 const loaded=await loadRustModule(source??wasmURL??defaultWasmURL(),{signal});
 const timings=Object.freeze({...loaded.timings});
 const createActor=({signal:actorSignal}={})=>createRustActor({module:loaded.module,workerURL,signal:actorSignal,timeoutMs});
 return Object.freeze({
  backend:'rust-wasm',timings,
  async createSession({count=0,options=null,signal:sessionSignal}={}){
   signalCheck(sessionSignal);if(sessionSignal?.aborted)throw aborted();
   let actor,stopped=false,rejectStop;
   const stop=new Promise((_resolve,reject)=>{rejectStop=reject;});
   const cancel=()=>{stopped=true;rejectStop(aborted());if(actor)void actor.close().catch(()=>{});};
   if(sessionSignal)sessionSignal.addEventListener('abort',cancel,{once:true});
   const task=(async()=>{
    actor=await createRustActor({module:loaded.module,workerURL,signal:sessionSignal,timeoutMs});
    if(stopped){await actor.close();throw aborted();}
    const session=await openRustSession(actor,{count,options,createActor:({signal:jobSignal}={})=>createRustActor({module:loaded.module,workerURL,signal:jobSignal,timeoutMs})});
    if(stopped){await session.close();throw aborted();}
    return session;
   })();
   try{return await (sessionSignal?Promise.race([task,stop]):task);}
   catch(error){if(actor&&!stopped)try{await actor.close();}catch{}throw error;}
   finally{sessionSignal?.removeEventListener('abort',cancel);}
  },
  async createSessionFromWorkspace({columns,document,binding,source:storeSource,size,dataIngestion,signal:sessionSignal,onProgress}={}){
   if(typeof document!=='string'||document.length>8388608||!binding||typeof binding!=='object')throw new TypeError('Workspace document and binding required');
   if(onProgress!==undefined&&typeof onProgress!=='function')throw new TypeError('Workspace progress callback required');
   if(dataIngestion!==undefined&&(typeof dataIngestion!=='string'||dataIngestion.length>32768))throw new TypeError('Canonical workspace ingestion document required');
   const input=snapshotColumns(columns),descriptors=snapshotStoreSource(storeSource,size,input.length),metadata=workspaceMetadata({schema:'aster.native-workspace-target',version:1,document,datasetBinding:structuredClone(binding),...descriptors,...(dataIngestion===undefined?{}:{dataIngestion}),retainedBytes:input.length*48+document.length*2+(dataIngestion?.length??0)*2,maxBytes:805306368});
   return withOwnedActor(createActor,async(actor,check)=>{
    await actor.call('nativeWorkspaceTargetCreate',[metadata]);check();
    await fillColumns(actor,input.columns,input.length,check,onProgress);await computeWorkspace(actor,'nativeAsyncStep',check,onProgress);
    check();await actor.call('nativeWorkspaceTargetFinish',[]);check();return adoptRustSession(actor,{createActor});
   },{signal:sessionSignal});
  },
  async createSessionFromMigration(capture,{signal:sessionSignal,onProgress}={}){
   if(!capture||typeof capture!=='object')throw new TypeError('Rust migration capture required');
   if(onProgress!==undefined&&typeof onProgress!=='function')throw new TypeError('Migration progress callback required');
   const metadataJSON=dataField(capture,'metadataJSON'),header=dataField(capture,'header'),uiChunks=dataField(capture,'uiChunks'),rawDescription=dataField(capture,'description'),rawColumns=dataField(capture,'columns');
   if(typeof metadataJSON!=='string'||typeof header!=='string'||!Array.isArray(uiChunks)||!rawDescription)throw new TypeError('Rust migration capture required');
   const description=structuredClone(rawDescription),chunks=structuredClone(uiChunks),input=snapshotColumns(rawColumns);
   const {workspaceTicket:ticket,workspaceRegistration:registration,sourceRevision:revision}=description;
   return withOwnedActor(createActor,async(actor,check)=>{
    await actor.call('web.migrationTargetCreate',[metadataJSON,ticket,registration,revision]);check();
    await fillColumns(actor,input.columns,input.length,check,onProgress);await computeWorkspace(actor,'web.migrationTargetStep',check,onProgress);
    check();await actor.call('web.migrationTargetUiBegin',[description,header]);
    for(const chunk of chunks){check();await actor.call('web.migrationTargetUiChunk',[chunk]);await yieldControl();}
    check();await actor.call('web.migrationTargetUiFinish',[ticket,registration,revision]);check();return adoptRustSession(actor,{createActor});
   },{signal:sessionSignal});
  },
 });
}
