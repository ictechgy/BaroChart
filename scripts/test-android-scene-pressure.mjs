import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {validatePressureReport,finalizePressureCompletion} from './android-ingestion-contract.mjs';
import {confirmOwnedPackageAbsent} from './android-scene-cleanup.mjs';
import {validateSceneTransport} from './android-scene-pressure-contract.mjs';

const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),adb=join(sdk,'platform-tools/adb');
const port=process.env.ASTER_INGESTION_ADB_PORT??'5038',serial=process.env.ASTER_INGESTION_SERIAL??'emulator-5580';
if(port!=='5038'||serial!=='emulator-5580')throw new Error('Runner is scoped to owned5580/privateADB5038');
const dir=resolve(process.env.ASTER_PACKET_BUILD??'/tmp/aster-cycle13-android/pressure-candidate-build');
const resultDir=resolve(process.env.ASTER_PACKET_RESULTS??'/tmp/aster-cycle13-android/pressure-candidate-pilot');
if(![dir,resultDir].every(p=>p.startsWith('/tmp/aster-cycle13-android/')))throw new Error('Private cycle13 /tmp paths required');
// Guard precedes all fallible ADB startup/preparation. Never reuse old evidence.
try{await access(resultDir);throw new Error('Results exist; choose a fresh immutable attempt');}catch(error){if(error.code!=='ENOENT')throw error;}
const duration=process.argv.includes('--approved-long-run')?900000:process.argv.includes('--short')?60000:30000;
if(duration!==30000&&!process.argv.includes('--quiet-go'))throw new Error('Comparative/900s sampling requires coordinator --quiet-go');
if(process.argv.includes('--sdk')||process.argv.includes('--timezone'))throw new Error('Pressure-only runner; SDK/timezone use preserved runners');
const pkg='dev.aster.charts.packet.pressure',manifest=JSON.parse(await readFile(join(dir,'build-manifest.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(await readFile(manifest.apk))!==manifest.apkSHA256)throw new Error('Selected APK changed after manifest freeze');
if(manifest.pressure!==true||manifest.pkg!==pkg)throw new Error('Selected APK is not a frozen pressure fixture');
const componentProof=spawnSync('python3',['-c','import zipfile,sys,json,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:print(json.dumps({k:hashlib.sha256(z.read(k)).hexdigest() for k in ["assets/aster-core.js","lib/arm64-v8a/libaster.so"]}))',manifest.apk],{encoding:'utf8'});
if(componentProof.status!==0||componentProof.error)throw new Error('APK component inspection failed');
const components=JSON.parse(componentProof.stdout);
if(components['assets/aster-core.js']!==manifest.coreSHA256||components['lib/arm64-v8a/libaster.so']!==manifest.jniSHA256)throw new Error('Frozen APK core/JNI differs from build manifest');
const guardSources=[new URL(import.meta.url),new URL('./android-ingestion-contract.mjs',import.meta.url),new URL('./android-scene-cleanup.mjs',import.meta.url),new URL('./android-scene-pressure-contract.mjs',import.meta.url)];
const guardHashes=await Promise.all(guardSources.map(async url=>sha(await readFile(url))));
const env={...process.env,ANDROID_USER_HOME:process.env.ANDROID_USER_HOME??'/tmp/aster-cycle7-android-user',ADB_VENDOR_KEYS:process.env.ADB_VENDOR_KEYS??'/tmp/aster-cycle7-adb-keys/adbkey'};
const run=(args,optional=false)=>{
 const result=spawnSync(adb,['-P',port,'-s',serial,...args],{env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
 if((result.status!==0||result.error)&&!optional)throw new Error(`adb ${args.join(' ')}: ${result.error??result.stderr}`);
 return result;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const snapshot=name=>{const result=run(['shell','run-as',pkg,'cat',`files/${name}`],true);if(result.status!==0||result.error)return null;try{return {report:JSON.parse(result.stdout),bytes:Buffer.from(result.stdout,'utf8')};}catch{return null;}};
const file=name=>snapshot(name)?.report??null;
const runId=randomUUID(),inputs=[];let report,ownershipConfirmed=false;
await mkdir(resultDir,{recursive:true});
const runner={mode:'pressure',duration,runId,transport:manifest.transport,build:manifest,avd:null,serial,privateADBPort:port,systemInputCommands:inputs,physicalDevice:false,comparativePerformance:false,newCommonDiagnosticFixture:true,sourceGuard:{runnerSHA256:guardHashes[0],validatorSHA256:guardHashes[1],cleanupHelperSHA256:guardHashes[2],transportHelperSHA256:guardHashes[3]}};
const requireOwnership=operation=>ownershipConfirmed?operation():{status:null,error:'Owned AVD identity unconfirmed; cleanup skipped',stdout:'',stderr:''};
await finalizePressureCompletion({runnerManifest:runner,
 persist:async value=>writeFile(join(resultDir,'runner-manifest.json'),JSON.stringify(value,null,2)+'\n'),
 cleanupSteps:[
  {name:'force-stop',run:async()=>requireOwnership(()=>run(['shell','am','force-stop',pkg],true))},
  {name:'owned-app-process-inventory',run:async()=>requireOwnership(()=>confirmOwnedPackageAbsent(run(['shell','ps','-A','-o','PID,NAME'],true),pkg))}
 ],
 emitPassed:async()=>console.log(JSON.stringify({passed:true,mode:'pressure',checks:report.checkCount??report.checks?.length,resultDir})),
 validate:async()=>{
  const avd=run(['emu','avd','name']).stdout.trim().split(/\r?\n/)[0];
  if(avd!=='aster-validation')throw new Error('AVD identity mismatch');ownershipConfirmed=true;runner.avd=avd;
  run(['install','-r',manifest.apk]);run(['shell','am','force-stop',pkg]);
  run(['shell','run-as',pkg,'rm','-f','files/progress.json','files/final.json']);
  run(['shell','am','start','-W','-n',`${pkg}/dev.aster.charts.ScenePressureActivity`,'--el','duration',String(duration),'--es','runId',runId,'--es','transport',manifest.transport]);
  let progress;const readyDeadline=Date.now()+240000;
  while(Date.now()<readyDeadline){progress=file('progress.json');if(progress?.state==='running')break;if(progress?.state==='failed')throw new Error(progress.error);await sleep(500);}
  if(progress?.state!=='running')throw new Error('Preparation did not become ready');
  const [x,y,w,h]=progress.chartBounds;if(!(w>100&&h>100))throw new Error('Visible chart bounds invalid');
  const started=Date.now();let ordinal=0;
  console.log(`RUNNING ${duration}ms; app device start=${progress.startUptimeMs}; external OS input only`);
  while(Date.now()-started<duration){
   const current=file('progress.json');if(current?.state==='complete'||current?.state==='failed')break;
   const a=[Math.round(x+w*.25),Math.round(y+h*.18)],b=[Math.round(x+w*.60),Math.round(y+h*.18)];
   const command=ordinal%3===2?['input','touchscreen','swipe',...a.map(String),...b.map(String),'120']:['input','touchscreen','tap',String(Math.round(x+w*(ordinal%2===0?.25:.55))),String(Math.round(y+h*.18))];
   const before=Date.now(),result=run(['shell',...command]);
   inputs.push({ordinal:ordinal++,command,hostStartedUnixMs:before,hostFinishedUnixMs:Date.now(),exit:result.status,scope:'ADB shell Android input service; host command roundtrip is not device event latency'});
   if(ordinal%30===0)console.log(`input${ordinal} elapsed${Date.now()-started}ms`);await sleep(600);
  }
  let final;const finalDeadline=Date.now()+240000;
  while(Date.now()<finalDeadline){final=snapshot('final.json');if(final)break;await sleep(500);}
  if(!final)throw new Error('Final scalar/vector validation timed out');report=final.report;
  await writeFile(join(resultDir,'pressure-raw.json'),final.bytes);
  runner.pressureEvidence={rawSHA256:sha(final.bytes),traceSHA256:[]};
  if(!report.passed)throw new Error(report.error??'Functional assertion failed');
  const traces=[];
  for(let stream=0;stream<2;stream++){
   const result=spawnSync(adb,['-P',port,'-s',serial,'exec-out','run-as',pkg,'cat',`files/applied-${stream}.bin`],{env,maxBuffer:16*1024*1024,timeout:120000});
   if(result.status!==0||result.error)throw new Error('Binary trace missing: '+stream);
   const bytes=result.stdout;await writeFile(join(resultDir,`applied-${stream}.bin`),bytes);traces.push({stream,bytes});runner.pressureEvidence.traceSHA256.push({stream,sha256:sha(bytes)});
  }
  for(let i=0;i<guardSources.length;i++)if(sha(await readFile(guardSources[i]))!==guardHashes[i])throw new Error('Runner/validator/cleanup source changed during run');
  if(sha(await readFile(manifest.apk))!==manifest.apkSHA256)throw new Error('APK changed during run');
  validatePressureReport(report,duration,{runnerManifest:runner,expectedBuild:manifest,expectedRunId:runId,rawReportBytes:final.bytes,traces});
  validateSceneTransport(report,manifest.transport);
  runner.pressureAcceptance={requestedMs:duration,observedMs:report.durationObservedMs,capturedInputs:report.probe.inputCount,matchedCpuSubmitN:report.probe.rawInputRows.length,unmatchedStopBoundaryInputs:report.probe.unmatchedInputRowsAtEnd,inputSampleDrops:report.probe.inputSampleDrops,note:'Matched latency uses matchedCpuSubmitN; accounted deadline-pending inputs have no CPU-submit sample and are reported separately.'};
 }
});
