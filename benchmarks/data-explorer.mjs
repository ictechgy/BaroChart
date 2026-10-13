// Absolute synchronous API cost, not a renderer/frame-rate or competitor comparison.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {BarStore,ChartModel,ChartAPI,seededColumns} from '../src/core/index.mjs';
const count=Number(process.argv[2]),seriesCount=Number(process.argv[3]),path=process.argv[4];assert([100000,1000000].includes(count));assert([1,8].includes(seriesCount));assert(path);assert.equal(typeof globalThis.gc,'function');
{const w=new ChartModel(),a=new ChartAPI(w);w.store.setColumns(seededColumns(4096,42));a.addIndicator('e','ema',{period:20});a.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});for(let i=0;i<200;a.dataAt({index:4095}),i++);w.dispose();}
const store=new BarStore(),model=new ChartModel({store}),api=new ChartAPI(model);
// Adding on an empty source leaves initial full calculation to the first query.
for(let i=0;i<seriesCount;i++){api.addIndicator('e'+i,'ema',{period:20+i});api.addSeries({id:'s'+i,type:'line',panel:'price',indicator:'e'+i});}
store.setColumns(seededColumns(count,42));
const measure=fn=>{const start=performance.now(),value=fn();return {ms:performance.now()-start,value};};
globalThis.gc();const initialMemory=process.memoryUsage(),cold=measure(()=>api.dataAt({index:count-1}));
const verify=result=>{for(let s=0;s<seriesCount;s++){const p=20+s,alpha=2/(p+1);let sum=0,ema=NaN;for(let i=0;i<count;i++){const close=store.columns.close[i];if(i<p){sum+=close;if(i===p-1)ema=sum/p;}else ema+=alpha*(close-ema);}assert.ok(Object.is(result.series[s].value,ema));}};
verify(cold.value);for(let i=0;i<200;i++)api.dataAt({index:count-1});
const warm={};for(const mode of ['index','exact-time']){const batches=[];for(let b=0;b<9;b++){const start=performance.now();for(let i=0;i<500;i++){const index=count-1-(i%100),result=api.dataAt(mode==='index'?{index}:{time:store.columns.time[index],match:'exact'});assert.equal(result.index,index);assert.equal(result.series.length,seriesCount);}batches.push((performance.now()-start)/500);}warm[mode]={queriesPerBatch:500,batchesMsPerQuery:batches,medianMsPerQuery:[...batches].sort((a,b)=>a-b)[4]};}
const original=store.at(0);store.update(0,{...original,close:original.close+0.01,high:Math.max(original.high,original.close+0.01)});globalThis.gc();const correction=measure(()=>api.dataAt({index:count-1}));verify(correction.value);const correctionComputedRows=[...model.indicators.entries.values()].map(e=>e.computedUntil-e.computedFrom);
// Managed source reset invalidates the entire suffix, unlike convergent EMA correction.
store.setColumns(store.columns,store.length);globalThis.gc();const dirty=measure(()=>api.dataAt({index:count-1}));verify(dirty.value);const afterDirty=process.memoryUsage();
// Query itself must not modify the source; correction above was explicit.
const version=store.version;api.dataAt({index:count-1});assert.equal(store.version,version);
const outputBytes=[...model.indicators.entries.values()].reduce((n,e)=>n+e.arrays.reduce((sum,a)=>sum+a.byteLength,0),0);
const result={schema:'aster.data-explorer-cost.v1',node:process.version,cpu:cpus()[0]?.model,count,seriesCount,capacity:store.capacity,coldMs:cold.ms,fullDirtyMs:dirty.ms,correctionMs:correction.ms,correctionComputedRows,warm,returnedSeries:dirty.value.series.length,serializedResultBytes:Buffer.byteLength(JSON.stringify(dirty.value)),retainedIndicatorOutputBytes:outputBytes,initialMemory,afterDirty,checks:{independentEMAExact:true,queryPreservesStoreVersion:true},scope:'Synchronous Node absolute wall costs. Warm batches include result checks; cold means caches empty after source load, dirty means full same-data reset; correction is separately timed with checkpoint convergence. No browser/native responsiveness claim, no whole-process peak bound.',sourceSHA:Object.fromEntries(['src/core/data-explorer.mjs','src/core/indicators.mjs','benchmarks/data-explorer.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))};writeFileSync(path,JSON.stringify(result,null,2)+'\n');model.dispose();console.log(JSON.stringify({count,seriesCount,coldMs:result.coldMs,fullDirtyMs:result.fullDirtyMs,warm:result.warm}));
