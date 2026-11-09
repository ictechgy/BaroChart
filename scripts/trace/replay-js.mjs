// 호출 추적 재생기(설계 §6.5-1, §7.3, M0 Task 5).
// 새 node:vm 컨텍스트에 번들을 올리고 추적 줄을 순서대로 다시 부른다. 결과와 오류는 BCJSON 글자로 비교한다.
// write 줄은 같은 순번의 Float64Array 뷰에 바이트를 써서 호스트 쓰기를 재현한다.
// CLI: node scripts/trace/replay-js.mjs <trace.jsonl> [--bundle <path>]
//   표준 출력에 요약 JSON {trace, calls, mismatches}를 쓰고, 불일치가 있으면 종료 코드 1이다.
import {existsSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {losslessMemberTexts,parseLossless,sha256Hex,stringifyLossless,writeFloat64LittleEndianBytes,float64LittleEndianBytes} from './bcjson.mjs';
import {HOST_CALLBACK_PROFILES,contextRealm,traceArgumentsIssue,traceErrorRecord,traceMetaPath,traceResultIssue} from './record.mjs';

/** 저장소 루트 */
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
/** 옆 파일이 없을 때 쓰는 커밋된 번들 */
export const DEFAULT_BUNDLE_PATH=resolve(ROOT,'native/Resources/aster-core.js');
/** 모듈을 읽을 때 잡아 둔 원래 vm.runInContext(preload가 감싸도 재생은 기록되지 않는다) */
const runInContext=vm.runInContext;
const PARSED_REALM={objectPrototype:Object.prototype,arrayPrototype:Array.prototype};
const HOST_ERROR_NAMES=new Set(['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']);

/**
 * 추적 옆 파일을 읽는다.
 * @param {string} path 추적 파일 경로
 * @returns {object|null} 옆 파일 내용, 없으면 null
 */
export function readTraceMeta(path){
 const metaPath=traceMetaPath(path);
 return existsSync(metaPath)?JSON.parse(readFileSync(metaPath,'utf8')):null;
}

/**
 * 기록 때와 같은 시작 전역으로 재생 컨텍스트를 만든다.
 * 평범한 값은 BCJSON에서 되살리고, 호스트 전역(console, 호스트 Intl 등)은 이 프로세스의 같은 이름 값을 넣는다.
 * @param {object|null} meta 옆 파일 내용
 * @returns {vm.Context} 번들을 올리기 전의 새 컨텍스트
 * @throws {Error} 재현할 수 없는 전역(테스트가 넣은 함수 등)으로 기록된 추적
 */
function createReplayContext(meta){
 if(meta?.opaqueGlobals?.length)throw new Error(`Trace context started with globals a replay cannot reproduce: ${meta.opaqueGlobals.join(', ')}`);
 const sandbox=meta?.globals?parseLossless(meta.globals):{};
 for(const name of meta?.hostGlobals??[])sandbox[name]=globalThis[name];
 return vm.createContext(sandbox);
}

/**
 * 파싱한 인자(이 realm의 평범한 값)를 재생 컨텍스트 realm의 평범한 값으로 옮긴다.
 * iOS·Android처럼 코어는 자기 realm에서 만든 값을 받는다. 다른 realm 객체는 프로토타입 검사에서 다르게 걸린다.
 * @param {unknown} value parseLossless가 돌려준 값(F64 토큰 없음)
 * @param {{object: () => object, array: () => unknown[]}} make 컨텍스트 realm에서 빈 객체·배열을 만드는 함수
 * @returns {unknown} 같은 모양의 컨텍스트 realm 값
 */
function intoContextRealm(value,make){
 if(value===null||typeof value!=='object')return value;
 const root=Array.isArray(value)?make.array():make.object();
 const pending=[[value,root]];
 while(pending.length){
  const [source,target]=pending.pop();
  for(const key of Object.keys(source)){
   const child=source[key];
   let copy=child;
   if(child!==null&&typeof child==='object'){copy=Array.isArray(child)?make.array():make.object();pending.push([child,copy]);}
   Object.defineProperty(target,key,{value:copy,writable:true,enumerable:true,configurable:true});
  }
 }
 return root;
}

function exactKeys(value,expected){
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const keys=Object.keys(value);
 return keys.length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
}

function hostTranscriptError(name,message){return new Error(`Host callback transcript ${name}: ${message}`);}

function parseTranscriptText(name,label,text){
 if(typeof text!=='string')throw hostTranscriptError(name,`${label} must be a BCJSON string`);
 let value;
 try{value=parseLossless(text);}catch(error){throw hostTranscriptError(name,`${label} is invalid BCJSON (${error.message})`);}
 let canonical;
 try{canonical=stringifyLossless(value);}catch(error){throw hostTranscriptError(name,`${label} is not replayable (${error.message})`);}
 if(canonical!==text)throw hostTranscriptError(name,`${label} must be canonical BCJSON`);
 return value;
}

function prepareTranscriptCall(name,profile,entry,index,make,makeError){
 if(entry===null||typeof entry!=='object'||Array.isArray(entry))throw hostTranscriptError(name,`call ${index} must be an object`);
 const outcomes=['ok','thrown','err'].filter(key=>Object.hasOwn(entry,key));
 if(outcomes.length!==1)throw hostTranscriptError(name,`call ${index} must have exactly one outcome`);
 const outcome=outcomes[0],keys=['phase','nativeOrdinal','receiver','args',outcome];
 if(!exactKeys(entry,keys))throw hostTranscriptError(name,`call ${index} has invalid keys`);
 if(entry.phase!=='native')throw hostTranscriptError(name,`call ${index} has invalid phase`);
 if(!Number.isSafeInteger(entry.nativeOrdinal)||entry.nativeOrdinal<0)throw hostTranscriptError(name,`call ${index} has invalid native ordinal`);
 if(!profile.receivers.includes(entry.receiver))throw hostTranscriptError(name,`call ${index} has invalid receiver`);
 const args=parseTranscriptText(name,`call ${index} arguments`,entry.args);
 if(!Array.isArray(args))throw hostTranscriptError(name,`call ${index} arguments must encode an array`);
 const argsIssue=traceArgumentsIssue(args,PARSED_REALM);
 if(argsIssue)throw hostTranscriptError(name,`call ${index} arguments contain ${argsIssue}`);
 if(outcome==='err'){
  const detail=entry.err;
  if(!exactKeys(detail,['name','message','code'])||typeof detail.name!=='string'||typeof detail.message!=='string'||typeof detail.code!=='string')throw hostTranscriptError(name,`call ${index} has invalid error outcome`);
  if(!HOST_ERROR_NAMES.has(detail.name))throw hostTranscriptError(name,`call ${index} has unsupported error name`);
  const code=parseTranscriptText(name,`call ${index} error code`,detail.code);
  if(code!==undefined&&code!==null&&typeof code!=='string'&&typeof code!=='number'&&typeof code!=='boolean')throw hostTranscriptError(name,`call ${index} has invalid error code`);
  return {...entry,throws:true,value:makeError(detail.name,detail.message,code,code!==undefined)};
 }
 const value=parseTranscriptText(name,`call ${index} ${outcome}`,entry[outcome]);
 const issue=traceArgumentsIssue([value],PARSED_REALM);
 if(issue)throw hostTranscriptError(name,`call ${index} ${outcome} contains ${issue}`);
 return {...entry,throws:outcome==='thrown',value:intoContextRealm(value,make)};
}

/**
 * Installs realm-local stubs for the explicitly recorded callback profiles.
 * The bridge is only a transcript matcher; callback source is never evaluated
 * during replay.
 * @param {vm.Context} context replay context
 * @param {object|null} meta trace metadata
 * @returns {{beginNative: (ordinal: number) => void, endNative: (ordinal: number) => void, assertHealthy: () => void, assertComplete: () => void}}
 */
function installHostCallbacks(context,meta){
 const configured=meta?.hostCallbacks;
 if(configured===undefined)return {beginNative(){},endNative(){},assertHealthy(){},assertComplete(){}};
 if(configured===null||typeof configured!=='object'||Array.isArray(configured))throw new Error('Trace hostCallbacks metadata must be a name-keyed object');
 const realm=contextRealm(context),globalObject=runInContext('globalThis',context);
 const factories=runInContext('[()=>({}),()=>[],(name,message,code,hasCode)=>{const constructors={Error,EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError};const error=new (constructors[name]??Error)(message);Object.defineProperty(error,"name",{value:name,writable:true,enumerable:false,configurable:true});if(hasCode)Object.defineProperty(error,"code",{value:code,writable:true,enumerable:true,configurable:true});return error;},(bridge,name,length)=>{const stub=function(){"use strict";const args=[];for(let index=0;index<arguments.length;index++)args[index]=arguments[index];const result=bridge(this,args);if(result[0])throw result[1];return result[1];};Object.defineProperty(stub,"name",{value:name});Object.defineProperty(stub,"length",{value:length});return stub;}]',context);
 const make={object:factories[0],array:factories[1]},makeError=factories[2],makeStub=factories[3];
 const states=new Map(),failures=[];
 for(const [name,transcript] of Object.entries(configured)){
  if(!Object.hasOwn(HOST_CALLBACK_PROFILES,name))throw new Error(`Unknown trace host callback profile: ${name}`);
  const profile=HOST_CALLBACK_PROFILES[name];
  if(!exactKeys(transcript,['profile','version','calls','complete'])||transcript.profile!==name||transcript.version!==profile.version||transcript.complete!==true||!Array.isArray(transcript.calls))throw new Error(`Incomplete trace host callback transcript: ${name}`);
  const calls=transcript.calls.map((entry,index)=>prepareTranscriptCall(name,profile,entry,index,make,makeError));
  for(let index=1;index<calls.length;index++)if(calls[index].nativeOrdinal<calls[index-1].nativeOrdinal)throw hostTranscriptError(name,`call ${index} native ordinal is out of order`);
  states.set(name,{name,calls,index:0,profile});
 }
 let activeNativeOrdinal=null;
 const fail=(name,message)=>{
  if(failures.length===0)failures.push(hostTranscriptError(name,message));
  throw failures[0];
 };
 for(const state of states.values()){
  const {name,profile}=state;
  const bridge=(receiver,args)=>{
   if(failures.length)throw failures[0];
   if(activeNativeOrdinal===null)return fail(name,'call outside native call');
   const entry=state.calls[state.index];
   if(entry===undefined)return fail(name,`extra call in native call ${activeNativeOrdinal}`);
   if(entry.nativeOrdinal!==activeNativeOrdinal)return fail(name,`native call ordinal mismatch (expected ${entry.nativeOrdinal}, got ${activeNativeOrdinal})`);
   const receiverClass=receiver===globalObject?'global':receiver===undefined?'undefined':null;
   if(receiverClass===null||receiverClass!==entry.receiver)return fail(name,'receiver mismatch');
   const issue=traceArgumentsIssue(args,realm);if(issue)return fail(name,`argument ${issue}`);
   let argsText;try{argsText=stringifyLossless(args);}catch(error){return fail(name,`argument ${error.message}`);}
   if(argsText!==entry.args)return fail(name,`argument mismatch (expected ${entry.args}, got ${argsText})`);
   state.index++;
   return [entry.throws,entry.value];
  };
  Object.defineProperty(context,name,{value:makeStub(bridge,name,profile.length),writable:true,enumerable:true,configurable:true});
 }
 return {
  beginNative(ordinal){
   this.assertHealthy();
   if(activeNativeOrdinal!==null)return fail('replay',`nested native call ${ordinal}`);
   for(const state of states.values()){
    const entry=state.calls[state.index];
    if(entry&&entry.nativeOrdinal<ordinal)return fail(state.name,`missing call(s) before native call ${ordinal}`);
   }
   activeNativeOrdinal=ordinal;
  },
  endNative(ordinal){
   if(activeNativeOrdinal!==ordinal)return fail('replay',`native call boundary mismatch for ${ordinal}`);
   activeNativeOrdinal=null;
   this.assertHealthy();
   for(const state of states.values()){
    const entry=state.calls[state.index];
    if(entry&&entry.nativeOrdinal<=ordinal)return fail(state.name,`missing call(s) in native call ${ordinal}`);
   }
  },
  assertHealthy(){if(failures.length)throw failures[0];},
  assertComplete(){
   this.assertHealthy();
   if(activeNativeOrdinal!==null)throw new Error(`Host callback transcript replay: native call ${activeNativeOrdinal} did not close`);
   for(const state of states.values())if(state.index!==state.calls.length)throw new Error(`Host callback transcript ${state.name}: missing call(s), consumed ${state.index} of ${state.calls.length}`);
  },
 };
}

/**
 * 재생한 호출의 결과를 기록과 같은 BCJSON 글자로 만든다. 결과의 Float64Array는 출력 순서대로 뷰 목록에 붙는다.
 * 비교 글자는 {"ok":…} 또는 {"err":…}이다. 종류까지 글자에 넣어 결과 값과 오류 레코드가 우연히 같아도 구분한다.
 * @param {boolean} threw 던졌는지
 * @param {unknown} error 던진 값
 * @param {unknown} result 결과
 * @param {{objectPrototype: object, arrayPrototype: object}} realm 컨텍스트 realm
 * @param {Float64Array[]} views 뷰 목록(결과 뷰를 덧붙인다)
 * @returns {string} 비교 글자
 */
function outcomeText(threw,error,result,realm,views){
 if(threw){
  const outcome=traceErrorRecord(error);
  return outcome.issue?`{"err":<unrepresentable ${outcome.issue}>}`:`{"err":${stringifyLossless(outcome.record)}}`;
 }
 const issue=traceResultIssue(result,realm);
 if(issue)return `{"ok":<unrepresentable ${issue}>}`;
 return `{"ok":${stringifyLossless(result,{onFloat64:view=>views.push(view)})}}`;
}

/**
 * 기록된 줄의 비교 글자를 원문에서 잘라 만든다(다시 쓰면 F64 토큰을 되돌릴 수 없으므로 원문을 쓴다).
 * @param {Map<string, string>} members losslessMemberTexts 결과
 * @returns {string} {"ok":…} 또는 {"err":…}
 */
function recordedText(members){
 if(members.has('err'))return `{"err":${members.get('err')}}`;
 return `{"ok":${members.get('ok')}}`;
}

/**
 * write 줄을 재생한다. 같은 순번의 뷰에 바이트를 쓴다.
 * @param {{view: number, sha256: string, data: string}} write write 줄 내용
 * @param {Float64Array[]} views 재생 중 결과로 받은 뷰
 * @returns {{expected: string, actual: string}|null} 재현하지 못하면 불일치 설명
 */
function replayWrite(write,views){
 const bytes=new Uint8Array(Buffer.from(write.data,'base64'));
 if(sha256Hex(bytes)!==write.sha256)throw new Error(`Trace write line for view ${write.view} has data that does not match its sha256`);
 const view=views[write.view];
 if(view===undefined)return {expected:`{"write":view ${write.view}}`,actual:`{"write":${views.length} views}`};
 const length=float64LittleEndianBytes(view).length;
 if(length!==bytes.length)return {expected:`{"write":${bytes.length} bytes}`,actual:`{"write":${length} bytes}`};
 writeFloat64LittleEndianBytes(view,bytes);
 return null;
}

/**
 * 재생할 번들 파일을 정한다. 옆 파일의 번들은 추적 폴더 안 bundles/<sha256>.js만 받는다.
 * 재생은 번들을 실행하므로, 조작한 옆 파일이 ../ 경로로 다른 파일을 실행하게 두지 않는다.
 * @param {string} path 추적 파일 경로
 * @param {object|null} meta 옆 파일 내용
 * @param {string|undefined} bundlePath 호출자가 고른 번들(있으면 그대로 쓴다)
 * @returns {{file: string, sha256: string|null}} 번들 경로와 확인할 해시(호출자가 골랐거나 옆 파일이 없으면 null)
 * @throws {Error} 옆 파일의 번들 경로가 bundles/<기록된 sha256>.js가 아님
 */
function bundleSource(path,meta,bundlePath){
 if(bundlePath!==undefined)return {file:bundlePath,sha256:null};
 if(!meta?.bundle)return {file:DEFAULT_BUNDLE_PATH,sha256:null};
 const {path:relative,sha256}=meta.bundle;
 if(typeof sha256!=='string'||!/^[0-9a-f]{64}$/.test(sha256)||relative!==`bundles/${sha256}.js`)throw new Error(`Trace bundle path must be bundles/<sha256>.js: ${relative}`);
 return {file:resolve(dirname(path),relative),sha256};
}

/**
 * 추적을 재생한다. 추적 폴더는 믿을 수 있는 것만 재생한다(번들을 이 프로세스의 vm 컨텍스트에서 실행한다).
 * @param {string} path 추적 파일(JSONL, BCJSON 줄)
 * @param {{bundlePath?: string}} [options] bundlePath를 주면 그 번들로 재생한다(옆 파일의 번들 해시는 보지 않는다).
 *   없으면 옆 파일 <이름>.meta.json의 번들(해시 확인)을, 옆 파일도 없으면 커밋된 번들을 쓴다.
 * @returns {{calls: number, mismatches: {line: number, expected: string, actual: string}[]}} 재생한 호출 수와 불일치(줄 번호는 1부터)
 */
export function replayTrace(path,{bundlePath}={}){
 const meta=readTraceMeta(path);
 const source=bundleSource(path,meta,bundlePath);
 const bundle=readFileSync(source.file,'utf8');
 if(source.sha256!==null&&sha256Hex(Buffer.from(bundle,'utf8'))!==source.sha256)throw new Error(`Trace bundle ${source.file} does not match the recorded sha256 ${source.sha256}`);
 const context=createReplayContext(meta);
 const hostReplay=installHostCallbacks(context,meta);
 runInContext(bundle,context);
 hostReplay.assertHealthy();
 const realm=contextRealm(context);
 const factories=runInContext('[()=>({}),()=>[]]',context);
 const make={object:factories[0],array:factories[1]};
 /** 재생 중 결과로 받은 Float64Array 뷰(기록과 같은 순번) */
 const views=[];
 const mismatches=[];
 let calls=0;
 const lines=readFileSync(path,'utf8').split('\n');
 lines.forEach((line,index)=>{
  if(line==='')return;
  const record=parseLossless(line);
  if(record.write){const mismatch=replayWrite(record.write,views);if(mismatch)mismatches.push({line:index+1,...mismatch});return;}
  const nativeOrdinal=calls++;
  const fn=context[record.fn];
  let result,error,threw=false;
  hostReplay.beginNative(nativeOrdinal);
  try{
   if(typeof fn!=='function')throw new TypeError(`Missing function: ${record.fn}`);
   result=Reflect.apply(fn,undefined,record.args.map(arg=>intoContextRealm(arg,make)));
  }catch(caught){threw=true;error=caught;}
  hostReplay.endNative(nativeOrdinal);
  const expected=recordedText(losslessMemberTexts(line)),actual=outcomeText(threw,error,result,realm,views);
  if(expected!==actual)mismatches.push({line:index+1,expected,actual});
 });
 hostReplay.assertComplete();
 return {calls,mismatches};
}

/**
 * CLI 인자를 읽는다.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{trace: string, bundlePath: string|undefined}} 추적 경로와 번들 경로
 */
function parseArguments(argv){
 const bundleIndex=argv.indexOf('--bundle');
 const bundlePath=bundleIndex>=0?argv[bundleIndex+1]:undefined;
 const positional=argv.filter((_,index)=>index!==bundleIndex&&index!==bundleIndex+1);
 if(positional.length!==1||(bundleIndex>=0&&!bundlePath))throw new TypeError('Usage: node scripts/trace/replay-js.mjs <trace.jsonl> [--bundle <path>]');
 return {trace:positional[0],bundlePath};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {trace,bundlePath}=parseArguments(process.argv.slice(2));
 const {calls,mismatches}=replayTrace(trace,{bundlePath});
 for(const mismatch of mismatches.slice(0,20))process.stderr.write(`line ${mismatch.line}\n  expected ${mismatch.expected.slice(0,400)}\n  actual   ${mismatch.actual.slice(0,400)}\n`);
 process.stdout.write(JSON.stringify({trace,calls,mismatches:mismatches.length})+'\n');
 process.exitCode=mismatches.length?1:0;
}
