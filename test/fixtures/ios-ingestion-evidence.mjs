// Small generated contract evidence, never a measured benchmark or financial
// oracle. All binary payloads are generated here; source ZIP needs no archives.
import {createHash} from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function distribution(values) {
  if (!values.length) return {samples: 0};
  const s = values.toSorted((a, b) => a - b), at = p => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {samples: s.length, p50: at(.5), p95: at(.95), p99: at(.99), max: s.at(-1)};
}
export function iosEvidence({pilot = true, instrumented = true, seconds = pilot ? 30 : 900} = {}) {
  const bars = pilot ? 512 : 100000, warmup = pilot ? 2 : 30, begin = 10000, elapsed = seconds + .02;
  const id = '11111111-2222-3333-4444-555555555555', core = hash('core'), original = hash('original'), hooked = instrumented ? hash('hooked') : original;
  const sources = Object.fromEntries(['native/AsterNative.swift','native/AsterColumns.swift','native/AsterFrameRenderer.swift','/fixture/native/AsterUIKit.swift','examples/ios/cycle12/IngestionApp.swift','examples/ios/cycle12/IngestionFeed.swift','examples/ios/cycle12/IngestionProbe.swift','examples/ios/cycle12/IngestionSystemTests.swift','scripts/build-ios-ingestion.mjs','scripts/test-ios-ingestion.mjs','examples/ios/Info.plist','package.json'].map(name => [name, hash(name)]));
  sources['/fixture/native/AsterUIKit.swift'] = original;
  const bundled = {schema:'aster.cycle12.ios.build', protocol:1, packageVersion:'0.2.12', instrumented, simulatorOnly:true, signingAllowed:false, systemInputAPI:'public XCTest/XCUIAutomation', coreSHA256:core, originalUIKitSHA256:original, hookedUIKitSHA256:hooked, uikitSHA256:hooked, hookPatchSHA256:hash('patch'), sources};
  const manifest = {...bundled, appPath:'/fixture/Cycle12Apple.app', xctestrunPath:'/fixture/owned.xctestrun', appBinarySHA256:hash('app')};
  const run = {id, runtime:'com.apple.CoreSimulator.SimRuntime.iOS-27-0', createdByThisRun:true, pilot, seconds, bars};
  const policy = {streamId:'ios-cycle12', generation:1, firstSequence:0, maxBatchEvents:64, maxQueuedEvents:4096, maxQueuedBytes:4096*49, maxStoredBars:bars+32, maxStoreBytes:96*262144};
  const feeds = [], traces = [], descriptors = [];
  const every = pilot ? 10 : 500, fail = every*33, count = Math.ceil((seconds + warmup)*100)+2, interval = pilot ? 6 : 300;
  for (let symbol = 0; symbol < 2; symbol++) {
    let tail = 1700000000000+(bars-1)*60000, correction = 0;
    const rows = [], drains = [], history = [], ages = [];
    for (let serial = 0; serial < count - 1; serial++) {
      ages.push(1);
      if (serial === fail) continue;
      const created = begin-warmup+serial/100+symbol*.000001;
      let kind = serial>0 && serial<fail && serial%every===0 ? 1 : 2, time = tail;
      if (kind === 1) time = tail += 60000;
      if (serial > fail && correction < 2 && created-begin >= (correction+1)*interval) {
        kind=3; const index=correction++===0 ? 0 : Math.floor((bars+32)/2); time=1700000000000+index*60000;
        history.push({kind:'historical-correction', index, historyRows:bars+32, createdAfterMeasurementSeconds:created-begin, appliedAfterMeasurementSeconds:created-begin+.001});
      }
      const row = Buffer.alloc(65); row.writeBigUInt64LE(BigInt(serial),0);row.writeDoubleLE(created,8);row[16]=kind;
      [time,100,101,99,100,10].forEach((v,j)=>row.writeDoubleLE(v,17+j*8));rows.push(row);
      drains.push({start:created+.0005, drainStart:created+.0006, end:created+.001, events:1, firstSequence:serial, lastSequence:serial, revision:serial*2+2, appliedDuringOSInput:true});
    }
    const bytes = Buffer.concat(rows), applied = rows.length;
    const session = {policy, state:'running', nextSequence:count-1, accepted:count-1, applied, cancelled:1, failedDrains:1, rejectedPackets:0, rejectedEvents:0, pendingEvents:0, pendingBytes:0, ownedBytes:4096*49, peakPendingEvents:1, peakPendingBytes:49, lastAppliedSequence:count-2, lastCancelledSequence:fail, lastError:null, storedBars:bars+32, storeBytes:96*(pilot?1024:131072)};
    const before = {...session, accepted:fail+1, applied:fail, cancelled:0, nextSequence:fail+1, lastAppliedSequence:fail-1, lastCancelledSequence:null, pendingEvents:1, pendingBytes:49, state:'paused', lastError:{code:'DRAIN_FAILED',message:'budget'}};
    const after = {...before, cancelled:1,pendingEvents:0,pendingBytes:0,state:'running',lastCancelledSequence:fail,lastError:null};
    feeds.push({schema:'aster.cycle12.ios-feed', rateHz:100, appendEveryMessages:every, historyCorrectionIntervalSeconds:interval, historyNeverResetOrEvicted:true, hostCreated:count, hostAccepted:count-1, hostCancelled:1, hostRejected:0, hostLedgerConserved:true, hostCapacity:4096, hostHighwater:1, maxAdmissionAndDrain:64, maximumRawRowsPerTrace:180000, omittedRawRows:0, appliedEvents:applied, appliedDuringOSInput:applied, budgetFailures:1, failures:[], session, hostQueueAgeMs:ages, rawDrains:drains, epochs:[{kind:'store-budget-explicit-cancel-resume',at:begin-warmup+fail/100+.001,before,after,cancel:{events:1,firstSequence:fail,lastSequence:fail},hostCancelled:0},...history,{kind:'stop-explicit-cancel',before:session,after:session,cancel:{events:0,firstSequence:null,lastSequence:null}}]});
    const file = 'applied-symbol-'+symbol+'.bin';traces.push({file,bytes});
    descriptors.push({file,bytes:bytes.length,rows:applied,recordBytes:65,littleEndian:true,performedAfterMeasurement:true,sha256:hash(bytes),historicalCorrections:2,historicalIndices:[0,Math.floor((bars+32)/2)]});
  }
  const inputs = [1,7,13,seconds-.1].map((t,i)=>({entered:begin+t,returned:begin+t+.001,oldestTouchTimestamp:begin+t-.002,newestTouchTimestamp:begin+t-.001,epoch:i+1,touches:1}));
  const frames = instrumented ? inputs.map(i=>({start:i.returned+.001,end:i.returned+.002,inputEpoch:i.epoch,revision:i.epoch})) : [];
  const heartbeat = Array(Math.floor(elapsed*1000/8)).fill(8);heartbeat.push(elapsed*1000-heartbeat.length*8);
  const probe = {schema:'aster.cycle12.private-draw-probe',boundary:'Public actual UIWindow delivery + test-only same-location draw hook; CPU-section wall time, not GPU',elapsedSeconds:elapsed,inputEvents:inputs.length,frames:frames.length,supersededInputs:0,negativeTouchAgeSamples:0,errors:[],rawInput:inputs,rawFrames:frames,rawHeartbeatMs:heartbeat,gapsOver50Ms:0,osTouchAgeAtDispatchMs:distribution(inputs.map(i=>(i.entered-i.oldestTouchTimestamp)*1000)),windowSendEventWallMs:distribution(inputs.map(i=>(i.returned-i.entered)*1000)),drawCPUSectionWallMs:distribution(frames.map(f=>(f.end-f.start)*1000)),latestInputToCPUSectionCompletionMs:distribution(frames.map((f,i)=>(f.end-inputs[i].entered)*1000)),mainHeartbeatGapMs:distribution(heartbeat)};
  const snapshot = t=>({sampledAt:t,residentBytes:10000000,processCPUSeconds:t/2});
  const samples = Array.from({length:Math.floor(seconds*10)+1},(_,i)=>snapshot(begin+.0001+i/10));
  const cleanup = Object.fromEntries(['engineNil','contextNil','vmNil','runtimeNil','feedNil','viewNil','retainedJobsReleased','ownerThread','afterEventScope'].map(k=>[k,true]));cleanup.retainedCompletedHandles=2;
  const report = {schema:'aster.cycle12.ios-pressure',physicalDevice:false,platformSpeedComparison:false,buildManifest:bundled,initialBarsPerSymbol:bars,symbols:['A visible UIKit chart','B independent offscreen engine'],requestedSeconds:seconds,warmupSeconds:warmup,coreSHA256:core,originalUIKitSHA256:original,instrumented,nativeDrawHookInstrumented:instrumented,simulatorID:id,runtime:run.runtime,pilot,xcodebuildStatus:0,allRawAndOutputsEqual:true,studyGolden:{passed:true,expectedMean:12.4,expectedPopulationVariance:3.84,method:'Literal two-pass'},feed:feeds,appliedTrace:descriptors,oracle:[0,1].map(()=>({equal:true,columns:6,outputVectors:22,bars:bars+32,comparedBytes:(bars+32)*28*8,chunkRows:4096,performedAfterMeasurement:true,reference:'Fresh scalar; allFloat64bits includingNaN/sign checked'})),probe,sampler:{intervalMs:100,samples,sampledPeakResidentBytes:10000000,peakIsSamplingLowerBound:true,boundary:'Whole process'},measureStartProcess:snapshot(begin-.0001),measurementEndProcess:snapshot(begin+elapsed+.05),readyProcess:snapshot(begin-warmup-1),beforeCloseProcess:snapshot(begin+elapsed+1),afterCloseProcess:snapshot(begin+elapsed+1.1),afterDropProcess:snapshot(begin+elapsed+1.2),backgroundAt:begin+elapsed+.5,cleanup,accessibleCancelActions:1,drawingChecks:{accessibleEscapePreservesCommittedDocument:true,pointersAfter:0,inputBoundary:'XCUI draw/edit plus UIControl accessibleEscape',saved:JSON.stringify({schema:'aster.drawings',version:1,drawings:[{id:'drawing-1',type:'trendline',panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},points:[{time:1700000000000,price:100},{time:1700000060000,price:101}]}]})},observedChanges:[100,100]};
  const xctest = {status:0,stdout:'-destination id='+id+'\nSYSTEM_PINCH_PAIR gesture=1 completed\nSYSTEM_PINCH_PAIR gesture=4 completed\nActual public XCUI slow-drag calls:4\n** TEST EXECUTE SUCCEEDED **',appBinarySHA256:manifest.appBinarySHA256,coreSHA256:core};
  const simulatorCleanup = {id,ownedOnly:true,remaining:false,processQueryStatus:0,ownedUUIDProcessCount:0,ownedUUIDProcesses:[],cleanup:[{operation:'terminate',status:3,stderr:'found nothing to terminate'},{operation:'shutdown',status:0,stderr:''},{operation:'delete',status:0,stderr:''}]};
  return sealEvidence({report,manifest,run,xctest,traces,simulatorCleanup});
}
// Field-mutation tests refresh this binding so they exercise structural guards.
export function sealEvidence(evidence) {
  evidence.reportSHA256=hash(JSON.stringify(evidence.report,null,2));
  return evidence;
}
export function sealReplay(evidence, index) {
  evidence.report.appliedTrace[index].sha256=hash(evidence.traces[index].bytes);
  return sealEvidence(evidence);
}
