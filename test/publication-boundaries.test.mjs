import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {watchdog} from './helpers/calculation-deadline-fixture.mjs';
import {BarStore,ChartModel,ChartAPI,InteractionController,createLayout,seededColumns} from '../src/core/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {installRecomputed,modelRequest} from '../src/web/worker-state.mjs';
import {prepareChartModel,recomputeInWorker} from '../src/web/worker.mjs';
const T=1700000000000;
function drawingFixture(){
 const store=new BarStore(Array.from({length:12},(_,i)=>({time:T+i*60000,open:100,high:120,low:90,close:110,volume:1})));
 const model=new ChartModel({store,panels:[{id:'price',range:[80,120],padding:0},{id:'other',range:[0,100],axisSide:'left'}],axes:[{id:'A',panel:'price',range:[1000,5000],padding:0,width:80},{id:'B',panel:'price',range:[0,100],padding:0,width:80}]});model.view={from:0,to:12};
 const input=new InteractionController(model,()=>({width:1000,height:500})),api=new ChartAPI(model,{controller:input});api.addDrawing({id:'d',type:'horizontal',panel:'price',axisId:'A',points:[{time:T+120000,price:3000}]});const p=createLayout(model,1000,500).toScreen(model.drawings.items[0].points[0],'price','A');input.down(1,p.x+60,p.y);assert.equal(input.gesture.handle,-1);return {model,input,api,p};
}
const drawingState=x=>JSON.stringify({state:x.api.inspect(),transaction:x.model.drawings.transaction,undo:x.model.drawings.undoStack,redo:x.model.drawings.redoStack});
for(const [name,change] of [
 ['unreferenced axis width',x=>x.api.setAxis('B',{width:160})],
 ['unreferenced axis side',x=>x.api.setAxis('B',{side:'left'})],
 ['unreferenced axis visibility',x=>x.api.setAxis('B',{visible:false})],
 ['unreferenced visible axis removal',x=>x.api.removeAxis('B')],
 ['visible axis addition',x=>x.api.addAxis({id:'C',panel:'price',width:80})],
 ['other panel axis visibility',x=>x.api.setPanel('other',{axisVisible:false})],
 ['other panel axis side',x=>x.api.setPanel('other',{axisSide:'right'})],
 ['panel addition',x=>x.api.addPanel({id:'new',axisVisible:false})]
])test(name+' cannot move the global plot during a drawing transaction',()=>{
 const x=drawingFixture();try{const before=drawingState(x),anchors=x.model.drawings.items[0].points;assert.throws(()=>change(x),/transaction|gesture/);assert.equal(drawingState(x),before);x.input.move(1,x.p.x+60,x.p.y);assert.deepEqual(x.model.drawings.items[0].points,anchors);}finally{x.input.cancel();x.model.dispose();}
});
test('unrelated range, label and hidden-axis ownership changes preserve pointer geometry',()=>{
 const x=drawingFixture();try{const anchors=x.model.drawings.items[0].points;x.api.setAxis('B',{range:[0,200],width:80});x.api.setPanel('other',{label:'updated'});x.api.addAxis({id:'hidden',panel:'price',visible:false});x.api.removeAxis('hidden');x.input.move(1,x.p.x+60,x.p.y);assert.deepEqual(x.model.drawings.items[0].points,anchors);x.input.cancel();assert.doesNotThrow(()=>x.api.removeAxis('B'));assert.doesNotThrow(()=>x.api.addPanel({id:'new'}));}finally{x.model.dispose();}
});
for(const [name,change] of [['zoom',x=>x.api.zoom(.9)],['pan',x=>x.api.pan(-1)],['fit',x=>x.api.fit()],['visible range',x=>x.api.setVisibleRange(-.5,9.5)]])
test(name+' reprojection cancels the next drawing move without shifting committed anchors',()=>{
 const x=drawingFixture();try{const anchors=x.model.drawings.transaction[0].points;x.input.move(1,x.p.x+65,x.p.y);change(x);const view={...x.model.view};x.input.move(1,x.p.x+65,x.p.y);assert.equal(x.input.gesture,null);assert.equal(x.input.pointers.size,0);assert.equal(x.model.drawings.transaction,null);assert.deepEqual(x.model.drawings.items[0].points,anchors);assert.deepEqual(x.model.view,view);}finally{x.input.cancel();x.model.dispose();}
});
test('removing an unrelated series with an unchanged drawing projection retains the edit',()=>{
 const x=drawingFixture();try{x.input.cancel();x.api.addSeries({id:'other-line',type:'line',panel:'other',values:new Float64Array(12).fill(50)});x.input.down(1,x.p.x+60,x.p.y);x.api.removeSeries('other-line');x.input.move(1,x.p.x+60,x.p.y);assert.equal(x.input.gesture.kind,'edit');assert.deepEqual(x.model.drawings.items[0].points,x.model.drawings.transaction[0].points);}finally{x.input.cancel();x.model.dispose();}
});
function modelFixture(){const store=new BarStore();store.setColumns(seededColumns(16));const model=new ChartModel({store});model.addSeries({id:'f',type:'line',panel:'price',values:Float64Array.from({length:16},(_,i)=>i+1)});model.addSeries({id:'control',type:'line',panel:'price',source:'close'});createLayout(model,800,600);return model;}
for(const sameBuffer of [false,true])test('publication retains observer series invalidation with '+(sameBuffer?'same borrowed buffer':'new API values'),async()=>{
 const model=modelFixture(),api=new ChartAPI(model);try{const event={kind:'correction',bar:{...model.store.at(0),volume:999}},expected=modelRequest(model),packet=await computeRequest({columns:model.store.columns,length:model.store.length,event,options:expected});let called=false;
  const unsubscribe=model.store.subscribe(()=>{if(called)return;called=true;if(sameBuffer){const s=model.series[0];s.values.fill(1000);model.setSeriesValues('f',s.values);}else api.setSeriesValues('f',new Float64Array(16).fill(1000));});
  installRecomputed(model,packet,event,expected);unsubscribe();assert(called);assert.equal(model.series[1].dirtyFrom,Infinity,'unchanged prepared cache remains clean');const data=model.seriesData(model.series[0]),range=data.index.query(0,16);assert.equal(range.min,1000);assert.equal(range.max,1000);assert.equal(data.values[0],1000);
 }finally{model.dispose();}
});
async function registrationProbe(script, method) {
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc']});
 const messages=[];let stderr='',ready;
 const started=new Promise(resolve=>{ready=resolve;});
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-32768);});
 child.on('message',message=>{messages.push(message);if(message?.phase==='ready')ready();});
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
 try{
  // These infrastructure watchdogs allow process/module startup under a loaded
  // suite. Neither changes the operation's separately verified 5 ms deadline.
  await watchdog(Promise.race([started,closed.then(result=>{throw new Error(`${method} exited before ready: ${JSON.stringify(result)} ${stderr}`);})]),method+' subprocess startup');
  child.send({phase:'run'});
  const result=await watchdog(closed,method+' subprocess completion');
  assert.equal(result.status,0,`${method}: ${JSON.stringify(result)} ${stderr}`);
  assert.deepEqual(messages.map(message=>message.phase),['ready','result']);
  return messages[1].result;
 }finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await closed.catch(()=>{});
 }
}
for(const method of ['prepareChartModel','recomputeInWorker'])test(method+' registration failure removes the listener and cancels the timer without an unhandled rejection',async()=>{
 const moduleURL=new URL('../src/web/worker.mjs',import.meta.url).href,coreURL=new URL('../src/core/index.mjs',import.meta.url).href;
 const script=`
import {${method}} from ${JSON.stringify(moduleURL)};
import {ChartModel} from ${JSON.stringify(coreURL)};
let created=0,removed=0;
globalThis.Worker=class{constructor(){created++;}};
const unhandled=[];
process.on('unhandledRejection',e=>unhandled.push(e.message));
const signal={aborted:false,addEventListener(){throw new Error('registration failed');},removeEventListener(){removed++;}};
const model=new ChartModel();
process.send({phase:'ready'});
await new Promise(resolve=>process.once('message',message=>{if(message?.phase!=='run')throw new Error('Expected run handshake');resolve();}));
const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout,handles=new Set(),deadlines=[];
globalThis.setTimeout=(callback,ms,...args)=>{deadlines.push(ms);const handle=originalSetTimeout(callback,ms,...args);handles.add(handle);return handle;};
globalThis.clearTimeout=handle=>{handles.delete(handle);return originalClearTimeout(handle);};
let error;
try{await ${method}(${method==='prepareChartModel'?'{}':"model,{kind:'correction',bar:{time:1}}"},{signal,timeoutMs:5});}catch(e){error=e.message;}
globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
await new Promise(resolve=>setTimeout(resolve,20));
model.dispose();
process.send({phase:'result',result:{created,removed,unhandled,error,deadlines,retainedTimers:handles.size}},()=>process.disconnect());
`;
 assert.deepEqual(await registrationProbe(script,method),{created:0,removed:1,unhandled:[],error:'registration failed',deadlines:[5],retainedTimers:0});
});
function workers(error){const previous=globalThis.Worker,list=[];globalThis.Worker=class{constructor(){this.terminated=0;list.push(this);}postMessage(request){if(error)throw error;computeRequest(request).then(packet=>this.onmessage({data:{packet}}),e=>this.onerror({message:e.message}));}terminate(){this.terminated++;}};return {list,restore:()=>{globalThis.Worker=previous;}};}
for(const mode of ['prepare','recompute'])for(const failCalculation of [false,true])test(mode+' signal removal failure preserves the operation cause and source model',async()=>{
 const model=modelFixture(),before=JSON.stringify(model.store.at(0)),version=model.store.version,operationError=new Error('posting failed'),cleanupError=new Error('signal removal failed'),f=workers(failCalculation?operationError:null);let removed=0;
 const signal={aborted:false,addEventListener(){},removeEventListener(){removed++;throw cleanupError;}};
 try{const pending=mode==='prepare'?prepareChartModel({columns:seededColumns(16),options:{}},{signal}):recomputeInWorker(model,{kind:'correction',bar:{...model.store.at(0),volume:999}},{signal});await assert.rejects(pending,e=>e===(failCalculation?operationError:cleanupError));assert.equal(removed,1);assert.equal(f.list.length,1);assert.equal(f.list[0].terminated,1);assert.equal(JSON.stringify(model.store.at(0)),before);assert.equal(model.store.version,version);}finally{f.restore();model.dispose();}
});
test('high-level abort during signal registration never allocates a worker',async()=>{
 const f=workers();let removed=0;const signal={aborted:false,addEventListener(_name,cancel){this.aborted=true;cancel();},removeEventListener(){removed++;}};
 try{await assert.rejects(prepareChartModel({}, {signal}),e=>e.name==='AbortError');assert.equal(f.list.length,0);assert.equal(removed,1);}finally{f.restore();}
});
