const baselineScenarios=Object.freeze(['resources','external-columns','font-scale','drawing-history','prepare-owned-input','prepare-sma-full-vector','correction-success','correction-sma-full-vector','cancel-source-and-drawings','view-render-and-cache','background-resume','close-cache-and-rejection','activity-recreate','replacement-native-ledger-and-close']);
const studyScenarios=Object.freeze(['linked-module','sample-vectors','asof-matrix','asof-defaults-and-cloud','save-schema-descriptor-readonly','unsupported-module-version','load-merge-vectors','load-target-preserved','reject-duplicate','reject-panel','reject-module-version','reject-executable-source','reject-url','prepare-owned-vectors','correction-vectors','cancel-source-and-studies','close']);
const studyVectors=Object.freeze(['sample signed','sample cumulative','target recomputed signed','target recomputed cumulative','prepared module cumulative','corrected module signed','corrected module cumulative']);
const requireContract=(valid,reason)=>{if(!valid)throw new Error('Kotlin consumer contract incomplete: '+reason);};
const count=value=>Number.isSafeInteger(value)&&value>=0;
function scenarios(actual,required,label){
 requireContract(Array.isArray(actual)&&actual.every(id=>typeof id==='string')&&new Set(actual).size===actual.length,label+' scenario IDs');
 for(const id of required)requireContract(actual.includes(id),label+'/'+id);
}
function assertions(actual,reported,label){
 requireContract(Array.isArray(actual)&&actual.every(reason=>typeof reason==='string'&&reason.length>0)&&count(reported)&&actual.length===reported,label+' assertion telemetry');
}
function jobs(actual,results,ids,total,progress,inputBytes){
 requireContract(Array.isArray(actual)&&actual.length===ids.length&&Array.isArray(results)&&results.length===ids.length,'all named async jobs');
 let callbacks=0;
 for(let i=0;i<ids.length;i++){
  const job=actual[i],result=results[i],status=i===2?'cancelled':'success';
  requireContract(job?.id===ids[i],ids[i]+' job identity/order');
  requireContract(job.terminalCount===1&&job.ownerValid===true&&job.orderValid===true,ids[i]+' exactly one ordered owner terminal');
  requireContract(job.status===status&&result?.status===status&&(result.error===undefined||result.error===null),ids[i]+' terminal status/error');
  requireContract(count(job.progressCallbacks),ids[i]+' progress telemetry');callbacks+=job.progressCallbacks;
 }
 requireContract(total===ids.length&&count(progress)&&callbacks===progress,'terminal/progress ledger');
 requireContract(results[0].metrics?.immutableInputBytes===inputBytes,'owned prepare input metrics');
}
function lifecycle(events){
 requireContract(Array.isArray(events)&&events.every(event=>typeof event==='string'),'Activity lifecycle trace');
 for(const event of ['create:1','destroy:1','create:2'])requireContract(events.filter(value=>value===event).length===1,'one actual '+event);
 let cursor=0;for(const expected of ['create:1','resume:1','pause:1','stop:1','resume:1','destroy:1','create:2','resume:2']){
  const index=events.indexOf(expected,cursor);requireContract(index>=0,'actual ordered lifecycle '+expected);cursor=index+1;
 }
}

// Keep an already observed failure even if a stale success file appears later.
export function selectFinalConsumerReport(previous,latest){return previous?.failed===true?previous:latest??previous;}
export function readFinalConsumerReport(previous,read){
 try{
  const latest=JSON.parse(read());
  if(!latest||typeof latest!=='object'||Array.isArray(latest)||typeof latest.failed!=='boolean')throw new Error('Expected report object with an explicit failure state');
  return selectFinalConsumerReport(previous,latest);
 }catch(error){
  return selectFinalConsumerReport(previous,{...previous,failed:true,error:'Final consumer report unavailable or invalid: '+String(error?.message??error).slice(0,256)});
 }
}

/** Pure report validation. Importing this module performs no build or adb work. */
export function validateKotlinConsumerReport(report,{studies=false,expectedVersion}={}){
 requireContract(report?.failed===false&&(report.error===undefined||report.error===null),'failed/error state');
 requireContract(report.package==='dev.aster.consumer'&&report.api===36,'consumer package/Android API');
 requireContract(typeof report.sdkVersion==='string'&&report.sdkVersion.trim().length>0&&(!expectedVersion||report.sdkVersion===expectedVersion),'SDK version');
 requireContract(report.activityGenerations===2,'two actual Activity generations');lifecycle(report.lifecycle);
 requireContract(report.nativeHandleLedgerBeforeReplacementClose?.processLiveNativeHandles===1,'replacement native handle ledger');
 const contract=report.consumerContract;requireContract(contract?.schema==='aster.kotlin-consumer'&&contract.version===1&&contract.complete===true,'completed report schema/version');
 const baseline=contract.baseline;scenarios(baseline?.scenarios,baselineScenarios,'baseline');
 for(const phase of ['prepareSma','correctionSma']){
  const coverage=baseline.oracles?.[phase];requireContract(coverage?.length===512&&coverage.warmup===13&&coverage.values===499,phase+' complete SMA oracle');
 }
 const closed=baseline.closed;requireContract(closed?.cacheBytes===0&&closed.engineClosed===true&&closed.commandsRejected===true&&closed.replacementClosed===true,'closed engines/cache/command rejection');
 jobs(baseline.jobs,report.jobs,['prepare','correction','cancel'],report.terminals,report.progressCallbacks,24576);
 if(studies){
  assertions(report.checks,report.baselinePassed,'baseline');assertions(report.studyChecks,report.studyPassed,'study');
  requireContract(count(report.passed)&&report.passed===report.baselinePassed+report.studyPassed,'total assertion telemetry');
  const study=contract.study;scenarios(study?.scenarios,studyScenarios,'study');
  requireContract(study.oracles?.asOfQueries===600,'complete module as-of matrix');
  for(const id of studyVectors)requireContract(study.oracles?.vectors?.[id]===4,id+' full module vector');
  requireContract(study.sourceClosed===true&&study.targetClosed===true,'study source/target explicitly closed before report');
  jobs(study.jobs,report.studyJobs,['module-prepare','module-correction','module-cancel'],report.studyTerminals,report.studyProgressCallbacks,192);
 }else assertions(report.checks,report.passed,'baseline');
 return report;
}
