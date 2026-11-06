import test from 'node:test';
import assert from 'node:assert/strict';
import {runCalculationJob,runDedicatedCalculationWorker} from '../src/web/calculation-job.mjs';

function transport(){
 const workers=[];
 class Worker {
  constructor(){this.terminated=false;workers.push(this);}
  postMessage(){}
  terminate(){this.terminated=true;}
  reply(data){this.onmessage?.({data});}
  messageError(event={}){this.onmessageerror?.(event);}
 }
 return {workers,workerFactory:()=>new Worker()};
}

async function runWithReply(reply){
 const f=transport(),pending=runCalculationJob({timeoutMs:1000},context=>runDedicatedCalculationWorker(
  {schema:'aster.resample-request',version:1,jobId:context.id,kind:'resample'},
  new URL('../src/web/resample-worker.mjs',import.meta.url),
  {workerFactory:f.workerFactory},context));
 const worker=f.workers[0];reply(worker);
 await assert.rejects(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('unsettled transport')),30))]),/response protocol|message/);
 assert.equal(worker.terminated,true);
}

test('malformed dedicated worker envelopes reject immediately and terminate',async()=>{
 for(const payload of [null,{}, {unknown:true}])await runWithReply(worker=>worker.reply(payload));
});

test('dedicated worker messageerror rejects immediately and terminates',async()=>{
 await runWithReply(worker=>worker.messageError({message:'deserialization failed'}));
});

test('documented non-extensible custom calculation workers remain supported',async()=>{
 let posted=0,terminated=0;
 const worker=Object.preventExtensions({onmessage:null,onerror:null,
  postMessage(request){posted++;queueMicrotask(()=>this.onmessage?.({data:{schema:'aster.resample-result',version:1,jobId:request.jobId,kind:request.kind}}));},
  terminate(){terminated++;},
 });
 const packet=await runCalculationJob({timeoutMs:1000},context=>runDedicatedCalculationWorker(
  {schema:'aster.resample-request',version:1,jobId:context.id,kind:'resample'},new URL('../src/web/resample-worker.mjs',import.meta.url),{workerFactory:()=>worker},context));
 assert.equal(packet.schema,'aster.resample-result');assert.equal(posted,1);assert.equal(terminated,1);
 assert.equal(worker.onmessage,null);assert.equal(worker.onerror,null);assert.equal(Object.hasOwn(worker,'onmessageerror'),false);
});
