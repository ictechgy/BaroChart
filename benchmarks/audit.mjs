import {performance} from 'node:perf_hooks';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
// Run the exact same harness against a frozen source tree and the changed tree.
const root=resolve(process.argv[2]??'.'),output=process.argv[3]??'benchmarks/results/audit-before.json';
const A=await import(pathToFileURL(resolve(root,'src/index.mjs')).href);
const version=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version;
const stats=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],p99:a[Math.floor((a.length-1)*.99)]};};
const rows=[];
for(const n of [100000,1000000]) {
 const data=A.seededColumns(n,42);let store=new A.BarStore(),times=[];
 for(let i=0;i<10;i++){global.gc?.();const start=performance.now();store.setColumns(data);if(i>=3)times.push(performance.now()-start);}
 rows.push({mode:'column-load',storedBars:n,warmup:3,samples:7,ms:stats(times),storeBytes:store.bytes});
 const model=new A.ChartModel({store}),api=new A.ChartAPI(model);api.addSeries({id:'l',type:'line',panel:'price'});A.buildScene(model,1200,700);
 let rebuilds=0;times=[];
 for(let i=0;i<70;i++){global.gc?.();const before=model.series[0].rangeIndex,start=performance.now();api.setSeries('l',{color:i%2?'#aa91f7':'#f0b755',width:i%2?1.5:2});A.buildScene(model,1200,700);const elapsed=performance.now()-start;if(before!==model.series[0].rangeIndex)rebuilds++;if(i>=10)times.push(elapsed);}
 rows.push({mode:'style-only-and-scene',storedBars:n,warmup:10,samples:60,ms:stats(times),dataIndexRebuilds:rebuilds});
 model.indicators.add('e','ema');model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});A.buildScene(model,1200,700);const last=store.at(n-1);times=[];
 for(let i=0;i<150;i++){const start=performance.now();store.update(n-1,{...last,close:i%2?last.high:last.close});A.buildScene(model,1200,700);if(i>=30)times.push(performance.now()-start);}
 rows.push({mode:'current-update-ema-and-scene',storedBars:n,warmup:30,samples:120,ms:stats(times)});
 model.dispose();store=null;global.gc?.();
}
const result={version,node:process.version,cpu:os.cpus()[0].model,platform:process.platform,arch:process.arch,seed:42,width:1200,height:700,timestamp:new Date().toISOString(),method:'Same Node process settings and seed; separate source roots. Column loads 3 warm/7 samples; style 10 warm/60 samples with explicit GC before each sample (GC excluded); stream 30 warm/120 samples. CPU only; no raster, bridge or display FPS. One run is not a confidence interval.',rows};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result.rows));
