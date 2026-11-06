import assert from 'node:assert/strict';
import test from 'node:test';
import {instantiateRustRuntime, loadRustModule, RustWasmCapabilityError, RustWasmLoadError} from '../src/web/wasm/runtime.mjs';
import {float64FromLittleEndianBytes, littleEndianFloat64Bytes, parseLossless, stringifyLossless} from '../src/web/wasm/bcjson.mjs';
import {parseLossless as parseTrace, stringifyLossless as stringifyTrace} from '../scripts/trace/bcjson.mjs';

const emptyModule = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
test('web runtime imports safely without fetching or instantiating', () => {
  assert.equal(typeof loadRustModule, 'function');
  assert.throws(() => instantiateRustRuntime(emptyModule), error => error instanceof RustWasmCapabilityError);
});
test('runtime rejects required exports with the wrong WebAssembly kind',t=>{
 const fake=fakeRuntime(t);WebAssembly.Module.exports=()=>requiredExports.map(name=>({name,kind:name==='memory'?'function':'function'}));
 assert.throws(()=>instantiateRustRuntime(fake.module),error=>error.code==='BAD_EXPORT');
});
test('module loader accepts an ArrayBuffer and reports compile timing', async () => {
  const result = await loadRustModule(new Uint8Array([0,97,115,109,1,0,0,0]).buffer);
  assert.ok(result.module instanceof WebAssembly.Module);
  assert.equal(typeof result.timings.compileMs, 'number');
});
test('aborted load does not turn into a generic compile error', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadRustModule(emptyModule, {signal: controller.signal}), error => error.name === 'AbortError');
});
test('unsupported source is classified before WebAssembly calls', async () => {
  await assert.rejects(loadRustModule(42), error => error instanceof TypeError);
});
test('failed URL response is a typed load error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', {status: 503});
  try { await assert.rejects(loadRustModule('https://example.invalid/chart.wasm'), error => error instanceof RustWasmLoadError && error.status === 503); }
  finally { globalThis.fetch = original; }
});
test('failed Response input is classified as the same HTTP load error', async () => {
  await assert.rejects(loadRustModule(new Response('no', {status: 503})), error => error instanceof RustWasmLoadError && error.name === 'RustWasmFetchError' && error.status === 503);
});
test('failed cached URL loads are evicted so an explicit retry can succeed',async()=>{
 const original=globalThis.fetch;let count=0;
 globalThis.fetch=async()=>new Response(count++?new Uint8Array([0,97,115,109,1,0,0,0]):new Uint8Array([1,2,3]),{headers:{'Content-Type':'application/wasm'}});
 try{await assert.rejects(loadRustModule('https://example.invalid/retry-runtime.wasm'),error=>error.name==='RustWasmCompileError');const loaded=await loadRustModule('https://example.invalid/retry-runtime.wasm');assert.ok(loaded.module instanceof WebAssembly.Module);assert.equal(count,2);}
 finally{globalThis.fetch=original;}
});
test('browser lossless codec preserves special scalar values and float bits', () => {
  const bits = [0x0000000000000000n, 0x8000000000000000n, 0x7ff8000000000042n, 0x7ff0000000000000n, 0xfff0000000000000n];
  const raw = new Uint8Array(bits.length * 8), rawView = new DataView(raw.buffer);
  bits.forEach((value,index)=>rawView.setBigUint64(index*8,value,true));
  const values = float64FromLittleEndianBytes(raw);
  const encoded = stringifyLossless({undef: undefined, nan: NaN, pos: Infinity, neg: -Infinity, minusZero: -0});
  const decoded = parseLossless(encoded);
  assert.equal(Object.is(decoded.minusZero, -0), true);
  assert.equal(Number.isNaN(decoded.nan), true);
  assert.equal(decoded.pos, Infinity);
  assert.equal(decoded.neg, -Infinity);
  const bytes = littleEndianFloat64Bytes(values);
  assert.deepEqual(bytes,raw,'raw NaN payload and signed-zero bytes survive without Number round-tripping');
  const byteView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(Array.from({length: bits.length}, (_, index) => byteView.getBigUint64(index * 8, true)), bits);
  const roundTrip = float64FromLittleEndianBytes(bytes);
  assert.deepEqual(Array.from({length: bits.length}, (_, index) => new DataView(roundTrip.buffer).getBigUint64(index * 8, true)), bits);
});
test('browser lossless codec handles deep values, strict JSON whitespace and own __proto__ data', () => {
  let value = 0; for (let index = 0; index < 12000; index++) value = [value];
  const parsed = parseLossless(stringifyLossless(value)); let depth = 0; let cursor = parsed;
  while (Array.isArray(cursor)) { depth++; cursor = cursor[0]; }
  assert.equal(depth, 12000); assert.equal(cursor, 0);
  const object = parseLossless('{ "__proto__" : 1, "x" : 2, "x" : 3 }');
  assert.equal(Object.getPrototypeOf(object), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(object, '__proto__').value, 1);
  assert.equal(object.x, 3);
  assert.equal(parseLossless('1e400'), Infinity);
  assert.equal(parseLossless('-1e400'), -Infinity);
});

test('browser scalar codec matches the canonical lossless contract',()=>{
 const cases=[undefined,null,true,false,0,-0,1e400,-1e400,NaN,Infinity,-Infinity,'x\ud800\n',[1,undefined,-0],{b:1,a:undefined,n:NaN}];
 for(const value of cases){const text=stringifyTrace(value);assert.equal(stringifyLossless(value),text);assert.deepStrictEqual(parseLossless(text),parseTrace(text));}
 const duplicate='{"2":1,"b":2,"1":3,"b":4,"__proto__":{"x":1}}';
 assert.deepStrictEqual(parseLossless(duplicate),parseTrace(duplicate));
 assert.throws(()=>parseLossless('\u00a01'),/unexpected character/);
});

const requiredExports=['memory','bc_alloc','bc_free','bc_engine_new','bc_engine_free','bc_call','bc_web_abi_version','bc_web_capabilities','bc_web_read_f64','bc_web_write_f64','bc_web_packet','bc_web_memory_stats'];
const realModuleExports=WebAssembly.Module.exports,RealInstance=WebAssembly.Instance;
const validCapabilities=()=>({schema:'barochart.web-wasm.capabilities',version:1,abi:1,transfer:'f64-le',packetVersion:1,maxTransfer:262144,implemented:['nativeInit','nativeCommand','nativeScenePacket'],unavailable:[]});
function fakeRuntime(t,options={}){
 const module=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
 const memory=new WebAssembly.Memory({initial:2});
 const encoder=new TextEncoder(),decoder=new TextDecoder();
 const state={
  bump:1024,allocCalls:0,freeCalls:[],callCalls:0,writeCalls:0,engineNewCalls:0,
  allocations:new Map(),outputPointers:new Set(),allocSequence:[],freeTrapKind:null,freeTrapSize:null,
  abiVersion:options.abiVersion??1,capabilities:options.capabilities??validCapabilities(),
  releaseMode:options.releaseMode??'one',callBytes:encoder.encode('0'),packetMetadata:encoder.encode('{}'),packetNumbers:new Uint8Array(),didWrite:0,
  trapCall:false,earlyRelease:false,callHost:null,
 };
 const align=value=>(value+7)&~7;
 const reserve=(size,kind='host')=>{const pointer=align(state.bump);state.bump=pointer+size;state.allocations.set(pointer,{size,kind});return pointer;};
 const setDescriptor=(slot,bytes,{malformed=false}={})=>{
  const view=new DataView(memory.buffer);
  if(malformed){view.setUint32(slot,3,true);view.setUint32(slot+4,8,true);view.setUint32(slot+8,8,true);return;}
  if(bytes.length===0){view.setUint32(slot,0,true);view.setUint32(slot+4,0,true);view.setUint32(slot+8,0,true);return;}
  const pointer=reserve(bytes.length,'output');state.outputPointers.add(pointer);new Uint8Array(memory.buffer).set(bytes,pointer);view.setUint32(slot,pointer,true);view.setUint32(slot+4,bytes.length,true);view.setUint32(slot+8,bytes.length,true);
 };
 let env;
 const exports={
  memory,
  bc_alloc(size){state.allocCalls++;const planned=state.allocSequence.length?state.allocSequence.shift():'normal';if(planned!=='normal')return typeof planned==='function'?planned(size,memory):planned;return reserve(size,'host');},
  bc_free(pointer,size){const item=state.allocations.get(pointer),kind=item?.kind??'unknown';state.freeCalls.push({pointer,size,kind});if(state.freeTrapSize===size||state.freeTrapKind&&(state.freeTrapKind===kind||state.freeTrapKind==='descriptor'&&kind==='host'&&size===12)){state.freeTrapKind=null;state.freeTrapSize=null;throw new Error('free trap');}state.allocations.delete(pointer);},
  bc_web_abi_version(){return state.abiVersion;},
  bc_engine_new(hostId,out,error){state.engineNewCalls++;state.hostId=hostId;new DataView(memory.buffer).setUint32(out,1,true);setDescriptor(error,new Uint8Array());return 0;},
  bc_engine_free(){if(state.releaseMode==='one')env.host_release(state.hostId);else if(state.releaseMode==='duplicate'){env.host_release(state.hostId);env.host_release(state.hostId);}else if(state.releaseMode==='wrong')env.host_release(state.hostId+1);},
  bc_web_capabilities(_engine,out){setDescriptor(out,encoder.encode(stringifyLossless(state.capabilities)));return 0;},
  bc_web_memory_stats(_engine,out){setDescriptor(out,encoder.encode('{"requested":0}'));return 0;},
  bc_call(_engine,name,nameLength,_args,_argsLength,_flags,out){state.callCalls++;if(state.trapCall)throw new Error('call trap');if(state.earlyRelease)env.host_release(state.hostId);state.callHost?.(env);state.lastName=decoder.decode(new Uint8Array(memory.buffer,name,nameLength));setDescriptor(out,state.callBytes,{malformed:state.malformedCallDescriptor});return 0;},
  bc_web_read_f64(_engine,_name,_nameLength,_args,_argsLength,_flags,out){setDescriptor(out,state.readBytes??new Uint8Array());return 0;},
  bc_web_write_f64(_engine,_name,_nameLength,_args,_argsLength,_flags,_source,_count,did,error){state.writeCalls++;new DataView(memory.buffer).setUint32(did,state.didWrite,true);setDescriptor(error,new Uint8Array());return 0;},
  bc_web_packet(_engine,_args,_argsLength,metadata,numbers){setDescriptor(metadata,state.packetMetadata);setDescriptor(numbers,state.packetNumbers);return 0;},
 };
 WebAssembly.Module.exports=()=>requiredExports.map(name=>({name,kind:name==='memory'?'memory':'function'}));
 WebAssembly.Instance=function(_module,imports){env=imports.env;return{exports};};
 t.after(()=>{WebAssembly.Module.exports=realModuleExports;WebAssembly.Instance=RealInstance;});
 return{module,state,exports,memory};
}

test('ABI and executable capability handshake happen before the runtime is returned',t=>{
 const mismatch=fakeRuntime(t,{abiVersion:2});
 assert.throws(()=>instantiateRustRuntime(mismatch.module),error=>error.code==='ABI_VERSION');
 assert.equal(mismatch.state.engineNewCalls,0);
});

test('memory telemetry reports current linear capacity as an owned scalar after memory growth',t=>{
 const fake=fakeRuntime(t),runtime=instantiateRustRuntime(fake.module);
 const before=runtime.memoryStats();assert.equal(before.requested,0);assert.equal(before.linearMemoryBytes,131072);
 fake.memory.grow(1);const after=runtime.memoryStats();assert.equal(after.linearMemoryBytes,196608);assert.equal(before.linearMemoryBytes,131072);runtime.close();
});

test('known but rejected required operations fail capability validation and release an adopted engine once',t=>{
 const capabilities=validCapabilities();capabilities.implemented=capabilities.implemented.filter(name=>name!=='nativeScenePacket');capabilities.unavailable=['nativeScenePacket'];
 const fake=fakeRuntime(t,{capabilities});
 assert.throws(()=>instantiateRustRuntime(fake.module),error=>error.code==='MISSING_OPERATION');
 assert.equal(fake.state.engineNewCalls,1);
 assert.equal(fake.state.releaseMode,'one');
});

test('ordinary OOM frees earlier allocations without quarantining, while corrupt allocator pointers quarantine',t=>{
 const fake=fakeRuntime(t),runtime=instantiateRustRuntime(fake.module);
 const freesBefore=fake.state.freeCalls.length;fake.state.allocSequence=['normal',0];
 assert.throws(()=>runtime.call('nativeInit',[]),error=>error.name==='RustWasmAllocationError');
 assert.equal(runtime.quarantined,false);assert.ok(fake.state.freeCalls.length>freesBefore);
 assert.equal(runtime.call('nativeInit',[]),0);
 fake.state.allocSequence=[3];
 assert.throws(()=>runtime.call('nativeInit',[]),error=>error.code==='BAD_ALLOC');
 assert.equal(runtime.quarantined,true);
 assert.throws(()=>runtime.call('nativeInit',[]),error=>error.code==='QUARANTINED');

 const outside=fakeRuntime(t),outsideRuntime=instantiateRustRuntime(outside.module);outside.state.allocSequence=[outside.memory.buffer.byteLength+8];
 assert.throws(()=>outsideRuntime.call('nativeInit',[]),error=>error.code==='BAD_ALLOC');assert.equal(outsideRuntime.quarantined,true);
});

test('trap and malformed successful payload quarantine without an automatic replay',t=>{
 const trapped=fakeRuntime(t),runtime=instantiateRustRuntime(trapped.module);trapped.state.trapCall=true;
 assert.throws(()=>runtime.call('nativeInit',[]),error=>error.code==='TRAP');assert.equal(trapped.state.callCalls,1);
 assert.throws(()=>runtime.call('nativeInit',[]),error=>error.code==='QUARANTINED');assert.equal(trapped.state.callCalls,1);

 const descriptor=fakeRuntime(t),descriptorRuntime=instantiateRustRuntime(descriptor.module);descriptor.state.malformedCallDescriptor=true;
 assert.throws(()=>descriptorRuntime.call('nativeInit',[]),error=>error.code==='BAD_DESCRIPTOR');assert.equal(descriptorRuntime.quarantined,true);
});

test('output copy failures release the owned result and quarantine the ambiguous call',t=>{
 const fake=fakeRuntime(t),runtime=instantiateRustRuntime(fake.module),original=ArrayBuffer.prototype.slice;
 let outputPointer;
 fake.state.callBytes=new TextEncoder().encode('1');
 ArrayBuffer.prototype.slice=function(...args){if(this===fake.memory.buffer){outputPointer=[...fake.state.outputPointers].at(-1);throw new Error('copy failure');}return original.apply(this,args);};
 try{assert.throws(()=>runtime.call('nativeInit',[]),error=>error.code==='BAD_COPY');}
 finally{ArrayBuffer.prototype.slice=original;}
 assert.equal(runtime.quarantined,true);assert.ok(fake.state.freeCalls.some(item=>item.pointer===outputPointer));
});

test('malformed UTF-8, BCJSON, packet numbers and write receipts are terminal protocol failures',t=>{
 const utf=fakeRuntime(t),utfRuntime=instantiateRustRuntime(utf.module);utf.state.callBytes=Uint8Array.of(0xff);
 assert.throws(()=>utfRuntime.call('nativeInit',[]),error=>error.code==='BAD_UTF8');assert.equal(utfRuntime.quarantined,true);

 const json=fakeRuntime(t),jsonRuntime=instantiateRustRuntime(json.module);json.state.callBytes=new TextEncoder().encode('{');
 assert.throws(()=>jsonRuntime.call('nativeInit',[]),error=>error.code==='BAD_BCJSON');assert.equal(jsonRuntime.quarantined,true);

 const packet=fakeRuntime(t),packetRuntime=instantiateRustRuntime(packet.module);packet.state.packetNumbers=new Uint8Array(7);
 assert.throws(()=>packetRuntime.packet(['scene']),error=>error.code==='BAD_F64');assert.equal(packetRuntime.quarantined,true);

 const receipt=fakeRuntime(t),receiptRuntime=instantiateRustRuntime(receipt.module);receipt.state.didWrite=2;
 assert.throws(()=>receiptRuntime.writeF64('nativeAsyncTargetBuffer',[],new Float64Array([1])),error=>error.code==='BAD_RECEIPT');assert.equal(receiptRuntime.quarantined,true);
});

test('cleanup failures cannot produce a successful result',t=>{
 const output=fakeRuntime(t),outputRuntime=instantiateRustRuntime(output.module);output.state.freeTrapKind='output';
 assert.throws(()=>outputRuntime.call('nativeInit',[]),error=>error.code==='CLEANUP');assert.equal(outputRuntime.quarantined,true);

 const descriptor=fakeRuntime(t),descriptorRuntime=instantiateRustRuntime(descriptor.module);descriptor.state.freeTrapKind='descriptor';
 assert.throws(()=>descriptorRuntime.call('nativeInit',[]),error=>error.code==='CLEANUP');assert.equal(descriptorRuntime.quarantined,true);

 const input=fakeRuntime(t),inputRuntime=instantiateRustRuntime(input.module);input.state.freeTrapSize=2;
 assert.throws(()=>inputRuntime.call('nativeInit',[]),error=>error.code==='CLEANUP');assert.equal(inputRuntime.quarantined,true);
});

test('host release is accepted exactly once and only during disposal',t=>{
 const normal=fakeRuntime(t),normalRuntime=instantiateRustRuntime(normal.module);normalRuntime.close();assert.equal(normalRuntime.hostReleaseCount,1);assert.equal(normalRuntime.hostReleased,true);

 for(const releaseMode of ['zero','duplicate','wrong']){
  const fake=fakeRuntime(t,{releaseMode}),runtime=instantiateRustRuntime(fake.module);
  assert.throws(()=>runtime.close(),error=>error.code==='HOST_RELEASE',releaseMode);
 }

 const early=fakeRuntime(t),earlyRuntime=instantiateRustRuntime(early.module);early.state.earlyRelease=true;
 assert.throws(()=>earlyRuntime.call('nativeInit',[]),error=>error.code==='HOST_RELEASE');assert.equal(earlyRuntime.quarantined,true);
});

test('reentrant close from custom Math and Intl callbacks is busy without mutating runtime ownership',t=>{
 for(const kind of ['Math','Intl']){
  const fake=fakeRuntime(t);let runtime,closeError,callbackCalls=0;
  const closeInsideCallback=()=>{callbackCalls++;try{runtime.close();}catch(error){closeError=error;}};
  const host=kind==='Math'
   ? {Math:{log(value){closeInsideCallback();return Math.log(value);}}}
   : {Intl:{DateTimeFormat:function(...args){closeInsideCallback();return new Intl.DateTimeFormat(...args);}}};
  if(kind==='Math')fake.state.callHost=env=>env.js_log(2);
  else fake.state.callHost=env=>{const pointer=32,zone=new TextEncoder().encode('UTC');new Uint8Array(fake.memory.buffer).set(zone,pointer);env.zone_offset_seconds(1,pointer,zone.length,0);};
  runtime=instantiateRustRuntime(fake.module,{host});
  assert.equal(runtime.call('nativeInit',[]),0);assert.equal(callbackCalls,1);assert.equal(closeError?.code,'BUSY');
  assert.equal(runtime.closed,false);assert.equal(runtime.engine,1);assert.equal(runtime.hostReleaseCount,0);
  runtime.close();assert.equal(runtime.closed,true);assert.equal(runtime.engine,0);assert.equal(runtime.hostReleaseCount,1);assert.equal(runtime.hostReleased,true);
 }
});

test('negotiated transfer limits are enforced before the write export',t=>{
 const capabilities=validCapabilities();capabilities.maxTransfer=2;const fake=fakeRuntime(t,{capabilities}),runtime=instantiateRustRuntime(fake.module);
 assert.throws(()=>runtime.writeF64('nativeAsyncTargetBuffer',[],new Float64Array(3)),/transfer limit/);assert.equal(fake.state.writeCalls,0);assert.equal(runtime.quarantined,false);runtime.close();
});
