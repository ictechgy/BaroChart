import assert from 'node:assert/strict';
import test from 'node:test';
import {openRustSession} from '../src/web/wasm/session.mjs';

class Actor {
 initialCapabilities={implemented:['nativeInit','nativeCommand','nativeScenePacket','nativeSaveWorkspace','nativePrepareBegin','nativePrepareCreate','nativeAsyncBuffer','nativeAsyncTargetBuffer','nativeAsyncStart','nativeAsyncStep','nativeAsyncUIBegin','nativeAsyncUINext','nativeAsyncUICheck','nativeAsyncUIImportBegin','nativeAsyncUIImportChunk','nativeAsyncUIImportEnd','nativeAsyncFinish','nativeAsyncRelease','nativeParamsTargetCreate','nativeParamsTargetStart','nativeParamsTargetStep','nativeParamsTargetDescriptor','nativeParamsTargetCheckpoint','nativeWorkspaceTargetCreate','nativeWorkspaceTargetFinish']};
 generation='test-actor';calls=[];closed=0;failState=false;quarantined=false;
 state={schema:'aster.web-wasm.presentation',version:1,data:{length:10,version:1},view:{from:0,to:9,follow:true},interaction:{tool:'select'},drawings:{selected:null,canUndo:false,canRedo:false}};
 async call(name,args=[]){
  this.calls.push([name,...(name==='nativeCommand'?[args[0]]:[])]);
  if(name==='web.capabilities')return {schema:'aster.web-wasm.capabilities',version:1,maxTransfer:262144,typedReads:['web.dataColumn'],implemented:['web.capabilities','web.presentationState','web.configuration','web.drawingsState','web.indicatorCatalog','web.layoutCapture','web.layoutReferences','web.applyLayoutFrame',...['Begin','Step','Check','Receive','ArmWrite','Checkpoint','Validate','Prepare','Publish','Status','Abort'].map(suffix=>'web.paramsSource'+suffix),...['Begin','Step','UiBegin','UiNext','Check','Finish','Abort'].map(suffix=>'web.migrationSource'+suffix),...['Create','Start','Step','UiBegin','UiChunk','UiFinish','Abort'].map(suffix=>'web.migrationTarget'+suffix)]};
  if(name==='nativeInit')return args[0];
  if(name==='web.presentationState'){if(this.failState){this.failState=false;throw new Error('snapshot unavailable');}return structuredClone(this.state);}
  if(name==='nativeCommand'){this.state.view.from++;return null;}
  return {};
 }
 async packet(){return {metadata:{},numbers:new Float64Array()};}
 async readF64(name,[field,start,count,version]){if(name!=='web.dataColumn'||version!==this.state.data.version)throw new Error('Stale data export');return Float64Array.from({length:count},(_,index)=>start+index);}
 async memoryStats(){return {};}
 async close(){this.closed++;}
}

const waitTurn=()=>new Promise(resolve=>setImmediate(resolve));
const bounded=(promise,ms=50)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('operation did not settle')),ms);})]).finally(()=>clearTimeout(timer));};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const PREPARE_HEADER=JSON.stringify({schema:'aster.async.ui',protocol:1,state:{drawings:{frameCounts:[0],undoCount:0,redoCount:0}}});

function enableSuccessfulPrepare(source){
 const original=source.call.bind(source);let uiComplete=false;
 source.call=async(name,args=[])=>{
  if(name==='nativePrepareBegin')return {ticket:7,metadataJSON:'{"schema":"aster.prepare"}',buffers:[],checkpoints:[]};
  if(name==='nativeAsyncUIBegin')return PREPARE_HEADER;
  if(name==='nativeAsyncUINext'){if(uiComplete)throw new Error('unexpected prepare UI read');uiComplete=true;return JSON.stringify({complete:true});}
  if(name==='nativeAsyncUICheck'||name==='nativeAsyncRelease')return true;
  return original(name,args);
 };
 const candidate=new Actor();candidate.generation='prepared-actor';candidate.state.view.from=42;
 const candidateCall=candidate.call.bind(candidate);
 candidate.call=async(name,args=[])=>{
  if(['nativePrepareCreate','nativeAsyncStart','nativeAsyncUIImportBegin','nativeAsyncUIImportEnd','nativeAsyncFinish'].includes(name))return true;
  if(name==='nativeAsyncStep')return {phase:'ready',done:1,total:1,complete:true};
  return candidateCall(name,args);
 };
 candidate.writeF64=async()=>true;
 return candidate;
}

test('session serializes a mutation and its authoritative state before the next mutation',async()=>{
 const actor=new Actor(),session=await openRustSession(actor,{count:10});actor.calls=[];
 await Promise.all([session.command('pan',[1]),session.command('pan',[2])]);
 assert.deepEqual(actor.calls,[['nativeCommand','pan'],['web.presentationState'],['nativeCommand','pan'],['web.presentationState']]);
 assert.equal(session.snapshot().view.from,2);assert.equal(session.snapshot().revision,2);
 assert.throws(()=>{session.snapshot().view.from=999;},TypeError);
 await session.close();
});

test('nested subscription commands publish complete snapshots in order without listener state mixing',async()=>{
 const session=await openRustSession(new Actor());const events=[];let nested;
 session.subscribe(state=>{events.push(['first',state.revision,state.view.from]);if(state.revision===1)nested=session.command('pan',[1]);});
 session.subscribe(state=>events.push(['second',state.revision,state.view.from]));
 await session.command('pan',[1]);await nested;
 assert.deepEqual(events,[['first',1,1],['second',1,1],['first',2,2],['second',2,2]]);
 await session.close();
});

test('post-mutation snapshot failure blocks further mutations without retry until explicit resync',async()=>{
 const actor=new Actor(),session=await openRustSession(actor);actor.failState=true;
 await assert.rejects(session.command('pan',[1]),/resync/i);
 const calls=actor.calls.filter(([name])=>name==='nativeCommand').length;
 await assert.rejects(session.command('pan',[2]),/resync/i);
 assert.equal(actor.calls.filter(([name])=>name==='nativeCommand').length,calls);
 await session.resync();assert.equal(session.snapshot().view.from,1);
 await session.command('pan',[3]);assert.equal(session.snapshot().view.from,2);
 await session.close();
});

test('session and view lifetimes are separate, single-view attachment is explicit and close is idempotent',async()=>{
 const actor=new Actor(),session=await openRustSession(actor),view={closed:0,onSessionClose(){this.closed++;}};
 session.claimView(view);assert.throws(()=>session.claimView({}),/view/i);
 session.releaseView({});assert.throws(()=>session.claimView({}),/view/i);
 session.releaseView(view);session.claimView(view);
 await session.close();await session.close();assert.equal(actor.closed,1);assert.equal(view.closed,1);
 await assert.rejects(session.command('pan',[1]),/closed/i);
});

test('typed data exports are owned, revision-checked, bounded slices and never replayed after a stale result',async()=>{
 const actor=new Actor(),session=await openRustSession(actor);
 const values=await session.readDataColumn('close',2,3);assert.deepEqual(values,new Float64Array([2,3,4]));
 values[0]=999;assert.deepEqual(await session.readDataColumn('close',2,3),new Float64Array([2,3,4]));
 actor.state.data.version++;
 await assert.rejects(session.readDataColumn('close',2,3),/Stale/);
 await session.resync();
 const exported=await session.exportColumns({maxBars:10});
 assert.deepEqual(Object.keys(exported.columns),['time','open','high','low','close','volume']);
 assert.equal(exported.length,10);assert.equal(exported.version,2);
 assert.deepEqual(exported.columns.close,Float64Array.from({length:10},(_,index)=>index));
 await assert.rejects(session.exportColumns({maxBars:9}),/limit/i);
 await session.close();
});

test('session params job owns registration, serializes publication with snapshot and rejects overlapping jobs',async()=>{
 const actor=new Actor();let release;
 const original=actor.call.bind(actor);
 actor.call=async(name,args)=>{
  if(name==='web.paramsSourceBegin'){assert.equal(args[4],1);return {ticket:4,registration:1,phase:'noop'};}
  if(name==='web.paramsSourceStep')return {complete:true,phase:'noop'};
  if(name==='web.paramsSourceCheck'||name==='web.paramsSourcePrepare')return true;
  if(name==='web.paramsSourcePublish'){actor.state.view.from=8;return {status:'unchanged'};}
  return original(name,args);
 };
 const session=await openRustSession(actor),running=session.setIndicatorParams('ema',{period:9},{onProgress:progress=>progress.stage==='source-admission'?new Promise(yes=>{release=yes;}):undefined});
 while(!release)await new Promise(yes=>setImmediate(yes));
 assert.equal(session.activeJob,'params');
 await assert.rejects(session.setIndicatorParams('ema',{period:8}),/job/i);
 await session.command('pan',[1]);release();
 assert.equal((await running).status,'unchanged');assert.equal(session.activeJob,null);
 assert.equal(session.snapshot().view.from,8);assert.equal(session.snapshot().revision,2);
 await session.close();
});

test('public session calls cannot enter internal Rust job protocols',async()=>{
 const actor=new Actor(),session=await openRustSession(actor);const before=actor.calls.length;
 await assert.rejects(session.invoke('web.paramsSourceBegin',['ema',{},0,1000,1]),/interaction/i);
 await assert.rejects(session.invoke('nativeParamsTargetCreate',['{}']),/interaction/i);
 assert.equal(actor.calls.length,before);await session.close();
});

test('custom indicator callbacks fail with an explicit JavaScript requirement before cloning or dispatch',async()=>{
 const actor=new Actor(),session=await openRustSession(actor),before=actor.calls.length;
 for(const call of [()=>session.registerIndicatorSource('custom',()=>{}),()=>session.command('registerIndicator',['custom',()=>{}])])await assert.rejects(call(),error=>error.code==='JAVASCRIPT_BACKEND_REQUIRED');
 assert.equal(actor.calls.length,before);await session.close();
});

test('handshake requires typed data support and exports obey the negotiated chunk limit',async()=>{
 const missing=new Actor(),original=missing.call.bind(missing);
 missing.call=async(name,args)=>{const value=await original(name,args);if(name==='web.capabilities')value.typedReads=[];return value;};
 await assert.rejects(openRustSession(missing),/protocol/i);assert.equal(missing.closed,1);
 const actor=new Actor(),call=actor.call.bind(actor),reads=[];
 actor.call=async(name,args)=>{const value=await call(name,args);if(name==='web.capabilities')value.maxTransfer=3;return value;};
 const read=actor.readF64.bind(actor);actor.readF64=async(name,args)=>{reads.push(args[2]);return read(name,args);};
 const session=await openRustSession(actor);await session.exportColumns();
 assert.equal(reads.length,24);assert.ok(reads.every(count=>count<=3));
 await assert.rejects(session.readDataColumn('close',0,4),/transfer limit/i);await session.close();
});

test('actor handshake rejects missing executable prepare operations before initialization',async()=>{
 const actor=new Actor();actor.initialCapabilities.implemented=actor.initialCapabilities.implemented.filter(name=>name!=='nativeAsyncFinish');
 await assert.rejects(openRustSession(actor),/job protocol/i);assert.equal(actor.calls.length,0);assert.equal(actor.closed,1);
});

test('a mutation admitted before a candidate job keeps its call order',async()=>{
 const session=await openRustSession(new Actor());
 const earlier=session.command('pan',[1]),later=session.prepareData({kind:'invalid'});
 await assert.rejects(later);await earlier;assert.equal(session.snapshot().view.from,1);await session.close();
});

test('an already-aborted candidate job rejects before calling view.flush',async()=>{
 const actor=new Actor(),session=await openRustSession(actor),controller=new AbortController(),view={flushCalls:0,flush(){this.flushCalls++;return new Promise(()=>{});}};
 session.claimView(view);controller.abort();const pending=session.prepareData({kind:'seeded',count:1},{signal:controller.signal,timeoutMs:100});
 assert.equal(view.flushCalls,0);await assert.rejects(pending,error=>error.name==='AbortError'&&error.code==='ABORTED');assert.equal(session.activeJob,null);await session.close();
});

test('abort during a pending flush releases job and view ownership, ignores late flush, and permits fresh promotion',async()=>{
 const source=new Actor(),candidate=enableSuccessfulPrepare(source),session=await openRustSession(source,{createActor:async()=>candidate}),gate=deferred(),controller=new AbortController();
 const view={flushCalls:0,pauses:0,resumes:0,flush(){this.flushCalls++;return this.flushCalls===1?gate.promise:Promise.resolve();},pausePresentation(){this.pauses++;},resumePresentation(){this.resumes++;},promotionSize(){return{width:1,height:1};},stagePresentation(){return{commit(){},discard(){}};}};
 session.claimView(view);const pending=session.prepareData({kind:'seeded',count:1},{signal:controller.signal,timeoutMs:1000});await waitTurn();assert.equal(view.flushCalls,1);controller.abort();
 await assert.rejects(bounded(pending),error=>error.name==='AbortError'&&error.code==='ABORTED');assert.equal(session.activeJob,null);assert.equal(view.pauses,0);assert.equal(source.calls.some(([name])=>name==='nativePrepareBegin'),false);
 gate.resolve();await waitTurn();assert.equal(view.pauses,0);assert.equal(source.calls.some(([name])=>name==='nativePrepareBegin'),false);assert.equal(session.generation,'test-actor');
 const result=await session.prepareData({kind:'seeded',count:1},{timeoutMs:1000});assert.equal(result.status,'committed');assert.equal(session.generation,'prepared-actor');assert.equal(session.snapshot().view.from,42);assert.equal(source.closed,1);assert.equal(view.pauses,1);assert.equal(view.resumes,1);await session.close();
});

test('candidate timeout covers a never-resolving flush and late resolution cannot start the candidate',async()=>{
 const actor=new Actor(),session=await openRustSession(actor),gate=deferred();let pauses=0;
 session.claimView({flush:()=>gate.promise,pausePresentation(){pauses++;},resumePresentation(){pauses--;}});
 const pending=session.prepareData({kind:'seeded',count:1},{timeoutMs:20});
 await assert.rejects(bounded(pending),error=>error.name==='TimeoutError'&&error.code==='TIMEOUT');assert.equal(session.activeJob,null);assert.equal(pauses,0);
 gate.resolve();await waitTurn();assert.equal(actor.calls.some(([name])=>name==='nativePrepareBegin'),false);assert.equal(pauses,0);await session.close();
});

test('candidate admission passes only its remaining deadline budget to the coordinator',async t=>{
 const actor=new Actor(),originalCall=actor.call.bind(actor);actor.call=async(name,args)=>name==='nativePrepareBegin'?new Promise(()=>{}):originalCall(name,args);
 const session=await openRustSession(actor),gate=deferred(),controller=new AbortController(),realSetTimeout=globalThis.setTimeout,delays=[];
 session.claimView({flush:()=>gate.promise,pausePresentation(){},resumePresentation(){}});
 globalThis.setTimeout=(handler,delay,...args)=>{delays.push(delay);return realSetTimeout(handler,delay,...args);};t.after(()=>{globalThis.setTimeout=realSetTimeout;});
 const pending=session.prepareData({kind:'seeded',count:1},{signal:controller.signal,timeoutMs:1000});
 try{
  await new Promise(resolve=>realSetTimeout(resolve,25));gate.resolve();await waitTurn();await waitTurn();
  assert.ok(delays.length>=2,`expected admission and coordinator deadlines, got ${delays}`);assert.ok(delays[1]<delays[0]-10,`expected remaining timeout budget, got ${delays}`);
 }finally{controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');await session.close();}
 assert.equal(session.activeJob,null);
});

test('abort and timeout also release a candidate waiting at the session queue barrier',async()=>{
 for(const mode of ['abort','timeout']){
  const actor=new Actor(),originalCall=actor.call.bind(actor),mutationGate=deferred(),entered=deferred();
  actor.call=async(name,args)=>{if(name==='nativeCommand'){entered.resolve();await mutationGate.promise;}return originalCall(name,args);};
  const session=await openRustSession(actor),controller=new AbortController();let pauses=0,resumes=0;
  session.claimView({async flush(){},pausePresentation(){pauses++;},resumePresentation(){resumes++;}});
  const earlier=session.command('pan',[1]);await entered.promise;
  const pending=session.prepareData({kind:'seeded',count:1},{signal:controller.signal,timeoutMs:mode==='timeout'?20:1000});await waitTurn();assert.equal(pauses,1);
  if(mode==='abort')controller.abort();
  await assert.rejects(bounded(pending),error=>error.name===(mode==='abort'?'AbortError':'TimeoutError'));
  assert.equal(session.activeJob,null);assert.equal(pauses,1);assert.equal(resumes,1);assert.equal(actor.calls.some(([name])=>name==='nativePrepareBegin'),false);
  mutationGate.resolve();await earlier;await waitTurn();assert.equal(actor.calls.some(([name])=>name==='nativePrepareBegin'),false);await session.close();
 }
});

test('migration admission abort and timeout cover nativeSaveWorkspace and ignore its late result',async()=>{
 for(const operation of ['recreate','capture'])for(const mode of ['abort','timeout']){
  const actor=new Actor(),originalCall=actor.call.bind(actor),workspace=deferred(),entered=deferred();let targetCreates=0;
  actor.call=async(name,args=[])=>{if(name==='nativeSaveWorkspace'){actor.calls.push([name]);entered.resolve();return workspace.promise;}return originalCall(name,args);};
  const session=await openRustSession(actor,{createActor:async()=>{targetCreates++;return new Actor();}}),controller=new AbortController(),options={signal:controller.signal,timeoutMs:mode==='timeout'?20:1000};
  const pending=operation==='recreate'?session.recreate(options):session.withMigrationCapture({}, {...options,consume:async()=>({}),activate:async()=>({})});
  await entered.promise;if(mode==='abort')controller.abort();
  await assert.rejects(bounded(pending),error=>error.name===(mode==='abort'?'AbortError':'TimeoutError')&&error.code===(mode==='abort'?'ABORTED':'TIMEOUT'));
  assert.equal(session.activeJob,null);workspace.resolve('{}');await waitTurn();await waitTurn();
  assert.equal(actor.calls.some(([name])=>name==='web.migrationSourceBegin'),false);assert.equal(targetCreates,0);await session.close();
 }
});
