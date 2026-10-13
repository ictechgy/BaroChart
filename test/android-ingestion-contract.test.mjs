import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validatePressureReport} from '../scripts/android-ingestion-contract.mjs';
import * as pressureContract from '../scripts/android-ingestion-contract.mjs';
import {pressureFixture,refreshReportBytes} from './fixtures/android-ingestion-report.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validate=f=>validatePressureReport(f.report,f.duration,f.context);
function rejects(mutate,pattern,refresh=true){const f=pressureFixture();mutate(f.report,f.context);if(refresh)refreshReportBytes(f.report,f.context);assert.throws(()=>validate(f),pattern);}

test('complete synthetic 900s evidence accepts without benchmark archive files',()=>{const f=pressureFixture();assert.equal(validate(f),f.report);});
test('pilot evidence uses its own selected duration and append cadence',()=>{const f=pressureFixture(30000);assert.equal(validate(f),f.report);});
test('modern 60s diagnostics retain all full evidence gates and cadence10',()=>{const f=pressureFixture(60000);assert.equal(validate(f),f.report);assert.equal(f.report.streams[0].host.appendEveryProducedEvents,10);for(const mutate of [r=>{r.oracles[0].fullVectors=0;},r=>{r.jobs=[];},r=>{r.cleanup.sourceEnginesClosed=false;}]){const next=pressureFixture(60000);mutate(next.report);refreshReportBytes(next.report,next.context);assert.throws(()=>validate(next));}});
test('60s diagnostics do not fabricate legacy duration or unsupported frozen source roles',()=>{
 const legacy=pressureFixture(60000,{legacy:true});assert.throws(()=>validate(legacy));
 const f=pressureFixture(60000),roles={activity:'IngestionActivity.java',feed:'IngestionFeed.java',probe:'IngestionProbe.java'};
 for(const build of [f.context.expectedBuild,f.context.runnerManifest.build]){for(const role of Object.keys(roles)){build.hashes[roles[role]]=build.hashes[build.sourceRoles[role]];delete build.hashes[build.sourceRoles[role]];}build.sourceRoles={...roles};}
 f.report.buildIdentity.sourceHashes=structuredClone(f.context.expectedBuild.hashes);f.report.buildIdentity.sourceRoles={...roles};refreshReportBytes(f.report,f.context);assert.throws(()=>validate(f));
});
test('legacy evidence binds available provenance without inventing a run UUID or numeric error measurement',()=>{const f=pressureFixture(900000,{legacy:true});assert.equal(validate(f),f.report);});
function staleHistory(f){
 const job=f.report.jobs.find(j=>j.label==='direct-history-0-0');job.result.status='stale';job.result.error='java.lang.IllegalStateException: Error: Async stale: active gesture';
 const route=f.report.epochs.find(e=>e.kind==='direct-async-history'&&e.stream===0&&e.index===0),pre=f.report.epochs.find(e=>e.kind==='history-pre-attempt-vector-proof'&&e.stream===0&&e.index===0);
 route.kind='direct-sync-history-after-explicit-stale';route.asyncStatus='stale';f.report.epochs.splice(f.report.epochs.indexOf(route),0,{kind:'stale-full-source-preserved',stream:0,index:0,columns:6,vectors:22,beforeSHA256:pre.sha256,afterSHA256:pre.sha256,ownerCpuMs:1});
 f.report.checks.push('Actual input stale history leaves ingestion unchanged0/0','Stale preserves all6columns and22vectors before fallback0/0');f.report.checkCount=f.report.checks.length;
 f.report.probe.directHistorySyncFallback={count:1,meanMs:1,p50LowerBinMs:1,p95LowerBinMs:1,maxMs:1};refreshReportBytes(f.report,f.context);return f;
}
test('explicit input stale terminal accepts only its full-source preservation and applied fallback route',()=>{const f=staleHistory(pressureFixture(30000));assert.equal(validate(f),f.report);});
test('stale fallback rejects missing source proof, changed vectors, unknown error and unaccounted timing',()=>{
 for(const mutate of [r=>{r.epochs=r.epochs.filter(e=>e.kind!=='stale-full-source-preserved');},r=>{r.epochs.find(e=>e.kind==='stale-full-source-preserved').afterSHA256='f'.repeat(64);},r=>{r.jobs.find(j=>j.label==='direct-history-0-0').result.error='unrelated failure saying stale';},r=>{r.probe.directHistorySyncFallback.count=0;}]){
  const f=staleHistory(pressureFixture(30000));mutate(f.report);refreshReportBytes(f.report,f.context);assert.throws(()=>validate(f));
 }
});
test('a sampled sequential history worker is accounted and idle endpoints retain exactly two source models',()=>{
 const f=pressureFixture();for(const ledger of f.report.probe.memory[1].jni){ledger.processLiveNativeHandles=3;ledger.processNativeHandlesCreated++;}refreshReportBytes(f.report,f.context);assert.equal(validate(f),f.report);
 for(const mutate of [r=>{r.probe.memory[1].jni[0].processNativeHandlesFreed--;},r=>{r.probe.memory.at(-1).jni[0].processLiveNativeHandles=3;},r=>{r.probe.memory[1].jni[0].processLiveNativeHandles=4;r.probe.memory[1].jni[0].processNativeHandlesCreated+=2;}])rejects(mutate);
});
for(const key of ['requestedLiveBytes','requestedPeakBytes'])test(`native allocator timeline requires positive safe integer ${key}`,()=>{
 for(const stream of [0,1])for(const sample of [0,1,-1])for(const value of [undefined,null,0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1000',{}])
  rejects(r=>{r.probe.memory.at(sample).jni[stream][key]=value;},new RegExp(key));
});
test('native allocator live bytes cannot exceed the same sample peak',()=>{
 for(const stream of [0,1])for(const sample of [0,1,-1])rejects(r=>{const ledger=r.probe.memory.at(sample).jni[stream];ledger.requestedLiveBytes=ledger.requestedPeakBytes+1;},/allocator.*peak/i);
});
test('native allocator peaks can reset when async publication replaces an engine runtime',()=>{
 const f=pressureFixture();
 for(const ledger of f.report.probe.memory[1].jni){ledger.requestedLiveBytes=500;ledger.requestedPeakBytes=500;}
 refreshReportBytes(f.report,f.context);assert.equal(validate(f),f.report);
});
test('diagnostic check count can change while all required semantic evidence remains complete',()=>{const f=pressureFixture();f.report.checks.push('extra diagnostic');f.report.checkCount++;refreshReportBytes(f.report,f.context);assert.equal(validate(f),f.report);});
test('accounted stop-boundary unmatched inputs remain separate from dropped samples',()=>{
 const f=pressureFixture();f.report.probe.inputCount++;f.report.probe.unmatchedInputRowsAtEnd=1;
 f.context.runnerManifest.systemInputCommands.push({ordinal:2,command:['input','touchscreen','tap','270','474'],hostStartedUnixMs:1800000000000+f.duration-1,hostFinishedUnixMs:1800000000000+f.duration+10,exit:0});
 refreshReportBytes(f.report,f.context);assert.equal(validate(f),f.report);
});
test('completion cannot be certified without external artifact bindings',()=>{const f=pressureFixture();assert.throws(()=>validatePressureReport(f.report,f.duration),/evidence|context|binding/i);});
for(const key of ['schema','streams','oracles','jobs','epochs','checks','cleanup','probe','runtimeBeforeWitnessClose','historyNeverResetOrEvicted'])test(`missing ${key} rejects after refreshing synthetic raw authority`,()=>{rejects(r=>{delete r[key];});});
for(const key of ['streams','oracles','jobs','epochs','checks'])test(`empty ${key} rejects after refreshing synthetic raw authority`,()=>{rejects(r=>{r[key]=[];});});
for(const key of ['streams','oracles'])test(`${key} requires exactly two unique model/stream identities`,()=>{
 for(const mutate of [r=>r[key].pop(),r=>r[key].push(structuredClone(r[key][0])),r=>{r[key][1].stream=0;},r=>{r[key][1].stream=2;}])rejects(mutate);
});
for(const key of ['fullRawColumns','fullVectors','rows','comparedBytes'])test(`oracle ${key} rejects missing/zero/null/nonfinite/wrong coverage`,()=>{
 for(const value of [undefined,0,null,NaN,Infinity,-1,1.5,'6'])rejects(r=>{r.oracles[0][key]=value;},new RegExp(key));
});
for(const key of ['maxAbsoluteError','maxRelativeError'])test(`byte-equal oracle ${key} requires finite exact zero`,()=>{
 for(const value of [undefined,null,NaN,Infinity,-Infinity,-1,1e-12,1,'0'])rejects(r=>{r.oracles[0][key]=value;},new RegExp(key));
});
test('failed byte equality and duplicate opaque vector digests reject',()=>{
 rejects(r=>{r.oracles[0].bytesEqual=false;});rejects(r=>{r.oracles[1].vectorSHA256=r.oracles[0].vectorSHA256;});
});
for(const [name,mutate] of [
 ['unconserved core ledger',r=>{r.streams[0].ingestion.accepted++;}],
 ['unconserved host ledger',r=>{r.streams[0].host.produced++;}],
 ['wrong stream policy',r=>{r.streams[1].ingestion.policy.streamId=r.streams[0].ingestion.policy.streamId;}],
 ['pending terminal payload',r=>{r.streams[0].ingestion.pendingEvents=1;}],
 ['unbounded owned ring',r=>{r.streams[0].ingestion.ownedBytes=1e10;}],
 ['zero input-active processing',r=>{r.streams[0].queuedAppliedDuringInputPending=0;}],
 ['missing direct correction',r=>{r.streams[0].directOldCorrections=1;}],
 ['missing store-budget failure',r=>{r.streams[0].budgetFailures=0;}],
 ['reset full history',r=>{r.streams[0].fullHistoryRows=100000;}],
 ['failed drawing evidence',r=>{r.checks=r.checks.filter(s=>s!=='All measured inputs retain committed drawing anchors/history');r.checkCount=r.checks.length;}],
 ['failed undo/redo evidence',r=>{r.checks=r.checks.filter(s=>s!=='Original drawing redo survives all feeds');r.checkCount=r.checks.length;}],
 ['retained callback reference',r=>{r.checks.splice(r.checks.indexOf('Retained terminal job releaseslistener'),1);r.checkCount=r.checks.length;}],
 ['duplicate terminal',r=>{r.jobs.push(structuredClone(r.jobs[0]));}],
 ['wrong terminal status',r=>{r.jobs[0].result.status='cancelled';}],
 ['reordered sequential terminal',r=>{[r.jobs[3],r.jobs[4]]=[r.jobs[4],r.jobs[3]];}],
 ['unreported terminal error',r=>{r.jobs[0].result.error='worker failure';}],
 ['missing owner terminal evidence',r=>{r.checks=r.checks.filter(s=>s!=='initial-0 owner terminal');r.checkCount=r.checks.length;}],
 ['producer cleanup failure',r=>{r.cleanup.producersTerminated=false;}],
 ['missing source cleanup',r=>{delete r.cleanup.sourceEnginesClosed;}],
 ['wrong retained-job ledger',r=>{r.cleanup.retainedJobCount=0;}],
 ['wrong native witness ledger',r=>{r.runtimeBeforeWitnessClose.processLiveNativeHandles=2;}],
 ['missing pause route',r=>{r.epochs=r.epochs.filter(e=>e.kind!=='explicit-pause');}],
 ['missing restore route',r=>{r.epochs=r.epochs.filter(e=>e.kind!=='save-load-empty-session');}],
 ['missing cancelled history route',r=>{r.epochs=r.epochs.filter(e=>e.kind!=='direct-async-cancel');}],
 ['missing history route',r=>{r.epochs=r.epochs.filter(e=>!(e.kind==='direct-async-history'&&e.stream===0&&e.index===0));}],
 ['missing history pre-proof',r=>{r.epochs=r.epochs.filter(e=>!(e.kind==='history-pre-attempt-vector-proof'&&e.stream===1&&e.index===50000));}],
 ['missing replay trace',r=>{r.epochs=r.epochs.filter(e=>!(e.kind==='replay-trace'&&e.stream===1));}],
 ['wrong replay row count',r=>{r.epochs.find(e=>e.kind==='replay-trace').rows++;}],
 ['empty memory timeline',r=>{r.probe.memory=[];}],
 ['missing final memory scope',r=>{r.probe.memory.pop();}],
 ['removed intermediate memory samples',r=>{r.probe.memory=[r.probe.memory[0],r.probe.memory.at(-1)];}],
 ['foreign lifecycle pause',r=>{r.probe.lifecycle.push({kind:'pause',uptimeMs:1000010});}]
])test(`${name} rejects independently of raw hash changes`,()=>rejects(mutate));

test('null matched input rows reject even when sample accounting remains exact',()=>rejects(r=>{r.probe.rawInputRows=r.probe.rawInputRows.map(()=>null);}));
for(const key of ['action','source','tool','deviceEventUptimeMs','captureUptimeMs','captureNanos','submitNanos','captureToCpuSubmitMs','inputToCaptureMs','inputToCpuSubmitEstimateMs','dispatchCpuMs','sceneJNI','envelopeParse','bodyParse','canvas','accessibility','bitmapCopy','x','y','renderedRevision','deviceClockQuantumMs'])test(`input ${key} rejects missing/null/NaN/Infinity rows`,()=>{
 for(const value of [undefined,null,NaN,Infinity])rejects(r=>{r.probe.rawInputRows[0][key]=value;},new RegExp(key));
});
test('input clock reversal, invented latency, duplicate ordinals and dropped samples reject',()=>{
 rejects(r=>{r.probe.rawInputRows[1].captureNanos=r.probe.rawInputRows[0].captureNanos-1;});
 rejects(r=>{r.probe.rawInputRows[0].inputToCpuSubmitEstimateMs++;});
 rejects(r=>{r.probe.rawInputRows[1].ordinal=1;});rejects(r=>{r.probe.inputSampleDrops=1;});
});
test('histogram endpoint counts and derived means cannot be substituted',()=>{rejects(r=>{r.probe.inputAge.count=0;});rejects(r=>{r.probe.inputToCpuSubmitEstimate.meanMs=1;});});
test('requested/observed run duration is finite and matches the selected run',()=>{
 for(const key of ['durationRequestedMs','durationObservedMs'])for(const value of [undefined,null,'900000',NaN,Infinity,0])rejects(r=>{r[key]=value;});
 rejects(r=>{r.durationObservedMs=30000;});rejects(r=>{r.durationRequestedMs=30000;});
});

test('source/build/run identity is cross-bound to the selected fixture',()=>{
 rejects(r=>{r.runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';});
 rejects(r=>{r.buildIdentity.coreSHA256='a'.repeat(64);});
 rejects(r=>{r.buildIdentity.sourceHashes['IngestionFeed.java']='b'.repeat(64);});
 rejects((r,c)=>{c.runnerManifest.build.hashes['IngestionFeed.java']='c'.repeat(64);});
 rejects((r,c)=>{c.runnerManifest.duration=30000;});
 rejects(r=>{delete r.measurementWindow;});rejects(r=>{r.measurementWindow.endNanos++;});
 rejects(r=>{delete r.buildIdentity;});rejects((r,c)=>{delete c.expectedRunId;});rejects((r,c)=>{delete c.runnerManifest.pressureEvidence;},undefined,false);
 rejects(r=>{r.buildIdentity.sourceRoles.feed=r.buildIdentity.sourceRoles.activity;});
});
test('modern renamed fixture binds distinct source roles to the selected build',()=>{
 const f=pressureFixture(),roles={activity:'ScenePressureActivity.java',feed:'ScenePressureFeed.java',probe:'ScenePressureProbe.java'};
 for(const build of [f.context.expectedBuild,f.context.runnerManifest.build]){for(const role of Object.keys(roles)){build.hashes[roles[role]]=build.hashes[build.sourceRoles[role]];delete build.hashes[build.sourceRoles[role]];}build.sourceRoles={...roles};}
 f.report.buildIdentity.sourceHashes=structuredClone(f.context.expectedBuild.hashes);f.report.buildIdentity.sourceRoles={...roles};refreshReportBytes(f.report,f.context);assert.equal(validate(f),f.report);
});
test('another run input or oracle evidence is not a completed run substitute',()=>{
 const other=pressureFixture(30000);
 rejects(r=>{r.probe.rawInputRows=structuredClone(other.report.probe.rawInputRows);});
 rejects(r=>{r.oracles[0]=structuredClone(other.report.oracles[0]);},undefined,false);
});
test('raw report authority and final runner evidence cannot silently accept a different serialized file',()=>{
 rejects((r,c)=>{c.rawReportBytes=Buffer.from('{}');},undefined,false);
 rejects((r,c)=>{c.runnerManifest.pressureEvidence.rawSHA256='a'.repeat(64);},undefined,false);
});
test('actual replay bytes must match their declared SHA, finite envelope and ordered time/serial',()=>{
 rejects((r,c)=>{c.traces[0].bytes[0]^=1;},undefined,false);
 for(const edit of [b=>b.writeDoubleLE(NaN,17),b=>b.writeDoubleLE(-1,57),b=>b.writeBigInt64LE(-9n,0),b=>{b[16]=9;}]){
  const f=pressureFixture();edit(f.context.traces[0].bytes);f.report.epochs.find(e=>e.kind==='replay-trace'&&e.stream===0).sha256=hash(f.context.traces[0].bytes);refreshReportBytes(f.report,f.context);assert.throws(()=>validate(f));
 }
});
test('missing trace file or swapped source stream bytes rejects despite valid report counters',()=>{
 rejects((r,c)=>{c.traces.pop();});rejects((r,c)=>{c.traces[0].bytes=c.traces[1].bytes;});
});
test('archive authority keeps original raw/component/replay byte identities',()=>{
 const archive=f=>({coreSHA256:f.context.expectedBuild.coreSHA256,JNIsha256:f.context.expectedBuild.jniSHA256,APKsha256:f.context.expectedBuild.apkSHA256,files:Object.fromEntries([['pressure-raw.json',{bytes:f.context.rawReportBytes.length,sha256:f.context.rawSHA256}],...f.context.traces.map(t=>[`applied-${t.stream}.bin`,{bytes:t.bytes.length,sha256:hash(t.bytes)}])])});
 const f=pressureFixture();f.context.archiveManifest=archive(f);assert.equal(validate(f),f.report);
 for(const mutate of [a=>{a.files['pressure-raw.json'].sha256='a'.repeat(64);},a=>{a.files['applied-0.bin'].bytes++;},a=>{a.APKsha256='b'.repeat(64);}]){const next=pressureFixture();next.context.archiveManifest=archive(next);mutate(next.context.archiveManifest);assert.throws(()=>validate(next));}
});
test('known semantic coverage cannot use wrong reference/trace/job/cleanup field types',()=>{
 for(const mutate of [r=>{delete r.oracles[0].reference;},r=>{r.epochs.find(e=>e.kind==='replay-trace').format='another transport';},r=>{r.jobs[0].result.metrics.kind='correction';},r=>{r.runtimeBeforeWitnessClose.processNativeHandlesCreated='13';},r=>{r.probe.rawInputRows[0].baseChanged=null;}])rejects(mutate);
});

function completionHarness({validate,steps,persist}={}){
 const f=pressureFixture(),events=[],writes=[];const options={runnerManifest:f.context.runnerManifest,
  validate:async()=>{events.push('validate');if(validate)await validate();else validatePressureReport(f.report,f.duration,f.context);},
  cleanupSteps:steps??[{name:'force-stop',run:async()=>{events.push('force-stop');assert.notEqual(f.context.runnerManifest.completionValidation.passed,true);return {status:0};}}],
  persist:async manifest=>{events.push(manifest.completionValidation.pending?'write-pending':'write-final');writes.push(structuredClone(manifest));if(persist)await persist(manifest);},
  emitPassed:async()=>{events.push('emit-pass');assert.equal(writes.at(-1).hostCleanup.passed,true);assert.equal(writes.at(-1).completionValidation.passed,true);}};
 return {f,events,writes,options,run:()=>pressureContract.finalizePressureCompletion(options)};
}
test('fresh completion success writes and emits positive only after required cleanup status0',async()=>{
 const h=completionHarness();await h.run();assert.deepEqual(h.events,['write-pending','validate','force-stop','write-final','emit-pass']);
 assert.equal(h.writes[0].completionValidation.passed,false);assert.equal(h.writes[0].completionValidation.qualifying,false);assert.equal(h.writes.at(-1).completionValidation.passed,true);assert.equal(h.writes.at(-1).completionValidation.qualifying,true);assert.equal(h.writes.at(-1).hostCleanup.steps[0].status,0);assert.equal(h.writes.at(-1).hostCleanup.steps[0].error,null);
});
for(const [name,cleanup] of [
 ['nonzero',()=>({status:1,stderr:'device offline'})],['unavailable',()=>({status:null})],['missing response',()=>undefined],['wrong status type',()=>({status:'0'})],['execution error with status0',()=>({status:0,error:new Error('transport failure')})],['signal termination',()=>({status:null,signal:'SIGTERM'})],['thrown exception',()=>{throw new Error('cleanup threw');}]
])test('fresh completion '+name+' cleanup retains failed nonqualifying evidence and no positive output',async()=>{
 const h=completionHarness({steps:[{name:'force-stop',run:async()=>cleanup()}]});await assert.rejects(h.run());
 const final=h.writes.at(-1);assert.equal(final.completionValidation.passed,false);assert.equal(final.completionValidation.qualifying,false);assert.equal(final.hostCleanup.passed,false);assert.equal(final.hostCleanup.steps[0].passed,false);assert.equal(h.events.includes('emit-pass'),false);assert.ok(final.hostCleanup.steps[0].error!==null||final.hostCleanup.steps[0].status!==0);assert.ok(final.completionValidation.errors.length>0);
});
test('fresh completion failure still attempts every remaining cleanup and preserves each result',async()=>{
 const calls=[],h=completionHarness({steps:[{name:'force-stop',run:async()=>{calls.push('force-stop');throw new Error('unavailable');}},{name:'remaining',run:async()=>{calls.push('remaining');return {status:0};}}]});
 await assert.rejects(h.run());assert.deepEqual(calls,['force-stop','remaining']);assert.equal(h.writes.at(-1).hostCleanup.steps[1].passed,true);assert.equal(h.writes.at(-1).completionValidation.passed,false);
});
test('fresh completion startup/validation error still cleans and cannot reuse a positive state',async()=>{
 const h=completionHarness({validate:async()=>{throw new Error('startup failed');}});h.f.context.runnerManifest.completionValidation={passed:true,qualifying:true};
 await assert.rejects(h.run(),/startup failed/);assert.deepEqual(h.events,['write-pending','validate','force-stop','write-final']);assert.ok(h.writes.every(m=>m.completionValidation.passed===false));assert.equal(h.writes.at(-1).hostCleanup.passed,true);assert.match(h.writes.at(-1).completionValidation.errors[0],/startup failed/);
});
test('fresh completion missing mandatory force-stop cannot qualify even if another cleanup succeeds',async()=>{
 const h=completionHarness({steps:[{name:'remaining',run:async()=>({status:0})}]});await assert.rejects(h.run(),/force-stop/);assert.equal(h.writes.at(-1).completionValidation.qualifying,false);assert.equal(h.events.includes('emit-pass'),false);
});
test('fresh completion reused certificate/raw output is refused without touching preserved entries',()=>{
 const old=['runner-manifest.json','pressure-raw.json','applied-0.bin'];assert.throws(()=>pressureContract.assertFreshPressureOutput(old),/existing|fresh|preserv/i);assert.deepEqual(old,['runner-manifest.json','pressure-raw.json','applied-0.bin']);
 for(const entries of [['runner-manifest.json'],['pressure-raw.json']])assert.throws(()=>pressureContract.assertFreshPressureOutput(entries),/existing|fresh|preserv/i);
 assert.doesNotThrow(()=>pressureContract.assertFreshPressureOutput([]));assert.doesNotThrow(()=>pressureContract.assertFreshPressureOutput(['preparation-manifest.json']));
});
test('fresh completion write failure cannot emit positive and remaining cleanup still runs',async()=>{
 const h=completionHarness({persist:async()=>{throw new Error('writer unavailable');}});await assert.rejects(h.run(),/writer unavailable/);assert.ok(h.events.includes('force-stop'));assert.equal(h.events.includes('emit-pass'),false);assert.equal(h.f.context.runnerManifest.completionValidation.passed,false);assert.equal(h.f.context.runnerManifest.completionValidation.qualifying,false);
});
test('fresh completion positive-write error is replaced by failed evidence before any pass emission',async()=>{
 let failed=false;const h=completionHarness({persist:async manifest=>{if(manifest.completionValidation.passed&&!failed){failed=true;throw new Error('final writer failed');}}});await assert.rejects(h.run(),/final writer failed/);assert.equal(failed,true);assert.equal(h.writes.at(-1).completionValidation.passed,false);assert.equal(h.writes.at(-1).completionValidation.qualifying,false);assert.equal(h.events.includes('emit-pass'),false);
});
test('fresh completion certificate re-evaluation rejects missing or failed present host cleanup metadata',async()=>{
 const h=completionHarness();await h.run();assert.equal(validate(h.f),h.f.report);
 for(const mutate of [m=>{delete m.hostCleanup;},m=>{m.hostCleanup.steps[0].status=null;},m=>{m.hostCleanup.steps[0].error='query unavailable';},m=>{m.completionValidation.passed=false;},m=>{m.completionValidation.pending=true;},m=>{delete m.completionValidation;}]){
  const saved=structuredClone(h.f.context.runnerManifest);mutate(h.f.context.runnerManifest);assert.throws(()=>validate(h.f),/cleanup|completion|certificate/i);h.f.context.runnerManifest=saved;
 }
});
