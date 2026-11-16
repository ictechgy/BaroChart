import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {packNativeCommands} from '../src/renderers/native-command-packet.mjs';
import {RustSession} from '../src/web/wasm/session.mjs';
import {loadRustModule} from '../src/web/wasm/runtime.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const settle=promise=>promise.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const wasmModuleBytes=Uint8Array.from([0,97,115,109,1,0,0,0]);

test('WASM buffer snapshot does not invoke a caller-defined buffer species',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs');
 let speciesReads=0;
 class WasmBytes extends ArrayBuffer {static get [Symbol.species](){speciesReads++;throw new Error('caller species');}}
 const source=new WasmBytes(wasmModuleBytes.length);new Uint8Array(source).set(wasmModuleBytes);
 const snapshot=snapshotRustChartCreation(new Container(),{load:{source}});
 assert.equal(speciesReads,0);
 const loaded=await loadRustModule(snapshot.load.source);assert.ok(loaded.module instanceof WebAssembly.Module);
});

test('WASM snapshot owns foreign ArrayBuffers',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs');
 const foreign=runInNewContext('Uint8Array.from([0,97,115,109,1,0,0,0]).buffer');
 const binary=snapshotRustChartCreation(new Container(),{load:{source:foreign}}).load.source;
 assert.ok(binary instanceof ArrayBuffer);assert.notEqual(binary,foreign);
 new Uint8Array(foreign)[0]=255;
 assert.ok((await loadRustModule(binary)).module instanceof WebAssembly.Module);
});

test('WASM Response snapshot ignores caller-defined state and clone overrides',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs');
 let overrideReads=0;
 class AliasResponse extends Response {
  get bodyUsed(){overrideReads++;throw new Error('caller state getter');}
  get body(){overrideReads++;throw new Error('caller body getter');}
  clone(){overrideReads++;return this;}
 }
 const response=new AliasResponse(wasmModuleBytes,{headers:{'Content-Type':'application/wasm'}});
 const owned=snapshotRustChartCreation(new Container(),{load:{source:response}}).load.source;
 assert.notEqual(owned,response);assert.equal(overrideReads,0);
 await Response.prototype.arrayBuffer.call(response);
 assert.ok((await loadRustModule(owned)).module instanceof WebAssembly.Module);
});

class Canvas extends EventTarget {
 constructor(){super();this.style={};this.width=0;this.height=0;this.parent=null;}
 setAttribute(){}focus(){}setPointerCapture(){}releasePointerCapture(){}
 getContext(){return{setTransform(){},clearRect(){},fillRect(){},strokeRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},fill(){},closePath(){},ellipse(){},fillText(){},setLineDash(){}};}
 remove(){this.parent?.remove(this);}
}
class Container {
 constructor(){this.children=[];}
 append(node){node.parent=this;this.children.push(node);}
 remove(node){this.children=this.children.filter(value=>value!==node);node.parent=null;}
 getBoundingClientRect(){return{width:320,height:180};}
}

class Actor {
 constructor({packetError=null,holdPacket=false,closeError=null}={}){this.generation='factory-test';this.closed=0;this.packetError=packetError;this.packetGate=holdPacket?deferred():null;this.closeError=closeError;}
 async packet([, ,width,height]){
  if(this.packetGate)await this.packetGate.promise;
  if(this.packetError!==null)throw this.packetError;
  return packNativeCommands([{commands:[]}],{mode:'scene',width,height,background:'#fff',stats:{commandCount:0}});
 }
 async close(){this.closed++;this.packetGate?.reject(new Error('actor closed'));if(this.closeError!==null)throw this.closeError;}
}

function installDOM(){
 const prior={document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,CustomEvent:globalThis.CustomEvent,devicePixelRatio:globalThis.devicePixelRatio};
 globalThis.document={createElement:()=>new Canvas()};
 globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.devicePixelRatio=1;
 globalThis.CustomEvent=class extends Event{constructor(type,options={}){super(type,options);this.detail=options.detail;}};
 return()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}};
}

test('root import is SSR inert and preserves the synchronous JavaScript chart API',async()=>{
 const before={worker:globalThis.Worker,fetch:globalThis.fetch,document:globalThis.document};let allocations=0;
 globalThis.Worker=class{constructor(){allocations++;}};globalThis.fetch=()=>{allocations++;throw new Error('unexpected fetch');};delete globalThis.document;
 try{
  const root=await import('../src/index.mjs'),javascript=await import('../src/javascript.mjs');
  assert.equal(typeof root.default,'function');assert.equal(root.default,root.createBaroChart);
  assert.equal(root.createChart,javascript.createChart);assert.equal(root.createJavaScriptChart,root.createChart);
  assert.equal(allocations,0);
 }finally{for(const[key,value]of Object.entries(before)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('Rust default factory owns one session and chart and concurrent destroy closes them once',async()=>{
 const restore=installDOM(),actor=new Actor(),session=new RustSession(actor);let sessions=0;
 const backend={backend:'rust-wasm',async createSession(){sessions++;return session;}};
 try{
  const {createBaroChart}=await import('../src/web/rust-default.mjs'),container=new Container();
  const owner=await createBaroChart(container,{backend,view:{interactive:false,observeResize:false}});
  assert.equal(owner.backend,'rust-wasm');assert.equal(owner.session,session);assert.equal(owner.closed,false);assert.equal(sessions,1);assert.equal(container.children.length,1);
  await Promise.all([owner.destroy(),owner.destroy(),owner.destroy()]);
  assert.equal(owner.closed,true);assert.equal(session.closed,true);assert.equal(actor.closed,1);assert.equal(container.children.length,0);
 }finally{restore();}
});

test('factory snapshots session, prepare and view options before the first await',async()=>{
 const restore=installDOM(),gate=deferred(),actor=new Actor(),calls=[];
 class PreparedSession extends RustSession {async prepareData(input,options){calls.push(['prepare',input,options]);return{status:'committed'};}}
 const session=new PreparedSession(actor),sessionOptions={count:0,options:{theme:'dark'}},prepareOptions={timeoutMs:50},view={interactive:false,observeResize:false},prepare={kind:'seeded',count:4};
 try{
  const {default:createBaroChart}=await import('../src/index.mjs'),options={backend:gate.promise,session:sessionOptions,prepare,prepareOptions,view};
  const pending=createBaroChart(new Container(),options);
  options.backend=Promise.reject(new Error('mutated backend'));options.backend.catch(()=>{});sessionOptions.count=9;sessionOptions.options.theme='light';options.prepare={kind:'seeded',count:99};prepareOptions.timeoutMs=500;view.renderer='invalid';
  gate.resolve({backend:'rust-wasm',async createSession(options){calls.push(['session',options]);return session;}});
  const owner=await pending;
  assert.equal(calls[0][0],'session');assert.equal(calls[0][1].count,0);assert.equal(calls[0][1].options.theme,'dark');
  assert.equal(calls[1][0],'prepare');assert.equal(calls[1][1],prepare);assert.equal(calls[1][1].count,4);assert.equal(calls[1][2].timeoutMs,50);assert.ok(calls[1][2].signal===undefined);
  assert.equal(owner.chart.rendererKind,'canvas');await owner.destroy();assert.equal(actor.closed,1);
 }finally{restore();}
});

test('columns reach the existing prepare ownership boundary without a factory copy',async()=>{
 const restore=installDOM(),actor=new Actor(),fields=['time','open','high','low','close','volume'],columns=Object.fromEntries(fields.map((field,index)=>[field,new Float64Array([index,index+1,index+2])])),prepare={kind:'columns',columns,visibleBars:2};let received;
 class PreparedSession extends RustSession {async prepareData(input){received=input;return{status:'committed'};}}
 const session=new PreparedSession(actor);
 try{
  const {default:createBaroChart}=await import('../src/index.mjs'),owner=await createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},prepare,view:{interactive:false,observeResize:false}});
  assert.equal(received,prepare);for(const field of fields){assert.equal(received.columns[field],columns[field]);assert.equal(received.columns[field].buffer,columns[field].buffer);}
  await owner.destroy();
 }finally{restore();}
});

test('creation snapshot owns mutable URL inputs',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),wasmURL=new URL('https://example.test/original.wasm'),workerURL=new URL('https://example.test/worker.mjs');
 const snapshot=snapshotRustChartCreation(new Container(),{load:{wasmURL,workerURL}});wasmURL.pathname='/changed.wasm';workerURL.pathname='/changed-worker.mjs';
 assert.equal(snapshot.load.wasmURL.href,'https://example.test/original.wasm');assert.equal(snapshot.load.workerURL.href,'https://example.test/worker.mjs');
});

test('creation snapshot owns mutable WASM bytes before the async compile path',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),storage=new Uint8Array(wasmModuleBytes.length+2);
 storage.set(wasmModuleBytes,1);const source=new Uint8Array(storage.buffer,1,wasmModuleBytes.length),snapshot=snapshotRustChartCreation(new Container(),{load:{source}});
 source[0]=255;
 const loaded=await loadRustModule(snapshot.load.source);
 assert.ok(loaded.module instanceof WebAssembly.Module);
});

test('creation snapshot copies only the exact WASM view range',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),storage=new Uint8Array(wasmModuleBytes.length+4).fill(255);
 storage.set(wasmModuleBytes,2);const source=new DataView(storage.buffer,2,wasmModuleBytes.length),snapshot=snapshotRustChartCreation(new Container(),{load:{source}});
 assert.ok(snapshot.load.source instanceof ArrayBuffer);assert.deepEqual([...new Uint8Array(snapshot.load.source)], [...wasmModuleBytes]);
 storage.fill(0);const loaded=await loadRustModule(snapshot.load.source);assert.ok(loaded.module instanceof WebAssembly.Module);
});

test('creation snapshot keeps a cloned WASM Response usable after the caller consumes it',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),response=new Response(wasmModuleBytes,{headers:{'Content-Type':'application/wasm'}}),snapshot=snapshotRustChartCreation(new Container(),{load:{source:response}});
 await response.arrayBuffer();
 const loaded=await loadRustModule(snapshot.load.source);assert.ok(loaded.module instanceof WebAssembly.Module);
});

test('consumed WASM Response fails synchronously before backend allocation',async()=>{
 const {createBaroChart}=await import('../src/web/rust-default.mjs'),response=new Response(wasmModuleBytes);await response.arrayBuffer();let sessions=0;
 assert.throws(()=>createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){sessions++;}},load:{source:response}}),/WASM Response/i);assert.equal(sessions,0);
});

test('detaching the caller WASM buffer after the snapshot does not affect compilation',async()=>{
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),buffer=wasmModuleBytes.slice().buffer,source=new Uint8Array(buffer),snapshot=snapshotRustChartCreation(new Container(),{load:{source}}),channel=new MessageChannel();
 try{channel.port1.postMessage(buffer,[buffer]);const loaded=await loadRustModule(snapshot.load.source);assert.ok(loaded.module instanceof WebAssembly.Module);}
 finally{channel.port1.close();channel.port2.close();}
});

test('creation snapshot keeps SharedArrayBuffer WASM sources unsupported',async()=>{
 if(typeof SharedArrayBuffer!=='function')return;
 const {snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),buffer=new SharedArrayBuffer(wasmModuleBytes.length);
 new Uint8Array(buffer).set(wasmModuleBytes);
 assert.throws(()=>snapshotRustChartCreation(new Container(),{load:{source:new Uint8Array(buffer)}}),/ArrayBuffer/i);
});

test('creation snapshot copies foreign-realm WASM views into local ArrayBuffers',async()=>{
 const {default:vm}=await import('node:vm'),{snapshotRustChartCreation}=await import('../src/web/rust-default-options.mjs'),foreignTyped=vm.runInNewContext(`Uint8Array.from([${wasmModuleBytes}])`),foreignDataView=vm.runInNewContext(`new DataView(Uint8Array.from([255,${wasmModuleBytes},255]).buffer,1,${wasmModuleBytes.length})`);
 for(const source of [foreignTyped,foreignDataView]){
  const snapshot=snapshotRustChartCreation(new Container(),{load:{source}});
  assert.ok(snapshot.load.source instanceof ArrayBuffer);assert.deepEqual([...new Uint8Array(snapshot.load.source)], [...wasmModuleBytes]);
  if(typeof source.setUint8==='function')source.setUint8(0,255);else source[0]=255;
  const loaded=await loadRustModule(snapshot.load.source);assert.ok(loaded.module instanceof WebAssembly.Module);
 }
});

test('root default export compiles an owned WASM snapshot before later source mutation',async()=>{
 const {default:createBaroChart}=await import('../src/index.mjs'),source=wasmModuleBytes.slice(),originalCompile=WebAssembly.compile,compiled=[];
 WebAssembly.compile=async bytes=>{compiled.push(Uint8Array.from(new Uint8Array(bytes)));return originalCompile.call(WebAssembly,bytes);};
 try{
  const pending=createBaroChart(new Container(),{load:{source},view:{interactive:false,observeResize:false}});source[0]=255;
  await assert.rejects(pending);assert.deepEqual(compiled,[wasmModuleBytes]);
 }finally{WebAssembly.compile=originalCompile;}
});

test('invalid container and pre-abort allocate no backend or session',async()=>{
 const {createBaroChart}=await import('../src/web/rust-default.mjs');let reads=0;
 assert.throws(()=>createBaroChart(null,{get backend(){reads++;throw new Error('backend read');}}),/container/i);assert.equal(reads,0);
 const controller=new AbortController();controller.abort();
 assert.throws(()=>createBaroChart(new Container(),{get backend(){reads++;throw new Error('backend read');},signal:controller.signal}),{name:'AbortError'});assert.equal(reads,0);
});

test('invalid view options reject before a backend or session is allocated',async()=>{
 const {default:createBaroChart}=await import('../src/index.mjs');let sessions=0;
 const backend={backend:'rust-wasm',async createSession(){sessions++;throw new Error('must not allocate');}};
 for(const view of [{renderer:'bad'},{dpr:1},{interactive:'yes'},{observeResize:1},{onError:true}])assert.throws(()=>createBaroChart(new Container(),{backend,view}),/Rust chart/);
 assert.equal(sessions,0);
});

test('abort settles a never-resolving injected backend without poisoning it for another caller',async()=>{
 const restore=installDOM(),gate=deferred(),controller=new AbortController();
 try{
  const {createBaroChart}=await import('../src/web/rust-default.mjs'),container=new Container();
  const first=createBaroChart(container,{backend:gate.promise,signal:controller.signal,view:{interactive:false,observeResize:false}});controller.abort();
  assert.equal((await settle(first)).reason.name,'AbortError');
  const actor=new Actor(),session=new RustSession(actor);gate.resolve({backend:'rust-wasm',async createSession(){return session;}});
  const owner=await createBaroChart(container,{backend:gate.promise,view:{interactive:false,observeResize:false}});await owner.destroy();assert.equal(actor.closed,1);
 }finally{restore();}
});

test('abort during session, prepare and first render settles and releases every acquired owner',async()=>{
 const restore=installDOM(),{createBaroChart}=await import('../src/web/rust-default.mjs');
 try{
  {
   const controller=new AbortController(),started=deferred(),backend={backend:'rust-wasm',createSession(){started.resolve();return new Promise(()=>{});}};
   const pending=createBaroChart(new Container(),{backend,signal:controller.signal});await started.promise;controller.abort();assert.equal((await settle(pending)).reason.name,'AbortError');
  }
  {
   const controller=new AbortController(),started=deferred(),session={closed:0,prepareData(){started.resolve();return new Promise(()=>{});},async close(){this.closed++;}};
   const pending=createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},prepare:{kind:'seeded',count:1},signal:controller.signal});await started.promise;controller.abort();assert.equal((await settle(pending)).reason.name,'AbortError');await turn();assert.equal(session.closed,1);
  }
  {
   const controller=new AbortController(),actor=new Actor({holdPacket:true}),session=new RustSession(actor),pending=createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},signal:controller.signal,view:{interactive:false,observeResize:false}});
   await turn();controller.abort();assert.equal((await settle(pending)).reason.name,'AbortError');await turn();assert.equal(actor.closed,1);assert.equal(session.closed,true);
  }
  {
   const controller=new AbortController(),actor=new Actor(),session=new RustSession(actor),container=new Container(),append=container.append.bind(container);
   container.append=node=>{append(node);controller.abort();};
   const pending=createBaroChart(container,{backend:{backend:'rust-wasm',async createSession(){return session;}},signal:controller.signal,view:{interactive:false,observeResize:false}});
   const result=await settle(pending);assert.equal(result.reason.name,'AbortError');await turn();assert.equal(actor.closed,1);assert.equal(container.children.length,0);
  }
 }finally{restore();}
});

test('first-render failure closes its session and never falls back to JavaScript',async()=>{
 const restore=installDOM(),failure=new Error('first render failed'),actor=new Actor({packetError:failure}),session=new RustSession(actor);let sessions=0;
 try{
  const {createBaroChart}=await import('../src/web/rust-default.mjs');
  await assert.rejects(createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){sessions++;return session;}},view:{interactive:false,observeResize:false}}),error=>error===failure);
  assert.equal(sessions,1);assert.equal(actor.closed,1);assert.equal(session.closed,true);
 }finally{restore();}
});

test('successful owner surfaces one cleanup failure and shares one destroy promise',async()=>{
 const restore=installDOM(),failure=new Error('close failed'),actor=new Actor({closeError:failure}),session=new RustSession(actor);
 try{
  const {createBaroChart}=await import('../src/web/rust-default.mjs'),owner=await createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},view:{interactive:false,observeResize:false}});
  const first=owner.destroy(),second=owner.destroy();assert.equal(first,second);
  await assert.rejects(first,error=>error===failure);assert.equal(owner.closed,true);assert.equal(actor.closed,1);
 }finally{restore();}
});

test('destroy attempts chart and session cleanup and aggregates both failures',async()=>{
 const restore=installDOM(),chartFailure=new Error('chart cleanup failed'),sessionFailure=new Error('session cleanup failed'),actor=new Actor({closeError:sessionFailure}),session=new RustSession(actor);
 try{
  const {createBaroChart}=await import('../src/web/rust-default.mjs'),owner=await createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},view:{interactive:false,observeResize:false}});
  owner.chart.destroy=async()=>{throw chartFailure;};
  const result=await settle(owner.destroy());assert.ok(result.reason instanceof AggregateError);assert.deepEqual(result.reason.errors,[chartFailure,sessionFailure]);assert.equal(result.reason.cause,chartFailure);assert.equal(actor.closed,1);
 }finally{restore();}
});

for(const primary of [undefined,null,false])test(`successful cleanup preserves a ${String(primary)} primary failure`,async()=>{
 const {createBaroChart}=await import('../src/web/rust-default.mjs');
 const session={prepareData(){return Promise.reject(primary);},async close(){}};
 const result=await settle(createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},prepare:{kind:'seeded',count:1}}));
 assert.equal(result.status,'rejected');assert.equal(result.reason,primary);
});

for(const primary of [undefined,null,false])test(`cleanup failure aggregates a ${String(primary)} creation failure without loss`,async()=>{
 const {createBaroChart}=await import('../src/web/rust-default.mjs'),cleanupFailure=new Error('cleanup failed');
 const session={prepareData(){return Promise.reject(primary);},close(){throw cleanupFailure;}};
 const result=await settle(createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},prepare:{kind:'seeded',count:1}}));
 assert.ok(result.reason instanceof AggregateError);assert.deepEqual(result.reason.errors,[primary,cleanupFailure]);assert.equal(result.reason.cause,primary);
});

test('abort result retains asynchronous cleanup failures',async()=>{
 const {createBaroChart}=await import('../src/web/rust-default.mjs'),controller=new AbortController(),started=deferred(),cleanupFailure=new Error('late close failed');
 const session={prepareData(){started.resolve();return new Promise(()=>{});},async close(){throw cleanupFailure;}};
 const pending=createBaroChart(new Container(),{backend:{backend:'rust-wasm',async createSession(){return session;}},prepare:{kind:'seeded',count:1},signal:controller.signal});
 await started.promise;controller.abort();const result=await settle(pending);await turn();assert.equal(result.reason.name,'AbortError');assert.deepEqual(result.reason.cleanupErrors,[cleanupFailure]);assert.equal(result.reason.cause,cleanupFailure);
});
