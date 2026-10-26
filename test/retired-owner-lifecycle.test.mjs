import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {BarStore} from '../src/core/data.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {InteractionController} from '../src/core/interaction.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';
import {setIndicatorParamsAsync} from '../src/web/indicator-params-async.mjs';
import {computeIndicatorParamsRequest} from '../src/web/indicator-params-worker.mjs';

const size=()=>({width:400,height:240});
const drawing=id=>({id,type:'horizontal',panel:'price',points:[{time:0,price:1}]});
const journalState=drawings=>({
  items:drawings.items,
  undo:drawings.undoStack,
  redo:drawings.redoStack,
  selected:drawings.selected,
  transaction:drawings.transaction,
  serial:drawings.serial,
});

test('disposed standalone API and controller cannot mutate a transferred drawing journal',t=>{
  const oldModel=new ChartModel(),oldNotices=[];
  const oldController=new InteractionController(oldModel,size,kind=>oldNotices.push(kind));
  const oldAPI=new ChartAPI(oldModel,{controller:oldController,invalidate:kind=>oldNotices.push(kind)});
  oldAPI.addDrawing(drawing('kept'));
  const nextModel=new ChartModel({store:oldModel.store}),nextAPI=new ChartAPI(nextModel);
  nextModel.drawings=oldModel.drawings;
  t.after(()=>nextModel.dispose());
  oldModel.dispose();
  const before=journalState(nextModel.drawings),noticeCount=oldNotices.length;

  assert.throws(()=>oldAPI.addDrawing(drawing('late')),/disposed/i);
  assert.throws(()=>oldController.key('z',{ctrl:true}),/disposed/i);
  assert.deepEqual(journalState(nextModel.drawings),before);
  assert.equal(oldNotices.length,noticeCount);

  nextAPI.addDrawing(drawing('fresh'));
  assert.deepEqual(nextModel.drawings.items.map(({id})=>id),['kept','fresh']);
  assert.equal(nextModel.store.length,0);
});

test('facade and interaction constructors reject an already disposed model',()=>{
  const model=new ChartModel();model.dispose();
  assert.equal(ChartAPI.length,1);assert.equal(InteractionController.length,2);
  assert.throws(()=>new ChartAPI(model),/disposed/i);
  assert.throws(()=>new InteractionController(model,size),/disposed/i);
});

test('owner guard seams preserve public mutator arity',()=>{
  const api={compactData:1,setData:1,applyDataEvent:1,applyDataEvents:1,configureDataIngestion:1,enqueueDataEvents:1,loadDataIngestion:1,addPanel:1,setPanel:2,setPanelOrder:1,removePanel:1,addAxis:1,setAxis:2,addSeries:1,addIndicator:2,setIndicatorParams:2,setIndicatorPlacement:2,loadStudies:1,duplicateDrawing:2,duplicateDrawings:2,setDrawingVisibility:2,setDrawingsVisibility:2,setDrawingsStyle:2,deleteDrawings:1,translateDrawings:2};
  for(const [name,arity] of Object.entries(api))assert.equal(ChartAPI.prototype[name].length,arity,name);
  const model={addPanel:1,setPanel:2,setPanelOrder:1,removePanel:1,addAxis:1,setAxis:2,addSeries:1};
  for(const [name,arity] of Object.entries(model))assert.equal(ChartModel.prototype[name].length,arity,name);
  assert.equal(setIndicatorParamsAsync.length,3);
});

function chartEnvironment(t,{resize=false}={}){
  const keys=['document','requestAnimationFrame','cancelAnimationFrame','ResizeObserver'];
  const saved=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const frames=new Map(),canvases=[];let frameId=0,disconnects=0;
  class Context {setTransform(){} clearRect(){} fillRect(){} drawImage(){}}
  class Canvas extends EventTarget {
    constructor(){super();this.style={};this.width=0;this.height=0;this.context=new Context();this.listenerCount=0;canvases.push(this);}
    setAttribute(){}
    getContext(){return this.context;}
    addEventListener(...args){this.listenerCount++;return super.addEventListener(...args);}
    removeEventListener(...args){this.listenerCount--;return super.removeEventListener(...args);}
    cloneNode(){return new Canvas();}
    replaceWith(next){this.removed=true;this.replacement=next;}
    remove(){this.removed=true;}
  }
  class Observer {constructor(callback){this.callback=callback;}observe(){this.observed=true;}disconnect(){if(!this.disconnected){this.disconnected=true;disconnects++;}}}
  const globals={
    document:{createElement:()=>new Canvas()},
    requestAnimationFrame:callback=>{const id=++frameId;frames.set(id,callback);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:Observer,
  };
  for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:globals[key]});
  const container={clientWidth:400,clientHeight:240,children:[],append(node){this.children.push(node);}};
  t.after(()=>{frames.clear();for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {container,frames,canvases,resize,get disconnects(){return disconnects;}};
}

const bars=()=>[
  {time:1,open:10,high:12,low:9,close:11,volume:2},
  {time:2,open:11,high:13,low:10,close:12,volume:3},
  {time:3,open:12,high:14,low:11,close:13,volume:4},
];
function ownedChart(t,{data=[]}={}){
  const env=chartEnvironment(t),model=new ChartModel({store:new BarStore(data)});
  const chart=new CanvasChart(env.container,model,{dpr:()=>1,interactive:false,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})});
  t.after(()=>{chart.destroy();model.dispose();});
  return {chart,model,api:chart.api};
}
function retiringProxy(chart,target){return new Proxy(target,{ownKeys(value){chart.destroy();return Reflect.ownKeys(value);}});}

test('input snapshot callbacks cannot commit through a retired chart owner',t=>{
  {
    const {chart,model,api}=ownedChart(t),before=model.panels.slice();
    assert.throws(()=>api.addPanel(retiringProxy(chart,{id:'late',weight:1})),/disposed|retired/i);
    assert.deepEqual(model.panels,before);
  }
  {
    const {chart,model,api}=ownedChart(t),before=model.axes.slice();
    assert.throws(()=>api.addAxis(retiringProxy(chart,{id:'late',panel:'price'})),/disposed|retired/i);
    assert.deepEqual(model.axes,before);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()}),before=model.store.at(0),beforeLength=model.store.length;
    const bar={get time(){chart.destroy();return 5;},open:20,high:22,low:19,close:21,volume:5};
    assert.throws(()=>api.setData([bar]),/disposed|retired/i);
    assert.equal(model.store.length,beforeLength);assert.deepEqual(model.store.at(0),before);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()}),before=model.store.at(2);
    const bar={get time(){chart.destroy();return 3;},open:20,high:22,low:19,close:21,volume:5};
    assert.throws(()=>api.applyDataEvent({kind:'update',bar}),/disposed|retired/i);
    assert.deepEqual(model.store.at(2),before);
  }
});

test('observer retirement after data commit preserves the successful outcome',t=>{
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});const replacement=[{time:10,open:20,high:22,low:19,close:21,volume:5}];model.store.subscribe(()=>chart.destroy());
    assert.equal(api.setData(replacement),undefined);assert.equal(chart.disposed,true);assert.equal(model.store.length,1);assert.deepEqual(model.store.at(0),replacement[0]);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()}),replacement={time:3,open:20,high:22,low:19,close:21,volume:5};model.store.subscribe(()=>chart.destroy());
    assert.equal(api.applyDataEvent({kind:'update',bar:replacement}),undefined);assert.equal(chart.disposed,true);assert.deepEqual(model.store.at(2),replacement);
  }
});

test('indicator and layout snapshots cannot publish after retiring their API owner',t=>{
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});
    assert.throws(()=>api.addIndicator('late','ema',retiringProxy(chart,{period:2})),/disposed|retired/i);
    assert.equal(model.indicators.entries.has('late'),false);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});api.addIndicator('e','ema',{period:2});const before=model.indicators.entries.get('e');
    assert.throws(()=>api.setIndicatorParams('e',retiringProxy(chart,{period:3})),/disposed|retired/i);
    assert.equal(model.indicators.entries.get('e'),before);
  }
  {
    const {chart,model,api}=ownedChart(t);api.addPanel({id:'second',weight:1});const before=model.panels.slice();
    assert.throws(()=>api.setPanelOrder(retiringProxy(chart,['second','price'])),/disposed|retired/i);
    assert.deepEqual(model.panels,before);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});api.addPanel({id:'second',weight:1});api.addIndicator('e','ema',{period:2});api.addSeries({id:'line',type:'line',panel:'price',indicator:'e'});const before=model.series[0];
    assert.throws(()=>api.setIndicatorPlacement('e',retiringProxy(chart,{panel:'second',axisId:null})),/disposed|retired/i);
    assert.equal(model.series[0],before);assert.equal(before.panel,'price');
  }
  {
    const {chart,model,api}=ownedChart(t);api.addDrawing(drawing('kept'));const before=journalState(model.drawings);
    assert.throws(()=>api.deleteDrawings(retiringProxy(chart,['kept'])),/disposed|retired/i);
    assert.deepEqual(journalState(model.drawings),before);
  }
  {
    const {chart,model,api}=ownedChart(t);api.addSeries({id:'line',type:'line',panel:'price'});const before=model.series[0];let reflections=0;
    const patch=new Proxy({color:'red'},{ownKeys(target){if(++reflections===2)chart.destroy();return Reflect.ownKeys(target);}});
    assert.throws(()=>api.setSeries('line',patch),/disposed|retired/i);assert.equal(model.series[0],before);
  }
});

test('registered calculation callbacks cannot publish through a retired API owner',t=>{
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});
    api.registerIndicator('retiring-add',()=>{chart.destroy();return {outputs:['value'],create:()=>({step:bar=>[bar.close],snapshot:()=>({}),restore(){}})};});
    assert.throws(()=>api.addIndicator('late','retiring-add',{}),/disposed|retired/i);assert.equal(model.indicators.entries.has('late'),false);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});let armed=false;
    api.registerIndicator('retiring-params',({period=1}={})=>{if(armed)chart.destroy();return {outputs:['value'],create:()=>({step:bar=>[bar.close/period],snapshot:()=>({}),restore(){}})};});
    api.addIndicator('e','retiring-params',{period:1});const before=model.indicators.entries.get('e');armed=true;
    assert.throws(()=>api.setIndicatorParams('e',{period:2}),/disposed|retired/i);assert.equal(model.indicators.entries.get('e'),before);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});let armed=false;
    api.registerIndicator('retiring-series',()=>({outputs:['value'],create:()=>({step:bar=>{if(armed)chart.destroy();return [bar.close];},snapshot:()=>({}),restore(){}})}));
    api.addIndicator('e','retiring-series',{});model.store.update(0,{...model.store.at(0),volume:5});armed=true;
    assert.throws(()=>api.addSeries({id:'late',type:'line',panel:'price',indicator:'e'}),/disposed|retired/i);assert.equal(model.series.length,0);
  }
});

test('compaction and ingestion do not publish after input callbacks retire the owner',t=>{
  {
    const {chart,model,api}=ownedChart(t,{data:bars()}),store=model.store,before={columns:store.columns,index:store.index,length:store.length,version:store.version};
    assert.throws(()=>api.compactData(retiringProxy(chart,{keepLastBars:1,studyHistory:'restart'})),/disposed|retired/i);
    for(const [key,value] of Object.entries(before))assert.equal(store[key],value);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});
    assert.throws(()=>api.configureDataIngestion(retiringProxy(chart,{streamId:'x',generation:1})),/disposed|retired/i);assert.equal(model.dataIngestion,undefined);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});api.configureDataIngestion({streamId:'x',generation:1});const session=model.dataIngestion,before={count:session.count,nextSequence:session.nextSequence,counters:{...session.counters}};
    const packet=retiringProxy(chart,{streamId:'x',generation:1,firstSequence:0,events:[{kind:'update',bar:bars()[2]}]});
    assert.throws(()=>api.enqueueDataEvents(packet),/disposed|retired/i);assert.equal(session.count,before.count);assert.equal(session.nextSequence,before.nextSequence);assert.deepEqual(session.counters,before.counters);
  }
});

test('drawing validation callbacks cannot publish after retiring the owner',t=>{
  const {chart,model,api}=ownedChart(t),before=journalState(model.drawings),point={time:0,price:1};Object.defineProperty(point,'toJSON',{value(){chart.destroy();return {time:0,price:1};}});
  assert.throws(()=>api.addDrawing({id:'late',type:'horizontal',panel:'price',points:[point]}),/disposed|retired/i);
  assert.deepEqual(journalState(model.drawings),before);
});

test('async indicator params reject retained and mid-flight retired API owners without publication',async t=>{
  assert.equal(setIndicatorParamsAsync.length,3);
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});api.addIndicator('e','ema',{period:2});const before=model.indicators.entries.get('e');let workers=0;chart.destroy();
    await assert.rejects(setIndicatorParamsAsync(api,'e',{period:3},{workerFactory(){workers++;throw new Error('worker must not start');}}),/disposed|retired/i);
    assert.equal(workers,0);assert.equal(model.indicators.entries.get('e'),before);
  }
  {
    const {chart,model,api}=ownedChart(t,{data:bars()});api.addIndicator('e','ema',{period:2});const before=model.indicators.entries.get('e');let worker,postedResolve,packet;
    const posted=new Promise(resolve=>{postedResolve=resolve;});
    const pending=setIndicatorParamsAsync(api,'e',{period:3},{workerFactory:()=>worker={onmessage:null,onerror:null,postMessage(request,transfer){packet=computeIndicatorParamsRequest(structuredClone(request,{transfer}));postedResolve();},terminate(){}}});
    await posted;chart.destroy();queueMicrotask(()=>worker.onmessage?.({data:packet}));
    await assert.rejects(pending,/disposed|retired|stale/i);assert.equal(model.indicators.entries.get('e'),before);
  }
});

test('destroy retires held API and every controller input entry without touching a fresh owner',t=>{
  const env=chartEnvironment(t),model=new ChartModel(),notices=[];
  const chart=new CanvasChart(env.container,model,{dpr:()=>1,interactive:false,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})});
  const api=chart.api,controller=chart.controller;
  api.invalidate=kind=>notices.push(kind);controller.invalidate=kind=>notices.push(kind);
  chart.destroy();const before=journalState(model.drawings),noticeCount=notices.length;

  const entries=[
    ()=>controller.key('z',{ctrl:true}),
    ()=>controller.down(1,10,10),
    ()=>controller.move(1,11,11),
    ()=>controller.up(1),
    ()=>controller.wheel(1,10),
    ()=>controller.setTool('horizontal'),
    ()=>controller.cancel(),
    ()=>api.addDrawing(drawing('late')),
    ()=>api.dispatch('inspect'),
  ];
  for(const entry of entries)assert.throws(entry,/disposed|retired/i);
  assert.deepEqual(journalState(model.drawings),before);
  assert.equal(notices.length,noticeCount);

  const fresh=new ChartAPI(model);fresh.addDrawing(drawing('fresh'));
  assert.equal(model.drawings.items[0].id,'fresh');
  model.dispose();
});

test('destroy only cancels its captured drawing transaction after journal transfer',t=>{
  const env=chartEnvironment(t),oldModel=new ChartModel();
  const chart=new CanvasChart(env.container,oldModel,{dpr:()=>1,interactive:false,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})});
  chart.controller.setTool('horizontal');chart.controller.down(1,100,100);
  const drawings=oldModel.drawings;assert(drawings.transaction);drawings.cancel();
  const nextModel=new ChartModel({store:oldModel.store});nextModel.drawings=drawings;
  const nextController=new InteractionController(nextModel,size);nextController.setTool('horizontal');nextController.down(2,120,100);
  const transaction=drawings.transaction,items=drawings.items;

  chart.destroy();
  assert.equal(drawings.transaction,transaction);
  assert.equal(drawings.items,items);
  nextController.up(2);assert.equal(drawings.transaction,null);assert.equal(drawings.items.length,1);
  oldModel.dispose();nextModel.dispose();
});

test('initial fallback disposal fails construction and releases listeners, observer, canvas and RAF',t=>{
  const env=chartEnvironment(t,{resize:true}),model=new ChartModel();
  assert.throws(()=>new CanvasChart(env.container,model,{
    dpr:()=>1,interactive:true,observeResize:true,layerCaching:false,
    rendererFactory(){throw new Error('initial renderer failure');},
    onFallback(){model.dispose();},
  }),/disposed/i);
  assert.equal(model.disposed,true);
  assert.equal(model.store.listeners.size,0);
  assert.equal(env.frames.size,0);
  assert.equal(env.disconnects,1);
  assert(env.canvases.every(canvas=>canvas.listenerCount===0));
  assert(env.canvases.every(canvas=>canvas.removed===true));
});

test('synchronous initial fallback retires a renderer returned after its callback',t=>{
  const env=chartEnvironment(t),model=new ChartModel();let rendererDisposals=0,fallbacks=0;
  const chart=new CanvasChart(env.container,model,{
    dpr:()=>1,interactive:false,observeResize:false,layerCaching:false,
    rendererFactory(canvas,fallback){fallback('synchronous renderer failure');return {kind:'late',render(){},dispose(){rendererDisposals++;}};},
    onFallback(reason){fallbacks++;assert.equal(reason,'synchronous renderer failure');},
  });
  assert.equal(chart.renderer,null);assert.equal(chart.rendererKind,'canvas');
  assert.equal(rendererDisposals,1);assert.equal(fallbacks,1);assert.equal(env.frames.size,1);
  chart.destroy();model.dispose();
});

test('runtime fallback disposal tears down the chart instead of retaining a dead model',t=>{
  const env=chartEnvironment(t),model=new ChartModel();
  const chart=new CanvasChart(env.container,model,{
    dpr:()=>1,interactive:false,observeResize:false,layerCaching:false,
    rendererFactory:()=>({kind:'test',render(){},dispose(){}}),
    onFallback(){model.dispose();},
  });
  chart.fallback('runtime renderer failure');
  assert.equal(chart.disposed,true);assert.equal(model.disposed,true);
  assert.equal(model.store.listeners.size,0);assert.equal(env.frames.size,0);
  assert(env.canvases.every(canvas=>canvas.listenerCount===0));
});
