import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as contracts from '../src/core/contracts.mjs';
import {DrawingStore} from '../src/core/drawings.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const bundle=await buildNativeBundle();
const arrayText=depth=>'['.repeat(depth)+'0'+']'.repeat(depth);
const objectText=depth=>'{"x":'.repeat(depth)+'0'+'}'.repeat(depth);
const check=(text,limit=32)=>contracts.assertJsonTextDepth(text,limit,'Test document depth limit');
const realm=()=>{const context=vm.createContext({});vm.runInContext(bundle,context);context.nativeInit(0);return context;};

test('JSON depth admits the exact limit for arrays, objects and mixed containers',()=>{
 for(const text of [arrayText(32),objectText(32),'['+objectText(31)+']'])assert.equal(check(text),text);
 for(const text of [arrayText(33),objectText(33),'['+objectText(32)+']'])assert.throws(()=>check(text),{name:'RangeError',message:'Test document depth limit'});
});

test('JSON depth ignores string contents, escapes, scalar text and whitespace',()=>{
 const text=JSON.stringify({text:'"}]\\\\\\"{['.repeat(1000),values:[1]});
 assert.equal(check(text,2),text);
 for(const text of ['0','null','true','"[{}]"',' \n [0] \r\t'])assert.equal(check(text,1),text);
 // 검사는 문법 파서를 대신하지 않는다. 얕은 깨진 문법은 기존 JSON.parse의 SyntaxError로 남는다.
 for(const text of ['[1,]','{"a":}','"unterminated ['])assert.throws(()=>JSON.parse(check(text)),SyntaxError);
});

test('JSON depth rejects 100000 levels without parsing or recursing',()=>{
 for(const text of [arrayText(100000),objectText(100000),'['.repeat(100000)])assert.throws(()=>check(text),{name:'RangeError',message:'Test document depth limit'});
});

test('JSON depth does not depend on later String prototype changes',()=>{
 const charCodeAt=String.prototype.charCodeAt;
 String.prototype.charCodeAt=()=>0;
 try{assert.throws(()=>check(arrayText(33)),{name:'RangeError',message:'Test document depth limit'});}
 finally{String.prototype.charCodeAt=charCodeAt;}
});

test('JSON depth preserves JSON.parse string coercion once, including its string hint and Symbol rejection',()=>{
 const hints=[],value={[Symbol.toPrimitive](hint){hints.push(hint);return '[0]';}};
 assert.equal(check(value),'[0]');assert.deepEqual(hints,['string']);
 assert.throws(()=>check(Symbol('input')),TypeError);
});

test('drawing document depth is checked before parsing and leaves drawing/history/selection unchanged',()=>{
 const store=new DrawingStore();store.add({type:'horizontal',points:[{time:1,price:2}]});
 const saved=store.save(),items=store.items,history=store.undoStack,selection=store.selected;
 const parse=JSON.parse;let calls=0;
 JSON.parse=(...args)=>{calls++;return parse(...args);};
 try{
  for(const text of [arrayText(33),objectText(33),arrayText(100000)])assert.throws(()=>store.load(text),{name:'RangeError',message:'Drawing document depth limit'});
  assert.equal(calls,0);
 }finally{JSON.parse=parse;}
 assert.equal(store.save(),saved);assert.equal(store.items,items);assert.equal(store.undoStack,history);assert.equal(store.selected,selection);
 assert.throws(()=>store.load(arrayText(32)),{name:'TypeError',message:'Drawing document: object required'});
});

test('native event and prepare documents reject depth 33 before capture without consuming tickets',()=>{
 const context=realm();
 for(const name of ['nativeAsyncBegin','nativePrepareBegin']){
  for(const depth of [33,100000])assert.throws(()=>context[name](arrayText(depth)),{name:'RangeError',message:name==='nativeAsyncBegin'?'Native data event document depth limit':'Native prepare document depth limit'});
  assert.throws(()=>context[name](arrayText(32)),error=>error.message!=='Native data event document depth limit'&&error.message!=='Native prepare document depth limit');
 }
 const descriptor=JSON.parse(context.nativePrepareBegin('{"kind":"seeded","count":0}'));
 assert.equal(descriptor.ticket,1);context.nativeAsyncRelease(descriptor.ticket);
 assert.equal(JSON.parse(context.nativePrepareBegin('{"kind":"seeded","count":0}')).ticket,2);
 context.nativeAsyncRelease(2);
});

test('native capture busy rejection still precedes document coercion and depth checks',()=>{
 const context=realm(),ticket=JSON.parse(context.nativePrepareBegin('{"kind":"seeded","count":0}')).ticket;
 vm.runInContext('var coercions=0;var input={[Symbol.toPrimitive](){coercions++;throw new Error("coerced")}};',context);
 for(const name of ['nativeAsyncBegin','nativePrepareBegin']){
  assert.throws(()=>vm.runInContext(`${name}(input)`,context),{name:'Error',message:'Async capture busy'});
  assert.throws(()=>context[name](arrayText(33)),{name:'Error',message:'Async capture busy'});
 }
 assert.equal(context.coercions,0);context.nativeAsyncRelease(ticket);
});

test('native document coercion uses the string hint once and the depth helper stays private',()=>{
 const context=realm();
 const result=vm.runInContext(`(()=>{
  const hints=[],value={[Symbol.toPrimitive](hint){hints.push(hint);return '{"kind":"seeded","count":0}';}};
  const ticket=JSON.parse(nativePrepareBegin(value)).ticket;nativeAsyncRelease(ticket);return JSON.stringify(hints);
 })()`,context);
 assert.deepEqual(JSON.parse(result),['string']);
 assert.equal(Object.hasOwn(context.Aster,'assertJsonTextDepth'),false);
});
