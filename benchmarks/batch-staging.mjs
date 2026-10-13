// Fixed-history transactional burst CPU. No renderer or end-to-end feed latency.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,platform,arch} from 'node:os';
const root=resolve(process.argv[2]??'.'),output=resolve(process.argv[3]??'benchmarks/results/batch-staging.json'),caseId=process.argv[4]??'store-100k-4096';
const cases={
 'store-100k-4096':{bars:100000,events:4096,route:'store',mixed:false},
 'queue-100k-4096':{bars:100000,events:4096,route:'queue',mixed:false},
 'store-1m-4096':{bars:1000000,events:4096,route:'store',mixed:false},
 'queue-100k-mixed128':{bars:100000,events:128,route:'queue',mixed:true},
 'store-100k-8':{bars:100000,events:8,route:'store',mixed:false},
};
const condition=cases[caseId];assert(condition,'Known batch staging case');
const {BarStore,ChartModel,ChartAPI,seededColumns,FIELDS}=await import(pathToFileURL(resolve(root,'src/core/index.mjs')));
const hash=value=>createHash('sha256').update(value).digest('hex');
const digestStore=store=>{const h=createHash('sha256');for(const key of FIELDS)h.update(new Uint8Array(store.columns[key].buffer));for(const key of ['min','max','sum'])h.update(new Uint8Array(store.index[key].buffer));return h.digest('hex');};
const store=new BarStore(),reference=new BarStore();store.setColumns(seededColumns(condition.bars,42));reference.setColumns(seededColumns(condition.bars,42));
const events=Array.from({length:condition.events},(_,i)=>{const correction=condition.mixed&&i%4===0,index=correction?i*7919%store.length:store.length-1,price=100+(i%17)*.123456789012345;return {kind:correction?'correction':'update',bar:{time:store.columns.time[index],open:price,high:price+1,low:price-1,close:price,volume:i%5===0?-0:(i+1)/10}};});
const fixtureSHA256=hash(JSON.stringify({condition,events,initial:digestStore(store)}));
for(const event of events)reference.update(event.kind==='update'?reference.length-1:reference.lowerBound(event.bar.time),event.bar);
const expectedSHA256=digestStore(reference),model=new ChartModel({store}),api=new ChartAPI(model);
if(condition.route==='queue')api.configureDataIngestion({streamId:'burst',generation:1,maxQueuedEvents:4096,maxQueuedBytes:4096*49,maxBatchEvents:4096});
let sequence=0,publications=0;const off=store.subscribe(()=>publications++);
const run=()=>{if(condition.route==='store')return store.applyEvents(events);const packet={streamId:'burst',generation:1,firstSequence:sequence,events};api.enqueueDataEvents(packet);sequence+=events.length;return api.drainDataEvents();};
// Exact operation-count observation is outside the timed loop.
const originalSet=Map.prototype.set,records=new Set(),keys=new Set();let writes=0;
Map.prototype.set=function(key,value){if(Number.isInteger(key)&&value&&Object.hasOwn(value,'min')&&Object.hasOwn(value,'max')&&Object.hasOwn(value,'sum')){records.add(value);keys.add(key);writes++;}return originalSet.call(this,key,value);};
try{run();}finally{Map.prototype.set=originalSet;}
const staged={distinctRecords:records.size,distinctKeys:keys.size,mapWrites:writes};records.clear();keys.clear();
assert.equal(digestStore(store),expectedSHA256,'All six columns and all tree cells equal scalar order');
const phase=process.env.ASTER_STAGING_PHASE??'full',warmup=Number(process.env.ASTER_STAGING_WARMUP??15),samples=Number(process.env.ASTER_STAGING_SAMPLES??40);
assert(['full','enqueue','drain'].includes(phase));assert(phase==='full'||condition.route==='queue');assert(Number.isInteger(warmup)&&warmup>=0&&warmup<=1000);assert(Number.isInteger(samples)&&samples>=1&&samples<=1000);
for(let i=0;i<warmup;i++)run();globalThis.gc?.();
const rawMs=[];for(let i=0;i<samples;i++){
 if(phase==='full'){const start=performance.now();run();rawMs.push(performance.now()-start);}
 else{const packet={streamId:'burst',generation:1,firstSequence:sequence,events};const start=performance.now();api.enqueueDataEvents(packet);const enqueued=performance.now();sequence+=events.length;api.drainDataEvents();const drained=performance.now();rawMs.push(phase==='enqueue'?enqueued-start:drained-enqueued);}
}
assert.equal(digestStore(store),expectedSHA256);assert.equal(publications,1+warmup+samples);
const stats=condition.route==='queue'?api.dataIngestionStats():null;
if(stats){assert.equal(stats.pendingEvents,0);assert.equal(stats.accepted,sequence);assert.equal(stats.applied,sequence);assert.equal(stats.cancelled,0);}
off();model.dispose();assert.equal(store.listeners.size,0);
const ordered=rawMs.toSorted((a,b)=>a-b),report={timestamp:new Date().toISOString(),root,caseId,condition,phase,warmup,samples,environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},sourceSHA256:hash(await readFile(resolve(root,'src/core/data.mjs'))),harnessSHA256:hash(await readFile(new URL(import.meta.url))),fixtureSHA256,resultSHA256:expectedSHA256,staged,rawMs,p50Ms:ordered[Math.floor(samples*.5)],p95Ms:ordered[Math.floor(samples*.95)],stats,publications,scope:'Warm fixed-capacity store.applyEvents or selected full/enqueue/drain queue phase CPU; fixture, scalar oracle, hashing and allocation instrumentation excluded; no append-growth, RSS/heap savings, renderer/native/feed-latency claim'};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);
