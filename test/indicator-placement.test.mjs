import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Worker} from 'node:worker_threads';
import {BarStore,ChartModel,ChartAPI,InteractionController,saveWorkspace} from '../src/core/index.mjs';
import {prepareWorkspaceAsync} from '../src/web/workspace-async.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const bars=Array.from({length:32},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:100+i}));
const binding=Object.freeze({key:'indicator-placement:ASTER/1m',revision:'2026-10-23.1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'});
function fixture(t){
  const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price',weight:3},{id:'osc',weight:1},{id:'volume',weight:1}],axes:[{id:'osc-axis',panel:'osc',side:'left'}]});
  const controller=new InteractionController(model,()=>({width:800,height:500}));let invalidations=0;
  const api=new ChartAPI(model,{controller,invalidate:()=>invalidations++});t.after(()=>model.dispose());
  api.addIndicator('macd','macd',{fast:3,slow:7,signal:2});api.addIndicator('rsi','rsi',{period:3});
  api.addSeries({id:'macd-line',type:'line',panel:'price',indicator:'macd',output:'macd',color:'#123456',offset:2});
  api.addSeries({id:'macd-signal',type:'line',panel:'price',indicator:'macd',output:'signal',color:'#abcdef'});
  api.addSeries({id:'rsi-line',type:'line',panel:'price',indicator:'rsi',output:'value'});
  return {model,api,controller,invalidations:()=>invalidations};
}

test('panel order is an exact permutation, preserves panel objects, and invalidates once',t=>{
  const f=fixture(t),refs=f.model.panels.slice(),before=f.invalidations();
  assert.equal(f.api.setPanelOrder(['volume','price','osc']),true);assert.equal(f.invalidations(),before+1);
  assert.deepEqual(f.model.panels.map(p=>p.id),['volume','price','osc']);assert.equal(f.model.panels[1],refs[0]);assert.equal(f.model.panels[2],refs[1]);
  const noOp=f.invalidations();assert.equal(f.api.setPanelOrder(['volume','price','osc']),false);assert.equal(f.invalidations(),noOp);
  for(const value of [[],['volume','price'],['volume','price','price'],['volume','price','missing'],new Array(3)]){const state=f.model.panels.slice();assert.throws(()=>f.api.setPanelOrder(value));assert.deepEqual(f.model.panels,state);}
  const accessor=['volume','price','osc'];Object.defineProperty(accessor,'1',{enumerable:true,get(){throw new Error('accessor');}});assert.throws(()=>f.api.setPanelOrder(accessor));
  const hidden=['volume','price','osc'];Object.defineProperty(hidden,'1',{enumerable:false,value:'price'});assert.throws(()=>f.api.setPanelOrder(hidden));
});

test('indicator placement moves every output without calculation or cache replacement',t=>{
  const f=fixture(t),macd=f.model.indicators.entries.get('macd'),series=f.model.series.filter(s=>s.indicator==='macd'),entryArrays=macd.arrays.slice();
  for(const s of series)f.model.seriesData(s);const caches=series.map(s=>({ref:s,index:s.rangeIndex,revision:s.revision,dirty:s.dirtyFrom,style:s.color,offset:s.offset}));const before=f.invalidations();
  let gets=0;const original=f.model.indicators.get;f.model.indicators.get=function(...args){gets++;return original.apply(this,args);};
  assert.deepEqual(f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'}),{changed:2});assert.equal(f.invalidations(),before+1);assert.equal(gets,0);
  assert.deepEqual(f.model.series.filter(s=>s.indicator==='macd').map(s=>[s.panel,s.axisId]),[['osc','osc-axis'],['osc','osc-axis']]);assert.deepEqual(macd.arrays,entryArrays);for(const [s,c] of f.model.series.filter(s=>s.indicator==='macd').map((s,i)=>[s,caches[i]])){assert.equal(s.rangeIndex,c.index);assert.equal(s.revision,c.revision);assert.equal(s.dirtyFrom,c.dirty);assert.equal(s.color,c.style);assert.equal(s.offset,c.offset);}
  assert.deepEqual(f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'}),{changed:0});assert.equal(f.invalidations(),before+1);assert.equal(gets,0);
  assert.deepEqual(f.api.setIndicatorPlacement('macd',{panel:'price'}),{changed:2});assert.deepEqual(f.model.series.filter(s=>s.indicator==='macd').map(s=>[s.panel,s.axisId]),[['price',null],['price',null]]);assert.equal(gets,0);
});

test('indicator placement validates the complete destination before mutation',t=>{
  const f=fixture(t),before=f.model.series.map(s=>({...s})),n=f.invalidations();
  for(const placement of [{panel:'missing'},{panel:'osc',axisId:'missing'},{panel:'osc',axisId:7},[],{axisId:null},{panel:'osc',extra:true},Object.create({panel:'osc'})]){assert.throws(()=>f.api.setIndicatorPlacement('macd',placement));assert.deepEqual(f.model.series.map(s=>({...s})),before);assert.equal(f.invalidations(),n);}
  assert.throws(()=>f.api.setIndicatorPlacement('missing',{panel:'osc'}));f.api.removeSeries('rsi-line');assert.throws(()=>f.api.setIndicatorPlacement('rsi',{panel:'osc'}),/bound series/);
});

test('placement and panel order reject owned input while drawing or pointers are active',t=>{
  const f=fixture(t),layout=f.controller.layout();f.controller.setTool('trendline');f.controller.down(1,layout.x(3),layout.axis('price').y(101));
  assert.throws(()=>f.api.setIndicatorPlacement('macd',{panel:'osc'}),/gesture/);assert.throws(()=>f.api.setPanelOrder(['osc','price','volume']),/gesture/);assert.throws(()=>f.api.removePanel('volume'),/gesture/);f.controller.cancel();
  f.model.drawings.begin();assert.throws(()=>f.api.setPanelOrder(['osc','price','volume']),/transaction/);assert.throws(()=>f.api.setIndicatorPlacement('macd',{panel:'osc'}),/transaction|owner/);f.model.drawings.cancel();
});

test('removePanel refuses bindings and drawing history and clears an empty target',t=>{
  const f=fixture(t);f.controller.setDrawingTarget({panel:'volume'});const n=f.invalidations();f.api.removePanel('volume');assert.equal(f.model.panels.some(p=>p.id==='volume'),false);assert.equal(f.controller.drawingTarget,null);assert.equal(f.invalidations(),n+1);
  assert.throws(()=>f.api.removePanel('price'),/series/);f.api.addPanel({id:'empty'});f.api.addDrawing({id:'d',type:'horizontal',panel:'empty',points:[{time:bars[0].time,price:100}]});assert.throws(()=>f.api.removePanel('empty'),/drawing/);f.api.deleteDrawing('d');assert.throws(()=>f.api.removePanel('missing'),/Missing/);
  const only=new ChartModel({store:new BarStore(bars)}),onlyApi=new ChartAPI(only);assert.throws(()=>onlyApi.removePanel('price'),/last panel/);only.dispose();
});

test('removePanel rejects same-array series reentry and preserves the newer target binding',t=>{
  const f=fixture(t),series=f.model.series,originalTarget=f.controller.drawingTarget;let reflections=0;
  const late=f.model.normalizedSeries({id:'late-volume',type:'line',panel:'volume',source:'close'});
  f.model.series=new Proxy(series,{getOwnPropertyDescriptor(target,key){
    if(key==='length'&&++reflections===2){target.push(late);f.controller.drawingTarget={panel:'volume',seriesId:'late-volume'};}
    return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  assert.equal(originalTarget,null);assert.throws(()=>f.api.removePanel('volume'),e=>e?.name==='StaleSourceError');
  assert.equal(f.model.panels.some(panel=>panel.id==='volume'),true);
  assert.deepEqual(f.controller.drawingTarget,{panel:'volume',seriesId:'late-volume'});
  assert.equal(f.model.series.at(-1),late);
});

test('removePanel rejects same-array axis and history reentry before changing panels',t=>{
  const axisFixture=fixture(t),axes=axisFixture.model.axes;let axisReflections=0;
  const lateAxis={id:'late-volume-axis',panel:'volume',side:'right',visible:true,tickFormat:'fixed',scale:'linear',inverted:false,padding:.08};
  axisFixture.model.axes=new Proxy(axes,{getOwnPropertyDescriptor(target,key){
    if(key==='length'&&++axisReflections===2)target.push(lateAxis);return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  assert.throws(()=>axisFixture.api.removePanel('volume'),e=>e?.name==='StaleSourceError');
  assert.equal(axisFixture.model.panels.some(panel=>panel.id==='volume'),true);assert.equal(axisFixture.model.axes.at(-1),lateAxis);

  const historyFixture=fixture(t),drawings=historyFixture.model.drawings,undo=[];let historyReflections=0;
  const referenced=[{id:'history-volume',type:'horizontal',panel:'volume',points:[{time:bars[0].time,price:100}]}];
  historyFixture.model.drawings.undoStack=new Proxy(undo,{getOwnPropertyDescriptor(target,key){
    if(key==='length'&&++historyReflections===2)target.push(referenced);return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  assert.throws(()=>historyFixture.api.removePanel('volume'),e=>e?.name==='StaleSourceError');
  assert.equal(historyFixture.model.panels.some(panel=>panel.id==='volume'),true);assert.equal(historyFixture.model.drawings.undoStack.at(-1),referenced);
});

test('removePanel retains panels referenced by current, undo, and redo drawing state, including a deleted last drawing',t=>{
  const setup=()=>{const f=fixture(t);f.api.addPanel({id:'drawing-panel'});f.api.addDrawing({id:'last-drawing',type:'horizontal',panel:'drawing-panel',points:[{time:bars[0].time,price:100}]});return f;};
  const current=setup();assert.throws(()=>current.api.removePanel('drawing-panel'),/drawing/);
  const undo=setup();undo.api.deleteDrawing('last-drawing');assert.equal(undo.model.drawings.items.length,0);assert.throws(()=>undo.api.removePanel('drawing-panel'),/drawing history/);
  const redo=setup();redo.api.undo();assert.equal(redo.model.drawings.items.length,0);assert.throws(()=>redo.api.removePanel('drawing-panel'),/drawing history/);
});

test('indicator placement stages every output when the first axis binding is non-writable',t=>{
  const f=fixture(t),macd=f.model.series.filter(series=>series.indicator==='macd');
  Object.defineProperty(macd[0],'axisId',{value:null,writable:false,enumerable:true,configurable:false});
  assert.deepEqual(f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'}),{changed:2});
  assert.deepEqual(f.model.series.filter(series=>series.indicator==='macd').map(series=>[series.panel,series.axisId]),[['osc','osc-axis'],['osc','osc-axis']]);
});

test('indicator placement rejects an accessor id before mutating any output binding',t=>{
  const f=fixture(t),series=f.model.series.filter(value=>value.indicator==='macd'),before=f.model.series;
  Object.defineProperty(series[0],'id',{enumerable:true,configurable:true,get(){throw new Error('id accessor must not run');}});
  assert.throws(()=>f.api.setIndicatorPlacement('macd',{panel:'osc'}),/own data|id/);
  assert.strictEqual(f.model.series,before);assert.deepEqual(f.model.series.filter(value=>value.indicator==='macd').map(value=>value.panel),['price','price']);
});

test('no-op placement rejects API owner replacement during input reflection',t=>{
  const f=fixture(t),replacement=new ChartModel({store:new BarStore(bars)});t.after(()=>replacement.dispose());let once=true;
  const placement=new Proxy({panel:'price'},{ownKeys(target){if(once){once=false;f.api.model=replacement;}return Reflect.ownKeys(target);}});
  assert.throws(()=>f.api.setIndicatorPlacement('macd',placement),e=>e?.name==='StaleSourceError');
  assert.deepEqual(f.model.series.filter(series=>series.indicator==='macd').map(series=>[series.panel,series.axisId??null]),[['price',null],['price',null]]);
});

test('placement updates the owned target directly and invalidates once',t=>{
  const f=fixture(t);f.api.setDrawingTarget({panel:'price',seriesId:'macd-line'});const before=f.invalidations();let calls=0;
  f.controller.setDrawingTarget=()=>{calls++;throw new Error('overridden target setter must not run');};
  assert.deepEqual(f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'}),{changed:2});
  assert.equal(calls,0);assert.equal(f.invalidations(),before+1);assert.deepEqual(f.controller.drawingTarget,{panel:'osc',axisId:'osc-axis',seriesId:'macd-line'});
  assert.deepEqual(f.model.series.filter(series=>series.indicator==='macd').map(series=>[series.panel,series.axisId]),[['osc','osc-axis'],['osc','osc-axis']]);
});

for(const reentry of ['pointer','transaction'])test(`placement rejects ${reentry} reentry before committing staged bindings`,t=>{
  const f=fixture(t),series=f.model.series.slice(),drawings=f.model.drawings;let reads=0;
  f.model.drawings=new Proxy(drawings,{getOwnPropertyDescriptor(target,key){
    if(key==='transaction'&&++reads===2){if(reentry==='pointer')f.controller.pointers.set(77,{x:1,y:1});else target.transaction=[];}
    return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  assert.throws(()=>f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'}));
  assert.strictEqual(f.model.series[0],series[0]);assert.strictEqual(f.model.series[1],series[1]);assert.deepEqual(f.model.series.filter(value=>value.indicator==='macd').map(value=>[value.panel,value.axisId??null]),[['price',null],['price',null]]);
  f.model.drawings=drawings;drawings.transaction=null;f.controller.pointers.clear();
});

test('panel order rejects pointer reentry during its final owner reflection',t=>{
  const f=fixture(t),panels=f.model.panels,first=panels[0];let reads=0;
  panels[0]=new Proxy(first,{getOwnPropertyDescriptor(target,key){if(key==='id'&&++reads===2)f.controller.pointers.set(78,{x:1,y:1});return Reflect.getOwnPropertyDescriptor(target,key);}});
  assert.throws(()=>f.api.setPanelOrder(['volume','price','osc']),/active gesture/);assert.strictEqual(f.model.panels[0].id,'price');assert.equal(f.model.panels[1].id,'osc');
  panels[0]=first;f.controller.pointers.clear();
});

test('workspace and study documents round-trip moved RSI/MACD outputs with axes and panel order',async t=>{
  const f=fixture(t);f.api.addAxis({id:'volume-axis',panel:'volume',side:'right'});f.api.addSeries({id:'macd-histogram',type:'histogram',panel:'price',indicator:'macd',output:'histogram'});
  f.api.setIndicatorPlacement('rsi',{panel:'osc',axisId:'osc-axis'});f.api.setIndicatorPlacement('macd',{panel:'volume',axisId:'volume-axis'});f.api.setPanelOrder(['volume','price','osc']);
  const workspace=saveWorkspace(f.api,binding),studies=f.api.saveStudies();
  const workerFactory=()=>{const node=new Worker(new URL('./fixtures/workspace-worker-host.mjs',import.meta.url),{type:'module'}),adapter={onmessage:null,onerror:null,postMessage(...args){node.postMessage(...args);},terminate(){return node.terminate();}};node.on('message',data=>{if(!data?.__workspaceTestHost)adapter.onmessage?.({data});});node.on('error',error=>adapter.onerror?.({message:error.message}));t.after(()=>node.terminate());return adapter;};
  const restored=await prepareWorkspaceAsync(f.model.store,workspace,{datasetBinding:binding,workerFactory});t.after(()=>restored.dispose());
  assert.deepEqual(restored.panels.map(panel=>panel.id),['volume','price','osc']);assert.deepEqual(restored.axes.map(axis=>[axis.id,axis.panel]),[['osc-axis','osc'],['volume-axis','volume']]);
  assert.deepEqual(restored.series.filter(series=>series.indicator==='rsi').map(series=>[series.id,series.panel,series.axisId]),[['rsi-line','osc','osc-axis']]);
  assert.deepEqual(restored.series.filter(series=>series.indicator==='macd').map(series=>[series.output,series.panel,series.axisId]),[['macd','volume','volume-axis'],['signal','volume','volume-axis'],['histogram','volume','volume-axis']]);
  const target=new ChartModel({store:new BarStore(bars),panels:[{id:'price',weight:3},{id:'osc',weight:1},{id:'volume',weight:1}],axes:[{id:'osc-axis',panel:'osc',side:'left'},{id:'volume-axis',panel:'volume',side:'right'}]});t.after(()=>target.dispose());const targetAPI=new ChartAPI(target);
  assert.deepEqual(targetAPI.loadStudies(studies),{indicators:2,series:4});assert.deepEqual(target.series.filter(series=>series.indicator==='macd').map(series=>[series.output,series.panel,series.axisId]),[['macd','volume','volume-axis'],['signal','volume','volume-axis'],['histogram','volume','volume-axis']]);
});

test('generated native VM dispatches placement, panel order, and panel removal commands',async()=>{
  const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
  const result=vm.runInContext(`(()=>{nativeInit(4,{panels:[{id:'price',weight:3},{id:'osc',weight:1},{id:'empty',weight:1}],axes:[{id:'osc-axis',panel:'osc',side:'left'}],series:[]});nativeCommand('addIndicator',['rsi','rsi',{period:2}]);nativeCommand('addSeries',[{id:'rsi-value',type:'line',panel:'price',indicator:'rsi',output:'value'}]);const placement=nativeCommand('setIndicatorPlacement',['rsi',{panel:'osc',axisId:'osc-axis'}]);const order=nativeCommand('setPanelOrder',[['osc','price','empty']]);const removed=nativeCommand('removePanel',['empty']);const methods=['setIndicatorPlacement','setPanelOrder','removePanel'].every(name=>typeof Aster.ChartAPI.prototype[name]==='function');const state={placement,order,removed,methods,panels:nativeModel.panels.map(panel=>panel.id),series:nativeModel.series.map(series=>[series.id,series.panel,series.axisId])};nativeModel.dispose();return JSON.stringify(state);})()`,context,{timeout:5000});
  assert.deepEqual(JSON.parse(result),{placement:{changed:1},order:true,removed:null,methods:true,panels:['osc','price'],series:[['rsi-value','osc','osc-axis']]});
});
