// 실기기 성능 측정(G6): 기기 CPU 렌더 시간·시작 시간·메모리와 SDK가 앱에 더하는 크기를 기록하고 잠정 예산과 비교한다.
//   iOS: node scripts/measure-native-device.mjs --platform ios --device <udid> --team <Apple 팀 ID>
//   Android: node scripts/measure-native-device.mjs --platform android --serial <adb serial>
//   [--output <path>] 기본값 docs/measurements/native-device-performance.json
//   [--size-only] 기기 없이 SDK 크기만 잰다(성능 기록은 남기지 않음)
// 결과는 docs/measurements/native-device-performance.json에 플랫폼별로 합쳐 쓴다. 예산 미달은 숨기지 않고 budgetMisses에 남긴다.
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const platform=arg('--platform');
/** 잠정 예산(설계 §5.8 G6). 첫 실측 뒤 근거와 함께 조정할 수 있다 */
const BUDGET={startupP50Ms:500,panP95Ms:16.7,sizePerAbiBytes:3*1024*1024};

function run(command,args,env={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:256*1024*1024,env:{...process.env,...env}});
 return {status:result.status,output:(result.stdout??'')+(result.stderr??'')};
}
function benchmarkLine(log){const match=/BAROCHART_DEVICE_BENCHMARK (\{.*\})/.exec(log);return match?JSON.parse(match[1]):null;}
function requireValue(value,message){if(!value)throw new Error(message);return value;}

/** 링크 맵에서 SwiftPM BaroChart 타깃 오브젝트가 차지하는 바이트를 합한다 */
async function sdkCodeBytes(linkMap){
 const text=await readFile(linkMap,'utf8'),files=new Map();let section='',total=0;
 for(const line of text.split('\n')){
  if(line.startsWith('# Object files:')){section='objects';continue;}
  if(line.startsWith('# Sections:')){section='';continue;}
  if(line.startsWith('# Symbols:')){section='symbols';continue;}
  if(section==='objects'){const m=/^\[\s*(\d+)\]\s+(.*)$/.exec(line);if(m)files.set(m[1],m[2]);}
  if(section==='symbols'){const m=/^0x[0-9A-F]+\s+0x([0-9A-F]+)\s+\[\s*(\d+)\]/.exec(line);if(m&&/(\/BaroChart\.build\/|\/BaroChart\.o$)/.test(files.get(m[2])??''))total+=parseInt(m[1],16);}
 }
 return total;
}

const sizeOnly=process.argv.includes('--size-only');

/** iOS 크기: 서명 없이 arm64 Release를 빌드해 링크 맵의 SDK 코드 크기와 리소스 번들 크기를 잰다(기기와 무관) */
async function iosSize(project){
 const work=await mkdtemp(join(tmpdir(),'barochart-size-')),linkMap=join(work,'link-map.txt');
 try{
  const build=run('xcodebuild',['build','-project',project,'-scheme','BaroChartSample','-configuration','Release','-destination','generic/platform=iOS','-derivedDataPath',join(work,'dd'),`OTHER_LDFLAGS=-Wl,-map,${linkMap}`,'CODE_SIGNING_ALLOWED=NO']);
  if(build.status!==0)throw new Error('iOS release build failed: '+build.output.slice(-3000));
  const bundle=join(work,'dd/Build/Products/Release-iphoneos/BaroChartSample.app/BaroChart_BaroChart.bundle');
  let bundleBytes=0;for(const name of await readdir(bundle))bundleBytes+=(await stat(join(bundle,name))).size;
  const codeBytes=await sdkCodeBytes(linkMap);
  return {sdkCodeBytes:codeBytes,sdkResourceBundleBytes:bundleBytes,totalBytes:codeBytes+bundleBytes,note:'arm64 release link map (BaroChart target objects) + BaroChart_BaroChart.bundle; uncompressed'};
 }finally{await rm(work,{recursive:true,force:true});}
}

/** iOS 기기 성능: 샘플 앱의 PerformanceUITests를 실기기에서 돌려 결과 줄을 읽는다(서명 팀 필요) */
function iosBenchmark(project){
 const device=requireValue(arg('--device'),'Pass --device <udid> (xcrun xctrace list devices)'),team=requireValue(arg('--team'),'Pass --team <Apple Developer Team ID>');
 const test=run('xcodebuild',['test','-project',project,'-scheme','BaroChartSample','-destination',`platform=iOS,id=${device}`,'-derivedDataPath',join(root,'artifacts/device-ios-dd'),'-only-testing:BaroChartSampleUITests/PerformanceUITests',`DEVELOPMENT_TEAM=${team}`,'CODE_SIGN_STYLE=Automatic','-allowProvisioningUpdates']);
 const benchmark=benchmarkLine(test.output);
 if(!benchmark)throw new Error('iOS benchmark output missing; check the device is unlocked, trusted and in Developer Mode. xcodebuild output tail:\n'+test.output.slice(-3000));
 return benchmark;
}

async function measureIOS(){
 const project='examples/swiftui-sample/BaroChartSample.xcodeproj';
 const benchmark=sizeOnly?{sizeOnly:true}:iosBenchmark(project);
 return {...benchmark,size:await iosSize(project)};
}

/** Android Gradle 실행 환경(격리 adb 포트를 존중한다) */
function androidContext(serial){
 const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),adbPort=process.env.ANDROID_ADB_SERVER_PORT??'5037';
 const gradle=process.env.ASTER_GRADLE??spawnSync('sh',['-c','ls ~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle'],{encoding:'utf8'}).stdout.trim().split('\n')[0];
 const env={JAVA_HOME:process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_ADB_SERVER_PORT:adbPort,...(serial?{ANDROID_SERIAL:serial}:{})};
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
 if(serial)context.adb(['logcat','-c']);
 const tasks=sizeOnly?[':assembleRelease']:[':connectedDebugAndroidTest','-Pandroid.testInstrumentationRunnerArguments.class=kr.coden.barochart.PerformanceTest',':assembleRelease'];
 const build=run(context.gradle,['--console=plain','-p','native/android/library',`-PasterBuildDir=${join(root,'artifacts/device-android/build')}`,...tasks],context.env);
 if(build.status!==0)throw new Error('Android build or benchmark failed; check the device is unlocked and authorized. Gradle output tail:\n'+build.output.slice(-3000));
 const benchmark=sizeOnly?{sizeOnly:true}:benchmarkLine(context.adb(['logcat','-d','-s','BaroChartPerf:I']).output);
 if(!benchmark)throw new Error('Android benchmark output missing from logcat (tag BaroChartPerf); check the device is unlocked and the test ran');
 return {...benchmark,size:androidSize()};
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
const result=platform==='ios'?await measureIOS():await measureAndroid();
// --output은 스크립트 자체를 에뮬레이터 등으로 시험할 때 실측 기록을 덮어쓰지 않도록 다른 경로에 쓰게 한다
const path=arg('--output')??join(root,'docs/measurements/native-device-performance.json');
let document={schema:'barochart.native-device-performance',version:1,budget:BUDGET,platforms:{}};
try{document=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
// 크기만 잰 결과는 sizes에 따로 둔다: 기기 성능 기록(platforms)을 덮어쓰지 않기 위해서다
const section=sizeOnly?(document.sizes??={}):document.platforms;
section[platform]={date:new Date().toISOString().slice(0,10),...result,budgetMisses:budgetMisses(result)};
await writeFile(path,JSON.stringify(document,null,2)+'\n');
console.log(JSON.stringify({platform,sizeOnly,startup:result.startup,pan10k:result.pan10k,budgetMisses:section[platform].budgetMisses}));
