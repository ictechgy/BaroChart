import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChartModel,ChartAPI,builtinIndicators,buildScene} from '../src/core/index.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';
const source=await readFile(new URL('../examples/web/demo.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function addIndicator(){'),end=source.indexOf('\nfor(const name of builtinIndicators.keys())',start);
assert.ok(start>=0&&end>start);
// Execute the actual demo handler with preparation/UI boundaries replaced by
// owned test hooks. No browser, Worker, rendering or network is exercised.
const invoke=new Function('context','with(context){return ('+source.slice(start,end)+')();}');
const priceNames=['sma','vwma','ema','wma','bollinger','donchian','vwap','dema','tema','hma','keltner','supertrend','ichimoku','pivots','parabolicSAR'];
const separateNames=['rsi','atr','macd','aroon','stochastic','roc','williamsR','cci','obv','mfi','cmf','adx','trix','ppo','stochRSI','adl','chaikin','forceIndex','volumeOscillator','vortex'];
async function optionsFor(name,scale='linear'){
 const model=new ChartModel({panels:[{id:'price',scale,precision:5,weight:3}]});const api=new ChartAPI(model);api.addSeries({id:'price',type:'candles',panel:'price'});let prepared,installed;
 const context={model,job:0,controller:null,serial:0,AbortController,stopStream(){},busy(){},modelRequest,$:()=>({value:name}),builtinIndicators,progress(){},loadedMarket:'us',loadedCount:0,extras:[],streamIntent:false,document:{hidden:true},startStream(){},status(){},friendly(error){throw error;},prepareChartModel:async request=>{prepared=request;return{sentinel:true};},install:next=>{installed=next;}};
 try{await invoke(context);assert.equal(installed?.sentinel,true);return prepared.options;}finally{model.dispose();}
}
test('demo classification covers all 35 canonical builtin names exactly once',()=>{assert.equal(builtinIndicators.size,35);assert.equal(new Set([...priceNames,...separateNames]).size,35);assert.deepEqual([...builtinIndicators.keys()].sort(),[...priceNames,...separateNames].sort());});
for(const name of [...priceNames,...separateNames])test(`demo ${name} uses its intended panel and output series`,async()=>{
 const options=await optionsFor(name),isPrice=priceNames.includes(name),panel=isPrice?'price':'extra-1',series=options.series.filter(s=>s.indicator==='extra-1');
 assert.equal(options.panels.length,isPrice?1:2);assert.ok(series.length>0);assert.ok(series.every(s=>s.panel===panel&&s.axisId===undefined));assert.deepEqual(series.map(s=>s.output),builtinIndicators.get(name)({}).outputs.filter(o=>o!=='direction'));assert.ok(series.every(s=>s.type===(s.output==='histogram'?'histogram':'line')));
});
for(const scale of ['linear','log','percent'])test(`VWMA shares the existing ${scale} price panel while Aroon stays independent`,async()=>{
 for(const name of ['vwma','aroon']){const options=await optionsFor(name,scale),model=new ChartModel(options),api=new ChartAPI(model);try{for(const i of options.indicators)api.addIndicator(i.id,i.name,i.params);for(const s of options.series)api.addSeries(s);assert.equal(model.panels[0].scale,scale);assert.equal(model.panels[0].precision,5);const extra=model.series.filter(s=>s.indicator==='extra-1');assert.ok(extra.every(s=>s.panel===(name==='vwma'?'price':'extra-1')));if(name==='aroon')assert.equal(model.panels[1].scale,'linear');api.setData(Array.from({length:64},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10+i})));const scene=buildScene(model,800,500),priceAxis=scene.layout.axis('price');for(const s of extra){const axis=scene.layout.axis(s.panel,s.axisId);if(name==='vwma')assert.strictEqual(axis,priceAxis);else assert.notStrictEqual(axis,priceAxis);assert.ok(Number.isFinite(axis.y(50)));}}finally{model.dispose();}}
});
for(const file of ['README.md','README.ko.md','examples/web/index.html'])test(`${file} links both current demo pages`,async()=>{const text=await readFile(new URL('../'+file,import.meta.url),'utf8');for(const page of ['linked-cursors','drawing-groups']){assert.ok(text.includes(page+'.html'));const html=await readFile(new URL('../examples/web/'+page+'.html',import.meta.url),'utf8');assert.match(html,/<title>[^<]*BaroChart/i);for(const m of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g))await readFile(new URL('../examples/web/'+m[1],import.meta.url));}});
