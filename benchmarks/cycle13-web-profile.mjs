import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {cpus,release} from 'node:os';

// Attribution diagnostics only. The completed Cycle12 source/harness/raw are inputs,
// never edited. Each run owns one fresh Chrome and loopback server.
const sha=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function webProfileOptions(input={}) {
  const options={mode:'normal',durationSeconds:60,workerProbes:4,pollMs:50,heapSamplingBytes:32768,cpuSamplingUs:1000,...input};
  if(!['normal','light','diagnostic'].includes(options.mode))throw new TypeError('Diagnostic mode');
  for(const [key,min,max] of [['durationSeconds',30,60],['workerProbes',1,4],['pollMs',50,50],['heapSamplingBytes',32768,32768],['cpuSamplingUs',1000,1000]])
    if(!Number.isInteger(options[key])||options[key]<min||options[key]>max)throw new RangeError(key);
  return options;
}
export function compactSnapshot(snapshot) {
  const {transitions,...rest}=snapshot;
  if(!Array.isArray(transitions))throw new TypeError('Transition array');
  return {...rest,transitionCount:transitions.length};
}
export function snapshotExpression(mode) {
  if(!['normal','light','diagnostic'].includes(mode))throw new TypeError('Diagnostic mode');
  return mode==='normal'?'__asterIngestion.snapshot()':`(${compactSnapshot.toString()})(__asterIngestion.snapshot())`;
}
function diagnosticAccess() {
  // This block runs inside the original fixture's closure. It adds read-only owner
  // accounting and an explicitly post-feed call to the original leaseProbe.
  const ids=new WeakMap();let serial=0;
  const id=x=>{if(!ids.has(x))ids.set(x,++serial);return ids.get(x);};
  const array=a=>a?{bufferId:id(a.buffer),viewBytes:a.byteLength,bufferBytes:a.buffer.byteLength,length:a.length}:null;
  function ownership() {
    const buffers=new Map();
    const own=a=>{if(a)buffers.set(id(a.buffer),a.buffer.byteLength);return array(a);};
    const tree=t=>t?{identity:id(t),size:t.size,min:own(t.min),max:own(t.max),sum:own(t.sum)}:null;
    const models=fixture.owners.map(o=>({symbol:o.symbol.id,length:o.store.length,capacity:o.store.capacity,version:o.store.version,view:{...o.model.view},
      source:Object.fromEntries(Object.entries(o.store.columns).map(([k,a])=>[k,own(a)])),sourceIndex:tree(o.store.index),
      outputs:[...o.model.indicators.entries].map(([name,e])=>({name,revision:e.revision,dirty:e.dirty,arrays:e.arrays.map(own),checkpoints:e.checkpoints.size})),
      series:o.model.series.map(s=>({id:s.id,source:s.source??null,indicator:s.indicator??null,index:s.rangeIndex?{identity:id(s.rangeIndex),length:s.rangeIndex.length,size:s.rangeIndex.size,blockSize:s.rangeIndex.blockSize??null,values:array(s.rangeIndex.values),tree:tree(s.rangeIndex.tree??s.rangeIndex)}:null})),
      ring:Object.values(o.model.dataIngestion?.columns??{}).map(own),kind:own(o.model.dataIngestion?.kinds),
      fixtureRows:{original:o.original.length,reference:o.reference.length},modelDisposed:o.model.disposed}));
    return {models,uniqueTypedBufferBytes:[...buffers.values()].reduce((a,b)=>a+b,0),uniqueTypedBufferCount:buffers.size,
      traceRows:{heartbeat:heartbeatRaw.length,packets:packetSamples.length,input:events.length,renders:fixture.owners.map(o=>o.browser.renderCPU.length),transitions:transitions.length,epochs:epochs.length},
      charts:charts.map(c=>({disposed:c.disposed,timingRows:c.timings.length,sceneBaseCommands:c.sceneCache?.base?.commands.length??0,latestCommands:c.lastScene?.commands.length??0,cachedPixelBytes:c.layerSurfaces?.bytes??0,mainPixelBytes:c.canvas.width*c.canvas.height*4})),
      workers:{created:createdWorkers,terminated:terminatedWorkers,live:workers.size},
      scope:'Unique known source/tree/output/series-index/ring ArrayBuffers and chart pixel accounting. Views share buffer IDs. Pixel bytes and object counts are not process RSS or live JavaScript bytes. Disposed borrowed stores remain reachable until controls are released.'};
  }
  Object.defineProperty(controls,'diagnostic',{value:{ownership,
    async workers(count) {
      if(!finished||stopped)throw new Error('Worker diagnostic requires finished primary feed');
      const preparation=queueStats();for(const o of fixture.owners)if(ingestionLedger(o.api).state==='paused')o.api.resumeDataIngestion();
      drainAll(true);const before=ownership(),versions=fixture.owners.map(o=>o.store.version),rows=[],copies=[];
      const prototype=globalThis.Worker.prototype,descriptor=Object.getOwnPropertyDescriptor(prototype,'postMessage'),original=prototype.postMessage;
      prototype.postMessage=function(request,...rest){
        const buffers=new Set(),views=Object.values(request.columns??{});for(const a of views)if(ArrayBuffer.isView(a))buffers.add(a.buffer);
        const t0=performance.now();try{return original.call(this,request,...rest);}finally{copies.push({startedAt:t0,finishedAt:performance.now(),columnViews:views.length,columnViewBytes:views.reduce((n,a)=>n+(a?.byteLength??0),0),columnUnderlyingBufferBytes:[...buffers].reduce((n,a)=>n+a.byteLength,0),transferredBuffers:rest[0]?.length??rest[0]?.transfer?.length??0});}
      };
      try{for(let i=0;i<count;i++){
        const oldCount=transitions.length,t0=performance.now();await leaseProbe();const t1=performance.now();
        const added=transitions.slice(oldCount),abort=added.find(x=>x.type==='abort-job');
        if(!abort||abort.result!=='AbortError'||fixture.owners.some((o,j)=>o.store.version!==versions[j]))throw new Error('Controlled worker source/abort drift');
        rows.push({ordinal:i,startedAt:t0,finishedAt:t1,durationMs:t1-t0,transition:abort,ownership:ownership()});
      }}finally{if(descriptor)Object.defineProperty(prototype,'postMessage',descriptor);else delete prototype.postMessage;}
      return {preparation,before,rows,copies,after:ownership(),scope:'Post-primary sequential original100k leaseProbe; no producer/history mutation. Paused sessions resume and any pending final packet is explicitly drained before versions are captured. BUSY rejection-attempt counters change, accepted/source sequence does not. PostMessage wrapper records six column view/underlying bytes and synchronous native-call duration only here; full Worker times include diagnostic bookkeeping and profiler overhead, not a clean production latency.'};
    }
  }});
}
export function adaptRuntimeSource(original) {
  const marker=' await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));globalThis.__asterIngestion=controls;';
  if(original.split(marker).length!==2)throw new Error('Frozen fixture diagnostic hook changed');
  const body=diagnosticAccess.toString();
  return original.replace(marker,body.slice(body.indexOf('{')+1,body.lastIndexOf('}'))+'\n'+marker);
}
async function sourceManifest(root) {
  const files={};
  async function walk(dir){for(const e of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())files[relative(root,p)]=sha(await readFile(p));}}
  await walk(join(root,'src'));files['package.json']=sha(await readFile(join(root,'package.json')));
  return {files,sha256:sha(JSON.stringify(files)),scope:'Web source and package metadata only; native-only candidate edits excluded'};
}
async function memory(browser) {
  const [heap,info]=await Promise.allSettled([browser.send('Runtime.getHeapUsage'),browser.send('SystemInfo.getProcessInfo',{},null)]);
  const processes=info.status==='fulfilled'?info.value.processInfo.map(p=>({pid:Number(p.id),type:p.type,cpuTimeSeconds:p.cpuTime})).filter(p=>Number.isSafeInteger(p.pid)&&p.pid>0):[];
  let rss=[],rssError=null;
  if(processes.length)try{rss=execFileSync('ps',['-o','pid=,rss=','-p',processes.map(p=>p.pid).join(',')],{encoding:'utf8'}).trim().split('\n').map(x=>x.trim().split(/\s+/).map(Number)).filter(a=>a.length===2&&a.every(Number.isFinite)).map(([pid,kib])=>({pid,rssBytes:kib*1024,type:processes.find(p=>p.pid===pid)?.type}));}catch(e){rssError=e.message;}
  return {heap:heap.status==='fulfilled'?heap.value:null,processes,ownedProcessRSS:rss,rssSumBytes:rss.reduce((n,p)=>n+p.rssBytes,0),rssError,nodeMemory:process.memoryUsage(),scope:'Main target V8 and separately sampled process RSS. Shared pages may be counted repeatedly; not worker heap, GPU VRAM or true between-sample peak.'};
}
async function profileStart(browser,options) {
  await browser.send('Profiler.enable');await browser.send('Profiler.setSamplingInterval',{interval:options.cpuSamplingUs});await browser.send('Profiler.start');
  await browser.send('HeapProfiler.enable');
  await browser.send('HeapProfiler.startSampling',{samplingInterval:options.heapSamplingBytes,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
}
async function profileStop(browser,output,name) {
  const cpu=await browser.send('Profiler.stop'),heap=await browser.send('HeapProfiler.stopSampling');
  await writeFile(join(output,name+'.cpuprofile'),JSON.stringify(cpu.profile));await writeFile(join(output,name+'.heapprofile.json'),JSON.stringify(heap.profile));
  return {cpu:name+'.cpuprofile',allocation:name+'.heapprofile.json',scope:'Sampled and instrumented diagnostics; sampling and inspector overhead are included, not clean latency samples'};
}
export function diagnosticVerdict(report) {
  const errors=[],f=report.final;
  if(!f||f.status!=='pass'||f.errors.length)errors.push('Fixture error');
  if(f&&(!Number.isFinite(f.primaryElapsedSeconds)||f.primaryElapsedSeconds<report.options.durationSeconds||f.producer.omittedSamples!==0))errors.push('Duration/raw coverage');
  if(f&&(f.producer.hostPacketPeak>1||f.producer.sequenceGaps||f.producer.produced!==f.producer.accepted+f.producer.producerCancelled+f.producer.pendingProducerEvents))errors.push('Producer ledger');
  if(f?.queues?.some(q=>q.accepted!==q.applied+q.cancelled+q.pendingEvents||q.pendingEvents))errors.push('Queue ledger');
  if(f&&(!f.inputSamples.length||f.inputSamples.some(x=>!x.isTrusted||!Number.isFinite(x.inputToNextRenderMs))))errors.push('Input evidence');
  if(f){const c=f.cleanup;if(c.canvases||c.workersLive||c.rafPending||c.heartbeatPending||c.inputListeners||c.queueRingKnownBytes.some(Boolean)||c.models.some(x=>x.listeners||x.pendingChanges||!x.modelDisposed)||c.charts.some(x=>!x.disposed||x.listeners||x.frame!==null||x.canvasWidth||x.canvasHeight||x.cachedPixelBytes))errors.push('Owned cleanup');}
  if(report.protocol.exceptions.length||report.protocol.crashes.length||report.protocol.externalRequests.length)errors.push('Protocol');
  if(report.options.mode==='diagnostic'&&report.workerDiagnostic?.rows.length!==report.options.workerProbes)errors.push('Worker diagnostic');
  const digest=x=>Array.isArray(x)&&x.length===2&&x.every(n=>Number.isInteger(n)&&n>=0&&n<=4294967295);
  if(!Array.isArray(f?.proof)||f.proof.length!==2||f.proof.some(p=>!Number.isInteger(p.length)||p.length<100000||Object.keys(p.sourceDigest??{}).sort().join(',')!=='close,high,low,open,time,volume'||Object.values(p.sourceDigest).some(x=>!digest(x))||Object.values(p.studies??{}).flatMap(x=>Object.values(x.outputs??{})).length!==9||Object.values(p.studies??{}).flatMap(x=>Object.values(x.outputs??{})).some(x=>!digest(x))))errors.push('Full six-column/nine-output proof');
  if(typeof report.executionID!=='string'||!report.executionID||report.source?.sha256!==report.expectedWebSHA||report.diagnosticHarnessSHA256!==report.expectedHarnessSHA||report.originalHarnessSHA256!==report.expectedFrozenHarnessSHA)errors.push('Execution/source/harness binding');
  return {status:errors.length?'fail':'pass',errors,scope:'Finite attribution fixture, not production optimization or15-minute qualification'};
}
export async function webProfilePlan({sourceRoot,frozenHarnessRoot,options:input={}}) {
  const source=await realpath(resolve(sourceRoot)),frozen=await realpath(resolve(frozenHarnessRoot)),options=webProfileOptions(input);
  const rels=['benchmarks/ingestion.mjs','benchmarks/browser-ingestion.mjs','benchmarks/browser-soak.mjs','scripts/cdp.mjs','scripts/profile-cycle12-ingestion.mjs','test/cycle12-ingestion-browser.mjs'];
  const files={};for(const p of rels)files[p]=sha(await readFile(join(frozen,p)));
  const fixtureModule=await import(pathToFileURL(join(frozen,'benchmarks/browser-ingestion.mjs')));
  const runtime=adaptRuntimeSource(fixtureModule.browserIngestionRuntime.toString());
  const conditions=fixtureModule.browserIngestionOptions({verifyOnly:false,durationSeconds:options.durationSeconds,bars:100000,lineSeries:32,strategy:'queued',renderer:'canvas',dpr:1,burst:8,tickMs:100,drainEveryFrames:6,pressure:true,epochSeconds:60,maxStoredExtra:512,maxRawSamples:131072});
  return {schema:'aster.cycle13.web-attribution-plan',sourceRoot:source,frozenHarnessRoot:frozen,options,conditions,source:await sourceManifest(source),originalHarness:files,originalHarnessSHA256:sha(JSON.stringify(files)),diagnosticHarnessSHA256:sha(await readFile(fileURLToPath(import.meta.url))),runtimeAdapterSHA256:sha(runtime),measurementRan:false,scope:'Same frozen producer/input/render/trace retention; normal vs compact deep snapshot serialization only. Diagnostic CPU/allocation sampling and GC/Worker endpoints are separate.60s prefix does not reproduce the late900s transition backlog.'};
}
export async function runWebProfile({sourceRoot,frozenHarnessRoot,output,expectedWebSHA,expectedHarnessSHA,expectedFrozenHarnessSHA,options:input={}}) {
  const plan=await webProfilePlan({sourceRoot,frozenHarnessRoot,options:input});assert.equal(plan.source.sha256,expectedWebSHA,'Frozen web SHA required');
  assert.equal(plan.diagnosticHarnessSHA256,expectedHarnessSHA,'Diagnostic harness SHA required');assert.equal(plan.originalHarnessSHA256,expectedFrozenHarnessSHA,'Original harness SHA required');
  await mkdir(resolve(output,'..'),{recursive:true});await mkdir(output);
  const module=await import(pathToFileURL(join(plan.frozenHarnessRoot,'benchmarks/browser-ingestion.mjs'))),serverModule=await import(pathToFileURL(join(plan.frozenHarnessRoot,'benchmarks/browser-soak.mjs'))),cdp=await import(pathToFileURL(join(plan.frozenHarnessRoot,'scripts/cdp.mjs')));
  const fixture=await readFile(join(plan.frozenHarnessRoot,'benchmarks/ingestion.mjs'),'utf8');
  const runtime=fixture+'\n;('+adaptRuntimeSource(module.browserIngestionRuntime.toString())+')('+JSON.stringify(plan.conditions)+').catch(e=>globalThis.__asterIngestionFailure={name:e.name,message:e.message,stack:e.stack});';
  const server=await serverModule.startFixtureServer(plan.sourceRoot,runtime),report={...plan,executionID:randomUUID(),expectedWebSHA,expectedHarnessSHA,expectedFrozenHarnessSHA,measurementRan:true,timestamp:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0]?.model},protocol:{externalRequests:[],exceptions:[],crashes:[]},polls:[],samples:[],endpoints:[],profiles:[]};
  let browser,inputJob,inputFailure,stopping=false,profileActive=false;
  const endpoint=async(name,gc=false)=>{if(gc)await browser.send('HeapProfiler.collectGarbage');const row={name,forcedGC:gc,memory:await memory(browser),ownership:await browser.evaluate('globalThis.__asterIngestion?.diagnostic.ownership()??null')};report.endpoints.push(row);return row;};
  try {
    browser=await cdp.launchBrowser({width:1280,height:1540,dpr:1});report.environment.browser=await browser.send('Browser.getVersion',{},null);await browser.send('Network.enable');
    browser.on('Runtime.exceptionThrown',p=>report.protocol.exceptions.push(p.exceptionDetails));browser.on('Inspector.targetCrashed',p=>report.protocol.crashes.push(p));browser.on('Network.requestWillBeSent',p=>{if(/^https?:/.test(p.request.url)&&!p.request.url.startsWith(server.origin+'/'))report.protocol.externalRequests.push(p.request.url);});
    await browser.navigate(server.origin+'/harness.html');
    let ready=false;for(let i=0;i<300;i++){const state=await browser.evaluate('({ready:!!globalThis.__asterIngestion?.ready,failure:globalThis.__asterIngestionFailure??null})');if(state.failure)throw new Error(JSON.stringify(state.failure));if(state.ready){ready=true;break;}await delay(20);}assert.ok(ready,'Fixture startup');
    await endpoint('ready',plan.options.mode==='diagnostic');
    if(plan.options.mode==='diagnostic'){profileActive=true;await profileStart(browser,plan.options);}
    const rects=await browser.evaluate('[...document.querySelectorAll("canvas")].map(c=>{const r=c.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})');assert.equal(rects.length,2);await browser.evaluate('__asterIngestion.start()');
    inputJob=(async()=>{let n=0;while(!stopping){const r=rects[n%2],x=r.left+60+(n*31)%1000,y=r.top+80+(n*17)%220;await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,buttons:0});if(n%3===0)await browser.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:n%2?20:-20});if(n%6===0){await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+8,y:y+2,buttons:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+8,y:y+2,button:'left',buttons:0,clickCount:1});}n++;await delay(250);}report.inputActorIterations=n;})().catch(e=>{inputFailure=e;stopping=true;});
    let done=false,sampleAt=0;
    for(let i=0;i<Math.ceil((plan.options.durationSeconds+120)*1000/50);i++){
      if(inputFailure)throw inputFailure;const t0=performance.now(),snapshot=await browser.evaluate(snapshotExpression(plan.options.mode)),t1=performance.now();
      report.polls.push({ordinal:i,elapsedSeconds:snapshot.elapsedSeconds,roundTripMs:t1-t0,transitions:snapshot.transitionCount??snapshot.transitions.length});
      if(snapshot.errors.length)throw new Error(JSON.stringify(snapshot.errors));
      if(snapshot.elapsedSeconds>=sampleAt){report.samples.push({elapsedSeconds:snapshot.elapsedSeconds,decodedCompactJSONBytes:Buffer.byteLength(JSON.stringify(snapshot)),memory:await memory(browser),ownership:await browser.evaluate('__asterIngestion.diagnostic.ownership()')});sampleAt=snapshot.elapsedSeconds+10;}
      if(snapshot.done){done=true;break;}await delay(plan.options.pollMs);
    }
    assert.ok(done,'Bounded completion');stopping=true;await inputJob;
    if(profileActive){report.profiles.push(await profileStop(browser,output,'feed'));profileActive=false;}
    await endpoint('finished-primary-before-proof');
    if(plan.options.mode==='diagnostic'){
      await endpoint('finished-primary-alive-after-GC',true);
      profileActive=true;await profileStart(browser,plan.options);
      report.workerDiagnostic=await browser.evaluate(`__asterIngestion.diagnostic.workers(${plan.options.workerProbes})`);
      report.profiles.push(await profileStop(browser,output,'post-feed-workers'));profileActive=false;
      await endpoint('post-feed-workers-before-GC');await endpoint('post-feed-workers-after-GC',true);
    }
    const stopped=await browser.evaluate('(async()=>{const final=await __asterIngestion.stop();const ownership=__asterIngestion.diagnostic.ownership();globalThis.__asterIngestion=null;return {final,ownership};})()');report.final=stopped.final;report.borrowedStoreAccountingAtDispose=stopped.ownership;
    await endpoint('after-proof-and-global-release');if(plan.options.mode==='diagnostic')await endpoint('after-proof-and-global-release-after-GC',true);
    assert.deepEqual(await sourceManifest(plan.sourceRoot),plan.source,'Frozen web changed');
    const after=await webProfilePlan({sourceRoot,frozenHarnessRoot,options:input});assert.equal(after.diagnosticHarnessSHA256,expectedHarnessSHA,'Diagnostic harness changed');assert.equal(after.originalHarnessSHA256,expectedFrozenHarnessSHA,'Frozen harness changed');report.guardsAfter={sourceSHA:after.source.sha256,harnessSHA:after.diagnosticHarnessSHA256,frozenHarnessSHA:after.originalHarnessSHA256};
    report.verdict=diagnosticVerdict(report);assert.equal(report.verdict.status,'pass',report.verdict.errors.join(';'));
  } catch(error) {
    report.failure={name:error.name,message:error.message,stack:error.stack};report.verdict={status:'fail',errors:[error.message]};throw error;
  } finally {
    stopping=true;
    if(profileActive&&browser)try{report.profiles.push(await profileStop(browser,output,'interrupted'));}catch{}
    if(browser)try{await browser.evaluate('(async()=>{if(globalThis.__asterIngestion){try{await __asterIngestion.stop()}finally{globalThis.__asterIngestion=null}}})()');}catch{}
    await browser?.close();await inputJob;await server.close();report.ownedCloseCompleted=true;
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  }
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const arg=(name,fallback)=>{const key='--'+name,i=process.argv.indexOf(key),v=process.argv.find(x=>x.startsWith(key+'='));return v?v.slice(key.length+1):i<0?fallback:process.argv[i+1];};
  const input={sourceRoot:arg('source','.'),frozenHarnessRoot:arg('frozen-harness','/tmp/aster-cycle12-browser-pressure900-final/harness'),output:arg('output','/tmp/aster-cycle13-web/run'),expectedWebSHA:arg('expected-web-sha',null),expectedHarnessSHA:arg('expected-harness-sha',null),expectedFrozenHarnessSHA:arg('expected-frozen-harness-sha',null),options:{mode:arg('mode','normal'),durationSeconds:Number(arg('duration','60'))}};
  if(!process.argv.includes('--isolated'))console.log(JSON.stringify(await webProfilePlan(input),null,2));
  else console.log(JSON.stringify({output:input.output,verdict:(await runWebProfile(input)).verdict}));
}
