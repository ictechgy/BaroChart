import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {runCalculationJob, runDedicatedCalculationWorker, calculationJobStats} from '../src/web/calculation-job.mjs';

const ENTRY = new URL('../src/web/resample-worker.mjs', import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFile = promisify(spawn);

function deferred() {
 let resolve;
 const promise = new Promise(yes => {resolve = yes;});
 return {promise, resolve};
}

function hangingWorkers() {
 const workers = [];
 return {
  workers,
  factory() {
   const termination = deferred();
   const worker = {
    onmessage: null,
    onerror: null,
    postMessage() {},
    terminate() {return termination.promise;},
   };
   workers.push({worker, termination});
   return worker;
  },
 };
}

async function settlesWithin(promise, label) {
 return Promise.race([promise, pause(250).then(() => {throw new Error(`${label} remained pending`);})]);
}

async function isolatedTerminationFailure(mode) {
 const calculationURL = new URL('../src/web/calculation-job.mjs', import.meta.url).href;
 const entryURL = ENTRY.href;
 const script = `
  import {runCalculationJob,runDedicatedCalculationWorker,calculationJobStats} from ${JSON.stringify(calculationURL)};
  const entry=new URL(${JSON.stringify(entryURL)}),mode=${JSON.stringify(mode)};
  const terminateError=new Error('termination failed'),detachError=new Error('detach failed');
  let worker,messageValue,detachFailed=false;
  const factory=()=>{
   worker={onerror:null,postMessage(){queueMicrotask(()=>worker.onmessage?.({data:{packet:{ok:true}}}));},terminate(){return Promise.reject(terminateError);}};
   Object.defineProperty(worker,'onmessage',{configurable:true,get(){return messageValue;},set(value){if(value===null&&!detachFailed&&mode==='detach'){detachFailed=true;throw detachError;}messageValue=value;}});
   return worker;
  };
  let error;
  try{await runCalculationJob({timeoutMs:1000},async context=>{context.reserve(64);return runDedicatedCalculationWorker({},entry,{workerFactory:factory},context);});}
  catch(failure){error={name:failure.name,message:failure.message};}
  console.log(JSON.stringify({mode,error,stats:calculationJobStats()}));
 `;
 const {stdout}=await execFile(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),timeout:5000,maxBuffer:1024*1024});
 return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function isolatedResampleTerminationFailure() {
 const resampleURL = new URL('../src/web/resample-async.mjs', import.meta.url).href;
 const workerURL = new URL('../src/web/resample-worker.mjs', import.meta.url).href;
 const jobURL = new URL('../src/web/calculation-job.mjs', import.meta.url).href;
 const coreURL = new URL('../src/core/index.mjs', import.meta.url).href;
 const script = `
  import {resampleOHLCVAsync} from ${JSON.stringify(resampleURL)};
  import {computeResampleRequest} from ${JSON.stringify(workerURL)};
  import {SessionCalendar} from ${JSON.stringify(coreURL)};
  import {calculationJobStats} from ${JSON.stringify(jobURL)};
  const time=Date.parse('2026-04-01T09:00:00Z'),fields=['time','open','high','low','close','volume'],columns=Object.fromEntries(fields.map(field=>[field,Float64Array.from([field==='time'?time:1])]));
  let worker;
  const factory=()=>worker={onmessage:null,onerror:null,postMessage(request){queueMicrotask(()=>worker.onmessage?.({data:computeResampleRequest(request)}));},terminate(){return Promise.reject(new Error('resample termination failed'));}};
  const options={sourceIntervalMs:1,targetIntervalMs:1,kinds:['regular'],asOf:time+10,partialTarget:'include-unconfirmed',calendar:new SessionCalendar('UTC',()=>[{open:'09:00',close:'10:00'}]),workerFactory:factory};
  let error;
  try{await resampleOHLCVAsync({kind:'immutable-columns',columns,length:1},options);}catch(failure){error={name:failure.name,message:failure.message};}
  console.log(JSON.stringify({error,stats:calculationJobStats()}));
 `;
 const {stdout}=await execFile(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),timeout:5000,maxBuffer:1024*1024});
 return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function isolatedLateTerminationRejection() {
 const calculationURL = new URL('../src/web/calculation-job.mjs', import.meta.url).href;
 const entryURL = ENTRY.href;
 const script = `
  import {runCalculationJob,runDedicatedCalculationWorker,calculationJobStats} from ${JSON.stringify(calculationURL)};
  const entry=new URL(${JSON.stringify(entryURL)}),termination={};termination.promise=new Promise((resolve,reject)=>{termination.reject=reject;});
  let worker;let unhandled=0;process.on('unhandledRejection',()=>{unhandled++;});
  const controller=new AbortController();
  const operation=runCalculationJob({signal:controller.signal,timeoutMs:1000},async context=>{context.reserve(64);return runDedicatedCalculationWorker({},entry,{workerFactory:()=>worker={onmessage:null,onerror:null,postMessage(){},terminate(){return termination.promise;}}},context);});
  setTimeout(()=>controller.abort(),5);let error;try{await operation;}catch(failure){error={name:failure.name,message:failure.message};}
  const before=calculationJobStats();termination.reject(new Error('late termination failure'));await new Promise(resolve=>setTimeout(resolve,0));
  console.log(JSON.stringify({error,before,after:calculationJobStats(),unhandled}));
 `;
 const {stdout}=await execFile(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),timeout:5000,maxBuffer:1024*1024});
 return JSON.parse(stdout.trim().split('\n').at(-1));
}

test('timeout and abort settle while Worker cleanup stays quarantined, then recover capacity', async () => {
 const baseline = calculationJobStats(), first = hangingWorkers(), second = hangingWorkers();
 const timeout = runCalculationJob({timeoutMs:20}, async context => {
  context.reserve(64);
  return runDedicatedCalculationWorker({}, ENTRY, {workerFactory:first.factory}, context);
 });
 const controller = new AbortController();
 const aborted = runCalculationJob({signal:controller.signal,timeoutMs:1000}, async context => {
  context.reserve(64);
  return runDedicatedCalculationWorker({}, ENTRY, {workerFactory:second.factory}, context);
 });
 const timeoutSettled = settlesWithin(timeout, 'timeout');
 const abortSettled = settlesWithin(aborted, 'abort');
 const timeoutOutcome = timeoutSettled.then(() => null, error => error);
 const abortOutcome = abortSettled.then(() => null, error => error);
 await pause(5);
 controller.abort();
 assert.equal((await timeoutOutcome)?.name, 'TimeoutError');
 assert.equal((await abortOutcome)?.name, 'AbortError');
 assert.deepEqual(calculationJobStats(), {
  activeJobs: baseline.activeJobs + 2,
  reservedBytes: baseline.reservedBytes + 128,
 });

 await assert.rejects(runCalculationJob({}, async context => {
  context.reserve(64);
  return 'unreachable';
 }), /budget/);

 first.workers[0].termination.resolve();
 second.workers[0].termination.resolve();
 for(let i=0;i<20&&JSON.stringify(calculationJobStats())!==JSON.stringify(baseline);i++)await pause(0);
 assert.deepEqual(calculationJobStats(), baseline);
 assert.equal(await runCalculationJob({}, async context => {context.reserve(64);return 'healthy';}), 'healthy');
 assert.deepEqual(calculationJobStats(), baseline);
});

test('termination rejection retains reservation after successful computation and detach failure', async () => {
 const success=await isolatedTerminationFailure('success');
 assert.equal(success.error?.message,'termination failed');
 assert.deepEqual(success.stats,{activeJobs:1,reservedBytes:64});
 const detach=await isolatedTerminationFailure('detach');
 assert.equal(detach.error?.message,'detach failed');
 assert.deepEqual(detach.stats,{activeJobs:1,reservedBytes:64});
});

test('public resample API retains reservation after Worker termination rejection', async () => {
 const result=await isolatedResampleTerminationFailure();
 assert.equal(result.error?.message,'resample termination failed');
 assert.equal(result.stats.activeJobs,1);
 assert.ok(result.stats.reservedBytes>0);
});

test('late termination rejection keeps the cancelled reservation without unhandled rejection', async () => {
 const result=await isolatedLateTerminationRejection();
 assert.equal(result.error?.name,'AbortError');
 assert.deepEqual(result.before,{activeJobs:1,reservedBytes:64});
 assert.deepEqual(result.after,result.before);
 assert.equal(result.unhandled,0);
});

test('stopped jobs ignore late packets and drain every cleanup after termination acknowledgement', async () => {
 const baseline=calculationJobStats(),termination=deferred();let worker,lateMessage,published=0,remainingCleanup=false,checkError;
 const operation=runCalculationJob({timeoutMs:20},async context=>{
  context.reserve(64);context.publish(()=>{published++;return 'published';});
  context.cleanup(()=>{remainingCleanup=true;});
  context.cleanup(async()=>{await termination.promise;try{context.check();}catch(error){checkError=error;}});
  return runDedicatedCalculationWorker({},ENTRY,{workerFactory:()=>worker={onmessage:null,onerror:null,postMessage(){lateMessage=worker.onmessage;},terminate(){return termination.promise;}}},context);
 });
 await assert.rejects(operation,{name:'TimeoutError'});
 assert.equal(typeof lateMessage,'function');
 assert.equal(remainingCleanup,false);
 lateMessage({data:{packet:{ok:true}}});
 assert.equal(published,0);
 termination.resolve();
 for(let i=0;i<20&&JSON.stringify(calculationJobStats())!==JSON.stringify(baseline);i++)await pause(0);
 assert.equal(remainingCleanup,true);
 assert.equal(checkError?.name,'TimeoutError');
 assert.deepEqual(calculationJobStats(),baseline);
 assert.equal(published,0);
});
