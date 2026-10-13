import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/index.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';

const moduleName='aster.volume-direction@1/pressure';
const absent={value:null,sourceIndex:null,sourceTime:null};
const makeBars=(closes=[10,11,11,9,12,8,8,13,10,14,12,15])=>closes.map((close,i)=>({
 time:1700000000000+i*60000,open:close-.25,high:close+1+i%3,low:close-1-i%2,close,volume:[5,7,8,9,4,6,3,2,11,1,12,10][i]??i+1,
}));
function fixture(bars=makeBars()) {
 const model=new A.ChartModel(),api=new A.ChartAPI(model);api.setData(bars);
 return {model,api};
}
function requireAsOf(api) {assert.equal(typeof api.indicatorValueAt,'function','public indicatorValueAt contract is required');}
function registerModule(api) {
 assert.equal(typeof api.registerIndicatorModule,'function','public module registration contract is required');
 assert.deepEqual(api.registerIndicatorModule('aster.volume-direction',1),[moduleName]);
}
// Each expected value is calculated from the available prefix, without reading
// an Aster output array, checkpoint, plot offset or indicator definition.
function cloudPrefix(bars,{conversion,base,span}) {
 const midpoint=(index,period)=>{
  if(index+1<period)return null;
  const window=bars.slice(index-period+1,index+1);
  return (Math.max(...window.map(b=>b.high))+Math.min(...window.map(b=>b.low)))/2;
 };
 const result={tenkan:[],kijun:[],spanA:[],spanB:[],chikou:[]};
 for(let i=0;i<bars.length;i++) {
  const tenkan=midpoint(i,conversion),kijun=midpoint(i,base);
  result.tenkan.push(tenkan);result.kijun.push(kijun);
  result.spanA.push(tenkan===null||kijun===null?null:(tenkan+kijun)/2);
  result.spanB.push(midpoint(i,span));result.chikou.push(bars[i].close);
 }
 return result;
}
function pressurePrefix(bars,factor=1) {
 let cumulative=0;
 const signed=bars.map((bar,i)=>i===0?0:Math.sign(bar.close-bars[i-1].close)*bar.volume*factor);
 return {signed,cumulative:signed.map(value=>cumulative+=value)};
}
function expectedAt(bars,prefixValues,sourceIndex,asOfIndex) {
 if(sourceIndex<0||sourceIndex>=bars.length||sourceIndex>asOfIndex)return {...absent};
 return {value:prefixValues[sourceIndex]??null,sourceIndex,sourceTime:bars[sourceIndex].time};
}
function verifyCloud(api,bars,params) {
 for(let asOfIndex=-1;asOfIndex<bars.length;asOfIndex++) {
  const prefix=cloudPrefix(bars.slice(0,asOfIndex+1),params);
  for(const output of Object.keys(prefix))for(const mode of ['raw','plot']) {
   const offset=mode==='raw'?0:output==='chikou'?-params.displacement:['spanA','spanB'].includes(output)?params.displacement:0;
   for(let index=-params.displacement-1;index<=bars.length+params.displacement;index++) {
    const expected=expectedAt(bars,prefix[output],index-offset,asOfIndex);
    assert.deepEqual(api.indicatorValueAt('cloud',output,index,{mode,asOfIndex}),expected,`${output} ${mode} index${index} asOf${asOfIndex}`);
   }
  }
 }
}
function verifyPressure(api,bars,shift,factor) {
 for(let asOfIndex=-1;asOfIndex<bars.length;asOfIndex++) {
  const prefix=pressurePrefix(bars.slice(0,asOfIndex+1),factor);
  for(const output of ['signed','cumulative'])for(const mode of ['raw','plot'])for(let index=-Math.abs(shift)-1;index<=bars.length+Math.abs(shift);index++) {
   const sourceIndex=index-(mode==='plot'?shift:0);
   assert.deepEqual(api.indicatorValueAt('pressure',output,index,{mode,asOfIndex}),expectedAt(bars,prefix[output],sourceIndex,asOfIndex),`${output} shift${shift} ${mode} index${index} asOf${asOfIndex}`);
  }
 }
}

test('public versioned volume-direction sample has independent signed and cumulative vectors',()=>{
 const bars=makeBars([10,11,11,9]),{model,api}=fixture(bars);
 try {
  registerModule(api);requireAsOf(api);api.addIndicator('pressure',moduleName,{factor:1,shift:0});
  assert.deepEqual(api.indicatorValues('pressure','signed'),[0,7,0,-9]);
  assert.deepEqual(api.indicatorValues('pressure','cumulative'),[0,7,7,-2]);
  for(let i=0;i<bars.length;i++)assert.deepEqual(api.indicatorValueAt('pressure','cumulative',i),{value:[0,7,7,-2][i],sourceIndex:i,sourceTime:bars[i].time});
 } finally {model.dispose();}
});

test('Ichimoku raw and positive/negative plot as-of queries match independent prefixes',()=>{
 const bars=makeBars(),params={conversion:3,base:5,span:7,displacement:4},{model,api}=fixture(bars);
 try {requireAsOf(api);api.addIndicator('cloud','ichimoku',params);verifyCloud(api,bars,params);}finally {model.dispose();}
});

test('known warmup retains source metadata while future and unavailable mappings reveal none',()=>{
 const bars=makeBars(),{model,api}=fixture(bars);
 try {
  requireAsOf(api);api.addIndicator('cloud','ichimoku',{conversion:3,base:5,span:7,displacement:4});
  assert.deepEqual(api.indicatorValueAt('cloud','spanB',4,{mode:'plot',asOfIndex:0}),{value:null,sourceIndex:0,sourceTime:bars[0].time});
  assert.deepEqual(api.indicatorValueAt('cloud','chikou',0,{mode:'plot',asOfIndex:3}),absent);
  assert.deepEqual(api.indicatorValueAt('cloud','chikou',-4,{mode:'plot',asOfIndex:0}),{value:bars[0].close,sourceIndex:0,sourceTime:bars[0].time});
  assert.deepEqual(api.indicatorValueAt('cloud','spanA',bars.length+3,{mode:'plot'}),{value:cloudPrefix(bars,{conversion:3,base:5,span:7}).spanA.at(-1),sourceIndex:bars.length-1,sourceTime:bars.at(-1).time});
  assert.deepEqual(api.indicatorValueAt('cloud','chikou',bars.length),absent);
  assert.deepEqual(api.indicatorValueAt('cloud','chikou',-1),absent);
 } finally {model.dispose();}
});

for(const shift of [-3,0,3])test(`module shift${shift} prefixes survive correction, append and current-bar replacement`,()=>{
 const bars=makeBars(),factor=.5,{model,api}=fixture(bars);
 try {
  registerModule(api);requireAsOf(api);api.addIndicator('pressure',moduleName,{factor,shift});
  verifyPressure(api,bars,shift,factor);
  bars[3]={...bars[3],close:14,high:16};api.applyDataEvent({kind:'correction',bar:bars[3]});verifyPressure(api,bars,shift,factor);
  const appended={...bars.at(-1),time:bars.at(-1).time+60000,open:13,high:18,low:12,close:17,volume:19};
  bars.push(appended);api.applyDataEvent({kind:'append',bar:appended});verifyPressure(api,bars,shift,factor);
  bars[bars.length-1]={...appended,close:12,low:11,volume:23};api.applyDataEvent({kind:'update',bar:bars.at(-1)});verifyPressure(api,bars,shift,factor);
 } finally {model.dispose();}
});

test('Ichimoku prefixes also remain causal after correction, append and current replacement',()=>{
 const bars=makeBars(),params={conversion:3,base:5,span:7,displacement:4},{model,api}=fixture(bars);
 try {
  requireAsOf(api);api.addIndicator('cloud','ichimoku',params);
  bars[2]={...bars[2],high:20,low:6,close:15};api.applyDataEvent({kind:'correction',bar:bars[2]});verifyCloud(api,bars,params);
  const appended={...bars.at(-1),time:bars.at(-1).time+60000,high:20,low:7,close:13};bars.push(appended);api.applyDataEvent({kind:'append',bar:appended});verifyCloud(api,bars,params);
  bars[bars.length-1]={...appended,high:23,close:21};api.applyDataEvent({kind:'update',bar:bars.at(-1)});verifyCloud(api,bars,params);
 } finally {model.dispose();}
});

test('as-of validates integer indexes, bounded horizons, names and mode without model mutation',()=>{
 const {model,api}=fixture();
 try {
  requireAsOf(api);api.addIndicator('sma','sma',{period:3});
  const before=api.inspect(),version=model.store.version;
  for(const index of [NaN,Infinity,.5,'1',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>api.indicatorValueAt('sma','value',index));
  for(const asOfIndex of [-2,model.store.length,.5,NaN,'1'])assert.throws(()=>api.indicatorValueAt('sma','value',0,{asOfIndex}));
  assert.throws(()=>api.indicatorValueAt('sma','value',0,{mode:'future'}));
  assert.throws(()=>api.indicatorValueAt('missing','value',0));assert.throws(()=>api.indicatorValueAt('sma','missing',0));
  assert.deepEqual(api.inspect(),before);assert.equal(model.store.version,version);
 } finally {model.dispose();}
 const empty=fixture([]);
 try {requireAsOf(empty.api);empty.api.addIndicator('sma','sma',{period:3});assert.deepEqual(empty.api.indicatorValueAt('sma','value',0,{asOfIndex:-1}),absent);assert.deepEqual(empty.api.indicatorValueAt('sma','value',0),absent);assert.throws(()=>empty.api.indicatorValueAt('sma','value',0,{asOfIndex:0}));}finally {empty.model.dispose();}
});

test('arbitrary and source-string factories are explicitly unsupported for causal as-of and async portability',()=>{
 for(const source of [false,true]) {
  const {model,api}=fixture();
  try {
   requireAsOf(api);
   if(source)api.registerIndicatorSource('untrusted-oracle','()=>({outputs:["value"],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}}}})');
   // A naked factory may read the whole store and claim causality itself. That
   // claim cannot grant as-of/worker portability or expose a later close.
   else api.registerIndicator('untrusted-oracle',()=>({causal:true,outputs:['value'],plotOffsets:{value:-3},create(){return {step:()=>[model.store.at(model.store.length-1).close],snapshot:()=>0,restore(){}};}}));
   api.addIndicator('naked','untrusted-oracle');
   assert.throws(()=>api.indicatorValueAt('naked','value',0),/unsupported|causal|portable/i);
   assert.throws(()=>api.indicatorValueAt('naked','value',0,{asOfIndex:0}),/unsupported|causal|portable/i);
   assert.throws(()=>api.indicatorValueAt('naked','value',0,{mode:'plot',asOfIndex:0}),/unsupported|causal|portable/i);
   assert.throws(()=>modelRequest(model),/unsupported|factory|portable|built.?in/i);
  } finally {model.dispose();}
 }
});
