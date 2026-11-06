import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI,ChartModel} from '../src/core/index.mjs';

const stale = error => error?.name === 'StaleSourceError';

test('addPanel rejects a reentrant duplicate without undoing the inner add',()=>{
 const model=new ChartModel(),api=new ChartAPI(model);let once=true;
 try {
  assert.throws(()=>api.addPanel({id:'dup',get weight(){if(once){once=false;api.addPanel({id:'dup',weight:1});}return 1;}}),stale);
  assert.deepEqual(model.panels.map(panel=>panel.id),['price','dup']);
 } finally { model.dispose(); }
});

test('addAxis rejects a reentrant duplicate without undoing the inner add',()=>{
 const model=new ChartModel(),api=new ChartAPI(model);let once=true;
 try {
  assert.throws(()=>api.addAxis({id:'dup',panel:'price',get visible(){if(once){once=false;api.addAxis({id:'dup',panel:'price'});}return true;}}),stale);
  assert.deepEqual(model.axes.map(axis=>axis.id),['dup']);
 } finally { model.dispose(); }
});

test('ChartModel.addSeries rejects a reentrant duplicate without undoing the inner add',()=>{
 const model=new ChartModel();let once=true;
 try {
  assert.throws(()=>model.addSeries({id:'dup',type:'line',panel:'price',get width(){if(once){once=false;model.addSeries({id:'dup',type:'line',panel:'price'});}return 1;}}),stale);
  assert.deepEqual(model.series.map(series=>series.id),['dup']);
 } finally { model.dispose(); }
});

test('ChartModel.addSeries rejects a reentrant axis binding change',()=>{
 const model=new ChartModel();let once=true;
 try {
  assert.throws(()=>model.addSeries({id:'line',type:'line',panel:'price',get axisId(){if(once){once=false;model.addAxis({id:'axis',panel:'price'});}return 'axis';}}),stale);
  assert.deepEqual(model.series,[]);
  assert.deepEqual(model.axes.map(axis=>axis.id),['axis']);
 } finally { model.dispose(); }
});

test('ChartModel.addAxis rejects a reentrant panel replacement',()=>{
 const model=new ChartModel();let once=true;
 try {
  assert.throws(()=>model.addAxis({id:'axis',get panel(){if(once){once=false;model.setPanel('price',{label:'rebound'});}return 'price';}}),stale);
  assert.deepEqual(model.axes,[]);
  assert.equal(model.panels[0].label,'rebound');
 } finally { model.dispose(); }
});

test('ChartModel.addSeries rejects a reentrant indicator removal',()=>{
 const model=new ChartModel();model.indicators.add('x','sma',{period:2});let once=true;
 try {
  assert.throws(()=>model.addSeries({id:'xline',type:'line',panel:'price',indicator:'x',get output(){if(once){once=false;model.indicators.remove('x');}return 'value';}}),stale);
  assert.deepEqual(model.series,[]);
  assert.equal(model.indicators.entries.has('x'),false);
 } finally { model.dispose(); }
});

test('addSeries rejects external values whose store alignment changed during reflection',()=>{
 const model=new ChartModel(),bar=time=>({time,open:1,high:2,low:0,close:1,volume:1});let once=true;
 try{
  model.store.setData([bar(1)]);
  assert.throws(()=>model.addSeries({id:'external',type:'line',panel:'price',values:new Float64Array(1),get output(){if(once){once=false;model.store.append(bar(2));}return undefined;}}),stale);
  assert.equal(model.store.length,2);assert.equal(model.series.length,0);
 }finally{model.dispose();}
});
