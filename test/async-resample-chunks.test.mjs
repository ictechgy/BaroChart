import test from 'node:test';
import assert from 'node:assert/strict';
import {resampleOHLCV,SessionCalendar} from '../src/core/index.mjs';
import {resampleOHLCVAsync} from '../src/web/resample-async.mjs';
import {computeResampleRequest} from '../src/web/resample-worker.mjs';
import {calculationJobStats} from '../src/web/calculation-job.mjs';
const t=Date.parse('2026-04-01T09:00Z'),fields=['time','open','high','low','close','volume'];
const baseOpts={sourceIntervalMs:1,targetIntervalMs:7,kinds:['regular'],asOf:t+20000,partialTarget:'include-unconfirmed',calendar:new SessionCalendar('UTC',()=>[{open:'09:00',close:'10:00'}])};
let workers=0;
const workerFactory=()=>{workers++;return {postMessage(request,transfer){const copy=structuredClone(request,{transfer});queueMicrotask(()=>this.onmessage?.({data:computeResampleRequest(copy)}))},terminate(){},onmessage:null,onerror:null}};
const columns=n=>Object.fromEntries(fields.map(k=>[k,Float64Array.from({length:n},(_,i)=>k==='time'?t+i:1)]));
// Inline transport isolates chunk boundaries; actual-thread lifecycle is tested separately.
for(const targetIntervalMs of [1,7])for(const n of [0,1,16383,16384,16385])test(`async chunk coverage ${n} rows / target ${targetIntervalMs}`,async()=>{
 const opts={...baseOpts,targetIntervalMs};
 const input={columns:columns(n),length:n},progress=[];
 const actual=await resampleOHLCVAsync({kind:'immutable-columns',...input},{...opts,workerFactory,onProgress:p=>progress.push(p)});
 assert.deepEqual(actual,resampleOHLCV(input,opts));
 for(const phase of ['snapshot','validate']){const p=progress.filter(p=>p.phase===phase);assert.ok(p.length);assert.equal(p[0].done,0);assert.equal(p.at(-1).done,p.at(-1).total);for(let i=1;i<p.length;i++){assert.ok(p[i].done>=p[i-1].done);assert.ok(p[i].done<=p[i].total);}}
 assert.equal(progress.filter(p=>p.phase==='snapshot').length,1+6*Math.ceil(n/16384));
 assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});
});
test('first-full-chunk cancellation prevents worker creation',async()=>{
const controller=new AbortController(),before=workers;
await assert.rejects(resampleOHLCVAsync({kind:'immutable-columns',columns:columns(16385),length:16385},{...baseOpts,workerFactory,signal:controller.signal,onProgress:p=>{if(p.phase==='snapshot'&&p.done===16384)controller.abort()}}),{name:'AbortError'});
assert.equal(workers,before);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});});
