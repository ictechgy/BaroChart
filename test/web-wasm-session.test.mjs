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
