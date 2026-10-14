import {mkdir,copyFile,readFile,writeFile,readdir,rm,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {join,resolve} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
// Test-only private APK, reusing the preserved binary-compatible JNI library.
// Never overwrites shared APKs or regenerates the core asset.
const root=resolve(process.env.ASTER_INGESTION_SOURCE??'.'),out=resolve(process.env.ASTER_INGESTION_BUILD??'/tmp/aster-cycle12-android/pressure-build');
if(!out.startsWith('/tmp/aster-cycle12-android/'))throw new Error('Private cycle12 /tmp build directory required');
const core=resolve(process.env.ASTER_INGESTION_CORE??join(root,'native/Resources/aster-core.js'));
const expectedCore=process.env.ASTER_INGESTION_CORE_SHA??'44f5a33df95bd9a3a800583385a605c275abd1480e18e6aae8aafb64c25ad473';
const expectedJNI=process.env.ASTER_INGESTION_JNI_SHA;
const oldAPK=resolve(process.env.ASTER_INGESTION_JNI_APK??join(root,'artifacts/android/aster-native.apk'));
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),jdk=process.env.ASTER_JDK??'/opt/homebrew/opt/openjdk';
const build=join(sdk,'build-tools/36.0.0'),android=join(sdk,'platforms/android-36/android.jar');
const run=(exe,args)=>{const r=spawnSync(exe,args,{stdio:'inherit'});if(r.status!==0)throw new Error(`${exe} exit ${r.status}`);};
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
await access(oldAPK);await rm(out,{recursive:true,force:true});for(const dir of ['java','classes','dex','assets','lib/arm64-v8a'])await mkdir(join(out,dir),{recursive:true});
await copyFile(core,join(out,'assets/aster-core.js'));if(await hash(join(out,'assets/aster-core.js'))!==expectedCore)throw new Error('Frozen core SHA mismatch');
run('python3',['-c','import zipfile,sys,pathlib\nwith zipfile.ZipFile(sys.argv[1]) as z:pathlib.Path(sys.argv[2]).write_bytes(z.read("lib/arm64-v8a/libaster.so"))',oldAPK,join(out,'lib/arm64-v8a/libaster.so')]);
const selectedJNI=await hash(join(out,'lib/arm64-v8a/libaster.so'));if(expectedJNI&&selectedJNI!==expectedJNI)throw new Error('Explicit selected JNI SHA mismatch');
const sourceFiles=[];for(const dir of [join(root,'native/android/java/dev/aster/charts'),join(root,'examples/android/cycle12')])for(const name of (await readdir(dir)).filter(n=>n.endsWith('.java')))sourceFiles.push(join(dir,name));
sourceFiles.push(join(root,'examples/android/IngestionVerification.java'),join(root,'examples/android/TimezoneVerification.java'));
const hashes={};const snapshots=[];for(const source of sourceFiles){const name=source.split('/').at(-1),dest=join(out,'java',name);await copyFile(source,dest);hashes[name]=await hash(dest);snapshots.push(dest);}
const production=snapshots.filter(p=>['AsterEngine.java','AsterColumns.java','AsterChartView.java','AsterBitmapCachePool.java','WorkspaceRestoreJob.java','NativeJobBudget.java','ParamsUpdateJob.java'].includes(p.split('/').at(-1)));
// Existing low-memory compatibility callbacks are deprecated in API36. Keep
// their production code unchanged; all other lint warnings remain fatal.
run(join(jdk,'bin/javac'),['--release','8','-Werror','-Xlint:all,-options,-deprecation','-cp',android,'-d',join(out,'classes'),...production]);
run(join(jdk,'bin/javac'),['--release','8','-Werror','-Xlint:all,-options','-cp',`${android}:${join(out,'classes')}`,'-d',join(out,'classes'),...snapshots.filter(p=>!production.includes(p))]);
const classes=(await readdir(join(out,'classes/dev/aster/charts'))).filter(n=>n.endsWith('.class')).map(n=>join(out,'classes/dev/aster/charts',n));
run(join(jdk,'bin/java'),['-cp',join(build,'lib/d8.jar'),'com.android.tools.r8.D8','--lib',android,'--min-api','26','--output',join(out,'dex'),...classes]);
await writeFile(join(out,'AndroidManifest.xml'),'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.aster.charts.ingestion.pressure"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><application android:label="Aster Local Ingestion Pressure" android:theme="@android:style/Theme.Material.NoActionBar" android:debuggable="true" android:allowBackup="false" android:extractNativeLibs="true"><activity android:name="dev.aster.charts.IngestionActivity" android:exported="true"/></application><instrumentation android:name="dev.aster.charts.IngestionInstrumentation" android:targetPackage="dev.aster.charts.ingestion.pressure" android:functionalTest="true"/></manifest>');
run(join(build,'aapt2'),['link','--manifest',join(out,'AndroidManifest.xml'),'-I',android,'-A',join(out,'assets'),'--min-sdk-version','26','--target-sdk-version','36','-o',join(out,'unsigned.apk')]);
run('python3',['-c','import zipfile,pathlib,sys\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(p/"unsigned.apk","a",zipfile.ZIP_DEFLATED) as z:\n z.write(p/"dex/classes.dex","classes.dex")\n z.write(p/"lib/arm64-v8a/libaster.so","lib/arm64-v8a/libaster.so")',out]);
run(join(build,'zipalign'),['-f','-p','4',join(out,'unsigned.apk'),join(out,'aligned.apk')]);
const key=resolve(process.env.ASTER_DEBUG_KEYSTORE??join(root,'artifacts/android/debug.jks'));await access(key);
run(join(jdk,'bin/java'),['-jar',join(build,'lib/apksigner.jar'),'sign','--ks',key,'--ks-pass','pass:android','--out',join(out,'aster-ingestion.apk'),join(out,'aligned.apk')]);
for(const source of sourceFiles)if(await hash(source)!==hashes[source.split('/').at(-1)])throw new Error(`Source changed while building: ${source}`);
if(await hash(core)!==expectedCore)throw new Error('Selected core changed while building');
const report={sourceRoot:root,version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,coreSource:core,jniAPK:oldAPK,jniAPKSHA256:await hash(oldAPK),coreSHA256:expectedCore,jniSHA256:selectedJNI,explicitJNIHashGuard:expectedJNI??null,jniCSourceSHA256:await hash(join(root,'native/android/aster_jni.c')),hashes,apkSHA256:await hash(join(out,'aster-ingestion.apk')),apk:join(out,'aster-ingestion.apk'),warningsAsErrors:true,lint:'Production all except API36 deprecation/options; fixtures all except options. Existing Pool low-memory compatibility callbacks preserved.',buildExit:0,productionViewModifiedForFixture:false,reproduction:'npm run build:android first; node scripts/build-android-ingestion.mjs; node scripts/test-android-ingestion.mjs. Private /tmp/aster-cycle12-android output. Preserved old APK only via explicit ASTER_INGESTION_JNI_APK; optional ASTER_INGESTION_JNI_SHA enforces an expected library SHA.'};
await writeFile(join(out,'build-manifest.json'),JSON.stringify(report,null,2)+'\n');console.log(report.apk);
