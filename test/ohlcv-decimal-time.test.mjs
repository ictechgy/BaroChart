import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOHLCV,BarStore} from '../src/core/index.mjs';
const normalize=(time,timeUnit='ms')=>normalizeOHLCV([[time,1,2,0,1,0]],{format:'tuples',timeUnit})[0];
test('decimal seconds preserve exact milliseconds without intermediate binary rounding',()=>{
 for(const [text,expected] of [['1.001',1001],['-1.001',-1001],['1.001e0',1001],['1001e-3',1001],['.001',1],['1.',1000],['+1.001',1001],[' 1.001 ',1001],['1700000000.123',1700000000123]]) assert.equal(normalize(text,'s').time,expected);
});
test('fractional milliseconds and underflow never silently become a different timestamp',()=>{
 for(const text of ['1700000000000.00001','8640000000000000.1','1e-400','-1e-400','.1'])assert.throws(()=>normalize(text),RangeError);
 for(const text of ['1.0001','1e-400','8640000000000.0001'])assert.throws(()=>normalize(text,'s'),RangeError);
});
test('decimal time bounds and signed zero are explicit',()=>{
 for(const unit of ['ms','s']){
  const boundary=unit==='ms'?'8640000000000000':'8640000000000';
  assert.equal(normalize(boundary,unit).time,8640000000000000);assert.equal(normalize('-'+boundary,unit).time,-8640000000000000);
  for(const value of ['0','0e10000','0e-10000'])assert.ok(Object.is(normalize(value,unit).time,0));
  assert.ok(Object.is(normalize('-0.000',unit).time,-0));
 }
 assert.throws(()=>normalize('8640000000000001'),RangeError);assert.throws(()=>normalize('9007199254740991'),RangeError);
});
test('time text grammar and resource limits reject before numeric conversion',()=>{
 for(const text of ['0x10','0b10','0o10','Infinity','NaN','',' ','1_000','1e','--1','1,000'])assert.throws(()=>normalize(text),TypeError);
 for(const text of ['0'.repeat(129),' '.repeat(129),' '.repeat(128)+'1','1e10001','0e-10001'])assert.throws(()=>normalize(text),RangeError);
 assert.equal(normalize('0'.repeat(127)+'1').time,1);
});
test('number inputs retain existing binary64 conversion; price and volume conversion unchanged',()=>{
 assert.equal(normalize(1700000000,'s').time,1700000000000);
 assert.throws(()=>normalize(1.001,'s'),RangeError);
 assert.equal(normalize(Number('1700000000000.00001')).time,1700000000000);
 const row=normalizeOHLCV([{time:'1001',open:'-0.1',high:'0',low:'-1',close:'-0.2',volume:'0'}])[0];
 assert.equal(row.close,Number('-0.2'));assert.equal(row.volume,0);assert.equal(new BarStore([row]).length,1);
});
test('exact decimal timestamp conversion agrees with independent integer oracle',()=>{
 for(let coefficient=-97;coefficient<=97;coefficient+=7)for(let exponent=-6;exponent<=6;exponent++)for(const unit of ['ms','s']){
  const power=exponent+(unit==='s'?3:0),numerator=BigInt(coefficient)*(power>=0?10n**BigInt(power):1n),denominator=power<0?10n**BigInt(-power):1n;
  const text=`${coefficient}e${exponent}`;
  if(numerator%denominator)assert.throws(()=>normalize(text,unit),RangeError);else assert.equal(normalize(text,unit).time,Number(numerator/denominator));
 }
});
test('native generated bundle uses the same exact decimal timestamp boundary',async()=>{
 const {buildNativeBundle}=await import('../scripts/native-core-bundle.mjs'),vm=await import('node:vm');
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context);
 assert.equal(vm.runInContext(`Aster.normalizeOHLCV([['1.001',1,1,1,1,0]],{format:'tuples',timeUnit:'s'})[0].time`,context),1001);
 assert.throws(()=>vm.runInContext(`Aster.normalizeOHLCV([['1700000000000.00001',1,1,1,1,0]],{format:'tuples'})`,context),/exact UTC millisecond/);
});
