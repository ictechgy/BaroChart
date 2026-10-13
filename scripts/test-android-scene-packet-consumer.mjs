import {cp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {gradleEnvironment,gradleRun,projectRoot,auditAar,sha} from './build-android-library.mjs';
import {validateKotlinConsumerReport} from './kotlin-consumer-contract.mjs';
import {finalizePressureCompletion} from './android-ingestion-contract.mjs';
import {confirmOwnedPackageAbsent} from './android-scene-cleanup.mjs';
const out=resolve(process.env.ASTER_PACKET_CONSUMER_OUT??'/tmp/aster-cycle13-android/r8-obfuscated');
if(!out.startsWith('/tmp/aster-cycle13-android/'))throw new Error('Private cycle13 consumer path required');
try{await access(out);throw new Error('Choose a new immutable attempt directory');}catch(error){if(error.code!=='ENOENT')throw error;}
const aar=resolve(process.env.ASTER_PACKET_AAR??'/tmp/aster-cycle13-android/sdk-final-2/aster-charts.aar'),core=resolve(process.env.ASTER_PACKET_CORE??join(projectRoot,'native/Resources/aster-core.js'));
await mkdir(out,{recursive:true});const audit=auditAar(aar,core);const project=join(out,'project');await cp(join(projectRoot,'examples/kotlin-consumer'),project,{recursive:true,filter:path=>!['build','.gradle'].includes(path.split('/').at(-1))});
const activity=join(project,'app/src/main/kotlin/dev/aster/consumer/ConsumerActivity.kt');let source=await readFile(activity,'utf8');const marker='check(chart.renderCacheMetrics().getLong("ownedBitmapBytes") > 0, "consumer View owns admitted render cache")';assert.equal(source.split(marker).length,2);
source=source.replace(marker,marker+'\n            check(chart.renderCacheMetrics().getLong("packetFrames") > 0, "nondebuggable R8 View uses typed JNI packets")\n            check(chart.renderCacheMetrics().getLong("packetFailures") == 0L, "nondebuggable R8 typed path has zero fallback")\n            ConsumerRun.closed.put("packetTransport", chart.renderCacheMetrics())');await writeFile(activity,source);
const gradle=join(project,'app/build.gradle');await writeFile(gradle,(await readFile(gradle,'utf8')).replace('debuggable true','debuggable false'));
const manifest=join(project,'app/src/main/AndroidManifest.xml');await writeFile(manifest,(await readFile(manifest,'utf8')).replace('</manifest>','<instrumentation android:name="dev.aster.consumer.PacketConsumerInstrumentation" android:targetPackage="dev.aster.consumer" android:functionalTest="true"/></manifest>'));
const java=join(project,'app/src/main/java/dev/aster/consumer');await mkdir(java,{recursive:true});await cp(join(projectRoot,'examples/android/cycle13/PacketConsumerInstrumentation.java'),join(java,'PacketConsumerInstrumentation.java'));
const environment=await gradleEnvironment(out);gradleRun(environment,project,out,[':app:assembleRelease'],{consumerBuildRoot:join(out,'build'),asterDebugKeystore:join(projectRoot,'artifacts/android/debug.jks'),asterAar:aar});
const apk=join(out,'build/app/outputs/apk/release/app-release.apk'),mapping=join(out,'build/app/outputs/mapping/release/mapping.txt');const mapText=await readFile(mapping,'utf8');assert(mapText.includes('dev.aster.charts.AsterEngine$ScenePacket ->'),'ScenePacket must reach R8 mapping');
const mapped=mapText.match(/^dev\.aster\.charts\.AsterEngine\$ScenePacket -> (.+):$/m)?.[1];assert(mapped&&mapped!=='dev.aster.charts.AsterEngine$ScenePacket','ScenePacket was not obfuscated');
const serial=process.env.ASTER_ANDROID_SERIAL??'emulator-5580',port=process.env.ASTER_ADB_PORT??'5038';assert.equal(serial,'emulator-5580');assert.equal(port,'5038');
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk');
const badging=spawnSync(join(sdk,'build-tools/36.0.0/aapt2'),['dump','badging',apk],{encoding:'utf8'});
assert.equal(badging.status,0,'Actual APK manifest inspection');assert.equal(badging.error,undefined);assert(!/^application-debuggable(?:\s|$)/m.test(badging.stdout),'Actual APK must be nondebuggable');
await writeFile(join(out,'manifest-badging.txt'),badging.stdout);
const command=args=>spawnSync(join(sdk,'platform-tools/adb'),['-P',port,'-s',serial,...args],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000});
const adb=args=>{const p=command(args);if(p.status!==0||p.error)throw new Error(p.error||p.stderr||p.stdout);return p.stdout;};
const pkg='dev.aster.consumer';let instrumentation='',raw,ownershipConfirmed=false;
const proof={passed:false,apk,apkSHA256:sha(await readFile(apk)),aarSHA256:sha(await readFile(aar)),coreSHA256:audit.coreSHA256,jniSHA256:audit.jniSHA256,activitySourceSHA256:sha(Buffer.from(source)),mappingSHA256:sha(Buffer.from(mapText)),scenePacketObfuscatedName:mapped,debuggable:false,shrinking:true,obfuscation:true,systemInput:'UiAutomation shell HOME; actual Activity stop/resume/recreate; no performance claim',serial,port};
const owned=operation=>ownershipConfirmed?operation():{status:null,error:'Owned AVD identity unconfirmed; cleanup skipped'};
await finalizePressureCompletion({runnerManifest:proof,
 persist:async value=>writeFile(join(out,'proof.json'),JSON.stringify({...value,passed:value.completionValidation.passed},null,2)+'\n'),
 cleanupSteps:[
  {name:'force-stop',run:async()=>owned(()=>command(['shell','am','force-stop',pkg]))},
  {name:'owned-app-process-inventory',run:async()=>owned(()=>confirmOwnedPackageAbsent(command(['shell','ps','-A','-o','PID,NAME']),pkg))}
 ],
 emitPassed:async()=>console.log(JSON.stringify({passed:true,out,scenePacketObfuscatedName:mapped})),
 validate:async()=>{
 assert.equal(adb(['emu','avd','name']).split('\n')[0].trim(),'aster-validation');ownershipConfirmed=true;adb(['install','-r',apk]);instrumentation=adb(['shell','am','instrument','-w',pkg+'/'+pkg+'.PacketConsumerInstrumentation']);await writeFile(join(out,'instrumentation.txt'),instrumentation);
 const encoded=instrumentation.match(/^INSTRUMENTATION_RESULT: packetReportBase64=(.+)$/m)?.[1]?.trim();assert(encoded,'Missing same-UID nondebuggable report');raw=Buffer.from(encoded,'base64');const report=JSON.parse(raw);await writeFile(join(out,'raw.json'),raw);
 validateKotlinConsumerReport(report,{studies:false,expectedVersion:audit.sdkVersion});assert(report.checks.includes('nondebuggable R8 View uses typed JNI packets'));assert(report.checks.includes('nondebuggable R8 typed path has zero fallback'));assert(report.consumerContract);
 proof.rawSHA256=sha(raw);assert.equal(sha(await readFile(apk)),proof.apkSHA256);
 }
});
