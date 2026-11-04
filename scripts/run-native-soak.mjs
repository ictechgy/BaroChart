// 네이티브 장시간 안정성 soak(G5)을 iOS 시뮬레이터·Android 에뮬레이터에서 실행하고 결과를 기록한다.
//   iOS: Tests/BaroChartTests/SoakTests (simulator 또는 --destination "platform=iOS,id=PRIVATE_DEVICE_ID")
//   Android: native/android/library/src/androidTest/.../SoakTest (physical --serial PRIVATE_ADB_SERIAL --backend javascript|rust)
// 사용법: node scripts/run-native-soak.mjs --platform ios|android [--minutes 30] [--offline]
// 출력: docs/measurements/native-soak-<platform>.json
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const platform=arg('--platform'),minutes=Number(arg('--minutes','30'));
if(!['ios','android'].includes(platform))throw new Error('Choose --platform ios or --platform android');
if(!(minutes>0))throw new Error('--minutes must be positive');

/** 명령을 실행하고 출력 전체를 돌려준다(실패해도 출력은 보고서 판단에 쓴다) */
function run(command,args,env={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:256*1024*1024,env:{...process.env,...env}});
 return {status:result.status,output:(result.stdout??'')+(result.stderr??'')};
}

/** 로그에서 BAROCHART_SOAK_REPORT <이름> ... {json} 줄을 모은다 */
function reports(log,runId,backend){
 const found={};
 for(const line of log.split('\n')){const match=/BAROCHART_SOAK_REPORT (\S+) (?:\S+ )?(\{.*\})\s*$/.exec(line);if(match){const report=JSON.parse(match[2]);if(report.runId===runId&&report.backend===backend)found[match[1]]=report;}}
 return found;
}

async function fingerprints(){
 const source=createHash('sha256');
 const inputs=['scripts/run-native-soak.mjs','Tests/BaroChartTests/SoakTests.swift','native/BaroChartEngine.swift','native/BaroChartCoreRuntime.swift','native/BaroChartRustCoreRuntime.swift','native/BaroChartValidation.swift','native/android/java/kr/coden/barochart/BaroChartEngine.java','native/android/java/kr/coden/barochart/BaroChartValidation.java','native/android/library/src/androidTest/java/kr/coden/barochart/SoakTest.java'];
 const collect=async directory=>{try{for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())await collect(file);else if((file.startsWith('rust/crates/')&&file.endsWith('.rs'))||(file.startsWith('rust/include/')&&file.endsWith('.h')))inputs.push(file);}}catch(error){if(error.code!=='ENOENT')throw error;}};
 await collect('rust/crates');await collect('rust/include');inputs.sort();
 for(const file of inputs){source.update(file);source.update('\0');source.update(await readFile(join(root,file)));}
 const hashFile=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex');
 const artifacts=createHash('sha256');let found=false;
 const collectArtifacts=async directory=>{try{for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())await collectArtifacts(file);else if(/\.(apk|aar|so|a)$/.test(file)||directory.includes('Build/Products')){artifacts.update(file);artifacts.update('\0');artifacts.update(await readFile(join(root,file)));found=true;}}}catch(error){if(error.code!=='ENOENT')throw error;}};
 if(platform==='android')await collectArtifacts('artifacts/android-soak/build');
 else await collectArtifacts('artifacts/dd-soak/Build/Products');
 return {sourceSha256:source.digest('hex'),coreBundleSha256:await hashFile('native/Resources/aster-core.js'),rustAbiHeaderSha256:await hashFile('rust/include/barochart_core.h'),buildArtifactsSha256:found?artifacts.digest('hex'):null,buildArtifactScope:platform==='android'?'soak APK/AAR/shared libraries':'XCTest products including linked Rust code'};
}

function soakIOS(){
 const destination=arg('--destination',null)??(arg('--device',null)?`platform=iOS,id=${arg('--device')}`:null)??(arg('--simulator',null)?`platform=iOS Simulator,id=${arg('--simulator')}`:null)??(()=>{throw new Error('Pass --simulator <ID> or --destination "platform=iOS,id=PRIVATE_DEVICE_ID"');})();
 const backend=arg('--backend','javascript');if(!['javascript','rust'].includes(backend))throw new Error('Choose --backend javascript or rust');
 const runId=randomUUID();
 const signing=process.argv.includes('--offline-signing')?['CODE_SIGN_STYLE=Automatic','CODE_SIGNING_REQUIRED=YES',`DEVELOPMENT_TEAM=${arg('--team',null)??(()=>{throw new Error('--offline-signing requires --team <Apple Team ID>');})()}`]:[];
 const result=run('xcodebuild',['test','-scheme','BaroChart','-destination',destination,'-derivedDataPath',join(root,'artifacts/dd-soak'),'-only-testing:BaroChartTests/SoakTests',...signing],{TEST_RUNNER_BAROCHART_SOAK_MINUTES:String(minutes),TEST_RUNNER_BAROCHART_BACKEND:backend,TEST_RUNNER_BAROCHART_RUN_ID:runId});
 const physical=destination.startsWith('platform=iOS,');
 const selectedId=destination.split(',').find(value=>value.startsWith('id='))?.slice(3);
 const deviceIdSha256=selectedId?createHash('sha256').update(selectedId).digest('hex').slice(0,12):undefined;
 return {status:result.status,reports:reports(result.output,runId,backend),host:physical?'iOS physical device (XCTest), phys_footprint':'iOS Simulator (XCTest), phys_footprint',physicalDevice:physical,backend,...(deviceIdSha256?{deviceIdSha256}:{})};
}

function soakAndroid(){
 const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),serial=arg('--serial',process.env.ASTER_ANDROID_SERIAL??'emulator-5580'),backend=arg('--backend','javascript'),adbPort=process.env.ANDROID_ADB_SERVER_PORT??'5038';
 if(!['javascript','rust'].includes(backend))throw new Error('Choose --backend javascript or rust');
 const runId=randomUUID();
 const adb=args=>run(join(sdk,'platform-tools/adb'),['-s',serial,...args],{ANDROID_ADB_SERVER_PORT:adbPort});
 const gradle=spawnSync('sh',['-c','ls ~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle'],{encoding:'utf8'}).stdout.trim().split('\n')[0];
 const result=run(process.env.ASTER_GRADLE??gradle,[...(process.argv.includes('--offline')?['--offline']:[]),'--console=plain','-p','native/android/library',`-PasterBuildDir=${join(root,'artifacts/android-soak/build')}`,':connectedDebugAndroidTest','-Pandroid.testInstrumentationRunnerArguments.class=kr.coden.barochart.SoakTest',`-Pandroid.testInstrumentationRunnerArguments.soakMinutes=${minutes}`,`-Pandroid.testInstrumentationRunnerArguments.backend=${backend}`,`-Pandroid.testInstrumentationRunnerArguments.runId=${runId}`],
  {JAVA_HOME:process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_SERIAL:serial,ANDROID_ADB_SERVER_PORT:adbPort});
 const log=adb(['logcat','-d','-s','BaroChartSoak:I']).output;
 const label=serial.startsWith('emulator-')?'emulator':'physical device';
 const serialHash=createHash('sha256').update(serial).digest('hex').slice(0,12);
 return {status:result.status,reports:reports(log,runId,backend),host:`Android ${label} (${serialHash}), Debug.getPss`,backend,physicalDevice:label==='physical device',deviceIdSha256:serialHash};
}

const started=new Date().toISOString();
const outcome=platform==='ios'?soakIOS():soakAndroid();
const values=Object.values(outcome.reports);
const report={schema:'barochart.native-soak',version:1,platform,minutes,started,finished:new Date().toISOString(),host:outcome.host,physicalDevice:outcome.physicalDevice??false,backend:outcome.backend??'javascript',...(outcome.deviceIdSha256?{deviceIdSha256:outcome.deviceIdSha256}:{}),hashes:await fingerprints(),testStatus:outcome.status,
 passed:outcome.status===0&&values.length===2&&values.every(r=>r.passed===true),reports:outcome.reports,
  limits:[platform==='ios'?'XCTest phys_footprint':'Android Debug.getPss process memory','Data is bounded with compactData(keepLastBars: 10000) every 60 s so growth reflects retention, not the dataset']};
const reportPath=join(root,`docs/measurements/native-soak-${platform}.json`);
try {
 const previous=JSON.parse(await readFile(reportPath,'utf8'));
 report.history=[...(previous.history??[]),{started:previous.started,finished:previous.finished,passed:previous.passed,reports:previous.reports}];
} catch(error) { if(error.code!=='ENOENT')throw error; }
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({platform,passed:report.passed,testStatus:outcome.status,reports:Object.fromEntries(Object.entries(outcome.reports).map(([k,v])=>[k,{passed:v.passed,windows:v.windows,growthPercent:v.growthPercent,projectedGrowthPercent:v.projectedGrowthPercent}]))}));
if(!report.passed)process.exitCode=1;
