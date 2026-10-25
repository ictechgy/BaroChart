// Exact warm results and dirty availability are separate workloads.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {BarStore,ChartModel,ChartAPI,IndicatorEngine,seededColumns} from '../src/core/index.mjs';

const count=Number(process.argv[2]),studies=Number(process.argv[3]),output=process.argv[4];
assert([100000,1000000].includes(count),'count: 100000 or 1000000');
assert([8,32].includes(studies),'studies: 8 or 32');
assert(output,'output JSON path required');
assert.equal(typeof globalThis.gc,'function','run with --expose-gc');
const samples=2000,warmups=200,store=new BarStore(),model=new ChartModel({store}),api=new ChartAPI(model);
const percentile=values=>{const sorted=[...values].sort((a,b)=>a-b);return Object.fromEntries([['p50',.5],['p95',.95],['p99',.99],['max',1]].map(([name,fraction])=>[name,sorted[Math.floor((sorted.length-1)*fraction)]]));};
const measure=fn=>{const start=performance.now(),value=fn();return {value,ms:performance.now()-start};};
const digest=()=>{const hash=createHash('sha256');for(const entry of model.indicators.entries.values())for(const array of entry.arrays)hash.update(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));return hash.digest('hex');};
const cacheState=()=>[...model.indicators.entries.values()].map(entry=>({entry,arrays:entry.arrays,vectors:[...entry.arrays],dirty:entry.dirty,dirtyTo:entry.dirtyTo,invalidated:entry.invalidated,length:entry.length,revision:entry.revision,checkpoints:entry.checkpoints}));
const assertCacheState=before=>{const after=cacheState();assert.equal(after.length,before.length);for(let i=0;i<before.length;i++){for(const key of ['entry','arrays','dirty','dirtyTo','invalidated','length','revision','checkpoints'])assert.strictEqual(after[i][key],before[i][key],key);assert.equal(after[i].vectors.length,before[i].vectors.length);for(let j=0;j<before[i].vectors.length;j++)assert.strictEqual(after[i].vectors[j],before[i].vectors[j]);}};
try{
 api.addSeries({id:'price',type:'candles',panel:'price'});
 for(let i=0;i<studies;i++){api.addIndicator('e'+i,'ema',{period:20+i});api.addSeries({id:'s'+i,type:'line',panel:'price',indicator:'e'+i});}
 store.setColumns(seededColumns(count,42));
 globalThis.gc();
 const cold=measure(()=>api.dataAt({index:count-1}));
 const cachedOptions={indicatorMode:'cached'},calculateOptions={indicatorMode:'calculate'};
 for(let i=0;i<warmups;i++){api.dataAt({index:count-1-i%200},calculateOptions);api.dataAt({index:count-1-i%200},cachedOptions);}
 const exact={calculate:[],cached:[]},beforeWarm=cacheState(),warmDigest=digest();globalThis.gc();
 for(let i=0;i<samples;i++){
  const query={index:count-1-i%200},order=i%2?['cached','calculate']:['calculate','cached'],results={};
  for(const mode of order){const result=measure(()=>api.dataAt(query,mode==='cached'?cachedOptions:calculateOptions));exact[mode].push(result.ms);results[mode]=result.value;}
  assert.deepEqual(results.cached,results.calculate,'warm modes must return identical scalar snapshots');
 }
 assertCacheState(beforeWarm);assert.equal(digest(),warmDigest);
 // A full same-data reset leaves old output bytes present but not certified.
 // The cached availability lane must never turn those bytes into fresh values.
 store.setColumns(store.columns,store.length);
 const beforePending=cacheState(),pendingDigest=digest(),version=store.version,columns=store.columns,view={...model.view},crosshair=model.crosshair,drawings=model.drawings.items;
 const originalGet=IndicatorEngine.prototype.get,originalCalculate=IndicatorEngine.prototype.calculate,calls={get:0,calculate:0},pending=[];
 try{
  IndicatorEngine.prototype.get=function(){calls.get++;throw new Error('Cached read called indicator get');};
  IndicatorEngine.prototype.calculate=function*(){calls.calculate++;throw new Error('Cached read called indicator calculate');};
  globalThis.gc();
  for(let i=0;i<samples;i++){
   const index=count-1-i%200,result=measure(()=>api.dataAt({index},cachedOptions));pending.push(result.ms);
   assert.equal(result.value.primary.bar.time,store.columns.time[index]);
   assert.equal(result.value.series[0].status,'value');
   for(const row of result.value.series.slice(1)){assert.equal(row.status,'pending');assert.equal(row.value,null);assert.equal(row.sourceIndex,index);assert.equal(row.sourceTime,store.columns.time[index]);}
  }
 }finally{IndicatorEngine.prototype.get=originalGet;IndicatorEngine.prototype.calculate=originalCalculate;}
 assert.deepEqual(calls,{get:0,calculate:0});assertCacheState(beforePending);assert.equal(digest(),pendingDigest);assert.equal(store.version,version);assert.strictEqual(store.columns,columns);assert.deepEqual(model.view,view);assert.strictEqual(model.crosshair,crosshair);assert.strictEqual(model.drawings.items,drawings);
 const dirty=measure(()=>api.dataAt({index:count-1}));
 for(let s=0;s<studies;s++){
  const period=20+s,alpha=2/(period+1);let sum=0,ema=NaN;
  for(let i=0;i<count;i++){const close=store.columns.close[i];if(i<period){sum+=close;if(i===period-1)ema=sum/period;}else ema+=alpha*(close-ema);}
  assert.ok(Object.is(dirty.value.series[s+1].value,ema),'independent EMA oracle');
 }
 const warmCalculate=percentile(exact.calculate),warmCached=percentile(exact.cached),dirtyPending=percentile(pending),absoluteTargetMs=studies===8?.25:.75;
 const sources=['src/core/data-explorer.mjs','src/core/indicators.mjs','src/core/data.mjs','benchmarks/cached-readout.mjs'];
 const result={schema:'barochart.cached-readout.v1',timestamp:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model},fixture:{count,studies,visibleSeries:studies+1,capacity:store.capacity,seed:42,warmups,samplesPerLane:samples,order:'alternating warmed calculate/cached; separate dirty availability lane',gc:'before each lane; no forced GC inside samples'},exact:{coldCalculateMs:cold.ms,dirtyCalculateMs:dirty.ms,warmCalculateMs:warmCalculate,warmCachedMs:warmCached,cachedP95Ratio:warmCached.p95/warmCalculate.p95},availability:{dirtyCachedMs:dirtyPending,returnedIndicatorStatus:'pending',indicatorCalculationAttempts:calls},targets:{absoluteP95Ms:absoluteTargetMs,warmRatioMaximum:1.25,warmAbsoluteMet:warmCached.p95<=absoluteTargetMs,pendingAbsoluteMet:dirtyPending.p95<=absoluteTargetMs,warmRatioMet:warmCached.p95<=warmCalculate.p95*1.25},checks:{warmExactEquality:true,independentEMAExact:true,pendingHasNoOldValues:true,zeroLazyCalculation:true,sourceAndCacheUnchanged:true},sourceSHA256:Object.fromEntries(sources.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),scope:'Synchronous Node scalar-query cost only. Exact warm output and dirty pending availability are different contracts and are not a speedup ratio. No renderer, browser responsiveness, display FPS, native-device or competitor performance claim.'};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({count,studies,exact:result.exact,availability:result.availability,targets:result.targets}));
}finally{model.dispose();}
