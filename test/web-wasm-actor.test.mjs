import assert from 'node:assert/strict';
import test from 'node:test';
import {createRustActor, RustActorProtocolError, RustActorTimeoutError} from '../src/web/wasm/actor.mjs';

const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
const capabilities = {schema:'barochart.web-wasm.capabilities',version:1,abi:1,transfer:'f64-le',packetVersion:1,maxTransfer:262144,implemented:['nativeInit','nativeCommand','nativeScenePacket'],unavailable:[]};

class FakeWorker {
  static instances=[];
  constructor() { this.listeners=new Map(); this.messages=[]; this.responses={}; this.terminated=false; this.terminateCount=0; this.hang=false; this.hangInit=false; this.wrongType=false; this.malformed=false; FakeWorker.instances.push(this); }
  addEventListener(type,handler) { const set=this.listeners.get(type)??new Set();set.add(handler);this.listeners.set(type,set); }
  removeEventListener(type,handler) { this.listeners.get(type)?.delete(handler); }
  emit(type,data) { for(const handler of this.listeners.get(type)??[])handler({data,message:data}); }
  postMessage(message,transfer=[]) {
    this.messages.push({message,transfer});
    if(message.type==='init'&&!this.hangInit) queueMicrotask(()=>this.emit('message',{protocol:1,generation:message.generation,id:message.id,type:'ready',capabilities}));
    else if(message.type==='close') queueMicrotask(()=>this.emit('message',{protocol:1,generation:message.generation,id:message.id,type:'closed'}));
    else if(message.type==='rpc'&&!this.hang) queueMicrotask(()=>{
      let value;
      if(this.wrongType) { this.emit('message',{protocol:1,generation:message.generation,id:message.id,type:'ready',capabilities}); return; }
      if(Object.hasOwn(this.responses,message.method)) value=this.responses[message.method];
      else if(message.method==='call') value={name:message.name,args:message.args};
      else if(message.method==='readF64') value=this.malformed?{not:'float64'}:new Float64Array([1.5,-0]);
      else if(message.method==='writeF64') value=true;
      else if(message.method==='packet') value={metadata:{ok:true},numbers:new Float64Array([2.5])};
      else if(message.method==='capabilities') value=capabilities;
      else if(message.method==='memoryStats') value={requested:0};
      this.emit('message',{protocol:1,generation:message.generation,id:message.id,type:'result',value});
    });
  }
  terminate() { this.terminated=true; this.terminateCount++; }
}

function withFake(testBody) {
  return async t => {
    const previous=globalThis.Worker;globalThis.Worker=FakeWorker;t.after(()=>{globalThis.Worker=previous;FakeWorker.instances.length=0;});return testBody(t);
  };
}

test('actor creates a worker-owned generation and preserves request ordering',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});
  const first=actor.call('nativeInit',[1]);const second=actor.call('nativeCommand',['scene']);
  assert.deepEqual(await first,{name:'nativeInit',args:[1]});assert.deepEqual(await second,{name:'nativeCommand',args:['scene']});
  const worker=FakeWorker.instances[0];assert.equal(worker.messages[0].message.type,'init');assert.equal(worker.messages[1].message.id<worker.messages[2].message.id,true);
  await actor.close();assert.equal(actor.closed,true);assert.equal(worker.terminated,true);
}));

test('writeF64 copies caller memory before transferring it',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const values=new Float64Array([1,-0,3]);const before=values.slice();
  assert.equal(await actor.writeF64('nativePrepare',[],values),true);assert.deepEqual(Array.from(values),Array.from(before));
  const request=FakeWorker.instances[0].messages.find(item=>item.message.method==='writeF64');assert.ok(request.transfer.includes(request.message.values.buffer));assert.notEqual(request.message.values.buffer,values.buffer);await actor.close();
}));

test('worker errors preserve error fields and do not retry',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];
  worker.hang=true;
  const pending=actor.call('nativeSource',[]);
  worker.emit('message',{protocol:1,generation:actor.generation,id:2,type:'error',error:{name:'UnavailableError',message:'missing',code:'JAVASCRIPT_BACKEND_REQUIRED',phase:'rpc',quarantine:false}});
  await assert.rejects(pending,error=>error.name==='UnavailableError'&&error.code==='JAVASCRIPT_BACKEND_REQUIRED');
  assert.equal(worker.messages.filter(item=>item.message.method==='nativeSource').length,0);await actor.close();
}));

test('timeout quarantines and terminates the actor without an automatic retry',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:20});const worker=FakeWorker.instances[0];worker.hang=true;
  await assert.rejects(actor.call('nativeScenePacket',[]),error=>error instanceof RustActorTimeoutError&&error.quarantine===true);assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);
  await assert.rejects(actor.call('nativeScenePacket',[]),error=>error.code==='QUARANTINED');
}));

test('wrong generation is a protocol quarantine',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];
  worker.hang=true;
  const pending=actor.call('nativeInit',[]);
  worker.emit('message',{protocol:1,generation:'wrong',id:2,type:'result',value:true});
  await assert.rejects(pending,error=>error instanceof RustActorProtocolError&&error.quarantine===true);assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);
}));

test('close is idempotent and blocks new requests',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const close1=actor.close();const close2=actor.close();assert.strictEqual(close1,close2);await close1;await assert.rejects(actor.call('nativeInit',[]),error=>error.code==='CLOSED');
}));

test('wrong response type rejects its own request instead of leaving it pending',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];worker.wrongType=true;
  await assert.rejects(actor.call('nativeInit',[]),error=>error instanceof RustActorProtocolError&&error.code==='BAD_RESPONSE_TYPE');assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);
}));

test('malformed Float64 result rejects promptly and quarantines the actor',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];worker.malformed=true;
  await assert.rejects(actor.readF64('nativeIndicatorBuffer',[]),error=>error instanceof RustActorProtocolError&&error.code==='BAD_RESULT');assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);
}));

test('falsy and malformed packet replies reject promptly and quarantine without replay',withFake(async()=>{
 for(const value of [null,undefined,false,0]){
  const actor=await createRustActor({module,timeoutMs:100}),worker=FakeWorker.instances.at(-1);worker.responses.packet=value;
  await assert.rejects(actor.packet([]),error=>error instanceof RustActorProtocolError&&error.code==='BAD_RESULT');
  assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);assert.equal(worker.messages.filter(item=>item.message.method==='packet').length,1);
 }
 const actor=await createRustActor({module,timeoutMs:100}),worker=FakeWorker.instances.at(-1);worker.responses.packet={metadata:{},numbers:'not-f64'};
 await assert.rejects(actor.packet([]),error=>error instanceof RustActorProtocolError&&error.code==='BAD_RESULT');assert.equal(actor.quarantined,true);
}));

test('write receipts require booleans while both true and false remain valid',withFake(async()=>{
 const actor=await createRustActor({module,timeoutMs:100}),worker=FakeWorker.instances.at(-1);
 assert.equal(await actor.writeF64('nativePrepare',[],new Float64Array()),true);
 worker.responses.writeF64=false;assert.equal(await actor.writeF64('nativePrepare',[],new Float64Array()),false);assert.equal(actor.quarantined,false);await actor.close();
 for(const value of [null,undefined,0,1,'not-boolean',{}]){
  const malformed=await createRustActor({module,timeoutMs:100}),malformedWorker=FakeWorker.instances.at(-1);malformedWorker.responses.writeF64=value;
  await assert.rejects(malformed.writeF64('nativePrepare',[],new Float64Array()),error=>error instanceof RustActorProtocolError&&error.code==='BAD_RESULT');
  assert.equal(malformed.quarantined,true);assert.equal(malformedWorker.terminated,true);assert.equal(malformedWorker.messages.filter(item=>item.message.method==='writeF64').length,1);
 }
}));

test('a malformed reply settles its request and quarantined siblings exactly once',withFake(async()=>{
 const actor=await createRustActor({module,timeoutMs:100}),worker=FakeWorker.instances.at(-1);worker.hang=true;let packetSettles=0,siblingSettles=0;
 const packet=actor.packet([]).catch(error=>{packetSettles++;throw error;}),sibling=actor.call('nativeInit',[]).catch(error=>{siblingSettles++;throw error;});
 worker.emit('message',{protocol:1,generation:actor.generation,id:2,type:'result',value:null});
 const results=await Promise.allSettled([packet,sibling]);assert.deepEqual(results.map(result=>result.status),['rejected','rejected']);
 worker.emit('message',{protocol:1,generation:actor.generation,id:2,type:'result',value:null});await Promise.resolve();
 assert.equal(packetSettles,1);assert.equal(siblingSettles,1);assert.equal(actor.quarantined,true);assert.equal(worker.terminateCount,1);
}));

test('aborting initialization terminates the worker and does not leave a late actor',async()=>{
  const previous=globalThis.Worker;globalThis.Worker=FakeWorker;FakeWorker.instances.length=0;
  try {
    const controller=new AbortController();const pending=createRustActor({module,signal:controller.signal,timeoutMs:100});const worker=FakeWorker.instances[0];worker.hangInit=true;controller.abort();
    await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(worker.terminated,true);
  } finally { globalThis.Worker=previous;FakeWorker.instances.length=0; }
});

test('worker entry does not hijack window-like globals when imported outside a Worker',async()=>{
  const postDescriptor=Object.getOwnPropertyDescriptor(globalThis,'postMessage');
  const messageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'onmessage');
  const sentinel=()=>{};
  try {
    Object.defineProperty(globalThis,'postMessage',{configurable:true,writable:true,value:()=>{}});
    Object.defineProperty(globalThis,'onmessage',{configurable:true,writable:true,value:sentinel});
    await import(`../src/web/wasm/worker-entry.mjs?window-probe=${Date.now()}`);
    assert.strictEqual(globalThis.onmessage,sentinel);
  } finally {
    if (postDescriptor) Object.defineProperty(globalThis,'postMessage',postDescriptor); else delete globalThis.postMessage;
    if (messageDescriptor) Object.defineProperty(globalThis,'onmessage',messageDescriptor); else delete globalThis.onmessage;
  }
});

test('close abandons pending RPCs, ignores their late replies, then drains close ack',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];worker.hang=true;
  const pending=actor.call('nativeScenePacket',[]);const closing=actor.close();
  await assert.rejects(pending,error=>error.name==='RustActorClosedError'&&error.code==='CLOSED');
  worker.emit('message',{protocol:1,generation:actor.generation,id:2,type:'result',value:{late:true}});
  worker.emit('message',{protocol:1,generation:actor.generation,id:2,type:'error',error:{name:'UnavailableError',message:'late',code:'LATE',phase:'rpc'}});
  await closing;assert.equal(actor.quarantined,false);assert.equal(actor.closed,true);assert.equal(worker.terminated,true);assert.equal(worker.terminateCount,1);
}));

test('arbitrary unknown reply during close is still a protocol failure',withFake(async()=>{
  const actor=await createRustActor({module,timeoutMs:100});const worker=FakeWorker.instances[0];worker.hang=true;
  const closing=actor.close();worker.emit('message',{protocol:1,generation:actor.generation,id:999,type:'result',value:true});
  await assert.rejects(closing,error=>error instanceof RustActorProtocolError&&error.quarantine===true);assert.equal(actor.quarantined,true);assert.equal(worker.terminated,true);
}));
