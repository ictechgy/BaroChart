import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,seededColumns,ChartModel,ChartAPI,InteractionController,createLayout,DEMO_SYMBOLS} from '../src/core/index.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {hydrateModel,modelRequest,installRecomputed,requestOptionsSnapshot,validatePreparedPacketAsync} from '../src/web/worker-state.mjs';
import {prepareChartModel,recomputeInWorker} from '../src/web/worker.mjs';

function fixture(){
 const store=new BarStore();store.setColumns(seededColumns(512,42));const model=new ChartModel({store,panels:[{id:'price',axisVisible:false,axisSide:'left'}],axes:[
  {id:'left',panel:'price',side:'left',precision:4,prefix:'USD ',range:[90,120]},
  {id:'percent',panel:'price',side:'right',scale:'percent',base:100,range:[80,150],suffix:'%',tickFormat:'scientific'}
 ]});
 model.indicators.add('e','ema');model.addSeries({id:'ohlc',type:'candles',panel:'price',axisId:null,label:'Primary'});model.addSeries({id:'ema',type:'line',panel:'price',axisId:'left',indicator:'e',label:'Trend'});
 model.addSeries({id:'foreign',type:'line',panel:'price',axisId:'percent',symbolId:'EURUSD',label:'Aligned EUR/USD',values:Float64Array.from({length:512},(_,i)=>100+i/100)});
 const input=new InteractionController(model,()=>({width:1200,height:700})),api=new ChartAPI(model,{controller:input});api.setSymbol(DEMO_SYMBOLS.crypto);createLayout(model,1200,700);return {model,input,api};
}
function event(model){return {kind:'correction',bar:{...model.store.at(0),close:1000,high:1000}};}
function request(model,change){return {columns:model.store.columns,length:model.store.length,options:modelRequest(model),...(change?{event:change}:{})};}
function assertMetadata(model,source){assert.deepEqual(model.axes,source.axes);assert.deepEqual(model.panels,source.panels);assert.deepEqual(model.series.map(s=>[s.id,s.axisId,s.symbolId,s.label]),source.series.map(s=>[s.id,s.axisId,s.symbolId,s.label]));}

test('worker preparation/hydration preserves explicit axes, null primary and aligned foreign metadata',async()=>{
 const {model}=fixture(),expected=requestOptionsSnapshot(modelRequest(model)),packet=await computeRequest(request(model)),token=await validatePreparedPacketAsync(packet,expected,{yieldTask:async()=>{}}),done=hydrateModel(packet,expected,token);
 assertMetadata(done,model);assert.deepEqual(done.series.find(s=>s.id==='foreign').values,model.series.find(s=>s.id==='foreign').values);assert.deepEqual(done.indicators.get('e').outputs,model.indicators.get('e').outputs);
 assert.equal(createLayout(done,1200,700).axis('price','left').prefix,'USD ');model.dispose();done.dispose();
});

test('worker request owns portable axis ranges and rejects sync formatter callbacks',()=>{
 const {model}=fixture(),options=modelRequest(model),snapshot=requestOptionsSnapshot(options);options.axes[0].range[0]=12;assert.equal(snapshot.axes[0].range[0],90);assert.equal(snapshot.axes[0].side,'left');
 assert.throws(()=>requestOptionsSnapshot({...snapshot,axes:[{...snapshot.axes[0],formatter:v=>String(v)}]}),/formatter/);model.setAxis('left',{formatter:v=>String(v)});assert.throws(()=>modelRequest(model),/formatter/);model.dispose();
});

test('worker axis and series reply metadata are bound to original request before publication',async()=>{
 const {model}=fixture(),change=event(model),expected=requestOptionsSnapshot(modelRequest(model)),packet=await computeRequest(request(model,change)),before=model.store.at(0),axes=structuredClone(model.axes),saved=model.drawings.save();
 const mutations=[p=>{p.options.axes=[];},p=>{p.options.axes[0].side='right';},p=>{p.options.axes[0].prefix='spoof ';},p=>{p.options.axes[1].base=0;},p=>{p.options.series[1].axisId='percent';},p=>{p.options.series[2].symbolId='SPOOF';},p=>{p.options.series[2].label='SPOOF';}];
 for(const mutate of mutations){const reply=structuredClone(packet);mutate(reply);assert.throws(()=>installRecomputed(model,reply,change,expected),/axis|binding|scale/i);await assert.rejects(validatePreparedPacketAsync(reply,expected),/axis|binding|scale/i);assert.deepEqual(model.store.at(0),before);assert.deepEqual(model.axes,axes);assert.equal(model.drawings.save(),saved);}
 model.dispose();
});

test('worker recompute installs only calculated data while retaining latest axes/series labels/target and drawing history',async()=>{
 const {model,input,api}=fixture(),change=event(model),expected=requestOptionsSnapshot(modelRequest(model)),packet=await computeRequest(request(model,change));
 const id=api.addDrawing({type:'text',seriesId:'ema',text:'one',points:[{time:model.store.at(10).time,price:101}]});api.editDrawing(id,{text:'two'});api.undo();api.setAxis('left',{prefix:'$ ',range:[85,125],inverted:true});api.setSeries('foreign',{label:'Live EUR/USD'});input.setDrawingTarget({panel:'price',seriesId:'ema'});
 const saved=model.drawings.save(),history=structuredClone(model.drawings.redoStack),axes=structuredClone(model.axes),target=structuredClone(input.drawingTarget);installRecomputed(model,packet,change,expected);
 assert.equal(model.store.at(0).close,1000);assert.deepEqual(model.axes,axes);assert.equal(model.series.find(s=>s.id==='foreign').label,'Live EUR/USD');assert.deepEqual(input.drawingTarget,target);assert.equal(model.drawings.save(),saved);assert.deepEqual(model.drawings.redoStack,history);api.redo();assert.equal(model.drawings.items[0].text,'two');model.dispose();
});

test('worker packet carrying foreign metadata cannot substitute primary candle OHLC identity',async()=>{
 const {model}=fixture(),packet=await computeRequest(request(model)),done=hydrateModel(packet);done.setVisibleRange(50,150);const api=new ChartAPI(done);api.setSymbol(DEMO_SYMBOLS.crypto);const layout=createLayout(done,1200,700);done.crosshair={x:layout.x(100),y:layout.axis('price','left').y(105)};
 const values=api.crosshairValues(1200,700);assert.deepEqual(values.primary.bar,done.store.at(100));assert.equal(values.primary.symbolId,DEMO_SYMBOLS.crypto.id);assert.equal(values.series.find(s=>s.id==='foreign').symbolId,'EURUSD');assert.equal(values.series.find(s=>s.id==='foreign').value,101);assert.equal(values.series.find(s=>s.id==='ohlc').symbolId,DEMO_SYMBOLS.crypto.id);
 model.dispose();done.dispose();
});

test('public worker preparation fails on axis callbacks before constructing a worker',async()=>{
 const previous=globalThis.Worker;let created=0;globalThis.Worker=class{constructor(){created++;}terminate(){}};
 try{await assert.rejects(prepareChartModel({columns:seededColumns(16),options:{axes:[{id:'a',panel:'price',formatter:v=>String(v)}]}}),/formatter/);assert.equal(created,0);}finally{globalThis.Worker=previous;}
});

test('late axis callback during worker calculation rejects before source publication',async()=>{
 const previous=globalThis.Worker;let finish;globalThis.Worker=class {postMessage(value){const snapshot=structuredClone(value);finish=async()=>{this.onmessage?.({data:{packet:await computeRequest(snapshot)}});};}terminate(){}};
 const {model}=fixture();try{const original=model.store.at(0),pending=recomputeInWorker(model,event(model));model.setAxis('left',{formatter:v=>'custom '+v});await finish();await assert.rejects(pending,/formatter/);assert.deepEqual(model.store.at(0),original);}finally{model.dispose();globalThis.Worker=previous;}
});

test('public worker recompute keeps latest portable axis edits while waiting for result',async()=>{
 const previous=globalThis.Worker;let finish;globalThis.Worker=class {postMessage(value){const snapshot=structuredClone(value);finish=async()=>{this.onmessage?.({data:{packet:await computeRequest(snapshot)}});};}terminate(){}};
 const {model,input,api}=fixture();try{const pending=recomputeInWorker(model,event(model));api.setAxis('left',{prefix:'latest ',precision:7});api.setSeries('foreign',{label:'Latest quote'});input.setDrawingTarget({panel:'price',seriesId:'foreign'});await finish();assert.equal(await pending,model);assert.equal(model.axes[0].prefix,'latest ');assert.equal(model.axes[0].precision,7);assert.equal(model.series.find(s=>s.id==='foreign').label,'Latest quote');assert.equal(input.drawingTarget.axisId,'percent');assert.equal(model.store.at(0).close,1000);}finally{model.dispose();globalThis.Worker=previous;}
});
