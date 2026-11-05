import {ChartAPI} from '../../core/api.mjs';
import {InteractionController} from '../../core/interaction.mjs';
import {FIELDS} from '../../core/data.mjs';
import {NativeWorkspaceCapture} from '../../core/native-workspace-source.mjs';
import {NativeWorkspacePrepared,NATIVE_WORKSPACE_RESTORE_BYTES} from '../../core/native-workspace-target.mjs';
import {AsyncCapture,AsyncPrepared} from '../../core/async-state.mjs';
import {AsyncUICapture,AsyncUIImport} from '../../core/async-ui.mjs';
import {UnsupportedIndicatorError} from '../../core/indicator-modules.mjs';
import {requirePortableFactory} from '../../core/indicators.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from '../../core/checkpoint-validation.mjs';

const DEFAULT_CHUNK=16384,DEFAULT_STEP=4096,MAX_CHUNK=262144,MAX_STEP=65536;
let migrationSerial=0;

export class JavaScriptBackendRequiredError extends Error {
 constructor(name,cause){super(`Indicator ${String(name??'SOURCE').slice(0,128)} requires the JavaScript backend`,{cause});this.name='JavaScriptBackendRequiredError';this.code='JAVASCRIPT_BACKEND_REQUIRED';}
}

const yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0));
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(label);return value;}
function signalCheck(signal){if(signal!==undefined&&(!signal||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('AbortSignal required');}
function aborted(signal){return new DOMException(String(signal?.reason??'Migration aborted'),'AbortError');}
function checkSignal(signal){if(signal?.aborted)throw aborted(signal);}
function portableError(error){if(error instanceof UnsupportedIndicatorError){const match=String(error.message).match(/module:\s*([^;]+)/);return new JavaScriptBackendRequiredError(match?.[1],error);}return error;}
function clone(value,label){try{return structuredClone(value);}catch(error){throw new TypeError(`${label} must be cloneable`,{cause:error});}}
function same(a,b){if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));}
function ownFloat64(value,label){if(!(value instanceof Float64Array))throw new TypeError(`${label} Float64Array required`);return new Float64Array(value);}
function ownData(record,key,label){if(!record||typeof record!=='object')throw new TypeError(`${label} object required`);const descriptor=Object.getOwnPropertyDescriptor(record,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError(`${label} own data property required`);return descriptor.value;}
function safePoint(api,input){
 if(!(api instanceof ChartAPI)||!(input instanceof InteractionController)||api.controller!==input)throw new TypeError('Actual JavaScript ChartAPI/controller required');
 if(input.gesture||input.pointers.size||api.model.drawings.transaction)throw new Error('Backend migration requires idle input');
 if(api.model.dataIngestion){const state=api.dataIngestionStats();if(state.state!=='paused'||state.pendingEvents!==0)throw new Error('Backend migration requires paused empty ingestion');}
}
async function report(onProgress,value){if(onProgress)await onProgress(Object.freeze({...value}));}
function nextIdentity(){if(migrationSerial>=Number.MAX_SAFE_INTEGER-1)throw new RangeError('JavaScript migration identity exhausted');return ++migrationSerial;}

/** Capture an actual JavaScript chart as the portable workspace + segmented UI protocol. */
export async function captureJavaScriptMigration({api,input,size,document,binding,revision=1,maxBytes=NATIVE_WORKSPACE_RESTORE_BYTES,signal,onProgress,chunkSize=DEFAULT_CHUNK,admissionRecords=8}={}){
 signalCheck(signal);checkSignal(signal);if(onProgress!==undefined&&typeof onProgress!=='function')throw new TypeError('Progress callback required');
 integer(revision,1,Number.MAX_SAFE_INTEGER,'Migration revision');integer(maxBytes,1,NATIVE_WORKSPACE_RESTORE_BYTES,'Migration byte limit');integer(chunkSize,1,MAX_CHUNK,'Migration chunk size');integer(admissionRecords,1,64,'Migration admission work');
 if(!size||!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<100||size.height<80)throw new RangeError('Migration presentation size');
 if(typeof document!=='string'||document.length>8388608)throw new RangeError('Migration workspace document');
 safePoint(api,input);
 try{for(const entry of api.model.indicators.entries.values())requirePortableFactory(entry.name,api.model.indicators.registry.get(entry.name));}catch(error){throw portableError(error);}
 let source,finished=false;
 try{
  try{source=new NativeWorkspaceCapture(api,document,binding,{input,size,revision,maxBytes});}catch(error){throw portableError(error);}
  let admission;
  do{checkSignal(signal);admission=source.step(admissionRecords,revision);await report(onProgress,{...admission,stage:'workspace-admission'});if(!admission.complete)await yieldControl();}while(!admission.complete);
  const length=source.model.store.length,columns={};
  for(let slot=0;slot<FIELDS.length;slot++){
   const values=new Float64Array(length);
   for(let offset=0;offset<length;offset+=chunkSize){checkSignal(signal);const count=Math.min(chunkSize,length-offset);values.set(source.buffer(slot,offset,count,revision),offset);await report(onProgress,{phase:'workspace-copy',slot,done:offset+count,total:length});await yieldControl();}
   columns[FIELDS[slot]]=values;
  }
  const uiSource=Object.create(AsyncCapture.prototype);
  uiSource.model=source.model;
  uiSource.check=()=>source.check(revision);
  uiSource.uiState=function(controller,logicalSize){const state=AsyncCapture.prototype.uiState.call(this,controller,logicalSize);return {...state,drawingMagnet:clone(controller.drawingMagnet,'Drawing magnet'),crosshairSnap:clone(controller.crosshairSnap,'Crosshair snap')};};
  const ui=new AsyncUICapture(uiSource,input,size),uiChunks=[];
  for(;;){checkSignal(signal);const text=ui.next(),row=safeCheckpointParse(text);if(row.complete)break;uiChunks.push(text);await report(onProgress,{phase:'ui-copy',done:uiChunks.length});await yieldControl();}
  ui.check(input,size);source.check(revision);
  const identity=nextIdentity(),metadataJSON=source.metadataJSON,header=ui.headerJSON;
  const description=Object.freeze({schema:'aster.web-ui-migration',version:1,registration:identity,workspaceTicket:identity,workspaceRegistration:identity,sourceRevision:revision,workspaceMetadata:metadataJSON,header});
  const check=()=>{if(finished)throw new Error('JavaScript migration source is closed');ui.check(input,size);return source.check(revision);};
  const finish=()=>{check();const receipt=source.finish(revision);finished=true;return receipt;};
  const dispose=()=>{if(finished)return false;finished=true;source.dispose();return true;};
  return Object.freeze({schema:'aster.web-wasm.javascript-capture',version:1,metadataJSON,columns:Object.freeze(columns),header,uiChunks:Object.freeze(uiChunks.slice()),description,revision,check,finish,dispose});
 }catch(error){source?.dispose();throw portableError(error);}
}

function validatePortableSource(source){
 if(!source||typeof source!=='object')throw new TypeError('Portable migration source required');
 const metadataJSON=ownData(source,'metadataJSON','Portable migration source'),header=ownData(source,'header','Portable migration source'),chunkSource=ownData(source,'uiChunks','Portable migration source'),columnSource=ownData(source,'columns','Portable migration source'),descriptionSource=ownData(source,'description','Portable migration source');
 if(typeof metadataJSON!=='string'||typeof header!=='string'||!Array.isArray(chunkSource)||!columnSource||typeof columnSource!=='object'||!descriptionSource||typeof descriptionSource!=='object')throw new TypeError('Portable migration source required');
 const metadata=safeCheckpointParse(metadataJSON);if(metadata?.schema!=='aster.native-workspace-target'||metadata.version!==1)throw new TypeError('Portable workspace metadata');
 const descriptionKeys=['schema','version','registration','workspaceTicket','workspaceRegistration','sourceRevision','workspaceMetadata','header'],descriptionOwnKeys=Reflect.ownKeys(descriptionSource);if(descriptionOwnKeys.length!==descriptionKeys.length||descriptionOwnKeys.some(key=>typeof key!=='string'||!descriptionKeys.includes(key)))throw new TypeError('Portable UI migration description');
 const description=Object.fromEntries(descriptionKeys.map(key=>[key,ownData(descriptionSource,key,'Portable UI migration description')]));
 if(description.schema!=='aster.web-ui-migration'||description.version!==1||description.workspaceMetadata!==metadataJSON||description.header!==header)throw new TypeError('Portable UI migration description');
 for(const key of ['registration','workspaceTicket','workspaceRegistration','sourceRevision'])integer(description[key],1,Number.MAX_SAFE_INTEGER,'Portable migration identity');
 const columns=Object.fromEntries(FIELDS.map(key=>[key,ownFloat64(ownData(columnSource,key,'Portable migration columns'),`Migration ${key}`)]));
 if(columns.time.length!==metadata.source.length||FIELDS.some(key=>columns[key].length!==columns.time.length))throw new TypeError('Portable workspace column lengths');
 const length=ownData(chunkSource,'length','Portable migration chunks'),chunkKeys=Reflect.ownKeys(chunkSource);integer(length,0,10001,'Migration UI chunk count');if(chunkKeys.length!==length+1||chunkKeys.some(key=>key!=='length'&&(!/^(0|[1-9]\d*)$/.test(String(key))||Number(key)>=length)))throw new TypeError('Portable migration dense chunk array');
 const uiChunks=Array.from({length},(_,index)=>{const text=ownData(chunkSource,String(index),'Portable migration chunk');if(typeof text!=='string'||text.length>262144)throw new RangeError(`Migration UI chunk ${index}`);return text;});
 return {metadata,metadataJSON,header,description:Object.freeze(description),columns,uiChunks:Object.freeze(uiChunks)};
}

/** Build an isolated actual JavaScript model/controller candidate from a Rust or JS capture. */
export async function importJavaScriptMigration(source,{signal,onProgress,chunkSize=DEFAULT_CHUNK,stepSize=DEFAULT_STEP}={}){
 signalCheck(signal);checkSignal(signal);if(onProgress!==undefined&&typeof onProgress!=='function')throw new TypeError('Progress callback required');integer(chunkSize,1,MAX_CHUNK,'Migration chunk size');integer(stepSize,1,MAX_STEP,'Migration step size');
 const portable=validatePortableSource(source);let target,model=null,handedOff=false,disposed=false;
 try{
  try{target=new NativeWorkspacePrepared(portable.metadataJSON);}catch(error){throw portableError(error);}
  for(let slot=0;slot<FIELDS.length;slot++)for(let offset=0;offset<target.length;offset+=chunkSize){checkSignal(signal);const count=Math.min(chunkSize,target.length-offset);target.target(slot,offset,count).set(portable.columns[FIELDS[slot]].subarray(offset,offset+count));await report(onProgress,{phase:'workspace-copy',slot,done:offset+count,total:target.length});await yieldControl();}
  target.start();let progress;
  do{checkSignal(signal);progress=target.step(stepSize);await report(onProgress,{...progress,stage:'workspace-prepare'});if(!progress.complete)await yieldControl();}while(!progress.complete);
  checkSignal(signal);
  const ready=target.finish();model=ready.model;
  const prepared={phase:'ready',model,metadata:{event:{kind:'migration'}},finishUI(state,drawings){
   if(!Object.hasOwn(state,'drawingMagnet')||!Object.hasOwn(state,'crosshairSnap'))throw new TypeError('Backend migration controller state');
   if(!same(state.symbol??null,model.symbol??null))throw new Error('Backend migration symbol changed');
   const ingestion=model.dataIngestion,ingestionText=ingestion?.save();
   if(!Object.is(state.dataIngestion,ingestionText))throw new Error('Backend migration ingestion changed');
   const clean={...state};delete clean.drawingMagnet;delete clean.crosshairSnap;delete clean.dataIngestion;
   model.dataIngestion=null;let result;
   try{result=AsyncPrepared.prototype.finishUI.call(this,clean,drawings);}finally{model.dataIngestion=ingestion??null;}
   const controller=new InteractionController(result.model,()=>ready.size),api=new ChartAPI(result.model,{controller});
   api.setDrawingMagnet(state.drawingMagnet);api.setCrosshairSnap(state.crosshairSnap);api.setDrawingTarget(result.ui.drawingTarget);api.setTool(result.ui.tool);api.setText(result.ui.text);
   return {...result,input:controller,api};
  }};
  const ui=new AsyncUIImport(portable.header,prepared);
  for(let index=0;index<portable.uiChunks.length;index++){checkSignal(signal);ui.chunk(portable.uiChunks[index]);await report(onProgress,{phase:'ui-import',done:index+1,total:portable.uiChunks.length});checkSignal(signal);await yieldControl();}
  const restored=ui.finish();checkSignal(signal);
  const candidate={schema:'aster.web-wasm.javascript-candidate',version:1,model:restored.model,input:restored.input,api:restored.api,size:Object.freeze({...ready.size}),plan:ready.plan,description:Object.freeze(portable.description),
   dispose(){if(disposed||handedOff)return false;disposed=true;restored.model.dispose();return true;},
   handoff(){if(disposed)throw new Error('JavaScript migration candidate is closed');if(handedOff)throw new Error('JavaScript migration candidate already handed off');handedOff=true;return Object.freeze({model:restored.model,input:restored.input,api:restored.api,size:this.size});},
  };
  return Object.freeze(candidate);
 }catch(error){if(model&&!handedOff)model.dispose();else target?.dispose();throw portableError(error);}
}
