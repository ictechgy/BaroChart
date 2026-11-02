// Rust JS 의미 커널 대조 하네스 테스트(scripts/rust/conformance.mjs, M1 계획 Task 4).
// Node만으로 코퍼스 생성기의 결정성과 오라클(엔진 쪽 기대값)을 시험하고, 가짜 커널 바이너리로 하네스가 불일치·누락·보고서를
// 제대로 다루는지 본다. 고정한 Rust 툴체인이 설치돼 있을 때만 실제 커널과 2000건 대조를 돌린다(없으면 이유를 남기고 건너뛴다).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {NUMBER_SOURCES,SENTINEL_KEY,SUITE_OPS,SUITES,corpusCases,corpusText,createOracle,engineScript} from '../scripts/rust/conformance.mjs';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';

/** 저장소 루트(테스트를 어느 cwd에서 돌려도 같다) */
const root=fileURLToPath(new URL('..',import.meta.url));
/** 대조 하네스 CLI 경로 */
const conformanceScript=join(root,'scripts/rust/conformance.mjs');
/** 숫자 원천을 쓰는 스위트(값 원천을 고루 섞어야 한다) */
const NUMBER_SUITES=['number','fixed','precision','exponential','round'];

/**
 * 수의 IEEE-754 비트를 16진 16자리(빅엔디언)로 쓴다. 하네스 구현과 따로 둔 기준이다.
 * @param {number} value 수
 * @returns {string} 16진 비트
 */
function bitsOf(value){
 const view=new DataView(new ArrayBuffer(8));
 view.setFloat64(0,value);
 return view.getBigUint64(0).toString(16).padStart(16,'0');
}

/**
 * 16진 비트를 수로 읽는다(NaN 페이로드를 담은 입력을 만들 때 쓴다).
 * @param {string} hex 16진 16자리
 * @returns {number} 수
 */
function numberOf(hex){
 const view=new DataView(new ArrayBuffer(8));
 view.setBigUint64(0,BigInt(`0x${hex}`));
 return view.getFloat64(0);
}

/**
 * 올바른 UTF-16 문자열의 UTF-8 바이트를 16진으로 쓴다.
 * @param {string} text 단독 서로게이트가 없는 문자열
 * @returns {string} 16진 바이트
 */
const utf8Of=text=>Buffer.from(text,'utf8').toString('hex');

/**
 * UTF-16 코드 단위를 단위마다 16진 네 자리로 쓴다(단독 서로게이트도 그대로 담는다).
 * @param {string} text 문자열
 * @returns {string} 16진 코드 단위
 */
const unitsOf=text=>Array.from({length:text.length},(_,index)=>text.charCodeAt(index).toString(16).padStart(4,'0')).join('');

/**
 * 대조 하네스 CLI를 저장소 밖 cwd에서 실행한다.
 * @param {string[]} args CLI 인자
 * @param {NodeJS.ProcessEnv} [env] 환경
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 실행 결과
 */
const runConformance=(args,env=process.env)=>spawnSync(process.execPath,[conformanceScript,...args],{cwd:tmpdir(),encoding:'utf8',env,maxBuffer:64*1024*1024});

/**
 * 문자열의 SHA-256(16진)
 * @param {string} text 문자열
 * @returns {string} 해시
 */
const sha256=text=>createHash('sha256').update(text).digest('hex');

test('the same seed produces the same corpus bytes, another seed changes them, and suites do not depend on each other',()=>{
 const options={seed:20261102,count:300,suites:SUITES};
 const first=corpusText(options),second=corpusText(options);
 assert.equal(sha256(first),sha256(second));
 assert.notEqual(sha256(corpusText({...options,seed:20261103})),sha256(first));
 const lines=first.trimEnd().split('\n');
 assert.equal(lines.length,300*SUITES.length);
 // 스위트마다 시드에서 따로 난수 흐름을 만들므로, 한 스위트만 고르든 전부 고르든 그 스위트의 작업은 같다
 SUITES.forEach((suite,index)=>{
  assert.equal(corpusText({...options,suites:[suite]}),lines.slice(index*300,(index+1)*300).join('\n')+'\n',suite);
 });
});

test('every suite yields exactly count tasks, covers all of its operations and mixes every number source',()=>{
 for(const suite of SUITES){
  const cases=[...corpusCases({seed:7,count:2000,suites:[suite]})];
  assert.equal(cases.length,2000,suite);
  assert.ok(cases.every(item=>item.suite===suite&&typeof item.task.op==='string'),suite);
  assert.deepEqual([...new Set(cases.map(item=>item.task.op))].sort(),[...SUITE_OPS[suite]].sort(),suite);
  if(NUMBER_SUITES.includes(suite))assert.deepEqual([...new Set(cases.map(item=>item.source))].sort(),[...NUMBER_SOURCES].sort(),suite);
 }
 for(const name of ['randomBits','shortDecimal','exactTie','near2p53','boundary','subnormal','priceDecimal'])assert.ok(NUMBER_SOURCES.includes(name),name);
});

test('the CLI prints the same corpus bytes as the module from a separate process',()=>{
 const args=['--emit-corpus','--seed','9','--count','150'];
 const first=runConformance(args),second=runConformance(args);
 assert.equal(first.status,0,first.stderr);
 assert.equal(first.stdout,second.stdout);
 assert.equal(first.stdout,corpusText({seed:9,count:150,suites:SUITES}));
});

test('the oracle computes the JS engine results for exact inputs and normalizes NaN',()=>{
 const expected=createOracle();
 const number=(op,value,extra={})=>expected({op,x:bitsOf(value),...extra});
 assert.equal(number('toString',1e21),'1e+21');
 assert.equal(number('toString',-0),'0');
 assert.equal(number('toFixed',0.125,{d:2}),'0.13');
 assert.equal(number('toFixed',-1e-10,{d:2}),'-0.00');
 assert.equal(number('toPrecision',123456789012344.5,{p:15}),'123456789012345');
 assert.equal(number('toExponential',123.456),'1.23456e+2');
 assert.equal(number('toExponential',0,{d:2}),'0.00e+0');
 assert.equal(number('round',-0.4),'8000000000000000');
 assert.equal(number('round',-2.5),bitsOf(-2));
 assert.equal(number('round',numberOf('7ff0000000000001')),'NaN');
 assert.equal(number('sign',-0),'8000000000000000');
 assert.equal(expected({op:'max',xs:[bitsOf(NaN),bitsOf(1)]}),'NaN');
 assert.equal(expected({op:'max',xs:[bitsOf(-0),bitsOf(0)]}),'0000000000000000');
 assert.equal(expected({op:'max',xs:[]}),bitsOf(-Infinity));
 assert.equal(expected({op:'min',xs:[bitsOf(0),bitsOf(-0)]}),'8000000000000000');
 assert.equal(number('toInt32',4294967296.5),'0');
 assert.equal(number('toInt32',2147483648),'-2147483648');
 assert.equal(number('toUint32',-1),'4294967295');
 assert.equal(expected({op:'objectIs',x:'7ff8000000000000',y:'fff8000000000001'}),'true');
 assert.equal(expected({op:'objectIs',x:bitsOf(0),y:bitsOf(-0)}),'false');

 assert.equal(expected({op:'json',text:utf8Of('{"b":1,"2":2,"a":3,"1":4}')}),utf8Of('{"1":4,"2":2,"b":1,"a":3}'));
 assert.equal(expected({op:'json',text:utf8Of('{"a":1,"a":2,"__proto__":0}')}),utf8Of('{"a":2,"__proto__":0}'));
 assert.equal(expected({op:'json',text:utf8Of('[1e400,-0,"\\ud800","\u2028"]')}),utf8Of('[null,0,"\\ud800","\u2028"]'));
 assert.equal(expected({op:'json',text:utf8Of('{"a":1,}')}),'E:SyntaxError');
 const special=token=>`{${JSON.stringify(SENTINEL_KEY)}:"${token}"}`;
 const carrier=`[${special('NaN')},-0,${special('Infinity')},{"4294967295":1,"1":${special('undefined')},"__proto__":${special('-Infinity')}}]`;
 assert.equal(expected({op:'jsonLossless',text:utf8Of('[NaN,-0,Infinity,{"4294967295":1,"1":undefined,"__proto__":-Infinity}]'),carrier:utf8Of(carrier)}),
  `${utf8Of('[null,0,null,{"4294967295":1,"__proto__":null}]')},${utf8Of('[NaN,-0,Infinity,{"1":undefined,"4294967295":1,"__proto__":-Infinity}]')}`);
 assert.equal(expected({op:'jsonLossless',text:utf8Of('undefined'),carrier:utf8Of(special('undefined'))}),`${utf8Of('null')},${utf8Of('undefined')}`);
 // jsonUnits: JS 문자열(코드 단위)에 JSON.parse. 문자열 안 원문 단독 서로게이트는 그 단위, 문자열 밖이면 SyntaxError다
 assert.equal(expected({op:'jsonUnits',units:unitsOf('{"text":"\ud83d"}')}),utf8Of('{"text":"\\ud83d"}'));
 assert.equal(expected({op:'jsonUnits',units:unitsOf('"\ud83d\\ude00"')}),utf8Of('"\u{1f600}"'));
 assert.equal(expected({op:'jsonUnits',units:unitsOf('[\ud83d]')}),'E:SyntaxError');

 assert.equal(expected({op:'trim',units:unitsOf('\ufeff a\u0085 \u180e')}),unitsOf('a\u0085 \u180e'));
 assert.equal(expected({op:'toLowerCase',units:unitsOf('blac\u212a \u0391\u03a3')}),unitsOf('black \u03b1\u03c2'));
 assert.equal(expected({op:'toLowerCase',units:unitsOf('\u03a3\ud800\u03a3')}),unitsOf('\u03c3\ud800\u03c3'));
 assert.equal(expected({op:'slice',units:unitsOf('\ud83d\ude00'),start:0,end:1}),'d83d');
 assert.equal(expected({op:'slice',units:unitsOf('abcdef'),start:-2}),unitsOf('ef'));
 assert.equal(expected({op:'length',units:unitsOf('\ud83d\ude00')}),'2');
 assert.equal(expected({op:'isWhitespace',unit:0xfeff}),'true');
 assert.equal(expected({op:'isWhitespace',unit:0x85}),'false');
 assert.equal(expected({op:'quote',units:unitsOf('\ud800\u2028\u007f\u001f"/')}),utf8Of('"\\ud800\u2028\u007f\\u001f\\"/"'));

 assert.equal(expected({op:'dateUtc',args:[2026,2,9,13,30,0,0].map(bitsOf)}),bitsOf(1773063000000));
 assert.equal(expected({op:'dateUtc',args:[99,0,1,0,0,0,0].map(bitsOf)}),bitsOf(Date.UTC(1999,0,1)));
 assert.equal(expected({op:'timeClip',t:bitsOf(-0.5)}),'0000000000000000');
 assert.equal(expected({op:'toISOString',t:bitsOf(-62198755200000)}),'-000001-01-01T00:00:00.000Z');
 assert.equal(expected({op:'toISOString',t:bitsOf(8.64e15+1)}),'E:RangeError');
 assert.equal(expected({op:'daysFromCivil',year:1970,month:1,day:1}),'0');
 assert.equal(expected({op:'daysFromCivil',year:2024,month:3,day:0}),String(Date.UTC(2024,1,29)/86400000));
 assert.equal(expected({op:'daysFromCivil',year:50,month:13,day:1}),String(new Date(0).setUTCFullYear(51,0,1)/86400000));
 assert.equal(expected({op:'civilFromDays',days:-1}),'1969,12,31');
 assert.equal(expected({op:'parseIsoDate',text:utf8Of('2024-02-29')}),'2024,2,29');
 assert.equal(expected({op:'parseIsoDate',text:utf8Of('2026-02-30')}),'none');
 assert.equal(expected({op:'parseIsoDate',text:utf8Of('0999-01-01')}),'none');
 assert.equal(expected({op:'parseIsoDate',text:utf8Of('2026-0\u0663-01')}),'none');
 assert.equal(expected({op:'parseIsoClock',text:utf8Of('09:30')}),'9,30,0');
 assert.equal(expected({op:'parseIsoClock',text:utf8Of('23:59:59')}),'23,59,59');
 assert.equal(expected({op:'parseIsoClock',text:utf8Of('24:00')}),'none');
});

test('the engine script is self-contained and reproduces the oracle in a fresh context without Node globals',()=>{
 const tasks=[...corpusCases({seed:11,count:40,suites:SUITES})].map(item=>item.task);
 const expected=createOracle();
 const output=vm.runInNewContext(engineScript(tasks),{},{timeout:60000});
 assert.equal(output,tasks.map(expected).join('\n'));
});

/** 가짜 커널: 오라클 결과를 돌려준다. FAKE_CORRUPT_LINE번째 결과를 틀리게, FAKE_STOP_AFTER개 뒤에 멈출 수 있다(process.exit 없이 출력을 비우고 끝난다) */
const FAKE_KERNEL=conformanceUrl=>[
 `import {createOracle} from ${JSON.stringify(conformanceUrl)};`,
 'import {createInterface} from \'node:readline\';',
 'if(process.argv.includes(\'--unicode-version\'))console.log(`${process.versions.unicode}.0`);',
 'else{',
 ' const expected=createOracle(),corrupt=Number(process.env.FAKE_CORRUPT_LINE??0),stop=Number(process.env.FAKE_STOP_AFTER??Infinity);',
 ' let line=0;',
 ' for await(const text of createInterface({input:process.stdin,crlfDelay:Infinity})){',
 '  if(++line>stop)break;',
 '  const result=expected(JSON.parse(text));',
 '  process.stdout.write(JSON.stringify({r:line===corrupt?result+\'X\':result})+\'\\n\');',
 ' }',
 ' process.stdin.destroy();',
 '}',
 '',
].join('\n');

test('the harness passes a correct kernel, reports a wrong result and fails on missing results, and merges reports',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'barochart-conformance-'));
 try{
  const kernel=join(dir,'fake-kernel.mjs'),binary=join(dir,'bc-conformance'),report=join(dir,'report.json');
  await writeFile(kernel,FAKE_KERNEL(pathToFileURL(conformanceScript).href));
  await writeFile(binary,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(kernel)} "$@"\n`);
  await chmod(binary,0o755);
  const common=['--binary',binary,'--count','25','--seed','5'];

  const passed=runConformance([...common,'--report',report]);
  assert.equal(passed.status,0,passed.stdout+passed.stderr);
  assert.match(passed.stdout,/conformance: PASS/);
  assert.match(passed.stdout,new RegExp(`\\b${25*SUITES.length} compared\\b`));
  assert.match(passed.stdout,/\b0 mismatches\b/);

  const corrupted=runConformance(common,{...process.env,FAKE_CORRUPT_LINE:'7'});
  assert.equal(corrupted.status,1,corrupted.stdout+corrupted.stderr);
  assert.match(corrupted.stdout,/MISMATCH number#6 op=toString/);
  assert.match(corrupted.stdout,/conformance: FAIL/);
  assert.match(corrupted.stdout,/\b1 mismatch\b/);

  const truncated=runConformance(common,{...process.env,FAKE_STOP_AFTER:'10'});
  assert.equal(truncated.status,2,truncated.stdout+truncated.stderr);
  assert.match(truncated.stderr,/ended after 10 of \d+ results/);

  assert.equal(runConformance([...common,'--seed','6','--report',report]).status,0);
  assert.equal(runConformance([...common,'--report',report]).status,0);
  const saved=JSON.parse(await readFile(report,'utf8'));
  assert.equal(saved.schema,'barochart.rust-js-kernel-conformance');
  assert.deepEqual(saved.runs.map(run=>run.seed).sort(),[5,6]);
  assert.ok(saved.runs.every(run=>run.result==='pass'&&run.totals.mismatches===0&&run.totals.compared===25*SUITES.length));
  // 연산별 개수는 수여야 한다. 'toString' 같은 연산 이름이 Object.prototype의 메서드를 읽으면 개수가 문자열로 자라며 메모리를 잡아먹는다
  for(const run of saved.runs)for(const suite of SUITES){
   const counts=run.bySuite[suite].ops;
   assert.deepEqual(Object.keys(counts).sort(),[...SUITE_OPS[suite]].sort(),suite);
   assert.ok(Object.values(counts).every(Number.isInteger),`${suite} op counts must be integers`);
   assert.equal(Object.values(counts).reduce((sum,value)=>sum+value,0),25,suite);
  }

  const usage=runConformance(['--suite','nope']);
  assert.equal(usage.status,2);
  assert.match(usage.stderr,/--suite/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * 고정한 Rust 툴체인으로 cargo를 부를 수 있는지 본다. rustup이 툴체인을 몰래 내려받지 않게 설치 목록만 읽는다.
 * @returns {string|null} 건너뛸 이유, 부를 수 있으면 null
 */
function cargoSkipReason(){
 const bin=rustupBinDirectory(process.env);
 if(!existsSync(join(bin,'cargo'))||!existsSync(join(bin,'rustup')))return `rustup cargo is not installed in ${bin}; install rustup to run the Rust kernel comparison`;
 const channel=/^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root,'rust/rust-toolchain.toml'),'utf8'))?.[1];
 const listed=spawnSync(join(bin,'rustup'),['toolchain','list'],{encoding:'utf8'});
 if(listed.status!==0)return `rustup toolchain list failed (${listed.stderr.trim()}); check the rustup installation`;
 if(!listed.stdout.split('\n').some(line=>line.startsWith(`${channel}-`)))return `Rust ${channel} is not installed; run rustup toolchain install in rust/ to compare the kernel`;
 return null;
}

test('the Rust kernel matches V8 on a 2000-case corpus of every suite',t=>{
 const reason=cargoSkipReason();
 if(reason){t.skip(reason);return;}
 const result=runConformance(['--count','2000']);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/conformance: PASS/);
 assert.match(result.stdout,/\b0 mismatches\b/);
 const [,compared,excluded]=/(\d+) compared, (\d+) excluded/.exec(result.stdout)??[];
 assert.equal(Number(compared)+Number(excluded),2000*SUITES.length);
});
