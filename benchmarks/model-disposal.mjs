// Retained disposed-model experiment. Explicit-GC Node observations are not a
// browser/native memory measurement or a universal leak-freedom assertion.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,platform,arch} from 'node:os';

const root=resolve(process.argv[2]??'.'),output=resolve(process.argv[3]??'benchmarks/results/model-disposal.json'),bars=Number(process.argv[4]??100000);
assert([100000,1000000].includes(bars));assert.equal(typeof globalThis.gc,'function','Run with --expose-gc');
const {BarStore,ChartModel,seededColumns}=await import(pathToFileURL(resolve(root,'src/core/index.mjs')));
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashColumns=model=>{const h=createHash('sha256');for(const values of Object.values(model.store.columns))h.update(new Uint8Array(values.buffer,values.byteOffset,values.byteLength));return h.digest('hex');};
function derivedReachable(model){
 const buffers=new Set(),seen=new Set();
 function visit(value){if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);if(ArrayBuffer.isView(value)){buffers.add(value.buffer);return;}for(const next of Object.values(value))visit(next);}
 for(const series of model.series)visit(series.rangeIndex);
 return {buffers:buffers.size,bytes:[...buffers].reduce((sum,b)=>sum+b.byteLength,0),path:'model.series[*].rangeIndex recursively, buffers deduplicated'};
}
function createModel(){const store=new BarStore();store.setColumns(seededColumns(bars,42));const model=new ChartModel({store});
 for(let i=0;i<8;i++){model.indicators.add('ema'+i,'ema',{period:20+i});model.addSeries({id:'ema'+i,type:'line',panel:'price',indicator:'ema'+i});model.seriesData(model.series[i]);}return model;
}
async function collected(){for(let i=0;i<3;i++){globalThis.gc();await new Promise(resolve=>setImmediate(resolve));}return process.memoryUsage();}
const start=await collected();let model=createModel();globalThis.__asterRetainedModel=model;
const fixtureSHA256=hashColumns(model),beforeGC=await collected();
const before={process:beforeGC,derived:derivedReachable(model),sourceBytes:model.store.bytes,storeListeners:model.store.listeners.size,indicators:model.indicators.entries.size};
const time=performance.now();model.dispose();const disposalCpuMs=performance.now()-time;
const disposedGC=await collected();
assert.equal(hashColumns(model),fixtureSHA256,'Full Float64 source bytes preserved');assert.equal(model.store.length,bars);assert.equal(model.store.listeners.size,0);assert.equal(model.indicators.entries.size,0);
const afterDispose={process:disposedGC,derived:derivedReachable(model),sourceBytes:model.store.bytes,storeListeners:model.store.listeners.size,indicators:model.indicators.entries.size,series:model.series.length,disposed:model.disposed};
model.dispose();assert.deepEqual(derivedReachable(model),afterDispose.derived,'Idempotent disposal');
model=null;globalThis.__asterRetainedModel=null;const afterRelease=await collected();
const report={timestamp:new Date().toISOString(),root,environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},conditions:{bars,series:8,indicator:'EMA periods20..27',seed:42,retained:'Disposed model and source store kept live through afterDispose; both dropped for afterRelease',gc:'Three explicit GC turns before each observation'},fixtureSHA256,sourceSHA256:sha(await readFile(resolve(root,'src/core/model.mjs'))),harnessSHA256:sha(await readFile(new URL(import.meta.url))),start,before,afterDispose,afterRelease,disposalCpuMs,scope:'Exact model-owned range-index buffer reachability plus Node process memory snapshots; process/RSS values include runtime effects; no browser/native/FPS/universal leak claim'};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);
