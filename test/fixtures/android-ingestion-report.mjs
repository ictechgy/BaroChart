import {createHash} from 'node:crypto';

// Compact synthetic completion-evidence fixture, not a device run or a
// financial numeric oracle. No benchmark archive is needed to run these tests.
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const BASE=1700000000000,INITIAL=100000,FINAL=100512,START=1000000000000;
const fields=['listener','inputColumns','descriptor','worker','preceding','eventJSON'];
const labels=['initial-0','initial-1','direct-history-cancel','direct-history-0-0','direct-history-0-1','direct-history-1-0','direct-history-1-1','reference-seed-0','reference-seed-1'];
function stats(samples){
 const sorted=[...samples].sort((a,b)=>a-b),bin=p=>Math.min(256,Math.floor(sorted[Math.ceil(sorted.length*p)-1]*4)/4);
 return {count:sorted.length,meanMs:sorted.length?sorted.reduce((sum,x)=>sum+x,0)/sorted.length:null,p50LowerBinMs:sorted.length?bin(.5):null,p95LowerBinMs:sorted.length?bin(.95):null,maxMs:sorted.at(-1)??0,quantileMethod:'all samples in0.25ms bins, overflowbin>=256ms; max exact'};
}
function policy(stream){return {streamId:'android-cycle12-'+stream,generation:1,firstSequence:0,maxQueuedEvents:64,maxQueuedBytes:3136,maxBatchEvents:8,maxStoredBars:FINAL,maxStoreBytes:25165824};}
function session(stream,phase='final'){
 const before=phase==='before';return {policy:policy(stream),state:before?'paused':'running',nextSequence:514,accepted:514,applied:513,cancelled:before?0:1,rejectedPackets:1,rejectedEvents:0,failedDrains:1,peakPendingEvents:64,peakPendingBytes:3136,lastAppliedSequence:512,lastCancelledSequence:before?null:513,pendingEvents:before?1:0,pendingBytes:before?49:0,ownedBytes:3136,lastError:before?{code:'DRAIN_FAILED',message:'Data batch bar budget limit'}:null,storedBars:FINAL,storeBytes:12582912};
}
function trace(stream,duration){
 const every=duration===30000?1:10,events=[];
 for(let i=0;i<=512;i++)events.push({serial:i*every,clock:START/1e9+i/512*duration/1000*.9,kind:i?1:2,index:INITIAL-1+i});
 for(let stage=0;stage<2;stage++)events.push({serial:-1-stage,clock:START/1e9+duration/1000*(stage+1)/3,kind:3,index:stage?INITIAL/2:0});
 events.sort((a,b)=>a.clock-b.clock);const bytes=Buffer.alloc(events.length*65);
 events.forEach((event,i)=>{let at=i*65;bytes.writeBigInt64LE(BigInt(event.serial),at);bytes.writeDoubleLE(event.clock,at+8);bytes[at+16]=event.kind;
  const close=320+stream*.25+event.index*.000001,bar=[BASE+event.index*60000,close,close+.1,close-.1,close,1];bar.forEach((value,k)=>bytes.writeDoubleLE(value,at+17+k*8));});
 return bytes;
}
export function pressureFixture(duration=900000,{legacy=false}={}){
 const every=duration===30000?1:10,traces=[0,1].map(stream=>({stream,bytes:trace(stream,duration)}));
 const sourceRoles=duration===60000?{activity:'ScenePressureActivity.java',feed:'ScenePressureFeed.java',probe:'ScenePressureProbe.java'}:{activity:'IngestionActivity.java',feed:'IngestionFeed.java',probe:'IngestionProbe.java'};
 const builds={version:'0.2.12',sourceRoles,apkSHA256:hash('apk'),coreSHA256:hash('core'),jniSHA256:hash('jni'),jniCSourceSHA256:hash('jni source'),hashes:Object.fromEntries(['AsterEngine.java','AsterChartView.java','AsterColumns.java',...Object.values(sourceRoles)].map(name=>[name,hash(name)])),buildExit:0,warningsAsErrors:true,productionViewModifiedForFixture:false};
 const jobs=labels.map(label=>({label,result:{status:label==='direct-history-cancel'?'cancelled':'success',metrics:{kind:label.startsWith('initial')||label.startsWith('reference')?'seeded':'correction',elapsedMs:1}}}));
 const checks=[];for(let stream=0;stream<2;stream++)for(const label of ['Initial seeded worker','Paused diagnostic packet explicitly rejects without advancing cursor','Budget failure keeps full history and entire prefix','Budget prefix explicit cancel','Save explicit empty cancellation','Save/load preserves exact empty policy/cursors/counters','Stop explicit pending cancel','Final core conserved','Final bounded host conserved','Finite append budget reached','No prefix reset or eviction','Independent scalar replay initial seed','All22 full raw Float64 vectors scalar parity'])checks.push(label+stream);
 checks.push('Direct history cancelled exactly once and ingestion conserved','All measured inputs retain committed drawing anchors/history','Independent small study literals12','No data event adds drawing undo entry','Original drawing redo survives all feeds','Both producer executor threads ended','Attached closed View owns zero bitmap bytes','Only empty ledger witness remains after all workers/references/source close','No observer callback errors','No observer callback errors');
 for(const label of labels)checks.push(label+' owner terminal');for(const _label of labels)for(const field of fields)checks.push('Retained terminal job releases'+field);
 const epochs=[{kind:'explicit-pause',elapsedMs:1000,diagnosticRejectedPacketsPerStream:1},{kind:'explicit-resume',elapsedMs:1250}];
 for(let stream=0;stream<2;stream++)epochs.push({kind:'failed-prefix-observed',stream,stats:session(stream,'before')},{kind:'store-budget-cancel-resume',stream,before:session(stream,'before'),cancel:{events:1,firstSequence:513,lastSequence:513},after:session(stream,'after')});
 epochs.push({kind:'direct-async-cancel',elapsedMs:duration/3});
 for(let stage=0;stage<2;stage++){
  for(let stream=0;stream<2;stream++)epochs.push({kind:'history-pre-attempt-vector-proof',stream,index:stage?INITIAL/2:0,fullVectors:22,sha256:hash(`before${stage}/${stream}`),ownerCpuMs:1},{kind:'direct-async-history',stream,index:stage?INITIAL/2:0,asyncStatus:'success',elapsedMs:duration*(stage+1)/3+1});
  epochs.push({kind:'direct-history-producer-hold-ended',stage,holdMs:2});
 }
 epochs.push({kind:'save-load-empty-session',elapsedMs:duration/2});
 for(const {stream,bytes} of traces)epochs.push({kind:'replay-trace',stream,file:`applied-${stream}.bin`,rows:bytes.length/65,bytes:bytes.length,recordBytes:65,format:'LE Int64serial,Float64createdMonotonicSeconds,Uint8kind append1/update2/correction3,Float64time/open/high/low/close/volume',sha256:hash(bytes),performedAfterMeasurement:true});
 const inputs=[0,1,0,1].map((action,i)=>{const offset=i<2?100:duration-200;return {ordinal:i+1,action,source:4098,tool:1,deviceEventUptimeMs:START/1e6+offset-10,captureUptimeMs:START/1e6+offset+(i%2)*10,captureNanos:START+(offset+(i%2)*10)*1e6,x:270,y:474,dispatchCpuMs:.5,submitNanos:START+(offset+50)*1e6,captureToCpuSubmitMs:50-(i%2)*10,inputToCaptureMs:10+(i%2)*10,inputToCpuSubmitEstimateMs:60,deviceClockQuantumMs:1,renderedRevision:10+i,sceneJNI:6,envelopeParse:2,bodyParse:10,canvas:3,accessibility:.1,bitmapCopy:.01,baseChanged:true};});
 const jni={processLiveNativeHandles:2,processNativeHandlesCreated:8,processNativeHandlesFreed:6,requestedLiveBytes:1000,requestedPeakBytes:2000};
 const memory=Array.from({length:Math.ceil(duration/10000)+1},(_,i)=>({kind:i===0?'start':i===Math.ceil(duration/10000)?'end-before-validation':'10s',elapsedMs:i===Math.ceil(duration/10000)?duration+1:i*10000,rssKiB:10000,pssKiB:9000,jni:[{...jni},{...jni}],retainedTerminalJobs:i?7:2}));
 const probe={inputCount:4,drawCount:4,rawInputRows:inputs,inputSampleDrops:0,unmatchedInputRowsAtEnd:0,inputAge:stats([10,20,10,20]),inputToCpuSubmitEstimate:stats([60,60,60,60]),heartbeatForeground:stats(Array(10).fill(duration/10)),onDraw:stats([22,22,22,22]),sceneJNI:stats([6,6,6,6]),envelopeParse:stats([2,2,2,2]),bodyParse:stats([10,10,10,10]),canvas:stats([3,3,3,3]),accessibility:stats([.1,.1,.1,.1]),bitmapCopy:stats([.01,.01,.01,.01]),enqueueOwner:stats([1]),drainOwner:stats([1]),directHistorySyncFallback:stats([]),windowFrameMetricsTotal:stats([23,23,23,23]),windowFrameMetricsDroppedReports:0,memory,lifecycle:[{kind:'resume',uptimeMs:START/1e6-1}]};
 const report={schema:'aster.cycle12.android-ingestion',durationRequestedMs:duration,durationObservedMs:duration+1,producerRateHzPerStream:100,hostRingEventsPerStream:64,coreRingEventsPerStream:64,maxAdmissionAndDrain:8,nearStoreLimitDrainEvents:1,seed:42,streams:[0,1].map(stream=>({stream,host:{scheduledTicks:duration/10+1,ticksDuringExplicitProducerHold:duration/10+1-(512*every+2),produced:512*every+2,accepted:514,rejectedBeforeAdmission:512*every+2-514,explicitlyCancelled:0,pending:0,conserved:true,capacity:64,highwater:64,appendEveryProducedEvents:every},ingestion:session(stream),successfulReplayEvents:515,queuedAppliedDuringInputPending:1,directOldCorrections:2,budgetFailures:1,fullHistoryRows:FINAL,successfulDrainSizeHistogram:[0,513,0,0,0,0,0,0,0]})),jobs,epochs,oracles:[0,1].map(stream=>({stream,fullRawColumns:6,fullVectors:22,rows:FINAL,comparedBytes:FINAL*28*8,vectorSHA256:hash('vectors'+duration+'/'+stream),reference:'Fresh independent public scalar replay and complete Float64 byte comparison',performedAfterMeasurement:true,...(legacy?{}:{bytesEqual:true,maxAbsoluteError:0,maxRelativeError:0})})),probe,notifications:10,fixtureOwnedPrimitiveOracleBytes:2*6*FINAL*8,fixtureOwnedTraceCapacityBytes:2*(duration/10+1024)*65,physicalDevice:false,historyNeverResetOrEvicted:true,runtimeBeforeWitnessClose:{processLiveNativeHandles:1,processNativeHandlesCreated:13,processNativeHandlesFreed:12},checks,checkCount:checks.length,passed:true,cleanup:{producersTerminated:true,sourceEnginesClosed:true,drawProbeRemoved:true,frameMetricsListenerRemoved:true,handlersCancelled:true,retainedJobCount:jobs.length}};
 const runner={mode:'pressure',duration,build:structuredClone(builds),avd:'aster-validation',serial:'emulator-5580',privateADBPort:'5038',systemInputCommands:[0,1].map(i=>({ordinal:i,command:['input','touchscreen','tap','270','474'],hostStartedUnixMs:1800000000000+i*(duration-300),hostFinishedUnixMs:1800000000010+i*(duration-300),exit:0})),physicalDevice:false,comparativePerformance:false};
 if(!legacy){report.reportVersion=2;report.runId='12345678-1234-4234-8234-123456789abc';report.buildIdentity={coreSHA256:builds.coreSHA256,jniSHA256:builds.jniSHA256,sourceHashes:structuredClone(builds.hashes),sourceRoles:structuredClone(builds.sourceRoles)};report.measurementWindow={startNanos:START,endNanos:START+(duration+1)*1e6};runner.runId=report.runId;runner.completionValidation={passed:false,qualifying:false,pending:true};}
 const context={runnerManifest:runner,expectedBuild:builds,traces,expectedRunId:report.runId};refreshReportBytes(report,context);return {report,context,duration};
}
export function refreshReportBytes(report,context){
 context.rawReportBytes=Buffer.from(JSON.stringify(report));context.rawSHA256=hash(context.rawReportBytes);
 context.runnerManifest.pressureEvidence={rawSHA256:context.rawSHA256,traceSHA256:context.traces.map(({stream,bytes})=>({stream,sha256:hash(bytes)}))};
}
