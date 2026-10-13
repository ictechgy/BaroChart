import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import {join,resolve} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
import {validatePressureReport,assertFreshPressureOutput,finalizePressureCompletion} from './android-ingestion-contract.mjs';
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),adb=join(sdk,'platform-tools/adb');
const port=process.env.ASTER_INGESTION_ADB_PORT??'5038',serial=process.env.ASTER_INGESTION_SERIAL??'emulator-5580';if(port!=='5038'||serial!=='emulator-5580')throw new Error('This local runner is scoped to owned5580/privateADB5038');
const dir=resolve(process.env.ASTER_INGESTION_BUILD??'/tmp/aster-cycle12-android/pressure-build'),resultDir=resolve(process.env.ASTER_INGESTION_RESULTS??'/tmp/aster-cycle12-android/pilot');
if(!resultDir.startsWith('/tmp/aster-cycle12-android/'))throw new Error('Private cycle12 /tmp results required');await mkdir(resultDir,{recursive:true});
const duration=process.argv.includes('--approved-long-run')?900000:30000,mode=process.argv.includes('--sdk')?'sdk':process.argv.includes('--timezone')?'timezone':'pressure';
if(mode==='pressure')assertFreshPressureOutput(await readdir(resultDir));
if(duration===900000&&!process.argv.includes('--quiet-go'))throw new Error('900s requires explicit coordinator --quiet-go; functional pilot is the default');
const pkg='dev.aster.charts.ingestion.pressure',manifest=JSON.parse(await readFile(join(dir,'build-manifest.json'),'utf8'));
if(createHash('sha256').update(await readFile(manifest.apk)).digest('hex')!==manifest.apkSHA256)throw new Error('Selected APK changed after manifest freeze');
const componentProof=spawnSync('python3',['-c','import zipfile,sys,json,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:print(json.dumps({k:hashlib.sha256(z.read(k)).hexdigest() for k in ["assets/aster-core.js","lib/arm64-v8a/libaster.so"]}))',manifest.apk],{encoding:'utf8'});if(componentProof.status!==0)throw new Error('APK component inspection failed');const components=JSON.parse(componentProof.stdout);if(components['assets/aster-core.js']!==manifest.coreSHA256||components['lib/arm64-v8a/libaster.so']!==manifest.jniSHA256)throw new Error('Frozen APK core/JNI differs from build manifest');
const env={...process.env,ANDROID_USER_HOME:process.env.ANDROID_USER_HOME??'/tmp/aster-cycle7-android-user',ADB_VENDOR_KEYS:process.env.ADB_VENDOR_KEYS??'/tmp/aster-cycle7-adb-keys/adbkey'};
const run=(args,optional=false)=>{const r=spawnSync(adb,['-P',port,'-s',serial,...args],{env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});if((r.status!==0||r.error)&&!optional)throw new Error(`adb ${args.join(' ')}: ${r.error??r.stderr}`);return r;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const snapshot=name=>{const r=run(['shell','run-as',pkg,'cat',`files/${name}`],true);if(r.status!==0)return null;try{return {report:JSON.parse(r.stdout),bytes:Buffer.from(r.stdout,'utf8')};}catch{return null;}};const file=name=>snapshot(name)?.report??null;
const avd=run(['emu','avd','name']).stdout.trim().split(/\r?\n/)[0];if(avd!=='aster-validation')throw new Error('AVD identity mismatch');
const inputs=[];let report,pressureAcceptance=null,pressureRunner;
if(mode!=='pressure'){run(['install','-r',manifest.apk]);run(['shell','am','force-stop',pkg]);}
try{
 if(mode!=='pressure'){
  const raw=run(['shell','am','instrument','-w','-e','mode',mode,`${pkg}/dev.aster.charts.IngestionInstrumentation`]);await writeFile(join(resultDir,`${mode}-instrumentation.txt`),raw.stdout+raw.stderr);report=file(`${mode}-functional.json`);if(!report)throw new Error('Missing SDK functional report');
 }else{
  pressureRunner={mode,duration,build:manifest,avd,serial,privateADBPort:port,systemInputCommands:inputs,physicalDevice:false,comparativePerformance:false};
  await finalizePressureCompletion({runnerManifest:pressureRunner,
   persist:async value=>writeFile(join(resultDir,'runner-manifest.json'),JSON.stringify(value,null,2)+'\n'),
   cleanupSteps:[{name:'force-stop',run:async()=>run(['shell','am','force-stop',pkg],true)}],
   emitPassed:async()=>console.log(JSON.stringify({passed:true,mode,checks:report.checkCount??report.checks?.length,resultDir})),
   validate:async()=>{
  run(['install','-r',manifest.apk]);run(['shell','am','force-stop',pkg]);
  run(['shell','run-as',pkg,'rm','-f','files/progress.json','files/final.json']);run(['shell','am','start','-W','-n',`${pkg}/dev.aster.charts.IngestionActivity`,'--el','duration',String(duration)]);
  let progress;const readyDeadline=Date.now()+240000;while(Date.now()<readyDeadline){progress=file('progress.json');if(progress?.state==='running')break;if(progress?.state==='failed')throw new Error(progress.error);await sleep(500);}if(progress?.state!=='running')throw new Error('Preparation did not become ready');
  const [x,y,w,h]=progress.chartBounds;if(!(w>100&&h>100))throw new Error('Visible chart bounds invalid');const started=Date.now();let ordinal=0;
  console.log(`RUNNING ${duration}ms; app device start=${progress.startUptimeMs}; external OS input only`);
  while(Date.now()-started<duration){const current=file('progress.json');if(current?.state==='complete'||current?.state==='failed')break;
   const a=[Math.round(x+w*.25),Math.round(y+h*.18)],b=[Math.round(x+w*.60),Math.round(y+h*.18)];const command=ordinal%3===2?['input','touchscreen','swipe',...a.map(String),...b.map(String),'120']:['input','touchscreen','tap',String(Math.round(x+w*(ordinal%2===0?.25:.55))),String(Math.round(y+h*.18))];
   const before=Date.now();const r=run(['shell',...command]);inputs.push({ordinal:ordinal++,command,hostStartedUnixMs:before,hostFinishedUnixMs:Date.now(),exit:r.status,scope:'ADB shell Android input service; host command roundtrip is not device event latency'});if(ordinal%30===0)console.log(`input${ordinal} elapsed${Date.now()-started}ms`);await sleep(600);
  }
  let final;const finalDeadline=Date.now()+240000;while(Date.now()<finalDeadline){final=snapshot('final.json');if(final)break;await sleep(500);}if(!final)throw new Error('Final scalar/vector validation timed out');report=final.report;
  await writeFile(join(resultDir,'pressure-raw.json'),final.bytes);
  pressureRunner.pressureEvidence={rawSHA256:createHash('sha256').update(final.bytes).digest('hex'),traceSHA256:[]};
  const traces=[];
   if(!report.passed)throw new Error(report.error??'Functional assertion failed');
   for(let stream=0;stream<2;stream++){
    const r=spawnSync(adb,['-P',port,'-s',serial,'exec-out','run-as',pkg,'cat',`files/applied-${stream}.bin`],{env,maxBuffer:16*1024*1024,timeout:120000});if(r.status!==0||r.error)throw new Error('Binary trace missing: '+stream);
    const bytes=r.stdout;await writeFile(join(resultDir,`applied-${stream}.bin`),bytes);traces.push({stream,bytes});pressureRunner.pressureEvidence.traceSHA256.push({stream,sha256:createHash('sha256').update(bytes).digest('hex')});
   }
   validatePressureReport(report,duration,{runnerManifest:pressureRunner,expectedBuild:manifest,rawReportBytes:final.bytes,traces});
   pressureAcceptance={requestedMs:duration,observedMs:report.durationObservedMs,capturedInputs:report.probe.inputCount,matchedCpuSubmitN:report.probe.rawInputRows.length,unmatchedStopBoundaryInputs:report.probe.unmatchedInputRowsAtEnd,inputSampleDrops:report.probe.inputSampleDrops,note:'Matched latency quantiles use matchedCpuSubmitN; accounted deadline-pending inputs have no CPU-submit sample and are reported separately.'};
   pressureRunner.pressureAcceptance=pressureAcceptance;
   }});
 }
 if(mode!=='pressure'){await writeFile(join(resultDir,`${mode}-raw.json`),JSON.stringify(report,null,2)+'\n');await writeFile(join(resultDir,'runner-manifest.json'),JSON.stringify({mode,duration,build:manifest,avd,serial,privateADBPort:port,systemInputCommands:inputs,pressureAcceptance,physicalDevice:false,comparativePerformance:false},null,2)+'\n');if(!report.passed)throw new Error(report.error??'Functional assertion failed');console.log(JSON.stringify({passed:true,mode,checks:report.checkCount??report.checks?.length,resultDir}));}
}finally{if(mode!=='pressure')run(['shell','am','force-stop',pkg],true);}
