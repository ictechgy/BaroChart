import {mkdir,copyFile,readFile,writeFile,readdir,rm,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {join,resolve} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
const baseline=process.argv.includes('--baseline'),mode=baseline?'baseline':'candidate';
const root=resolve(process.env.ASTER_MOBILE_UX_SOURCE??(baseline?'/tmp/aster-cycle10-android/baseline-source':'.'));
const out=resolve(process.env.ASTER_MOBILE_UX_BUILD??`/tmp/aster-cycle10-android/${mode}`);
if(!out.startsWith('/tmp/aster-cycle10-android/'))throw new Error('Build must use private /tmp/aster-cycle10-android/ directory');
const apk=resolve(process.env.ASTER_MOBILE_UX_JNI_APK??(baseline?'/tmp/aster-cycle10-android/baseline-0.2.9.apk':'artifacts/android/aster-native.apk'));
const core=resolve(process.env.ASTER_MOBILE_UX_CORE??join(root,'native/Resources/aster-core.js'));
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),jdk=process.env.ASTER_JDK??'/opt/homebrew/opt/openjdk',build=join(sdk,'build-tools/36.0.0'),android=join(sdk,'platforms/android-36/android.jar');
const run=(exe,args)=>{const r=spawnSync(exe,args,{stdio:'inherit'});if(r.status!==0)throw new Error(`${exe} exit ${r.status}`);};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex'),hashes={};
await rm(out,{recursive:true,force:true});for(const dir of ['java','classes','dex','assets','lib/arm64-v8a'])await mkdir(join(out,dir),{recursive:true});
if(baseline&&await hash(core)!==await hash(join(root,"native/Resources/aster-core.js")))throw new Error("Baseline core must match declared frozen source");
await copyFile(core,join(out,'assets/aster-core.js'));hashes.core=await hash(join(out,'assets/aster-core.js'));hashes.jniAPK=await hash(apk);
run('python3',['-c','import zipfile,sys,pathlib\nwith zipfile.ZipFile(sys.argv[1]) as z:pathlib.Path(sys.argv[2]).write_bytes(z.read("lib/arm64-v8a/libaster.so"))',apk,join(out,'lib/arm64-v8a/libaster.so')]);hashes.jni=await hash(join(out,'lib/arm64-v8a/libaster.so'));
const files=[];for(const sourceDir of [join(root,'native/android/java/dev/aster/charts'),resolve('examples/android/mobileux')])for(const name of (await readdir(sourceDir)).filter(x=>x.endsWith('.java'))){const dest=join(out,'java',name);await copyFile(join(sourceDir,name),dest);hashes[name]=await hash(dest);files.push(dest);}
run(join(jdk,'bin/javac'),['--release','8','-Werror','-Xlint:-options','-cp',android,'-d',join(out,'classes'),...files]);
const classes=(await readdir(join(out,'classes/dev/aster/charts'))).filter(x=>x.endsWith('.class')).map(x=>join(out,'classes/dev/aster/charts',x));run(join(jdk,'bin/java'),['-cp',join(build,'lib/d8.jar'),'com.android.tools.r8.D8','--lib',android,'--min-api','26','--output',join(out,'dex'),...classes]);
await writeFile(join(out,'AndroidManifest.xml'),`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.aster.charts.mobileux"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><application android:label="Aster Mobile UX Validation" android:theme="@android:style/Theme.Material.NoActionBar" android:debuggable="true" android:allowBackup="false" android:extractNativeLibs="true"><activity android:name="dev.aster.charts.MobileUXActivity" android:exported="true"/></application><instrumentation android:name="dev.aster.charts.MobileUXInstrumentation" android:targetPackage="dev.aster.charts.mobileux" android:functionalTest="true"/></manifest>`);
run(join(build,'aapt2'),['link','--manifest',join(out,'AndroidManifest.xml'),'-I',android,'-A',join(out,'assets'),'--min-sdk-version','26','--target-sdk-version','36','-o',join(out,'unsigned.apk')]);
run('python3',['-c','import zipfile,pathlib,sys\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(p/"unsigned.apk","a",zipfile.ZIP_DEFLATED) as z:\n z.write(p/"dex/classes.dex","classes.dex")\n z.write(p/"lib/arm64-v8a/libaster.so","lib/arm64-v8a/libaster.so")',out]);
run(join(build,'zipalign'),['-f','-p','4',join(out,'unsigned.apk'),join(out,'aligned.apk')]);
let key=resolve('artifacts/android/debug.jks');try{await access(key);}catch{key='/tmp/aster-cycle10-android/debug.jks';try{await access(key);}catch{run(join(jdk,'bin/keytool'),['-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','aster-debug','-dname','CN=Aster Local Debug','-keyalg','RSA','-validity','3650']);}}
run(join(jdk,'bin/java'),['-jar',join(build,'lib/apksigner.jar'),'sign','--ks',key,'--ks-pass','pass:android','--out',join(out,'aster-mobile-ux.apk'),join(out,'aligned.apk')]);
await writeFile(join(out,'build-manifest.json'),JSON.stringify({mode,version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,sourceRoot:root,coreSource:core,jniAPK:apk,hashes,apk:join(out,'aster-mobile-ux.apk'),javaWarningsAsErrors:true},null,2)+'\n');console.log(join(out,'aster-mobile-ux.apk'));
