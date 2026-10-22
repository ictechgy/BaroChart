import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {BarStore,ChartModel,DEMO_SYMBOLS,builtinIndicators,demoCalendar,seededColumns} from '../src/core/index.mjs';
import {prepareChartModel} from '../src/web/worker.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
const demoURL=new URL('../examples/web/demo.mjs',import.meta.url),source=await readFile(demoURL,'utf8');
function piece(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);}
const handlers=[piece("$('cancel-compute').onclick=","$('fit').onclick="),piece('function stopStream(){','function sync(){'),piece('function busy(value){','function defaults('),piece('async function load(){','for(const name of builtinIndicators.keys())'),piece('function startStream(){',"$('stream').onclick="),piece("window.addEventListener('resize',layoutPanels);",'await load();')].join('\n').replaceAll('import.meta.url',JSON.stringify(demoURL.href));
function model(){const store=new BarStore();store.setColumns(seededColumns(8));const m=new ChartModel({store});m.symbol=DEMO_SYMBOLS.us;m.addSeries({id:'price',type:'candles',panel:'price'});return m;}
function fixture(t,{initial=true,real=true,hidden=false}={}){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:({market:'us',count:'64',indicator:'ema'})[id]??'',hidden:true,attributes:{},setAttribute(k,v){this.attributes[k]=String(v);}});return nodes.get(id);};
 const events={window:new Map(),document:new Map()},target=name=>({addEventListener(type,fn){events[name].set(type,fn);}});
 const timers=new Map(),jobs=[],requests=[],statuses=[],progress=[],calls={install:0,destroy:0,resize:0,invalidate:0};let timerId=0,resizeHook=null;
 const chartFor=m=>({model:m,disposed:false,destroy(){if(this.disposed)return;this.disposed=true;calls.destroy++;m.dispose();},resize(){calls.resize++;resizeHook?.();},invalidate(){calls.invalidate++;}});
 const current=initial?undefined:model(),ctx={$,model:current,chart:current?chartFor(current):undefined,timer:null,job:0,serial:0,controller:null,preparing:false,pageActive:true,pageClosed:false,resumeInitial:false,loadedMarket:initial?undefined:'us',loadedCount:initial?undefined:8,extras:[],streamIntent:!initial,AbortController,URL,builtinIndicators,modelRequest,demoCalendar,document:{...target('document'),hidden,querySelectorAll:()=>[]},window:target('window'),setInterval(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearInterval(id){timers.delete(id);},statsTimer:999,drawingFileImport:{cancel(){}},status(message){statuses.push(message);},friendly(error){return error.name;},defaults(){return{};},layoutPanels(){}};
 const saved=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 class HeldWorker{constructor(){this.terminated=0;requests.push(this);}postMessage(request){this.request=request;}terminate(){this.terminated++;}}
 if(real)Object.defineProperty(globalThis,'Worker',{configurable:true,writable:true,value:HeldWorker});
 // The extracted handlers run in a VM realm; clone their data at this test-only
 // boundary so same-realm plain-record validation matches the browser module.
 ctx.prepareChartModel=real?((request,options)=>prepareChartModel(structuredClone(request),options)):(request,options)=>new Promise((resolve,reject)=>{requests.push({request,options,resolve,reject});});
 ctx.install=(next,market,count,extras)=>{calls.install++;ctx.chart?.destroy();next.symbol=DEMO_SYMBOLS[market];ctx.model=next;ctx.chart=chartFor(next);ctx.loadedMarket=market;ctx.loadedCount=count;ctx.extras=extras;};
 vm.createContext(ctx);vm.runInContext(handlers+'\nstreamCalendar=demoCalendar("us");',ctx);
 const originalProgress=ctx.progress;ctx.progress=p=>{progress.push(p);return originalProgress(p);};
 for(const name of ['load','addIndicator']){const fn=ctx[name];ctx[name]=()=>{const p=fn();jobs.push(p);return p;};}
 const fire=(target,type,event={})=>events[target].get(type)?.(event);
 t.after(async()=>{ctx.pageClosed=true;ctx.pageActive=false;ctx.job++;ctx.controller?.abort();if(!real)for(const r of requests)r.reject(new DOMException('cleanup','AbortError'));await Promise.allSettled(jobs);ctx.model?.dispose();if(real){if(saved)Object.defineProperty(globalThis,'Worker',saved);else delete globalThis.Worker;}});
 return {ctx,$,jobs,requests,statuses,progress,timers,calls,fire,set resizeHook(fn){resizeHook=fn;},hide(persisted=true){fire('window','pagehide',{persisted});},show(){fire('window','pageshow',{persisted:true});},async complete(index=requests.length-1){const r=requests[index];if(real){const packet=await computeRequest({columns:seededColumns(4),options:r.request.options});r.onmessage({data:{packet}});}else r.resolve(model());await jobs.at(-1);}};
}
for(const order of ['settled-before-resume','resume-before-settled'])test('interrupted first load resumes through real preparation: '+order,async t=>{
 const f=fixture(t),first=f.ctx.load();f.ctx.document.hidden=true;f.hide();assert.equal(f.requests[0].terminated,1);if(order==='settled-before-resume')await first;
 f.ctx.document.hidden=false;f.show();assert.equal(f.requests.length,2);await first;assert.equal(f.ctx.preparing,true);assert.equal(f.$('add-indicator').disabled,true);assert.equal(f.$('cancel-compute').hidden,false);
 await f.complete(1);assert.equal(f.calls.install,1);assert.equal(f.ctx.model.store.length,4);assert.equal(f.ctx.preparing,false);assert.equal(f.ctx.resumeInitial,false);assert.equal(f.requests[1].terminated,1);
});
test('repeated suspended pagehide preserves initial intent and duplicate pageshow does not duplicate work',async t=>{
 const f=fixture(t),first=f.ctx.load();f.hide();f.hide();f.hide();await first;assert.equal(f.ctx.resumeInitial,true);f.show();f.show();assert.equal(f.requests.length,2);await f.complete();f.hide();f.show();assert.equal(f.requests.length,2);assert.equal(f.calls.install,1);
});
test('repeated interrupted initialization resumes once per suspension and ultimately installs',async t=>{
 const f=fixture(t);f.ctx.load();for(let n=0;n<3;n++){f.hide();await f.jobs.at(-1);f.show();assert.equal(f.requests.length,n+2);}await f.complete();assert.equal(f.calls.install,1);
});
for(const order of ['cancel-settled','cancel-pending'])test('explicit initial Cancel is not replayed: '+order,async t=>{
 const f=fixture(t),first=f.ctx.load();f.$('cancel-compute').onclick();if(order==='cancel-settled')await first;f.hide();f.show();await first;for(let n=0;n<3;n++){f.hide();f.show();}assert.equal(f.requests.length,1);assert.equal(f.ctx.model,undefined);assert.equal(f.ctx.resumeInitial,false);
});
test('Cancel on resumed initialization prevents another automatic retry',async t=>{
 const f=fixture(t);f.ctx.load();f.hide();await f.jobs[0];f.show();f.$('cancel-compute').onclick();f.hide();f.show();await f.jobs[1];assert.equal(f.requests.length,2);assert.equal(f.ctx.resumeInitial,false);
});
test('ordinary initial failure is not automatically retried on restoration',async t=>{
 const f=fixture(t),first=f.ctx.load();f.requests[0].onmessage({data:{error:'source failed'}});await first;f.hide();f.show();assert.equal(f.requests.length,1);assert.equal(f.ctx.model,undefined);
});
test('completed initial load is retained rather than replayed',async t=>{
 const f=fixture(t);f.ctx.load();await f.complete();const current=f.ctx.model;f.hide();f.show();assert.equal(f.requests.length,1);assert.equal(f.ctx.model,current);assert.equal(!!current.disposed,false);assert.equal(f.calls.resize,1);
});
for(const operation of ['load','addIndicator'])test('interrupted '+operation+' keeps installed chart/drawings and is not replayed',async t=>{
 const f=fixture(t,{initial:false}),current=f.ctx.model;current.drawings.add({id:'keep',type:'horizontal',panel:'price',points:[{time:0,price:100}]});const drawings=current.drawings.items;f.$('market').value='crypto';f.$('count').value='1000';const pending=f.ctx[operation]();f.hide();await pending;
 assert.equal(f.$('market').value,'us');assert.equal(f.$('count').value,'8');assert.equal(f.ctx.preparing,false);f.show();assert.equal(f.requests.length,1);assert.equal(f.ctx.model,current);assert.equal(current.drawings.items,drawings);assert.equal(!!current.disposed,false);assert.equal(f.calls.install,0);assert.equal(f.timers.size,1);
});
for(const operation of ['load','addIndicator'])test('terminal pagehide cannot restart stream from '+operation+' finally while document is visible',async t=>{
 const f=fixture(t,{initial:false,hidden:false}),current=f.ctx.model,version=current.store.version,pending=f.ctx[operation]();assert.equal(f.requests.length,1);f.hide(false);await pending;assert.equal(f.ctx.pageClosed,true);assert.equal(f.ctx.pageActive,false);assert.equal(f.timers.size,0);assert.equal(current.store.version,version);assert.equal(current.disposed,true);assert.equal(f.calls.destroy,1);f.hide(false);assert.equal(f.calls.destroy,1);
});
test('terminal pagehide clears a pending initialization resume intent',async t=>{
 const f=fixture(t),p=f.ctx.load();f.hide();assert.equal(f.ctx.resumeInitial,true);f.hide(false);await p;assert.equal(f.ctx.resumeInitial,false);assert.equal(f.ctx.pageClosed,true);assert.equal(f.requests.length,1);
});
for(const operation of ['load','addIndicator'])test(operation+' cannot start while suspended or closed',async t=>{
 const f=fixture(t,{initial:false});f.hide();await f.ctx[operation]();assert.equal(f.requests.length,0);f.hide(false);await f.ctx[operation]();assert.equal(f.requests.length,0);
});
for(const state of ['suspended','closed','preparing','hidden','disposed-model','disposed-chart'])test('stream startup refuses '+state, t=>{
 const f=fixture(t,{initial:false});if(state==='suspended')f.ctx.pageActive=false;else if(state==='closed')f.ctx.pageClosed=true;else if(state==='preparing')f.ctx.preparing=true;else if(state==='hidden')f.ctx.document.hidden=true;else if(state==='disposed-model')f.ctx.model.dispose();else f.ctx.chart.disposed=true;f.ctx.startStream();assert.equal(f.timers.size,0);
});
test('visibility cannot resume suspended stream; ordinary visible restoration resumes exactly one timer',t=>{
 const f=fixture(t,{initial:false});f.ctx.startStream();assert.equal(f.timers.size,1);f.hide();f.fire('document','visibilitychange');assert.equal(f.timers.size,0);f.show();assert.equal(f.timers.size,1);f.fire('document','visibilitychange');assert.equal(f.timers.size,1);f.ctx.document.hidden=true;f.fire('document','visibilitychange');assert.equal(f.timers.size,0);f.ctx.document.hidden=false;f.fire('document','visibilitychange');assert.equal(f.timers.size,1);
});
test('stream intent false remains paused across persisted restoration',t=>{
 const f=fixture(t,{initial:false});f.ctx.streamIntent=false;f.hide();f.show();f.fire('document','visibilitychange');assert.equal(f.timers.size,0);
});
test('resize-triggered terminal teardown prevents remaining resume work',t=>{
 const f=fixture(t,{initial:false});f.hide();f.resizeHook=()=>f.hide(false);f.show();assert.equal(f.ctx.pageClosed,true);assert.equal(f.calls.invalidate,0);assert.equal(f.timers.size,0);
});
for(const outcome of ['resolve','reject'])test('obsolete '+outcome+' cannot clear resumed busy state or status',async t=>{
 const f=fixture(t,{real:false}),first=f.ctx.load();f.hide();f.show();assert.equal(f.requests.length,2);const status=[...f.statuses];let stale;
 if(outcome==='resolve'){stale=model();f.requests[0].resolve(stale);}else f.requests[0].reject(new Error('old failure'));await first;assert.equal(f.ctx.preparing,true);assert.deepEqual(f.statuses,status);assert.equal(f.calls.install,0);if(stale)assert.equal(stale.disposed,true);await f.complete(1);assert.equal(f.calls.install,1);
});
for(const operation of ['load','addIndicator'])test('obsolete '+operation+' progress cannot replace newer status',async t=>{
 const f=fixture(t,{initial:operation==='load',real:false}),old=f.ctx[operation](),previous=f.requests[0];previous.options.onProgress({phase:'data',done:1,total:2});assert.equal(f.progress.length,1);f.hide();const messages=[...f.statuses];previous.options.onProgress({phase:'data',done:2,total:2});assert.deepEqual(f.statuses,messages);f.show();previous.options.onProgress({phase:'data',done:2,total:2});assert.equal(f.progress.length,1);previous.reject(new Error('old'));await old;
});
