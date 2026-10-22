// Independent-model core scene CPU only. No renderer submission, browser or GPU.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile,mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {ChartModel,seededColumns,buildScene,FIELDS} from '../src/core/index.mjs';

export function distribution(raw){const a=raw.toSorted((x,y)=>x-y);return {count:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)};}
export function runCase({charts,bars,operation,warmup=5,samples=10}){
 assert(Number.isSafeInteger(charts)&&charts>=1&&charts<=8);assert(Number.isSafeInteger(bars)&&bars>=32&&bars<=80000);assert(['clean','update','append'].includes(operation));assert(Number.isSafeInteger(warmup)&&warmup>=0&&warmup<=20);assert(Number.isSafeInteger(samples)&&samples>=1&&samples<=40);
 const models=[],plans=[],held=[],lastScenes=[],rawMs=[];let sceneCalls=0,events=0;
 try{
  for(let c=0;c<charts;c++){
   const m=new ChartModel();models.push(m);m.store.setColumns(seededColumns(bars,42+c));m.indicators.add('ema','ema',{period:20});m.addSeries({id:'price',type:'candles',panel:'price'});m.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema'});m.setVisibleRange(bars-200.5,bars-.5);buildScene(m,1200,700);
   held.push({columns:m.store.columns,capacity:m.store.capacity,entry:m.indicators.entries.get('ema'),output:m.indicators.get('ema').outputs.value,index:m.seriesData(m.series[1]).index,version:m.store.version,initial:Array.from({length:bars},(_,i)=>m.store.at(i))});
   const last=m.store.at(bars-1);plans.push(Array.from({length:warmup+samples},(_,i)=>{const close=last.close+(i%7-3)/10;return {time:last.time+(operation==='append'?(i+1)*60000:0),open:last.open,high:Math.max(last.high,close),low:Math.min(last.low,close),close,volume:last.volume+(i+1)/100};}));
  }
  for(let i=0;i<warmup+samples;i++){
   const start=performance.now();
   for(let c=0;c<charts;c++){
    const m=models[c];if(operation==='append')m.store.append(plans[c][i]);else if(operation==='update')m.store.update(m.store.length-1,plans[c][i]);
    lastScenes[c]=buildScene(m,1200,700);
   }
   const elapsed=performance.now()-start;if(i>=warmup)rawMs.push(elapsed);
   sceneCalls+=charts;if(operation!=='clean')events+=charts;
  }
  // Full value/EMA and direct range scan checks are deliberately outside timing.
  let checkedValues=0,rangeQueries=0,storeBytes=0,outputBytes=0;const policies=[];
  for(let c=0;c<charts;c++){
   const m=models[c],expected=held[c].initial.slice();assert(lastScenes[c].commands.length>0);const finite=v=>{if(typeof v==='number')assert(Number.isFinite(v));else if(v&&typeof v==='object')for(const x of Object.values(v))finite(x);};finite(lastScenes[c].commands);if(operation==='append')expected.push(...plans[c]);else if(operation==='update')expected[expected.length-1]=plans[c].at(-1);
   assert.equal(m.store.length,expected.length);if(expected.length<=held[c].capacity)assert.equal(m.store.columns,held[c].columns);assert.equal(m.store.version,held[c].version+(operation==='clean'?0:warmup+samples));
   for(let i=0;i<expected.length;i++)for(const f of FIELDS){assert(Object.is(m.store.columns[f][i],expected[i][f]));checkedValues++;}
   const fresh=new ChartModel();try{fresh.store.setData(expected);fresh.indicators.add('ema','ema',{period:20});fresh.addSeries({id:'price',type:'candles',panel:'price'});fresh.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema'});fresh.setVisibleRange(m.view.from,m.view.to);assert.deepEqual(lastScenes[c].commands,buildScene(fresh,1200,700).commands);const oracle=fresh.indicators.get('ema').outputs.value,actual=m.seriesData(m.series[1]);if(operation==='clean'){assert.equal(m.indicators.entries.get('ema'),held[c].entry);const current=m.indicators.get('ema').outputs.value;assert.equal(current.buffer,held[c].output.buffer);assert.equal(current.byteOffset,held[c].output.byteOffset);assert.equal(current.length,held[c].output.length);assert.equal(actual.index,held[c].index);}policies.push({capacity:m.store.capacity,index:actual.index.constructor.name,initialCapacity:held[c].capacity});assert.equal(actual.values.length,oracle.length);
    for(let i=0;i<oracle.length;i++){assert(Object.is(actual.values[i],oracle[i]));checkedValues++;}
    for(const [a,b] of [[0,Math.min(32,oracle.length)],[Math.max(0,oracle.length-201),oracle.length],[Math.max(0,oracle.length-33),oracle.length]]){let min=Infinity,max=-Infinity,count=0;for(let i=a;i<b;i++)if(Number.isFinite(oracle[i])){min=Math.min(min,oracle[i]);max=Math.max(max,oracle[i]);count++;}assert.deepEqual(actual.index.query(a,b),{min,max,sum:0});assert.equal(actual.index.finiteCount(a,b),count);rangeQueries++;}
    storeBytes+=m.store.bytes;outputBytes+=actual.values.byteLength;
   }finally{fresh.dispose();assert.equal(fresh.store.listeners.size,0);}
  }
  return {charts,barsPerChart:bars,initialTotalBars:charts*bars,operation,warmup,samples,sceneCalls,events,rawMs,groupMs:distribution(rawMs),averagePerChartEquivalentMs:distribution(rawMs.map(x=>x/charts)),policies,correctness:{checkedValues,rangeQueries,sourceIdentityWhenCapacityUnchanged:true,scope:'Full OHLCV and fresh implementation EMA; direct scalar extrema/count oracle, not independent EMA formula'},resources:{storeBytes,emaLogicalViewBytes:outputBytes,scope:'Selected accounting only; excludes JS heap, indexes, checkpoints, transient peaks, GPU and process memory'},cleanup:'Every model disposed; public store listener count zero'};
 }catch(error){error.partial={charts,bars,operation,warmup,samples,rawMs,sceneCalls,events};throw error;}finally{for(const m of models){m.dispose();assert.equal(m.store.listeners.size,0);}}
}
export async function runPilot(output){
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const snapshot=async()=>{const source={};for(const file of (await readdir(new URL('../src/',import.meta.url),{recursive:true})).filter(x=>x.endsWith('.mjs')).sort())source['src/'+file]=hash(await readFile(new URL('../src/'+file,import.meta.url)));source['benchmarks/multi-chart-cpu.mjs']=hash(await readFile(new URL(import.meta.url)));return source;};
 const source=await snapshot();
 const cases=[];for(const mode of ['fixed-total','fixed-per-chart'])for(const charts of [1,4,8])for(const operation of ['clean','update','append'])cases.push({mode,charts,bars:mode==='fixed-total'?80000/charts:10000,operation});
 const runs=[];await mkdir(dirname(output),{recursive:true});for(let repeat=0;repeat<3;repeat++)for(const c of repeat%2?[...cases].reverse():cases){try{runs.push({repeat,mode:c.mode,status:'pass',...runCase(c)});}catch(error){runs.push({repeat,mode:c.mode,status:'failed',condition:c,error:String(error.message),partial:error.partial});await writeFile(output,JSON.stringify({status:'failed',runs},null,2)+'\n');throw error;}await writeFile(output,JSON.stringify({status:'running',runs},null,2)+'\n');}
 assert.deepEqual(await snapshot(),source,'Source and harness hashes match before and after pilot');
 const report={timestamp:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model},scope:'Serial independent ChartModel buildScene CPU. No Canvas/WebGL submission, browser/FPS, heap leak or competitor claims. Fixed-total equalizes initial bars, not event/scene count; fixed-per-chart grows total data and operations. One bounded pilot; all repetitions retained. Per-chart equivalents divide group elapsed by chart count, not individual latency samples. Index policy and capacity can differ between workloads.',conditions:{width:1200,height:700,visibleBars:200,seed:'42+chartIndex',series:'candles+EMA20',order:'forward/reverse/forward',gc:'No forced GC; pauses retained'},source,harnessSHA256:hash(await readFile(new URL(import.meta.url))),runs};await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert(process.argv[2],'Explicit output path required');await runPilot(resolve(process.argv[2]));console.log('Multi-chart CPU pilot complete');}
