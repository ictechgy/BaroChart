import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ingestionBrowserVerdict,runIngestionBrowser} from './cycle12-ingestion-browser.mjs';
import {browserIngestionOptions} from '../benchmarks/browser-ingestion.mjs';

const runFile=promisify(execFile);
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const runner=fileURLToPath(new URL('./cycle12-ingestion-browser.mjs',import.meta.url));

import {browserIngestionExecution,sealBrowserIngestionEvidence} from '../scripts/browser-ingestion-evidence-contract.mjs';
import {healthyBrowserIngestionReport,directBrowserIngestionReport} from './fixtures/browser-ingestion-report.mjs';
const healthyReport=healthyBrowserIngestionReport;

function mustReject900(report){
 const verdict=ingestionBrowserVerdict(report);
 assert.equal(verdict.status,'fail');
 assert.equal(verdict.qualifying900Seconds,false);
}

test('a complete measured report qualifies at exactly900 actual seconds',()=>{
 const verdict=ingestionBrowserVerdict(healthyReport());
 assert.equal(verdict.status,'pass',verdict.errors.join(';'));
 assert.equal(verdict.qualifying900Seconds,true);
});

for(const [label,elapsed] of [['early',899.999],['missing',undefined],['null',null],['NaN',NaN],['positiveInfinity',Infinity],['negativeInfinity',-Infinity],['numericString','900']]){
 test('configured900 cannot qualify with '+label+' actual elapsed evidence',()=>{
  const report=healthyReport();
  if(elapsed===undefined)delete report.final.primaryElapsedSeconds;
  else report.final.primaryElapsedSeconds=elapsed;
  mustReject900(report);
 });
}

for(const [label,count] of [['positive',1],['missing',undefined],['negative',-1],['numericString','0']]){
 test('measured900 requires a present zero omission counter: '+label,()=>{
  const report=healthyReport();
  if(count===undefined)delete report.final.producer.omittedSamples;
  else report.final.producer.omittedSamples=count;
  // A retained final heartbeat does not establish complete raw trace coverage.
  assert.equal(report.final.heartbeat.at(-1).final,true);
  mustReject900(report);
 });
}

test('an inherited zero omission counter is not own coverage evidence',()=>{
 const report=healthyReport();
 delete report.final.producer.omittedSamples;
 Object.setPrototypeOf(report.final.producer,{omittedSamples:0});
 mustReject900(report);
});

for(const [label,alter] of [
 ['runtime failure',r=>{r.final.status='fail';}],
 ['protocol exception',r=>{r.protocol.exceptions.push({text:'fixture failure'});}],
 ['owned retained pixels',r=>{r.final.cleanup.charts[0].cachedPixelBytes=4;}],
 ['incomplete queue ledger',r=>{r.final.queues[0].applied=23;}],
 ['nontrusted input',r=>{r.final.inputSamples[0].isTrusted=false;}],
 ['missing final heartbeat',r=>{r.final.heartbeat.at(-1).final=false;}]
]){
 test('overall '+label+' prevents900 qualification despite duration and coverage',()=>{
  const report=healthyReport();alter(report);mustReject900(report);
 });
}

test('functional verify-only evidence is not a900 measurement',()=>{
 const report=healthyReport({measured:false});
 const verdict=ingestionBrowserVerdict(report);
 assert.equal(verdict.status,'pass',verdict.errors.join(';'));
 assert.equal(verdict.qualifying900Seconds,false);
});

test('a healthy short diagnostic remains separate from900 qualification',()=>{
 const report=healthyReport({duration:3});
 const verdict=ingestionBrowserVerdict(report);
 assert.equal(verdict.status,'pass',verdict.errors.join(';'));
 assert.equal(verdict.qualifying900Seconds,false);
});

test('runtime default trace capacity covers900 seconds of8ms heartbeat plusfinal',()=>{
 const options=browserIngestionOptions();
 assert.equal(options.maxRawSamples,131072);
 assert.ok(options.maxRawSamples>900000/8+1);
 assert.equal(browserIngestionOptions({maxRawSamples:65536}).maxRawSamples,65536,'explicit diagnostic cap remains selectable');
 assert.throws(()=>browserIngestionOptions({maxRawSamples:131073}),RangeError,'trace capacity remains bounded');
});

test('CLI default plan uses the same sufficient trace cap without starting a browser',async()=>{
 // No --isolated/--verify-only: this only prints the plan and source hashes.
 const {stdout}=await runFile(process.execPath,[runner,'--source',projectRoot],{cwd:projectRoot,maxBuffer:1024*1024,timeout:15000});
 const plan=JSON.parse(stdout);
 assert.equal(plan.browserStarted,false);
 assert.equal(plan.measurementRan,false);
 assert.equal(plan.conditions.durationSeconds,900);
 assert.equal(plan.conditions.maxRawSamples,131072);
 assert.equal(plan.conditions.maxRawSamples,browserIngestionOptions().maxRawSamples);
});

for(const [label,alter]of [
 ['missing full-vector proof',r=>{delete r.final.proof;}],
 ['empty full-vector proof',r=>{r.final.proof=[];}],
 ['missing second model proof',r=>{r.final.proof.pop();}],
 ['duplicate model proof',r=>{r.final.proof[1]=structuredClone(r.final.proof[0]);}],
 ['out-of-tolerance finite oracle error',r=>{r.final.proof[0].studies.ema.checks.maxRelativeError=1;}],
 ['missing measured packet timestamp',r=>{delete r.final.packetSamples[0].at;}],
 ['missing measured packet CPU timing',r=>{delete r.final.packetSamples[0].coreSubmitMs;}],
 ['zero vector coverage and wrong values',r=>{for(const p of r.final.proof)for(const s of Object.values(p.studies))s.checks={checked:0,maxRelativeError:1};}],
 ['missing raw column',r=>{delete r.final.proof[0].sourceDigest.volume;}],
 ['missing output vector',r=>{delete r.final.proof[1].studies.vwap.outputs.deviation;}],
 ['infinite oracle error',r=>{r.final.proof[0].studies.ema.checks.maxRelativeError=Infinity;}],
 ['NaN oracle error',r=>{r.final.proof[0].studies.ema.checks.maxRelativeError=NaN;}],
 ['empty terminal queue ledger',r=>{r.final.queues=[];}],
 ['failed drawing undo evidence',r=>{r.final.drawingChecks[0].unchanged=false;r.final.drawingChecks[0].undoRedo=false;}],
 ['empty drawing evidence',r=>{r.final.drawingChecks=[];}],
 ['sparse model cleanup',r=>{delete r.final.cleanup.models[0];}],
 ['empty model cleanup',r=>{r.final.cleanup.models=[];r.final.cleanup.charts=[];r.final.cleanup.queueRingKnownBytes=[];}],
 ['worker conservation mismatch',r=>{r.final.cleanup.workersTerminated--;}],
 ['missing intermediate heartbeat trace',r=>{r.final.heartbeat=[r.final.heartbeat.at(-1)];}],
 ['missing render trace',r=>{r.final.renderSamples=[[],[]];}],
 ['missing packet trace',r=>{r.final.packetSamples=[];}],
 ['null input row',r=>{r.final.inputSamples[0]=null;}],
 ['missing input temporal value',r=>{delete r.final.inputSamples[0].eventAt;}],
 ['infinite input timestamp',r=>{r.final.inputSamples[0].handlerAt=Infinity;}],
 ['NaN heartbeat gap',r=>{r.final.heartbeat[0].gapMs=NaN;}],
 ['infinite render timestamp',r=>{r.final.renderSamples[0][0].at=Infinity;}],
 ['different fixture conditions',r=>{r.final.conditions.bars++;}],
 ['different source manifest',r=>{r.source.files['src/core/data.mjs']='0'.repeat(64);}]
])test('completed evidence rejects '+label,()=>{const r=healthyReport();alter(r);mustReject900(r);});

test('incomplete objects fail closed instead of throwing from the public verdict',()=>{
 for(const r of [null,{},[],{final:{}},{conditions:{durationSeconds:900}}]){
  let verdict;assert.doesNotThrow(()=>{verdict=ingestionBrowserVerdict(r);});
  assert.equal(verdict.status,'fail');assert.equal(verdict.qualifying900Seconds,false);
 }
});

const RUN_A='11111111-1111-4111-8111-111111111111',RUN_B='22222222-2222-4222-8222-222222222222';
function boundReport(runId=RUN_A){
 const r=healthyReport({duration:3});r.execution=browserIngestionExecution(r,runId);
 r.final.execution=structuredClone(r.execution);r.runnerCleanup={completed:true,results:['fixture-stop','browser-close','input-stop','server-close'].map(resource=>({resource,status:'fulfilled'}))};return sealBrowserIngestionEvidence(r);
}
test('new runtime execution UUID/source/fixture/config and trace seals bind healthy evidence',()=>{
 const r=boundReport(),v=ingestionBrowserVerdict(r);
 assert.equal(v.status,'pass',v.errors.join(';'));assert.match(v.evidenceBinding,/UUID/);
 assert.equal(v.qualifying900Seconds,false);
});
for(const [name,mutate]of [
 ['another execution final',r=>{r.final=boundReport(RUN_B).final;}],
 ['another execution proof',r=>{r.final.proof=boundReport(RUN_B).final.proof;}],
 ['another execution input row',r=>{r.final.inputSamples[0]=boundReport(RUN_B).final.inputSamples[0];}],
 ['missing intermediate sealed heartbeat',r=>{r.final.heartbeat.splice(1,1);} ],
 ['missing sealed render row',r=>{r.final.renderSamples[0].splice(0,1);} ],
 ['altered sealed raw digest',r=>{r.final.proof[0].sourceDigest.close[0]++;}],
 ['wrong fixture execution hash',r=>{r.execution.fixtureSHA256='0'.repeat(64);} ],
 ['wrong source execution hash',r=>{r.execution.sourceSHA256='0'.repeat(64);} ],
 ['wrong runtime timestamp',r=>{r.final.execution.timestamp='2026-10-13T00:00:00Z';} ],
 ['deleted trace seal',r=>{delete r.evidenceSeal;} ]
])test('new execution rejects '+name,()=>{const r=boundReport();mutate(r);mustReject900(r);});

// Refreshing the seal after a structural mutation must not hide the missing
// required evidence. These deliberately bypass a mere checksum-mismatch RED.
for(const [name,mutate]of [
 ['deleted second proof',r=>{r.final.proof.pop();}],
 ['out-of-tolerance oracle error',r=>{r.final.proof[0].studies.ema.checks.maxRelativeError=.1;}],
 ['empty cleanup models',r=>{r.final.cleanup.models=[];}],
 ['missing input timestamp',r=>{delete r.final.inputSamples[0].handlerAt;}]
])test('even a refreshed new seal rejects '+name,()=>{
 const r=boundReport();mutate(r);sealBrowserIngestionEvidence(r);mustReject900(r);
 assert.ok(!ingestionBrowserVerdict(r).errors.some(e=>e.startsWith('Trace coverage')),'structural guard rejects even when trace hash was refreshed');
});
test('new rows cannot be quietly imported into an unbound legacy report',()=>{
 const r=healthyReport({duration:3});r.final.proof=boundReport(RUN_B).final.proof;
 mustReject900(r);
});
test('plain JSON/accessor/cyclic/nonfinite failures do not escape the verdict',()=>{
 const accessor=healthyReport({duration:3});let reads=0;
 Object.defineProperty(accessor,'measurementRan',{enumerable:true,get(){reads++;throw new Error('read getter');}});
 const cycle=healthyReport({duration:3});cycle.extra=cycle;
 for(const r of [accessor,cycle])assert.doesNotThrow(()=>mustReject900(r));
 assert.equal(reads,0);
});

test('another run proof is rejected by row UUID even with a recomputed trace checksum',()=>{
 const r=boundReport();r.final.proof=boundReport(RUN_B).final.proof;
 r.evidenceSeal.traces.proof={count:2,sha256:createHash('sha256').update(JSON.stringify(r.final.proof)).digest('hex')};
 const v=ingestionBrowserVerdict(r);assert.equal(v.status,'fail');assert.match(v.errors.join(';'),/Trace run proof/);
});

for(const [name,mutate]of [
 ['only renderer cleanup empty',r=>{r.final.cleanup.charts=[];}],
 ['only ring cleanup empty',r=>{r.final.cleanup.queueRingKnownBytes=[];}],
 ['missing worker-created count',r=>{delete r.final.cleanup.workersCreated;}],
 ['missing raw source digest',r=>{delete r.final.proof[0].sourceDigest;}],
 ['missing numerical oracle',r=>{delete r.final.proof[0].studies.rsi.checks;}],
 ['partial finite oracle coverage',r=>{r.final.proof[0].studies.rsi.checks.checked--;}],
 ['missing drawing document',r=>{delete r.final.drawingChecks[0].document;}],
 ['missing async terminal route',r=>{r.final.transitions=r.final.transitions.filter(t=>t.type!=='success-worker-committed-observer');}],
 ['incomplete packet interval',r=>{r.final.packetSamples[1].receipt.firstSequence++;}],
 ['reversed packet timestamp',r=>{r.final.packetSamples[1].at=0;}],
 ['unmatched real input render',r=>{r.final.inputSamples[0].renderAt+=100;r.final.inputSamples[0].inputToNextRenderMs+=100;r.final.inputSamples[0].handlerToNextRenderMs+=100;}],
 ['negative heartbeat gap',r=>{r.final.heartbeat[0].gapMs=-1;}],
 ['finite heartbeat duration shortage',r=>{r.final.heartbeat[0].gapMs=0;}],
 ['out-of-order epoch',r=>{r.final.epochs[1].epoch++;}],
 ['wrong epoch raw OHLC',r=>{r.final.epochs[0].source[0].first.close=1000;}],
 ['another runtime fixture',r=>{r.final.conditions.renderer='webgl2';}]
])test('legacy structural crosscheck rejects '+name,()=>{const r=healthyReport();mutate(r);mustReject900(r);});

for(const [path,select,key]of [
 ['input.eventAt',r=>r.final.inputSamples[0],'eventAt'],
 ['input.handlerAt',r=>r.final.inputSamples[0],'handlerAt'],
 ['input.renderAt',r=>r.final.inputSamples[0],'renderAt'],
 ['input.inputToNextRenderMs',r=>r.final.inputSamples[0],'inputToNextRenderMs'],
 ['input.handlerToNextRenderMs',r=>r.final.inputSamples[0],'handlerToNextRenderMs'],
 ['render.at',r=>r.final.renderSamples[0][0],'at'],
 ['render.cpuSubmitMs',r=>r.final.renderSamples[0][0],'cpuSubmitMs'],
 ['packet.at',r=>r.final.packetSamples[0],'at'],
 ['packet.coreSubmitMs',r=>r.final.packetSamples[0],'coreSubmitMs'],
 ['applied.coreAndQueryMs',r=>r.final.packetSamples[1],'coreAndQueryMs'],
 ['heartbeat.gapMs',r=>r.final.heartbeat[0],'gapMs']
])for(const value of [NaN,Infinity])test(path+' rejects '+String(value)+' temporal evidence',()=>{
 const r=healthyReport({duration:3});select(r)[key]=value;mustReject900(r);
});

for(const [label,mutate]of [
 ['wrong configured packet target',r=>{r.conditions.pressure=false;r.final.conditions.pressure=false;}],
 ['wrong verify-only packet completion',r=>{r.conditions.verifyPackets++;r.final.conditions.verifyPackets++;}]
])test('completed producer schedule rejects '+label,()=>{const r=healthyReport({measured:label.startsWith('wrong configured')});mutate(r);mustReject900(r);});

for(const strategy of ['scalar','atomic'])test('complete direct '+strategy+' route binds two proof/source ledgers without pretending queues/workers ran',()=>{
 const r=directBrowserIngestionReport(strategy),v=ingestionBrowserVerdict(r);
 assert.equal(v.status,'pass',v.errors.join(';'));assert.equal(v.qualifying900Seconds,false);
 r.final.proof[0].stats.lastSequence++;mustReject900(r);
});
test('declared drawing success cannot mask a changed retained seed-price anchor',()=>{
 const r=healthyReport({duration:3}),d=r.final.drawingChecks[0],doc=JSON.parse(d.document);
 doc.drawings[0].points[0].price+=1;d.document=JSON.stringify(doc);mustReject900(r);
});


// Source-only dependency boundary: execute the actual imported runner body,
// relocating only import.meta.url for this controlled Function context. No
// browser, server, filesystem writes, process launches, timers or performance.
function fakeCompletedRunner(options={}){
 const seed=healthyReport(),log=[],writes=[];let storage=options.existing??null,execution;
 const errorFor=name=>options[name] instanceof Error?options[name]:new Error(name+' rejected');
 const browser={
  async send(method){if(options.inputReject&&method==='Input.dispatchMouseEvent')throw errorFor('inputReject');return {};},on(){},async navigate(){},
  async evaluate(code){
   if(code.includes('?.snapshot()'))return {diagnostic:'partial'};
   if(code.includes('if(globalThis.__asterIngestion)')){log.push('fixture-stop');if(options.fixtureReject)throw errorFor('fixtureReject');return null;}
   if(code.includes('ready:'))return {ready:true,failure:null};
   if(code==='navigator.userAgent')return 'source-only-test';
   if(code.includes('querySelectorAll'))return [0,1].map(i=>({left:0,top:i*700,width:1200,height:700}));
   if(code==='__asterIngestion.start()')return null;
   if(code==='__asterIngestion.snapshot()'){
    if(options.workReject)throw errorFor('workReject');
    return {errors:[],done:true,elapsedSeconds:900,producer:seed.final.producer,queues:seed.final.queues,source:seed.final.proof};
   }
   if(code.includes('const r=await __asterIngestion.stop()')){const f=structuredClone(seed.final);f.execution=execution;return f;}
   throw new Error('Unexpected fixture evaluate '+code);
  },
  async close(){log.push('browser-close');if(options.closeReject)throw errorFor('closeReject');}
 };
 const bindings={
  realpath:async value=>value,resolve:x=>x,join:(...p)=>p.join('/'),
  browserIngestionOptions,manifest:async()=>{if(options.sourceReject)throw errorFor('sourceReject');return structuredClone(seed.source);},
  harnessManifest:async()=>structuredClone(seed.harness),assert,browserIngestionExecution,
  mkdir:async()=>{log.push('mkdir');},readFile:async()=>'',URL,
  browserIngestionRuntime:async function sourceOnlyRuntime(){},
  startFixtureServer:async(_root,runtime)=>{
   log.push('server-start');if(options.startReject)throw errorFor('startReject');
   const match=runtime.match(/execution:(\{[^{}]*\})/);execution=JSON.parse(match[1]);
   return {origin:'http://127.0.0.1:1',close:async()=>{log.push('server-close');if(options.serverReject)throw errorFor('serverReject');}};
  },
  launchBrowser:async()=>{log.push('browser-start');return browser;},
  cpus:()=>[{model:'fake'}],release:()=> 'fake',process:{version:'fake',platform:'fake',arch:'fake'},
  ownedMemory:async()=>({heap:{usedSize:1},ownedChromeRSSBytes:1}),delay:async()=>{},trend:()=>null,
  sealBrowserIngestionEvidence,ingestionBrowserVerdict,
  writeFile:async(path,text,flags)=>{
   if(flags?.flag==='wx'&&storage!==null){const e=new Error('EEXIST existing report');e.code='EEXIST';throw e;}
   const r=JSON.parse(text);if(options.failureWriteReject&&r.status==='fail')throw errorFor('failureWriteReject');
   storage=text;writes.push(r);log.push('write-'+r.verdict?.status);
  },
  randomUUID:()=>RUN_A,
 };
 const source=runIngestionBrowser.toString().replaceAll('import.meta.url',JSON.stringify(new URL('./cycle12-ingestion-browser.mjs',import.meta.url).href));
 const actual=new Function(...Object.keys(bindings),'return ('+source+');')(...Object.values(bindings));
 return {log,writes,get text(){return storage;},run:()=>actual({sourceRoot:'/fake-source',output:'/fake-output',conditions:seed.conditions,expectedSourceSHA:options.wrongSourceSHA?'0'.repeat(64):seed.source.sha256})};
}

test('source-only browser close rejection never leaves a positive completed certificate and still closes server',async()=>{
 const f=fakeCompletedRunner({closeReject:true});await assert.rejects(f.run(),/closeReject/);
 assert.ok(f.log.includes('server-close'),'server cleanup survives browser close rejection');
 assert.equal(f.writes.some(r=>r.verdict?.status==='pass'),false,'never write a provisional pass');
 const saved=JSON.parse(f.text);assert.equal(saved.verdict.status,'fail');assert.equal(saved.verdict.qualifying900Seconds,false);mustReject900(saved);
});
test('source-only success writes its positive report only after all mandatory cleanup',async()=>{
 const f=fakeCompletedRunner(),r=await f.run();assert.equal(r.verdict.status,'pass');
 assert.ok(f.log.indexOf('write-pass')>f.log.indexOf('server-close'),'publication follows resource cleanup');
 assert.equal(r.runnerCleanup.completed,true);
 assert.deepEqual(r.runnerCleanup.results.map(x=>x.resource),['fixture-stop','browser-close','input-stop','server-close']);
 assert.ok(r.runnerCleanup.results.every(x=>x.status==='fulfilled'));
});
for(const option of ['fixtureReject','inputReject','serverReject'])test('source-only '+option+' attempts remaining cleanup and saves nonqualification',async()=>{
 const f=fakeCompletedRunner({[option]:true});await assert.rejects(f.run(),new RegExp(option));
 assert.ok(f.log.includes('browser-close'));assert.ok(f.log.includes('server-close'));
 assert.equal(f.writes.some(r=>r.verdict?.status==='pass'),false);
 const saved=JSON.parse(f.text);assert.equal(saved.verdict.status,'fail');mustReject900(saved);
});
test('source-only original work failure keeps error priority over later close rejection',async()=>{
 const workReject=new RangeError('original work'),closeReject=new Error('later cleanup'),f=fakeCompletedRunner({workReject,closeReject});
 await assert.rejects(f.run(),e=>e===workReject);assert.ok(f.log.includes('server-close'));
 const saved=JSON.parse(f.text);assert.equal(saved.failure.message,'original work');
 assert.ok(saved.runnerCleanup.results.some(x=>x.resource==='browser-close'&&x.status==='rejected'));
});
test('source-only reused output rejects before startup and preserves prior certificate bytes',async()=>{
 const existing='prior archive certificate bytes',f=fakeCompletedRunner({existing});
 await assert.rejects(f.run(),/EEXIST|existing.*report/);assert.equal(f.text,existing);
 assert.equal(f.log.includes('browser-start'),false);assert.equal(f.log.includes('server-start'),false);
});
for(const option of ['sourceReject','startReject'])test('source-only '+option+' follows pending claim with an explicit failed certificate',async()=>{
 const f=fakeCompletedRunner({[option]:true});await assert.rejects(f.run(),new RegExp(option));
 const saved=JSON.parse(f.text);assert.equal(saved.status,'fail');assert.equal(saved.verdict.status,'fail');assert.equal(saved.verdict.qualifying900Seconds,false);
 assert.equal(f.writes[0].status,'pending');assert.equal(f.writes[0].verdict.qualifying900Seconds,false);
 assert.equal(f.log.includes('browser-start'),false);
});
test('inner successful model evidence cannot override a failed outer runner cleanup',()=>{
 const r=boundReport();r.status='fail';r.failure={name:'Error',message:'browser close rejected'};
 mustReject900(r);
});
for(const [name,mutate]of [
 ['missing receipt',r=>{delete r.runnerCleanup;}],
 ['incomplete resource list',r=>{r.runnerCleanup.results.pop();}],
 ['failed close flag',r=>{r.runnerCleanup.completed=false;r.runnerCleanup.results[1].status='rejected';}],
 ['wrong resource label',r=>{r.runnerCleanup.results[3].resource='another-run-server';}],
 ['pending outer status',r=>{r.status='pending';}]
])test('fresh execution verdict rejects '+name+' before trace-seal checks',()=>{
 const r=boundReport();mutate(r);const v=ingestionBrowserVerdict(r);
 assert.equal(v.status,'fail');assert.equal(v.qualifying900Seconds,false);
 assert.ok(!v.errors.some(e=>e.startsWith('Trace coverage')),'required runner state has its own guard');
});

test('failed-certificate write rejection is exposed while a pending claim stays nonqualifying',async()=>{
 const closeReject=new Error('primary close failed'),f=fakeCompletedRunner({closeReject,failureWriteReject:true});
 await assert.rejects(f.run(),e=>e===closeReject&&e.reportWriteFailure?.message==='failureWriteReject rejected');
 const saved=JSON.parse(f.text);assert.equal(saved.status,'pending');assert.equal(saved.verdict.qualifying900Seconds,false);mustReject900(saved);
 assert.ok(f.log.includes('server-close'));
});

test('source-only frozen-source mismatch is a failed fresh attempt after pending claim',async()=>{
 const f=fakeCompletedRunner({wrongSourceSHA:true});await assert.rejects(f.run(),/Frozen source SHA/);
 assert.equal(f.writes[0].status,'pending');const saved=JSON.parse(f.text);assert.equal(saved.verdict.status,'fail');assert.equal(saved.verdict.qualifying900Seconds,false);
 assert.equal(f.log.includes('server-start'),false);assert.equal(f.log.includes('browser-start'),false);
});
test('source-only second execution cannot reuse the first successful output certificate',async()=>{
 const f=fakeCompletedRunner();await f.run();const original=f.text;await assert.rejects(f.run(),/existing.*report/);
 assert.equal(f.text,original);assert.equal(f.log.filter(x=>x==='server-start').length,1);assert.equal(f.log.filter(x=>x==='browser-start').length,1);
});
