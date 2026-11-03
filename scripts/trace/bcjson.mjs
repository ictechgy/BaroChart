// BCJSON: 호출 추적에 쓰는 무손실 JSON 상위 집합(설계 §4.2 무손실 모드, §7.3).
// JSON(RFC 8259)에 값 토큰 다섯 개를 더한다: NaN, Infinity, -Infinity, undefined, F64(<길이>,<sha256 16진 소문자>).
// -0은 숫자 리터럴 -0으로 쓴다. iOS JSValue가 구분하는 값(NaN, -0, undefined)과 Float64Array 전송 해시를
// 잃지 않아야 같은 추적을 JS 번들과 Rust 백엔드에 재생해 결과를 바이트 단위로 비교할 수 있다.
// 깊은 중첩에서도 스택이 넘치지 않도록 writer와 parser 모두 재귀 없이 명시 스택으로 돈다.
import {createHash} from 'node:crypto';
import {endianness} from 'node:os';

/** 함수, 심볼, BigInt, 순환 참조처럼 BCJSON으로 쓸 수 없는 값에 내는 오류 문구(계획 Task 5 그대로) */
const UNSUPPORTED='BCJSON unsupported value';
/** %TypedArray%.prototype. 타입 배열 내부 슬롯을 읽는 내장 게터를 여기서 꺼낸다. */
const TYPED_ARRAY_PROTOTYPE=Object.getPrototypeOf(Uint8Array.prototype);
/**
 * 내장 게터를 꺼낸다. 재정의된 속성이나 하위 클래스 게터를 거치지 않고 내부 슬롯을 읽으려고 쓴다.
 * @param {string|symbol} key %TypedArray%.prototype의 접근자 이름
 * @returns {Function} 그 접근자의 get 함수
 */
function typedArrayGetter(key){return Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,key).get;}
/** [[TypedArrayName]]을 돌려주는 게터. 다른 realm의 타입 배열도 판별하고, 그 밖의 값에는 부작용 없이 undefined를 돌려준다. */
const typedArrayName=typedArrayGetter(Symbol.toStringTag);
/** 타입 배열의 [[ViewedArrayBuffer]] 게터 */
const typedArrayBuffer=typedArrayGetter('buffer');
/** 타입 배열의 바이트 오프셋 게터 */
const typedArrayByteOffset=typedArrayGetter('byteOffset');
/** 타입 배열의 바이트 길이 게터. 분리된 버퍼에서는 0이다. */
const typedArrayByteLength=typedArrayGetter('byteLength');
/** 타입 배열의 원소 수 게터 */
const typedArrayLength=typedArrayGetter('length');
/** 추적 해시와 write 줄은 리틀엔디언 바이트로 정의한다. 빅엔디언 프로세스에서만 원소마다 바이트를 뒤집는다. */
const BIG_ENDIAN=endianness()==='BE';
/** JSON 숫자 문법(RFC 8259) */
const NUMBER=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** 따옴표, 역슬래시, 제어 문자가 아닌 문자열 조각. 이스케이프 없는 구간을 한 번에 읽는다. */
const STRING_RUN=/[^"\\\u0000-\u001f]*/y;
/** F64 토큰. 길이는 앞자리 0 없는 십진수, 해시는 16진 소문자 64자다. */
const F64_TOKEN=/F64\((0|[1-9]\d{0,15}),([0-9a-f]{64})\)/y;
/** \uXXXX 이스케이프의 16진 네 자리 */
const HEX4=/^[0-9a-fA-F]{4}$/;
/** 한 글자 이스케이프의 뜻 */
const SIMPLE_ESCAPES=new Map([['"','"'],['\\','\\'],['/','/'],['b','\b'],['f','\f'],['n','\n'],['r','\r'],['t','\t']]);
/** 값 앞에 올 수 있는 낱말 토큰과 그 값. 긴 것부터 검사할 필요는 없다(첫 글자가 모두 다르다). */
const WORD_TOKENS=[['true',true],['false',false],['null',null],['NaN',NaN],['Infinity',Infinity],['undefined',undefined]];

/**
 * 타입 배열 종류를 부작용 없이 돌려준다. 다른 realm의 배열도 내부 슬롯으로 알아본다.
 * Proxy는 내부 슬롯이 없으므로 트랩을 부르지 않고 undefined다.
 * @param {unknown} value 검사할 값
 * @returns {string|undefined} 'Float64Array' 같은 타입 배열 이름. 타입 배열이 아니면 undefined
 */
export function typedArrayKind(value){
 return typeof value==='object'&&value!==null?typedArrayName.call(value):undefined;
}

/**
 * 값이 Float64Array인지 부작용 없이 판별한다.
 * @param {unknown} value 검사할 값
 * @returns {boolean} 진짜 Float64Array이면 true
 */
export function isFloat64Array(value){return typedArrayKind(value)==='Float64Array';}

/**
 * Float64Array 뷰의 리틀엔디언 바이트를 돌려준다.
 * 리틀엔디언 프로세스에서는 복사하지 않고 같은 메모리를 가리킨다. NaN 페이로드와 -0 비트를 그대로 둔다.
 * @param {Float64Array} view 대상 뷰(다른 realm도 됨)
 * @returns {Uint8Array} 바이트 길이가 view.byteLength인 바이트 뷰(분리된 버퍼면 빈 배열)
 */
export function float64LittleEndianBytes(view){
 const byteLength=typedArrayByteLength.call(view);
 // 분리된 버퍼 위에는 새 뷰를 만들 수 없다. 길이 0이면 빈 배열로 대신한다.
 if(byteLength===0)return new Uint8Array(0);
 const bytes=new Uint8Array(typedArrayBuffer.call(view),typedArrayByteOffset.call(view),byteLength);
 return BIG_ENDIAN?swapEvery8(bytes):bytes;
}

/**
 * 리틀엔디언 바이트를 Float64Array 뷰에 그대로 쓴다. 추적의 write 줄을 재생할 때 쓴다.
 * @param {Float64Array} view 쓸 대상 뷰
 * @param {Uint8Array} bytes 리틀엔디언 바이트. 길이는 view.byteLength와 같아야 한다.
 * @returns {void}
 */
export function writeFloat64LittleEndianBytes(view,bytes){
 const target=float64LittleEndianBytes(view);
 if(target.length!==bytes.length)throw new RangeError(`Float64Array byte length ${target.length} does not match ${bytes.length} trace bytes`);
 if(!BIG_ENDIAN){target.set(bytes);return;}
 // 빅엔디언에서는 float64LittleEndianBytes가 사본을 주므로 원래 메모리에 뒤집어 쓴다.
 new Uint8Array(typedArrayBuffer.call(view),typedArrayByteOffset.call(view),target.length).set(swapEvery8(bytes));
}

/**
 * 8바이트 단위로 바이트 순서를 뒤집은 사본을 만든다. 빅엔디언 프로세스에서만 쓴다.
 * @param {Uint8Array} bytes 원본 바이트
 * @returns {Uint8Array} 뒤집은 새 배열
 */
function swapEvery8(bytes){
 const out=new Uint8Array(bytes.length);
 for(let offset=0;offset<bytes.length;offset+=8)for(let i=0;i<8;i++)out[offset+i]=bytes[offset+7-i];
 return out;
}

/**
 * 바이트의 sha256을 16진 소문자로 돌려준다.
 * @param {Uint8Array} bytes 해시할 바이트
 * @returns {string} 64자 16진 문자열
 */
export function sha256Hex(bytes){return createHash('sha256').update(bytes).digest('hex');}

/**
 * 값을 BCJSON 텍스트로 쓴다.
 * - 객체 키는 JS 자기 키 순서(배열 인덱스 오름차순, 나머지는 삽입 순서)이고, 자기 열거 가능 문자열 키만 쓴다.
 * - 문자열 이스케이프는 JSON.stringify와 같다(단독 서로게이트는 \udxxx 소문자).
 * - 유한한 숫자는 String(n), -0은 -0, 비유한 수와 undefined는 토큰이다. undefined는 배열과 객체 모두에서 남는다.
 * - Float64Array는 F64(<길이>,<리틀엔디언 바이트 sha256>)이다.
 * 주의: 속성을 그대로 읽으므로 게터나 Proxy 트랩이 불릴 수 있다. 호출을 건드리면 안 되는 기록기는
 * 먼저 record.mjs의 traceValueIssue로 평범한 데이터인지 확인한 뒤에만 부른다.
 * @param {unknown} value 쓸 값
 * @param {{onFloat64?: (view: Float64Array) => void}} [options] onFloat64는 Float64Array를 출력 순서대로 받는다(추적 뷰 순번용)
 * @returns {string} BCJSON 텍스트
 * @throws {TypeError} 'BCJSON unsupported value': 함수, 심볼, BigInt, 순환 참조
 */
export function stringifyLossless(value,options={}){
 const onFloat64=options.onFloat64??null;
 /** 출력 조각. 마지막에 한 번 이어 붙인다. */
 const parts=[];
 /** 열린 배열·객체 틀: {container, keys(배열이면 null), index, size} */
 const frames=[];
 /** 지금 열려 있는 조상 컨테이너. 같은 객체를 조상 안에서 다시 만나면 순환이다. */
 const ancestors=new Set();
 writeValue(value,parts,frames,ancestors,onFloat64);
 while(frames.length){
  const frame=frames[frames.length-1];
  if(frame.index===frame.size){parts.push(frame.keys?'}':']');ancestors.delete(frame.container);frames.pop();continue;}
  const index=frame.index++;
  if(index)parts.push(',');
  if(frame.keys){const key=frame.keys[index];parts.push(JSON.stringify(key),':');writeValue(frame.container[key],parts,frames,ancestors,onFloat64);}
  else writeValue(frame.container[index],parts,frames,ancestors,onFloat64);
 }
 return parts.join('');
}

/**
 * 값 하나를 쓴다. 원시 값과 F64 토큰은 바로 쓰고, 배열·객체는 틀을 열어 stringifyLossless의 반복에 맡긴다.
 * @param {unknown} value 쓸 값
 * @param {string[]} parts 출력 조각
 * @param {object[]} frames 열린 틀 스택
 * @param {Set<object>} ancestors 열린 조상 집합
 * @param {((view: Float64Array) => void)|null} onFloat64 Float64Array 알림 함수
 * @returns {void}
 */
function writeValue(value,parts,frames,ancestors,onFloat64){
 switch(typeof value){
  case 'undefined':parts.push('undefined');return;
  case 'boolean':parts.push(value?'true':'false');return;
  case 'number':parts.push(numberText(value));return;
  case 'string':parts.push(JSON.stringify(value));return;
  case 'object':break;
  default:throw new TypeError(UNSUPPORTED);
 }
 if(value===null){parts.push('null');return;}
 if(isFloat64Array(value)){
  parts.push(`F64(${typedArrayLength.call(value)},${sha256Hex(float64LittleEndianBytes(value))})`);
  onFloat64?.(value);
  return;
 }
 if(ancestors.has(value))throw new TypeError(UNSUPPORTED);
 ancestors.add(value);
 if(Array.isArray(value)){parts.push('[');frames.push({container:value,keys:null,index:0,size:value.length});return;}
 const keys=Object.keys(value);
 parts.push('{');
 frames.push({container:value,keys,index:0,size:keys.length});
}

/**
 * 숫자를 BCJSON 글자로 바꾼다. 유한한 수는 JS Number#toString과 같고, -0과 비유한 수만 따로 쓴다.
 * @param {number} value 숫자
 * @returns {string} 숫자 토큰
 */
function numberText(value){
 if(Number.isNaN(value))return 'NaN';
 if(value===Infinity)return 'Infinity';
 if(value===-Infinity)return '-Infinity';
 return Object.is(value,-0)?'-0':String(value);
}

/**
 * BCJSON 텍스트를 읽는다. stringifyLossless의 역이다.
 * - 표준 JSON은 JSON.parse와 같은 값이 된다(중복 키는 마지막 값이 처음 자리에 남고, __proto__는 평범한 자기 키다).
 * - F64 토큰은 {f64: true, length, sha256} 객체로 돌려준다(바이트는 추적에 없으므로 되살리지 않는다).
 * @param {string} text BCJSON 텍스트(문자열이 아니면 JSON.parse처럼 문자열로 바꾼다)
 * @returns {any} 읽은 값
 * @throws {SyntaxError} 'BCJSON: <위치> <이유>'. 위치는 0부터 센 UTF-16 오프셋이다.
 */
export function parseLossless(text){return parseText(String(text),null);}

/**
 * 맨 바깥이 객체인 BCJSON 텍스트에서 멤버마다 값 원문을 잘라 돌려준다. 재생기가 기록된 결과 원문을
 * 다시 쓰지 않고 그대로 비교할 때 쓴다(F64 토큰은 파싱하면 바이트가 없어 같은 글자로 되돌릴 수 없다).
 * @param {string} text BCJSON 텍스트
 * @returns {Map<string, string>|null} 키 → 값 원문(중복 키는 마지막 것). 맨 바깥이 객체가 아니면 null
 * @throws {SyntaxError} parseLossless와 같다
 */
export function losslessMemberTexts(text){
 const source=String(text),spans=[];
 const value=parseText(source,spans);
 if(value===null||typeof value!=='object'||Array.isArray(value))return null;
 return new Map(spans.map(([key,start,end])=>[key,source.slice(start,end)]));
}

/**
 * 반복형 파서 본체. 열린 컨테이너를 스택에 두고 값 하나를 읽을 때마다 위로 붙인다.
 * @param {string} text 전체 텍스트
 * @param {Array<[string, number, number]>|null} spans 맨 바깥 객체 멤버의 [키, 시작, 끝]을 모을 배열
 * @returns {any} 읽은 값
 */
function parseText(text,spans){
 const state={text,index:0};
 /** 열린 컨테이너: {container, isArray, key, valueStart} */
 const stack=[];
 for(;;){
  skipWhitespace(state);
  if(spans&&stack.length===1&&!stack[0].isArray)stack[0].valueStart=state.index;
  const code=text.charCodeAt(state.index);
  let value;
  if(code===0x7b){
   state.index++;skipWhitespace(state);
   if(text.charCodeAt(state.index)===0x7d){state.index++;value={};}
   else{stack.push({container:{},isArray:false,key:readKey(state),valueStart:0});continue;}
  }else if(code===0x5b){
   state.index++;skipWhitespace(state);
   if(text.charCodeAt(state.index)===0x5d){state.index++;value=[];}
   else{stack.push({container:[],isArray:true,key:'',valueStart:0});continue;}
  }else value=readScalar(state);
  // 다 읽은 값을 열린 컨테이너에 붙이고, 닫는 괄호가 이어지면 그 컨테이너도 위로 붙인다.
  for(;;){
   if(stack.length===0){
    skipWhitespace(state);
    if(state.index!==text.length)fail(state,'trailing characters');
    return value;
   }
   const top=stack[stack.length-1];
   if(top.isArray)top.container.push(value);
   else{
    defineMember(top.container,top.key,value);
    if(spans&&stack.length===1)spans.push([top.key,top.valueStart,state.index]);
   }
   skipWhitespace(state);
   const next=text.charCodeAt(state.index);
   if(next===0x2c){state.index++;if(!top.isArray){skipWhitespace(state);top.key=readKey(state);}break;}
   if(next===(top.isArray?0x5d:0x7d)){state.index++;value=top.container;stack.pop();continue;}
   fail(state,state.index>=text.length?'unexpected end':`expected , or ${top.isArray?']':'}'}`);
  }
 }
}

/**
 * 객체 멤버를 JSON.parse처럼 붙인다. __proto__도 프로토타입을 바꾸지 않고 자기 데이터 속성이 된다.
 * 이미 있는 키는 값만 바뀌고 자리는 처음 그대로다.
 * @param {object} container 대상 객체
 * @param {string} key 키
 * @param {unknown} value 값
 * @returns {void}
 */
function defineMember(container,key,value){
 if(key==='__proto__')Object.defineProperty(container,key,{value,writable:true,enumerable:true,configurable:true});
 else container[key]=value;
}

/**
 * JSON 공백(스페이스, 탭, LF, CR)만 건너뛴다. U+00A0 같은 다른 공백은 받지 않는다.
 * @param {{text: string, index: number}} state 파서 상태
 * @returns {void}
 */
function skipWhitespace(state){
 const {text}=state;
 let index=state.index;
 for(;;){const code=text.charCodeAt(index);if(code===0x20||code===0x09||code===0x0a||code===0x0d)index++;else break;}
 state.index=index;
}

/**
 * 객체 키와 뒤따르는 콜론을 읽는다.
 * @param {{text: string, index: number}} state 파서 상태
 * @returns {string} 키
 */
function readKey(state){
 if(state.text.charCodeAt(state.index)!==0x22)fail(state,state.index>=state.text.length?'unexpected end':'expected string key');
 const key=readString(state);
 skipWhitespace(state);
 if(state.text.charCodeAt(state.index)!==0x3a)fail(state,state.index>=state.text.length?'unexpected end':'expected :');
 state.index++;
 return key;
}

/**
 * 컨테이너가 아닌 값(문자열, 숫자, 낱말 토큰, F64 토큰)을 읽는다.
 * @param {{text: string, index: number}} state 파서 상태
 * @returns {any} 읽은 값
 */
function readScalar(state){
 const {text,index}=state;
 const code=text.charCodeAt(index);
 if(code===0x22)return readString(state);
 if(code===0x2d&&text.startsWith('-Infinity',index)){state.index+=9;return -Infinity;}
 if(code===0x2d||(code>=0x30&&code<=0x39)){
  NUMBER.lastIndex=index;
  const match=NUMBER.exec(text);
  if(!match)fail(state,'invalid number');
  state.index+=match[0].length;
  return Number(match[0]);
 }
 for(const [word,value] of WORD_TOKENS)if(text.startsWith(word,index)){state.index+=word.length;return value;}
 if(code===0x46){
  F64_TOKEN.lastIndex=index;
  const match=F64_TOKEN.exec(text),length=match?Number(match[1]):NaN;
  if(!Number.isSafeInteger(length))fail(state,'invalid F64 token');
  state.index+=match[0].length;
  return {f64:true,length,sha256:match[2]};
 }
 fail(state,index>=text.length?'unexpected end':'unexpected character');
}

/**
 * 따옴표 문자열을 읽는다. 단독 서로게이트(\ud800이나 원문 그대로)도 JSON.parse처럼 받는다.
 * @param {{text: string, index: number}} state 파서 상태. index는 여는 따옴표를 가리킨다.
 * @returns {string} 읽은 문자열
 */
function readString(state){
 const {text}=state;
 let index=state.index+1,out='';
 for(;;){
  STRING_RUN.lastIndex=index;
  const run=STRING_RUN.exec(text)[0];
  out+=run;index+=run.length;
  if(index>=text.length){state.index=index;fail(state,'unterminated string');}
  const code=text.charCodeAt(index);
  if(code===0x22){state.index=index+1;return out;}
  if(code<0x20){state.index=index;fail(state,'control character in string');}
  // 남은 경우는 역슬래시다.
  const escape=text[index+1];
  if(escape==='u'){
   const hex=text.slice(index+2,index+6);
   if(!HEX4.test(hex)){state.index=index;fail(state,'invalid escape');}
   out+=String.fromCharCode(Number.parseInt(hex,16));index+=6;continue;
  }
  const simple=SIMPLE_ESCAPES.get(escape);
  if(simple===undefined){state.index=index;fail(state,'invalid escape');}
  out+=simple;index+=2;
 }
}

/**
 * 위치를 담은 BCJSON SyntaxError를 던진다.
 * @param {{index: number}} state 파서 상태(오류 위치)
 * @param {string} reason 이유
 * @returns {never}
 * @throws {SyntaxError} 'BCJSON: <위치> <이유>'
 */
function fail(state,reason){throw new SyntaxError(`BCJSON: ${state.index} ${reason}`);}
