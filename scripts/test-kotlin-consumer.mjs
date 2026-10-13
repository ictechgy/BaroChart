import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gradleEnvironment,gradleRun,projectRoot,arg,auditAar,sha} from './build-android-library.mjs';
import {readFinalConsumerReport,validateKotlinConsumerReport} from './kotlin-consumer-contract.mjs';

const output=resolve(arg('--out',process.env.ASTER_KOTLIN_CONSUMER_OUT??'/tmp/aster-kotlin-consumer'));
await mkdir(output,{recursive:true});
const core=resolve(arg('--core',process.env.ASTER_ANDROID_LIBRARY_CORE??join(projectRoot,'native/Resources/aster-core.js')));
const aar=resolve(arg('--aar',process.env.ASTER_ANDROID_LIBRARY_AAR??'/tmp/aster-android-sdk/aster-charts.aar'));
const selectedVariant=arg('--variant','debug');if(!['debug','release'].includes(selectedVariant))throw new Error('Select debug or release');
const studyConsumer=process.argv.includes('--studies');
const consumerProject=join(projectRoot,studyConsumer?'examples/kotlin-study-consumer':'examples/kotlin-consumer');
let buildReport;
let apk=arg('--apk');
if(!apk){
    let audit=auditAar(aar,core);
    const environment=await gradleEnvironment(output);
    const projectDependency=process.argv.includes('--project-dependency');
    const properties={consumerBuildRoot:join(output,'build'),asterDebugKeystore:process.env.ASTER_ANDROID_DEBUG_KEYSTORE??join(projectRoot,'artifacts/android/debug.jks')};
    if(projectDependency)Object.assign(properties,{asterProjectDependency:true,asterCoreFile:core,asterVersion:arg('--sdk-version',audit.sdkVersion)});
    else properties.asterAar=aar;
    gradleRun(environment,consumerProject,output,[...(projectDependency?[':aster:assembleRelease']:[]),':app:assembleDebug',':app:assembleRelease'],properties);
    const consumedAar=projectDependency?join(output,'build/aster/outputs/aar/aster-release.aar'):aar;
    if(projectDependency)audit=auditAar(consumedAar,core,environment.javaHome);
    for(const variant of ['debug','release'])await copyFile(join(output,`build/app/outputs/apk/${variant}/app-${variant}.apk`),join(output,`aster-kotlin-${variant}.apk`));
    apk=join(output,`aster-kotlin-${selectedVariant}.apk`);
    buildReport={aar:consumedAar,aarSHA256:sha(await readFile(consumedAar)),coreSHA256:audit.coreSHA256,sdkVersion:audit.sdkVersion,versionResource:true,gradle:'8.14.5',agp:'8.13.2',kotlin:'2.4.10',projectDependency,studyConsumer,consumerProject,source:'Independent dev.aster.consumer Kotlin application; Gradle app consumes local AAR or library project; no copied production Java or demo sources'};
    await writeFile(join(output,'consumer-build.json'),JSON.stringify(buildReport,null,2));
}
const inspect=spawnSync('python3',['-c',String.raw`
import zipfile,json,sys,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist()
 for name in ['classes.dex','assets/aster-core.js','lib/arm64-v8a/libaster.so','assets/licenses/QUICKJS-LICENSE.txt','assets/licenses/LICENSE.txt','assets/licenses/NOTICE.txt']:
  if name not in names:raise ValueError('Missing consumer APK component:'+name)
 print(json.dumps({'coreSHA256':hashlib.sha256(z.read('assets/aster-core.js')).hexdigest(),'jniSHA256':hashlib.sha256(z.read('lib/arm64-v8a/libaster.so')).hexdigest(),'apkEntries':len(names)}))
`,resolve(apk)],{encoding:'utf8'});
if(inspect.status!==0)throw new Error(inspect.stderr);
const archive=JSON.parse(inspect.stdout);if(archive.coreSHA256!==sha(await readFile(core)))throw new Error('Consumer APK bundled core does not match selected frozen core');
await writeFile(join(output,`consumer-${selectedVariant}-package.json`),JSON.stringify({apk:resolve(apk),apkSHA256:sha(await readFile(apk)),variant:selectedVariant,minified:selectedVariant==='release',...archive,...buildReport},null,2));
if(process.argv.includes('--build-only')){console.log(JSON.stringify({apk,variant:selectedVariant,...archive,...buildReport}));process.exit(0);}

const serial=process.env.ASTER_ANDROID_SERIAL;if(!serial)throw new Error('Explicit ASTER_ANDROID_SERIAL required for consumer execution');
if(!serial.startsWith('emulator-'))throw new Error('This validation fixture requires an explicitly selected owned emulator');
const adbPort=process.env.ASTER_ANDROID_ADB_PORT;if(!adbPort)throw new Error('Explicit ASTER_ANDROID_ADB_PORT required; use the owner-approved private adb server');
const sdk=process.env.ANDROID_SDK_ROOT??process.env.ANDROID_HOME??join(process.env.HOME,'Library/Android/sdk');
const adb=(args,optional=false)=>{const result=spawnSync(join(sdk,'platform-tools/adb'),['-P',adbPort,'-s',serial,...args],{encoding:'utf8'});if(result.status!==0&&!optional)throw new Error(result.stderr||result.stdout);return result.stdout;};
const api=Number(adb(['shell','getprop','ro.build.version.sdk']).trim()),abi=adb(['shell','getprop','ro.product.cpu.abi']).trim();
if(api!==36||abi!=='arm64-v8a')throw new Error(`Expected owner-approved API36arm64 emulator; got ${api} ${abi}`);
const pkg='dev.aster.consumer',component=`${pkg}/${pkg}.ConsumerActivity`;
adb(['shell','am','force-stop',pkg]);adb(['install','-r',resolve(apk)]);
adb(['shell','run-as',pkg,'rm','-f','files/kotlin-consumer-validation.json','files/kotlin-consumer-ready.json','files/kotlin-consumer-lifecycle.json']);
adb(['shell','am','start','-n',component,'--ez','sdk-self-test','true']);
let report,ready;
for(let attempt=0;attempt<120;attempt++){
    try{report=JSON.parse(adb(['exec-out','run-as',pkg,'cat','files/kotlin-consumer-validation.json'],true));if(report.failed)break;}catch{}
    try{ready=JSON.parse(adb(['exec-out','run-as',pkg,'cat','files/kotlin-consumer-ready.json'],true));if(ready.stage==='await-background')break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
}
if(ready&&!report?.failed){
    adb(['shell','input','keyevent','KEYCODE_HOME']);
    let stopped=false;
    for(let attempt=0;attempt<40;attempt++){
        try{const lifecycle=JSON.parse(adb(['exec-out','run-as',pkg,'cat','files/kotlin-consumer-lifecycle.json'],true));if(lifecycle.events.includes('stop:1')){stopped=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!stopped)throw new Error('Consumer did not observe actual onStop after HOME');
    adb(['shell','am','start','--activity-single-top','--activity-reorder-to-front','-n',component,'--ez','sdk-self-test','true']);
    for(let attempt=0;attempt<60;attempt++){
        try{report=JSON.parse(adb(['exec-out','run-as',pkg,'cat','files/kotlin-consumer-validation.json'],true));break;}catch{}
        await new Promise(resolve=>setTimeout(resolve,500));
    }
}
report??={failed:true,error:'No consumer validation report after bounded launch/lifecycle waits'};
adb(['shell','am','force-stop',pkg]);
// A callback can fail after the first completed report was read. Stop the app,
// then fetch its final file while preserving any already observed failure.
report=readFinalConsumerReport(report,()=>adb(['exec-out','run-as',pkg,'cat','files/kotlin-consumer-validation.json']));
report.execution={apk:resolve(apk),apkSHA256:sha(await readFile(apk)),serial,adbPort,api,abi,variant:selectedVariant,minified:selectedVariant==='release',...archive};
await writeFile(join(output,`consumer-${selectedVariant}-validation.json`),JSON.stringify(report,null,2));
const expectedVersion=arg('--sdk-version',buildReport?.sdkVersion);
validateKotlinConsumerReport(report,{studies:studyConsumer,expectedVersion});
console.log(JSON.stringify({passed:report.passed,terminals:report.terminals,activityGenerations:report.activityGenerations,variant:selectedVariant,serial,report:join(output,`consumer-${selectedVariant}-validation.json`)}));
