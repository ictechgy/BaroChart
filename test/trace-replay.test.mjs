// 호출 추적 기록기·재생기·preload(설계 §6.5-1, §7.3, M0 Task 5)를 확인한다.
// node:vm에 올린 번들의 최상위 native* 호출을 BCJSON 줄로 남기고, 새 컨텍스트에 같은 번들을 올려
// 줄 순서대로 다시 부르면 결과와 오류가 바이트 단위로 같아야 한다. 이것이 이음새 리팩터링 전후 동작 보존과
// Rust 재생의 기준이 되므로, 기록은 호출된 값을 건드리지 않고(게터·Proxy 트랩 금지) 재현할 수 없는 호출에서 멈춘다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseLossless,stringifyLossless} from '../scripts/trace/bcjson.mjs';
import {installTraceRecorder} from '../scripts/trace/record.mjs';
import {replayTrace} from '../scripts/trace/replay-js.mjs';

/** 커밋된 번들 경로. 기록과 재생이 같은 원문을 쓴다. */
const BUNDLE_PATH=fileURLToPath(new URL('../native/Resources/aster-core.js',import.meta.url));
/** 커밋된 번들 원문 */
const BUNDLE=readFileSync(BUNDLE_PATH,'utf8');
/** node --import로 올리는 기록 preload */
const PRELOAD=fileURLToPath(new URL('./helpers/trace-preload.mjs',import.meta.url));
/** 재생 CLI */
const REPLAY_CLI=fileURLToPath(new URL('../scripts/trace/replay-js.mjs',import.meta.url));
/** 기록기 모듈(자식 프로세스 스크립트가 가져온다) */
const RECORD_MODULE=fileURLToPath(new URL('../scripts/trace/record.mjs',import.meta.url));
/** 시험 막대 40개. 소수 가격을 섞어 숫자 표기도 함께 본다. */
const BARS=Array.from({length:40},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:101.5+i,low:99.25+i,close:100.75+i,volume:1000+i}));
/** 계획 Step 1의 세션: 초기화, 데이터, 드로잉, append, 장면, 실패하는 명령 */
const SESSION=`(()=>{
 nativeInit(0,{panels:[{id:'price'}],series:[{id:'p',type:'candles',panel:'price'}]});
 nativeCommand('setData',[${JSON.stringify(BARS)}]);
 const drawing=nativeCommand('addDrawing',[{type:'horizontal',points:[{time:1700000600000,price:110.5}]}]);
 nativeCommand('applyDataEvent',[{kind:'append',bar:{time:1700002400000,open:140,high:141,low:139,close:140.5,volume:2000}}]);
 const scene=nativeSceneJSON(400,300);
 let failure='';
 try{nativeCommand('nope',[]);}catch(error){failure=error.name+': '+error.message;}
 return JSON.stringify({drawing,sceneLength:scene.length,failure});
})()`;

/**
 * 테스트마다 따로 쓰는 임시 폴더를 만든다.
 * @returns {string} 비어 있는 새 폴더 경로
 */
function scratch(){return mkdtempSync(join(tmpdir(),'barochart-trace-'));}

/**
 * 번들을 올린 새 컨텍스트에 기록기를 단다.
 * @param {string} path 추적 파일 경로
 * @returns {vm.Context} 기록 중인 컨텍스트
 */
function recordedContext(path){
 const context=vm.createContext({});
 vm.runInContext(BUNDLE,context);
 installTraceRecorder(context,{path});
 return context;
}

/**
 * 추적 파일을 줄 단위 원문으로 읽는다.
 * @param {string} path 추적 파일 경로
 * @returns {string[]} 빈 줄을 뺀 BCJSON 줄
 */
function rawLines(path){return readFileSync(path,'utf8').split('\n').filter(line=>line!=='');}

/**
 * 추적 파일을 줄마다 파싱한다.
 * @param {string} path 추적 파일 경로
 * @returns {any[]} 줄 객체 목록
 */
function traceLines(path){return rawLines(path).map(line=>parseLossless(line));}

test('a recorded native session replays with zero mismatches',()=>{
 const dir=scratch(),path=join(dir,'session.jsonl');
 try{
  const context=recordedContext(path);
  const summary=JSON.parse(vm.runInContext(SESSION,context));
  assert.equal(summary.failure,'TypeError: Unknown chart command or argument list');
  const lines=traceLines(path);
  assert.deepEqual(lines.map(line=>line.fn),['nativeInit','nativeCommand','nativeCommand','nativeCommand','nativeSceneJSON','nativeCommand']);
  assert.deepEqual(lines[1].args,['setData',[BARS]],'arguments are recorded before the call');
  assert.equal(lines[2].ok,summary.drawing);
  assert.equal(lines[4].ok.length,summary.sceneLength);
  assert.ok(lines.slice(0,5).every(line=>Object.hasOwn(line,'ok')&&!Object.hasOwn(line,'err')));
  assert.deepEqual(lines[5].err,{name:'TypeError',message:'Unknown chart command or argument list',code:undefined});
  assert.ok(rawLines(path)[5].endsWith(',"err":{"name":"TypeError","message":"Unknown chart command or argument list","code":undefined}}'));
  assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:6,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('changing one recorded result gives exactly one mismatch',()=>{
 const dir=scratch(),path=join(dir,'session.jsonl'),tampered=join(dir,'tampered.jsonl');
 try{
  vm.runInContext(SESSION,recordedContext(path));
  const lines=rawLines(path),record=parseLossless(lines[2]),original=stringifyLossless(record.ok);
  record.ok='tampered';
  lines[2]=stringifyLossless(record);
  writeFileSync(tampered,lines.join('\n')+'\n');
  const result=replayTrace(tampered,{bundlePath:BUNDLE_PATH});
  assert.equal(result.calls,6);
  assert.deepEqual(result.mismatches,[{line:3,expected:'{"ok":"tampered"}',actual:`{"ok":${original}}`}],'the comparison text carries the outcome kind');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('host writes into returned Float64Array views are recorded and replayed',()=>{
 const dir=scratch(),path=join(dir,'views.jsonl'),withoutWrite=join(dir,'without-write.jsonl');
 try{
  const context=recordedContext(path);
  vm.runInContext(`nativeInit(0,{series:[]});nativeCommand('setData',[${JSON.stringify(BARS.slice(0,12))}]);nativeCommand('addIndicator',['s','sma',{period:3}]);`,context);
  const view=context.nativeIndicatorBuffer('s','value',0,8);
  view[5]=12345.5;
  const values=JSON.parse(vm.runInContext(`JSON.stringify(nativeCommand('indicatorValues',['s']))`,context));
  assert.equal(values[5],12345.5,'the core reads the host write');
  const lines=traceLines(path);
  assert.deepEqual(lines.map(line=>line.fn??'write'),['nativeInit','nativeCommand','nativeCommand','nativeIndicatorBuffer','write','nativeCommand']);
  const bytes=new Uint8Array(view.buffer,view.byteOffset,view.byteLength);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(lines[3].ok,{f64:true,length:8,sha256:lines[3].ok.sha256},'the view result is an F64 token');
  assert.notEqual(lines[3].ok.sha256,sha256,'the token hashes the bytes the core returned');
  assert.deepEqual(lines[4],{write:{view:0,sha256,data:Buffer.from(bytes).toString('base64')}});
  assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:5,mismatches:[]});
  writeFileSync(withoutWrite,rawLines(path).filter((_,index)=>index!==4).join('\n')+'\n');
  const missing=replayTrace(withoutWrite,{bundlePath:BUNDLE_PATH});
  assert.deepEqual(missing.mismatches.map(mismatch=>mismatch.line),[5],'dropping the write line changes the next result');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('host writes through an alias are recorded even after the returned view is collected',()=>{
 const dir=scratch(),script=join(dir,'alias.mjs'),path=join(dir,'alias.jsonl');
 try{
  // 돌려준 뷰가 수거된 뒤에도 같은 메모리의 별칭으로 쓴 내용이 추적에 남아야 실행마다 같은 추적이 나온다.
  writeFileSync(script,[
   `import vm from 'node:vm';`,
   `import {readFileSync} from 'node:fs';`,
   `import {installTraceRecorder} from ${JSON.stringify(pathToFileURL(RECORD_MODULE).href)};`,
   `const context=vm.createContext({});`,
   `vm.runInContext(readFileSync(${JSON.stringify(BUNDLE_PATH)},'utf8'),context);`,
   `installTraceRecorder(context,{path:${JSON.stringify(path)}});`,
   `vm.runInContext(${JSON.stringify(`nativeInit(0,{series:[]});nativeCommand('setData',[${JSON.stringify(BARS.slice(0,12))}]);nativeCommand('addIndicator',['s','sma',{period:3}]);`)},context);`,
   `let view=context.nativeIndicatorBuffer('s','value',0,8);`,
   `const alias=new Float64Array(view.buffer,view.byteOffset,view.length);`,
   `view=null;`,
   `for(let i=0;i<3;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}`,
   `alias[5]=777.25;`,
   `vm.runInContext("nativeCommand('indicatorValues',['s'])",context);`,
  ].join('\n'));
  const run=spawnSync(process.execPath,['--expose-gc',script],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(traceLines(path).map(line=>line.fn??'write'),['nativeInit','nativeCommand','nativeCommand','nativeIndicatorBuffer','write','nativeCommand']);
  assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:5,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('only top-level calls are recorded',()=>{
 const dir=scratch(),path=join(dir,'nested.jsonl');
 try{
  const context=recordedContext(path);
  vm.runInContext('nativeComparisonDemo();nativeEcho([NaN,-0,undefined,"\\ud800"]);',context);
  const lines=traceLines(path);
  assert.deepEqual(lines.map(line=>line.fn),['nativeComparisonDemo','nativeEcho'],'nativeInit inside nativeComparisonDemo is not a separate line');
  assert.equal(rawLines(path)[1],'{"fn":"nativeEcho","args":[[NaN,-0,undefined,"\\ud800"]],"ok":[NaN,-0,undefined,"\\ud800"]}');
  assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:2,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('arguments that a trace cannot reproduce stop the recording without touching them',()=>{
 const dir=scratch();
 try{
  const cases=[
   ['accessor','argument: accessor',context=>vm.runInContext('globalThis.hits=0;nativeEcho({get x(){hits++;return 1;}})',context),context=>vm.runInContext('hits',context)],
   ['proxy','argument: proxy',context=>vm.runInContext('globalThis.hits=0;nativeEcho(new Proxy({},{ownKeys(){hits++;return [];},get(){hits++;}}))',context),context=>vm.runInContext('hits',context)],
   ['foreign','argument: prototype',context=>context.nativeEcho({outer:true}),()=>0],
   ['function','argument: function',context=>vm.runInContext('nativeEcho(function(){})',context),()=>0],
  ];
  for(const [name,reason,call,hits] of cases){
   const path=join(dir,`${name}.jsonl`),context=recordedContext(path);
   vm.runInContext(`nativeInit(0,{series:[]});`,context);
   call(context);
   vm.runInContext(`nativeEcho(1)`,context);
   assert.equal(hits(context),0,`${name}: inspection runs no getter or trap`);
   assert.deepEqual(traceLines(path).map(line=>line.fn),['nativeInit'],`${name}: the trace stays a faithful prefix`);
   assert.deepEqual(JSON.parse(readFileSync(join(dir,`${name}.meta.json`),'utf8')).stopped,{line:2,fn:'nativeEcho',reason},name);
   assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:1,mismatches:[]},name);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('touching core globals outside native calls stops the recording and the core never sees the guard',()=>{
 const dir=scratch();
 try{
  const cases=[
   ['inner-read','out-of-band read: nativeAPI',context=>vm.runInContext(`nativeAPI.setData(${JSON.stringify(BARS)});`,context)],
   ['outer-read','out-of-band read: Aster',context=>assert.equal(typeof context.Aster.ChartModel,'function')],
   ['inner-write','out-of-band write: nativeSize',context=>vm.runInContext('globalThis.nativeSize={width:1,height:1};',context)],
   ['outer-delete','out-of-band delete: nativeModel',context=>assert.equal(delete context.nativeModel,true)],
   ['new-bridge-global','out-of-band global: nativeLateGlobal',context=>vm.runInContext("Object.defineProperty(globalThis,'nativeLateGlobal',{value:undefined,configurable:false});",context)],
   ['builtin','out-of-band global: Math',context=>vm.runInContext('globalThis.Math=Math;',context)],
   ['replace','out-of-band replace: nativeSceneJSON',context=>vm.runInContext("globalThis.nativeSceneJSON=function(){return 'x';};",context)],
  ];
  for(const [name,reason,touch] of cases){
   const path=join(dir,`${name}.jsonl`),context=recordedContext(path);
   vm.runInContext(`nativeInit(0,{series:[]});nativeSceneJSON(300,200);`,context);
   touch(context);
   vm.runInContext(`try{nativeCommand('inspect');}catch(error){globalThis.inspectError=error.message;}`,context);
   assert.deepEqual(traceLines(path).map(line=>line.fn),['nativeInit','nativeSceneJSON'],name);
   assert.deepEqual(JSON.parse(readFileSync(join(dir,`${name}.meta.json`),'utf8')).stopped,{line:3,fn:null,reason},name);
   for(const key of ['Aster','nativeAPI','nativeInput'])assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(context,key),'value'),`${name}: ${key} is a plain data property again after the stop`);
   assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:2,mismatches:[]},name);
  }
  // 바깥에서 샌드박스를 얼려도 기록기가 호출을 깨뜨리지 않는다(지키던 접근자는 되돌릴 수 없어 그 자리에서 멈춘다).
  const frozenPath=join(dir,'frozen.jsonl'),frozen=recordedContext(frozenPath);
  vm.runInContext(`nativeInit(0,{series:[]});`,frozen);
  Object.freeze(frozen);
  assert.equal(typeof JSON.parse(JSON.stringify(frozen.nativeCommand('inspect'))).view,'object','the call still reaches the core');
  assert.deepEqual(traceLines(frozenPath).map(line=>line.fn),['nativeInit']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'frozen.meta.json'),'utf8')).stopped,{line:2,fn:null,reason:'out-of-band redefine: Aster'});
  // 코어가 이름으로 볼 수 없는 테스트 도우미 전역은 기록을 멈추지 않는다.
  const helperPath=join(dir,'helper.jsonl'),helper=recordedContext(helperPath);
  vm.runInContext(`nativeInit(0,{series:[]});globalThis.helperCount=1;globalThis.heldValue={a:1};nativeCommand('inspect');helperCount++;nativeEcho(helperCount);`,helper);
  assert.deepEqual(traceLines(helperPath).map(line=>line.fn),['nativeInit','nativeCommand','nativeEcho']);
  assert.equal(existsSync(join(dir,'helper.meta.json')),false,'no stop, so no side file without preload metadata');
  // 호출 안에서 코어가 보는 전역 서술자는 기록하지 않을 때와 같아야 한다(작업공간 대상의 빈 런타임 검사가 서술자 모양을 본다).
  // 지표 소스는 nativeRegisterIndicatorSource 호출 안에서 평가되므로, 그 소스가 던지는 문구로 호출 안의 서술자를 본다.
  const plain=vm.createContext({});vm.runInContext(BUNDLE,plain);
  const recordedPath=join(dir,'descriptors.jsonl'),recorded=recordedContext(recordedPath);
  const source=`(()=>{throw new Error(['nativeModel','nativeAPI','nativeInput','nativeSize','Aster'].map(key=>{const d=Object.getOwnPropertyDescriptor(globalThis,key);return d?key+':'+Object.keys(d).join(','):key+':none';}).join(';'));})()`;
  const probe=`nativeInit(0,{series:[]});nativeSceneJSON(300,200);(()=>{try{nativeRegisterIndicatorSource('probe',${JSON.stringify(source)});return 'no error';}catch(error){return error.message;}})()`;
  const seen=vm.runInContext(probe,recorded);
  assert.equal(seen,vm.runInContext(probe,plain));
  assert.match(seen,/^nativeModel:value,writable,enumerable,configurable;.*Aster:value,writable,enumerable,configurable$/);
  assert.deepEqual(traceLines(recordedPath).map(line=>line.fn),['nativeInit','nativeSceneJSON','nativeRegisterIndicatorSource']);
  assert.deepEqual(replayTrace(recordedPath,{bundlePath:BUNDLE_PATH}),{calls:3,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the preload records generated-bundle contexts only when BAROCHART_TRACE_DIR is set',()=>{
 const dir=scratch(),out=join(dir,'traces'),script=join(dir,'session.mjs');
 try{
  writeFileSync(script,`import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const bundle=readFileSync(${JSON.stringify(BUNDLE_PATH)},'utf8');
const plain=vm.createContext({});
vm.runInContext('globalThis.nativeLookalike=function(){return 1;};nativeLookalike();',plain);
const first=vm.createContext({});
vm.runInContext(bundle,first);
vm.runInContext("nativeInit(0,{series:[]});nativeEcho([NaN,-0,undefined]);",first);
const second=vm.createContext({scenario:'two'});
new vm.Script(bundle).runInContext(second);
second.nativeEcho('two');
const third=vm.createContext({console,hook(){return 3;}});
vm.runInContext(bundle,third);
third.nativeEcho(3);
`);
  const env={...process.env};delete env.BAROCHART_TRACE_DIR;
  const off=spawnSync(process.execPath,['--import',PRELOAD,script],{cwd:dir,env,encoding:'utf8'});
  assert.equal(off.status,0,off.stderr);
  assert.equal(existsSync(out),false,'nothing is written while tracing is off');
  const on=spawnSync(process.execPath,['--import',PRELOAD,script],{cwd:dir,env:{...env,BAROCHART_TRACE_DIR:out},encoding:'utf8'});
  assert.equal(on.status,0,on.stderr);
  assert.deepEqual(readdirSync(out).filter(name=>name.endsWith('.jsonl')).sort(),['session-1.jsonl','session-2.jsonl','session-3.jsonl']);
  assert.deepEqual(traceLines(join(out,'session-1.jsonl')).map(line=>line.fn),['nativeInit','nativeEcho']);
  assert.deepEqual(traceLines(join(out,'session-2.jsonl')),[{fn:'nativeEcho',args:['two'],ok:'two'}]);
  const meta=JSON.parse(readFileSync(join(out,'session-2.meta.json'),'utf8'));
  assert.equal(meta.bundle.sha256,createHash('sha256').update(BUNDLE).digest('hex'));
  assert.equal(readFileSync(join(out,meta.bundle.path),'utf8'),BUNDLE,'the exact bundle text is kept next to the trace');
  assert.deepEqual({globals:meta.globals,hostGlobals:meta.hostGlobals,opaqueGlobals:meta.opaqueGlobals,stopped:meta.stopped},{globals:'{"scenario":"two"}',hostGlobals:[],opaqueGlobals:[],stopped:null});
  for(const name of ['session-1.jsonl','session-2.jsonl'])assert.equal(replayTrace(join(out,name)).mismatches.length,0,name);
  const third=JSON.parse(readFileSync(join(out,'session-3.meta.json'),'utf8'));
  assert.deepEqual({globals:third.globals,hostGlobals:third.hostGlobals,opaqueGlobals:third.opaqueGlobals},{globals:'{}',hostGlobals:['console'],opaqueGlobals:['hook']});
  assert.throws(()=>replayTrace(join(out,'session-3.jsonl')),{message:'Trace context started with globals a replay cannot reproduce: hook'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the replayer only runs a side-file bundle stored as bundles/<sha256>.js',()=>{
 const dir=scratch(),path=join(dir,'session.jsonl');
 try{
  vm.runInContext('nativeEcho(1)',recordedContext(path));
  const sha256=createHash('sha256').update(BUNDLE).digest('hex');
  writeFileSync(join(dir,'evil.js'),BUNDLE);
  writeFileSync(join(dir,'session.meta.json'),JSON.stringify({bundle:{sha256,length:BUNDLE.length,path:'../'+join(dir,'evil.js')},globals:'{}',hostGlobals:[],opaqueGlobals:[],stopped:null}));
  assert.throws(()=>replayTrace(path),{message:`Trace bundle path must be bundles/<sha256>.js: ../${join(dir,'evil.js')}`});
  writeFileSync(join(dir,'session.meta.json'),JSON.stringify({bundle:{sha256,length:BUNDLE.length,path:`bundles/${'0'.repeat(64)}.js`},globals:'{}',hostGlobals:[],opaqueGlobals:[],stopped:null}));
  assert.throws(()=>replayTrace(path),{message:`Trace bundle path must be bundles/<sha256>.js: bundles/${'0'.repeat(64)}.js`},'the file name must be the recorded hash');
  assert.deepEqual(replayTrace(path,{bundlePath:BUNDLE_PATH}),{calls:1,mismatches:[]},'an explicit bundle path is the caller\'s choice');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the replay CLI prints a summary and exits 1 on a mismatch',()=>{
 const dir=scratch(),path=join(dir,'session.jsonl'),tampered=join(dir,'tampered.jsonl');
 try{
  vm.runInContext(SESSION,recordedContext(path));
  const good=spawnSync(process.execPath,[REPLAY_CLI,path,'--bundle',BUNDLE_PATH],{encoding:'utf8'});
  assert.equal(good.status,0,good.stderr);
  assert.deepEqual(JSON.parse(good.stdout),{trace:path,calls:6,mismatches:0});
  const lines=rawLines(path),record=parseLossless(lines[4]);
  record.ok=record.ok+' ';
  lines[4]=stringifyLossless(record);
  writeFileSync(tampered,lines.join('\n')+'\n');
  const bad=spawnSync(process.execPath,[REPLAY_CLI,tampered,'--bundle',BUNDLE_PATH],{encoding:'utf8'});
  assert.equal(bad.status,1);
  assert.deepEqual(JSON.parse(bad.stdout),{trace:tampered,calls:6,mismatches:1});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
