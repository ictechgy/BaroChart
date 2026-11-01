// 네이티브 장시간 안정성 soak(G5)을 iOS 시뮬레이터·Android 에뮬레이터에서 실행하고 결과를 기록한다.
//   iOS: Tests/BaroChartTests/SoakTests (TEST_RUNNER_BAROCHART_SOAK_MINUTES)
//   Android: native/android/library/src/androidTest/.../SoakTest (instrumentation 인자 soakMinutes)
// 사용법: node scripts/run-native-soak.mjs --platform ios|android [--minutes 30] [--simulator <udid>]
// 출력: docs/measurements/native-soak-<platform>.json
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
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
function reports(log){
 const found={};
 for(const line of log.split('\n')){const match=/BAROCHART_SOAK_REPORT (\S+) (?:\S+ )?(\{.*\})\s*$/.exec(line);if(match)found[match[1]]=JSON.parse(match[2]);}
 return found;
}

function soakIOS(){
 const simulator=arg('--simulator',null)??(()=>{throw new Error('Pass --simulator <udid> of an installed iOS simulator');})();
 const result=run('xcodebuild',['test','-scheme','BaroChart','-destination',`platform=iOS Simulator,id=${simulator}`,'-derivedDataPath',join(root,'artifacts/dd-soak'),'-only-testing:BaroChartTests/SoakTests'],{TEST_RUNNER_BAROCHART_SOAK_MINUTES:String(minutes)});
 return {status:result.status,reports:reports(result.output),host:'iOS Simulator (XCTest), phys_footprint'};
}

function soakAndroid(){
 const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),serial=process.env.ASTER_ANDROID_SERIAL??'emulator-5580',adbPort=process.env.ANDROID_ADB_SERVER_PORT??'5038';
 const adb=args=>run(join(sdk,'platform-tools/adb'),['-s',serial,...args],{ANDROID_ADB_SERVER_PORT:adbPort});
 adb(['logcat','-c']);
 const gradle=spawnSync('sh',['-c','ls ~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle'],{encoding:'utf8'}).stdout.trim().split('\n')[0];
 const result=run(process.env.ASTER_GRADLE??gradle,['--console=plain','-p','native/android/library',`-PasterBuildDir=${join(root,'artifacts/android-soak/build')}`,':connectedDebugAndroidTest','-Pandroid.testInstrumentationRunnerArguments.class=kr.coden.barochart.SoakTest',`-Pandroid.testInstrumentationRunnerArguments.soakMinutes=${minutes}`],
  {JAVA_HOME:process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_SERIAL:serial,ANDROID_ADB_SERVER_PORT:adbPort});
 const log=adb(['logcat','-d','-s','BaroChartSoak:I']).output;
 return {status:result.status,reports:reports(log),host:`Android emulator ${serial} (AndroidX Test), Debug.getPss`};
}

const started=new Date().toISOString();
const outcome=platform==='ios'?soakIOS():soakAndroid();
const values=Object.values(outcome.reports);
const report={schema:'barochart.native-soak',version:1,platform,minutes,started,finished:new Date().toISOString(),host:outcome.host,testStatus:outcome.status,
 passed:outcome.status===0&&values.length===2&&values.every(r=>r.passed===true),reports:outcome.reports,
 limits:['Simulator/emulator memory, not physical-device memory','Data is bounded with compactData(keepLastBars: 10000) every 60 s so growth reflects retention, not the dataset']};
await writeFile(join(root,`docs/measurements/native-soak-${platform}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({platform,passed:report.passed,testStatus:outcome.status,reports:Object.fromEntries(Object.entries(outcome.reports).map(([k,v])=>[k,{passed:v.passed,windows:v.windows,growthPercent:v.growthPercent,projectedGrowthPercent:v.projectedGrowthPercent}]))}));
if(!report.passed)process.exitCode=1;
