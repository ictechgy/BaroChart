// Execute the shipped full analysis module body with real ChartAPI/CanvasChart.
// Async Worker correction and paint/DOM primitives are modeled; no browser or Worker-runtime claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as lib from '../src/index.mjs';
import '../examples/indicators/local-volume-balance.mjs';
import {fixture} from './helpers/customization-dom.mjs';
const root=new URL('../',import.meta.url),src=readFileSync(new URL('examples/web/analysis.mjs',root),'utf8'),html=readFileSync(new URL('examples/web/analysis.html',root),'utf8');
function demo(t){
 const env=fixture(t),nodes=new Map(),pending=[];env.document.body.dataset.demo='analysis';
 for(const m of html.matchAll(/<([a-z-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const n=env.node(m[1]);nodes.set(m[2],n);const value=m[0].match(/\bvalue="([^"]*)"/);if(value)n.value=value[1];n.disabled=/\bdisabled\b/.test(m[0]);}
 const $=id=>nodes.get(id);env.document.getElementById=$;$('anchor').value='session';
 const createChart=(host,model,opts)=>{const chart=new lib.CanvasChart(host,model,{...opts,observeResize:false,layerCaching:false,dpr:()=>1,rendererFactory:()=>({kind:'canvas',render(){},dispose(){}})});env.charts.push(chart);env.models.push(model);return chart;};
 const args={...lib,createChart,recomputeInWorker:(...args)=>new Promise((resolve,reject)=>pending.push({args,resolve,reject}))};
 Function(...Object.keys(args),src.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('examples/web/analysis.mjs',root).href)))(...Object.values(args));
 return{...env,$,pending,get chart(){return env.window.analysisExample.chart;},get model(){return env.window.analysisExample.model;}};
}
const controls=['anchor','fit','correct','asof','query','save','load','setup'];
const anchored=Date.parse('2026-03-06T16:00Z');
const setMode=async(f,value)=>{f.$('anchor').value=value;await f.$('anchor').onchange();};
const assertBusy=(f,busy)=>{for(const id of controls)assert.equal(f.$(id).disabled,busy,id);assert.equal(f.$('chart').getAttribute('aria-busy'),String(busy));};
test('analysis placeholder exists and cannot itself be chosen as a new standard mode',()=>{assert.match(html,/<option\s+value="custom"\s+disabled>/);});
for(const mode of ['session','anchor'])test('analysis '+mode+' import synchronizes the control with accepted VWAP parameters',async t=>{
 const f=demo(t);assert.equal(f.$('anchor').value,'session');await setMode(f,mode);await f.$('save').onclick();const saved=f.$('setup').value;await setMode(f,mode==='anchor'?'session':'anchor');await f.$('load').onclick();assert.equal(f.$('anchor').value,mode);assert.equal(f.model.indicators.entries.get('vwap').params.anchorTime,mode==='anchor'?anchored:undefined);assert.equal(f.chart.api.saveStudies(),saved);assertBusy(f,false);
});
for(const custom of ['deviation','calendar','anchorTime','missing'])test('analysis '+custom+' import displays honest custom/unavailable state without normalizing imported setup',async t=>{
 const f=demo(t);if(custom==='missing')f.chart.api.removeIndicator('vwap');else{const params={...f.model.indicators.entries.get('vwap').params};if(custom==='deviation')params.deviation=3;else if(custom==='calendar')params.calendar=lib.portableSessionCalendar({timezone:'UTC',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]});else params.anchorTime=anchored+60000;f.chart.api.setIndicatorParams('vwap',params);}
 await f.$('save').onclick();const saved=f.$('setup').value;assert.equal(f.$('anchor').value,'custom');f.$('anchor').value='session';await f.$('load').onclick();assert.equal(f.$('anchor').value,'custom');assert.equal(f.chart.api.saveStudies(),saved);assertBusy(f,false);
 if(custom==='missing'){await setMode(f,'anchor');assert.equal(f.$('anchor').value,'custom');assert.equal(f.model.indicators.entries.has('vwap'),false);assert.match(f.$('status').textContent,/변경을 적용하지 못했습니다/);}
});
for(const outcome of ['resolve','reject'])test('analysis correction '+outcome+' blocks controls, restores accepted values and releases busy state',async t=>{
 const f=demo(t),oldChart=f.chart,oldModel=f.model,work=f.$('correct').onclick();assert.equal(f.pending.length,1);assertBusy(f,true);assert.match(f.$('status').textContent,/중/);
 f.$('anchor').value='anchor';await f.$('anchor').onchange();assert.equal(f.$('anchor').value,'session');assert.equal(f.model.indicators.entries.get('vwap').params.anchorTime,undefined);assertBusy(f,true);
 if(outcome==='resolve')f.pending[0].resolve();else f.pending[0].reject(new Error('correction refused'));
 await work;assertBusy(f,false);assert.equal(f.chart,oldChart);assert.equal(f.model,oldModel);assert.equal(oldChart.disposed,false);assert.equal(f.$('anchor').value,'session');if(outcome==='reject')assert.match(f.$('status').textContent,/correction refused/);
 await setMode(f,'anchor');assert.equal(f.model.indicators.entries.get('vwap').params.anchorTime,anchored);assert.equal(f.$('anchor').value,'anchor');
});
test('invalid analysis setup preserves model, accepted mode and readable error',async t=>{
 const f=demo(t);await setMode(f,'anchor');const oldModel=f.model,oldChart=f.chart;f.$('setup').value='{bad}';await f.$('load').onclick();assert.equal(f.model,oldModel);assert.equal(f.chart,oldChart);assert.equal(f.$('anchor').value,'anchor');assert.equal(f.model.indicators.entries.get('vwap').params.anchorTime,anchored);assert.match(f.$('status').textContent,/변경을 적용하지 못했습니다/);assertBusy(f,false);
});
