// 무손실 추적 형식 BCJSON(설계 §4.2, §7.3, M0 Task 5)을 확인한다.
// BCJSON은 JSON(RFC 8259)에 NaN, Infinity, -Infinity, undefined, F64(<길이>,<sha256>) 토큰을 더한 형식이다.
// iOS JSValue가 보는 값(NaN, -0, undefined)과 Float64Array 전송 해시를 잃지 않고 추적 줄에 담아야
// 같은 추적을 JS 번들과 Rust 백엔드에 재생해 결과를 바이트 단위로 비교할 수 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {stringifyLossless,parseLossless} from '../scripts/trace/bcjson.mjs';

/** 지원하지 않는 값의 기대 오류 */
const UNSUPPORTED={name:'TypeError',message:'BCJSON unsupported value'};

/**
 * 시드 고정 난수 생성기(mulberry32)를 만든다.
 * 새 npm 의존성 없이 실행마다 같은 입력을 재현하려고 직접 쓴다.
 * @param {number} seed 32비트 시드
 * @returns {() => number} [0, 1) 구간의 난수를 돌려주는 함수
 */
function seededRandom(seed){
 let state=seed>>>0;
 return ()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
}

/**
 * Float64Array 값들의 리틀엔디언 바이트 sha256을 플랫폼 엔디언과 무관하게 계산한다.
 * 구현이 쓰는 경로(원래 메모리를 그대로 해시)와 다른 경로(DataView로 다시 씀)로 기대값을 만든다.
 * @param {readonly number[]} values 정규 NaN만 담은 숫자 목록
 * @returns {string} 16진 소문자 sha256
 */
function littleEndianHash(values){
 const view=new DataView(new ArrayBuffer(values.length*8));
 values.forEach((value,index)=>view.setFloat64(index*8,value,true));
 return createHash('sha256').update(new Uint8Array(view.buffer)).digest('hex');
}

/**
 * 시드 난수로 JSON에 그대로 실리는 값(특수 토큰 없음, -0 없음)을 만든다.
 * 문자열에는 제어 문자, 따옴표, 역슬래시, 단독 서로게이트, U+2028을 섞는다.
 * @param {() => number} random seededRandom이 만든 난수 함수
 * @param {number} depth 남은 중첩 깊이
 * @returns {any} JSON.stringify와 BCJSON이 같은 글자를 내야 하는 값
 */
function jsonSafeValue(random,depth){
 const pick=Math.floor(random()*(depth>0?8:6));
 if(pick===0)return null;
 if(pick===1)return random()<0.5;
 if(pick===2){const value=(random()-0.5)*10**Math.floor(random()*40-20);return Object.is(value,-0)?0:value;}
 if(pick===3)return Math.floor(random()*2**31)-2**30;
 if(pick===4||pick===5){const units=[0x22,0x5c,0x0a,0x01,0x1f,0x7f,0x2028,0xd800,0xdc00,0xd83d,0xde00,0x41,0xac00];return String.fromCharCode(...Array.from({length:Math.floor(random()*8)},()=>units[Math.floor(random()*units.length)]));}
 if(pick===6)return Array.from({length:Math.floor(random()*4)},()=>jsonSafeValue(random,depth-1));
 const out={};
 for(let i=Math.floor(random()*4);i>0;i--)out[random()<0.3?String(Math.floor(random()*20)):'k'+Math.floor(random()*20)]=jsonSafeValue(random,depth-1);
 return out;
}

test('non-finite numbers, negative zero and undefined round-trip as tokens',()=>{
 const cases=[[NaN,'NaN'],[Infinity,'Infinity'],[-Infinity,'-Infinity'],[-0,'-0'],[0,'0'],[undefined,'undefined'],[null,'null'],[true,'true'],[false,'false'],[1.5,'1.5'],['x','"x"']];
 for(const [value,text] of cases){
  assert.equal(stringifyLossless(value),text,String(text));
  assert.ok(Object.is(parseLossless(text),value),text);
 }
 const array=[undefined,1,NaN,-0,Infinity,-Infinity,undefined];
 assert.equal(stringifyLossless(array),'[undefined,1,NaN,-0,Infinity,-Infinity,undefined]');
 const parsedArray=parseLossless(stringifyLossless(array));
 assert.equal(parsedArray.length,array.length);
 array.forEach((value,index)=>{assert.ok(index in parsedArray,`slot ${index} kept`);assert.ok(Object.is(parsedArray[index],value),`slot ${index}`);});
 const object={a:undefined,b:{c:undefined,d:-0},e:NaN};
 assert.equal(stringifyLossless(object),'{"a":undefined,"b":{"c":undefined,"d":-0},"e":NaN}');
 const parsedObject=parseLossless(stringifyLossless(object));
 assert.deepEqual(Object.keys(parsedObject),['a','b','e']);
 assert.ok(Object.hasOwn(parsedObject,'a')&&parsedObject.a===undefined,'undefined member stays an own key');
 assert.deepEqual(Object.keys(parsedObject.b),['c','d']);
 assert.ok(Object.is(parsedObject.b.d,-0)&&Number.isNaN(parsedObject.e));
});

test('strings escape like JSON.stringify and lone surrogates use lowercase \\u escapes',()=>{
 assert.equal(stringifyLossless('\uD800'),'"\\ud800"');
 assert.equal(parseLossless('"\\ud800"'),'\uD800');
 assert.equal(parseLossless('"\\uD800"'),'\uD800','uppercase escapes are accepted like JSON.parse');
 const mixed='a"b\\c/\n\r\t\b\f\u0001\u001f\u007f\u2028\u2029\uDC00x\uD83D\uDE00\uD83D';
 assert.equal(stringifyLossless(mixed),JSON.stringify(mixed));
 assert.equal(parseLossless(stringifyLossless(mixed)),mixed);
 assert.equal(parseLossless('"\\/\\b\\f\\n\\r\\t\\"\\\\\\u0041"'),'/\b\f\n\r\t"\\A');
});

test('object keys follow JS own-key order and duplicate keys behave like JSON.parse',()=>{
 const parsed=parseLossless('{"2":1,"b":2,"1":3}');
 assert.deepEqual(Object.keys(parsed),['1','2','b']);
 assert.equal(stringifyLossless(parsed),'{"1":3,"2":1,"b":2}');
 assert.equal(stringifyLossless({b:1,a:2,10:3,2:4}),'{"2":4,"10":3,"b":1,"a":2}');
 const duplicate='{"a":1,"b":2,"a":3}';
 assert.deepEqual(Object.keys(parseLossless(duplicate)),Object.keys(JSON.parse(duplicate)));
 assert.equal(stringifyLossless(parseLossless(duplicate)),'{"a":3,"b":2}','last value wins at the first position');
 const proto=parseLossless('{"__proto__":{"x":1},"y":2}');
 assert.ok(Object.hasOwn(proto,'__proto__'),'__proto__ is an ordinary own key');
 assert.equal(Object.getPrototypeOf(proto),Object.prototype);
 assert.equal(stringifyLossless(proto),JSON.stringify(JSON.parse('{"__proto__":{"x":1},"y":2}')));
});

test('deep nesting round-trips without recursion',()=>{
 const depth=100000;
 const arrays='['.repeat(depth)+']'.repeat(depth);
 assert.equal(stringifyLossless(parseLossless(arrays)),arrays);
 const objects='{"a":'.repeat(depth)+'NaN'+'}'.repeat(depth);
 assert.equal(stringifyLossless(parseLossless(objects)),objects);
});

test('Float64Array becomes an F64 length and little-endian sha256 token',()=>{
 const hash=littleEndianHash([1,-0,NaN]);
 const token=`F64(3,${hash})`;
 assert.equal(stringifyLossless(new Float64Array([1,-0,NaN])),token);
 assert.deepEqual(parseLossless(token),{f64:true,length:3,sha256:hash});
 assert.equal(stringifyLossless({v:[new Float64Array([1,-0,NaN])]}),`{"v":[${token}]}`);
 assert.equal(stringifyLossless(new Float64Array([9,1,-0,NaN,9]).subarray(1,4)),token,'a subarray hashes only its own bytes');
 assert.equal(stringifyLossless(vm.runInNewContext('new Float64Array([1,-0,NaN])')),token,'another realm gives the same token');
 assert.equal(stringifyLossless(new Float64Array(0)),`F64(0,${createHash('sha256').digest('hex')})`);
 const payload=new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]);
 assert.equal(stringifyLossless(new Float64Array(payload.slice().buffer)),`F64(1,${createHash('sha256').update(payload).digest('hex')})`,'NaN payload bits are hashed as stored');
});

test('finite numbers are written with String(n) and read back exactly',()=>{
 for(const value of [1e21,1.5e-7,0.000001,0.1+0.2,-1e-7,2**53,-(2**53),5e-324,1.7976931348623157e308,123456789012345680000]){
  assert.equal(stringifyLossless(value),String(value));
  assert.ok(Object.is(parseLossless(String(value)),value),String(value));
 }
 assert.equal(parseLossless('1e400'),Infinity,'overflow follows JSON.parse');
 assert.equal(parseLossless('-1e400'),-Infinity);
 assert.ok(Object.is(parseLossless('-0.0e5'),-0));
});

test('JSON-safe values give exactly JSON.stringify text and parse like JSON.parse',()=>{
 const random=seededRandom(20261102);
 for(let i=0;i<500;i++){
  const value=jsonSafeValue(random,4),text=JSON.stringify(value);
  assert.equal(stringifyLossless(value),text,text);
  assert.deepStrictEqual(parseLossless(text),JSON.parse(text),text);
 }
 assert.deepStrictEqual(parseLossless(' [ 1 ,\t{"a" : [ ] } ,\r\n"x" ]\n'),[1,{a:[]},'x'],'JSON whitespace is accepted between tokens');
});

test('functions, symbols, bigint and cycles are unsupported values',()=>{
 const cyclicArray=[];cyclicArray.push(cyclicArray);
 const cyclicObject={};cyclicObject.self={inner:cyclicObject};
 for(const value of [()=>1,[1,()=>2],{f(){return 1;}},Symbol('s'),[Symbol('s')],{s:Symbol('s')},10n,cyclicArray,cyclicObject])assert.throws(()=>stringifyLossless(value),UNSUPPORTED);
 const shared={x:1};
 assert.equal(stringifyLossless([shared,shared]),'[{"x":1},{"x":1}]','a repeated non-cyclic reference is written twice');
});

test('malformed text throws a positioned BCJSON SyntaxError',()=>{
 const cases=[
  ['',0,'unexpected end'],
  ['[1,]',3,'unexpected character'],
  ['{"a" 1}',5,'expected :'],
  ['nan',0,'unexpected character'],
  ['"\u0001"',1,'control character in string'],
  ['01',1,'trailing characters'],
  [`F64(3,${'A'.repeat(64)})`,0,'invalid F64 token'],
  ['"abc',4,'unterminated string'],
  ['"\\x"',1,'invalid escape'],
  ['{"a":1',6,'unexpected end'],
  ['undefinedx',9,'trailing characters'],
  ['\u00a01',0,'unexpected character'],
 ];
 for(const [text,position,reason] of cases)assert.throws(()=>parseLossless(text),{name:'SyntaxError',message:`BCJSON: ${position} ${reason}`},JSON.stringify(text));
});
