import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {cpus,release} from 'node:os';
import {startFixtureServer} from '../benchmarks/browser-soak.mjs';
import {browserIngestionOptions,browserIngestionRuntime} from '../benchmarks/browser-ingestion.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),delay=ms=>new Promise(r=>setTimeout(r,ms));
const arg=(name,fallback)=>{const key='--'+name,i=process.argv.indexOf(key),v=process.argv.find(x=>x.startsWith(key+'='));return v?v.slice(key.length+1):i<0?fallback:process.argv[i+1];};
async function manifest(root){const files={};async function walk(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())files[relative(root,p)]=hash(await readFile(p));}}await walk(join(root,'src'));for(const p of ['package.json','native/Resources/aster-core.js'])files[p]=hash(await readFile(join(root,p)));return {files,sha256:hash(JSON.stringify(files))};}
async function harnessManifest(){const files={};for(const rel of ['../benchmarks/ingestion.mjs','../benchmarks/browser-ingestion.mjs','../benchmarks/browser-soak.mjs','../scripts/cdp.mjs','./cycle12-ingestion-browser.mjs','../scripts/browser-ingestion-evidence-contract.mjs'])files[rel]=hash(await readFile(new URL(rel,import.meta.url)));return files;}
async function ownedMemory(browser){const [heap,info]=await Promise.allSettled([browser.send('Runtime.getHeapUsage'),browser.send('SystemInfo.getProcessInfo',{},null)]);const processes=info.status==='fulfilled'?info.value.processInfo.map(p=>({pid:Number(p.id),type:p.type,cpuTimeSeconds:p.cpuTime})).filter(p=>Number.isSafeInteger(p.pid)&&p.pid>0):[];let rss=null,rssError=null;if(processes.length)try{const text=execFileSync('ps',['-o','pid=,rss=','-p',processes.map(p=>p.pid).join(',')],{encoding:'utf8'}),rows=text.trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));rss=rows.filter(r=>r.length===2&&r.every(Number.isFinite)).map(([pid,rssKiB])=>({pid,rssBytes:rssKiB*1024,type:processes.find(p=>p.pid===pid)?.type}));}catch(e){rssError=e.message;}return {heap:heap.status==='fulfilled'?heap.value:null,ownedChromeProcessRSS:rss,ownedChromeRSSBytes:rss?.reduce((n,r)=>n+r.rssBytes,0)??null,processes,rssError,scope:'Main-target V8 heap/backing plus separately read owned Chrome process RSS endpoints. Worker heaps/GPU VRAM and between-sample peaks are not isolated; CPU time includes browser/protocol/sampling activity.'};}
function trend(samples,key){const rows=samples.filter(s=>Number.isFinite(s.elapsedSeconds)&&Number.isFinite(s[key]));if(rows.length<2)return null;const x=rows.reduce((n,r)=>n+r.elapsedSeconds,0)/rows.length,y=rows.reduce((n,r)=>n+r[key],0)/rows.length,num=rows.reduce((n,r)=>n+(r.elapsedSeconds-x)*(r[key]-y),0),den=rows.reduce((n,r)=>n+(r.elapsedSeconds-x)**2,0);return den?num/den:0;}
export {ingestionBrowserEvidenceVerdict as ingestionBrowserVerdict} from '../scripts/browser-ingestion-evidence-contract.mjs';
import {ingestionBrowserEvidenceVerdict as ingestionBrowserVerdict,browserIngestionExecution,sealBrowserIngestionEvidence} from '../scripts/browser-ingestion-evidence-contract.mjs';

export async function runIngestionBrowser({sourceRoot='.',output='/tmp/aster-cycle12-profile/browser-verify',conditions:input={},expectedSourceSHA=null}={}){
 const timestamp=new Date().toISOString(),runId=randomUUID(),reportPath=join(output,'report.json');
 // Reserve a fresh certificate before fallible source/server/browser startup.
 // Exclusive creation preserves previous evidence and prevents concurrent reuse.
 await mkdir(output,{recursive:true});
 const report={schema:'aster.cycle12.browser-ingestion',timestamp,attempt:{runId},status:'pending',verdict:{status:'pending',errors:[],qualifying900Seconds:false}};
 try{await writeFile(reportPath,JSON.stringify(report,null,2),{flag:'wx'});}
 catch(error){if(error?.code==='EEXIST')throw new Error('Refusing existing ingestion report '+reportPath+'; choose a new output directory',{cause:error});throw error;}
 let browser,server,stopping=false,inputJob,inputFailure,mainError,hasError=false;
 const describe=error=>{try{return {name:error?.name??'Error',message:error?.message??String(error),...(typeof error?.stack==='string'?{stack:error.stack}:{})};}catch{return {name:'Error',message:'Error details unavailable'};}};
 const protocol={externalRequests:[],exceptions:[],crashes:[]},samples=[];
 try{
  const root=await realpath(resolve(sourceRoot)),conditions=browserIngestionOptions(input),source=await manifest(root),harness=await harnessManifest(),measured=!conditions.verifyOnly;
  if(measured)assert.equal(source.sha256,expectedSourceSHA,'Frozen source SHA required before browser measurements');
  const execution=browserIngestionExecution({timestamp,source,harness,conditions},runId);
  Object.assign(report,{execution,sourceRoot:root,source,harness,conditions,measurementRan:measured,environment:{node:process.version,platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0]?.model},protocol,samples});
  const fixtureSource=await readFile(new URL('../benchmarks/ingestion.mjs',import.meta.url),'utf8');
  const runtime=fixtureSource+'\n;('+browserIngestionRuntime.toString()+')('+JSON.stringify(conditions)+').then(()=>{const controls=globalThis.__asterIngestion,stop=controls.stop;controls.stop=async()=>({...await stop.call(controls),execution:'+JSON.stringify(execution)+'});}).catch(e=>{globalThis.__asterIngestionFailure={name:e.name,message:e.message,stack:e.stack}});';
  server=await startFixtureServer(root,runtime);
  browser=await launchBrowser({width:1280,height:1540,dpr:conditions.dpr});await browser.send('Network.enable');browser.on('Runtime.exceptionThrown',p=>protocol.exceptions.push(p.exceptionDetails));browser.on('Inspector.targetCrashed',p=>protocol.crashes.push(p));browser.on('Network.requestWillBeSent',p=>{if(/^https?:/.test(p.request.url)&&!p.request.url.startsWith(server.origin+'/'))protocol.externalRequests.push(p.request.url);});await browser.navigate(server.origin+'/harness.html');
  let ready=false;for(let i=0;i<300;i++){const state=await browser.evaluate('({ready:!!globalThis.__asterIngestion?.ready,failure:globalThis.__asterIngestionFailure??null})');if(state.failure)throw new Error(JSON.stringify(state.failure));if(state.ready){ready=true;break;}await delay(20);}assert.ok(ready,'Fixture startup timeout');
  report.environment.browser=await browser.evaluate('navigator.userAgent');report.startMemory=measured?await ownedMemory(browser):{collected:false};const rects=await browser.evaluate('[...document.querySelectorAll("canvas")].map(c=>{const r=c.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})');assert.equal(rects.length,2);await browser.evaluate('__asterIngestion.start()');
  const actor=async()=>{let n=0;while(!stopping){const r=rects[n%2],x=r.left+60+(n*31)%1000,y=r.top+80+(n*17)%220;await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,buttons:0});if(n%3===0)await browser.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:n%2?20:-20});if(n%6===0){await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+8,y:y+2,buttons:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+8,y:y+2,button:'left',buttons:0,clickCount:1});}n++;if(conditions.verifyOnly&&n>=12)return;await delay(conditions.verifyOnly?20:250);}};
  inputJob=actor().catch(e=>{inputFailure=e;stopping=true;});let done=false,sampleAt=0;const maxPolls=conditions.verifyOnly?1000:Math.ceil((conditions.durationSeconds+120)*1000/50);
  for(let i=0;i<maxPolls;i++){if(inputFailure)throw inputFailure;const s=await browser.evaluate('__asterIngestion.snapshot()');if(s.errors.length)throw new Error(JSON.stringify(s.errors));if(measured&&s.elapsedSeconds>=sampleAt){const m=await ownedMemory(browser);samples.push({elapsedSeconds:s.elapsedSeconds,heapUsedBytes:m.heap?.usedSize??null,backingStorageBytes:m.heap?.backingStorageSize??null,ownedChromeRSSBytes:m.ownedChromeRSSBytes,memory:m,producer:s.producer,queues:s.queues,source:s.source});sampleAt=s.elapsedSeconds+10;}if(s.done){done=true;break;}await delay(50);}assert.ok(done,'Fixture bounded completion timeout');stopping=true;await inputJob;if(inputFailure)throw inputFailure;await delay(40);
  report.final=await browser.evaluate('(async()=>{const r=await __asterIngestion.stop();globalThis.__asterIngestion=null;return r;})()');report.cleanupMemory=measured?await ownedMemory(browser):{collected:false};assert.deepEqual(await manifest(root),source,'Source changed during browser run');const rss=samples.map(s=>s.ownedChromeRSSBytes).filter(Number.isFinite),heap=samples.map(s=>s.heapUsedBytes).filter(Number.isFinite);report.memorySummary=measured?{sampledOwnedRSSPeak:rss.length?Math.max(...rss):null,sampledMainHeapPeak:heap.length?Math.max(...heap):null,ownedRSSSlopeBytesPerSecond:trend(samples,'ownedChromeRSSBytes'),mainHeapSlopeBytesPerSecond:trend(samples,'heapUsedBytes'),scope:'Sampled maxima/endpoints/trends including fixture mirrors, temporary worker and telemetry; not true between-sample peaks or long-term leakage proof'}:{collected:false};
 }catch(error){
  mainError=error;hasError=true;report.failure=describe(error);
  if(browser)try{report.partial=await browser.evaluate('globalThis.__asterIngestion?.snapshot()??globalThis.__asterIngestionFailure??null');}catch{}
 }finally{
  stopping=true;const results=[],cleanupErrors=[];
  // Each resource gets its own failure boundary. One rejected close must not
  // suppress the remaining cleanup or replace the original operation error.
  for(const [resource,cleanup]of [
   ['fixture-stop',async()=>{if(browser)await browser.evaluate('(async()=>{if(globalThis.__asterIngestion){try{await __asterIngestion.stop()}finally{globalThis.__asterIngestion=null}}})()');}],
   ['browser-close',async()=>{await browser?.close();}],
   ['input-stop',async()=>{await inputJob;if(inputFailure)throw inputFailure;}],
   ['server-close',async()=>{await server?.close();}]
  ]){
   try{await cleanup();results.push({resource,status:'fulfilled'});}
   catch(error){cleanupErrors.push(error);results.push({resource,status:'rejected',error:describe(error)});}
  }
  report.runnerCleanup={completed:cleanupErrors.length===0,results};
  if(!hasError&&cleanupErrors.length){hasError=true;mainError=cleanupErrors[0];report.failure=describe(mainError);}
 }
 // A completed positive certificate is published only after all cleanup. Failed
 // startup/work/cleanup stays nonqualifying even if its inner final model passed.
 try{
  if(hasError)throw mainError;
  report.status='pass';sealBrowserIngestionEvidence(report);
  report.verdict=ingestionBrowserVerdict(report);assert.equal(report.verdict.status,'pass',report.verdict.errors.join(';'));
  await writeFile(reportPath,JSON.stringify(report,null,2));return report;
 }catch(error){
  const primary=hasError?mainError:error;report.status='fail';report.failure=describe(primary);
  report.verdict={status:'fail',errors:[report.failure.message,...report.runnerCleanup.results.filter(x=>x.status==='rejected').map(x=>x.resource+': '+x.error.message)],qualifying900Seconds:false,evidenceBinding:null,scope:'Fresh runner failed startup/work/validation/publication or mandatory owned cleanup'};
  try{await writeFile(reportPath,JSON.stringify(report,null,2));}
  catch(writeError){
   report.reportWriteFailure=describe(writeError);
   // Preserve the primary error while making unavailable failure evidence visible
   // to the caller. Primitive/frozen errors keep it as the aggregate cause.
   try{if(!primary||typeof primary!=='object')throw writeError;Object.defineProperty(primary,'reportWriteFailure',{value:report.reportWriteFailure,configurable:true});}
   catch{throw new AggregateError([primary,writeError],'Could not persist failed ingestion report',{cause:primary});}
  }
  throw primary;
 }

}
export async function main(){const verifyOnly=process.argv.includes('--verify-only'),isolated=process.argv.includes('--isolated'),conditions=browserIngestionOptions({verifyOnly,durationSeconds:Number(arg('duration',900)),bars:Number(arg('bars',verifyOnly?512:100000)),lineSeries:Number(arg('lines',32)),strategy:arg('strategy','scalar'),renderer:arg('renderer','canvas'),dpr:Number(arg('dpr',1)),burst:Number(arg('burst',8)),tickMs:Number(arg('tick-ms',100)),drainEveryFrames:Number(arg('drain-every',1)),pressure:process.argv.includes('--pressure'),epochSeconds:Number(arg('epoch-seconds',60)),maxStoredExtra:Number(arg('stored-extra',512)),maxRawSamples:Number(arg('max-raw',131072))});if(!verifyOnly&&!isolated){const root=await realpath(resolve(arg('source','.')));console.log(JSON.stringify({measurementRan:false,browserStarted:false,awaiting:'Explicit root quiet GO',sourceRoot:root,source:await manifest(root),harness:await harnessManifest(),conditions,commonComparison:'Baseline --strategy scalar, candidate --strategy atomic; identical burst8, queryonce, seed and feed scheduling. Queued --pressure is a separate diagnostic.'},null,2));return;}const report=await runIngestionBrowser({sourceRoot:arg('source','.'),output:arg('output','/tmp/aster-cycle12-profile/browser-'+conditions.strategy),conditions,expectedSourceSHA:arg('source-manifest-sha')});console.log(JSON.stringify({verdict:report.verdict,output:arg('output'),measurementRan:report.measurementRan}));}
if(process.argv[1]&&(resolve(process.argv[1])===resolve(import.meta.filename)||await realpath(process.argv[1]).catch(()=>null)===import.meta.filename))await main();
