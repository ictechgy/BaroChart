import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {resampleOHLCV,alignConfirmedByTime,SessionCalendar} from '../src/core/index.mjs';
const n=Number(process.argv[2]??100000),run=Number(process.argv[3]??0);
if(![100000,1000000].includes(n))throw new RangeError('Benchmark rows: 100000 or 1000000');
const start=Date.parse('2020-01-01T00:00Z'),step=60000;
function fixture(length){const columns=Object.fromEntries(['time','open','high','low','close','volume'].map(k=>[k,new Float64Array(length)]));for(let i=0;i<length;i++){const price=100+(i%1000)/8;columns.time[i]=start+i*step;columns.open[i]=price;columns.high[i]=price+2;columns.low[i]=price-2;columns.close[i]=price+.25;columns.volume[i]=(i%17)/4;}return columns;}
function opts(length){return {sourceIntervalMs:step,targetIntervalMs:5*step,calendar:new SessionCalendar('UTC',()=>[{open:'00:00',close:'00:00'}]),kinds:['regular'],asOf:start+length*step,partialTarget:'include-unconfirmed'};}
const warm=resampleOHLCV({columns:fixture(5000),length:5000},opts(5000));alignConfirmedByTime(warm.endTime,warm.columns.close,warm);
const columns=fixture(n),options=opts(n),decisions=Float64Array.from(columns.time,t=>t+step);
const inputDigest=createHash('sha256');for(const array of Object.values(columns))inputDigest.update(new Uint8Array(array.buffer));
const before=process.memoryUsage(),t0=performance.now(),result=resampleOHLCV({columns,length:n},options),t1=performance.now(),afterResample=process.memoryUsage(),alignStart=performance.now(),aligned=alignConfirmedByTime(decisions,result.columns.close,result),t2=performance.now(),afterAlign=process.memoryUsage();
assert.equal(result.length,n/5);
for(let j=0;j<result.length;j++){const a=j*5,b=a+5;let high=-Infinity,low=Infinity,volume=0;for(let i=a;i<b;i++){high=Math.max(high,columns.high[i]);low=Math.min(low,columns.low[i]);volume+=columns.volume[i];}for(const [key,expected] of Object.entries({time:columns.time[a],open:columns.open[a],high,low,close:columns.close[b-1],volume}))assert.ok(Object.is(result.columns[key][j],expected),`${key} ${j}`);assert.equal(result.endTime[j],start+b*step);assert.equal(result.availableAt[j],start+b*step);assert.equal(result.sourceFrom[j],a);assert.equal(result.sourceTo[j],b);assert.equal(result.complete[j],1);assert.equal(result.confirmed[j],1);}
for(let i=0;i<n;i++){const j=Math.floor((i+1)/5)-1,expected=j<0?NaN:columns.close[j*5+4];assert.ok(Object.is(aligned[i],expected),`aligned ${i}`);}
assert.equal(options.calendar.cache.size,0);
const hashes={};for(const path of ['src/core/resample.mjs','src/core/markets.mjs','src/core/data.mjs','src/core/contracts.mjs','benchmarks/resampling.mjs'])hashes[path]=createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex');
const resultTypedBytes=Object.values(result.columns).reduce((n,a)=>n+a.byteLength,0)+['endTime','availableAt','sourceFrom','sourceTo','complete','confirmed'].reduce((n,k)=>n+result[k].byteLength,0);
console.log(JSON.stringify({schema:1,scope:'warmed synchronous Node CPU; UTC 24-hour synthetic calendar; no renderer/native device',node:process.version,platform:process.platform,arch:process.arch,run,rows:n,targets:result.length,sourceIntervalMs:step,targetIntervalMs:5*step,resampleMs:t1-t0,alignMs:t2-alignStart,sourceTypedBytes:n*48,resultTypedBytes,alignedTypedBytes:aligned.byteLength,conservativeResampleNewTypedCeilingBytes:n*122,memorySnapshots:{before,afterResample,afterAlign},memoryNote:'process snapshots are not peaks; GC and unrelated retained warmup arrays affect differences',sourceDigest:inputDigest.digest('hex'),oracle:'all OHLCV fields, bounds, flags, availability and every aligned value exact; original calendar cache unchanged',hashes}));
