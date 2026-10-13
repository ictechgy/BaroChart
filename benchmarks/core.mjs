import {performance} from 'node:perf_hooks';import {writeFile,mkdir,readFile} from 'node:fs/promises';import os from 'node:os';
const sourceVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
import {BarStore,seededColumns,IndicatorEngine,ChartModel,buildScene,builtinIndicators} from '../src/core/index.mjs';
const percentile=a=>{const s=[...a].sort((a,b)=>a-b);return {p50:s[Math.floor((s.length-1)*.5)],p95:s[Math.floor((s.length-1)*.95)],p99:s[Math.floor((s.length-1)*.99)]};};
const measure=fn=>{const t=performance.now();const value=fn();return {value,ms:performance.now()-t};};
const results=[];
for(const n of [10000,100000,1000000]){
  global.gc?.();const memoryBefore=process.memoryUsage(),gen=measure(()=>seededColumns(n,42)),store=new BarStore();const load=measure(()=>store.setColumns(gen.value));global.gc?.();const memoryStore=process.memoryUsage();
  const pure=measure(()=>{const inst=builtinIndicators.get('ema')({period:20}).create(),c=store.columns,b={};let last;for(let i=0;i<n;i++){for(const k of ['time','open','high','low','close','volume'])b[k]=c[k][i];last=inst.step(b,i)[0];}return last;});
  const engine=new IndicatorEngine(store),batch=measure(()=>engine.add('ema','ema'));
  const model=new ChartModel({store});model.addSeries({id:'p',type:'candles',panel:'price'});model.indicators.add('ema','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'ema',color:'#f0b755'});
  buildScene(model,1200,700);const recent=[];for(let i=0;i<135;i++){const r=measure(()=>{model.setVisibleRange(n-220.5+i%20,n-20.5+i%20);return buildScene(model,1200,700);});if(i>=15)recent.push(r.ms);}
  model.fit();buildScene(model,1200,700);const lod=[];let stats;for(let i=0;i<135;i++){const r=measure(()=>buildScene(model,1200,700));stats=r.value.stats;if(i>=15)lod.push(r.ms);}
  model.setVisibleRange(n-200.5,n-.5);const stream=[];for(let i=0;i<135;i++){const b=store.at(n-1);const r=measure(()=>{store.update(n-1,{...b,close:i%2?b.high:b.low});engine.get('ema');return buildScene(model,1200,700);});if(i>=15)stream.push(r.ms);}
  global.gc?.();const memoryWithIndicators=process.memoryUsage();
  results.push({storedBars:n,seed:42,generationMs:gen.ms,validatedCopiedStoreAndIndexMs:load.ms,pureEmaStepLoopMs:pure.ms,emaWithOutputAndCheckpointsMs:batch.ms,recentVisibleBars:201,recentSceneMs:percentile(recent),fullViewSceneMs:percentile(lod),fullViewStats:stats,currentReplaceEmaAndSceneMs:percentile(stream),allocatedStoreTypedArrayBytes:store.bytes,memoryBefore,memoryStore,memoryWithIndicators,samples:120});model.dispose();engine.dispose();
}
const doc={sourceVersion,timestamp:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,cpuCount:os.cpus().length,totalMemoryBytes:os.totalmem(),method:'Single process; deterministic seed 42; 15 warmup + 120 samples. CPU scene construction only; no raster/display FPS. Memory is process-wide and includes retained generator arrays, two EMA engines and scene caches.',results};
await mkdir('benchmarks/results',{recursive:true});await writeFile('benchmarks/results/core.json',JSON.stringify(doc,null,2));console.log(JSON.stringify(doc,null,2));
