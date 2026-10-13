import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,seededColumns} from '../src/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';
import {prepareChartModel,recomputeInWorker} from '../src/web/worker.mjs';

function fixture(){
 const store=new BarStore();store.setColumns(seededColumns(32));
 const model=new ChartModel({store}),api=new ChartAPI(model);
 model.indicators.add('e','ema',{period:5});
 model.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});
 model.setVisibleRange(4,20);
 api.addDrawing({id:'keep',type:'text',points:[{time:store.at(4).time,price:12}],text:'keep'});
 return {model,api,event:{kind:'correction',bar:{...store.at(0),volume:1234}}};
}
function transport(){
 const previous=globalThis.Worker,workers=[];
 globalThis.Worker=class {
  constructor(){this.terminations=0;this.posts=0;workers.push(this);}
  postMessage(request){this.posts++;this.request=structuredClone(request);}
  terminate(){this.terminations++;}
  packet(){return computeRequest(this.request);}
  reply(packet){this.onmessage({data:{packet}});}
  async complete(){this.reply(await this.packet());}
 };
 return {workers,restore(){globalThis.Worker=previous;}};
}
function removal(controller,hook){
 const signal=controller.signal,remove=signal.removeEventListener.bind(signal);
 let count=0;
 signal.removeEventListener=(...args)=>{remove(...args);count++;hook();};
 return ()=>count;
}
function state(model){return {bar:model.store.at(0),version:model.store.version,view:{...model.view},follow:model.follow,drawings:model.drawings.save()};}
function assertState(model,expected){assert.deepEqual(state(model),expected);}

for(const mode of ['correction','borrowed-values','copied-values','dispose','indicator']){
 test(`cleanup reentry ${mode} rejects a stale reply and keeps the newer public change`,async()=>{
  const f=transport(),{model,api,event}=fixture(),controller=new AbortController();
  const values=new Float64Array(32).fill(1);
  if(mode.includes('values')){model.addSeries({id:'v',type:'line',panel:'price',values});model.seriesData(model.series.find(s=>s.id==='v'));}
  let after,seriesRevision;
  const removed=removal(controller,()=>{
   if(mode==='correction')api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});
   else if(mode.includes('values')){values.fill(9000);if(mode==='borrowed-values')model.setSeriesValues('v',values);else api.setSeriesValues('v',values);seriesRevision=model.seriesValuesRevision;}
   else if(mode==='dispose')model.dispose();
   else api.addIndicator('new','rsi',{period:7});
   after=state(model);
  });
  try{
   const pending=recomputeInWorker(model,event,{signal:controller.signal});
   await f.workers[0].complete();
   await assert.rejects(pending,/stale/);
   assertState(model,after);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
   if(mode==='correction')assert.equal(model.store.at(0).volume,4321);
   if(mode.includes('values')){
    const series=model.series.find(s=>s.id==='v'),data=model.seriesData(series);
    assert.equal(series.values[0],9000);assert.deepEqual(data.index.query(0,32),{min:9000,max:9000,sum:0});
    assert.equal(model.seriesValuesRevision,seriesRevision);
    if(mode==='borrowed-values')assert.equal(series.values,values);
   }
   if(mode==='dispose')assert.equal(model.disposed,true);
   if(mode==='indicator')assert.equal(model.indicators.entries.has('new'),true);
  }finally{model.dispose();f.restore();}
 });
}

test('removeEventListener property getter is another cleanup reentry boundary',async()=>{
 const f=transport(),{model,api,event}=fixture(),controller=new AbortController(),signal=controller.signal;
 const remove=signal.removeEventListener.bind(signal);let reads=0,removals=0,after;
 Object.defineProperty(signal,'removeEventListener',{get(){reads++;if(f.workers[0]?.terminations){api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});after=state(model);}return (...args)=>{removals++;remove(...args);};}});
 try{const pending=recomputeInWorker(model,event,{signal});await f.workers[0].complete();await assert.rejects(pending,/stale/);assertState(model,after);assert.equal(reads,2);assert.equal(removals,1);assert.equal(f.workers[0].terminations,1);}finally{model.dispose();f.restore();}
});

test('cleanup store replacement with the same version rejects without publishing into the new store',async()=>{
 const f=transport(),{model,event}=fixture(),controller=new AbortController(),source=model.store;
 const replacement=new BarStore(),columns=seededColumns(32);columns.volume[0]=4321;replacement.setColumns(columns);
 assert.equal(replacement.version,source.version);let after;
 const removed=removal(controller,()=>{model.store=replacement;after=state(model);});
 try{const pending=recomputeInWorker(model,event,{signal:controller.signal});await f.workers[0].complete();await assert.rejects(pending,/stale/);assert.equal(model.store,replacement);assertState(model,after);assert.equal(model.store.at(0).volume,4321);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);}finally{model.dispose();f.restore();}
});

test('an aborted getter after removal cannot mutate source after the final stale check',async()=>{
 const f=transport(),{model,api,event}=fixture(),controller=new AbortController(),signal=controller.signal;
 const getAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
 let detached=false,changed=false,after;
 const removed=removal(controller,()=>{detached=true;});
 Object.defineProperty(signal,'aborted',{get(){if(detached&&!changed){changed=true;api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});after=state(model);}return getAborted.call(signal);}});
 try{const pending=recomputeInWorker(model,event,{signal});await f.workers[0].complete();await assert.rejects(pending,/stale/);assert.equal(changed,true);assertState(model,after);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);}finally{model.dispose();f.restore();}
});

for(const mode of ['abort','timeout','cleanup-error']){
 test(`cleanup ${mode} rejects before recompute publication with one removal`,async()=>{
  const f=transport(),{model,event}=fixture(),controller=new AbortController(),before=state(model),error=new Error('cleanup failed');
  const performanceDescriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');let clock=0;
  if(mode==='timeout')Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});
  const removed=removal(controller,()=>{if(mode==='abort')controller.abort();else if(mode==='timeout')clock=1001;else throw error;});
  try{
   const pending=recomputeInWorker(model,event,{signal:controller.signal,timeoutMs:1000});await f.workers[0].complete();
   await assert.rejects(pending,mode==='cleanup-error'?e=>e===error:e=>e.name===(mode==='abort'?'AbortError':'TimeoutError'));
   assertState(model,before);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
  }finally{if(mode==='timeout')Object.defineProperty(globalThis,'performance',performanceDescriptor);model.dispose();f.restore();}
 });
}

for(const mode of ['abort','timeout','cleanup-error','aborted-getter-error']){
 test(`prepare ${mode} during cleanup disposes its unpublished hydrated model`,async()=>{
  const f=transport(),controller=new AbortController(),source=fixture(),error=new Error('cleanup failed'),descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');let clock=0,detached=false;
  if(mode==='timeout')Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});
  const removed=removal(controller,()=>{detached=true;if(mode==='abort')controller.abort();else if(mode==='timeout')clock=1001;else if(mode==='cleanup-error')throw error;});
  if(mode==='aborted-getter-error')Object.defineProperty(controller.signal,'aborted',{get(){if(detached)throw error;return false;}});
  const dispose=ChartModel.prototype.dispose,disposed=[];
  try{
   const pending=prepareChartModel({columns:source.model.store.columns,length:32,options:modelRequest(source.model)},{signal:controller.signal,timeoutMs:1000});
   const packet=await f.workers[0].packet();
   ChartModel.prototype.dispose=function(){disposed.push(this);return dispose.call(this);};
   f.workers[0].reply(packet);
   await assert.rejects(pending,mode.includes('error')?e=>e===error:e=>e.name===(mode==='abort'?'AbortError':'TimeoutError'));
   assert.equal(disposed.length,1);assert.equal(disposed[0].disposed,true);assert.equal(disposed[0].store.listeners.size,0);
   assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
  }finally{ChartModel.prototype.dispose=dispose;if(mode==='timeout')Object.defineProperty(globalThis,'performance',descriptor);source.model.dispose();f.restore();}
 });
}

for(const mode of ['worker-error','abort','timeout']){
 test(`original ${mode} wins over cleanup failure and cleanup runs once`,async()=>{
  const f=transport(),{model,event}=fixture(),controller=new AbortController(),before=state(model),cleanup=new Error('cleanup failed'),descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');let clock=0;
  if(mode==='timeout')Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});
  const removed=removal(controller,()=>{controller.abort();throw cleanup;});
  try{
   const pending=recomputeInWorker(model,event,{signal:controller.signal,timeoutMs:1000});
   if(mode==='worker-error')f.workers[0].onmessage({data:{error:'original worker error'}});
   else if(mode==='abort')controller.abort();
   else{const packet=await f.workers[0].packet();clock=1001;f.workers[0].reply(packet);}
   await assert.rejects(pending,mode==='worker-error'?/original worker error/:e=>e.name===(mode==='abort'?'AbortError':'TimeoutError'));
   assertState(model,before);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
  }finally{if(mode==='timeout')Object.defineProperty(globalThis,'performance',descriptor);model.dispose();f.restore();}
 });
}

test('registration failure keeps its original error if removal reenters and fails',async()=>{
 const f=transport(),{model,api,event}=fixture(),original=new Error('registration failed'),cleanup=new Error('cleanup failed');let removals=0;
 const signal={aborted:false,addEventListener(){throw original;},removeEventListener(){removals++;api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});throw cleanup;}};
 try{await assert.rejects(recomputeInWorker(model,event,{signal}),e=>e===original);assert.equal(model.store.at(0).volume,4321);assert.equal(removals,1);assert.equal(f.workers.length,0);}finally{model.dispose();f.restore();}
});

test('synchronous abort during original signal registration creates no worker and removes once',async()=>{
 const f=transport(),{model,api,event}=fixture(),controller=new AbortController(),signal=controller.signal,add=signal.addEventListener.bind(signal);
 const removed=removal(controller,()=>{});let after;
 signal.addEventListener=(...args)=>{add(...args);api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});after=state(model);controller.abort();};
 try{await assert.rejects(recomputeInWorker(model,event,{signal}),e=>e.name==='AbortError');assertState(model,after);assert.equal(removed(),1);assert.equal(f.workers.length,0);}finally{model.dispose();f.restore();}
});

test('validation progress reentry is stale, while its callback exception is isolated',async()=>{
 const f=transport(),{model,api,event}=fixture(),controller=new AbortController();let after,changes=0;
 const removed=removal(controller,()=>{});
 try{
  const pending=recomputeInWorker(model,event,{signal:controller.signal,onProgress:p=>{if(p.phase==='validation'&&!changes++){api.applyDataEvent({kind:'correction',bar:{...model.store.at(0),volume:4321}});after=state(model);throw new Error('observer failed');}}});
  await f.workers[0].complete();await assert.rejects(pending,/stale/);assertState(model,after);assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
 }finally{model.dispose();f.restore();}
});

test('cleanup may reenter with UI changes and successful publication preserves them',async()=>{
 const f=transport(),{model,api,event}=fixture(),controller=new AbortController();let after;
 const removed=removal(controller,()=>{api.setVisibleRange(2,12);api.editDrawing('keep',{text:'latest'});after={view:{...model.view},follow:model.follow,drawings:model.drawings.save()};});
 try{
  model.store.subscribe(()=>controller.abort());
  const pending=recomputeInWorker(model,event,{signal:controller.signal});await f.workers[0].complete();assert.equal(await pending,model);
  assert.equal(model.store.at(0).volume,1234);assert.deepEqual({view:{...model.view},follow:model.follow,drawings:model.drawings.save()},after);assert.equal(controller.signal.aborted,true);
  assert.equal(removed(),1);assert.equal(f.workers[0].terminations,1);
 }finally{model.dispose();f.restore();}
});
