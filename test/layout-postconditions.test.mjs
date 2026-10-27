import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI} from '../src/core/index.mjs';
import {applyLayoutFrame} from '../examples/web/apply-layout-frame.mjs';
import {clearSyntheticRange,pinSyntheticRange,rebindSyntheticRangePins} from '../examples/web/indicator-layout.mjs';

const bars=Array.from({length:16},(_,index)=>({time:index+1,open:100+index,high:103+index,low:98+index,close:101+index,volume:1}));

function fixture(t,invalidate=()=>{}){
 const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price',weight:2},{id:'osc',weight:1}],axes:[{id:'osc-axis',panel:'osc'}]});
 const api=new ChartAPI(model,{invalidate});
 api.addIndicator('macd','macd',{fast:3,slow:7,signal:2});
 api.addSeries({id:'macd-line',type:'line',panel:'price',indicator:'macd',output:'macd'});
 api.addSeries({id:'macd-signal',type:'line',panel:'price',indicator:'macd',output:'signal'});
 t.after(()=>model.dispose());
 return {model,api};
}

function targetFrame({panel='target',axis='target-axis'}={}){
 return {panelOrder:panel==='osc'?['osc','price']:['osc',panel,'price'],placements:[
  {seriesId:'macd-line',indicatorId:'macd',panelId:panel,axisId:axis},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:panel,axisId:axis},
 ],generatedPanels:panel==='osc'?[]:[{id:panel,options:{weight:1}}],generatedAxes:[{id:axis,panel,options:{side:'right'}}]};
}

test('cleanup rebind is rejected after exact panel and axis postcondition',t=>{
 const f=fixture(t),generatedPanels=new Set(),generatedAxes=new Set(),frame=targetFrame();
 let armed=true;
 assert.throws(()=>applyLayoutFrame({api:f.api,frame,generatedPanelIds:generatedPanels,generatedAxisIds:generatedAxes,cleanup:()=>{
  if(armed){armed=false;f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'});}
 }}),error=>error?.name==='StaleSourceError'&&/placement/i.test(error.message));
 assert.deepEqual(f.model.series.map(series=>[series.id,series.panel,series.axisId??null]),[['macd-line','osc','osc-axis'],['macd-signal','osc','osc-axis']]);
 assert.equal(f.model.panels.some(panel=>panel.id==='target'),false);
 assert.equal(f.model.axes.some(axis=>axis.id==='target-axis'),false);
 assert.equal(generatedPanels.has('target'),false);assert.equal(generatedAxes.has('target-axis'),false);
});

test('same-panel axis rebind is rejected after cleanup while newer binding remains',t=>{
 const f=fixture(t),generatedAxes=new Set(),frame=targetFrame({panel:'osc',axis:'target-axis'});
 f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'});
 let armed=true;
 assert.throws(()=>applyLayoutFrame({api:f.api,frame,generatedPanelIds:new Set(),generatedAxisIds:generatedAxes,cleanup:()=>{
  if(armed){armed=false;f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:null});}
 }}),error=>error?.name==='StaleSourceError'&&/placement/i.test(error.message));
 assert.deepEqual(f.model.series.map(series=>[series.panel,series.axisId??null]),[['osc',null],['osc',null]]);
 assert.equal(f.model.axes.some(axis=>axis.id==='target-axis'),false);assert.equal(generatedAxes.has('target-axis'),false);
});

test('setPanelOrder notification rebind is rejected after final callback',t=>{
 let rebound=false;
 let f;
 f=fixture(t,()=>{
  if(f&&!rebound&&f.model.panels.map(panel=>panel.id).join(',')==='osc,target,price'){
   rebound=true;f.api.setIndicatorPlacement('macd',{panel:'osc',axisId:'osc-axis'});
  }
 });
 const frame=targetFrame();
 assert.throws(()=>applyLayoutFrame({api:f.api,frame,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),error=>error?.name==='StaleSourceError'&&/placement/i.test(error.message));
 assert.deepEqual(f.model.series.map(series=>[series.panel,series.axisId??null]),[['osc','osc-axis'],['osc','osc-axis']]);
});

test('setPanelOrder notification cannot remove an unused generated target',t=>{
 let armed=false,rebound=false;
 let f;
 f=fixture(t,()=>{
  if(armed&&!rebound&&f.model.panels.map(panel=>panel.id).join(',')==='osc,target,price'){
   rebound=true;armed=false;f.api.removeAxis('target-axis');f.api.removePanel('target');
  }
 });
 const frame={panelOrder:['osc','target','price'],placements:[
  {seriesId:'macd-line',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:'price',axisId:null},
 ],generatedPanels:[{id:'target',options:{weight:1}}],generatedAxes:[{id:'target-axis',panel:'target',options:{side:'right'}}]};
 const generatedPanels=new Set(),generatedAxes=new Set();
 armed=true;
 assert.throws(()=>applyLayoutFrame({api:f.api,frame,generatedPanelIds:generatedPanels,generatedAxisIds:generatedAxes}),error=>error?.name==='StaleSourceError'&&/target panel|cleanup/i.test(error.message));
 assert.equal(f.model.panels.some(panel=>panel.id==='target'),false);assert.equal(f.model.axes.some(axis=>axis.id==='target-axis'),false);
 assert.equal(generatedPanels.has('target'),false);assert.equal(generatedAxes.has('target-axis'),false);
});

test('setPanelOrder notification cannot publish a different managed panel order',t=>{
 let armed=false,reordered=false;
 let f;
 f=fixture(t,()=>{
  if(armed&&!reordered&&f.model.panels.map(panel=>panel.id).join(',')==='osc,target,price'){
   reordered=true;armed=false;f.api.setPanelOrder(['price','target','osc']);
  }
 });
 const frame=targetFrame(),generatedPanels=new Set(),generatedAxes=new Set();armed=true;
 assert.throws(()=>applyLayoutFrame({api:f.api,frame,generatedPanelIds:generatedPanels,generatedAxisIds:generatedAxes}),error=>error?.name==='StaleSourceError'&&/panel order/i.test(error.message));
 assert.deepEqual(f.model.panels.map(panel=>panel.id),['price','target','osc']);
});

test('clean and mixed groups satisfy exact postconditions',t=>{
 const f=fixture(t),frame=targetFrame();
 f.api.addIndicator('ema','ema',{period:3});
 f.api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema'});
 frame.placements.push({seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:null});
 frame.panelOrder=['osc','target','price'];
 assert.deepEqual(applyLayoutFrame({api:f.api,frame,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),{changed:true});
 assert.deepEqual(f.model.series.map(series=>[series.id,series.panel,series.axisId??null]),[
  ['macd-line','target','target-axis'],['macd-signal','target','target-axis'],['ema-line','price',null],
 ]);
});

test('clearSyntheticRange removes a captured pin after publication observer throws',t=>{
 const model=new ChartModel({panels:[{id:'generated'}]}),pins=new Map();const api=new ChartAPI(model,{invalidate(){}});
 t.after(()=>model.dispose());
 assert.equal(pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[1,2]}),true);
 api.invalidate=()=>{throw new Error('observer failed');};
 assert.throws(()=>clearSyntheticRange({model,api,pins,kind:'panel',id:'generated'}),/observer failed/);
 assert.equal(model.panels[0].range,undefined);
 assert.equal(pins.size,0);
});

test('clearSyntheticRange preserves a nested replacement pin after observer throws',t=>{
 const model=new ChartModel({panels:[{id:'generated'}]}),pins=new Map();let replacement;
 const api=new ChartAPI(model,{invalidate(){
  replacement={model,range:[3,4],rangeRef:[3,4]};pins.set('generated',replacement);throw new Error('observer failed');
 }});
 t.after(()=>model.dispose());
 api.invalidate=()=>{};assert.equal(pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[1,2]}),true);
 api.invalidate=()=>{replacement={model,range:[3,4],rangeRef:[3,4]};pins.set('generated',replacement);throw new Error('observer failed');};
 assert.throws(()=>clearSyntheticRange({model,api,pins,kind:'panel',id:'generated'}),/observer failed/);
 assert.strictEqual(pins.get('generated'),replacement);assert.deepEqual(model.panels[0].range,undefined);
});

test('clearSyntheticRange preserves a nested replacement pin after a successful observer',t=>{
 const model=new ChartModel({panels:[{id:'generated'}]}),pins=new Map(),api=new ChartAPI(model);let replacement;
 t.after(()=>model.dispose());
 pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[1,2]});
 api.invalidate=()=>{replacement={model,range:[3,4],rangeRef:[3,4]};pins.set('generated',replacement);};
 assert.equal(clearSyntheticRange({model,api,pins,kind:'panel',id:'generated'}),true);
 assert.strictEqual(pins.get('generated'),replacement);
});

test('clearSyntheticRange preserves a pin rebound in place to a newer model',t=>{
 const model=new ChartModel({panels:[{id:'generated',range:[1,2]}]}),pins=new Map();let replacement,owner=model;
 const api=new ChartAPI(model,{invalidate(){
  replacement=new ChartModel({panels:[{id:'generated',range:[1,2]}]});
  rebindSyntheticRangePins(replacement,pins,new Map());owner=replacement;
 }});
 t.after(()=>{model.dispose();replacement?.dispose();});
 const originalRange=model.panels[0].range;
 pins.set('generated',{model,range:[1,2],rangeRef:originalRange});
 assert.throws(()=>clearSyntheticRange({model,api,pins,kind:'panel',id:'generated',assertOwner(){if(owner!==model)throw new Error('owner changed');}}),/owner changed/);
 const entry=pins.get('generated');assert.ok(entry);assert.strictEqual(entry.model,replacement);assert.strictEqual(entry.rangeRef,replacement.panels[0].range);
 assert.equal(model.panels[0].range,undefined);
});
