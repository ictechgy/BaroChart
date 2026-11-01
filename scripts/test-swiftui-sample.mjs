// SwiftUI 샘플 앱(examples/swiftui-sample)을 전용 시뮬레이터에서 빌드·UI 테스트하고 시뮬레이터를 지운다.
// 샘플은 Swift 6 엄격 동시성으로 빌드되며, 샘플 소스에서 나온 컴파일 경고가 하나라도 있으면 실패한다.
// 사용법: node scripts/test-swiftui-sample.mjs [--keep-simulator]
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=root+'artifacts/swiftui-sample';

/** 명령을 실행하고 실패하면 원인 출력과 함께 던진다 */
function run(command,args,{allowFailure=false}={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});
 if(result.status!==0&&!allowFailure)throw new Error(`${command} ${args[0]} failed (${result.status}): ${(result.stderr||result.stdout||'').slice(-2000)}`);
 return result;
}

/** 설치된 최신 iOS 런타임으로 전용 시뮬레이터를 만든다 */
function createSimulator(){
 const runtimes=JSON.parse(run('xcrun',['simctl','list','runtimes','--json']).stdout).runtimes.filter(r=>r.isAvailable&&r.name.startsWith('iOS'));
 if(!runtimes.length)throw new Error('No installed iOS simulator runtime; install one in Xcode > Settings > Components');
 const runtime=process.env.ASTER_IOS_RUNTIME??runtimes.at(-1).identifier,device=process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
 return run('xcrun',['simctl','create',`BaroChart-sample-${Date.now()}`,device,runtime]).stdout.trim();
}

/** 빌드 로그에서 샘플 소스(Sources·UITests)가 낸 경고를 찾는다 */
function sampleWarnings(log){
 return log.split('\n').filter(line=>/examples\/swiftui-sample\/(Sources|UITests)\/.*warning:/.test(line));
}

await mkdir(out,{recursive:true});
const simulator=createSimulator();
let report;
try{
 const result=run('xcodebuild',['test','-project','examples/swiftui-sample/BaroChartSample.xcodeproj','-scheme','BaroChartSample','-destination',`platform=iOS Simulator,id=${simulator}`,'-derivedDataPath',out+'/DerivedData','CODE_SIGNING_ALLOWED=NO'],{allowFailure:true});
 const log=result.stdout+result.stderr;await writeFile(out+'/xcodebuild.log',log);
 const warnings=sampleWarnings(log),executed=/Executed (\d+) tests?, with (\d+) failures?/.exec(log);
 report={passed:result.status===0&&warnings.length===0,xcodebuildStatus:result.status,tests:executed?Number(executed[1]):0,failures:executed?Number(executed[2]):null,sampleWarnings:warnings,simulator,swiftLanguageMode:'6.0',strictConcurrency:'complete'};
}finally{
 if(!process.argv.includes('--keep-simulator'))run('xcrun',['simctl','delete',simulator],{allowFailure:true});
}
await writeFile(out+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(!report.passed)throw new Error('SwiftUI sample failed; see artifacts/swiftui-sample/xcodebuild.log');
