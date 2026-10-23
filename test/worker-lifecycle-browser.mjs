import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser} from '../scripts/cdp.mjs';
// Actual browser Workers; delayed acknowledgements model a host adapter whose
// termination Promise settles after the native Worker has already stopped.
const root=fileURLToPath(new URL('..',import.meta.url)),prefix=resolve(root,'src')+'/';
const output=resolve(process.argv[2]??resolve(root,'artifacts/worker-lifecycle-browser.json'));
const bad={'/bad-empty.mjs':"self.postMessage({error:''});",'/bad-null.mjs':'self.postMessage(null);','/bad-unknown.mjs':'self.postMessage({unexpected:true});'};
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(path==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Worker regression smoke</title>');return;}
 if(Object.hasOwn(bad,path)){res.writeHead(200,{'content-type':'text/javascript'});res.end(bad[path]);return;}
 const file=resolve(root,'.'+decodeURIComponent(path));
 if(!file.startsWith(prefix)||!file.endsWith('.mjs')){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await launchBrowser({timeoutMs:30000});
 await browser.navigate('http://127.0.0.1:'+server.address().port+'/',{timeout:10000});
 const result=await browser.evaluate(`(async()=>{
  const {prepareChartModel,runChartWorker,resampleOHLCVAsync}=await import('/src/web/worker.mjs');
  const {BarStore,SessionCalendar}=await import('/src/core/index.mjs');
  const {calculationJobStats}=await import('/src/web/calculation-job.mjs');
  const check=(value,label)=>{if(!value)throw Error(label);};
  const time=Date.parse('2026-04-01T09:00:00Z');
  const bars=Array.from({length:4},(_,i)=>({time:time+i*60000,open:10+i,high:12+i,low:9+i,close:11+i,volume:10}));
  const prepared=await prepareChartModel({bars,options:{series:[{id:'price',panel:'price',type:'candles'}]}},{timeoutMs:5000});
  check(prepared.store.length===4,'real prepare worker');prepared.dispose();
  const rejected=[];
  for(const path of ['/bad-empty.mjs','/bad-null.mjs','/bad-unknown.mjs']){
   let error;try{await runChartWorker({}, {timeoutMs:5000,workerURL:new URL(path,location.href)});}catch(e){error=e;}
   check(error instanceof TypeError,'malformed worker reply must reject TypeError');rejected.push(error.name);
  }
  const source={kind:'store',store:new BarStore(bars)};
  const options={sourceIntervalMs:60000,targetIntervalMs:120000,asOf:time+300000,partialTarget:'reject',kinds:['regular'],calendar:new SessionCalendar('UTC',()=>[{open:'09:00',close:'10:00'}]),timeoutMs:5000};
  const ordinary=await resampleOHLCVAsync(source,options);check(ordinary.length===2,'real resample worker');
  const acknowledgements=[];let terminations=0;
  const factory=url=>{
   const worker=new Worker(url,{type:'module'});
   return {get onmessage(){return worker.onmessage;},set onmessage(v){worker.onmessage=v;},get onerror(){return worker.onerror;},set onerror(v){worker.onerror=v;},postMessage(...args){worker.postMessage(...args);},terminate(){worker.terminate();terminations++;return new Promise(resolve=>acknowledgements.push(resolve));}};
  };
  const outcomes=await Promise.all([0,1].map(()=>resampleOHLCVAsync(source,{...options,timeoutMs:500,workerFactory:factory}).then(()=>null,e=>e.name)));
  check(outcomes.every(x=>x==='TimeoutError'),'deadline settles pending termination callers');
  const held=calculationJobStats();check(held.activeJobs===2&&held.reservedBytes>0&&terminations===2,'reservations held until acknowledgements');
  acknowledgements.forEach(resolve=>resolve());
  for(let i=0;i<20&&calculationJobStats().activeJobs;i++)await new Promise(resolve=>setTimeout(resolve,0));
  check(calculationJobStats().activeJobs===0&&calculationJobStats().reservedBytes===0,'late acknowledgement releases budget');
  const recovered=await resampleOHLCVAsync(source,options);check(recovered.length===2,'new real Worker succeeds after recovery');
  return {prepareBars:4,malformedReplies:rejected,resampledBars:ordinary.length,pendingTerminationOutcomes:outcomes,heldJobs:held.activeJobs,recoveredJobs:calculationJobStats().activeJobs,browser:navigator.userAgent};
 })()`,{timeout:15000,label:'worker-regression-smoke'});
 assert.equal(result.recoveredJobs,0);
 result.scope='Actual headless browser module Workers and a host-adapter acknowledgement delay; no OS OOM or physical device test.';
 await mkdir(dirname(output),{recursive:true});
 await writeFile(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
