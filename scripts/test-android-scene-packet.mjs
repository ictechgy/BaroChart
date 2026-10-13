import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {finalizePressureCompletion} from './android-ingestion-contract.mjs';
import {confirmOwnedPackageAbsent} from './android-scene-cleanup.mjs';
const build=resolve(process.env.ASTER_PACKET_BUILD??'/tmp/aster-cycle13-android/functional-build');
const out=resolve(process.env.ASTER_PACKET_RESULTS??'/tmp/aster-cycle13-android/functional-results');
if(![build,out].every(path=>path.startsWith('/tmp/aster-cycle13-android/')))throw new Error('Private cycle13 paths required');
try{await access(out);throw new Error('Results exist; choose a new immutable attempt');}catch(error){if(error.code!=='ENOENT')throw error;}
const serial=process.env.ASTER_ANDROID_SERIAL??'emulator-5580',port=process.env.ASTER_ADB_PORT??'5038';assert.equal(serial,'emulator-5580');assert.equal(port,'5038');
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),adbFile=join(sdk,'platform-tools/adb');
const command=args=>spawnSync(adbFile,['-P',port,'-s',serial,...args],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000});
const adb=args=>{const p=command(args);if(p.status!==0||p.error)throw new Error(p.error||p.stderr||p.stdout);return p.stdout;};
const manifest=JSON.parse(await readFile(join(build,'build-manifest.json'),'utf8'));const apkBytes=await readFile(manifest.apk),sha=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(sha(apkBytes),manifest.apkSHA256);assert.equal(manifest.buildExit,0);
await mkdir(out,{recursive:true});const runId=randomUUID(),pkg='dev.aster.charts.packet',file='packet-functional.json';let raw='',ownershipConfirmed=false;
const runner={schema:'aster.cycle13.android-packet-runner',runId,build:manifest,serial,adbPort:port,physicalDevice:false};
const owned=operation=>ownershipConfirmed?operation():{status:null,error:'Owned AVD identity unconfirmed; cleanup skipped'};
await finalizePressureCompletion({runnerManifest:runner,
 persist:async value=>writeFile(join(out,'runner-manifest.json'),JSON.stringify(value,null,2)+'\n'),
 cleanupSteps:[
  {name:'force-stop',run:async()=>owned(()=>command(['shell','am','force-stop',pkg]))},
  {name:'owned-app-process-inventory',run:async()=>owned(()=>confirmOwnedPackageAbsent(command(['shell','ps','-A','-o','PID,NAME']),pkg))}
 ],
 emitPassed:async()=>console.log(JSON.stringify({passed:true,runId,raw:join(out,'raw.json')},null,2)),
 validate:async()=>{
 assert.equal(adb(['emu','avd','name']).split('\n')[0].trim(),'aster-validation');ownershipConfirmed=true;assert.equal(adb(['shell','getprop','sys.boot_completed']).trim(),'1');
 adb(['install','-r',manifest.apk]);adb(['shell','run-as',pkg,'rm','-f','files/'+file]);
 runner.instrumentation=adb(['shell','am','instrument','-w','-e','runId',runId,'-e','report',file,pkg+'/dev.aster.charts.PacketInstrumentation']);
 raw=adb(['exec-out','run-as',pkg,'cat','files/'+file]);await writeFile(join(out,'raw.json'),raw);const report=JSON.parse(raw);
 assert.equal(report.passed,true,report.error);assert.equal(report.schema,'aster.cycle13.android-packet');assert.equal(report.runId,runId);assert.deepEqual(report.buildIdentity,manifest.identity);
 assert.equal(report.decoder?.passed,true);assert.equal(report.pixels?.passed,true);assert(Number.isSafeInteger(report.inputCount)&&report.inputCount>=2);
 const required=['Attached cached typed frames','Cached unchanged base omitted safely','Malformed cached packet explicitly falls back','Fallback preserves diagnostic reason','Typed route recovers after failure cooldown','Real framework touch accepted by typed attached View','Closed attached View owns no bitmaps','Source/JNI fixtures closed; only empty witness remains'];
 for(const id of required)assert(report.checks.includes(id),'Missing semantic check: '+id);
 assert(report.pixels.checks.includes('Exact pixel parity all six opcodes/clip/dash/area-fill/text-font'));assert(report.pixels.checks.includes('Color preparation failure precedes background/Canvas writes'));assert(report.decoder.checks.includes('Metadata UTF8 budget differs from character count'));
 assert.equal(report.runtimeBeforeWitnessClose.processLiveNativeHandles,1);assert.equal(report.runtimeBeforeWitnessClose.processNativeHandlesCreated-report.runtimeBeforeWitnessClose.processNativeHandlesFreed,1);
 runner.rawSHA256=sha(Buffer.from(raw));assert.equal(sha(await readFile(manifest.apk)),manifest.apkSHA256);
 }
});
