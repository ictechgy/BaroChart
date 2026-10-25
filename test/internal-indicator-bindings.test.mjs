import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core/index.mjs';
import {BarStore,ChartModel,ChartAPI,InteractionController} from '../src/core/index.mjs';
import {restoreIndicatorBindings} from '../src/core/internal-indicator-bindings.mjs';

const bars=Array.from({length:24},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:100+i}));

function fixture(t){
  const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price',weight:3},{id:'osc',weight:1},{id:'volume',weight:1}],axes:[{id:'osc-axis',panel:'osc',side:'left'},{id:'volume-axis',panel:'volume',side:'right'}]});
  const controller=new InteractionController(model,()=>({width:800,height:500}));let invalidations=0;
  const api=new ChartAPI(model,{controller,invalidate:()=>invalidations++});t.after(()=>model.dispose());
  api.addIndicator('macd','macd',{fast:3,slow:7,signal:2});
  api.addIndicator('rsi','rsi',{period:3});
  api.addSeries({id:'macd-line',type:'line',panel:'price',indicator:'macd',output:'macd',color:'#123456',offset:2});
  api.addSeries({id:'macd-signal',type:'line',panel:'osc',axisId:'osc-axis',indicator:'macd',output:'signal',color:'#abcdef'});
  api.addSeries({id:'macd-histogram',type:'histogram',panel:'volume',axisId:'volume-axis',indicator:'macd',output:'histogram',color:'#fedcba'});
  api.addSeries({id:'rsi-line',type:'line',panel:'price',indicator:'rsi'});
  return {model,api,controller,invalidations:()=>invalidations};
}

const bindings=[
  {seriesId:'macd-line',panel:'osc',axisId:'osc-axis'},
  {seriesId:'macd-signal',panel:'volume',axisId:'volume-axis'},
  {seriesId:'macd-histogram',panel:'price',axisId:null},
];

test('binding restore stays outside the indexed public core surface',()=>{
  assert.equal(core.restoreIndicatorBindings,undefined);
});

test('restores every output binding without reading indicators and updates a bound target once',t=>{
  const f=fixture(t),entry=f.model.indicators.entries.get('macd'),outputArrays=entry.arrays.slice(),series=f.model.series.filter(value=>value.indicator==='macd');
  const caches=series.map(value=>{const data=f.model.seriesData(value);return {ref:value,index:value.rangeIndex,revision:value.revision,dirty:value.dirtyFrom,style:value.color,offset:value.offset,values:data.values,outputIndex:entry.def.outputs.indexOf(value.output)};});
  const view=f.model.view,drawings=f.model.drawings,items=drawings.items,undo=drawings.undoStack,redo=drawings.redoStack;
  f.api.setDrawingTarget({panel:'osc',axisId:'osc-axis',seriesId:'macd-signal'});const before=f.invalidations();
  f.model.indicators.get=()=>{throw new Error('restore must not query indicator outputs');};
  assert.deepEqual(restoreIndicatorBindings(f.api,'macd',bindings),{changed:3});
  assert.equal(f.invalidations(),before+1);assert.strictEqual(f.model.view,view);assert.strictEqual(f.model.drawings,drawings);assert.strictEqual(drawings.items,items);assert.strictEqual(drawings.undoStack,undo);assert.strictEqual(drawings.redoStack,redo);assert.strictEqual(f.model.indicators.entries.get('macd'),entry);assert.deepEqual(entry.arrays,outputArrays);
  assert.deepEqual(f.model.series.filter(value=>value.indicator==='macd').map(value=>[value.id,value.panel,value.axisId]),[['macd-line','osc','osc-axis'],['macd-signal','volume','volume-axis'],['macd-histogram','price',null]]);
  for(const [value,beforeCache] of f.model.series.filter(value=>value.indicator==='macd').map((value,index)=>[value,caches[index]])){assert.notStrictEqual(value,beforeCache.ref);assert.strictEqual(value.rangeIndex,beforeCache.index);assert.equal(value.revision,beforeCache.revision);assert.equal(value.dirtyFrom,beforeCache.dirty);assert.equal(value.color,beforeCache.style);assert.equal(value.offset,beforeCache.offset);assert.equal(beforeCache.values.buffer,outputArrays[beforeCache.outputIndex].buffer);}
  assert.deepEqual(f.controller.drawingTarget,{panel:'volume',axisId:'volume-axis',seriesId:'macd-signal'});
  const after=f.invalidations();assert.deepEqual(restoreIndicatorBindings(f.api,'macd',bindings),{changed:0});assert.equal(f.invalidations(),after);
});

test('requires the exact complete dense set and leaves the chart untouched on malformed input',t=>{
  const f=fixture(t),before=f.model.series,refs=f.model.series.slice(),placements=f.model.series.map(value=>[value.id,value.panel,value.axisId??null]),n=f.invalidations();
  const cases=[
    bindings.slice(0,2),
    [...bindings,{seriesId:'macd-line',panel:'price',axisId:null}],
    bindings.map(value=>value.seriesId==='macd-line'?{...value,seriesId:'rsi-line'}:value),
    bindings.map(value=>value.seriesId==='macd-line'?{...value,panel:'missing'}:value),
    bindings.map(value=>value.seriesId==='macd-line'?{...value,axisId:'volume-axis'}:value),
    bindings.map(value=>value.seriesId==='macd-line'?{...value,axisId:undefined}:value),
    Object.assign([],bindings,{extra:true}),
  ];
  for(const value of cases){assert.throws(()=>restoreIndicatorBindings(f.api,'macd',value));assert.strictEqual(f.model.series,before);assert.deepEqual(f.model.series.map(series=>[series.id,series.panel,series.axisId??null]),placements);assert.equal(f.invalidations(),n);assert.deepEqual(f.model.series,refs);}
  const accessor={seriesId:'macd-line',panel:'osc',axisId:'osc-axis'};Object.defineProperty(accessor,'panel',{enumerable:true,get(){throw new Error('binding accessor');}});assert.throws(()=>restoreIndicatorBindings(f.api,'macd',[accessor,...bindings.slice(1)]));assert.equal(f.invalidations(),n);
});

test('preflights a read-only target and rejects active gesture, pointers, or transaction before publication',t=>{
  const f=fixture(t),before=f.model.series.slice(),n=f.invalidations();f.api.setDrawingTarget({panel:'price',seriesId:'macd-line'});const target=f.controller.drawingTarget;
  Object.defineProperty(f.controller,'drawingTarget',{value:target,writable:false,enumerable:true,configurable:true});
  assert.throws(()=>restoreIndicatorBindings(f.api,'macd',bindings),/writable/);assert.strictEqual(f.model.series[0],before[0]);assert.equal(f.invalidations(),n+1);
  Object.defineProperty(f.controller,'drawingTarget',{value:target,writable:true,enumerable:true,configurable:true});
  f.controller.gesture={kind:'pan'};assert.throws(()=>restoreIndicatorBindings(f.api,'macd',bindings),/gesture/);f.controller.gesture=null;f.controller.pointers.set(1,{x:1,y:1});assert.throws(()=>restoreIndicatorBindings(f.api,'macd',bindings),/gesture/);f.controller.pointers.clear();f.model.drawings.begin();assert.throws(()=>restoreIndicatorBindings(f.api,'macd',bindings),/transaction|owner/);f.model.drawings.cancel();
  assert.deepEqual(f.model.series.map(value=>[value.id,value.panel,value.axisId??null]),before.map(value=>[value.id,value.panel,value.axisId??null]));
});

test('does not pretend to roll back a controller error after series publication',t=>{
  const f=fixture(t);f.api.setDrawingTarget({panel:'price',seriesId:'macd-line'});const original=f.controller,n=f.invalidations(),before=f.model.series;
  f.api.controller=new Proxy(original,{set(target,key,value,receiver){if(key==='drawingTarget')throw new Error('target publication failed');return Reflect.set(target,key,value,receiver);}});
  assert.throws(()=>restoreIndicatorBindings(f.api,'macd',bindings),/target publication failed/);assert.notStrictEqual(f.model.series,before);assert.equal(f.model.series.find(value=>value.id==='macd-line').panel,'osc');assert.equal(f.invalidations(),n);
});

for(const mode of ['pointer','entry','owner'])test(`rejects ${mode} reentry while reading binding input`,t=>{
  const f=fixture(t),before=f.model.series,record={...bindings[0]};let armed=true;
  const proxy=new Proxy(record,{getOwnPropertyDescriptor(target,key){if(armed&&key==='panel'){armed=false;if(mode==='pointer')f.controller.pointers.set(99,{x:1,y:1});else if(mode==='entry')f.model.indicators.entries=new Map(f.model.indicators.entries);else f.api.model=new ChartModel({store:new BarStore(bars)});return Reflect.getOwnPropertyDescriptor(target,key);}return Reflect.getOwnPropertyDescriptor(target,key);}});
  const input=[proxy,...bindings.slice(1)];assert.throws(()=>restoreIndicatorBindings(f.api,'macd',input),mode==='pointer'?/gesture/:/owner|stale/i);assert.strictEqual(f.model.series,before);f.controller.pointers.clear();if(mode==='owner')f.api.model=f.model;
});
