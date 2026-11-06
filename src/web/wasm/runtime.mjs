import {float64FromLittleEndianBytes, littleEndianFloat64Bytes, parseLossless, stringifyLossless} from './bcjson.mjs';

const ABI_VERSION=1;
const MAX_TRANSFER=262144;
const STATUS=Object.freeze({OK:0,THROW:1,UNAVAILABLE:2,CLOSED:3,POISONED:4,BUSY:5,INVALID:6,OOM_LIMIT:7,OOM_SYSTEM:8});
const REQUIRED=Object.freeze(['memory','bc_alloc','bc_free','bc_engine_new','bc_engine_free','bc_call','bc_web_abi_version','bc_web_capabilities','bc_web_read_f64','bc_web_write_f64','bc_web_packet','bc_web_memory_stats']);
const moduleCache=new Map();

export class RustWasmError extends Error {
  constructor(message,{name='RustWasmError',code=null,status=null,cause}={}){super(message,{cause});this.name=name;this.code=code;this.status=status;}
}
export class RustWasmLoadError extends RustWasmError {}
export class RustWasmCapabilityError extends RustWasmError {}
export class RustWasmCallError extends RustWasmError {}

const abortError=()=>new RustWasmError('WASM load aborted',{name:'AbortError'});
function assertSignal(signal){if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');}
function throwIfAborted(signal){if(signal?.aborted)throw abortError();}
function sourceKey(source){return typeof source==='string'||typeof URL!=='undefined'&&source instanceof URL?String(source):null;}
async function sourceResponse(source,signal){
  if(typeof Response!=='undefined'&&source instanceof Response){if(!source.ok)throw new RustWasmLoadError(`WASM fetch failed: HTTP ${source.status}`,{name:'RustWasmFetchError',code:`HTTP_${source.status}`,status:source.status});return source.clone();}
  if(typeof source==='string'||typeof URL!=='undefined'&&source instanceof URL){
    let response;try{response=await fetch(source,{signal});}catch(error){throw new RustWasmLoadError(`WASM fetch failed: ${error.message}`,{name:error.name==='AbortError'?'AbortError':'RustWasmFetchError',cause:error});}
    if(!response.ok)throw new RustWasmLoadError(`WASM fetch failed: HTTP ${response.status}`,{name:'RustWasmFetchError',code:`HTTP_${response.status}`,status:response.status});return response;
  }
  return null;
}
async function compileSource(source,signal){
  throwIfAborted(signal);if(source instanceof WebAssembly.Module)return source;
  const response=await sourceResponse(source,signal);
  if(response){try{return await WebAssembly.compileStreaming(response.clone());}catch{throwIfAborted(signal);try{return await WebAssembly.compile(await response.arrayBuffer());}catch(fallback){throw new RustWasmLoadError(`WASM compile failed: ${fallback.message}`,{name:'RustWasmCompileError',cause:fallback});}}}
  let bytes;if(source instanceof ArrayBuffer)bytes=source;else if(ArrayBuffer.isView(source))bytes=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);else throw new TypeError('WASM source must be a URL, Response, WebAssembly.Module, ArrayBuffer, or byte view');
  try{return await WebAssembly.compile(bytes);}catch(error){throw new RustWasmLoadError(`WASM compile failed: ${error.message}`,{name:'RustWasmCompileError',cause:error});}
}

/** Load and compile a module without instantiating it. Imports are side-effect free. */
export async function loadRustModule(source,{signal}={}){
  assertSignal(signal);throwIfAborted(signal);const key=sourceKey(source),started=globalThis.performance?.now?.()??Date.now();let promise=key&&!signal?moduleCache.get(key):null;
  if(!promise){promise=compileSource(source,signal);if(key&&!signal)moduleCache.set(key,promise);promise.catch(()=>{if(key&&moduleCache.get(key)===promise)moduleCache.delete(key);});}
  try{const module=await promise;throwIfAborted(signal);return{module,timings:{compileMs:(globalThis.performance?.now?.()??Date.now())-started}};}catch(error){if(error instanceof RustWasmError||error instanceof TypeError)throw error;throw new RustWasmLoadError(`WASM load failed: ${error.message}`,{cause:error});}
}

function rangesOverlap(left,length,right,rightLength){return length!==0&&rightLength!==0&&left<right+rightLength&&right<left+length;}
function validateCapabilities(value,requiredOperations){
  if(!value||value.schema!=='barochart.web-wasm.capabilities'||value.version!==1||value.abi!==ABI_VERSION||value.transfer!=='f64-le'||value.packetVersion!==1||!Number.isSafeInteger(value.maxTransfer)||value.maxTransfer<1||value.maxTransfer>MAX_TRANSFER||!Array.isArray(value.implemented)||!Array.isArray(value.unavailable))throw new RustWasmCapabilityError('Invalid web WASM capability contract',{name:'RustWasmCapabilityError',code:'BAD_CAPABILITIES'});
  const implemented=new Set(),unavailable=new Set();
  for(const name of value.implemented){if(typeof name!=='string'||implemented.has(name))throw new RustWasmCapabilityError('Invalid implemented operation list',{name:'RustWasmCapabilityError',code:'BAD_CAPABILITIES'});implemented.add(name);}
  for(const name of value.unavailable){if(typeof name!=='string'||unavailable.has(name)||implemented.has(name))throw new RustWasmCapabilityError('Invalid unavailable operation list',{name:'RustWasmCapabilityError',code:'BAD_CAPABILITIES'});unavailable.add(name);}
  for(const operation of requiredOperations)if(!implemented.has(operation)||unavailable.has(operation))throw new RustWasmCapabilityError(`Required WASM operation is unavailable: ${operation}`,{name:'RustWasmCapabilityError',code:'MISSING_OPERATION'});
  return Object.freeze({...value,implemented:Object.freeze([...value.implemented]),unavailable:Object.freeze([...value.unavailable])});
}

export function instantiateRustRuntime(module,{host=globalThis,requiredOperations=['nativeInit','nativeCommand','nativeScenePacket']}={}){
  if(!(module instanceof WebAssembly.Module))throw new TypeError('WebAssembly.Module required');
  if(!Array.isArray(requiredOperations)||requiredOperations.some(value=>typeof value!=='string'))throw new TypeError('requiredOperations must be a string array');
  const moduleExports=WebAssembly.Module.exports(module),exports=new Map(moduleExports.map(item=>[item.name,item.kind])),missing=REQUIRED.filter(name=>!exports.has(name));
  if(missing.length)throw new RustWasmCapabilityError(`WASM module is missing exports: ${missing.join(', ')}`,{name:'RustWasmCapabilityError',code:'MISSING_EXPORT'});
  if(exports.get('memory')!=='memory'||REQUIRED.some(name=>name!=='memory'&&exports.get(name)!=='function'))throw new RustWasmCapabilityError('WASM module has incompatible export kinds',{name:'RustWasmCapabilityError',code:'BAD_EXPORT'});

  let instance,engine=0,closed=false,quarantined=false,inFlight=false,invocationId=0,disposing=false;
  let hostContextActive=true,hostReleaseCount=0,hostProtocolError=null,capabilities=null;
  const hostId=1,allocations=new Map();
  const protocolError=(message,code='PROTOCOL',cause)=>{quarantined=true;return new RustWasmCallError(message,{name:'RustWasmProtocolError',code,cause});};
  const env={
    js_log:value=>{try{return Number(host.Math?.log?.(value)??Math.log(value));}catch{return NaN;}},
    js_exp:value=>{try{return Number(host.Math?.exp?.(value)??Math.exp(value));}catch{return NaN;}},
    js_hypot:(left,right)=>{try{return Number(host.Math?.hypot?.(left,right)??Math.hypot(left,right));}catch{return NaN;}},
    zone_resolve:(requested,pointer,length,outputPointer,outputCapacity)=>{
      if(requested!==hostId||!hostContextActive)return-1;
      try{const memory=instance.exports.memory,limit=memory.buffer.byteLength;pointer>>>=0;length>>>=0;outputPointer>>>=0;outputCapacity>>>=0;if(pointer>limit||length>limit-pointer||outputPointer>limit||outputCapacity>limit-outputPointer)return-1;const name=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(memory.buffer,pointer,length));const resolved=new host.Intl.DateTimeFormat('en-US',{timeZone:name}).resolvedOptions().timeZone,encoded=new TextEncoder().encode(resolved);if(encoded.length>outputCapacity)return-1;new Uint8Array(memory.buffer).set(encoded,outputPointer);return encoded.length;}catch{return-1;}
    },
    zone_offset_seconds:(requested,pointer,length,epoch)=>{
      if(requested!==hostId||!hostContextActive)return-0x80000000;
      try{const memory=instance.exports.memory,limit=memory.buffer.byteLength;pointer>>>=0;length>>>=0;if(pointer>limit||length>limit-pointer)return-0x80000000;const name=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(memory.buffer,pointer,length)),instant=new Date(Math.floor(epoch/1000)*1000);if(!Number.isFinite(instant.getTime()))return-0x80000000;const parts=new host.Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:name,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant),values=Object.fromEntries(parts.filter(item=>item.type!=='literal').map(item=>[item.type,Number(item.value)])),local=Date.UTC(values.year,values.month-1,values.day,values.hour,values.minute,values.second)/1000,result=local-Math.floor(epoch/1000);return Number.isInteger(result)&&result>-0x80000000&&result<=0x7fffffff?result:-0x80000000;}catch{return-0x80000000;}
    },
    host_release:requested=>{
      hostReleaseCount++;
      if(requested!==hostId||!disposing||!hostContextActive||hostReleaseCount!==1){hostProtocolError=protocolError('Invalid host_release callback','HOST_RELEASE');return;}
      hostContextActive=false;
    },
  };
  try{instance=new WebAssembly.Instance(module,{env});}catch(error){hostContextActive=false;throw new RustWasmLoadError(`WASM instantiation failed: ${error.message}`,{name:'RustWasmInstantiationError',cause:error});}

  const exportCall=(name,...args)=>{
    const outcome={id:++invocationId,name,started:globalThis.performance?.now?.()??Date.now(),state:'entered'};
    if(inFlight)throw new RustWasmCallError('Rust WASM call is already active',{name:'RustWasmBusyError',code:'BUSY',status:STATUS.BUSY});
    inFlight=true;
    try{const result=instance.exports[name](...args);if(hostProtocolError)throw hostProtocolError;outcome.state='returned';return result;}
    catch(error){if(error instanceof RustWasmError)throw error;throw protocolError(`WASM export ${name} trapped: ${error.message}`,'TRAP',error);}
    finally{inFlight=false;outcome.finished=globalThis.performance?.now?.()??Date.now();}
  };
  const memory=()=>instance.exports.memory;
  const pointerValid=(pointer,size,alignment=8)=>Number.isInteger(pointer)&&pointer>0&&pointer%alignment===0&&pointer<=memory().buffer.byteLength&&size<=memory().buffer.byteLength-pointer;
  const cleanupError=cause=>protocolError(`WASM allocation cleanup failed: ${cause.message}`,'CLEANUP',cause);
  const release=(pointer,size)=>{
    if(!pointer)return null;
    try{exportCall('bc_free',pointer>>>0,size>>>0);allocations.delete(pointer>>>0);return null;}
    catch(error){return cleanupError(error);}
  };
  const finishScope=(scope,primary=null)=>{
    let cleanup=null;
    for(let index=scope.length-1;index>=0;index--){const item=scope[index],failure=release(item.pointer,item.size);if(failure&&!cleanup)cleanup=failure;}
    if(primary){if(cleanup&&!primary.cleanupCause)Object.defineProperty(primary,'cleanupCause',{value:cleanup});throw primary;}
    if(cleanup)throw cleanup;
  };
  const withScope=fn=>{const scope=[];let value,primary=null;try{value=fn(scope);}catch(error){primary=error;}finishScope(scope,primary);return value;};
  const alloc=(scope,size)=>{
    if(!Number.isSafeInteger(size)||size<=0||size>0xffffffff)throw new RangeError('WASM allocation size');
    const pointer=exportCall('bc_alloc',size)>>>0;
    if(pointer===0)throw new RustWasmCallError(`WASM allocation failed: ${size}`,{name:'RustWasmAllocationError',code:'OOM',status:STATUS.OOM_SYSTEM});
    if(!pointerValid(pointer,size,8))throw protocolError('WASM allocator returned invalid pointer','BAD_ALLOC');
    for(const item of allocations.values())if(rangesOverlap(pointer,size,item.pointer,item.size))throw protocolError('WASM allocator returned overlapping storage','BAD_ALLOC');
    const item={pointer,size};allocations.set(pointer,item);scope.push(item);return pointer;
  };
  const adoptOwned=(scope,descriptorPointer)=>{
    descriptorPointer>>>=0;const limit=memory().buffer.byteLength;if(descriptorPointer%4||descriptorPointer>limit||12>limit-descriptorPointer)throw protocolError('Invalid WASM buffer descriptor','BAD_DESCRIPTOR');
    const view=new DataView(memory().buffer),pointer=view.getUint32(descriptorPointer,true),length=view.getUint32(descriptorPointer+4,true),capacity=view.getUint32(descriptorPointer+8,true);
    if(pointer===0){if(length||capacity)throw protocolError('Noncanonical empty WASM buffer','BAD_DESCRIPTOR');return{pointer:0,length:0,capacity:0};}
    if(length!==capacity||!pointerValid(pointer,capacity,8))throw protocolError('Invalid owned WASM buffer','BAD_DESCRIPTOR');
    for(const item of allocations.values())if(rangesOverlap(pointer,capacity,item.pointer,item.size))throw protocolError('Owned WASM output aliases host storage','BAD_DESCRIPTOR');
    const item={pointer,size:capacity};allocations.set(pointer,item);scope.push(item);return{pointer,length,capacity};
  };
  const readOwned=(scope,descriptorPointer)=>{const owned=adoptOwned(scope,descriptorPointer);if(!owned.pointer)return new Uint8Array();try{return new Uint8Array(memory().buffer.slice(owned.pointer,owned.pointer+owned.length));}catch(error){throw protocolError(`WASM output copy failed: ${error.message}`,'BAD_COPY',error);}};
  const decodeUtf8=(value,kind='payload')=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch(error){throw protocolError(`Malformed WASM UTF-8 ${kind}: ${error.message}`,'BAD_UTF8',error);}};
  const decodeLossless=(text,kind='payload')=>{try{return text?parseLossless(text):undefined;}catch(error){throw protocolError(`Malformed WASM BCJSON ${kind}: ${error.message}`,'BAD_BCJSON',error);}};
  const errorFrom=(status,text='')=>{const payload=decodeLossless(text,'error')??null,message=payload?.message??`Rust WASM call failed with status ${status}`,error=new RustWasmCallError(String(message),{name:payload?.name??'RustWasmCallError',code:payload?.code??null,status});if(status===STATUS.POISONED)quarantined=true;return error;};
  const ensureOpen=()=>{if(closed)throw new RustWasmCallError('Rust WASM session is closed',{name:'RustWasmClosedError',code:'CLOSED',status:STATUS.CLOSED});if(quarantined)throw new RustWasmCallError('Rust WASM session is quarantined; recreate it',{name:'RustWasmQuarantinedError',code:'QUARANTINED',status:STATUS.POISONED});};
  const inputBytes=value=>new TextEncoder().encode(stringifyLossless(value));
  const writeBytes=(pointer,value)=>new Uint8Array(memory().buffer).set(value,pointer);
  const callText=(name,args,flags=1)=>{
    ensureOpen();const nameBytes=new TextEncoder().encode(name),argsBytes=inputBytes(args);
    return withScope(scope=>{const np=alloc(scope,nameBytes.length),ap=alloc(scope,argsBytes.length),out=alloc(scope,12);writeBytes(np,nameBytes);writeBytes(ap,argsBytes);const status=exportCall('bc_call',engine,np,nameBytes.length,ap,argsBytes.length,flags,out),text=decodeUtf8(readOwned(scope,out));if(status!==STATUS.OK)throw errorFrom(status,text);return decodeLossless(text);});
  };
  const readF64=(name,args=[],flags=1)=>{
    ensureOpen();const nameBytes=new TextEncoder().encode(name),argsBytes=inputBytes(args);
    return withScope(scope=>{const np=alloc(scope,nameBytes.length),ap=alloc(scope,argsBytes.length),out=alloc(scope,12);writeBytes(np,nameBytes);writeBytes(ap,argsBytes);const status=exportCall('bc_web_read_f64',engine,np,nameBytes.length,ap,argsBytes.length,flags,out),payload=readOwned(scope,out);if(status!==STATUS.OK)throw errorFrom(status,decodeUtf8(payload,'error'));try{return float64FromLittleEndianBytes(payload);}catch(error){throw protocolError(`Malformed WASM Float64 payload: ${error.message}`,'BAD_F64',error);}});
  };
  const disposeEngine=()=>{
    if(!engine){hostContextActive=false;return null;}
    const current=engine;engine=0;disposing=true;let primary=null;
    try{exportCall('bc_engine_free',current);}catch(error){primary=error;}finally{disposing=false;}
    if(hostReleaseCount!==1||hostContextActive){const releaseError=protocolError(`WASM engine disposal released its host ${hostReleaseCount} times`,'HOST_RELEASE');if(!primary)primary=releaseError;}
    hostContextActive=false;return primary;
  };

  try{
    const version=exportCall('bc_web_abi_version');if(version!==ABI_VERSION)throw new RustWasmCapabilityError(`Unsupported web WASM ABI version: ${version}`,{name:'RustWasmCapabilityError',code:'ABI_VERSION'});
    withScope(scope=>{const out=alloc(scope,4),errorOut=alloc(scope,12),status=exportCall('bc_engine_new',hostId,out,errorOut);engine=new DataView(memory().buffer).getUint32(out,true);const text=decodeUtf8(readOwned(scope,errorOut),'engine error');if(status!==STATUS.OK)throw errorFrom(status,text);if(!engine)throw protocolError('WASM engine creation returned an empty handle','BAD_ENGINE');if(text)throw protocolError('Successful engine creation returned an error','BAD_ENGINE');});
    capabilities=withScope(scope=>{const out=alloc(scope,12),status=exportCall('bc_web_capabilities',engine,out),text=decodeUtf8(readOwned(scope,out),'capabilities');if(status!==STATUS.OK)throw errorFrom(status,text);return validateCapabilities(decodeLossless(text,'capabilities'),requiredOperations);});
  }catch(error){const disposal=disposeEngine();if(disposal&&!error.cleanupCause)Object.defineProperty(error,'cleanupCause',{value:disposal});hostContextActive=false;throw error;}

  const runtime={
    get module(){return module;},get instance(){return instance;},get engine(){return engine;},get quarantined(){return quarantined;},get closed(){return closed;},get hostReleased(){return hostReleaseCount===1&&!hostContextActive;},get hostReleaseCount(){return hostReleaseCount;},
    call:(name,args=[],flags=1)=>callText(name,args,flags),readF64,
    writeF64(name,args=[],values,flags=1){ensureOpen();if(!(values instanceof Float64Array)||values.length>capabilities.maxTransfer)throw new RangeError('Float64Array transfer limit');const nameBytes=new TextEncoder().encode(name),argsBytes=inputBytes(args),sourceBytes=littleEndianFloat64Bytes(values);return withScope(scope=>{const np=alloc(scope,nameBytes.length),ap=alloc(scope,argsBytes.length),sp=sourceBytes.length?alloc(scope,sourceBytes.length):0,did=alloc(scope,4),errorOut=alloc(scope,12);writeBytes(np,nameBytes);writeBytes(ap,argsBytes);if(sp)writeBytes(sp,sourceBytes);new DataView(memory().buffer).setUint32(did,0,true);const status=exportCall('bc_web_write_f64',engine,np,nameBytes.length,ap,argsBytes.length,flags,sp,values.length,did,errorOut),wrote=new DataView(memory().buffer).getUint32(did,true),text=decodeUtf8(readOwned(scope,errorOut),'write error');if(wrote!==0&&wrote!==1)throw protocolError(`Invalid WASM write receipt: ${wrote}`,'BAD_RECEIPT');if(status!==STATUS.OK)throw errorFrom(status,text);if(text)throw protocolError('Successful WASM write returned an error','BAD_RECEIPT');return wrote===1;});},
    packet(args=[]){ensureOpen();const argsBytes=inputBytes(args);return withScope(scope=>{const ap=alloc(scope,argsBytes.length),meta=alloc(scope,12),numbers=alloc(scope,12);writeBytes(ap,argsBytes);const status=exportCall('bc_web_packet',engine,ap,argsBytes.length,meta,numbers),metadataBytes=readOwned(scope,meta),numberBytes=readOwned(scope,numbers),metadataText=decodeUtf8(metadataBytes,'packet metadata');if(status!==STATUS.OK)throw errorFrom(status,metadataText);let decodedNumbers;try{decodedNumbers=float64FromLittleEndianBytes(numberBytes);}catch(error){throw protocolError(`Malformed WASM packet numbers: ${error.message}`,'BAD_F64',error);}return{metadata:decodeLossless(metadataText,'packet metadata')??null,numbers:decodedNumbers};});},
    capabilities:()=>capabilities,
    capabilitiesJson(){ensureOpen();return withScope(scope=>{const out=alloc(scope,12),status=exportCall('bc_web_capabilities',engine,out),text=decodeUtf8(readOwned(scope,out),'capabilities');if(status!==STATUS.OK)throw errorFrom(status,text);return validateCapabilities(decodeLossless(text,'capabilities'),requiredOperations);});},
    memoryStats(){ensureOpen();return withScope(scope=>{const out=alloc(scope,12),status=exportCall('bc_web_memory_stats',engine,out),text=decodeUtf8(readOwned(scope,out),'memory stats');if(status!==STATUS.OK)throw errorFrom(status,text);return {...decodeLossless(text,'memory stats'),linearMemoryBytes:memory().buffer.byteLength};});},
    resynchronize(){if(closed)throw new RustWasmCallError('Rust WASM session is closed',{name:'RustWasmClosedError',code:'CLOSED',status:STATUS.CLOSED});if(!quarantined)return true;throw new RustWasmCallError('Quarantined WASM session must be recreated',{name:'RustWasmQuarantinedError',code:'QUARANTINED',status:STATUS.POISONED});},
    close(){if(closed)return;if(inFlight)throw new RustWasmCallError('Rust WASM call is already active',{name:'RustWasmBusyError',code:'BUSY',status:STATUS.BUSY});closed=true;let primary=disposeEngine();const remaining=[...allocations.values()];if(remaining.length){try{finishScope(remaining,primary);}catch(error){primary=error;}}if(primary)throw primary;},
  };
  return runtime;
}

export async function createRustRuntime({source,signal,...options}={}){const loaded=await loadRustModule(source,{signal}),runtime=instantiateRustRuntime(loaded.module,options);Object.defineProperty(runtime,'timings',{value:loaded.timings,enumerable:true});return runtime;}
