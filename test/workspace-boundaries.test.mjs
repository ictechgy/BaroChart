import test from 'node:test';import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,saveWorkspace,prepareWorkspaceAsync} from '../src/index.mjs';
import {computeWorkspaceRequest} from '../src/web/workspace-worker.mjs';
import {readWorkspaceDocument,workspaceSnapshot,WORKSPACE_CHARS} from '../src/core/workspace.mjs';
import {calculationJobStats} from '../src/web/calculation-job.mjs';
import {withCalculationDeadline} from './helpers/calculation-deadline-fixture.mjs';
const binding={key:'feed',revision:'1',adjustmentVersion:'1',priceUnit:'USD',adjustment:'raw'};
function setup(){const store=new BarStore();store.setData(Array.from({length:300},(_,i)=>({time:i,open:i+1,high:i+2,low:i,close:i+1,volume:1})));const model=new ChartModel({store}),api=new ChartAPI(model);api.addIndicator('e','ema',{period:5});api.addIndicator('s','sma',{period:5});api.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});return {store,model,api,text:saveWorkspace(api,binding)};}
function factory(mutate=()=>{},terminate=()=>{}){return ()=>({postMessage(request,transfer){const packet=computeWorkspaceRequest(structuredClone(request,{transfer}));mutate(packet);queueMicrotask(()=>this.onmessage?.({data:packet}));},terminate});}
const attacks={
 'job':p=>p.jobId++,'kind':p=>p.kind='indicator-params','version':p=>p.version++,
 'entry missing':p=>p.entries.pop(),'duplicate entry':p=>p.entries[1]=p.entries[0],
 'cross-entry output alias':p=>p.entries[1].result.arrays[0]=p.entries[0].result.arrays[0],
 'cross-entry checkpoint alias':p=>p.entries[1].result.checkpoints=p.entries[0].result.checkpoints,
 'packet accessor':p=>Object.defineProperty(p,'entries',{get(){throw new Error('getter executed');},enumerable:true}),
 'nested accessor':p=>Object.defineProperty(p.entries[0].result,'checkpoints',{get(){throw new Error('getter executed');},enumerable:true}),
 'nonfinite output':p=>p.entries[0].result.arrays[0][10]=Infinity,
 'output capacity':p=>p.entries[0].result.arrays[0]=new Float64Array(300),
 'missing checkpoint':p=>p.entries[0].result.checkpoints.indices=new Uint32Array(0),
 'shared checkpoint':p=>p.entries[0].result.checkpoints.bytes=new Uint8Array(new SharedArrayBuffer(5)),
 'bad offset':p=>p.entries[0].result.plotOffsets.value=5,
 'wrong source length':p=>p.entries[0].binding.length=2,
 'wrong parameters':p=>p.entries[0].binding.params.period=6,
};
for(const [label,mutate] of Object.entries(attacks))test('workspace rejects hostile '+label+' with listener/budget cleanup',async()=>{const {store,model,text}=setup(),listeners=store.listeners.size,entries=model.indicators.entries;await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(mutate)}));assert.equal(store.listeners.size,listeners);assert.equal(model.indicators.entries,entries);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});model.dispose();});
test('workspace preabort runs no binding getter or worker',async()=>{const controller=new AbortController();controller.abort();let reads=0;await assert.rejects(prepareWorkspaceAsync(null,'',{signal:controller.signal,get datasetBinding(){reads++;throw Error();},workerFactory(){reads++;throw Error();}}),{name:'AbortError'});assert.equal(reads,0);});
for(const phase of ['snapshot','compute','validate'])test('workspace progress abort '+phase+' cleans listeners and caller buffers',async()=>{const {store,model,text}=setup(),controller=new AbortController(),columns=store.columns,listeners=store.listeners.size;await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,signal:controller.signal,workerFactory:factory(),onProgress:p=>{if(p.phase===phase)controller.abort();}}),{name:'AbortError'});assert.equal(store.listeners.size,listeners);assert.equal(store.columns,columns);assert.ok(columns.close.byteLength);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});model.dispose();});
for(const phase of ['snapshot','compute','validate'])test('workspace managed mutation '+phase+' rejects stale',async()=>{const {store,model,text}=setup(),listeners=store.listeners.size;let changed=false;await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(),onProgress:p=>{if(!changed&&p.phase===phase){changed=true;store.update(299,{time:299,open:5,high:6,low:4,close:5,volume:1});}}}),{name:'StaleSourceError'});assert.equal(store.listeners.size,listeners);model.dispose();});
test('workspace candidate disposed after terminate callback updates shared source',async()=>{const {store,model,text}=setup(),listeners=store.listeners.size;await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(()=>{},()=>store.update(299,{time:299,open:5,high:6,low:4,close:5,volume:1}))}),{name:'StaleSourceError'});assert.equal(store.listeners.size,listeners);assert.equal(store.at(299).close,5);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});model.dispose();});
test('workspace candidate disposed when final signal accessor mutates store',async()=>{const {store,model,text}=setup(),listeners=store.listeners.size,controller=new AbortController();let armed=false;Object.defineProperty(controller.signal,'aborted',{get(){if(armed){armed=false;store.update(299,{time:299,open:5,high:6,low:4,close:5,volume:1});}return false;}});await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,signal:controller.signal,workerFactory:factory(()=>{},()=>{armed=true;})}),{name:'StaleSourceError'});assert.equal(store.listeners.size,listeners);model.dispose();});
test('workspace progress callback errors do not corrupt successful publication',async()=>{const {store,model,text}=setup(),listeners=store.listeners.size;const next=await prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(),onProgress(){throw new Error('observer');}});assert.equal(store.listeners.size,listeners+2);next.dispose();assert.equal(store.listeners.size,listeners);model.dispose();});
test('workspace text both byte and character ceilings precede parsing',()=>{assert.throws(()=>readWorkspaceDocument(' '.repeat(WORKSPACE_CHARS+1)),/limit/);assert.throws(()=>readWorkspaceDocument('界'.repeat(1400000)),/byte limit/);});
test('workspace snapshot rejects accessor without reading, functions, sparse arrays, prototype fields and invalid Unicode',()=>{let reads=0;const value={get x(){reads++;return 1;}};assert.throws(()=>workspaceSnapshot(value));assert.equal(reads,0);for(const v of [{f(){}},Array(1),JSON.parse('{"__proto__":1}'),{x:'\ud800'},{x:undefined},{x:Infinity},{x:NaN},{toJSON(){return {};}}])assert.throws(()=>workspaceSnapshot(v));});
test('workspace snapshot preserves negative zero, null and nested data',()=>{const input={x:-0,a:[null,1,'é😀']},copy=workspaceSnapshot(input);assert.ok(Object.is(copy.x,-0));assert.deepEqual(copy,input);assert.notEqual(copy.a,input.a);});
const docAttacks={
 'schema':d=>d.schema='wrong','version':d=>d.version=2,'extra field':d=>d.extra=true,
 'null params':d=>d.indicators[0].params=null,'duplicate studies':d=>d.indicators.push(d.indicators[0]),
 'missing panel':d=>d.series[0].panel='none','missing study':d=>d.series[0].indicator='none',
 'external values':d=>d.series[0].values=[],'custom format':d=>d.chart.formatters='custom',
 'source endpoint':d=>d.source.lastTime=100,'output mismatch':d=>d.indicators[0].outputs=['wrong'],
 'plot offset':d=>d.indicators[0].plotOffsets.value=7,'unlinked module':d=>d.indicators[0].module={id:'x',version:1,stateVersion:1,causal:true,exportName:'e'},
};
for(const [label,mutate] of Object.entries(docAttacks))test('workspace document rejects '+label+' without touching existing model',async()=>{const {store,model,text}=setup(),doc=JSON.parse(text),listeners=store.listeners.size;mutate(doc);await assert.rejects(prepareWorkspaceAsync(store,JSON.stringify(doc),{datasetBinding:binding,workerFactory:factory()}));assert.equal(store.listeners.size,listeners);model.dispose();});
test('workspace repeated post-dispatch timeout drains reservations and worker ownership',async()=>{
 const {store,model,text}=setup(),listeners=store.listeners.size,workers=[];
 try{
  for(let i=0;i<3;i++)await withCalculationDeadline(20,async clock=>{
   await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,timeoutMs:20,workerFactory:()=>{
    const worker={posts:0,terminated:0,postMessage(){this.posts++;queueMicrotask(()=>clock.expire());},terminate(){this.terminated++;}};
    workers.push(worker);return worker;
   }}),{name:'TimeoutError'});
   assert.equal(workers.length,i+1,'each operation reaches Worker creation before its deadline');
   assert.equal(workers[i].posts,1);assert.equal(workers[i].terminated,1);
   assert.equal(workers[i].onmessage,null);assert.equal(workers[i].onerror,null);
   assert.equal(store.listeners.size,listeners);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});
  });
  assert.equal(workers.length,3);
 }finally{model.dispose();}
});
test('workspace preflight deadline expires without creating a Worker',async()=>{
 const {store,model,text}=setup(),listeners=store.listeners.size;let expired=false,workers=0;
 try{
  await withCalculationDeadline(20,async clock=>{
   await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,timeoutMs:20,
    onProgress(progress){if(!expired&&progress.phase==='snapshot'){expired=true;clock.expire();}},
    workerFactory(){workers++;throw new Error('Expired preflight must not create a Worker');},
   }),{name:'TimeoutError'});
   assert.equal(expired,true);assert.equal(workers,0);
   assert.equal(store.listeners.size,listeners);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});
  });
 }finally{model.dispose();}
});
test('workspace sums all indicator output capacity before starting Worker',async()=>{const store=new BarStore();store.setData(Array.from({length:32769},(_,i)=>({time:i,open:1,high:1,low:1,close:1,volume:1})));const model=new ChartModel({store}),api=new ChartAPI(model);for(let i=0;i<128;i++)api.addIndicator('e'+i,'ema',{period:2});let workers=0;await assert.rejects(prepareWorkspaceAsync(store,saveWorkspace(api,binding),{datasetBinding:binding,workerFactory(){workers++;throw Error('must not create');}}),/budget/);assert.equal(workers,0);assert.equal(store.listeners.size,2);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});model.dispose();});
test('workspace aggregate checkpoint ceiling rejects before owned output copies',async()=>{const {store,model,text}=setup();await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(p=>{for(const e of p.entries)e.result.checkpoints.bytes=new Uint8Array(17*1024*1024);})}),/Workspace checkpoint byte limit/);assert.equal(store.listeners.size,2);model.dispose();});
test('workspace shared inflight two-job ceiling cleans both cancelled jobs',async()=>{const {store,model,text}=setup(),a=new AbortController(),b=new AbortController();let created=0;const workerFactory=()=>{created++;return {postMessage(){},terminate(){}};};const p=prepareWorkspaceAsync(store,text,{datasetBinding:binding,signal:a.signal,workerFactory}),q=prepareWorkspaceAsync(store,text,{datasetBinding:binding,signal:b.signal,workerFactory});const settled=Promise.allSettled([p,q]);await assert.rejects(prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory}),/budget/);a.abort();b.abort();assert.ok((await settled).every(x=>x.status==='rejected'&&x.reason.name==='AbortError'));assert.ok(created<=2);assert.equal(store.listeners.size,2);assert.deepEqual(calculationJobStats(),{activeJobs:0,reservedBytes:0});model.dispose();});
test('workspace validation progress is aggregate and monotonic across entries',async()=>{const {store,model,text}=setup(),progress=[];const next=await prepareWorkspaceAsync(store,text,{datasetBinding:binding,workerFactory:factory(),onProgress:p=>{if(p.phase==='validate')progress.push(p);}});assert.ok(progress.length>2);assert.ok(progress.every((p,i)=>p.total===progress[0].total&&(!i||p.done>=progress[i-1].done)));assert.equal(progress.at(-1).done,progress.at(-1).total);next.dispose();model.dispose();});
