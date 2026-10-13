import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cpus,release} from 'node:os';
import {performance} from 'node:perf_hooks';
import {INGESTION_KINDS,INGESTION_SPEC,createIngestionFixture,ingestionOperation,dispatchIngestionOperation,commitIngestionReference,
  queryIngestionFixture,renderIngestionFixture,verifyIngestionFixture,disposeIngestionFixture,verifyIngestionNotificationQueue} from '../benchmarks/ingestion.mjs';
import {ingestionPacket,dispatchIngestionPacket,commitIngestionPacketReference,verifyIngestionQueueFixture} from '../benchmarks/ingestion.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const memoryEndpoint=()=>({...process.memoryUsage(),maxRSSRawKiB:process.resourceUsage().maxRSS,scope:'Process endpoint; maxRSS is lifetime highwater including fixture setup/previous cases/oracles; neither operation peak nor a retained-live/leak claim'});
const arg=(name,fallback)=>{const key='--'+name,i=process.argv.indexOf(key),inline=process.argv.find(v=>v.startsWith(key+'='));return inline?inline.slice(key.length+1):i<0?fallback:process.argv[i+1];};
function whole(name,fallback,min,max){const n=Number(arg(name,fallback));assert.ok(Number.isSafeInteger(n)&&n>=min&&n<=max,name);return n;}
function quantiles(samples){const a=[...samples].sort((x,y)=>x-y);return {count:a.length,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null,max:a.at(-1)??null};}
async function sourceManifest(root){const files=Object.fromEntries(await Promise.all((await readdir(join(root,'src/core'))).filter(n=>n.endsWith('.mjs')).sort().map(async n=>['src/core/'+n,hash(await readFile(join(root,'src/core',n)))])));files['native/Resources/aster-core.js']=hash(await readFile(join(root,'native/Resources/aster-core.js')));files['package.json']=hash(await readFile(join(root,'package.json')));return {files,sha256:hash(JSON.stringify(files))};}
async function harnessManifest(){return Object.fromEntries(await Promise.all(['../benchmarks/ingestion.mjs','./profile-cycle12-ingestion.mjs'].map(async rel=>[rel,hash(await readFile(new URL(rel,import.meta.url)))])));}
export function ingestionPlan(){return {
  schema:'aster.cycle12.ingestion-plan',measurementRan:false,CPUProfileRan:false,RSSSamplingRan:false,fixture:INGESTION_SPEC,
  operations:INGESTION_KINDS,bursts:[1,16,64],independentSymbols:'Two stores/models/APIs; native two owner engines/VMs, no pretend multi-store primary model',
  short:{tail:{warmup:20,samples:80},historical:{warmup:3,samples:10},firstProfile:{kinds:['current-update','append'],bars:100000,lineSeries:32,burst:32,policy:'per-event'}},
  boundaries:{notification:'ChartAPI.applyDataEvent incl validation/index/internal invalidation/4 public count observers; queries outside this phase',
    query:'IndicatorEngine.get EMA/RSI/session VWAP5/linked module2; scalar per-event versus explicitly different burst-end policy recorded',
    scene:'buildScene CPU including data index/axis/time/label work; no Canvas/GPU/raster/compositor FPS',
    surrogate:'Node JSON.stringify/parse stages are synthetic serialization only, never native bridge performance',
    apple:'Actual AsterEngine.command→JSC value bridge + notifyChanges. setData JSONEncoder/JSONSerialization separately. No invented JSON arg parse in ordinary command',
    android:'Actual JSONArray(args).toString→JNI/QuickJS arg parse→nativeCommand→result stringify→Java JSON parse + notifyChanges',
    taskqueue:'Nested source mutation probe checks FIFO observer version snapshots, latest query visibility, bounded error ledger/drained pendingChanges'},
  long:{durationSeconds:900,allowedDurationSeconds:[600,900],epochSeconds:60,policy:'Common planned scalar per-event and future candidate atomic-batch adapter must use same immutable ordered ingress trace',
    ledger:['produced','accepted','committed','pending','cancelled','rejected','sequenceGaps','producerBacklog','producerBacklogPeak','sourceVersions','capacity','outputVectors','outputCapacityBytes'],
    conservation:'Unique produced = accepted + explicit producerCancelled + hostPending; rejection attempts/retries are counted separately. Accepted = applied + pending + cancelled; no hidden drops/coalescing',
    retention:'Hard maxBars reject; no eviction/rebase/reset within pressure long run. Explicit cancel/resume then update/sparse old corrections keeps all history. Reset/period-change correctness is separately untimed',
    memory:'Epoch endpoints and separately sampled highwater; RSS trend is not retained live ownership/leak proof. Full digest/oracle checks are outside operation timers',
    readiness:'Explicit scalar/atomic packets and queued conservation probes are implemented. Actual Chrome producer/owner RAF pressure runner is separately gated by test/cycle12-ingestion-browser.mjs; no 900s run without quiet GO'},
  browserIntegration:{runner:'Existing scripts/cdp.mjs + startFixtureServer; platform worker owns actual renderer/input fixture',
    concurrent:'Separate trusted CDP pointer producer and immutable data-injection producer; record offered/accepted/committed seq, event.isTrusted, aster:render revision/RAF, final heartbeat interval',
    limits:'Loopback only; actual input/CPU submission separate from readback/display. No browser started by verify-only'},
  guards:['default CLI prints plan only','--verify-only performs deterministic work without clocks/CPU/RSS','--isolated measured mode requires exact --source-manifest-sha','Root quiet GO is still required operationally','No implicit multi-process comparative runs or sampling hooks']};}

async function verify(core,{bars,lineSeries}){
  const cases=[];
  for(const transport of ['direct','json-surrogate']){
    const fixture=createIngestionFixture(core,{bars,lineSeries});let sequence=0;
    try{for(const kind of INGESTION_KINDS){for(const burst of [1,4])for(let i=0;i<burst;i++)for(const symbol of [0,1]){let operation=ingestionOperation(fixture,kind,symbol,++sequence);if(transport==='json-surrogate')operation=JSON.parse(JSON.stringify(operation));const other=fixture.owners[1-symbol],otherVersion=other.store.version,otherLength=other.store.length;dispatchIngestionOperation(fixture,operation);commitIngestionReference(fixture,operation);queryIngestionFixture(fixture,symbol);const scene=renderIngestionFixture(fixture,symbol);assert.equal(scene.stats.storedBars,fixture.owners[symbol].store.length);assert.equal(other.store.version,otherVersion);assert.equal(other.store.length,otherLength);}cases.push({transport,kind,afterKind:verifyIngestionFixture(fixture)});}}
    finally{cases.push({transport,cleanup:disposeIngestionFixture(fixture)});}
  }
  return {measurementRan:false,CPUProfileRan:false,RSSSamplingRan:false,clockSamples:[],memorySamples:[],cases,nestedQueue:verifyIngestionNotificationQueue(core,{burst:32})};
}
async function verifyPackets(core,options,strategy){const fixture=createIngestionFixture(core,options),cases=[];let result;try{if(strategy==='queued'){result={measurementRan:false,CPUProfileRan:false,RSSSamplingRan:false,clockSamples:[],memorySamples:[],queue:verifyIngestionQueueFixture(fixture)};return result;}for(const kind of ['current-update','append','correction-first','correction-middle','correction-tail']){for(const symbol of [0,1]){const owner=fixture.owners[symbol],packet=ingestionPacket(fixture,kind,symbol,owner.stats.lastSequence,8),receipt=dispatchIngestionPacket(fixture,packet,{strategy});commitIngestionPacketReference(fixture,packet);queryIngestionFixture(fixture,symbol);renderIngestionFixture(fixture,symbol);cases.push({kind,symbol,receipt});}cases.push({kind,proof:verifyIngestionFixture(fixture)});}result={measurementRan:false,CPUProfileRan:false,RSSSamplingRan:false,clockSamples:[],memorySamples:[],strategy,cases};return result;}finally{const cleanup=disposeIngestionFixture(fixture);if(result)result.cleanup=cleanup;else cases.push({cleanup});}}

async function microPackets(core,options,output,strategy){
 const kinds=String(arg('kinds','current-update,append')).split(','),burst=whole('burst',8,1,4096),warmup=whole('warmup',20,0,1000),samples=whole('samples',80,1,10000),phase=arg('phase','query');assert.ok(kinds.every(k=>['current-update','append','correction-first','correction-middle','correction-tail'].includes(k)));assert.ok(['notification','query','render'].includes(phase));assert.equal(arg('policy','burst-end'),'burst-end','Packet comparison uses one burst-end query');const cases=[];
 for(const kind of kinds){const beforeFixture=memoryEndpoint(),fixture=createIngestionFixture(core,options),memory={beforeFixture,ready:memoryEndpoint()},raw=[],profiler=await cpuProfiler(process.argv.includes('--cpu-profile'));let profile;
  try{for(let sample=0;sample<warmup+samples;sample++)for(const symbol of [0,1]){const owner=fixture.owners[symbol],packet=ingestionPacket(fixture,kind,symbol,owner.stats.lastSequence,burst),versionBefore=owner.store.version,countsBefore=[...owner.counts],a=performance.now(),text=JSON.stringify(packet),b=performance.now(),copy=JSON.parse(text),c=performance.now(),receipt=dispatchIngestionPacket(fixture,copy,{strategy}),d=performance.now();let queryUs=0,sceneUs=0,jsonOutputUs=0;if(phase!=='notification'){const t=performance.now();queryIngestionFixture(fixture,symbol);queryUs=(performance.now()-t)*1000;}if(phase==='render'){const t=performance.now(),scene=renderIngestionFixture(fixture,symbol),s=performance.now();JSON.stringify(scene);const e=performance.now();sceneUs=(s-t)*1000;jsonOutputUs=(e-s)*1000;}commitIngestionPacketReference(fixture,packet);const row={sample,symbol,kind,burst,strategy,policy:'burst-end',mutationUs:(d-c)*1000,queryUs,sceneUs,jsonEncodeUs:(b-a)*1000,jsonParseUs:(c-b)*1000,jsonOutputUs,queryCalls:phase==='notification'?0:1,sceneCalls:phase==='render'?1:0,versionBefore,versionAfter:owner.store.version,countsBefore,countsAfter:[...owner.counts],receipt};if(sample>=warmup)raw.push(row);if(sample===warmup-1&&symbol===1)memory.afterWarmup=memoryEndpoint();}if(profiler)profile=await profiler.stop();memory.afterMeasuredBeforeOracle=memoryEndpoint();cases.push({kind,strategy,raw,memory,proof:verifyIngestionFixture(fixture),summary:Object.fromEntries(['mutationUs','queryUs','sceneUs','jsonEncodeUs','jsonParseUs','jsonOutputUs'].map(k=>[k,quantiles(raw.map(r=>r[k]))])),scope:'One packet JSON surrogate for both strategies; scalar dispatch8 versus explicit atomic8, query once. Publication/version grain deliberately differs. Generation/reference/full oracle outside timers.'});}
  catch(e){e.partialCase={kind,strategy,raw,memory};throw e;}
  finally{if(profiler&&!profile)await profiler.stop().catch(()=>{});const cleanup=disposeIngestionFixture(fixture);memory.afterDisposeWhileFixtureReferenced=memoryEndpoint();if(cases.at(-1)?.kind===kind)cases.at(-1).cleanup=cleanup;}
  if(profile)await writeFile(join(output,kind+'.cpuprofile'),JSON.stringify(profile));
 }return {measurementRan:true,CPUProfileRan:process.argv.includes('--cpu-profile'),RSSSamplingRan:false,strategy,cases};
}

// This diagnostic is explicitly selected and separate from clean latency runs.
async function cpuProfiler(enabled){if(!enabled)return null;const {Session}=await import('node:inspector');const session=new Session();session.connect();const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(e,r)=>e?reject(e):resolve(r)));await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');return {async stop(){try{return (await post('Profiler.stop')).profile;}finally{session.disconnect();}}};}
async function micro(core,options,output){
  const kinds=String(arg('kinds','current-update,append')).split(',');assert.ok(kinds.length&&kinds.every(k=>INGESTION_KINDS.includes(k)));
  const burst=whole('burst',32,1,256),warmup=whole('warmup',20,0,1000),samples=whole('samples',80,1,10000),policy=arg('policy','per-event'),phase=arg('phase','render');assert.ok(['per-event','burst-end'].includes(policy));assert.ok(['notification','query','render'].includes(phase));
  const rows=[];let sequence=0;
  for(const kind of kinds){const beforeFixture=memoryEndpoint(),fixture=createIngestionFixture(core,options),endpoints={beforeFixture,ready:memoryEndpoint()},raw=[],profiler=await cpuProfiler(process.argv.includes('--cpu-profile'));let profile;
    try{for(let sample=0;sample<warmup+samples;sample++)for(const symbol of [0,1]){
      const owner=fixture.owners[symbol],revisions=()=>Object.fromEntries([...owner.model.indicators.entries].map(([id,e])=>[id,e.revision]));
      const row={sample,symbol,kind,burst,policy,phase,mutationUs:0,queryUs:0,sceneUs:0,jsonEncodeUs:0,jsonParseUs:0,jsonOutputUs:0,queryCalls:0,sceneCalls:0,firstSequence:sequence+1,sourceVersionBefore:owner.store.version,capacityBefore:owner.store.capacity,publicNotificationsBefore:[...owner.counts],invalidationsBefore:owner.stats.invalidations,indicatorRevisionsBefore:revisions()};
      for(let i=0;i<burst;i++){
        const operation=ingestionOperation(fixture,kind,symbol,++sequence),a=performance.now(),text=JSON.stringify(operation),b=performance.now(),copy=JSON.parse(text),c=performance.now();dispatchIngestionOperation(fixture,copy);const d=performance.now();row.jsonEncodeUs+=(b-a)*1000;row.jsonParseUs+=(c-b)*1000;row.mutationUs+=(d-c)*1000;
        if(policy==='per-event'||i===burst-1){let result,scene;if(phase!=='notification'){const q=performance.now();result=queryIngestionFixture(fixture,symbol);row.queryUs+=(performance.now()-q)*1000;row.queryCalls++;}if(phase==='render'){const q=performance.now();scene=renderIngestionFixture(fixture,symbol);row.sceneUs+=(performance.now()-q)*1000;row.sceneCalls++;}if(scene||result){const q=performance.now();if(scene)JSON.stringify(scene);else JSON.stringify(Object.fromEntries(Object.entries(result).map(([id,v])=>[id,Object.fromEntries(Object.entries(v.outputs).map(([k,a])=>[k,[a.at(-1)]]))])));row.jsonOutputUs+=(performance.now()-q)*1000;}}
        commitIngestionReference(fixture,operation);
      }
      Object.assign(row,{lastSequence:sequence,sourceVersionAfter:owner.store.version,capacityAfter:owner.store.capacity,publicNotificationsAfter:[...owner.counts],invalidationsAfter:owner.stats.invalidations,indicatorRevisionsAfter:revisions()});
      if(sample===warmup-1&&symbol===1)endpoints.afterWarmup=memoryEndpoint();if(sample>=warmup)raw.push(row);
    }if(profiler)profile=await profiler.stop();endpoints.afterMeasuredBeforeOracle=memoryEndpoint();const proof=verifyIngestionFixture(fixture);rows.push({kind,burst,policy,phase,warmup,samplesPerSymbol:samples,raw,memory:endpoints,summary:Object.fromEntries(['mutationUs','queryUs','sceneUs','jsonEncodeUs','jsonParseUs','jsonOutputUs'].map(k=>[k,quantiles(raw.map(r=>r[k]))])),proof,scope:'Per-burst stage sums include clock overhead; JSON stages are Node surrogate. JSON output is full scene or projected study tail values, not full indicatorValues arrays. Input generation/reference/full validation are outside timers. CPU profile includes those fixture tasks and must retain separate core-versus-harness attribution. Phase query/render are explicit; burst-end differs observably from scalar per-event.'});}
    catch(e){e.partialCase={kind,burst,policy,phase,raw,memory:endpoints};throw e;}
    finally{if(profiler&&!profile)await profiler.stop().catch(()=>{});const cleanup=disposeIngestionFixture(fixture);endpoints.afterDisposeWhileFixtureReferenced=memoryEndpoint();if(rows.at(-1)?.kind===kind)rows.at(-1).cleanup=cleanup;}
    if(profile)await writeFile(join(output,kind+'.cpuprofile'),JSON.stringify(profile));
  }return {measurementRan:true,CPUProfileRan:process.argv.includes('--cpu-profile'),RSSSamplingRan:false,cases:rows};
}
export async function main(){
  const output=resolve(arg('output','/tmp/aster-cycle12-profile/plan')),root=await realpath(resolve(arg('source',process.cwd()))),verifyOnly=process.argv.includes('--verify-only'),isolated=process.argv.includes('--isolated'),mode=arg('mode','micro'),source=await sourceManifest(root),harness=await harnessManifest(),plan=ingestionPlan();
  const report={schema:'aster.cycle12.ingestion',timestamp:new Date().toISOString(),sourceRoot:root,source,harness,environment:{node:process.version,platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0]?.model},plan,measurementRan:false};
  if(!verifyOnly&&!isolated){console.log(JSON.stringify(report,null,2));return;}
  if(!verifyOnly){assert.equal(source.sha256,arg('source-manifest-sha'),'Frozen source manifest SHA required');assert.equal(mode,'micro','Long pressure runner is preparation plan only; align candidate ingress policy before implementation');}
  const options={bars:verifyOnly?whole('bars',512,32,2048):whole('bars',100000,32,100000),lineSeries:whole('lines',1,1,32)},strategy=arg('strategy','scalar'),packetMode=process.argv.includes('--packet')||strategy!=='scalar';assert.ok(['scalar','atomic','queued'].includes(strategy));if(strategy==='queued'&&!verifyOnly)throw new Error('Queued measured scheduler uses the separately gated browser ingestion runner');
  const core=await import(pathToFileURL(join(root,'src/core/index.mjs')));await mkdir(output,{recursive:true});
  try{Object.assign(report,verifyOnly?(packetMode?await verifyPackets(core,options,strategy):await verify(core,options)):(packetMode?await microPackets(core,options,output,strategy):await micro(core,options,output)));assert.deepEqual(await sourceManifest(root),source,'Source changed');report.status='pass';}
  catch(e){report.status='fail';report.failure={name:e.name,message:e.message,stack:e.stack};if(e.partialCase)report.partialCase=e.partialCase;await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));throw e;}
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(join(output,'report.json'));
}
// realpath also handles macOS /tmp→/private/tmp. Imported modules do no work.
if(process.argv[1]&&(resolve(process.argv[1])===resolve(import.meta.filename)||await realpath(process.argv[1]).catch(()=>null)===import.meta.filename))await main();
