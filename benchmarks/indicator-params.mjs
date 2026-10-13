// Absolute cost/retained-buffer experiment for a new synchronous API, not a
// speed comparison, browser frame measurement, or whole-process peak estimate.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cpus,platform,arch} from 'node:os';
import {performance} from 'node:perf_hooks';
import {BarStore,ChartModel,ChartAPI,seededColumns} from '../src/core/index.mjs';
const count=Number(process.argv[2]??100000),output=process.argv[3];assert([100000,1000000].includes(count));assert(output);assert.equal(typeof globalThis.gc,'function');
const hash=views=>{const h=createHash('sha256');for(const v of views)h.update(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));return h.digest('hex');};
const collect=(value,buffers=new Set(),seen=new Set())=>{if(!value||typeof value!=='object'||seen.has(value))return buffers;seen.add(value);if(ArrayBuffer.isView(value))buffers.add(value.buffer);else for(const v of Object.values(value))collect(v,buffers,seen);return buffers;};
const bytes=buffers=>[...buffers].reduce((s,b)=>s+b.byteLength,0);
const setup=n=>{const store=new BarStore();store.setColumns(seededColumns(n,42));const model=new ChartModel({store}),api=new ChartAPI(model);api.addIndicator('target','ema',{period:20});api.addIndicator('control','rsi',{period:14});api.addSeries({id:'target',type:'line',panel:'price',indicator:'target'});api.addSeries({id:'control',type:'line',panel:'price',indicator:'control'});for(const s of model.series)model.seriesData(s);return {model,api};};
{const {model,api}=setup(4096);for(let i=0;i<12;i++)api.setIndicatorParams('target',{period:i%2?20:50});model.dispose();}globalThis.gc();
const {model,api}=setup(count),store=model.store,target=model.series[0],control=model.indicators.entries.get('control'),controlIndex=model.series[1].rangeIndex,sourceHash=hash(Object.values(store.columns));
let oldEntry=model.indicators.entries.get('target'),oldIndex=target.rangeIndex,heldOutput=oldEntry.arrays[0].subarray(0,count);
const oldHash=hash([heldOutput]),oldTargetBytes=bytes(collect({arrays:oldEntry.arrays,index:oldIndex}));globalThis.gc();const before=process.memoryUsage();
const cpuStart=process.cpuUsage(),start=performance.now();const receipt=api.setIndicatorParams('target',{period:50});const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuStart),afterNoGC=process.memoryUsage();
const entry=model.indicators.entries.get('target'),additionalOutputBytes=bytes(collect(entry.arrays));assert.equal(target.rangeIndex,null);assert.equal(model.indicators.entries.get('control'),control);assert.equal(model.series[1].rangeIndex,controlIndex);assert.equal(hash([heldOutput]),oldHash);assert.equal(hash(Object.values(store.columns)),sourceHash);
const values=model.indicators.get('target').outputs.value,alpha=2/51;let sum=0,ema=NaN;for(let i=0;i<count;i++){const close=store.columns.close[i];if(i<50){sum+=close;if(i===49)ema=sum/50;}else ema+=alpha*(close-ema);assert.ok(Object.is(values[i],ema),`EMA oracle row ${i}`);}globalThis.gc();const afterGCWithHeldViews=process.memoryUsage();
oldEntry=null;oldIndex=null;heldOutput=null;globalThis.gc();const afterGCReleasedViews=process.memoryUsage();
const indexStart=performance.now();model.seriesData(target);const indexRebuildMs=performance.now()-indexStart;
const result={schema:'aster.indicator-params-cost.v1',node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,count,capacity:store.capacity,warmup:{bars:4096,updates:12},operation:'one EMA20 to EMA50; one RSI14 control; source and UI bindings preserved',elapsedMs,indexRebuildMs,cpuMicroseconds:cpu,receipt,sourceHash,outputHash:hash([values]),oldTargetBytes,additionalOutputBytes,before,afterNoGC,afterGCWithHeldViews,afterGCReleasedViews,checks:{sourceUnchanged:true,heldOldOutputUnchanged:true,independentEMAExact:true,unrelatedEntryAndIndexIdentical:true,dependentIndexCleared:true},scope:'Warmed Node synchronous update only. additionalOutputBytes is exact new output allocation; old/new coexist during staging. Samples are not a whole-process peak or browser/native responsiveness measurement.',sourceSHA:Object.fromEntries(['src/core/study-setup.mjs','src/core/api.mjs','src/core/indicators.mjs','src/core/model.mjs','benchmarks/indicator-params.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');model.dispose();console.log(JSON.stringify({count,elapsedMs,additionalOutputBytes,checks:result.checks}));
