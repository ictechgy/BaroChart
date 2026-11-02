// 네이티브 번들 시작 시간 측정(macOS JavaScriptCore): 엔진 생성 → 첫 scene까지 30회 p50/p95.
// 번들 최소화 채택 판단(설계 §5.7)의 근거를 재현한다. 실기기 시작 시간은 Task 18 측정이 담당한다.
// 사용법: node scripts/measure-native-startup.mjs [추가 번들 경로...]
import {spawnSync} from 'node:child_process';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
/** 명령 실행, 실패 시 출력과 함께 던진다 */
function run(command,args){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.status!==0)throw new Error(`${command} failed (${result.status}): ${(result.stderr||result.stdout).slice(-2000)}`);
 return result.stdout;
}
const work=await mkdtemp(join(tmpdir(),'barochart-startup-'));
try{
 const binary=join(work,'bench'),main=join(work,'main.swift');
 // Swift는 main.swift에서만 최상위 실행 코드를 허용한다
 await copyFile(join(root,'benchmarks/native-startup.swift'),main);
 run('swiftc',['-O',...['BaroChartEngine','BaroChartTrace','BaroChartError','BaroChartColumns','BaroChartFrameRenderer'].map(name=>`native/${name}.swift`),main,'-o',binary]);
 console.log(run(binary,['native/Resources/aster-core.js',...process.argv.slice(2)]).trim());
}finally{
 await rm(work,{recursive:true,force:true});
}
