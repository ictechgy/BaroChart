import test from 'node:test';
import assert from 'node:assert/strict';
import * as market from '../src/core/markets.mjs';
import {BarStore} from '../src/core/data.mjs';
import {ChartModel,createLayout} from '../src/core/model.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {drawingGeometry,DRAWING_TYPES,drawingPointCount} from '../src/core/drawings.mjs';
import {createFinancialFixture,periodExamples,inspectFinancialCursor} from '../examples/web/financial.mjs';

test('exact alignment leaves gaps and ignores points absent from the reference timeline',()=>{
 assert.equal(typeof market.alignSeriesByTime,'function');
 const reference=new Float64Array([0,60000,120000,180000]),points=[{time:60000,value:10},{time:90000,value:99},{time:180000,value:30}];
 const out=market.alignSeriesByTime(reference,points);
 assert.ok(out instanceof Float64Array);assert.deepEqual(out,new Float64Array([NaN,10,NaN,30]));
 points[0].value=200;assert.equal(out[1],10,'result owns its values');
 assert.deepEqual(market.alignSeriesByTime([0,1,2],[{time:0,value:null},{time:1,value:NaN},{time:2,value:-0}]),new Float64Array([NaN,NaN,-0]));
 assert.ok(Object.is(market.alignSeriesByTime([0],[{time:0,value:-0}])[0],-0));
});
test('alignment rejects duplicate/unsorted/inexact times and nonnumeric values even outside the reference',()=>{
 assert.equal(typeof market.alignSeriesByTime,'function');
 for(const reference of [[0,0],[1,0],[.5],['0'],[8640000000000001]])assert.throws(()=>market.alignSeriesByTime(reference,[]));
 for(const points of [[{time:0,value:1},{time:0,value:2}],[{time:2,value:1},{time:1,value:2}],[{time:.5,value:1}],[{time:999,value:Infinity}],[{time:999,value:'1'}],[{time:999}],[{time:999,value:undefined}]])assert.throws(()=>market.alignSeriesByTime([0],points));
 assert.deepEqual(market.alignSeriesByTime([],[]),new Float64Array());assert.deepEqual(market.alignSeriesByTime([0,1],[]),new Float64Array([NaN,NaN]));
});
test('example fixed UTC observations and cursor axis value remain separate from the nearest real bar',()=>{
 const f=createFinancialFixture();assert.equal(f.bars.length,20);assert.equal(f.points.length,16);assert.deepEqual([f.matched,f.gaps,f.unmatched],[12,8,4]);
 assert.equal(f.bars[0].time,Date.parse('2026-02-06T14:30:00Z'));assert.equal(f.bars[10].time,Date.parse('2026-02-09T14:30:00Z'));
 for(const b of f.bars)assert.ok(f.calendarA.at(b.time));for(const p of f.points)assert.ok(f.calendarB.at(p.time));
 const model=new ChartModel({store:new BarStore(f.bars),panels:[{id:'price',scale:'percent',base:100,range:[80,140],padding:0}]});model.addSeries({id:'a',type:'candles',panel:'price'});model.fit();const layout=createLayout(model,1000,500);
 const reading=inspectFinancialCursor(model,layout,f.aligned,layout.x(1.4),layout.panels[0].y(110));
 assert.equal(reading.index,1);assert.deepEqual(reading.bar,{time:Date.parse('2026-02-06T15:00:00Z'),open:100.5,high:102.8,low:98.8,close:100.8,volume:112});assert.equal(reading.foreignValue,102.6);
 assert.ok(Math.abs(reading.cursorPrice-110)<1e-10);assert.ok(Math.abs(reading.cursorAxisValue-10)<1e-10);assert.notEqual(reading.cursorPrice,reading.bar.close);
 const missing=inspectFinancialCursor(model,layout,f.aligned,layout.x(4.1),layout.panels[0].y(111));assert.equal(missing.bar.time,Date.parse('2026-02-06T16:30:00Z'));assert.ok(Number.isNaN(missing.foreignValue));
 assert.equal(inspectFinancialCursor(model,layout,f.aligned,-1,-1),null);for(const row of periodExamples())assert.equal(row.actual,row.expected);model.dispose();
});
test('all drawing anchors and geometry roundtrip on log/percent/inverted axes with a weekend gap',()=>{
 const bars=[{time:Date.parse('2026-02-06T20:59:00Z'),open:100,high:120,low:90,close:110,volume:1},{time:Date.parse('2026-02-09T14:30:00Z'),open:110,high:130,low:100,close:120,volume:2}];
 for(const scale of ['log','percent'])for(const inverted of [false,true]){
  const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price',scale,inverted,base:100,range:[50,200],padding:0}]}),api=new ChartAPI(model);
  model.addSeries({id:'price',type:'candles',panel:'price'});model.fit();
  for(const type of DRAWING_TYPES){const points=['longposition','shortposition'].includes(type)?[{time:bars[0].time,price:100},{time:bars[0].time,price:type==='longposition'?90:110},{time:bars[0].time,price:type==='longposition'?120:80},{time:bars[1].time,price:100}]:Array.from({length:drawingPointCount(type)},(_,i)=>({time:bars[0].time+(bars[1].time-bars[0].time)*(i+1)/4,price:80+i*30}));api.addDrawing({id:type,type,points,...(type==='text'?{text:'휴장 구간 / 한글 🚀'}:{})});}
  const layout=createLayout(model,1000,500),saved=api.saveDrawings(),before=model.drawings.items.map(d=>drawingGeometry(d,layout));
  api.loadDrawings(saved);assert.equal(api.saveDrawings(),saved);assert.deepEqual(model.drawings.items.map(d=>drawingGeometry(d,layout)),before);
  for(const d of model.drawings.items)for(const point of d.points){const xy=layout.toScreen(point,'price'),back=layout.fromScreen(xy.x,xy.y,'price');assert.ok(Math.abs(back.time-point.time)<=.001);assert.ok(Math.abs(back.price-point.price)<1e-10);}
  model.dispose();
 }
});
