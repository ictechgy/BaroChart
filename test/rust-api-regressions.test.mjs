import assert from 'node:assert/strict';
import test from 'node:test';
import {createJavaScriptOracle} from '../scripts/rust/core-conformance.mjs';
import {createWasmHarness,wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';
import {stringifyLossless} from '../scripts/trace/bcjson.mjs';

const availability=wasmTargetAvailable();

test('WASM API preserves raw missing-indicator strings and original series identities',{
 skip:process.env.REQUIRE_WASM==='1'?false:!availability.available&&availability.reason,
},async t=>{
 const oracle=await createJavaScriptOracle(),rust=await createWasmHarness();
 t.after(()=>rust.dispose());
 const compare=async(name,args)=>{
  const expected=oracle.call(name,args),actual=await rust.call(name,args);
  assert.equal(stringifyLossless(actual),stringifyLossless(expected),`${name} ${stringifyLossless(args)}`);
 };
 await compare('nativeInit',[2,{}]);
 for(const options of ['😀',[],null,7,{unexpected:true,color:5}]){
  await compare('nativeCommand',['addSeries',[options]]);
 }
 for(const id of [5,null,[1,undefined,'x'],'\ud800']){
  await compare('nativeCommand',['removeIndicator',[id]]);
 }
 for(const [id,values] of [['a',[1,2]],['b',[10,20]]]){
  await compare('nativeCommand',['addSeries',[{id,type:'line',panel:'price',values}]]);
 }
 for(const options of ['😀',[],null,7,{unexpected:true,color:5}]){
  await compare('nativeCommand',['setSeries',['a',options]]);
 }
 for(const [index,id] of ['fresh','b',7,null].entries()){
  await compare('nativeCommand',['setSeries',['a',{id,label:`updated-${index}`}]]);
  await compare('nativeInspect',[]);
 }
});
