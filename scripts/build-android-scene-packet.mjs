import {mkdir,copyFile,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

// Private functional APK. It never regenerates native-core or shared APK/AARs.
const root=resolve(process.env.ASTER_PACKET_SOURCE??'.');
const pressure=process.argv.includes('--pressure'),legacy=process.argv.includes('--legacy');
if(legacy&&!pressure)throw new Error('Legacy selection is only for the common pressure fixture');
const legacyRef=process.env.ASTER_PACKET_LEGACY_REF??'4a0b1c8549cf641f8124105216789c15384f6ceb';
const fixtures=resolve(process.env.ASTER_PACKET_FIXTURES??join(root,'examples/android/cycle13'));
const out=resolve(process.env.ASTER_PACKET_BUILD??'/tmp/aster-cycle13-android/functional-build');
if(!out.startsWith('/tmp/aster-cycle13-android/'))throw new Error('Private cycle13 output required');
try{await access(out);throw new Error('Output exists; choose a new immutable attempt directory');}catch(error){if(error.code!=='ENOENT')throw error;}
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk');
const ndk=process.env.ASTER_NDK??join(sdk,'ndk/29.0.14033849'),jdk=process.env.ASTER_JDK??'/opt/homebrew/opt/openjdk';
const tools=join(sdk,'build-tools/36.0.0'),android=join(sdk,'platforms/android-36/android.jar');
const run=(file,args)=>{const p=spawnSync(file,args,{stdio:'inherit'});if(p.status!==0)throw new Error(`${file} exit ${p.status}`);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=async file=>sha(await readFile(file));
for(const path of ['java','c/quickjs','classes','dex','assets','lib/arm64-v8a'])await mkdir(join(out,path),{recursive:true});
const sourceHashes={},originals=[];
async function snapshot(source,destination){await copyFile(source,destination);sourceHashes[basename(source)]=await hash(destination);originals.push({source,destination});return destination;}
async function sdkSnapshot(relative,destination){if(!legacy)return snapshot(join(root,relative),destination);const git=spawnSync('git',['-C',root,'show',legacyRef+':'+relative],{maxBuffer:32*1024*1024});if(git.status!==0)throw new Error('Missing immutable legacy source '+relative);await writeFile(destination,git.stdout);sourceHashes[basename(relative)]=sha(git.stdout);return destination;}
const java=[];for(const file of (await readdir(join(root,'native/android/java/dev/aster/charts'))).filter(x=>x.endsWith('.java')))java.push(await sdkSnapshot('native/android/java/dev/aster/charts/'+file,join(out,'java',file)));
const production=java.slice();const fixtureFiles=pressure?['ScenePressureActivity.java','ScenePressureFeed.java','ScenePressureProbe.java','ScenePressureInstrumentation.java']:['PacketVerification.java','PacketActivity.java','PacketInstrumentation.java'];for(const file of fixtureFiles)java.push(await snapshot(join(fixtures,file),join(out,'java',file)));
for(const file of ['aster_jni.c'])await sdkSnapshot('native/android/'+file,join(out,'c',file));
for(const file of await readdir(join(root,'native/android/quickjs')))if(/\.[ch]$/.test(file))await sdkSnapshot('native/android/quickjs/'+file,join(out,'c/quickjs',file));
const core=resolve(process.env.ASTER_PACKET_CORE??(legacy?'/tmp/aster-cycle13-baseline-core.js':join(root,'native/Resources/aster-core.js')));
const base=await readFile(core),overlay=pressure?Buffer.alloc(0):await readFile(join(fixtures,'packet-fixture.js'));
if(process.env.ASTER_PACKET_CORE_SHA&&sha(base)!==process.env.ASTER_PACKET_CORE_SHA)throw new Error('Selected root core differs from explicit freeze');
if(!pressure)sourceHashes['packet-fixture.js']=sha(overlay);sourceHashes['aster-core.base.js']=sha(base);
const bundle=pressure?base:Buffer.concat([base,Buffer.from('\n'),overlay,Buffer.from('\n')]);await writeFile(join(out,'assets/aster-core.js'),bundle);
const clang=join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android26-clang');
const common=['-O3','-fPIC','-D_GNU_SOURCE','-DCONFIG_VERSION="2026-06-04"'];
// Unchanged upstream inline headers have unused parameters. System-include
// classification isolates those; every warning in our JNI file remains fatal.
run(clang,[...common,'-isystem',join(out,'c/quickjs'),'-Wall','-Wextra','-Werror','-c',join(out,'c/aster_jni.c'),'-o',join(out,'c/aster_jni.o')]);
run(clang,[...common,'-I'+join(out,'c/quickjs'),'-shared',join(out,'c/aster_jni.o'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(file=>join(out,'c/quickjs',file+'.c')),'-lm','-o',join(out,'lib/arm64-v8a/libaster.so')]);
const identity={coreSHA256:sha(bundle),baseCoreSHA256:sha(base),jniSHA256:await hash(join(out,'lib/arm64-v8a/libaster.so')),sourceHashes};
const sourceRoles={activity:'ScenePressureActivity.java',feed:'ScenePressureFeed.java',probe:'ScenePressureProbe.java'};if(pressure)identity.sourceRoles=sourceRoles;
await writeFile(join(out,'assets/'+(pressure?'pressure-identity.json':'packet-identity.json')),JSON.stringify(identity)+'\n');
// Existing API36 Pool deprecations remain isolated; no new warning suppression.
run(join(jdk,'bin/javac'),['--release','8','-Werror','-Xlint:all,-options,-deprecation','-cp',android,'-d',join(out,'classes'),...production]);
run(join(jdk,'bin/javac'),['--release','8','-Werror','-Xlint:all,-options','-cp',android+':'+join(out,'classes'),'-d',join(out,'classes'),...java.filter(file=>!production.includes(file))]);
const classes=(await readdir(join(out,'classes/dev/aster/charts'))).filter(file=>file.endsWith('.class')).map(file=>join(out,'classes/dev/aster/charts',file));
run(join(jdk,'bin/java'),['-cp',join(tools,'lib/d8.jar'),'com.android.tools.r8.D8','--lib',android,'--min-api','26','--output',join(out,'dex'),...classes]);
const pkg=pressure?'dev.aster.charts.packet.pressure':'dev.aster.charts.packet',activity=pressure?'ScenePressureActivity':'PacketActivity',instrumentation=pressure?'ScenePressureInstrumentation':'PacketInstrumentation';
await writeFile(join(out,'AndroidManifest.xml'),`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><application android:label="Aster Private Packet QA" android:theme="@android:style/Theme.Material.NoActionBar" android:debuggable="true" android:allowBackup="false" android:extractNativeLibs="true"><activity android:name="dev.aster.charts.${activity}" android:exported="true"/></application><instrumentation android:name="dev.aster.charts.${instrumentation}" android:targetPackage="${pkg}" android:functionalTest="true"/></manifest>`);
run(join(tools,'aapt2'),['link','--manifest',join(out,'AndroidManifest.xml'),'-I',android,'-A',join(out,'assets'),'--min-sdk-version','26','--target-sdk-version','36','-o',join(out,'unsigned.apk')]);
run('python3',['-c','import zipfile,pathlib,sys\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(p/"unsigned.apk","a",zipfile.ZIP_DEFLATED) as z:\n z.write(p/"dex/classes.dex","classes.dex")\n z.write(p/"lib/arm64-v8a/libaster.so","lib/arm64-v8a/libaster.so")',out]);
run(join(tools,'zipalign'),['-f','-p','4',join(out,'unsigned.apk'),join(out,'aligned.apk')]);
const key=resolve(process.env.ASTER_DEBUG_KEYSTORE??join(root,'artifacts/android/debug.jks'));await access(key);
run(join(jdk,'bin/java'),['-jar',join(tools,'lib/apksigner.jar'),'sign','--ks',key,'--ks-pass','pass:android','--out',join(out,'aster-scene-packet.apk'),join(out,'aligned.apk')]);
for(const item of originals)if(await hash(item.source)!==await hash(item.destination))throw new Error('Source changed while compiling: '+item.source);
if(await hash(core)!==sha(base)||!pressure&&await hash(join(fixtures,'packet-fixture.js'))!==sha(overlay))throw new Error('Core/fixture changed while compiling');
const report={schema:'aster.cycle13.android-packet-build',buildExit:0,root,fixtures,apk:join(out,'aster-scene-packet.apk'),apkSHA256:await hash(join(out,'aster-scene-packet.apk')),identity,coreSHA256:identity.coreSHA256,jniSHA256:identity.jniSHA256,hashes:sourceHashes,...(pressure?{sourceRoles,transport:legacy?'json':'f64'}:{}),legacyRef:legacy?legacyRef:null,pressure,pkg,activity,instrumentation,sdk,ndk,jdk,abi:'arm64-v8a',minSDK:26,targetSDK:36,privateFixtureOverlay:!pressure,productionViewModifiedForFixture:false,fixtureLint:'all/-Werror; production API36 existing deprecation boundary only',rendererProtocol:1};
await writeFile(join(out,'build-manifest.json'),JSON.stringify(report,null,2)+'\n');console.log(report.apk);
