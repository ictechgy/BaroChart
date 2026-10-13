// Bounded cap-recovery correctness/cost probe, not a renderer benchmark.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ChartModel,ChartAPI} from '../src/core/index.mjs';
const row=time=>({time,open:2,high:3,low:1,close:2,volume:time%2?-0:1});
const model=new ChartModel();model.store.setData(Array.from({length:64},(_,i)=>row(i)));
const api=new ChartAPI(model),callbacks={create:0,step:0,snapshot:0,restore:0};
model.indicators.register('probe',()=>({outputs:['v'],create(){callbacks.create++;return {step:b=>{callbacks.step++;return [b.close];},snapshot(){callbacks.snapshot++;return 0;},restore(){callbacks.restore++;}};}}));
api.addIndicator('p','probe');for(const key of Object.keys(callbacks))callbacks[key]=0;
api.configureDataIngestion({streamId:'bounded',generation:1,maxQueuedEvents:4096,maxQueuedBytes:4096*49,maxBatchEvents:32,maxStoredBars:64,maxStoreBytes:96*64});
api.enqueueDataEvents({streamId:'bounded',generation:1,firstSequence:0,events:Array.from({length:4096},(_,i)=>({kind:'append',bar:row(i+64)}))});
const queue=model.dataIngestion,ring=queue.columns,kinds=queue.kinds,source=model.store;
assert.throws(()=>api.drainDataEvents(32));assert.equal(queue.paused,true);assert.equal(queue.count,4096);
const samples=[],start=performance.now();let checkedEvents=0,maxPeakSourceBytes=0,iterations=0;
while(queue.count){checkedEvents+=queue.count;const before=performance.now(),receipt=api.compactData({keepLastBars:32,studyHistory:'restart',pendingData:'preserve-retained'});samples.push(performance.now()-before);maxPeakSourceBytes=Math.max(maxPeakSourceBytes,receipt.peakSourceBytes);assert.equal(receipt.removed,32);api.resumeDataIngestion();assert.equal(api.drainDataEvents(32).events,32);api.pauseDataIngestion();assert.equal(model.store,source);assert.equal(source.length,64);assert.equal(source.capacity,64);assert.equal(queue.columns,ring);assert.equal(queue.kinds,kinds);iterations++;}
const wallMs=performance.now()-start;
for(let i=0;i<64;i++){const expected=row(4096+i),actual=source.at(i);for(const field of Object.keys(expected))assert(Object.is(actual[field],expected[field]),field+' exact final suffix');}
assert.deepEqual(callbacks,{create:0,step:0,snapshot:0,restore:0});assert.equal(queue.counters.accepted,4096);assert.equal(queue.counters.applied,4096);assert.equal(queue.counters.cancelled,0);assert.equal(queue.nextSequence,4096);assert.equal(source.listenerErrors.length,0);
const ordered=[...samples].sort((a,b)=>a-b),result={schema:'barochart.pending-compaction-cost.v1',node:process.version,platform:process.platform,arch:process.arch,fixture:{initialRows:64,pendingEvents:4096,drainPrefix:32,keepLastBars:32},iterations,validatedPendingEvents:checkedEvents,wallMs,compactionMs:{min:ordered[0],median:ordered[Math.floor(ordered.length/2)],p95:ordered[Math.ceil(.95*ordered.length)-1],max:ordered.at(-1)},sourceOwnedBytes:source.bytes,maxPeakSourceBytes,ringOwnedBytes:queue.capacity*49,maxTemporaryQueueTypedBytes:4096*49,callbacks,exactFinalSuffix:true,accepted:4096,applied:4096,cancelled:0,scope:'Synchronous Node cap recovery and exact FIFO/source contract; no browser/native UI latency or global RSS claim. Repeated compaction rechecks the entire remaining FIFO; schedule bounded host work rather than copying this tight benchmark loop into UI code.'};
model.dispose();assert.equal(source.listeners.size,0);assert.equal(queue.kinds,null);assert.equal(queue.model,null);result.cleanup=true;console.log(JSON.stringify(result,null,2));
