import test from 'node:test';
import assert from 'node:assert/strict';
import {validateKotlinConsumerReport,selectFinalConsumerReport,readFinalConsumerReport} from '../scripts/kotlin-consumer-contract.mjs';

// Independent required scenario inventory: deliberately not imported from the
// validator, so removing a required production ID cannot weaken these tests.
const baselineIds=['resources','external-columns','font-scale','drawing-history','prepare-owned-input','prepare-sma-full-vector','correction-success','correction-sma-full-vector','cancel-source-and-drawings','view-render-and-cache','background-resume','close-cache-and-rejection','activity-recreate','replacement-native-ledger-and-close'];
const studyIds=['linked-module','sample-vectors','asof-matrix','asof-defaults-and-cloud','save-schema-descriptor-readonly','unsupported-module-version','load-merge-vectors','load-target-preserved','reject-duplicate','reject-panel','reject-module-version','reject-executable-source','reject-url','prepare-owned-vectors','correction-vectors','cancel-source-and-studies','close'];
const vectorIds=['sample signed','sample cumulative','target recomputed signed','target recomputed cumulative','prepared module cumulative','corrected module signed','corrected module cumulative'];
const names=['prepare','correction','cancel'],studyNames=names.map(id=>'module-'+id);
function jobs(ids,progress=1) {return ids.map((id,i)=>({id,status:i===2?'cancelled':'success',terminalCount:1,ownerValid:true,orderValid:true,progressCallbacks:i===1?progress:0}));}
function report(baselinePassed=1083,correctionProgress=1) {
 const baseJobs=jobs(names,correctionProgress),moduleJobs=jobs(studyNames);
 return {failed:false,package:'dev.aster.consumer',sdkVersion:'0.2.11',api:36,activityGenerations:2,terminals:3,studyTerminals:3,
  passed:baselinePassed+693,baselinePassed,studyPassed:693,checks:Array.from({length:baselinePassed},(_,i)=>'baseline assertion '+i),studyChecks:Array.from({length:693},(_,i)=>'study assertion '+i),
  progressCallbacks:correctionProgress,studyProgressCallbacks:1,
  jobs:baseJobs.map((j,i)=>({status:j.status,metrics:{immutableInputBytes:i===0?24576:0}})),studyJobs:moduleJobs.map((j,i)=>({status:j.status,metrics:{immutableInputBytes:i===0?192:0}})),
  lifecycle:['create:1','resume:1','pause:1','stop:1','resume:1','pause:1','stop:1','destroy:1','create:2','resume:2'],nativeHandleLedgerBeforeReplacementClose:{processLiveNativeHandles:1},
  consumerContract:{schema:'aster.kotlin-consumer',version:1,complete:true,
   baseline:{scenarios:[...baselineIds],jobs:baseJobs,oracles:{prepareSma:{length:512,warmup:13,values:499},correctionSma:{length:512,warmup:13,values:499}},closed:{cacheBytes:0,engineClosed:true,commandsRejected:true,replacementClosed:true}},
   study:{scenarios:[...studyIds],jobs:moduleJobs,oracles:{asOfQueries:600,vectors:Object.fromEntries(vectorIds.map(id=>[id,4]))},sourceClosed:true,targetClosed:true}}
 };
}
const validate=value=>validateKotlinConsumerReport(value,{studies:true,expectedVersion:'0.2.11'});

for(const count of [1083,1084])test(`normal completed contracts accept ${count} assertions with variable progress`,()=>{assert.equal(validate(report(count,count-1082)).failed,false);});
test('successful jobs do not require any progress callback',()=>{
 const value=report(1083,0);value.studyProgressCallbacks=0;for(const job of value.consumerContract.study.jobs)job.progressCallbacks=0;assert.equal(validate(value),value);
});
test('normal basic consumer requires its semantic contract without studies',()=>{
 const value=report();delete value.consumerContract.study;delete value.studyChecks;delete value.studyJobs;delete value.studyPassed;delete value.baselinePassed;delete value.studyTerminals;delete value.studyProgressCallbacks;value.passed=value.checks.length;
 assert.equal(validateKotlinConsumerReport(value,{expectedVersion:'0.2.11'}),value);
});
test('a late callback failure replaces an earlier success after the final device report read',()=>{
 const earlier=report(),latest={...report(),failed:true,error:'late callback after terminal'};
 assert.equal(selectFinalConsumerReport(earlier,latest),latest);assert.throws(()=>validate(selectFinalConsumerReport(earlier,latest)));
});
test('an observed callback failure cannot be lost by a later stale success report',()=>{
 const failed={...report(),failed:true,error:'wrong callback owner'};
 assert.equal(selectFinalConsumerReport(failed,report()),failed);assert.throws(()=>validate(selectFinalConsumerReport(failed,report())));
});
for(const [label,read] of [
 ['missing final file',()=>{throw Error('run-as: final file missing');}],
 ['empty final file',()=>''],
 ['interrupted final JSON write',()=>'{"failed":true,"error":'],
 ['null final document',()=>'null'],
 ['array final document',()=>'[]'],
 ['missing final failure state',()=>'{}']
])test(`${label} cannot fall back to an earlier success`,()=>{
 const value=readFinalConsumerReport(report(),read);assert.equal(value.failed,true);assert.match(value.error,/final.*report/i);assert.throws(()=>validate(value));
});
test('unreadable final file retains an already observed callback failure',()=>{
 const failed={...report(),failed:true,error:'wrong callback owner'};assert.equal(readFinalConsumerReport(failed,()=>{throw Error('file missing');}),failed);
});
test('final read accepts a complete report with changed progress telemetry',()=>{
 const latest=report(1084,2);assert.deepEqual(readFinalConsumerReport(report(),()=>JSON.stringify(latest)),latest);assert.equal(validate(readFinalConsumerReport(report(),()=>JSON.stringify(latest))).failed,false);
});
for(const [group,ids] of [['baseline',baselineIds],['study',studyIds]])for(const id of ids)test(`missing mandatory ${group}/${id} rejects despite unchanged assertion counts`,()=>{
 const value=report();value.consumerContract[group].scenarios=value.consumerContract[group].scenarios.filter(item=>item!==id);assert.throws(()=>validate(value));
});
for(const [group,resultKey,ids] of [['baseline','jobs',names],['study','studyJobs',studyNames]])for(const [index,id] of ids.entries())test(`${id} rejects wrong owner, late order, duplicate terminal, status and error independently`,()=>{
 for(const mutate of [r=>{r.consumerContract[group].jobs[index].ownerValid=false;},r=>{r.consumerContract[group].jobs[index].orderValid=false;},r=>{r.consumerContract[group].jobs[index].terminalCount=2;},r=>{r[resultKey][index].status='failure';},r=>{r[resultKey][index].error='wrong terminal error';}]){
  const value=report();mutate(value);assert.throws(()=>validate(value));
 }
});
for(const [label,mutate] of [
 ['wrong progress owner',r=>{r.consumerContract.baseline.jobs[1].ownerValid=false;}],
 ['progress after terminal',r=>{r.consumerContract.study.jobs[1].orderValid=false;}],
 ['duplicate terminal',r=>{r.consumerContract.baseline.jobs[0].terminalCount=2;}],
 ['missing terminal',r=>{r.consumerContract.study.jobs[2].terminalCount=0;}],
 ['wrong success status',r=>{r.jobs[0].status='cancelled';}],
 ['wrong cancellation status',r=>{r.studyJobs[2].status='success';}],
 ['terminal error',r=>{r.jobs[1].error='worker failure';}],
 ['wrong job identity',r=>{r.consumerContract.baseline.jobs[1].id='prepare';}],
 ['wrong job order',r=>{r.consumerContract.study.jobs.reverse();}],
 ['missing full SMA value',r=>{r.consumerContract.baseline.oracles.prepareSma.values=498;}],
 ['missing full study value',r=>{delete r.consumerContract.study.oracles.vectors['corrected module signed'];}],
 ['missing as-of case',r=>{r.consumerContract.study.oracles.asOfQueries=599;}],
 ['missing actual stop',r=>{r.lifecycle=r.lifecycle.filter(id=>id!=='stop:1');}],
 ['destroy after replacement create',r=>{r.lifecycle=['create:1','resume:1','pause:1','stop:1','resume:1','create:2','destroy:1','resume:2'];}],
 ['wrong native ledger',r=>{r.nativeHandleLedgerBeforeReplacementClose.processLiveNativeHandles=2;}],
 ['retained close cache',r=>{r.consumerContract.baseline.closed.cacheBytes=1;}],
 ['closed commands accepted',r=>{r.consumerContract.baseline.closed.commandsRejected=false;}],
 ['study source still open',r=>{r.consumerContract.study.sourceClosed=false;}],
 ['replacement still open',r=>{r.consumerContract.baseline.closed.replacementClosed=false;}],
 ['late callback failure after final report',r=>{r.failed=true;r.error='progress after terminal';}],
 ['wrong API version',r=>{r.sdkVersion='0.2.10';}],
 ['wrong Android API',r=>{r.api=35;}],
 ['contract schema missing',r=>{delete r.consumerContract;}],
 ['contract not complete',r=>{r.consumerContract.complete=false;}],
 ['inconsistent progress telemetry',r=>{r.progressCallbacks++;}]
])test(`${label} rejects even when count is 1083 and required IDs remain`,()=>{const value=report();mutate(value);assert.throws(()=>validate(value));});
