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
import * as presetHelpers from '../examples/web/demo-layout-preset.mjs';
import * as historyHelpers from '../examples/web/layout-history.mjs';
import {applyLayoutFrame} from '../examples/web/apply-layout-frame.mjs';
import {createLayoutMemory} from '../examples/web/layout-memory.mjs';
import {createIndicatorEditor} from '../examples/web/indicator-editor.mjs';
import {safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
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
 const args={...lib,...layoutHelpers,...presetHelpers,...historyHelpers,applyLayoutFrame,createLayoutMemory,createIndicatorEditor,safeCheckpointStringify,createChart,modelRequest,drawingImportMessage,createDrawingFileImport,prepareChartModel,matchMedia:()=>({matches:false}),setInterval:(fn,delay)=>{const id=++timerSerial;timers.set(id,{fn,delay});return id;},clearInterval:id=>timers.delete(id)};
 const body=src.replace(/^import[^\n]+\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('examples/web/demo.mjs',root).href)).replace('await load();','const initialLoad=load(); return {initialLoad,load,addIndicator,install,importLayoutFile,get layoutHistoryStatus(){return layoutHistory.status();},get model(){return model;},get chart(){return chart;},get preparing(){return preparing;}};');
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

function layoutFile(model){return presetHelpers.stringifyDemoLayout(presetHelpers.captureDemoLayout(model,{market:'us',count:10000,light:false,generatedPanelIds:new Set(['late'])}));}
const settle=async()=>{await Promise.resolve();await Promise.resolve();};
test('layout import rejects invalid and oversized files before creating a worker',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const accepted=f.state.model,count=f.requests.length;let read=false;
 await f.state.importLayoutFile({size:presetHelpers.MAX_DEMO_LAYOUT_BYTES+1,text(){read=true;return Promise.resolve('{}');}});
 assert.equal(read,false);assert.equal(f.requests.length,count);assert.equal(f.state.model,accepted);
 await f.state.importLayoutFile({size:2,text:async()=>'{}'});assert.equal(f.requests.length,count);assert.equal(f.state.model,accepted);assert.equal(f.state.preparing,false);
 accepted.drawings.begin();await f.state.importLayoutFile({size:2,text(){read=true;return Promise.resolve('{}');}});assert.equal(read,false);assert.ok(accepted.drawings.transaction);accepted.drawings.cancel();
});
test('a superseded file read cannot replace a newer installed chart',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const text=layoutFile(f.state.model);let finishRead;
 const reading=f.state.importLayoutFile({size:text.length,text:()=>new Promise(resolve=>{finishRead=resolve;})});
 const loading=f.state.load();const replacement=await f.complete();await loading;
 finishRead(text);await reading;assert.equal(f.state.model,replacement);assert.notEqual(replacement.disposed,true);assert.equal(f.state.preparing,false);
});
test('layout preparation cancellation preserves the accepted chart and drawings',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const accepted=f.state.model,drawings=accepted.drawings,text=layoutFile(accepted);
 const importing=f.state.importLayoutFile({size:text.length,text:async()=>text});await settle();assert.equal(f.requests.length,2);
 f.$('cancel-compute').onclick();await importing;assert.equal(f.state.model,accepted);assert.equal(accepted.drawings,drawings);assert.notEqual(accepted.disposed,true);assert.equal(f.state.preparing,false);
});
test('source changes while importing discard only the prepared candidate',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const accepted=f.state.model,text=layoutFile(accepted),last=accepted.store.at(accepted.store.length-1);
 const importing=f.state.importLayoutFile({size:text.length,text:async()=>text});await settle();accepted.store.upsert({...last,volume:last.volume+1});
 const candidate=await f.complete();await importing;assert.equal(f.state.model,accepted);assert.notEqual(accepted.disposed,true);assert.equal(candidate.disposed,true);assert.equal(accepted.store.at(accepted.store.length-1).volume,last.volume+1);
});
test('a new drawing reference during import is validated before publication',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const accepted=f.state.model;f.state.chart.api.addPanel({id:'late',weight:1});const text=layoutFile(accepted);
 const importing=f.state.importLayoutFile({size:text.length,text:async()=>text});await settle();
 f.state.chart.api.addDrawing({id:'late-reference',type:'horizontal',panel:'late',points:[{time:accepted.store.at(0).time,price:1}]});
 const candidate=await f.complete();await importing;assert.equal(f.state.model,accepted);assert.equal(candidate.disposed,true);assert.ok(accepted.drawings.items.some(d=>d.id==='late-reference'));assert.equal(f.state.preparing,false);
});
test('a layout that cannot project current data leaves the mounted owner intact',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const accepted=f.state.model,oldChart=f.state.chart,preset=presetHelpers.parseDemoLayout(layoutFile(accepted));preset.layout.panels.find(p=>p.id==='volume').scale='log';const text=presetHelpers.stringifyDemoLayout(preset);
 const importing=f.state.importLayoutFile({size:text.length,text:async()=>text});await settle();const candidate=await f.complete();await importing;
 assert.equal(f.state.model,accepted);assert.equal(f.state.chart,oldChart);assert.equal(oldChart.disposed,false);assert.equal(candidate.disposed,true);assert.equal(f.state.preparing,false);
});

test('an explicit retained panel resumes autoscale when a study reuses its temporary domain',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;const before=f.state.model;
 f.state.chart.api.addPanel({id:'notes',weight:1,range:[40,60]});f.state.chart.api.addDrawing({id:'note',type:'horizontal',panel:'notes',points:[{time:before.store.at(0).time,price:50}]});f.state.chart.drawNow();
 const preset=presetHelpers.parseDemoLayout(layoutFile(before));delete preset.layout.panels.find(panel=>panel.id==='notes').range;const text=presetHelpers.stringifyDemoLayout(preset);
 const importing=f.state.importLayoutFile({size:text.length,text:async()=>text});await settle();await f.complete();await importing;
 assert.notEqual(f.state.model,before);assert.deepEqual(f.state.model.panels.find(panel=>panel.id==='notes').range,[40,60]);
 f.$('layout-indicator').value='rsi';f.$('layout-indicator').onchange();f.$('layout-panel').value='notes';f.$('layout-panel').onchange();f.$('layout-axis').value='primary';f.$('layout-axis').onchange();f.$('apply-indicator-placement').onclick();
 assert.equal(f.state.model.series.find(series=>series.indicator==='rsi').panel,'notes');assert.equal(f.state.model.panels.find(panel=>panel.id==='notes').range,undefined);
});

function chooseRSIOverlay(f){
 f.$('layout-indicator').value='rsi';f.$('layout-indicator').onchange();f.$('layout-panel').value='price';f.$('layout-panel').onchange();f.$('layout-axis').value='independent';f.$('layout-axis').onchange();
}

test('nested layout handlers during a placement notification cannot append another command',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;chooseRSIOverlay(f);const api=f.state.chart.api,invalidate=api.invalidate;let nested=0;
 f.$('reorder-panel').value='volume';api.invalidate=()=>{invalidate();if(!nested++){f.$('panel-up').onclick();}};
 f.$('apply-indicator-placement').onclick();api.invalidate=invalidate;
 assert.ok(nested>0);assert.deepEqual(f.state.model.panels.map(panel=>panel.id),['price','volume']);assert.equal(f.state.layoutHistoryStatus.depth,1);
 f.$('layout-undo').onclick();assert.deepEqual(f.state.model.panels.map(panel=>panel.id),['price','volume','rsi']);assert.equal(f.state.model.series.find(series=>series.indicator==='rsi').panel,'rsi');assert.equal(f.state.layoutHistoryStatus.canRedo,true);
});

test('a replacement started during placement excludes staged resources and resets history after acceptance',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;chooseRSIOverlay(f);const api=f.state.chart.api,invalidate=api.invalidate;let loading;
 api.invalidate=()=>{invalidate();if(!loading){f.$('count').value='10000';loading=f.$('count').onchange();}};
 f.$('apply-indicator-placement').onclick();api.invalidate=invalidate;
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].request.options.axes.some(axis=>axis.id==='rsi-axis'),false);
 const replacement=await f.complete();await loading;assert.equal(f.state.model,replacement);assert.equal(replacement.axes.length,0);assert.equal(f.state.layoutHistoryStatus.depth,0);
 chooseRSIOverlay(f);f.$('apply-indicator-placement').onclick();assert.equal(f.state.layoutHistoryStatus.depth,1);f.$('layout-undo').onclick();assert.equal(replacement.series.find(series=>series.indicator==='rsi').panel,'rsi');
});

test('an observer error after partial layout undo rebases history and permits the next command',async t=>{
 const f=demo(t);await f.complete();await f.state.initialLoad;chooseRSIOverlay(f);f.$('apply-indicator-placement').onclick();const model=f.state.model,api=f.state.chart.api,invalidate=api.invalidate,columns=model.store.columns;
 api.addDrawing({id:'kept',type:'horizontal',panel:'price',points:[{time:model.store.at(0).time,price:100}]});const drawings=api.saveDrawings();let notified=false;
 api.invalidate=()=>{invalidate();if(!notified){notified=true;throw new Error('observer failed after publication');}};
 f.$('layout-undo').onclick();api.invalidate=invalidate;
 assert.equal(notified,true);assert.equal(model.store.columns,columns);assert.equal(api.saveDrawings(),drawings);assert.equal(f.state.layoutHistoryStatus.depth,0);assert.match(f.$('indicator-layout-status').textContent,/observer failed/);
 f.$('reorder-panel').value='volume';f.$('panel-up').onclick();assert.equal(f.state.layoutHistoryStatus.depth,1);f.$('layout-undo').onclick();assert.equal(model.panels[0].id,'price');assert.equal(api.saveDrawings(),drawings);
});
