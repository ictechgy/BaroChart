// 실기기 성능 측정(G6): 기기 CPU 렌더 시간·시작 시간·메모리와 SDK가 앱에 더하는 크기를 기록하고 잠정 예산과 비교한다.
//   iOS: node scripts/measure-native-device.mjs --platform ios --device <udid> --team <Apple 팀 ID>
//   Android: node scripts/measure-native-device.mjs --platform android --serial <adb serial>
//   [--output <path>] 기본값 docs/measurements/native-device-performance.json
//   [--size-only] 기기 없이 SDK 크기만 잰다(성능 기록은 남기지 않음)
// 결과는 docs/measurements/native-device-performance.json에 플랫폼별로 합쳐 쓴다. 예산 미달은 숨기지 않고 budgetMisses에 남긴다.
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sdkCodeBytesFromLinkMap} from './native-device-size.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const platform=arg('--platform');
const backend=arg('--backend')??'javascript';
if(!['javascript','rust'].includes(backend))throw new Error('Choose --backend javascript or rust');
const fixtureId='seeded-sine-bars-10k-ema20-v1';
/** 잠정 예산(설계 §5.8 G6). 첫 실측 뒤 근거와 함께 조정할 수 있다 */
// 2026-11-04 owner decision: retain the dual backend and allow 5 MiB per ABI.
const BUDGET={startupP50Ms:500,panP95Ms:16.7,sizePerAbiBytes:5*1024*1024};

function run(command,args,env={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:256*1024*1024,env:{...process.env,...env}});
 return {status:result.status,output:(result.stdout??'')+(result.stderr??'')};
}
function benchmarkLine(log,runId){for(const line of log.split('\n')){const match=/BAROCHART_DEVICE_BENCHMARK (\{.*\})/.exec(line);if(match){const report=JSON.parse(match[1]);if(report.runId===runId&&report.backendVerified===true)return report;}}return null;}
function requireValue(value,message){if(!value)throw new Error(message);return value;}
function redact(text,identifier){return identifier?text.split(identifier).join('<redacted-device-id>'):text;}

/** 링크 맵에서 SwiftPM 타깃과 Rust 정적 라이브러리의 실제 링크 바이트를 합한다 */
async function sdkCodeBytes(linkMap){
 return sdkCodeBytesFromLinkMap(await readFile(linkMap,'utf8'));
}

const sizeOnly=process.argv.includes('--size-only');

/** iOS 크기: 서명 없이 arm64 Release를 빌드해 링크 맵의 SDK 코드 크기와 리소스 번들 크기를 잰다(기기와 무관) */
async function iosSize(project){
 const work=await mkdtemp(join(tmpdir(),'barochart-size-')),linkMap=join(work,'link-map.txt');
 try{
  const derivedData=arg('--ios-derived-data')??join(work,'dd');
  const build=run('xcodebuild',['build','-project',project,'-scheme','BaroChartSample','-configuration','Release','-destination','generic/platform=iOS','-derivedDataPath',derivedData,'-disableAutomaticPackageResolution',`OTHER_LDFLAGS=-Wl,-map,${linkMap}`,'CODE_SIGNING_ALLOWED=NO']);
  if(build.status!==0)throw new Error('iOS release build failed: '+build.output.slice(-3000));
  const bundle=join(derivedData,'Build/Products/Release-iphoneos/BaroChartSample.app/BaroChart_BaroChart.bundle');
  let bundleBytes=0;for(const name of await readdir(bundle))bundleBytes+=(await stat(join(bundle,name))).size;
  const codeBytes=await sdkCodeBytes(linkMap);
  const mapArtifact=join(root,'artifacts/physical-current/ios-size-link-map-private.txt');
  await mkdir(join(root,'artifacts/physical-current'),{recursive:true});
  await writeFile(mapArtifact,await readFile(linkMap),{mode:0o600});
  if(codeBytes===0)throw new Error('iOS SDK link map contains no accounted SDK symbols; inspect the private link-map artifact');
  const executable=join(derivedData,'Build/Products/Release-iphoneos/BaroChartSample.app/BaroChartSample');
  const executableSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
  return {sdkCodeBytes:codeBytes,sdkResourceBundleBytes:bundleBytes,totalBytes:codeBytes+bundleBytes,configuration:'Release',executableSha256,note:'arm64 release link map (BaroChart target objects and linked Rust archive) + BaroChart_BaroChart.bundle; uncompressed'};
 }finally{await rm(work,{recursive:true,force:true});}
}

/** iOS 기기 성능: 샘플 앱의 PerformanceUITests를 실기기에서 돌려 결과 줄을 읽는다(서명 팀 필요) */
function iosBenchmark(project){
 const device=requireValue(arg('--device'),'Pass --device <udid> (use the privately supplied device identifier)');
 const runId=randomUUID();
 const signing=process.argv.includes('--offline-signing')?['CODE_SIGN_STYLE=Automatic','CODE_SIGNING_REQUIRED=YES']:['CODE_SIGN_STYLE=Automatic',...(process.argv.includes('--allow-provisioning')?['-allowProvisioningUpdates']:[])];
 const test=run('xcodebuild',['test','-project',project,'-scheme','BaroChartSample','-destination',`platform=iOS,id=${device}`,'-derivedDataPath',join(root,'artifacts/device-ios-dd'),'-only-testing:BaroChartSampleUITests/PerformanceUITests','-collect-test-diagnostics','never',...signing,`DEVELOPMENT_TEAM=${requireValue(arg('--team'),'Pass --team <Apple Developer Team ID>')}`],{TEST_RUNNER_BAROCHART_BACKEND:backend,TEST_RUNNER_BAROCHART_RUN_ID:runId});
 const benchmark=benchmarkLine(test.output,runId);
 if(!benchmark)throw new Error('iOS benchmark output missing; check the device is unlocked, trusted and in Developer Mode. xcodebuild output tail:\n'+redact(test.output.slice(-3000),device));
 return benchmark;
}

async function measureIOS(){
 const project='examples/swiftui-sample/BaroChartSample.xcodeproj';
 const benchmark=sizeOnly?{sizeOnly:true}:iosBenchmark(project);
 return {...benchmark,size:await iosSize(project)};
}

/** Android Gradle 실행 환경(격리 adb 포트를 존중한다) */
function androidContext(serial){
 const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),adbPort=process.env.ANDROID_ADB_SERVER_PORT??'5038';
 const gradle=process.env.ASTER_GRADLE??spawnSync('sh',['-c','ls ~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle'],{encoding:'utf8'}).stdout.trim().split('\n')[0];
 const env={JAVA_HOME:process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_ADB_SERVER_PORT:adbPort,ADB_SERVER_SOCKET:`tcp:localhost:${adbPort}`,...(serial?{ANDROID_SERIAL:serial}:{})};
 return {gradle,env,adb:args=>run(join(sdk,'platform-tools/adb'),['-s',serial,...args],{ANDROID_ADB_SERVER_PORT:adbPort})};
}

/** Android 크기: Release AAR 안의 ABI별 네이티브 라이브러리 + 코어 자산 + classes.jar(비압축) */
function androidSize(){
 const aar=join(root,'artifacts/device-android/build/outputs/aar/barochart-android-release.aar');
 const sizes=Object.fromEntries(run('unzip',['-lv',aar]).output.split('\n').map(line=>line.trim().split(/\s+/)).filter(cols=>cols.length>=8&&/^(jni\/[^/]+\/[^/]+\.so|assets\/aster-core\.js|classes\.jar)$/.test(cols[7])).map(cols=>[cols[7],{uncompressed:Number(cols[0]),compressed:Number(cols[2])}]));
 const shared=(sizes['assets/aster-core.js']?.uncompressed??0)+(sizes['classes.jar']?.uncompressed??0);
 const perAbi=Object.fromEntries(Object.entries(sizes).filter(([name])=>name.startsWith('jni/')).map(([name,entry])=>[name.split('/')[1],entry.uncompressed+shared]));
 return {entries:sizes,perAbiBytes:perAbi,note:'release AAR: native library for the ABI + core asset + classes.jar, uncompressed (APK compression and R8 shrink further)'};
}

function measureAndroid(){
 const serial=sizeOnly?null:requireValue(arg('--serial'),'Pass --serial <adb serial> (adb devices)'),context=androidContext(serial);
 const runId=randomUUID();
 const tasks=[...(process.argv.includes('--offline')?['--offline']:[]),...(sizeOnly?[':assembleRelease']:[':connectedDebugAndroidTest','-Pandroid.testInstrumentationRunnerArguments.class=kr.coden.barochart.PerformanceTest',`-Pandroid.testInstrumentationRunnerArguments.backend=${backend}`,`-Pandroid.testInstrumentationRunnerArguments.runId=${runId}`,':assembleRelease'])];
 const build=run(context.gradle,['--no-daemon','--max-workers=2','--console=plain','-p','native/android/library',`-PbarochartNode=${process.execPath}`,`-PasterBuildDir=${join(root,'artifacts/device-android/build')}`,...tasks],context.env);
 if(build.status!==0)throw new Error('Android build or benchmark failed; check the device is unlocked and authorized. Gradle output tail:\n'+redact(build.output.slice(-3000),serial));
 const benchmark=sizeOnly?{sizeOnly:true}:benchmarkLine(context.adb(['logcat','-d','-s','BaroChartPerf:I']).output,runId);
 if(!benchmark)throw new Error('Android benchmark output missing from logcat (tag BaroChartPerf); check the device is unlocked and the test ran');
 return {...benchmark,size:androidSize()};
}

async function sourceFingerprint(includeArtifacts=true){
 const files=new Set(['Package.swift','package.json','rust/Cargo.toml','rust/Cargo.lock','rust/rust-toolchain.toml','scripts/measure-native-device.mjs','scripts/native-device-size.mjs','native/android/library/CMakeLists.txt','native/android/library/barochart.map','native/android/library/build.gradle','native/android/aster_jni.c','native/android/library/src/androidTest/java/kr/coden/barochart/PerformanceTest.java','examples/swiftui-sample/project.yml','examples/swiftui-sample/BaroChartSample.xcodeproj/project.pbxproj']);
 const collect=async(directory,accept)=>{for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const name=join(directory,entry.name);if(entry.isDirectory())await collect(name,accept);else if(accept(name))files.add(name);}};
 for(const entry of await readdir(join(root,'native'),{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.swift'))files.add(join('native',entry.name));
 await collect('rust/crates',name=>name.endsWith('.rs')||name.endsWith('/Cargo.toml'));
 await collect('rust/include',name=>name.endsWith('.h'));
 await collect('native/android/java',name=>name.endsWith('.java'));
 await collect('native/android/quickjs',name=>/\.[ch]$/.test(name));
 await collect('examples/swiftui-sample/Sources',name=>name.endsWith('.swift'));
 await collect('examples/swiftui-sample/UITests',name=>name.endsWith('.swift'));
 const hash=createHash('sha256');for(const file of [...files].sort()){hash.update(file);hash.update('\0');hash.update(await readFile(join(root,file)));hash.update('\0');}
 const digest=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex');
 const buildHash=createHash('sha256');let found=false;
 const collectArtifacts=async(directory)=>{try{for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())await collectArtifacts(file);else if(/\.(apk|aar|so|a)$/.test(file)||file.endsWith('/BaroChartSample')){buildHash.update(file);buildHash.update('\0');buildHash.update(await readFile(join(root,file)));found=true;}}}catch(error){if(error.code!=='ENOENT')throw error;}};
 if(includeArtifacts&&platform==='android')await collectArtifacts('artifacts/device-android/build');
 else if(includeArtifacts){for(const file of ['artifacts/device-ios-dd/Build/Products/Debug-iphoneos/BaroChartSample.app/BaroChartSample'])try{buildHash.update(file);buildHash.update(await readFile(join(root,file)));found=true;}catch(error){if(error.code!=='ENOENT')throw error;}}
 return {sourceSha256:hash.digest('hex'),coreBundleSha256:await digest('native/Resources/aster-core.js'),rustAbiHeaderSha256:await digest('rust/include/barochart_core.h'),buildArtifactsSha256:found?buildHash.digest('hex'):null,buildArtifactScope:platform==='android'?'built APK/AAR/shared libraries in the measured Gradle output directory':'measured SwiftUI app executable (Rust static library is linked into it)',fixtureId};
}

function budgetMisses(result){
 const misses=[];
 if(result.startup?.p50Ms>BUDGET.startupP50Ms)misses.push(`startup p50 ${result.startup.p50Ms.toFixed(1)} ms > ${BUDGET.startupP50Ms} ms`);
 if(result.pan10k?.p95Ms>BUDGET.panP95Ms)misses.push(`pan p95 ${result.pan10k.p95Ms.toFixed(2)} ms > ${BUDGET.panP95Ms} ms`);
 const sizes=result.size?.perAbiBytes?Object.values(result.size.perAbiBytes):[result.size?.totalBytes??0];
 if(sizes.some(bytes=>bytes>BUDGET.sizePerAbiBytes))misses.push(`size ${Math.max(...sizes)} B > ${BUDGET.sizePerAbiBytes} B per ABI`);
 return misses;
}

if(!['ios','android'].includes(platform))throw new Error('Choose --platform ios or --platform android');
const sourceBefore=(await sourceFingerprint(false)).sourceSha256;
const result=platform==='ios'?await measureIOS():await measureAndroid();
result.backend=backend;result.fixtureId=fixtureId;result.hashes=await sourceFingerprint();
if(sizeOnly&&platform==='ios'){
 result.hashes.buildArtifactsSha256=result.size.executableSha256;
 result.hashes.buildArtifactScope='size-only measured Release SwiftUI executable';
}
if(result.hashes.sourceSha256!==sourceBefore)throw new Error('Source changed during measurement; repeat against a frozen build');
// --output은 스크립트 자체를 에뮬레이터 등으로 시험할 때 실측 기록을 덮어쓰지 않도록 다른 경로에 쓰게 한다
const path=arg('--output')??join(root,'docs/measurements/native-device-performance.json');
let document={schema:'barochart.native-device-performance',version:1,budget:BUDGET,platforms:{}};
try{document=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
// Preserve the policy used by historical measurements while recording the current owner-approved budget.
for(const section of [document.platforms,document.sizes])for(const record of Object.values(section??{})){
 if(record&&typeof record==='object'&&!record.budget)record.budget={...document.budget};
}
document.budget={...BUDGET};
// 크기만 잰 결과는 sizes에 따로 둔다: 기기 성능 기록(platforms)을 덮어쓰지 않기 위해서다
const section=sizeOnly?(document.sizes??={}):document.platforms;
const recordKey=sizeOnly?platform:(backend==='javascript'?platform:`${platform}-${backend}`);
section[recordKey]={date:new Date().toISOString().slice(0,10),...result,budget:{...BUDGET},budgetMisses:budgetMisses(result)};
await writeFile(path,JSON.stringify(document,null,2)+'\n');
console.log(JSON.stringify({platform,backend,fixtureId,sizeOnly,startup:result.startup,pan10k:result.pan10k,budgetMisses:section[recordKey].budgetMisses}));
