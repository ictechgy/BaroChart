import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,InteractionController} from '../src/core/index.mjs';
import {applyLayoutFrame} from '../examples/web/apply-layout-frame.mjs';

const bars=Array.from({length:32},(_,index)=>({time:1700000000000+index*60000,open:100+index,high:103+index,low:98+index,close:101+index,volume:100+index}));

function fixture(t,{controller=true}={}){
 const model=new ChartModel({store:new BarStore(bars),panels:[
  {id:'price',weight:3,label:'PRICE',range:[90,180],precision:2},
  {id:'osc',weight:1,label:'OSC',range:[0,100],precision:0},
  {id:'extra',weight:1,label:'EXTRA'},
 ],axes:[
  {id:'osc-axis',panel:'osc',side:'left',range:[0,100],label:'OSC AXIS'},
 ]});
 let invalidations=0;
 const input=controller?new InteractionController(model,()=>({width:800,height:500})):null;
 const api=new ChartAPI(model,{controller:input,invalidate:()=>{invalidations++;}});
 api.addIndicator('macd','macd',{fast:3,slow:7,signal:2});
 api.addIndicator('ema','ema',{period:3});
 api.addSeries({id:'price-series',type:'candles',panel:'price'});
 api.addSeries({id:'macd-line',type:'line',panel:'price',indicator:'macd',output:'macd',color:'#123456',width:3,offset:2});
 api.addSeries({id:'macd-signal',type:'line',panel:'osc',axisId:'osc-axis',indicator:'macd',output:'signal',color:'#abcdef'});
 api.addSeries({id:'macd-histogram',type:'histogram',panel:'price',indicator:'macd',output:'histogram',color:'#fedcba'});
 api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#beefed'});
 t.after(()=>model.dispose());
 return {model,api,input,get invalidations(){return invalidations;}};
}

function frame({order=['osc','new','extra','price'],placements,generatedPanels,generatedAxes}={}){
 return {panelOrder:order,placements:placements??[
  {seriesId:'macd-line',indicatorId:'macd',panelId:'new',axisId:'new-axis'},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:'new',axisId:null},
  {seriesId:'macd-histogram',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:null},
 ],generatedPanels:generatedPanels??[{id:'new',options:{weight:2,label:'NEW',padding:.1}}],generatedAxes:generatedAxes??[{id:'new-axis',panel:'new',options:{side:'right',label:'NEW AXIS'}}]};
}

test('applies uniform and mixed indicator bindings without recalculation or unrelated state changes',t=>{
 const f=fixture(t),entry=f.model.indicators.entries.get('macd'),arrays=entry.arrays.slice(),seriesRefs=f.model.series.slice(),cacheRefs=f.model.series.map(series=>({series,index:series.rangeIndex,revision:series.revision,dirty:series.dirtyFrom})),drawings=f.model.drawings,theme={...f.model.theme},view=f.model.view,params={...entry.params};
 const drawingId=drawings.add({id:'keep',type:'horizontal',panel:'extra',points:[{time:bars[2].time,price:110}]});
 const items=drawings.items;
 const generatedPanels=new Set(['osc','legacy-panel']),generatedAxes=new Set(['osc-axis','legacy-axis']);let cleanupDomains,cleanupProtection;
 f.model.indicators.get=()=>{throw new Error('layout application must not calculate indicators');};
 const result=applyLayoutFrame({api:f.api,frame:frame({generatedPanels:[
  {id:'osc',options:{weight:99,label:'SHOULD STAY',range:[-1,1]}},
  {id:'new',options:{weight:2,label:'NEW',padding:.1}},
 ],generatedAxes:[
  {id:'osc-axis',panel:'osc',options:{side:'right',label:'SHOULD STAY',range:[-1,1]}},
  {id:'new-axis',panel:'new',options:{side:'right',label:'NEW AXIS'}},
 ]}),generatedPanelIds:generatedPanels,generatedAxisIds:generatedAxes,domains:{token:'domains'},cleanup:(domains,protection)=>{cleanupDomains=domains;cleanupProtection=protection;}});
 assert.deepEqual(result,{changed:true});
 assert.deepEqual(cleanupDomains,{token:'domains'});
 assert.deepEqual([...cleanupProtection.panels],['osc','new','extra','price']);assert.deepEqual([...cleanupProtection.axes].sort(),['new-axis','osc-axis']);
 assert.deepEqual(f.model.panels.map(panel=>panel.id),['osc','new','extra','price']);
 assert.deepEqual(f.model.axes.map(axis=>[axis.id,axis.panel]),[['osc-axis','osc'],['new-axis','new']]);
 assert.deepEqual(f.model.series.filter(series=>series.indicator==='macd').map(series=>[series.id,series.panel,series.axisId??null]),[
  ['macd-line','new','new-axis'],['macd-signal','new',null],['macd-histogram','price',null],
 ]);
 assert.equal(f.model.panels.find(panel=>panel.id==='osc').weight,1);
 assert.equal(f.model.panels.find(panel=>panel.id==='osc').label,'OSC');
 assert.deepEqual(f.model.panels.find(panel=>panel.id==='osc').range,[0,100]);
 assert.equal(f.model.axes.find(axis=>axis.id==='osc-axis').side,'left');
 assert.deepEqual(f.model.axes.find(axis=>axis.id==='osc-axis').range,[0,100]);
 assert.deepEqual([...generatedPanels],['osc','legacy-panel','new']);
 assert.deepEqual([...generatedAxes],['osc-axis','legacy-axis','new-axis']);
 assert.strictEqual(f.model.drawings,drawings);assert.strictEqual(drawings.items,items);assert.equal(drawings.items[0].id,drawingId);
 assert.strictEqual(f.model.view,view);assert.deepEqual(f.model.theme,theme);
 assert.strictEqual(f.model.indicators.entries.get('macd'),entry);assert.deepEqual(entry.params,params);assert.deepEqual(entry.arrays,arrays);
 assert.strictEqual(f.model.series[0],seriesRefs[0]);
 for(const before of cacheRefs){const after=f.model.series.find(series=>series.id===before.series.id);assert.strictEqual(after.rangeIndex,before.index);assert.equal(after.revision,before.revision);assert.equal(after.dirtyFrom,before.dirty);}
 assert.equal(f.model.series.find(series=>series.id==='macd-line').color,'#123456ff');assert.equal(f.model.series.find(series=>series.id==='macd-line').offset,2);
});

test('cleanup may remove an unreferenced generated resource through the guarded API before stable merge ordering',t=>{
 const f=fixture(t),generatedPanels=new Set(['extra']),generatedAxes=new Set(),removed=[];
 const target=frame({order:['price','osc','new'],generatedPanels:[{id:'new',options:{weight:1}}],generatedAxes:[],placements:[
  {seriesId:'macd-line',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:'osc',axisId:null},
  {seriesId:'macd-histogram',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:null},
 ]});
 const result=applyLayoutFrame({api:f.api,frame:target,generatedPanelIds:generatedPanels,generatedAxisIds:generatedAxes,cleanup:()=>{f.api.removePanel('extra');removed.push('extra');generatedPanels.delete('extra');}});
 assert.deepEqual(result,{changed:true});assert.deepEqual(removed,['extra']);assert.deepEqual(f.model.panels.map(panel=>panel.id),['price','osc','new']);
});

test('preflight rejects stale membership, missing resources, malformed order, and active input before publication',t=>{
 const f=fixture(t),beforePanels=f.model.panels,beforeAxes=f.model.axes,beforeSeries=f.model.series,notices=f.invalidations;
 const valid=frame();
 const cases=[
  {...valid,placements:valid.placements.map(placement=>placement.seriesId==='macd-line'?{...placement,indicatorId:'wrong'}:placement)},
  {...valid,panelOrder:['osc','missing','extra','price']},
  {...valid,panelOrder:['osc','osc','extra','price']},
  {...valid,generatedAxes:[{id:'new-axis',panel:'wrong',options:{}}]},
 ];
 for(const bad of cases){assert.throws(()=>applyLayoutFrame({api:f.api,frame:bad,generatedPanelIds:new Set(),generatedAxisIds:new Set()}));assert.strictEqual(f.model.panels,beforePanels);assert.strictEqual(f.model.axes,beforeAxes);assert.strictEqual(f.model.series,beforeSeries);assert.equal(f.invalidations,notices);}
 f.input.gesture={kind:'pan'};assert.throws(()=>applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),/gesture/);f.input.gesture=null;
 f.input.pointers.set(1,{x:1,y:1});assert.throws(()=>applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),/gesture/);f.input.pointers.clear();
 f.model.drawings.begin();assert.throws(()=>applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),/transaction/);f.model.drawings.cancel();
 assert.strictEqual(f.model.panels,beforePanels);assert.strictEqual(f.model.axes,beforeAxes);assert.strictEqual(f.model.series,beforeSeries);assert.equal(f.invalidations,notices);
});

test('no-op preserves resources and notification count, while foreign ownership is rejected',t=>{
 const f=fixture(t),valid=frame({order:['price','osc','extra'],placements:[
  {seriesId:'macd-line',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:'osc',axisId:'osc-axis'},
  {seriesId:'macd-histogram',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:null},
 ],generatedPanels:[],generatedAxes:[]}),notices=f.invalidations,panels=f.model.panels,axes=f.model.axes,series=f.model.series;
 assert.deepEqual(applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),{changed:false});assert.equal(f.invalidations,notices);assert.strictEqual(f.model.panels,panels);assert.strictEqual(f.model.axes,axes);assert.strictEqual(f.model.series,series);
 const foreign=new ChartModel({store:new BarStore(bars)});t.after(()=>foreign.dispose());
 assert.throws(()=>applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set(),assertOwner(){throw new Error('foreign owner');}}),/foreign owner/);assert.strictEqual(f.model.panels,panels);
});

test('reports panel order changes even when every panel configuration is identical',t=>{
 const f=fixture(t),valid=frame({order:['osc','price','extra'],placements:[
  {seriesId:'macd-line',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'macd-signal',indicatorId:'macd',panelId:'osc',axisId:'osc-axis'},
  {seriesId:'macd-histogram',indicatorId:'macd',panelId:'price',axisId:null},
  {seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:null},
 ],generatedPanels:[],generatedAxes:[]});
 assert.deepEqual(applyLayoutFrame({api:f.api,frame:valid,generatedPanelIds:new Set(),generatedAxisIds:new Set()}),{changed:true});
 assert.deepEqual(f.model.panels.map(panel=>panel.id),['osc','price','extra']);
});

function panelLimitFixture(t,retained){
 const panels=Array.from({length:31},(_,index)=>({id:'panel-'+index}));panels.push({id:'old-panel'});
 const model=new ChartModel({store:new BarStore(bars),panels});const api=new ChartAPI(model);api.addIndicator('ema','ema',{period:3});api.addSeries({id:'ema-line',type:'line',panel:'panel-0',indicator:'ema'});
 if(retained==='used')api.addSeries({id:'old-line',type:'line',panel:'old-panel',indicator:'ema'});
 if(retained==='drawing')model.drawings.add({id:'old-panel-drawing',type:'horizontal',panel:'old-panel',points:[{time:bars[0].time,price:110}]});
 t.after(()=>model.dispose());return {model,api};
}

function panelLimitFrame(){return {panelOrder:[...Array.from({length:31},(_,index)=>'panel-'+index),'new-panel'],placements:[{seriesId:'ema-line',indicatorId:'ema',panelId:'panel-0',axisId:null},...[{seriesId:'old-line',indicatorId:'ema',panelId:'panel-0',axisId:null}].filter(()=>false)],generatedPanels:[{id:'new-panel',options:{weight:1}}],generatedAxes:[]};}

for(const retained of ['unreferenced','used','drawing'])test(`panel limit swap handles ${retained} extras before creation`,t=>{
 const f=panelLimitFixture(t,retained),generatedPanels=new Set(['old-panel']),calls=[];
 const target=panelLimitFrame();if(retained==='used')target.placements.push({seriesId:'old-line',indicatorId:'ema',panelId:'panel-0',axisId:null});
 const cleanup=()=>{calls.push('cleanup');if(f.model.panels.some(panel=>panel.id==='old-panel')){try{f.api.removePanel('old-panel');generatedPanels.delete('old-panel');}catch{}}};
 if(retained==='unreferenced'){assert.deepEqual(applyLayoutFrame({api:f.api,frame:target,generatedPanelIds:generatedPanels,generatedAxisIds:new Set(),cleanup}),{changed:true});assert.equal(f.model.panels.length,32);assert.equal(f.model.panels.some(panel=>panel.id==='new-panel'),true);assert.ok(calls.length>=1);}
 else {assert.throws(()=>applyLayoutFrame({api:f.api,frame:target,generatedPanelIds:generatedPanels,generatedAxisIds:new Set(),cleanup}),/Panel limit/);assert.equal(f.model.panels.length,32);assert.equal(f.model.panels.some(panel=>panel.id==='old-panel'),true);assert.equal(f.model.panels.some(panel=>panel.id==='new-panel'),false);assert.ok(calls.length>=1);}
});

function axisLimitFixture(t,retained){
 const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price'}],axes:[...Array.from({length:63},(_,index)=>({id:'axis-'+index,panel:'price'})),{id:'old-axis',panel:'price'}]});const api=new ChartAPI(model);api.addIndicator('ema','ema',{period:3});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',...(retained==='used'?{axisId:'old-axis'}:{})});
 if(retained==='drawing')model.drawings.add({id:'old-axis-drawing',type:'horizontal',panel:'price',axisId:'old-axis',points:[{time:bars[0].time,price:110}]});
 t.after(()=>model.dispose());return {model,api};
}

function axisLimitFrame(){return {panelOrder:['price'],placements:[{seriesId:'ema-line',indicatorId:'ema',panelId:'price',axisId:'new-axis'}],generatedPanels:[],generatedAxes:[{id:'new-axis',panel:'price',options:{side:'right'}}]};}

for(const retained of ['unreferenced','used','drawing'])test(`axis limit swap handles ${retained} extras before creation`,t=>{
 const f=axisLimitFixture(t,retained),generatedAxes=new Set(['old-axis']),calls=[];
 const cleanup=()=>{calls.push('cleanup');if(f.model.axes.some(axis=>axis.id==='old-axis')){try{f.api.removeAxis('old-axis');generatedAxes.delete('old-axis');}catch{}}};
 if(retained==='unreferenced'){assert.deepEqual(applyLayoutFrame({api:f.api,frame:axisLimitFrame(),generatedPanelIds:new Set(),generatedAxisIds:generatedAxes,cleanup}),{changed:true});assert.equal(f.model.axes.length,64);assert.equal(f.model.axes.some(axis=>axis.id==='new-axis'),true);assert.equal(f.model.series[0].axisId,'new-axis');assert.ok(calls.length>=1);}
 else {assert.throws(()=>applyLayoutFrame({api:f.api,frame:axisLimitFrame(),generatedPanelIds:new Set(),generatedAxisIds:generatedAxes,cleanup}),/Axis limit/);assert.equal(f.model.axes.length,64);assert.equal(f.model.axes.some(axis=>axis.id==='old-axis'),true);assert.equal(f.model.axes.some(axis=>axis.id==='new-axis'),false);assert.ok(calls.length>=1);}
});

test('same-owner notification removal rejects and clears provisional ownership',t=>{
 const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price'}]});let armed=true;const api=new ChartAPI(model,{invalidate(){if(armed){armed=false;model.panels=[];}}});t.after(()=>model.dispose());
 const generatedPanels=new Set();const frame={panelOrder:['new-panel'],placements:[],generatedPanels:[{id:'new-panel',options:{weight:1}}],generatedAxes:[]};
 assert.throws(()=>applyLayoutFrame({api,frame,generatedPanelIds:generatedPanels,generatedAxisIds:new Set()}),/owner changed|removed|target panel/i);assert.equal(generatedPanels.has('new-panel'),false);assert.equal(model.panels.length,0);
});

test('observer owner replacement stops work and does not touch the newer model',t=>{
 const f=fixture(t),next=new ChartModel({store:new BarStore(bars),panels:[{id:'price'}]});t.after(()=>next.dispose());let owner=f.model,generatedPanels=new Set();
 const originalInvalidate=f.api.invalidate;f.api.invalidate=function(){owner=next;return originalInvalidate.call(this);};
 const beforeNext=next.panels.slice();assert.throws(()=>applyLayoutFrame({api:f.api,frame:frame(),generatedPanelIds:generatedPanels,generatedAxisIds:new Set(),assertOwner(){if(owner!==f.model)throw new Error('newer owner');}}),/newer owner/);
 assert.strictEqual(owner,next);assert.deepEqual(next.panels,beforeNext);assert.equal(generatedPanels.has('new'),true);
});
