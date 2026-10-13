// Serial Node-only scene construction; no browser, raster or presentation timing.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,platform,arch,release} from 'node:os';

const root=resolve(process.argv[2]??'.'),output=resolve(process.argv[3]??'benchmarks/results/scene-query.json');
const {BarStore,ChartModel,seededColumns,buildScene}=await import(pathToFileURL(resolve(root,'src/core/index.mjs')));
const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=values=>new Uint8Array(values.buffer,values.byteOffset,values.byteLength);
const summary=values=>{const ordered=values.toSorted((a,b)=>a-b);return {count:ordered.length,p50Ms:ordered[Math.floor(ordered.length*.5)],p95Ms:ordered[Math.floor(ordered.length*.95)],meanMs:values.reduce((a,b)=>a+b,0)/values.length};};
const cases=[];
for(const bars of [100000,1000000])for(const series of [1,8])for(const range of ['full','recent'])cases.push({id:`histogram-${bars}-${series}-${range}`,bars,series,range,type:'histogram'});
cases.push({id:'line-control-100000-8-full',bars:100000,series:8,range:'full',type:'line'},
 {id:'volume-control-100000-1-full',bars:100000,series:1,range:'full',type:'volume'},
 {id:'macd-100000-1-full',bars:100000,series:1,range:'full',type:'macd'});
const selected=process.argv[4]?cases.filter(c=>c.id===process.argv[4]):cases;assert(selected.length,'Known scene case');
const conditions={seed:42,width:1200,height:700,warmup:40,samples:80,externalGap:'first30 and index%10007===0 are NaN; otherwise close-100+series/8',cases:selected};
const source={};for(const file of ['src/core/scene.mjs','src/core/model.mjs','src/core/block-index.mjs','src/core/data.mjs'])source[file]=hash(await readFile(resolve(root,file)));
const results=[];
for(const condition of selected){
 const store=new BarStore();store.setColumns(seededColumns(condition.bars,42));
 const model=new ChartModel({store}),arrays=[];
 for(let series=0;series<condition.series;series++){
  if(condition.type==='volume')model.addSeries({id:'volume',type:'histogram',panel:'price',source:'volume',color:'#123456'});
  else if(condition.type==='macd'){model.indicators.add('macd','macd');model.addSeries({id:'macd',type:'histogram',panel:'price',indicator:'macd',output:'histogram',color:'#123456'});}
  else {const values=Float64Array.from(store.columns.close.subarray(0,store.length),(value,index)=>index<30||index%10007===0?NaN:value-100+series/8);arrays.push(values);model.addSeries({id:'series'+series,type:condition.type,panel:'price',values,color:'#123456'});}
 }
 if(condition.range==='full')model.fit();else model.setVisibleRange(store.length-201,store.length-.5);
 const sourceDigest=()=>hash(Buffer.concat([...Object.values(store.columns).map(a=>Buffer.from(bytes(a))),...arrays.map(a=>Buffer.from(bytes(a)))]));
 const before=sourceDigest();
 let scene=buildScene(model,conditions.width,conditions.height),queries=0;
 const indices=[...new Set(model.series.map(s=>model.seriesData(s).index))],saved=indices.map(index=>[index,index.query]);
 for(const [index,query] of saved)index.query=function(...args){queries++;return query.apply(this,args);};
 buildScene(model,conditions.width,conditions.height);
 for(const [index,query] of saved)index.query=query;
 for(let i=0;i<conditions.warmup;i++)scene=buildScene(model,conditions.width,conditions.height);
 globalThis.gc?.();
 const rawMs=[];
 for(let i=0;i<conditions.samples;i++){const start=performance.now();scene=buildScene(model,conditions.width,conditions.height);rawMs.push(performance.now()-start);}
 assert.equal(sourceDigest(),before,'Scene construction preserves all source Float64 bytes');
 const sceneSHA256=hash(JSON.stringify({commands:scene.commands,stats:scene.stats,layout:scene.layout}));
 model.dispose();assert.equal(store.listeners.size,0,'No retained store subscription');
 results.push({condition,fixtureSHA256:before,sceneSHA256,indexQueryCallsPerScene:queries,rawMs,...summary(rawMs),cleanup:'model disposed; store listeners zero'});
}
const report={timestamp:new Date().toISOString(),root,environment:{node:process.version,platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model},scope:'Warm indexed buildScene synchronous CPU only; setup/parity/hash/GC/instrumentation outside timing; not browser/native/FPS/memory-savings evidence',conditions,source,harnessSHA256:hash(await readFile(new URL(import.meta.url))),results};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);
