// 번들을 쓰는 Node 테스트를 기록 모드로 돌리고 모든 추적을 재생한다(설계 §6.5-1, M0 Task 5).
// 1) test/*.test.mjs 가운데 node:vm과 생성 번들을 함께 쓰는 파일을 고른다. 추적 도구 자신의 테스트(test/trace-*.test.mjs)는
//    스스로 기록기를 달고 재생하므로 뺀다.
// 2) node --import ./test/helpers/trace-preload.mjs --test …를 BAROCHART_TRACE_DIR=artifacts/traces/node로 돌린다.
//    테스트 출력은 artifacts/traces/node/tests.log에 남는다.
// 3) 모든 추적을 재생해 표준 출력에 {traces, calls, mismatches, …} 요약 JSON을 쓴다. 추적마다의 결과는 harvest.json에 남는다.
//    테스트가 실패하거나(기록이 동작을 바꿨다는 뜻) 불일치가 있거나 추적이 없으면 종료 코드 1이다.
// 시작 전역을 되살릴 수 없는 추적(테스트가 넣은 shim 함수 등)은 재생하지 않고 skipped로 센다.
import {spawnSync} from 'node:child_process';
import {closeSync,mkdirSync,openSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTraceMeta,replayTrace} from './replay-js.mjs';

/** 저장소 루트 */
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
/** 추적 출력 폴더(계획 Task 5) */
const OUTPUT=join(ROOT,'artifacts/traces/node');
/** 기록 preload */
const PRELOAD=join(ROOT,'test/helpers/trace-preload.mjs');
/** 생성 번들을 읽거나 만드는 자리. 이 가운데 하나와 node:vm을 함께 쓰는 테스트를 기록한다. */
const BUNDLE_REFERENCE=/aster-core\.js|buildNativeBundle|native-core-bundle/;

/**
 * 기록할 테스트 파일을 고른다.
 * @returns {string[]} 저장소 기준 상대 경로(정렬됨)
 */
export function bundleTestFiles(){
 return readdirSync(join(ROOT,'test')).filter(name=>name.endsWith('.test.mjs')&&!name.startsWith('trace-')).sort().filter(name=>{
  const text=readFileSync(join(ROOT,'test',name),'utf8');
  return text.includes('node:vm')&&BUNDLE_REFERENCE.test(text);
 }).map(name=>`test/${name}`);
}

/**
 * 기록 모드로 테스트를 돌린다.
 * @param {string[]} files 테스트 파일
 * @returns {{status: number|null, pass: number, fail: number}} 종료 코드와 TAP 요약
 */
function runRecordedTests(files){
 const log=join(OUTPUT,'tests.log'),fd=openSync(log,'w');
 let result;
 try{
  result=spawnSync(process.execPath,['--import',pathToFileURL(PRELOAD).href,'--test','--test-concurrency=1',...files],{cwd:ROOT,env:{...process.env,BAROCHART_TRACE_DIR:OUTPUT},stdio:['ignore',fd,fd]});
 }finally{closeSync(fd);}
 if(result.error)throw new Error(`Recorded test run could not start: ${result.error.message}`,{cause:result.error});
 const text=readFileSync(log,'utf8');
 const count=label=>Number(new RegExp(`^# ${label} (\\d+)$`,'m').exec(text)?.[1]??NaN);
 return {status:result.status,pass:count('pass'),fail:count('fail')};
}

/**
 * 폴더의 추적을 모두 재생한다.
 * - traces: 재생한 추적 수, withCalls: 그 가운데 호출이 하나 이상인 추적 수, calls: 재생한 호출 수
 * - stopped: 기록이 중간에 멈춘 추적 수(out-of-band 접근, 재현할 수 없는 인자 등. 멈춘 앞부분은 재생한다)
 * - skipped: 시작 전역을 되살릴 수 없어 재생하지 않은 추적 수
 * @returns {{summary: {traces: number, withCalls: number, calls: number, mismatches: number, skipped: number, stopped: number}, rows: object[]}} 요약과 추적마다의 결과
 */
function replayAll(){
 const rows=[];
 const summary={traces:0,withCalls:0,calls:0,mismatches:0,skipped:0,stopped:0};
 for(const name of readdirSync(OUTPUT).filter(file=>file.endsWith('.jsonl')).sort()){
  const path=join(OUTPUT,name),meta=readTraceMeta(path);
  if(meta?.stopped)summary.stopped++;
  if(meta?.opaqueGlobals?.length){summary.skipped++;rows.push({trace:name,skipped:`starting globals cannot be reproduced: ${meta.opaqueGlobals.join(', ')}`});continue;}
  const {calls,mismatches}=replayTrace(path);
  summary.traces++;summary.calls+=calls;summary.mismatches+=mismatches.length;
  if(calls>0)summary.withCalls++;
  rows.push({trace:name,source:meta?.source??null,calls,stopped:meta?.stopped??null,mismatches:mismatches.slice(0,5).map(mismatch=>({line:mismatch.line,expected:mismatch.expected.slice(0,300),actual:mismatch.actual.slice(0,300)})),mismatchCount:mismatches.length});
 }
 return {summary,rows};
}

/**
 * 수집 전체를 돌린다.
 * @returns {number} 종료 코드
 */
function main(){
 rmSync(OUTPUT,{recursive:true,force:true});
 mkdirSync(OUTPUT,{recursive:true});
 const files=bundleTestFiles();
 const tests=runRecordedTests(files);
 const {summary,rows}=replayAll();
 writeFileSync(join(OUTPUT,'harvest.json'),JSON.stringify({files,tests,summary,rows},null,1)+'\n');
 for(const row of rows.filter(entry=>entry.mismatchCount))process.stderr.write(`mismatch ${row.trace} (${row.source}): ${row.mismatchCount}, first line ${row.mismatches[0].line}\n`);
 if(tests.status!==0)process.stderr.write(`recorded test run failed (exit ${tests.status}, fail ${tests.fail}); see ${join(OUTPUT,'tests.log')}\n`);
 process.stdout.write(JSON.stringify({...summary,testFiles:files.length,tests:{pass:tests.pass,fail:tests.fail}})+'\n');
 return tests.status===0&&summary.mismatches===0&&summary.traces>0?0:1;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
