// Actual demo module bodies and CanvasChart/ChartAPI; only DOM, RAF, painter and async preparation are modeled.
// No browser pixels, native/default focus behavior, touch, Worker execution or assistive technology certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as lib from '../src/index.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';
import {drawingImportMessage} from '../examples/web/import-errors.mjs';
import {createDrawingFileImport} from '../examples/web/drawing-file-import.mjs';
import * as layoutHelpers from '../examples/web/indicator-layout.mjs';
import {fixture,event,key} from './helpers/customization-dom.mjs';
const root=new URL('../',import.meta.url);
const src=readFileSync(new URL('examples/web/demo.mjs',root),'utf8'),html=readFileSync(new URL('examples/web/index.html',root),'utf8');
function demo(t){
 const cleanup=[],env=fixture({after:fn=>cleanup.push(fn)}),nodes=new Map(),toolNodes=[];
 env.document.documentElement=env.node('html');env.document.hidden=false;env.document.addEventListener=()=>{};
 for(const m of html.matchAll(/<([a-z-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const n=env.node(m[1]);nodes.set(m[2],n);const value=m[0].match(/\bvalue="([^"]*)"/);if(value)n.value=value[1];n.disabled=/\bdisabled\b/.test(m[0]);n.hidden=/\bhidden\b/.test(m[0]);}
 for(const m of html.matchAll(/<button data-tool="([^"]+)" title="([^"]+)"[^>]*>/g)){const n=env.node('button');n.dataset.tool=m[1];n.title=m[2];n.disabled=/\bdisabled\b/.test(m[0]);toolNodes.push(n);}
 const $=id=>nodes.get(id);env.document.getElementById=$;env.document.querySelectorAll=()=>toolNodes;env.document.querySelector=()=>toolNodes.find(n=>n.getAttribute('aria-pressed')==='true');
 for(const[id,value]of Object.entries({market:'us',count:'64',series:'candles',scale:'linear',renderer:'canvas',indicator:'ema','crosshair-snap':'free',magnet:'off'}))$(id).value=value;
 const requests=[],timers=new Map();let timerSerial=0;
 const prepareChartModel=(request,options)=>new Promise((resolve,reject)=>{requests.push({request,options,resolve,reject});options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});
 const createChart=(host,model,opts)=>{const chart=new lib.CanvasChart(host,model,{...opts,observeResize:false,layerCaching:false,dpr:()=>1,rendererFactory:()=>({kind:'canvas',render(){},dispose(){}})});env.charts.push(chart);env.models.push(model);return chart;};
 const args={...lib,...layoutHelpers,createChart,modelRequest,drawingImportMessage,createDrawingFileImport,prepareChartModel,matchMedia:()=>({matches:false}),setInterval:(fn,delay)=>{const id=++timerSerial;timers.set(id,{fn,delay});return id;},clearInterval:id=>timers.delete(id)};
 const body=src.replace(/^import[^\n]+\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('examples/web/demo.mjs',root).href)).replace('await load();','const initialLoad=load(); return {initialLoad,load,addIndicator,install,get model(){return model;},get chart(){return chart;},get preparing(){return preparing;}};');
 const state=Function(...Object.keys(args),body)(...Object.values(args));

 const complete=async (index=requests.length-1)=>{const r=requests[index],m=new lib.ChartModel(r.request.options);m.store.setColumns(lib.seededColumns(64));const api=new lib.ChartAPI(m);for(const d of r.request.options.indicators??[])api.addIndicator(d.id,d.name,d.params);for(const s of r.request.options.series??[])m.addSeries(s);r.resolve(m);await Promise.resolve();await Promise.resolve();return m;};
 t.after(async()=>{event(env.window,'pagehide',{persisted:false});await state.initialLoad;await Promise.resolve();for(const fn of cleanup)fn();});
 return {...env,$,state,requests,complete,toolNodes};
}
const dependent=['add-indicator','clear-indicators','series','scale','renderer','stream','load','fit','recent','save','explore','explore-read'];
const commandIds=['series','scale','renderer','clear-indicators','save','load','lock','stream'];
const assertReadiness=(f,ready)=>{for(const id of dependent)assert.equal(f.$(id).disabled,!ready,id);for(const n of f.toolNodes)assert.equal(n.disabled,!ready,n.dataset.tool);for(const id of ['market','count','theme'])assert.equal(f.$(id).disabled,false,id);};
test('main HTML initially disables chart-dependent controls but leaves retry and preferences available',()=>{
 for(const id of dependent){const markup=html.match(new RegExp('<[^>]+\\bid="'+id+'"[^>]*>'))?.[0];assert.ok(markup,id);assert.match(markup,/\bdisabled\b/,id);}
 for(const markup of html.matchAll(/<button\b[^>]*\bdata-tool="[^"]+"[^>]*>/g))assert.match(markup[0],/\bdisabled\b/);
 for(const id of ['market','count','theme'])assert.doesNotMatch(html.match(new RegExp('<[^>]+\\bid="'+id+'"[^>]*>'))[0],/\bdisabled\b/);
});
for(const outcome of ['cancel','failure'])test('first '+outcome+' preserves disabled controls and direct-handler safety, then count change retries',async t=>{
 const f=demo(t);assertReadiness(f,false);for(const id of commandIds)assert.doesNotThrow(()=>{const n=f.$(id);(n.onchange??n.onclick)();},id+' during first preparation');
 if(outcome==='cancel')f.$('cancel-compute').onclick();else f.requests[0].reject(new Error('worker failed'));
 await f.state.initialLoad;assertReadiness(f,false);assert.equal(f.state.chart,undefined);assert.equal(f.$('cancel-compute').hidden,true);assert.equal(f.$('workspace').getAttribute('aria-busy'),'false');
 for(const id of commandIds)assert.doesNotThrow(()=>{const n=f.$(id);(n.onchange??n.onclick)();},id+' after '+outcome);
 assert.doesNotMatch(f.$('status').textContent,/이전 차트는 유지/);if(outcome==='cancel')assert.match(f.$('status').textContent,/시장이나 저장 봉 수/);
 f.$('theme').onclick();f.$('count').value='10000';const retry=f.$('count').onchange();assert.equal(f.requests.length,2);assertReadiness(f,false);await f.complete();await retry;assertReadiness(f,true);assert.equal(f.state.model.theme.background,lib.LIGHT_THEME.background+'ff');
});
test('cancelled replacement retains accepted chart, drawings, control readiness and preferences',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const old=f.state.chart,model=f.state.model;old.api.addDrawing({id:'kept',type:'horizontal',points:[{time:model.store.at(0).time,price:100}]});const before=old.api.saveDrawings();
 f.$('market').value='kr';const loading=f.$('market').onchange();assert.equal(f.$('series').disabled,true);assert.equal(f.$('fit').disabled,false);f.$('cancel-compute').onclick();await loading;
 assert.equal(f.state.chart,old);assert.equal(f.state.model,model);assert.equal(old.disposed,false);assert.equal(old.api.saveDrawings(),before);assert.equal(f.$('market').value,'us');assertReadiness(f,true);assert.match(f.$('status').textContent,/이전 차트는 유지/);
});
test('pending replacement resets explorer pressed state to the new inactive chart',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const work=f.state.load();assert.equal(f.$('explore').disabled,false);f.$('explore').onclick();assert.equal(f.state.chart.dataExploration.active,true);assert.equal(f.$('explore').getAttribute('aria-pressed'),'true');
 await f.complete();await work;assert.equal(f.state.chart.dataExploration.active,false);assert.equal(f.$('explore').getAttribute('aria-pressed'),'false');assert.equal(f.$('explorer-readout').textContent,'Data exploration off.');
 f.$('explore').onclick();assert.equal(f.$('explore').getAttribute('aria-pressed'),'true');key(f.state.chart,'Escape');assert.equal(f.$('explore').getAttribute('aria-pressed'),'false');
});
test('renderer replacement resets explorer pressed state and preserves later Escape synchronization',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;f.$('explore').onclick();const old=f.state.chart;assert.equal(f.$('explore').getAttribute('aria-pressed'),'true');f.$('renderer').onchange();assert.notEqual(f.state.chart,old);assert.equal(old.disposed,true);assert.equal(f.state.chart.dataExploration.active,false);assert.equal(f.$('explore').getAttribute('aria-pressed'),'false');
 f.$('explore').onclick();key(f.state.chart,'Escape');assert.equal(f.$('explore').getAttribute('aria-pressed'),'false');
});
