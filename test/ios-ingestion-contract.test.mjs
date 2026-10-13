import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateIOSIngestionEvidence,collectIOSProcessEvidence} from '../scripts/ios-ingestion-contract.mjs';
import {iosEvidence,sealEvidence,sealReplay} from './fixtures/ios-ingestion-evidence.mjs';

test('compact corrected pilot proves its own duration, not a900 run',()=>{
  const v=validateIOSIngestionEvidence(iosEvidence());assert.equal(v.passed,true);assert.equal(v.qualifying900Seconds,false);
});
const mutations=[
  ['empty oracles',e=>e.report.oracle=[]],
  ['missing replay descriptors',e=>delete e.report.appliedTrace],
  ['empty replay payload',e=>e.traces=[]],
  ['one model',e=>e.report.symbols.pop()],
  ['zero compared bytes',e=>e.report.oracle[0].comparedBytes=0],
  ['failed numeric proof',e=>e.report.oracle[0].equal=false],
  ['nonfinite coverage',e=>e.report.oracle[0].bars=Infinity],
  ['replay checksum mismatch',e=>e.traces[0].bytes[17]^=1],
  ['other-run replay metadata',e=>e.report.appliedTrace[0].sha256='0'.repeat(64)],
  ['empty drawing proof',e=>e.report.drawingChecks={}],
  ['failed drawing cancellation',e=>e.report.drawingChecks.accessibleEscapePreservesCommittedDocument=false],
  ['deleted heartbeat history',e=>e.report.probe.rawHeartbeatMs=[1]],
  ['null input endpoint',e=>e.report.probe.rawInput[0]=null],
  ['nonfinite timing',e=>e.report.probe.rawInput[0].returned=NaN],
  ['string input clock',e=>e.report.probe.rawInput[0].entered=String(e.report.probe.rawInput[0].entered)],
  ['string frame clock',e=>e.report.probe.rawFrames[0].start=String(e.report.probe.rawFrames[0].start)],
  ['string drain clock',e=>e.report.feed[0].rawDrains[0].end=String(e.report.feed[0].rawDrains[0].end)],
  ['foreign run UUID',e=>e.report.simulatorID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
  ['foreign bundled core',e=>e.report.buildManifest.coreSHA256='0'.repeat(64)],
  ['different instrumented mode',e=>e.report.instrumented=false],
  ['cleanup has live owned process',e=>e.simulatorCleanup.ownedUUIDProcessCount=1],
  ['missing actual cleanup',e=>delete e.simulatorCleanup],
  ['host ledger loses rows',e=>e.report.feed[0].hostCreated++],
  ['history clock from another run',e=>e.report.feed[0].epochs[1].createdAfterMeasurementSeconds=6000],
  ['missing feed',e=>delete e.report.feed],
  ['empty feeds',e=>e.report.feed=[]],
  ['missing models',e=>delete e.report.symbols],
  ['duplicated model identity',e=>e.report.symbols[1]=e.report.symbols[0]],
  ['missing oracle',e=>delete e.report.oracle],
  ['one oracle',e=>e.report.oracle.pop()],
  ['wrong output count',e=>e.report.oracle[0].outputVectors=0],
  ['wrong raw count',e=>e.report.oracle[0].columns=0],
  ['wrong replay row count',e=>e.report.appliedTrace[0].rows=0],
  ['missing original resource binding',e=>delete e.report.originalUIKitSHA256],
  ['missing nullable ledger cursor',e=>delete e.report.feed[0].session.lastCancelledSequence],
  ['negative pending ring bytes',e=>e.report.feed[0].session.pendingBytes=-1],
  ['unaccounted queued data',e=>e.report.feed[0].session.pendingEvents=1],
  ['lost failed prefix evidence',e=>e.report.feed[0].epochs[0].before.pendingEvents=0],
  ['missing actual error detail',e=>delete e.report.feed[0].epochs[0].before.lastError.message],
  ['missing explicit stop cursors',e=>delete e.report.feed[0].epochs[3].cancel.firstSequence],
  ['deleted stop scenario',e=>e.report.feed[0].epochs.pop()],
  ['lost owner terminal proof',e=>e.report.cleanup.ownerThread=false],
  ['retained job callbacks',e=>e.report.cleanup.retainedJobsReleased=false],
  ['empty saved anchors',e=>e.report.drawingChecks.saved=JSON.stringify({schema:'aster.drawings',version:1,drawings:[]})],
  ['sparse collapsed interval',e=>e.report.probe.rawHeartbeatMs=[e.report.probe.elapsedSeconds*1000]],
  ['wrong histogram sample coverage',e=>e.report.probe.mainHeartbeatGapMs.samples=0],
  ['wrong finite histogram max',e=>e.report.probe.windowSendEventWallMs.max=1000],
  ['missing sampler',e=>delete e.report.sampler],
  ['other-run sampler endpoints',e=>e.report.sampler.samples[0].sampledAt+=100000],
  ['other-run process endpoints',e=>e.report.measurementEndProcess.sampledAt=1],
  ['missing runtime',e=>delete e.report.runtime],
  ['missing simulator operation',e=>e.simulatorCleanup.cleanup.pop()],
  ['partial raw drain history',e=>e.report.feed[0].rawDrains.pop()],
  ['foreign replay source time',e=>e.traces[0].bytes.writeDoubleLE(1,17)],
  ['duplicate trace slot',e=>e.report.appliedTrace[1].file=e.report.appliedTrace[0].file],
  ['missing source manifest',e=>delete e.report.buildManifest.sources],
  ['short report offered as900',e=>{e.run.pilot=false;e.run.seconds=900;}],
  ['false XCTest success',e=>e.xctest.status=1],
  ['missing pinch contraction evidence',e=>e.xctest.stdout=e.xctest.stdout.replace('SYSTEM_PINCH_PAIR gesture=4 completed','')],
];
for(const [name,mutate] of mutations)test('fail-closed: '+name,()=>{const e=iosEvidence();mutate(e);sealEvidence(e);assert.throws(()=>validateIOSIngestionEvidence(e), error => !error.message.includes('report byte binding'));});
test('unchanged expected report bytes reject a separately modified report',()=>{
  const e=iosEvidence();e.report.observedChanges[0]++;
  assert.throws(()=>validateIOSIngestionEvidence(e),/report byte binding/);
});
test('independent expected app binary rejects foreign evidence',()=>{
  const e=iosEvidence();e.xctest.appBinarySHA256='0'.repeat(64);
  assert.throws(()=>validateIOSIngestionEvidence(e),/resource\/binary binding/);
});
test('foreign bundled source hash rejects without changing expected manifest',()=>{
  const e=iosEvidence();e.report.buildManifest.sources={...e.report.buildManifest.sources,'native/AsterNative.swift':'0'.repeat(64)};sealEvidence(e);
  assert.throws(()=>validateIOSIngestionEvidence(e),/source\/fixture hashes/);
});
test('original UIKit pilot has no fabricated draw samples or900 status',()=>{
  const v=validateIOSIngestionEvidence(iosEvidence({instrumented:false}));
  assert.equal(v.passed,true);assert.equal(v.qualifying900Seconds,false);assert.equal(v.instrumented,false);assert.match(v.clockBoundary,/no draw instrumentation/);
});
test('synthetic complete900 evidence tests gate modes, not actual performance',()=>{
  for(const instrumented of [true,false]){
    const v=validateIOSIngestionEvidence(iosEvidence({pilot:false,instrumented}));
    assert.equal(v.qualifying900Seconds,true);assert.equal(v.instrumented,instrumented);
    assert.equal(v.undoRedoVerified,false);assert.match(v.provenance,/no in-app run nonce/);
  }
});
test('source-light fixture imports without benchmark archives',()=>{
  assert.doesNotThrow(()=>iosEvidence());
});
for(const [name,change] of [
  ['NaN OHLCV',b=>b.writeDoubleLE(NaN,25)],
  ['infinite volume',b=>b.writeDoubleLE(Infinity,57)],
  ['negative volume',b=>b.writeDoubleLE(-1,57)],
  ['wrong OHLC envelope',b=>b.writeDoubleLE(0,33)],
  ['unknown wire kind',b=>{b[16]=7;}],
  ['unknown update timestamp',b=>b.writeDoubleLE(1,17)],
  ['out-of-run producer clock',b=>b.writeDoubleLE(1,8)],
  ['reversed serial',b=>b.writeBigUInt64LE(0n,65)],
  ['unsafe producer serial',b=>b.writeBigUInt64LE(2n**63n,0)],
])test('wire semantics after fresh binary/report hashes: '+name,()=>{
  const e=iosEvidence();change(e.traces[0].bytes);sealReplay(e,0);
  assert.throws(()=>validateIOSIngestionEvidence(e),error=>!error.message.includes('binary hash')&&!error.message.includes('report byte binding'));
});
for(const status of [1,null,undefined,NaN,'0'])test('fresh ps unavailable/status '+String(status)+' publishes no positive verdict',()=>{
  const e=iosEvidence();e.simulatorCleanup.processQueryStatus=status;
  let positive;
  assert.throws(()=>{positive=validateIOSIngestionEvidence(e);});assert.equal(positive,undefined);
});
test('fresh missing ps status is not an observed zero',()=>{
  const e=iosEvidence();delete e.simulatorCleanup.processQueryStatus;
  assert.throws(()=>validateIOSIngestionEvidence(e));
});
test('failed optional ps empty stdout yields unknown process count',()=>{
  const v=collectIOSProcessEvidence({status:1,stdout:'',stderr:'permission denied'},'11111111-2222-3333-4444-555555555555');
  assert.equal(v.processQueryStatus,1);assert.equal(v.ownedUUIDProcessCount,null);assert.equal(v.ownedUUIDProcesses,null);
});
test('successful ps zero is observed, not unavailable',()=>{
  const v=collectIOSProcessEvidence({status:0,stdout:'12 /usr/bin/other',stderr:''},'11111111-2222-3333-4444-555555555555');
  assert.equal(v.processQueryStatus,0);assert.equal(v.ownedUUIDProcessCount,0);assert.deepEqual(v.ownedUUIDProcesses,[]);
  const verdict=validateIOSIngestionEvidence(iosEvidence());assert.equal(verdict.processQueryVerified,true);assert.equal(verdict.newRunCertified,true);
});
test('successful ps still rejects live owned processes',()=>{
  const e=iosEvidence();const id=e.run.id;Object.assign(e.simulatorCleanup,collectIOSProcessEvidence({status:0,stdout:'42 '+id+' /fixture/app',stderr:''},id));
  assert.throws(()=>validateIOSIngestionEvidence(e),/owned-only OS cleanup/);
});
test('explicit archived reevaluation does not invent missing ps success',()=>{
  const e=iosEvidence();delete e.simulatorCleanup.processQueryStatus;e.executionPolicy='legacy-replay';
  const verdict=validateIOSIngestionEvidence(e);assert.equal(verdict.passed,true);assert.equal(verdict.processQueryVerified,false);assert.equal(verdict.newRunCertified,false);
  assert.equal(Object.hasOwn(e.simulatorCleanup,'processQueryStatus'),false);
});
test('archive policy cannot ignore an explicitly failed query',()=>{
  const e=iosEvidence();e.executionPolicy='legacy-replay';e.simulatorCleanup.processQueryStatus=1;
  assert.throws(()=>validateIOSIngestionEvidence(e),/successful process query/);
});
test('report cannot downgrade trusted fresh execution policy',()=>{
  const e=iosEvidence();e.report.executionPolicy='legacy-replay';delete e.simulatorCleanup.processQueryStatus;sealEvidence(e);
  assert.throws(()=>validateIOSIngestionEvidence(e),/successful process query/);
});
test('missing query result cannot be represented as zero',()=>{
  const v=collectIOSProcessEvidence(undefined,'11111111-2222-3333-4444-555555555555');
  assert.equal(v.processQueryStatus,null);assert.equal(v.ownedUUIDProcessCount,null);assert.equal(v.ownedUUIDProcesses,null);
});
test('failed query cleanup is recorded and publication leaves no positive file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'aster-ios-ps-contract-'));
  try{
    const e=iosEvidence();Object.assign(e.simulatorCleanup,collectIOSProcessEvidence({status:null,stdout:'',stderr:'spawn unavailable'},e.run.id));
    await writeFile(join(directory,'simulator-cleanup.json'),JSON.stringify(e.simulatorCleanup));
    await assert.rejects(async()=>{
      const verdict=validateIOSIngestionEvidence({...e,executionPolicy:'fresh'});
      await writeFile(join(directory,'acceptance.json'),JSON.stringify(verdict));
    },/successful process query/);
    await assert.rejects(access(join(directory,'acceptance.json')),error=>error.code==='ENOENT');
    const saved=JSON.parse(await readFile(join(directory,'simulator-cleanup.json'),'utf8'));
    assert.equal(saved.processQueryStatus,null);assert.equal(saved.ownedUUIDProcessCount,null);
    assert.equal(saved.processQueryError,'spawn unavailable');
  }finally{await rm(directory,{recursive:true,force:true});}
});
