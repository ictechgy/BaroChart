import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChartModel,ChartAPI,builtinIndicators,createLayout} from '../src/core/index.mjs';
import {modelRequest} from '../src/web/worker-state.mjs';
import {collectIndicatorGroups,copyPanelProjection,copyAxisProjection,uniqueLayoutId,captureLayoutDomains,pinSyntheticRange,clearSyntheticRange,rebindSyntheticRangePins,pruneSyntheticRangePins} from '../examples/web/indicator-layout.mjs';

function fixture(t){
 const model=new ChartModel({panels:[
  {id:'price',weight:3.5},
  {id:'rsi',weight:1,range:[0,100],precision:0},
  {id:'shared',weight:1}
 ],axes:[{id:'rsi-axis',panel:'rsi',range:[0,100],precision:0,side:'right'}]});
 const api=new ChartAPI(model);
 api.addIndicator('rsi','rsi',{period:14});
 api.addIndicator('macd','macd',{});
 api.addSeries({id:'price',type:'candles',panel:'price'});
 api.addSeries({id:'rsi-line',type:'line',panel:'rsi',indicator:'rsi',axisId:'rsi-axis'});
 for(const output of builtinIndicators.get('macd')({}).outputs.filter(output=>output!=='direction'))
  api.addSeries({id:'macd-'+output,type:output==='histogram'?'histogram':'line',panel:'shared',indicator:'macd',output});
 t.after(()=>model.dispose());
 return {model,api};
}

test('indicator groups derive every rendered output from the model',t=>{
 const {model}=fixture(t),groups=collectIndicatorGroups(model);
 assert.deepEqual(groups.map(group=>group.id),['rsi','macd']);
 assert.deepEqual(groups.find(group=>group.id==='macd').series.map(series=>series.output),['macd','signal','histogram']);
 assert.equal(groups.find(group=>group.id==='rsi').panelId,'rsi');
 assert.equal(groups.find(group=>group.id==='rsi').axisId,'rsi-axis');
});

test('projection copying preserves a single origin and falls back for mixed origins',t=>{
 const {model}=fixture(t),groups=collectIndicatorGroups(model),rsi=groups.find(group=>group.id==='rsi'),macd=groups.find(group=>group.id==='macd');
 assert.deepEqual(copyPanelProjection(model,rsi),{weight:1,scale:'linear',inverted:false,padding:.08,range:[0,100],precision:0});
 assert.deepEqual(copyAxisProjection(model,rsi),{side:'right',scale:'linear',inverted:false,padding:.08,range:[0,100],precision:0,tickFormat:'fixed',visible:true});
 assert.deepEqual(copyAxisProjection(model,macd),{side:'right',scale:'linear',inverted:false,padding:.08,tickFormat:'fixed',visible:true});
});

test('percent primary projection resolves the engine base before creating an independent axis',t=>{
 const model=new ChartModel({panels:[{id:'price',scale:'percent',weight:3},{id:'target',weight:1}]});
 const api=new ChartAPI(model);api.setData([{time:1,open:100,high:125,low:95,close:120,volume:1}]);api.addIndicator('ema','ema',{period:2});api.addSeries({id:'price',type:'candles',panel:'price'});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema'});
 t.after(()=>model.dispose());
 const group=collectIndicatorGroups(model).find(candidate=>candidate.id==='ema'),projection=copyAxisProjection(model,group);
 assert.equal(projection.scale,'percent');assert.equal(projection.base,120);assert.doesNotThrow(()=>api.addAxis({id:'ema-axis',panel:'target',...projection}));
});

test('generated panel and axis ids are collision checked',t=>{
 const {model}=fixture(t);
 assert.equal(uniqueLayoutId('rsi-panel',new Set(model.panels.map(panel=>panel.id))),'rsi-panel');
 assert.equal(uniqueLayoutId('rsi',new Set(model.panels.map(panel=>panel.id))),'rsi-2');
 assert.equal(uniqueLayoutId('other-axis',new Set(model.axes.map(axis=>axis.id))),'other-axis');
 assert.equal(uniqueLayoutId('rsi-axis',new Set(['rsi-axis'])),'rsi-axis-2');
});

test('synthetic retained ranges use the prior raw scene domain and resume autoscale when reused',t=>{
 const model=new ChartModel({panels:[{id:'price',weight:3},{id:'generated',weight:1}]});
 const api=new ChartAPI(model),pins=new Map();api.setData(Array.from({length:24},(_,i)=>({time:i+1,open:10+i,high:14+i,low:8+i,close:12+i,volume:1})));
 api.addIndicator('atr','atr',{period:3});api.addSeries({id:'atr-line',type:'line',panel:'generated',indicator:'atr'});
 const prior=captureLayoutDomains(model,{layout:createLayout(model,1000,600)}).panels.get('generated');assert.deepEqual(prior,(()=>{const axis=createLayout(model,1000,600).axis('generated');return [axis.min,axis.max];})());assert.ok(prior[0]<prior[1]);
 api.removeIndicator('atr');assert.equal(model.panels.find(panel=>panel.id==='generated').range,undefined);
 assert.equal(pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:prior}),true);
 assert.deepEqual(model.panels.find(panel=>panel.id==='generated').range,prior);
 api.addIndicator('atr','atr',{period:3});api.addSeries({id:'atr-line',type:'line',panel:'generated',indicator:'atr'});
 assert.equal(clearSyntheticRange({model,api,pins,kind:'panel',id:'generated'}),true);
 assert.equal(model.panels.find(panel=>panel.id==='generated').range,undefined);assert.equal(pins.size,0);
 t.after(()=>model.dispose());
});

test('synthetic range tracking survives worker-shaped reloads and preserves later manual ranges',t=>{
 const first=new ChartModel({panels:[{id:'generated',weight:1}]});const firstAPI=new ChartAPI(first),pins=new Map();firstAPI.setData(Array.from({length:12},(_,i)=>({time:i+1,open:100,high:102,low:98,close:101,volume:1})));
 const range=[97,103];assert.equal(pinSyntheticRange({model:first,api:firstAPI,pins,kind:'panel',id:'generated',range}),true);
 const next=new ChartModel({panels:[{id:'generated',weight:1,range:[...range]}]});const nextAPI=new ChartAPI(next);rebindSyntheticRangePins(next,pins,new Map());assert.equal(clearSyntheticRange({model:next,api:nextAPI,pins,kind:'panel',id:'generated'}),true);assert.equal(next.panels[0].range,undefined);
 pinSyntheticRange({model:next,api:nextAPI,pins,kind:'panel',id:'generated',range});const manual=[90,110];nextAPI.setPanel('generated',{range:manual});assert.equal(pruneSyntheticRangePins(next,pins,new Map()),true);assert.equal(clearSyntheticRange({model:next,api:nextAPI,pins,kind:'panel',id:'generated'}),false);assert.deepEqual(next.panels[0].range,manual);
 t.after(()=>{first.dispose();next.dispose();});
});

test('primary and independent synthetic pins are tracked separately',t=>{
 const model=new ChartModel({panels:[{id:'generated',weight:1}],axes:[{id:'generated-axis',panel:'generated'}]}),api=new ChartAPI(model),panelPins=new Map(),axisPins=new Map();api.setData([{time:1,open:10,high:20,low:5,close:15,volume:1}]);
 assert.equal(pinSyntheticRange({model,api,pins:panelPins,kind:'panel',id:'generated',range:[0,1]}),true);assert.equal(pinSyntheticRange({model,api,pins:axisPins,kind:'axis',id:'generated-axis',range:[4,24]}),true);
 assert.equal(model.panels[0].range[0],0);assert.equal(model.axes[0].range[0],4);assert.equal(clearSyntheticRange({model,api,pins:panelPins,kind:'panel',id:'generated'}),true);assert.equal(clearSyntheticRange({model,api,pins:axisPins,kind:'axis',id:'generated-axis'}),true);assert.equal(model.panels[0].range,undefined);assert.equal(model.axes[0].range,undefined);
 t.after(()=>model.dispose());
});

test('synthetic range ownership survives a reload started by the commit notification',t=>{
 const model=new ChartModel({panels:[{id:'generated',weight:1}]}),pins=new Map();let replacement,owner=model;
 const api=new ChartAPI(model,{invalidate(){replacement=new ChartModel(modelRequest(model));rebindSyntheticRangePins(replacement,pins,new Map());owner=replacement;}});
 t.after(()=>{model.dispose();replacement?.dispose();});
 assert.throws(()=>pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[40,60],assertOwner(){if(owner!==model)throw new Error('owner changed');}}),/owner changed/);
 assert.deepEqual(replacement.panels[0].range,[40,60]);
 assert.equal(clearSyntheticRange({model:replacement,api:new ChartAPI(replacement),pins,kind:'panel',id:'generated'}),true);
 assert.equal(replacement.panels[0].range,undefined);
});

test('synthetic pins distinguish rejected mutations from errors after publication',t=>{
 const model=new ChartModel({panels:[{id:'generated',weight:1,scale:'log'}]}),pins=new Map(),api=new ChartAPI(model);
 t.after(()=>model.dispose());
 assert.throws(()=>pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[-1,1]}),/scale\/range/);
 assert.equal(pins.size,0);assert.equal(model.panels[0].range,undefined);
 api.invalidate=()=>{throw new Error('observer failed');};
 assert.throws(()=>pinSyntheticRange({model,api,pins,kind:'panel',id:'generated',range:[40,60]}),/observer failed/);
 api.invalidate=()=>{};
 assert.equal(clearSyntheticRange({model,api,pins,kind:'panel',id:'generated'}),true);
 assert.equal(model.panels[0].range,undefined);
});

test('main demo exposes the indicator layout controls and public API calls',async()=>{
 const html=await readFile(new URL('../examples/web/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../examples/web/demo.mjs',import.meta.url),'utf8');
 for(const id of ['indicator-layout-section','layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down','indicator-layout-status'])assert.match(html,new RegExp('\\bid="'+id+'"'));
 assert.match(html,/role="status"[^>]*id="indicator-layout-status"|id="indicator-layout-status"[^>]*role="status"/);
 assert.match(source,/setIndicatorPlacement/);
 assert.match(source,/setPanelOrder/);
});
