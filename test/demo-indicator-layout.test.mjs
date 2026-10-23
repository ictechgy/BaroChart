import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChartModel,ChartAPI,builtinIndicators} from '../src/core/index.mjs';
import {collectIndicatorGroups,copyPanelProjection,copyAxisProjection,uniqueLayoutId} from '../examples/web/indicator-layout.mjs';

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

test('main demo exposes the indicator layout controls and public API calls',async()=>{
 const html=await readFile(new URL('../examples/web/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../examples/web/demo.mjs',import.meta.url),'utf8');
 for(const id of ['indicator-layout-section','layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down','indicator-layout-status'])assert.match(html,new RegExp('\\bid="'+id+'"'));
 assert.match(html,/role="status"[^>]*id="indicator-layout-status"|id="indicator-layout-status"[^>]*role="status"/);
 assert.match(source,/setIndicatorPlacement/);
 assert.match(source,/setPanelOrder/);
});
