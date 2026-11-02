// 호출 추적 기록기(설계 §6.5-1, §7.3, M0 Task 5).
// node:vm 컨텍스트에 올린 생성 번들의 자기 native* 전역 함수를 감싸, 최상위 호출마다 BCJSON 줄 하나를 쓴다.
//   호출: {"fn":…,"args":[…],"ok":…} 또는 {"fn":…,"args":[…],"err":{"name":…,"message":…,"code":…}}
//   호스트 쓰기: {"write":{"view":k,"sha256":…,"data":"<base64 리틀엔디언 바이트>"}}
// 브리지가 안에서 다른 native* 전역을 부르는 호출(깊이 1 이상)은 기록하지 않는다. 깊이 카운터로 가린다.
// 테스트·디버그 전용이다. 호출된 값은 건드리지 않는다: 검사는 내부 슬롯과 속성 서술자로만 하고
// 게터, Proxy 트랩, toJSON을 부르지 않는다(기록 때문에 테스트 결과가 바뀌면 안 된다).
// 추적은 백엔드 중립(설계 §7.3)이라 iOS·Android가 넘길 수 있는 평범한 데이터만 담는다. 그 밖의 인자
// (다른 realm 객체, 접근자, Proxy, 함수, 공유 참조 등)나 결과를 만나면 그 자리에서 기록을 멈춘다.
// native* 호출 밖에서 코어 상태를 바꾸는 길(테스트가 nativeAPI·nativeModel·Aster를 직접 쓰는 경우)도 추적이 재현할 수 없다.
// 그래서 코어가 만든 전역(번들이 만든 Aster, 호출 중에 생긴 nativeModel 등)을 호출 사이에만 접근자로 지키고,
// 호출 밖에서 읽거나 쓰거나 지우면 기록을 멈춘다. 호출 동안에는 원래 데이터 속성으로 되돌리므로 코어가 보는 서술자는
// 기록하지 않을 때와 같다(작업공간 대상의 빈 런타임 검사가 서술자 모양을 본다). 멈추면 모든 전역을 데이터 속성으로 되돌린다.
// 그래서 추적은 언제나 실제 세션의 충실한 앞부분이고, 멈춘 자리와 이유는 옆 파일 <이름>.meta.json의 stopped에 남는다.
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {types} from 'node:util';
import vm from 'node:vm';
import {float64LittleEndianBytes,sha256Hex,stringifyLossless,typedArrayKind} from './bcjson.mjs';

/** 모듈을 읽을 때 잡아 둔 원래 vm.runInContext. preload가 vm을 감싼 뒤에도 기록기 내부 평가는 그 감시를 거치지 않는다. */
const runInContext=vm.runInContext;
/** 정규 배열 인덱스 문자열(0..2^32-2) */
const ARRAY_INDEX=/^(?:0|[1-9]\d*)$/;
/** 프로토타입 사슬에서 접근자나 Proxy를 만나 값을 부작용 없이 읽을 수 없다는 표시 */
const UNREADABLE=Symbol('unreadable');
/** JS 내장 전역 이름(새 컨텍스트 전역의 자기 이름). 코어는 이 이름들을 전역으로 참조하므로 테스트가 바꾸면 결과가 달라질 수 있다. */
const BUILTIN_GLOBALS=new Set(runInContext('Object.getOwnPropertyNames(globalThis)',vm.createContext({})));

/**
 * 코어가 이름으로 볼 수 있는 전역인지 판단한다. 코어는 브리지 이름(native*, Aster)과 JS 내장 전역만 이름으로 참조한다.
 * 그 밖의 전역(테스트 도우미 hits, heldTarget 등)은 코어 결과에 닿지 않으므로 호출 사이에 바뀌어도 기록을 멈추지 않는다.
 * @param {string} name 전역 이름
 * @returns {boolean} 코어가 볼 수 있으면 true
 */
function coreObservable(name){return name.startsWith('native')||name==='Aster'||BUILTIN_GLOBALS.has(name);}

/**
 * 두 속성 서술자가 같은지 본다(값은 Object.is, 접근자는 함수 신원).
 * @param {PropertyDescriptor} left 왼쪽
 * @param {PropertyDescriptor} right 오른쪽
 * @returns {boolean} 같으면 true
 */
function sameDescriptor(left,right){
 return Object.is(left.value,right.value)&&left.get===right.get&&left.set===right.set&&left.writable===right.writable&&left.enumerable===right.enumerable&&left.configurable===right.configurable;
}

/**
 * 메타 옆 파일 경로를 만든다. trace.jsonl → trace.meta.json
 * @param {string} path 추적 파일 경로
 * @returns {string} 옆 파일 경로
 */
export function traceMetaPath(path){return (path.endsWith('.jsonl')?path.slice(0,-6):path)+'.meta.json';}

/**
 * 컨텍스트 realm의 평범한 객체·배열 프로토타입을 얻는다. 리터럴로 만들므로 전역 Object·Array를 바꿔도 내장값이다.
 * @param {vm.Context} context 대상 컨텍스트
 * @returns {{objectPrototype: object, arrayPrototype: object}} 그 realm의 %Object.prototype%, %Array.prototype%
 */
export function contextRealm(context){
 const pair=runInContext('[{},[]]',context);
 return {objectPrototype:Object.getPrototypeOf(pair[0]),arrayPrototype:Object.getPrototypeOf(pair[1])};
}

/**
 * 호출 인자가 추적으로 재현 가능한지 부작용 없이 검사한다.
 * iOS·Android가 코어에 넘길 수 있는 값만 받는다: 원시 값과, 컨텍스트 realm의 평범한 객체·배열로 된 나무.
 * 인자는 코어가 신원(===)이나 동결 여부를 볼 수 있으므로 공유 참조와 확장 불가 객체도 거절한다.
 * Float64Array 인자도 거절한다(추적에는 해시만 남아 재생할 바이트가 없다).
 * @param {readonly unknown[]} args 인자 목록
 * @param {{objectPrototype: object, arrayPrototype: object}} realm contextRealm 결과
 * @returns {string|null} 재현할 수 없으면 이유, 가능하면 null
 */
export function traceArgumentsIssue(args,realm){return valueIssue(args,realm,true);}

/**
 * 호출 결과가 추적으로 재현 가능한지 부작용 없이 검사한다.
 * 결과에서는 Float64Array(F64 토큰), 공유 참조(그대로 두 번 쓴다), 동결 객체를 받는다. 순환은 거절한다.
 * @param {unknown} result 결과
 * @param {{objectPrototype: object, arrayPrototype: object}} realm contextRealm 결과
 * @returns {string|null} 재현할 수 없으면 이유, 가능하면 null
 */
export function traceResultIssue(result,realm){return valueIssue([result],realm,false);}

/**
 * 값 나무를 재귀 없이 훑으며 추적에 담을 수 없는 첫 이유를 찾는다.
 * 읽는 것은 typeof, Proxy 판별, 내부 슬롯 게터, 프로토타입, 확장 가능 여부, 자기 키, 속성 서술자뿐이다.
 * Proxy인지 먼저 보므로 그 밖의 연산이 트랩을 부르지 않는다.
 * @param {readonly unknown[]} roots 검사할 뿌리 값들
 * @param {{objectPrototype: object, arrayPrototype: object}} realm 평범한 객체·배열의 프로토타입
 * @param {boolean} argument 인자 규칙(공유 참조, 확장 불가, Float64Array 거절)이면 true
 * @returns {string|null} 첫 이유 또는 null
 */
function valueIssue(roots,realm,argument){
 /** 인자에서 이미 본 객체. 두 번 나오면 공유 참조다. */
 const seen=new Set();
 /** 결과에서 지금 열린 조상. 다시 나오면 순환이다. */
 const ancestors=new Set();
 /** [값, 빠져나오는 표시] 스택 */
 const pending=[];
 for(let i=roots.length-1;i>=0;i--)pending.push([roots[i],false]);
 while(pending.length){
  const [value,exit]=pending.pop();
  if(exit){ancestors.delete(value);continue;}
  const type=typeof value;
  if(type==='undefined'||type==='boolean'||type==='number'||type==='string'||value===null)continue;
  if(type!=='object')return type;
  if(types.isProxy(value))return 'proxy';
  const kind=typedArrayKind(value);
  if(kind!==undefined){if(kind==='Float64Array'&&!argument)continue;return 'typed array';}
  if(argument){if(seen.has(value))return 'shared reference';seen.add(value);}
  else if(ancestors.has(value))return 'cycle';
  const isArray=Array.isArray(value);
  if(Object.getPrototypeOf(value)!==(isArray?realm.arrayPrototype:realm.objectPrototype))return 'prototype';
  if(argument&&!Object.isExtensible(value))return 'non-extensible';
  const children=[],length=isArray?value.length:0;
  let indices=0;
  for(const key of Reflect.ownKeys(value)){
   if(typeof key==='symbol')return 'symbol key';
   if(isArray){
    if(key==='length')continue;
    if(!ARRAY_INDEX.test(key)||Number(key)>=length)return 'extra property';
    indices++;
   }
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!Object.hasOwn(descriptor,'value'))return 'accessor';
   if(!descriptor.enumerable)return 'non-enumerable';
   children.push(descriptor.value);
  }
  if(indices!==length)return 'hole';
  if(!argument){ancestors.add(value);pending.push([value,true]);}
  for(let i=children.length-1;i>=0;i--)pending.push([children[i],false]);
 }
 return null;
}

/**
 * 던져진 값을 추적의 err 레코드 {name, message, code}로 만든다. 속성은 프로토타입 사슬의 데이터 속성만 읽는다.
 * @param {unknown} error 던져진 값
 * @returns {{record: {name: string, message: string, code: unknown}}|{issue: string}} 레코드, 또는 재현할 수 없는 이유
 */
export function traceErrorRecord(error){
 if(error===null||typeof error!=='object')return {issue:typeof error==='function'?'function':'primitive'};
 if(types.isProxy(error))return {issue:'proxy'};
 const name=dataProperty(error,'name'),message=dataProperty(error,'message'),code=dataProperty(error,'code');
 if(name===UNREADABLE||message===UNREADABLE||code===UNREADABLE)return {issue:'accessor'};
 if(typeof name!=='string'||typeof message!=='string')return {issue:'name or message'};
 if(code!==undefined&&code!==null&&typeof code!=='string'&&typeof code!=='number'&&typeof code!=='boolean')return {issue:'code'};
 return {record:{name,message,code}};
}

/**
 * 프로토타입 사슬에서 데이터 속성 값을 찾는다. 접근자나 Proxy를 만나면 부르지 않고 UNREADABLE을 돌려준다.
 * @param {object} object 시작 객체
 * @param {string} key 속성 이름
 * @returns {unknown} 값, 없으면 undefined, 읽을 수 없으면 UNREADABLE
 */
function dataProperty(object,key){
 for(let current=object;current!==null;current=Object.getPrototypeOf(current)){
  if(types.isProxy(current))return UNREADABLE;
  const descriptor=Object.getOwnPropertyDescriptor(current,key);
  if(descriptor)return Object.hasOwn(descriptor,'value')?descriptor.value:UNREADABLE;
 }
 return undefined;
}

/**
 * 두 바이트 배열이 같은지 본다(memcmp 속도).
 * @param {Uint8Array} left 왼쪽
 * @param {Uint8Array} right 오른쪽(길이는 같다고 본다)
 * @returns {boolean} 같으면 true
 */
function sameBytes(left,right){
 return Buffer.compare(Buffer.from(left.buffer,left.byteOffset,left.length),Buffer.from(right.buffer,right.byteOffset,right.length))===0;
}

/**
 * 호스트 쓰기 줄을 만든다.
 * @param {number} index 뷰 순번(결과에 나온 순서, 0부터)
 * @param {Uint8Array} bytes 뷰의 현재 리틀엔디언 바이트
 * @returns {string} {"write":{"view":k,"sha256":…,"data":…}} BCJSON 줄
 */
export function traceWriteLine(index,bytes){
 return stringifyLossless({write:{view:index,sha256:sha256Hex(bytes),data:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.length).toString('base64')}});
}

/**
 * 객체의 자기 문자열 키를 돌려준다(게터를 부르지 않는다).
 * @param {object} object 대상
 * @returns {string[]} 자기 문자열 키
 */
function ownStringKeys(object){return Reflect.ownKeys(object).filter(key=>typeof key==='string');}

/**
 * 기록기 상태. 컨텍스트 하나에 하나다.
 */
class TraceRecorder{
 /**
  * @param {vm.Context} context 번들을 올린 컨텍스트
  * @param {string} path 추적 파일 경로
  * @param {object|null} meta 옆 파일에 남길 정보(preload가 번들·전역을 넘긴다). null이면 멈출 때만 옆 파일을 쓴다.
  * @param {readonly string[]} preexisting 번들 전부터 있던 전역 이름(테스트가 넣은 값이라 지키지 않는다)
  */
 constructor(context,path,meta,preexisting){
  /** 기록 중인 컨텍스트(샌드박스 객체) */
  this.context=context;
  /** 지키는 코어 전역: 이름 → {value, enumerable, getter, setter}. 호출 사이에는 접근자이고 값은 여기에 있다. */
  this.guarded=new Map();
  /** 지키지 않는 이름: 감싼 native* 함수와 번들 전부터 있던 전역 */
  this.unguarded=new Set(preexisting);
  /** 감싼 native* 함수: 이름 → 감싼 함수. 호출 사이에 테스트가 바꿔 끼우면 기록을 멈춘다. */
  this.wrappers=new Map();
  /** 지키지도 감싸지도 않는, 코어가 볼 수 있는 전역의 서술자(마지막 호출이 끝났을 때). 호출 사이에 바뀌면 기록을 멈춘다. */
  this.environment=new Map();
  /** 추적 파일 경로 */
  this.path=path;
  /** 옆 파일 경로 */
  this.metaPath=traceMetaPath(path);
  /** 옆 파일 기본 내용 */
  this.meta=meta;
  /** 지금 실행 중인 native* 호출 깊이. 0일 때 들어온 호출만 기록한다. */
  this.depth=0;
  /** 쓴 줄 수(호출 줄과 쓰기 줄) */
  this.lines=0;
  /** 기록을 멈췄으면 {line, fn, reason}, 아니면 null */
  this.stopped=null;
  /**
   * 결과로 돌려준 Float64Array 뷰: {view, index, snapshot}. 추적이 끝날 때까지 강하게 잡는다.
   * 약한 참조로 두면 호스트가 같은 메모리의 별칭 뷰로 쓴 내용을 GC 시점에 따라 놓쳐 추적이 실행마다 달라질 수 있다.
   */
  this.views=[];
  /** 다음 뷰 순번 */
  this.nextView=0;
  /** 인자 realm 검사 기준 */
  this.realm=contextRealm(context);
  if(meta)this.writeMeta();
 }

 /**
  * 컨텍스트 전역의 자기 native* 함수를 모두 감싸고, 번들이 만든 나머지 전역(Aster 등)을 지킨다.
  * 서술자로 읽어 게터를 부르지 않는다.
  * @returns {void}
  */
 install(){
  const context=this.context;
  for(const key of Object.keys(context)){
   if(!key.startsWith('native'))continue;
   const descriptor=Object.getOwnPropertyDescriptor(context,key);
   if(!descriptor||typeof descriptor.value!=='function'||!(descriptor.writable||descriptor.configurable))continue;
   const wrapper=this.wrap(key,descriptor.value);
   Object.defineProperty(context,key,{...descriptor,value:wrapper});
   this.wrappers.set(key,wrapper);this.unguarded.add(key);
  }
  for(const key of ownStringKeys(context))if(!this.unguarded.has(key))this.guard(key);
  this.environment=this.environmentSnapshot();
 }

 /**
  * 지키지도 감싸지도 않는, 코어가 볼 수 있는 전역의 서술자를 모은다.
  * @returns {Map<string, PropertyDescriptor>} 이름 → 서술자
  */
 environmentSnapshot(){
  const snapshot=new Map();
  for(const name of ownStringKeys(this.context)){
   if(this.guarded.has(name)||this.wrappers.has(name)||!coreObservable(name))continue;
   snapshot.set(name,Object.getOwnPropertyDescriptor(this.context,name));
  }
  return snapshot;
 }

 /**
  * 마지막 호출 뒤로 코어가 볼 수 있는 전역이 새로 생기거나 바뀌거나 사라졌는지 찾는다.
  * @returns {string|null} 처음 찾은 이름, 없으면 null
  */
 environmentChange(){
  const now=this.environmentSnapshot();
  for(const [name,descriptor] of now){const before=this.environment.get(name);if(!before||!sameDescriptor(before,descriptor))return name;}
  for(const name of this.environment.keys())if(!now.has(name))return name;
  return null;
 }

 /**
  * 코어 전역 하나를 접근자로 바꿔 지킨다. 쓰기 가능하고 설정 가능한 데이터 속성만 지킨다(아니면 목록에서 뺀다).
  * 이미 지키던 이름이면 같은 게터·세터를 다시 쓴다.
  * @param {string} name 전역 이름
  * @returns {void}
  */
 guard(name){
  const descriptor=Object.getOwnPropertyDescriptor(this.context,name);
  if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.writable||!descriptor.configurable){this.guarded.delete(name);return;}
  let state=this.guarded.get(name);
  if(!state){state=this.guardState(name);this.guarded.set(name,state);}
  state.value=descriptor.value;state.enumerable=descriptor.enumerable;
  Object.defineProperty(this.context,name,{get:state.getter,set:state.setter,enumerable:state.enumerable,configurable:true});
 }

 /**
  * 지킬 전역 하나의 상태와 접근자를 만든다. 호출 밖에서 읽거나 쓰면 기록을 멈추고(모든 전역을 데이터 속성으로
  * 되돌리고) 원래 연산을 그대로 마친다. 값은 상태에 잡혀 있어 멈춘 뒤에도 같은 값을 돌려준다.
  * @param {string} name 전역 이름
  * @returns {{value: unknown, enumerable: boolean, getter: Function, setter: Function}} 지킨 상태
  */
 guardState(name){
  const recorder=this,state={value:undefined,enumerable:true,getter:null,setter:null};
  state.getter=function(){recorder.stop(null,`out-of-band read: ${name}`);return state.value;};
  state.setter=function(value){
   recorder.stop(null,`out-of-band write: ${name}`);
   // 멈추면 데이터 속성으로 돌아가므로 보통 쓰기를 그대로 한다. 바깥에서 샌드박스를 얼려 되돌리지 못한 접근자만 값을 상태에 둔다.
   if(Object.getOwnPropertyDescriptor(recorder.context,name)?.get===state.getter)state.value=value;
   else recorder.context[name]=value;
  };
  return state;
 }

 /**
  * 지키던 전역을 원래 데이터 속성으로 되돌린다. 호출을 시작할 때와 기록을 멈출 때 쓴다.
  * 테스트가 지우거나 다른 서술자로 바꾼 이름, 바깥에서 얼려 설정 불가가 된 접근자는 건드리지 않는다(던지지 않는다).
  * @param {string} name 전역 이름
  * @param {{value: unknown, enumerable: boolean, getter: Function}} state 지킨 상태
  * @returns {boolean} 되돌렸으면 true, 두었으면 false
  */
 unguard(name,state){
  const descriptor=Object.getOwnPropertyDescriptor(this.context,name);
  if(!descriptor||descriptor.get!==state.getter||!descriptor.configurable)return false;
  Object.defineProperty(this.context,name,{value:state.value,writable:true,enumerable:state.enumerable,configurable:true});
  return true;
 }

 /**
  * 최상위 호출을 시작하기 전에 지키던 전역을 데이터 속성으로 되돌린다. 호출 사이에 테스트가 코어 전역을 지우거나
  * 바꿨거나, 감싼 native* 함수를 바꿔 끼웠거나, 코어가 볼 수 있는 전역을 새로 만들거나 바꿨으면
  * 그 변화는 추적이 재현할 수 없으므로 기록을 멈춘다.
  * @returns {void}
  */
 openGuards(){
  for(const [name,state] of this.guarded){
   if(this.unguard(name,state))continue;
   this.stop(null,`out-of-band ${Object.getOwnPropertyDescriptor(this.context,name)?'redefine':'delete'}: ${name}`);
   return;
  }
  for(const [name,wrapper] of this.wrappers){
   if(Object.getOwnPropertyDescriptor(this.context,name)?.value===wrapper)continue;
   this.stop(null,`out-of-band replace: ${name}`);
   return;
  }
  const changed=this.environmentChange();
  if(changed!==null)this.stop(null,`out-of-band global: ${changed}`);
 }

 /**
  * 최상위 호출이 끝난 뒤 지키던 전역과 호출 중에 새로 생긴 전역을 다시 지킨다.
  * 호출 사이에 테스트가 만든 전역(호출 전에도 있었고 지키지 않던 이름)은 테스트 상태라 지키지 않는다.
  * @param {Set<string>} before 호출 직전의 자기 문자열 키
  * @returns {void}
  */
 closeGuards(before){
  const keys=ownStringKeys(this.context),present=new Set(keys);
  for(const name of [...this.guarded.keys()])if(!present.has(name))this.guarded.delete(name);
  for(const name of keys){
   if(this.unguarded.has(name)||(before.has(name)&&!this.guarded.has(name)))continue;
   this.guard(name);
  }
  this.environment=this.environmentSnapshot();
 }

 /**
  * native* 함수 하나의 감싼 함수를 만든다. 이름과 길이는 원래 함수와 같다.
  * @param {string} name 전역 이름
  * @param {Function} original 원래 함수
  * @returns {Function} 감싼 함수
  */
 wrap(name,original){
  const recorder=this;
  const wrapper=function(...args){return recorder.call(name,original,this,args);};
  Object.defineProperty(wrapper,'name',{value:original.name});
  Object.defineProperty(wrapper,'length',{value:original.length});
  return wrapper;
 }

 /**
  * 감싼 함수의 본체. 최상위 호출만 기록하고, 안쪽 호출과 멈춘 뒤의 호출은 그대로 넘긴다.
  * @param {string} name 전역 이름
  * @param {Function} original 원래 함수
  * @param {unknown} thisArg 호출자가 넘긴 this
  * @param {unknown[]} args 인자
  * @returns {unknown} 원래 함수의 결과(던지면 같은 오류를 다시 던진다)
  */
 call(name,original,thisArg,args){
  if(this.stopped||this.depth>0)return this.passThrough(original,thisArg,args);
  this.openGuards();
  if(this.stopped)return this.passThrough(original,thisArg,args);
  const before=new Set(ownStringKeys(this.context));
  try{return this.recordCall(name,original,thisArg,args);}
  finally{if(!this.stopped)this.closeGuards(before);}
 }

 /**
  * 최상위 호출 하나를 기록하며 부른다. 지키던 전역은 이미 데이터 속성으로 돌아와 있다.
  * @param {string} name 전역 이름
  * @param {Function} original 원래 함수
  * @param {unknown} thisArg 호출자가 넘긴 this
  * @param {unknown[]} args 인자
  * @returns {unknown} 원래 함수의 결과(던지면 같은 오류를 다시 던진다)
  */
 recordCall(name,original,thisArg,args){
  this.flushHostWrites();
  const argumentIssue=traceArgumentsIssue(args,this.realm);
  if(argumentIssue){this.stop(name,`argument: ${argumentIssue}`);return this.passThrough(original,thisArg,args);}
  // 코어가 인자를 바꿀 수 있으므로 부르기 전에 쓴다.
  const argsText=stringifyLossless(args);
  let result,error,threw=false;
  this.depth++;
  try{result=Reflect.apply(original,thisArg,args);}
  catch(caught){threw=true;error=caught;}
  finally{this.depth--;}
  try{this.recordOutcome(name,argsText,threw,error,result);}
  finally{this.refreshSnapshots();}
  if(threw)throw error;
  return result;
 }

 /**
  * 기록하지 않고 원래 함수를 부른다. 깊이는 세어 안쪽 호출이 기록되지 않게 한다.
  * @param {Function} original 원래 함수
  * @param {unknown} thisArg this
  * @param {unknown[]} args 인자
  * @returns {unknown} 결과
  */
 passThrough(original,thisArg,args){
  this.depth++;
  try{return Reflect.apply(original,thisArg,args);}
  finally{this.depth--;}
 }

 /**
  * 최상위 호출 하나의 줄을 쓴다. 결과의 Float64Array는 출력 순서대로 뷰 순번을 받는다.
  * @param {string} name 전역 이름
  * @param {string} argsText 부르기 전에 쓴 인자 BCJSON
  * @param {boolean} threw 던졌는지
  * @param {unknown} error 던진 값
  * @param {unknown} result 결과
  * @returns {void}
  */
 recordOutcome(name,argsText,threw,error,result){
  const head=`{"fn":${JSON.stringify(name)},"args":${argsText},`;
  if(threw){
   const outcome=traceErrorRecord(error);
   if(outcome.issue){this.stop(name,`error: ${outcome.issue}`);return;}
   this.writeLine(`${head}"err":${stringifyLossless(outcome.record)}}`);
   return;
  }
  const issue=traceResultIssue(result,this.realm);
  if(issue){this.stop(name,`result: ${issue}`);return;}
  const views=[];
  const okText=stringifyLossless(result,{onFloat64:view=>views.push(view)});
  this.writeLine(`${head}"ok":${okText}}`);
  for(const view of views)this.views.push({view,index:this.nextView++,snapshot:float64LittleEndianBytes(view).slice()});
 }

 /**
  * 다음 호출을 기록하기 직전에, 마지막 호출 뒤로 내용이 바뀐 뷰마다 write 줄을 쓴다.
  * 호출 중에 코어가 바꾼 내용은 refreshSnapshots가 이미 흡수했으므로, 여기서 보이는 변화는 호스트가 쓴 것이다.
  * @returns {void}
  */
 flushHostWrites(){
  for(const entry of this.views){
   const bytes=float64LittleEndianBytes(entry.view);
   // 분리된 버퍼에는 호스트가 쓸 수 없다. 길이가 달라졌으면 기준만 새로 잡는다.
   if(bytes.length!==entry.snapshot.length){entry.snapshot=bytes.slice();continue;}
   if(sameBytes(bytes,entry.snapshot))continue;
   this.writeLine(traceWriteLine(entry.index,bytes));
   entry.snapshot=bytes.slice();
  }
 }

 /**
  * 호출이 끝난 뒤 뷰의 기준 바이트를 새로 잡는다. 코어가 호출 중에 바꾼 내용을 호스트 쓰기로 오인하지 않게 한다.
  * @returns {void}
  */
 refreshSnapshots(){
  for(const entry of this.views){
   const bytes=float64LittleEndianBytes(entry.view);
   if(bytes.length!==entry.snapshot.length||!sameBytes(bytes,entry.snapshot))entry.snapshot=bytes.slice();
  }
 }

 /**
  * 기록을 멈춘다. 이후 호출은 그대로 넘기고, 멈춘 자리를 옆 파일에 남긴다.
  * @param {string|null} fn 멈춘 호출의 함수 이름(호출과 무관하게 멈추면 null)
  * @param {string} reason 이유
  * @returns {void}
  */
 stop(fn,reason){
  if(this.stopped)return;
  this.stopped={line:this.lines+1,fn,reason};
  this.views=[];
  for(const [name,state] of this.guarded)this.unguard(name,state);
  this.guarded.clear();
  this.writeMeta();
 }

 /**
  * 옆 파일을 쓴다.
  * @returns {void}
  */
 writeMeta(){writeFileSync(this.metaPath,JSON.stringify({...this.meta,stopped:this.stopped})+'\n');}

 /**
  * 추적 줄 하나를 덧붙인다. 테스트가 중간에 죽어도 그때까지의 줄이 남도록 바로 쓴다.
  * @param {string} text BCJSON 줄
  * @returns {void}
  */
 writeLine(text){appendFileSync(this.path,text+'\n');this.lines++;}
}

/**
 * vm 컨텍스트 전역의 자기 native* 함수를 모두 감싸 최상위 호출을 BCJSON 추적으로 기록한다.
 * 번들을 평가한 직후, 다른 코드가 함수를 잡기 전에 부른다. 추적 파일은 새로 만든다(있으면 비운다).
 * @param {vm.Context} context 생성 번들을 올린 컨텍스트
 * @param {{path: string, meta?: object|null, preexisting?: readonly string[]}} options path는 추적 파일,
 *   meta는 옆 파일 <이름>.meta.json에 남길 정보, preexisting은 번들 전부터 있던 전역 이름(지키지 않는다)
 * @returns {{path: string, stop: (reason: string) => void}} 추적 경로와, 호출과 무관하게 기록을 멈추는 함수
 */
export function installTraceRecorder(context,{path,meta=null,preexisting=[]}={}){
 if(typeof path!=='string'||path==='')throw new TypeError('installTraceRecorder requires a trace file path');
 mkdirSync(dirname(path),{recursive:true});
 writeFileSync(path,'');
 const recorder=new TraceRecorder(context,path,meta,preexisting);
 recorder.install();
 return {path,stop:reason=>recorder.stop(null,reason)};
}
