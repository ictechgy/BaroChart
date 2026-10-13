import {spawnSync} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,rm,cp,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const arg=(name,fallback)=>{const index=process.argv.indexOf(name);if(index<0)return fallback;if(!process.argv[index+1]||process.argv[index+1].startsWith('--'))throw new Error(name+' requires a value');return process.argv[index+1];};
const run=(file,args,options={})=>{const result=spawnSync(file,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});if(result.status!==0)throw new Error(`${file} exit${result.status}${result.stderr||result.stdout||result.error?': '+(result.stderr||result.stdout||result.error):''}`);return result.stdout;};

export async function gradleEnvironment(output){
    const gradleHome=resolve(process.env.ASTER_GRADLE_HOME??join(output,'gradle-home'));
    const cache=join(gradleHome,'caches/modules-2');
    if(!existsSync(cache)){
        const source=process.env.ASTER_GRADLE_CACHE??join(homedir(),'.gradle/caches/modules-2');
        if(!existsSync(source))throw new Error('Gradle dependency cache missing; prepare an isolated cache or set ASTER_GRADLE_CACHE');
        await mkdir(dirname(cache),{recursive:true});
        if(process.platform==='darwin')run('cp',['-cR',source,cache]);
        else await cp(source,cache,{recursive:true});
        for(const name of ['modules-2.lock','gc.properties'])await rm(join(cache,name),{force:true});
    }
    let gradle=process.env.ASTER_GRADLE;
    if(!gradle){const distributions=join(homedir(),'.gradle/wrapper/dists/gradle-8.14.5-bin');if(existsSync(distributions))for(const name of await readdir(distributions)){const candidate=join(distributions,name,'gradle-8.14.5/bin/gradle');if(existsSync(candidate)){gradle=candidate;break;}}}
    gradle??='gradle';
    const javaHome=process.env.ASTER_GRADLE_JAVA_HOME??process.env.JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const sdk=process.env.ANDROID_SDK_ROOT??process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
    const env={...process.env,GRADLE_USER_HOME:gradleHome,JAVA_HOME:javaHome,ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk};
    const version=run(gradle,['--version'],{env});if(!version.includes('Gradle 8.14.5'))throw new Error('Pinned Gradle8.14.5 required; set ASTER_GRADLE to that local distribution');
    return {gradle,env,sdk,javaHome,gradleHome};
}
export function gradleRun(environment,project,output,tasks,properties={}){
    const args=['--offline','--no-daemon','--console=plain','--max-workers=2','-Dorg.gradle.vfs.watch=false','--project-cache-dir',join(output,'project-cache'),'-p',project,...Object.entries(properties).map(([key,value])=>`-P${key}=${value}`),...tasks];
    run(environment.gradle,args,{env:environment.env,stdio:'inherit'});
}

export function auditAar(aar,core,jdk=process.env.ASTER_GRADLE_JAVA_HOME??process.env.JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'){
    const inspected=JSON.parse(run('python3',['-c',String.raw`
import zipfile,io,json,sys,hashlib,struct,xml.etree.ElementTree as ET,tempfile,pathlib
p=pathlib.Path(sys.argv[1]); core=pathlib.Path(sys.argv[2]); jdk=pathlib.Path(sys.argv[3])
required=['AndroidManifest.xml','classes.jar','assets/aster-core.js','jni/arm64-v8a/libaster.so','proguard.txt','R.txt','public.txt','res/values/values.xml','assets/licenses/QUICKJS-LICENSE.txt','assets/licenses/LICENSE.txt','assets/licenses/NOTICE.txt']
with zipfile.ZipFile(p) as z:
 names=z.namelist()
 for name in required:
  if name not in names or not z.read(name): raise ValueError('Missing AAR component: '+name)
 if len(names)!=len(set(names)):raise ValueError('Duplicate AAR entries')
 if any(name.endswith(('.jks','.keystore','.apk','.java','.kt')) for name in names):raise ValueError('Unexpected credentials/app/source in AAR')
 manifest=ET.fromstring(z.read('AndroidManifest.xml'));ns='{http://schemas.android.com/apk/res/android}'
 if manifest.find('uses-sdk') is None or manifest.find('uses-sdk').get(ns+'minSdkVersion')!='26':raise ValueError('AAR minSDK26 contract')
 if manifest.find('application') is not None and len(manifest.find('application')):raise ValueError('AAR must not declare demo Activity/components')
 js=z.read('assets/aster-core.js')
 if js!=core.read_bytes():raise ValueError('Bundled core differs from selected source')
 if b'Copyright' not in z.read('assets/licenses/QUICKJS-LICENSE.txt') or b'Permission is hereby granted' not in z.read('assets/licenses/QUICKJS-LICENSE.txt'):raise ValueError('QuickJS MIT notice incomplete')
 if not all(term in z.read('assets/licenses/LICENSE.txt') for term in [b'Apache License',b'Version 2.0, January 2004',b'END OF TERMS AND CONDITIONS']):raise ValueError('Apache-2.0 project license incomplete')
 if not all(term in z.read('assets/licenses/NOTICE.txt') for term in [b'BaroChart',b'QuickJS',b'Copyright (c) 2017-2025 Fabrice Bellard']):raise ValueError('Project or QuickJS attribution notice incomplete')
 if b'aster_sdk_version' not in z.read('R.txt') or b'aster_sdk_version' not in z.read('public.txt'):raise ValueError('Public SDK version resource missing')
 version=ET.fromstring(z.read('res/values/values.xml')).find("string[@name='aster_sdk_version']")
 if version is None or not version.text:raise ValueError('SDK version resource value missing')
 rules=z.read('proguard.txt').decode()
 if 'dev.aster.charts.AsterEngine' not in rules or 'dev.aster.charts.AsterColumns' not in rules or 'native <methods>' not in rules or 'zonedParts' not in rules:raise ValueError('JNI consumer rules missing')
 native=z.read('jni/arm64-v8a/libaster.so')
 if native[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',native,18)[0]!=183:raise ValueError('JNI is not arm64 ELF64')
 phoff=struct.unpack_from('<Q',native,32)[0];size,count=struct.unpack_from('<HH',native,54)
 aligns=[struct.unpack_from('<IIQQQQQQ',native,phoff+i*size)[7] for i in range(count) if struct.unpack_from('<I',native,phoff+i*size)[0]==1]
 if not aligns or min(aligns)<16384:raise ValueError('JNI load segments lack16KiB page alignment')
 jar=z.read('classes.jar')
 with zipfile.ZipFile(io.BytesIO(jar)) as c:
  classes=c.namelist()
  expected=['AsterEngine','AsterEngine$AsyncJob','AsterEngine$AsyncResult','AsterEngine$AsyncOptions','AsterEngine$AsyncListener','AsterEngine$AsyncProgress','AsterColumns','AsterChartView','AsterBitmapCachePool']
  for name in expected:
   if 'dev/aster/charts/'+name+'.class' not in classes:raise ValueError('Missing SDK class: '+name)
  if any('Verification' in name or 'Activity' in name or 'Instrumentation' in name for name in classes):raise ValueError('Demo/test classes in SDK')
 with tempfile.TemporaryDirectory() as d:
  j=pathlib.Path(d)/'classes.jar';j.write_bytes(jar)
  import subprocess
  api=subprocess.run([str(jdk/'bin/javap'),'-public','-classpath',str(j),'dev.aster.charts.AsterEngine','dev.aster.charts.AsterColumns','dev.aster.charts.AsterChartView'],capture_output=True,text=True,check=True).stdout
  for contract in ['implements java.lang.AutoCloseable','public dev.aster.charts.AsterEngine(android.content.Context, int)','setColumns(org.json.JSONObject)','addIndicator(','addDrawing(','applyDataEventAsync(','prepareColumnsAsync(','public void close()','public static dev.aster.charts.AsterColumns copyOf(','public dev.aster.charts.AsterChartView(android.content.Context, dev.aster.charts.AsterEngine)','setTool(java.lang.String)','renderCacheMetrics()']:
   if contract not in api:raise ValueError('Missing public API: '+contract)
 print(json.dumps({'entries':names,'classCount':len(classes),'sdkVersion':version.text,'coreSHA256':hashlib.sha256(js).hexdigest(),'jniSHA256':hashlib.sha256(native).hexdigest(),'classesSHA256':hashlib.sha256(jar).hexdigest(),'jniLoadAlignment':aligns,'minSDK':26,'abis':['arm64-v8a'],'publicAPI':api}))
`,resolve(aar),resolve(core),jdk]));
    return {...inspected,aar:resolve(aar)};
}

export async function buildLibrary(output,core,version){
    output=resolve(output);await mkdir(output,{recursive:true});
    const environment=await gradleEnvironment(output);
    gradleRun(environment,join(projectRoot,'native/android/library'),output,['assembleRelease'],{asterCoreFile:resolve(core),asterVersion:version,asterBuildDir:join(output,'library')});
    const aar=join(output,'aster-charts.aar');await copyFile(join(output,'library/outputs/aar/aster-android-release.aar'),aar);
    const audit=auditAar(aar,core,environment.javaHome);
    if(audit.sdkVersion!==version)throw new Error('AAR version resource does not match selected build version');
    const sources={};for(const name of await readdir(join(projectRoot,'native/android/java/dev/aster/charts')))if(name.endsWith('.java'))sources[name]=sha(await readFile(join(projectRoot,'native/android/java/dev/aster/charts',name)));
    const report={...audit,version,gradle:'8.14.5',agp:'8.13.2',ndk:'29.0.14033849',cmake:'3.22.1',javaHome:environment.javaHome,gradleHome:environment.gradleHome,aarSHA256:sha(await readFile(aar)),javaSources:sources,assetSource:resolve(core)};
    await writeFile(join(output,'aar-audit.json'),JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const core=arg('--core',process.env.ASTER_ANDROID_LIBRARY_CORE??join(projectRoot,'native/Resources/aster-core.js'));
    if(process.argv.includes('--audit-only'))console.log(JSON.stringify(auditAar(arg('--aar'),core),null,2));
    else {const version=arg('--version',JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8')).version);const report=await buildLibrary(arg('--out',process.env.ASTER_ANDROID_LIBRARY_OUT??'/tmp/aster-android-sdk'),core,version);console.log(JSON.stringify({aar:report.aar,version:report.version,coreSHA256:report.coreSHA256,aarSHA256:report.aarSHA256}));}
}
