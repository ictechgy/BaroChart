// node --import로 올리는 호출 추적 preload(설계 §6.5-1, M0 Task 5). 테스트 파일은 고치지 않는다.
// 환경 변수 BAROCHART_TRACE_DIR가 비어 있지 않을 때만 동작한다. 꺼져 있으면 vm을 건드리지 않고 파일도 만들지 않는다.
// 켜져 있으면 vm.runInContext와 vm.Script.prototype.runInContext를 감싸, 실행한 소스가 생성 번들
// ('// Generated from src/core')로 시작하면 그 컨텍스트에 기록기(scripts/trace/record.mjs)를 단다.
// vm.Script 인스턴스는 소스를 드러내지 않으므로 생성자도 Proxy로 감싸 번들 소스만 기억한다.
// 파일: <dir>/<테스트 파일 이름>-<n>.jsonl(n은 프로세스 안에서 번들을 올린 컨텍스트 순번, 1부터),
//       옆 파일 <…>.meta.json(번들 해시·시작 전역·멈춘 자리), 번들 원문 <dir>/bundles/<sha256>.js
import module from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {basename,dirname,extname,join,relative} from 'node:path';
import vm from 'node:vm';
import {stringifyLossless} from '../../scripts/trace/bcjson.mjs';
import {installTraceRecorder,traceArgumentsIssue} from '../../scripts/trace/record.mjs';

/** 생성 번들의 첫 줄 머리(scripts/native-core-bundle.mjs가 쓴다) */
const BUNDLE_HEADER='// Generated from src/core';
/** 이 프로세스 realm의 평범한 객체·배열 프로토타입. 시작 전역이 재생에서 되살릴 수 있는 값인지 볼 때 쓴다. */
const HOST_REALM={objectPrototype:Object.prototype,arrayPrototype:Array.prototype};
/** 추적 폴더. 빈 문자열이면 꺼진 것으로 본다. */
const traceDirectory=process.env.BAROCHART_TRACE_DIR;

if(traceDirectory)enableTracing(traceDirectory);

/**
 * 추적 파일 이름의 앞부분을 만든다. test/api.test.mjs → api.test
 * @param {string|undefined} entry process.argv[1]
 * @returns {string} 확장자를 뺀 실행 파일 이름(없으면 'node')
 */
function traceBaseName(entry){return entry?basename(entry,extname(entry)):'node';}

/**
 * 번들을 올리기 전 컨텍스트의 자기 전역을 재생용으로 나눈다. 서술자로 읽어 게터를 부르지 않는다.
 * - globals: BCJSON으로 되살릴 수 있는 평범한 값(예: {Intl: undefined}, 시나리오 문자열)
 * - hostGlobals: 이 프로세스의 같은 이름 전역과 같은 값(예: console, Intl)
 * - opaqueGlobals: 되살릴 수 없는 값(테스트가 넣은 함수·shim 등). 재생기는 이런 추적을 거절한다.
 * @param {object} context 컨텍스트로 만든 샌드박스 객체
 * @returns {{globals: string, hostGlobals: string[], opaqueGlobals: string[]}} 옆 파일에 넣을 시작 전역
 */
function startingGlobals(context){
 const values={},hostGlobals=[],opaqueGlobals=[];
 for(const key of Reflect.ownKeys(context)){
  if(typeof key==='symbol'){opaqueGlobals.push(String(key));continue;}
  const descriptor=Object.getOwnPropertyDescriptor(context,key);
  if(!Object.hasOwn(descriptor,'value'))opaqueGlobals.push(key);
  else if(descriptor.value!==undefined&&Object.hasOwn(globalThis,key)&&descriptor.value===globalThis[key])hostGlobals.push(key);
  else if(traceArgumentsIssue([descriptor.value],HOST_REALM)===null)values[key]=descriptor.value;
  else opaqueGlobals.push(key);
 }
 return {globals:stringifyLossless(values),hostGlobals,opaqueGlobals};
}

/**
 * 번들 원문을 해시 이름으로 한 번만 저장한다. 테스트 파일을 동시에 돌려도 깨지지 않게 임시 파일을 옮긴다.
 * @param {string} path 저장 경로
 * @param {string} source 번들 원문
 * @returns {void}
 */
function saveBundle(path,source){
 if(existsSync(path))return;
 mkdirSync(dirname(path),{recursive:true});
 const temporary=`${path}.${process.pid}.tmp`;
 writeFileSync(temporary,source);
 renameSync(temporary,path);
}

/**
 * vm을 감싸 생성 번들을 올린 컨텍스트마다 기록기를 단다.
 * @param {string} directory 추적 폴더
 * @returns {void}
 */
function enableTracing(directory){
 const name=traceBaseName(process.argv[1]);
 const originalRunInContext=vm.runInContext;
 const OriginalScript=vm.Script;
 const originalScriptRun=OriginalScript.prototype.runInContext;
 /** vm.Script 생성자에 넘긴 소스 가운데 생성 번들만 기억한다 */
 const bundleSources=new WeakMap();
 /** 기록기를 단 컨텍스트 → installTraceRecorder 결과 */
 const recorders=new WeakMap();
 let contexts=0;

 /**
  * 번들 실행을 감싼다. 시작 전역은 실행 전에 읽고, 기록기는 실행이 성공한 뒤 단다.
  * 같은 컨텍스트에 번들을 다시 올리면 새 함수가 감싼 함수를 덮으므로 그 추적은 멈춘다.
  * @param {unknown} context runInContext에 넘긴 컨텍스트
  * @param {string} source 번들 원문
  * @param {() => unknown} run 원래 실행
  * @returns {unknown} 원래 실행 결과
  */
 function traceBundleRun(context,source,run){
  if(!vm.isContext(context))return run();
  const existing=recorders.get(context);
  const globals=existing?null:startingGlobals(context);
  const preexisting=Reflect.ownKeys(context).filter(key=>typeof key==='string');
  const result=run();
  if(existing){existing.stop('bundle evaluated again in the same context');return result;}
  const sha256=createHash('sha256').update(source,'utf8').digest('hex');
  const bundlePath=`bundles/${sha256}.js`;
  saveBundle(join(directory,bundlePath),source);
  const path=join(directory,`${name}-${++contexts}.jsonl`);
  const meta={source:process.argv[1]?relative(process.cwd(),process.argv[1]):null,bundle:{sha256,length:source.length,path:bundlePath},...globals};
  recorders.set(context,installTraceRecorder(context,{path,meta,preexisting}));
  return result;
 }

 vm.Script=new Proxy(OriginalScript,{
  construct(target,args,newTarget){
   const script=Reflect.construct(target,args,newTarget);
   if(typeof args[0]==='string'&&args[0].startsWith(BUNDLE_HEADER))bundleSources.set(script,args[0]);
   return script;
  },
 });
 OriginalScript.prototype.runInContext=function(context,...rest){
  const source=bundleSources.get(this);
  const run=()=>Reflect.apply(originalScriptRun,this,[context,...rest]);
  return source===undefined?run():traceBundleRun(context,source,run);
 };
 vm.runInContext=function(code,context,...rest){
  const run=()=>Reflect.apply(originalRunInContext,this,[code,context,...rest]);
  return typeof code==='string'&&code.startsWith(BUNDLE_HEADER)?traceBundleRun(context,code,run):run();
 };
 // import {runInContext, Script} from 'node:vm' 같은 이름 가져오기에도 감싼 값이 보이게 한다.
 module.syncBuiltinESMExports();
}
