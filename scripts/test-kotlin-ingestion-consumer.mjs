import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gradleEnvironment,gradleRun,projectRoot,arg,auditAar,sha} from './build-android-library.mjs';
import {readFinalConsumerReport} from './kotlin-consumer-contract.mjs';

const output=resolve(arg('--out','/tmp/aster-kotlin-ingestion-consumer'));
const core=resolve(arg('--core',join(projectRoot,'native/Resources/aster-core.js')));
const aar=resolve(arg('--aar','/tmp/aster-android-sdk/aster-charts.aar'));
const project=join(projectRoot,'examples/kotlin-ingestion-consumer');
const variant=arg('--variant','debug');if(!['debug','release'].includes(variant))throw new Error('Select debug or release');
await mkdir(output,{recursive:true});
const sourceFiles=['settings.gradle','build.gradle','app/build.gradle','app/src/main/AndroidManifest.xml','app/src/main/kotlin/dev/aster/ingestion/consumer/ConsumerActivity.kt'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,sha(await readFile(join(project,file)))])));
const sources=await sourceHashes(),audit=auditAar(aar,core);
let apk=arg('--apk'),build;
if(!apk){
 const environment=await gradleEnvironment(output);
 gradleRun(environment,project,output,[':app:assembleDebug',':app:assembleRelease'],{consumerBuildRoot:join(output,'build'),asterAar:aar,asterDebugKeystore:process.env.ASTER_ANDROID_DEBUG_KEYSTORE??join(projectRoot,'artifacts/android/debug.jks')});
 if(JSON.stringify(await sourceHashes())!==JSON.stringify(sources))throw new Error('Consumer source changed during build');
 const apks={};for(const name of ['debug','release']){const path=join(output,`aster-kotlin-ingestion-${name}.apk`);await copyFile(join(output,`build/app/outputs/apk/${name}/app-${name}.apk`),path);apks[name]={path,sha256:sha(await readFile(path))};}
 build={aar,aarSHA256:sha(await readFile(aar)),coreSHA256:audit.coreSHA256,sdkVersion:audit.sdkVersion,sources,apks,gradle:'8.14.5',agp:'8.13.2',kotlin:'2.4.10',scope:'Independent small Kotlin app consumes local AAR; no production Java/source copy, benchmark, or inherited large-fixture assertion count'};
 await writeFile(join(output,'ingestion-consumer-build.json'),JSON.stringify(build,null,2));apk=build.apks[variant].path;
}else{
 build=JSON.parse(await readFile(join(output,'ingestion-consumer-build.json'),'utf8'));
 if(JSON.stringify(build.sources)!==JSON.stringify(sources)||build.coreSHA256!==audit.coreSHA256||build.aarSHA256!==sha(await readFile(aar))||build.apks[variant].sha256!==sha(await readFile(resolve(apk))))throw new Error('Selected APK does not match frozen consumer sources/AAR/core');
}
const inspected=spawnSync('python3',['-c',String.raw`
import zipfile,hashlib,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 for name in ['classes.dex','assets/aster-core.js','lib/arm64-v8a/libaster.so','assets/licenses/QUICKJS-LICENSE.txt','assets/licenses/LICENSE.txt','assets/licenses/NOTICE.txt']:
  if name not in z.namelist():raise ValueError('Missing consumer APK component: '+name)
 print(json.dumps({'coreSHA256':hashlib.sha256(z.read('assets/aster-core.js')).hexdigest(),'jniSHA256':hashlib.sha256(z.read('lib/arm64-v8a/libaster.so')).hexdigest()}))
`,resolve(apk)],{encoding:'utf8'});
if(inspected.status!==0)throw new Error(inspected.stderr);
const archive=JSON.parse(inspected.stdout);if(archive.coreSHA256!==audit.coreSHA256||archive.jniSHA256!==audit.jniSHA256)throw new Error('Consumer APK core/JNI differs from selected frozen AAR');
await writeFile(join(output,`ingestion-consumer-${variant}-package.json`),JSON.stringify({apk:resolve(apk),apkSHA256:sha(await readFile(apk)),variant,...archive,...build},null,2));
if(process.argv.includes('--build-only')){console.log(JSON.stringify({apk,variant,...archive,sdkVersion:audit.sdkVersion}));process.exit(0);}

const serial=process.env.ASTER_ANDROID_SERIAL,adbPort=process.env.ASTER_ANDROID_ADB_PORT;
if(!/^emulator-\d+$/.test(serial??'')||!Number.isInteger(Number(adbPort))||Number(adbPort)<1||Number(adbPort)>65535)throw new Error('Explicit owned emulator serial and private ASTER_ANDROID_ADB_PORT required');
const sdk=process.env.ANDROID_SDK_ROOT??process.env.ANDROID_HOME??join(process.env.HOME,'Library/Android/sdk');
const adb=args=>{const result=spawnSync(join(sdk,'platform-tools/adb'),['-P',adbPort,'-s',serial,...args],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout;};
const api=Number(adb(['shell','getprop','ro.build.version.sdk']).trim()),abi=adb(['shell','getprop','ro.product.cpu.abi']).trim();
if(api!==36||abi!=='arm64-v8a')throw new Error('Expected owner-approved API36 arm64 emulator');
const pkg='dev.aster.ingestion.consumer',file='files/ingestion-consumer-validation.json';let report;
try{
 adb(['shell','am','force-stop',pkg]);adb(['install','-r',resolve(apk)]);adb(['shell','run-as',pkg,'rm','-f',file]);
 adb(['shell','am','start','-n',`${pkg}/${pkg}.ConsumerActivity`]);
 for(let attempt=0;attempt<120;attempt++){
  try{report=JSON.parse(adb(['exec-out','run-as',pkg,'cat',file]));if(typeof report?.failed==='boolean')break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
}finally{adb(['shell','am','force-stop',pkg]);}
report??={failed:true,error:'No ingestion consumer report after bounded launch wait'};
report=readFinalConsumerReport(report,()=>adb(['exec-out','run-as',pkg,'cat',file]));
report.execution={serial,adbPort,api,abi,variant,minified:variant==='release',apk:resolve(apk),apkSHA256:sha(await readFile(apk)),...archive};
await writeFile(join(output,`ingestion-consumer-${variant}-validation.json`),JSON.stringify(report,null,2));
const required=['typed-configure','owned-prefix','typed-pause-resume-drain','typed-errors-cancel','typed-readonly-save-load','async-policy-handoff','close'];
if(report.failed!==false||report.schema!=='aster.kotlin-ingestion-consumer'||report.version!==1||report.sdkVersion!==audit.sdkVersion||!Array.isArray(report.scenarios)||new Set(report.scenarios).size!==report.scenarios.length||required.some(id=>!report.scenarios.includes(id))||report.terminals!==1||report.jobs?.length!==1||report.jobs[0].status!=='success'||report.jobs[0].error!=null||report.sourceClosed!==true||report.targetClosed!==true||!Array.isArray(report.checks)||report.passed!==report.checks.length)throw new Error(report.error??'Small Kotlin ingestion public contracts incomplete');
console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios,terminals:report.terminals,progressCallbacks:report.progressCallbacks,variant,report:join(output,`ingestion-consumer-${variant}-validation.json`)}));
