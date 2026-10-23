import test from 'node:test';
import assert from 'node:assert/strict';
import {runChartWorker} from '../src/web/worker.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function transport({post,handlerError,terminate}={}){
 const previous=globalThis.Worker,workers=[];
 globalThis.Worker=class {
  constructor(url,options){this.url=url;this.options=options;this.terminations=0;this.posts=0;workers.push(this);}
  set onerror(value){if(handlerError)throw handlerError;this.errorHandler=value;}
  set onmessage(value){this.messageHandler=value;}
  postMessage(request){this.posts++;post?.(this,request);}
  terminate(){this.terminations++;return terminate?.(this);}
  complete(packet={ok:true}){this.messageHandler({data:{packet}});}
 };
 return {workers,restore:()=>{globalThis.Worker=previous;}};
}
test('transport rejects malformed signals before worker creation',async()=>{
 const f=transport();try{
  for(const signal of [null,0,{aborted:true},{aborted:false,removeEventListener(){}},{aborted:'false',addEventListener(){},removeEventListener(){}}])
   await assert.rejects(runChartWorker({}, {signal,timeoutMs:5}),TypeError);
  assert.equal(f.workers.length,0);
 }finally{await pause(10);f.restore();}
});
test('transport validates bounded timeout and progress callback before allocation',async()=>{
 const f=transport({post:w=>w.complete()});try{
  for(const timeoutMs of [0,-1,NaN,Infinity,'5',null,120001])await assert.rejects(runChartWorker({}, {timeoutMs}),RangeError);
  for(const onProgress of [null,0,{}])await assert.rejects(runChartWorker({}, {onProgress}),TypeError);
  assert.equal(f.workers.length,0);
 }finally{f.restore();}
});
test('already aborted signal creates no worker and keeps AbortError',async()=>{
 const f=transport(),c=new AbortController();c.abort();try{await assert.rejects(runChartWorker({}, {signal:c.signal}),e=>e.name==='AbortError');assert.equal(f.workers.length,0);}finally{f.restore();}
});
test('listener registration failure immediately terminates the allocated worker',async()=>{
 const f=transport(),error=new Error('registration failed');let removed=0;
 const signal={aborted:false,addEventListener(){throw error;},removeEventListener(){removed++;}};
 try{await assert.rejects(runChartWorker({}, {signal,timeoutMs:20}),e=>e===error);assert.equal(f.workers[0].terminations,1);assert.equal(removed,1);assert.equal(f.workers[0].posts,0);}finally{await pause(25);f.restore();}
});
test('abort during registration skips posting and terminates once',async()=>{
 const f=transport();let removed=0;const signal={aborted:false,addEventListener(_kind,cancel){this.aborted=true;cancel();},removeEventListener(){removed++;}};
 try{await assert.rejects(runChartWorker({}, {signal,timeoutMs:10}),e=>e.name==='AbortError');assert.equal(f.workers[0].posts,0);assert.equal(f.workers[0].terminations,1);assert.equal(removed,1);await pause(15);assert.equal(f.workers[0].terminations,1);}finally{f.restore();}
});
test('listener removal failure cannot prevent termination or hide the original posting error',async()=>{
 const original=new Error('posting failed'),cleanup=new Error('removal failed');
 const signal={aborted:false,addEventListener(){},removeEventListener(){throw cleanup;}};
 const f=transport({post(){throw original;}});try{
  const pending=runChartWorker({}, {signal,timeoutMs:10});pending.catch(()=>{});
  await assert.rejects(Promise.race([pending,pause(30).then(()=>{throw new Error('unsettled transport');})]),e=>e===original);
  assert.equal(f.workers[0].terminations,1);
 }finally{f.restore();}
});
test('successful reply still terminates when listener removal fails',async()=>{
 const cleanup=new Error('removal failed'),signal={aborted:false,addEventListener(){},removeEventListener(){throw cleanup;}};
 const f=transport({post:w=>w.complete()});try{
  const pending=runChartWorker({}, {signal,timeoutMs:10});pending.catch(()=>{});
  await assert.rejects(Promise.race([pending,pause(30).then(()=>{throw new Error('unsettled transport');})]),e=>e===cleanup);assert.equal(f.workers[0].terminations,1);
 }finally{f.restore();}
});
test('handler setup failure follows the same cleanup path',async()=>{
 const error=new Error('handler setup failed'),f=transport({handlerError:error});try{await assert.rejects(runChartWorker({}, {timeoutMs:10}),e=>e===error);assert.equal(f.workers[0].terminations,1);}finally{await pause(15);f.restore();}
});
test('late replies after timeout or abort cannot deliver or terminate twice',async()=>{
 const f=transport();try{
  const timed=runChartWorker({}, {timeoutMs:5});await assert.rejects(timed,e=>e.name==='TimeoutError');f.workers[0].complete();assert.equal(f.workers[0].terminations,1);
  const c=new AbortController(),pending=runChartWorker({}, {signal:c.signal});c.abort();await assert.rejects(pending,e=>e.name==='AbortError');f.workers[1].complete();assert.equal(f.workers[1].terminations,1);
 }finally{f.restore();}
});
test('custom URL, progress isolation and success retain transport behavior',async()=>{
 const url=new URL('https://example.invalid/chart-worker.js'),f=transport();try{
  const pending=runChartWorker({x:1},{workerURL:url,onProgress(){throw new Error('observer');}}),w=f.workers[0];assert.equal(w.url,url);assert.deepEqual(w.options,{type:'module'});w.messageHandler({data:{progress:{phase:'compute',done:1,total:1}}});w.complete({ok:2});assert.deepEqual(await pending,{ok:2});assert.equal(w.terminations,1);
 }finally{f.restore();}
});

test('malformed Worker replies reject immediately and terminate once',async()=>{
 const packets=[null,{},Object.create(null),{error:''},{error:1},{progress:null},{progress:{}},{packet:null},{packet:1},{progress:{done:1,total:1},packet:{ok:true}}];
 for(const data of packets){
  const f=transport();
  try{
   const pending=runChartWorker({}, {timeoutMs:1000}),worker=f.workers[0];
   worker.messageHandler({data});
   await assert.rejects(Promise.race([pending,pause(50).then(()=>{throw new Error('malformed reply remained pending');})]), error => error instanceof TypeError);
   assert.equal(worker.terminations,1);
  }finally{f.restore();}
 }
});

test('valid progress and packets remain accepted while malformed progress fields reject',async()=>{
 const f=transport();
 try{
  const progress=[];
  const pending=runChartWorker({}, {onProgress:value=>progress.push(value)}),worker=f.workers[0];
  worker.messageHandler({data:{progress:{phase:'compute',done:1,total:2}}});
  worker.complete({ok:true});
  assert.deepEqual(await pending,{ok:true});
  assert.deepEqual(progress,[{phase:'compute',done:1,total:2}]);
  assert.equal(worker.terminations,1);
 }finally{f.restore();}
});

test('async termination rejection is observed after success or Worker error',async()=>{
 let unhandled;
 const onUnhandled=error=>{unhandled=error};
 process.on('unhandledRejection',onUnhandled);
 try{
  for(const mode of ['success','error']){
   const cleanup=new Error(`${mode} cleanup failed`),f=transport({
    post(worker){if(mode==='success')worker.complete({ok:true});else worker.messageHandler({data:{error:'worker failed'}});},
    terminate(){return Promise.reject(cleanup);},
   });
   try{
    const pending=runChartWorker({}, {timeoutMs:1000});
    if(mode==='success')assert.deepEqual(await pending,{ok:true});
    else await assert.rejects(pending,/worker failed/);
    await pause(0);
    assert.equal(unhandled,undefined,`${mode} termination rejection was unhandled`);
    assert.equal(f.workers[0].terminations,1);
   }finally{f.restore();}
  }
 }finally{process.off('unhandledRejection',onUnhandled);}
});
