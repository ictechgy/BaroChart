import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,IndicatorEngine,seededColumns,FIELDS} from '../src/core/index.mjs';
const p=14,fast=12,slow=26,signal=9;
const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;
const rolling=(a,p,fn=avg)=>a.map((_,i)=>i<p-1||a.slice(i-p+1,i+1).some(x=>!Number.isFinite(x))?NaN:fn(a.slice(i-p+1,i+1)));
function smooth(a,p,alpha){let previous=NaN,seed=[];return a.map(v=>{if(!Number.isFinite(v)){previous=NaN;seed=[];return NaN;}if(!Number.isFinite(previous)){seed.push(v);if(seed.length<p)return NaN;previous=avg(seed);}else previous=(1-alpha)*previous+alpha*v;return previous;});}
function reference(b){
 const c=b.map(x=>x.close),v=b.map(x=>x.volume),tp=b.map(x=>(x.high+x.low+x.close)/3),tr=b.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-b[i-1].close),Math.abs(x.low-b[i-1].close)):x.high-x.low),delta=c.map((x,i)=>i?x-c[i-1]:NaN),gain=smooth(delta.map(x=>Math.max(x,0)),p,1/p),loss=smooth(delta.map(x=>Math.max(-x,0)),p,1/p),high=rolling(b.map(x=>x.high),p,a=>Math.max(...a)),low=rolling(b.map(x=>x.low),p,a=>Math.min(...a));
 const short=smooth(c,fast,2/(fast+1)),long=smooth(c,slow,2/(slow+1)),macd=c.map((_,i)=>short[i]-long[i]),sig=smooth(macd,signal,2/(signal+1));
 const mid=rolling(c,p),std=rolling(c,p,a=>{const origin=a[0],mean=origin+avg(a.map(v=>v-origin));return Math.sqrt(avg(a.map(v=>(v-mean)**2)));}),raw=c.map((x,i)=>!Number.isFinite(high[i])?NaN:high[i]===low[i]?50:100*(x-low[i])/(high[i]-low[i])),k=rolling(raw,3),d=rolling(k,3);
 let obv=0,pv=0,vol=0,session=NaN;const obvs=c.map((x,i)=>{if(i)obv+=Math.sign(x-c[i-1])*v[i];return obv;}),vwaps=b.map((x,i)=>{const day=Math.floor(x.time/86400000);if(day!==session){pv=0;vol=0;session=day;}pv+=tp[i]*v[i];vol+=v[i];return vol?pv/vol:NaN;});
 const pos=rolling(tp.map((x,i)=>i?(x>tp[i-1]?x*v[i]:0):NaN),p),neg=rolling(tp.map((x,i)=>i?(x<tp[i-1]?x*v[i]:0):NaN),p),flow=rolling(b.map(x=>x.high===x.low?0:(2*x.close-x.high-x.low)/(x.high-x.low)*x.volume),p),rollingVol=rolling(v,p);
 const adxTr=smooth(tr.map((x,i)=>i?x:NaN),p,1/p),upDM=b.map((x,i)=>{if(!i)return NaN;const up=x.high-b[i-1].high,down=b[i-1].low-x.low;return up>down&&up>0?up:0;}),downDM=b.map((x,i)=>{if(!i)return NaN;const up=x.high-b[i-1].high,down=b[i-1].low-x.low;return down>up&&down>0?down:0;}),up=smooth(upDM,p,1/p),down=smooth(downDM,p,1/p),plus=up.map((x,i)=>Number.isNaN(adxTr[i])?NaN:adxTr[i]===0?0:100*x/adxTr[i]),minus=down.map((x,i)=>Number.isNaN(adxTr[i])?NaN:adxTr[i]===0?0:100*x/adxTr[i]),dx=plus.map((x,i)=>x+minus[i]===0?0:100*Math.abs(x-minus[i])/(x+minus[i]));
 return {
 sma:{value:mid},ema:{value:smooth(c,p,2/(p+1))},wma:{value:rolling(c,p,a=>a.reduce((s,x,i)=>s+x*(i+1),0)/(p*(p+1)/2))},rsi:{value:gain.map((g,i)=>Number.isNaN(g)?NaN:g===0&&loss[i]===0?50:loss[i]===0?100:100-100/(1+g/loss[i]))},atr:{value:smooth(tr,p,1/p)},macd:{macd,signal:sig,histogram:macd.map((v,i)=>v-sig[i])},bollinger:{middle:mid,upper:mid.map((x,i)=>x+2*std[i]),lower:mid.map((x,i)=>x-2*std[i])},donchian:{middle:high.map((h,i)=>(h+low[i])/2),upper:high,lower:low},stochastic:{k,d},roc:{value:c.map((x,i)=>i<p||c[i-p]===0?NaN:(x/c[i-p]-1)*100)},williamsR:{value:c.map((x,i)=>Number.isNaN(high[i])?NaN:high[i]===low[i]?-50:-100*(high[i]-x)/(high[i]-low[i]))},cci:{value:tp.map((x,i)=>{if(i<p-1)return NaN;const window=tp.slice(i-p+1,i+1),mean=avg(window),dev=avg(window.map(v=>Math.abs(v-mean)));return dev? (x-mean)/(.015*dev):0;})},obv:{value:obvs},vwap:{value:vwaps},mfi:{value:pos.map((x,i)=>Number.isNaN(x)?NaN:x===0&&neg[i]===0?50:neg[i]===0?100:100-100/(1+x/neg[i]))},cmf:{value:flow.map((x,i)=>Number.isNaN(x)||rollingVol[i]===0?NaN:x/rollingVol[i])},adx:{adx:smooth(dx,p,1/p),plusDI:plus,minusDI:minus}};
}
test('independent mixed/tiny/flat corpus: all 17 original indicators',()=>{
let channels=0,points=0;const report=[];
for (const [name,factor,flat] of [['mixed',1,false],['tiny-coin',1e-12,false],['flat-zero-volume',1,true]]) {
 const c=seededColumns(600,4711);for(let i=0;i<600;i++){c.time[i]=Date.parse('2026-04-01T20:00:00Z')+i*60000;for(const k of ['open','high','low','close'])c[k][i]=flat?0:c[k][i]*factor;if(flat)c.volume[i]=0;}
 const store=new BarStore();store.setColumns(c);const bars=Array.from({length:600},(_,i)=>store.at(i)),ref=reference(bars),engine=new IndicatorEngine(store);let worst=0;
 for(const [indicator,outputs] of Object.entries(ref)) {
  const actual=engine.add(indicator,indicator,{period:p}).outputs;
  for(const [channel,expected] of Object.entries(outputs)){channels++;const magnitude=Math.max(1e-300,...expected.filter(Number.isFinite).map(Math.abs)),tolerance=1e-9*magnitude;
   for(let i=0;i<600;i++){points++;const a=actual[channel][i],e=expected[i];assert.equal(Number.isNaN(a),Number.isNaN(e),`${name}/${indicator}/${channel}[${i}] warmup`);if(Number.isFinite(e)){const difference=Math.abs(a-e);assert.ok(difference<=tolerance,`${name}/${indicator}/${channel}[${i}] ${a} vs ${e}, tolerance=${tolerance}`);worst=Math.max(worst,difference/magnitude);}}
  }
 }
 engine.dispose();report.push({dataset:name,bars:600,indicators:17,maxChannelScaledError:worst});
}
console.log(JSON.stringify({independentReferences:'direct rolling windows + independent EMA/Wilder recurrence, conventions from docs/INDICATORS.md; no production helper reused',channelComparisons:channels,pointComparisons:points,relativeChannelTolerance:1e-9,report},null,2));

});
