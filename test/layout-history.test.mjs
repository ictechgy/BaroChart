import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI} from '../src/core/index.mjs';
import {captureLayoutFrame,createLayoutHistory} from '../examples/web/layout-history.mjs';

const bars = Array.from({length:8},(_,index) => ({time:1700000000000 + index * 60000,open:100 + index,high:102 + index,low:99 + index,close:101 + index,volume:10 + index}));

function fixture(t,options={}) {
  const model = new ChartModel({store:new BarStore(bars),panels:[
    {id:'price',weight:3},
    {id:'volume',weight:1},
    ...(options.panels ?? []),
  ],axes:options.axes ?? []});
  const api = new ChartAPI(model);
  api.addSeries({id:'price',type:'candles',panel:'price'});
  api.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume'});
  api.addIndicator('ema','ema',{period:3});
  api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#123456',width:3});
  t.after(() => model.dispose());
  return {model,api};
}

function capture(model,extra={}) {
  return captureLayoutFrame(model,{
    generatedPanelIds:new Set(['generated','manual','synthetic']),
    generatedAxisIds:new Set(['generated-axis','synthetic-axis']),
    ...extra,
  });
}

function containsReference(value,target,seen=new Set()) {
  if (value === target) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(entry => containsReference(entry,target,seen));
  return Object.values(value).some(entry => containsReference(entry,target,seen));
}

function framePlacement(model,indicatorId) {
  return model.series.filter(series => series.indicator === indicatorId).map(series => ({seriesId:series.id,indicatorId,panelId:series.panel,axisId:series.axisId ?? null}));
}

function applyFrame(api,frame) {
  api.setPanelOrder(frame.panelOrder);
  const byIndicator = new Map();
  for (const placement of frame.placements) {
    const group = byIndicator.get(placement.indicatorId) ?? [];
    group.push(placement); byIndicator.set(placement.indicatorId,group);
  }
  for (const [indicatorId,placements] of byIndicator) {
    const first = placements[0];
    if (placements.some(placement => placement.panelId !== first.panelId || placement.axisId !== first.axisId)) throw new Error('fixture applier only handles uniform bindings');
    api.setIndicatorPlacement(indicatorId,{panel:first.panelId,axisId:first.axisId});
  }
}

test('capture is pure, detached, complete for bound series, and excludes unrelated state',t => {
  const {model,api} = fixture(t,{panels:[
    {id:'generated',weight:2,label:'Generated',range:[0,100]},
    {id:'manual',weight:1,range:[-0,200]},
    {id:'synthetic',weight:1,range:[10,20]},
  ],axes:[
    {id:'generated-axis',panel:'generated',range:[1,9],side:'left'},
    {id:'synthetic-axis',panel:'synthetic',range:[2,8]},
  ]});
  const syntheticPanel = model.panels.find(panel => panel.id === 'synthetic');
  const syntheticAxis = model.axes.find(axis => axis.id === 'synthetic-axis');
  const syntheticPanelRanges = new Map([['synthetic',{model,rangeRef:syntheticPanel.range,values:syntheticPanel.range.slice()}]]);
  const syntheticAxisRanges = new Map([['synthetic-axis',{model,rangeRef:syntheticAxis.range,range:syntheticAxis.range.slice()}]]);
  model.drawings.items = [{id:'drawing',type:'horizontal',panel:'generated',points:[{time:bars[0].time,price:10}]}];
  const beforePanels = model.panels.slice(), beforeAxes = model.axes.slice(), beforeSeries = model.series.slice(), beforeDrawing = model.drawings.items;
  const frame = capture(model,{syntheticPanelRanges,syntheticAxisRanges});

  assert.deepEqual(frame.panelOrder,['price','volume','generated','manual','synthetic']);
  assert.deepEqual(frame.placements,framePlacement(model,'ema'));
  assert.deepEqual(frame.generatedPanels.map(entry => entry.id),['generated','manual','synthetic']);
  assert.deepEqual(frame.generatedAxes.map(entry => entry.id),['generated-axis','synthetic-axis']);
  assert.equal(Object.hasOwn(frame.generatedPanels.find(entry => entry.id === 'synthetic').options,'range'),false);
  assert.deepEqual(frame.generatedPanels.find(entry => entry.id === 'manual').options.range,[-0,200]);
  assert.equal(Object.hasOwn(frame.generatedAxes.find(entry => entry.id === 'synthetic-axis').options,'range'),false);
  assert.deepEqual(frame.generatedPanels.find(entry => entry.id === 'generated').options.range,[0,100]);
  assert.equal(Object.hasOwn(frame.generatedPanels[0].options,'id'),false);
  assert.equal(Object.hasOwn(frame.generatedAxes[0].options,'id'),false);
  assert.equal(Object.hasOwn(frame.generatedAxes[0].options,'panel'),false);
  assert.equal(containsReference(frame,model),false);
  assert.equal(containsReference(frame,model.store),false);
  assert.strictEqual(model.panels[0],beforePanels[0]);
  assert.strictEqual(model.axes[0],beforeAxes[0]);
  assert.strictEqual(model.series[0],beforeSeries[0]);
  assert.strictEqual(model.drawings.items,beforeDrawing);
  frame.generatedPanels[0].options.weight = 99;
  assert.equal(model.panels.find(panel => panel.id === 'generated').weight,2);
  api.setIndicatorParams('ema',{period:5});
  model.theme.background = '#fff';
  model.store.append({...bars[0],time:bars.at(-1).time + 60000});
  const afterUnrelated = capture(model,{syntheticPanelRanges,syntheticAxisRanges});
  assert.deepEqual(afterUnrelated.placements,framePlacement(model,'ema'));
});

test('capture validates live model and managed ids without accepting invalid snapshots',t => {
  const {model} = fixture(t,{panels:[{id:'generated'}]});
  assert.throws(() => captureLayoutFrame({},{}),/ChartModel/);
  assert.throws(() => captureLayoutFrame(model,{generatedPanelIds:['generated']}),/Set/);
  assert.throws(() => captureLayoutFrame(model,{generatedPanelIds:new Set(['missing'])}),/missing/i);
  assert.throws(() => captureLayoutFrame(model,{generatedPanelIds:new Set(['generated']),syntheticPanelRanges:{}}),/Map/);
  const range = model.panels.find(panel => panel.id === 'generated').range;
  void range;
});

test('capture and history reject duplicate semantic identifiers',t => {
  const {model} = fixture(t,{panels:[{id:'generated'}],axes:[{id:'generated-axis',panel:'generated'}]});
  const frame = captureLayoutFrame(model,{generatedPanelIds:new Set(['generated']),generatedAxisIds:new Set(['generated-axis'])});
  const duplicateCases = [
    ['placement series id',() => ({...frame,placements:[...frame.placements,{...frame.placements[0]}]})],
    ['generated panel id',() => ({...frame,generatedPanels:[...frame.generatedPanels,{...frame.generatedPanels[0],options:{...frame.generatedPanels[0].options}}]})],
    ['generated axis id',() => ({...frame,generatedAxes:[...frame.generatedAxes,{...frame.generatedAxes[0],options:{...frame.generatedAxes[0].options}}]})],
  ];
  for (const [label,make] of duplicateCases) {
    const history = createLayoutHistory({getModel:() => model,capture:() => make(),apply:() => {}});
    assert.throws(() => history.begin('duplicate'),/duplicate/i,label);
  }
  model.panels.push(model.panels[0]);
  assert.throws(() => captureLayoutFrame(model),/duplicate panel/i);
  model.panels.pop();
  model.axes.push(model.axes[0]);
  assert.throws(() => captureLayoutFrame(model),/duplicate axis/i);
  model.axes.pop();
  model.series.push(model.series[0]);
  assert.throws(() => captureLayoutFrame(model),/duplicate series/i);
  model.series.pop();
});

test('history can bootstrap before a model exists and bind on reset',t => {
  let current = null;
  let captures = 0;
  const history = createLayoutHistory({getModel:() => current,capture:model => { captures++; return captureLayoutFrame(model); },apply:() => {}});
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
  assert.equal(history.undo(),false);
  assert.equal(captures,0);
  const {model} = fixture(t);
  current = model;
  assert.equal(history.reset(model),true);
  assert.equal(captures,1);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
  const token = history.begin('initial no-op');
  assert.equal(history.commit(token),false);
});

test('history records panel reorder and placement, then restores both through the API',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}],axes:[{id:'osc-axis',panel:'osc'}]});
  let current = model;
  const history = createLayoutHistory({getModel:() => current,capture:m => captureLayoutFrame(m),apply:frame => applyFrame(api,frame)});
  api.addDrawing({id:'layout-history-drawing',type:'horizontal',panel:'price',points:[{time:bars[0].time,price:100}]});
  const drawingItems = model.drawings.items, drawingUndo = model.drawings.undoStack, drawingRedo = model.drawings.redoStack;
  const token = history.begin('move layout');
  api.setPanelOrder(['volume','osc','price']);
  api.setIndicatorPlacement('ema',{panel:'osc',axisId:'osc-axis'});
  assert.equal(history.commit(token),true);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:false,undoLabel:'move layout',redoLabel:null,depth:1,cursor:1});
  assert.equal(history.undo(),true);
  assert.deepEqual(model.panels.map(panel => panel.id),['price','volume','osc']);
  assert.deepEqual(model.series.find(series => series.id === 'ema-line').panel,'price');
  assert.equal(history.redo(),true);
  assert.deepEqual(model.panels.map(panel => panel.id),['volume','osc','price']);
  assert.deepEqual(model.series.find(series => series.id === 'ema-line').panel,'osc');
  assert.strictEqual(model.drawings.items,drawingItems);
  assert.strictEqual(model.drawings.undoStack,drawingUndo);
  assert.strictEqual(model.drawings.redoStack,drawingRedo);
});

test('no-op commit retains redo and effective branch drops only redo',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => api.setPanelOrder(frame.panelOrder)});
  let token = history.begin('first'); api.setPanelOrder(['volume','price','osc']); assert.equal(history.commit(token),true);
  token = history.begin('second'); api.setPanelOrder(['price','volume','osc']); assert.equal(history.commit(token),true);
  assert.equal(history.undo(),true);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:true,undoLabel:'first',redoLabel:'second',depth:2,cursor:1});
  token = history.begin('noop'); assert.equal(history.commit(token),false);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:true,undoLabel:'first',redoLabel:'second',depth:2,cursor:1});
  token = history.begin('branch'); api.setPanelOrder(['osc','price','volume']); assert.equal(history.commit(token),true);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:false,undoLabel:'branch',redoLabel:null,depth:2,cursor:2});
});

test('history keeps only the configured bounded number of commands',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  const orders = [
    ['volume','price','osc'],['price','osc','volume'],['osc','volume','price'],
    ['volume','osc','price'],['price','volume','osc'],
  ];
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => api.setPanelOrder(frame.panelOrder),maxEntries:3});
  for (const [index,order] of orders.entries()) { const token = history.begin('step-'+index); api.setPanelOrder(order); history.commit(token); }
  assert.deepEqual(history.status(),{canUndo:true,canRedo:false,undoLabel:'step-4',redoLabel:null,depth:3,cursor:3});
  assert.equal(history.undo(),true); assert.equal(history.undo(),true); assert.equal(history.undo(),true); assert.equal(history.undo(),false);
  assert.deepEqual(model.panels.map(panel => panel.id),orders[1]);
});

test('owner reset disables old history, binds the new model, and invalidates old tokens',t => {
  const first = fixture(t).model;
  const firstAPI = new ChartAPI(first);
  let current = first;
  const history = createLayoutHistory({getModel:() => current,capture:m => captureLayoutFrame(m),apply:frame => firstAPI.setPanelOrder(frame.panelOrder)});
  const token = history.begin('old'); firstAPI.setPanelOrder(['volume','price']); assert.equal(history.commit(token),true);
  const next = new ChartModel({store:new BarStore(bars),panels:[{id:'price'},{id:'volume'}]});
  t.after(() => next.dispose()); current = next;
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
  assert.throws(() => history.begin('disabled'),/owner changed/);
  assert.equal(history.reset(),true);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
  assert.throws(() => history.commit(token),/invalid|inactive|owner/i);
});

test('failed apply before publication preserves cursor and redo',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  let fail = false;
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => { if (fail) throw new Error('before publication'); api.setPanelOrder(frame.panelOrder); }});
  const token = history.begin('reorder'); api.setPanelOrder(['volume','price','osc']); history.commit(token);
  assert.equal(history.undo(),true);
  fail = true;
  assert.throws(() => history.redo(),/before publication/);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:true,undoLabel:null,redoLabel:'reorder',depth:1,cursor:0});
});

test('false apply with unchanged geometry preserves the cursor and redo',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  let fail = false;
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => { if (fail) return false; api.setPanelOrder(frame.panelOrder); }});
  const token = history.begin('reorder'); api.setPanelOrder(['volume','price','osc']); history.commit(token);
  assert.equal(history.undo(),true);
  fail = true;
  assert.equal(history.redo(),false);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:true,undoLabel:null,redoLabel:'reorder',depth:1,cursor:0});
});

test('failed apply after publication clears stale journal while preserving actual model',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  let failAfter = false;
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => { api.setPanelOrder(frame.panelOrder); if (failAfter) throw new Error('after publication'); }});
  const token = history.begin('reorder'); api.setPanelOrder(['volume','price','osc']); history.commit(token);
  failAfter = true;
  assert.throws(() => history.undo(),/after publication/);
  assert.deepEqual(model.panels.map(panel => panel.id),['price','volume','osc']);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
});

test('external geometry change rebases before a new command, while style changes are ignored',t => {
  const {model,api} = fixture(t,{panels:[{id:'osc'}]});
  const history = createLayoutHistory({getModel:() => model,capture:m => captureLayoutFrame(m),apply:frame => api.setPanelOrder(frame.panelOrder)});
  api.setSeries('ema-line',{color:'#abcdef'});
  const styleToken = history.begin('style');
  assert.throws(() => history.begin('nested-again'),/active/); history.cancel(styleToken);
  api.setPanelOrder(['volume','price','osc']);
  const token = history.begin('external');
  api.setPanelOrder(['osc','price','volume']);
  assert.equal(history.commit(token),true);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:false,undoLabel:'external',redoLabel:null,depth:1,cursor:1});
});

test('undo and redo accept retained panel and axis resources around the target frame',t => {
  const {model,api} = fixture(t);
  const generatedPanelIds = new Set(), generatedAxisIds = new Set();
  const capture = current => captureLayoutFrame(current,{generatedPanelIds,generatedAxisIds});
  let retained = false;
  const apply = frame => {
    if (!retained) {
      model.addPanel({id:'retained'});
      model.addAxis({id:'retained-axis',panel:'retained'});
      model.drawings.items = [{id:'retained-drawing',type:'horizontal',panel:'retained',points:[{time:bars[0].time,price:100}]}];
      generatedPanelIds.add('retained');
      generatedAxisIds.add('retained-axis');
      retained = true;
    }
    api.setPanelOrder([...frame.panelOrder,'retained']);
  };
  const history = createLayoutHistory({getModel:() => model,capture,apply});
  const token = history.begin('reorder');
  api.setPanelOrder(['volume','price']);
  assert.equal(history.commit(token),true);
  assert.equal(history.undo(),true);
  assert.deepEqual(model.panels.map(panel => panel.id),['price','volume','retained']);
  assert.equal(model.axes.some(axis => axis.id === 'retained-axis'),true);
  assert.equal(model.drawings.items[0].id,'retained-drawing');
  assert.equal(history.redo(),true);
  assert.deepEqual(model.panels.map(panel => panel.id),['volume','price','retained']);
  assert.deepEqual(history.status(),{canUndo:true,canRedo:false,undoLabel:'reorder',redoLabel:null,depth:1,cursor:1});
});

test('existing generated resource configuration may remain at its latest manual value',t => {
  const {model,api} = fixture(t,{panels:[{id:'managed',weight:1}]});
  const generatedPanelIds = new Set(['managed']);
  const capture = current => captureLayoutFrame(current,{generatedPanelIds});
  const history = createLayoutHistory({getModel:() => model,capture,apply:frame => {
    model.panels.find(panel => panel.id === 'managed').weight = 4;
    api.setPanelOrder(frame.panelOrder);
  }});
  const token = history.begin('reorder');
  api.setPanelOrder(['volume','managed','price']);
  assert.equal(history.commit(token),true);
  assert.equal(history.undo(),true);
  assert.equal(model.panels.find(panel => panel.id === 'managed').weight,4);
  assert.equal(history.redo(),true);
  assert.equal(model.panels.find(panel => panel.id === 'managed').weight,4);
});

test('reentrant reset during apply leaves the newer generation untouched',t => {
  const first = fixture(t).model;
  const firstAPI = new ChartAPI(first);
  const next = new ChartModel({store:new BarStore(bars),panels:[{id:'price'},{id:'volume'}]});
  t.after(() => next.dispose());
  let current = first;
  let history;
  const apply = frame => { void frame; current = next; history.reset(); throw new Error('reentrant reset'); };
  history = createLayoutHistory({getModel:() => current,capture:m => captureLayoutFrame(m),apply});
  const token = history.begin('reorder'); firstAPI.setPanelOrder(['volume','price']); history.commit(token);
  assert.throws(() => history.undo(),/reentrant reset/);
  assert.deepEqual(history.status(),{canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0});
  assert.deepEqual(next.panels.map(panel => panel.id),['price','volume']);
});
