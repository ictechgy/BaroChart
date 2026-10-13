import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

// These tests exercise the generated native bridge in Node's VM. They do not
// establish Swift/Java API, JavaScriptCore/QuickJS, SDK, or device coverage.
const MODULE = 'test.native-workspace@1/pair';
const BINDING = {key: 'fixture:ASTER/1m', revision: 'source-r1',
  adjustmentVersion: 'raw-v1', priceUnit: 'USD', adjustment: 'raw'};
const bundle = await buildNativeBundle({modulePaths: ['test/fixtures/native-workspace-module.mjs']});
const unlinkedBundle = await buildNativeBundle();
const run = (context, source) => vm.runInContext(source, context);
const json = value => JSON.parse(JSON.stringify(value));
function bridge(t, {count = 33, rich = true, linked = true} = {}) {
  const c = vm.createContext({console});
  vm.runInContext(linked ? bundle : unlinkedBundle, c);
  // Bridge arguments are parsed/constructed in the VM realm, just as native
  // JSON transport would do. Passing host-realm plain objects tests a different API.
  run(c, `globalThis.binding = JSON.parse(${JSON.stringify(JSON.stringify(BINDING))});
    nativeInit(${count}, {panels:[{id:'price',weight:3},{id:'osc',weight:1}],
      axes:[{id:'left',panel:'price',side:'left'}], series:[]});
    nativeAPI.addSeries({id:'candles',type:'candles',panel:'price'});
    globalThis.notifications=0; nativeAPI.invalidate=()=>{notifications++;};
    globalThis.sourceNotifications=0;
    globalThis.stopSource=nativeModel.store.subscribe(()=>{sourceNotifications++;});`);
  if (rich) run(c, `
    nativeAPI.addIndicator('ema','ema',{period:5});
    nativeAPI.addIndicator('hidden','${MODULE}',{shift:7,oldOnly:'live-value',sign:-0});
    nativeAPI.addSeries({id:'ema-line',type:'line',panel:'price',axisId:'left',indicator:'ema'});
    nativeAPI.addDrawing({id:'fractional',type:'trendline',panel:'price',
      points:[{time:1700000000000.125,price:1.25},{time:1700000000001.75,price:2.5}]});
    nativeAPI.addDrawing({id:'temporary',type:'text',panel:'price',text:'history',
      points:[{time:1700000000000.5,price:3.75}]});
    nativeAPI.undo(); nativeAPI.selectDrawing('fractional');
    nativeAPI.setVisibleRange(1.25,29.75);
    nativeAPI.setText('unsaved UI text');
    nativeAPI.setDrawingTarget({panel:'price',axisId:'left',seriesId:'ema-line'});`);
  t.after(() => {
    run(c, `if(globalThis.nativeWorkspaceProbe){nativeWorkspaceProbe.onFactory=null;
      nativeWorkspaceProbe.onOutputs=null;}`);
    c.stopSource?.(); c.nativeModel?.dispose();
  });
  return c;
}
function state(c) {
  const m=c.nativeModel, s=m.store, d=m.drawings;
  return {
    model:m, api:c.nativeAPI, input:c.nativeInput, size:c.nativeSize, sizeValues:{...c.nativeSize}, source:s,
    inputState:{tool:c.nativeInput.tool,text:c.nativeInput.text,target:c.nativeInput.drawingTarget,
      targetValues:c.nativeInput.drawingTarget?{...c.nativeInput.drawingTarget}:null,
      pointers:[...c.nativeInput.pointers],gesture:c.nativeInput.gesture},
    columns:s.columns, columnRefs:Object.values(s.columns), columnValues:Object.values(s.columns).map(a=>[...a]),
    index:s.index, version:s.version, timeVersion:s.timeVersion, capacity:s.capacity, length:s.length,
    listeners:[...s.listeners], entries:m.indicators.entries,
    entryRows:[...m.indicators.entries].map(([id,e])=>({id,e,def:e.def,params:e.params,
      arrays:e.arrays,arrayRefs:[...e.arrays],values:e.arrays.map(a=>[...a]),
      checkpoints:e.checkpoints,checkpointRows:[...e.checkpoints],
      metadata:[e.dirty,e.dirtyTo,e.invalidated,e.length,e.revision,e.computedFrom,e.computedUntil]})),
    series:m.series, seriesRefs:[...m.series], seriesState:m.series.map(s=>[s.dirtyFrom,s.revision,s.rangeIndex]),
    drawings:d, items:d.items, itemRefs:[...d.items], undo:d.undoStack, redo:d.redoStack,
    undoRows:[...d.undoStack], redoRows:[...d.redoStack], selected:d.selected, transaction:d.transaction,
    drawingSerial:d.serial,retainedHistoryBytes:d.retainedHistoryBytes,
    view:m.view, viewValues:{...m.view}, follow:m.follow, theme:m.theme,
    panels:m.panels, axes:m.axes, crosshair:m.crosshair, inspect:c.nativeInspect(),
    notifications:c.notifications, sourceNotifications:c.sourceNotifications,
  };
}
function unchanged(c, before) {
  const after=state(c);
  for(const key of ['model','api','input','size','source','columns','index','entries','series','drawings',
    'items','undo','redo','transaction','view','theme','panels','axes','crosshair'])
    assert.equal(after[key],before[key],key+' identity');
  assert.deepEqual(after,before,'read must preserve metadata, buffers, history, inspection and notifications');
}
function saved(c) {return run(c, 'globalThis.workspaceText=nativeSaveWorkspace(binding)');}
function preflight(c, text = c.workspaceText) {
  c.inputText=text;
  return run(c, 'nativePreflightWorkspace(inputText,binding)');
}
function edited(c, mutation) {
  return run(c, `(()=>{const doc=Aster.safeCheckpointParse(workspaceText);${mutation};return Aster.safeCheckpointStringify(doc);})()`);
}
function watchStaging(c) {
  run(c, `globalThis.stages=[];globalThis.stageEntries=[];globalThis.liveEngine=nativeModel.indicators;
    const originalAdd=Aster.IndicatorEngine.prototype.add;
    Aster.IndicatorEngine.prototype.add=function(...args){
      if(this!==liveEngine){if(!stages.includes(this))stages.push(this);
        if(this.store.length!==0||this.store.capacity!==0)throw Error('Metadata staging must be zero-capacity');}
      const result=originalAdd.apply(this,args);
      if(this!==liveEngine)stageEntries.push(this.entries.get(args[0]));
      return result;
    };`);
}
function stagingReleased(c) {
  assert.ok(c.stages.length,'metadata validation uses an isolated engine');
  for(const engine of c.stages) assert.equal(engine.entries.size,0,'released metadata entries');
  for(const entry of c.stageEntries) {
    assert.equal(entry.checkpoints.size,0,'metadata creates no checkpoints');
    assert.ok(entry.arrays.every(a=>a.length===0),'metadata owns no bar-sized arrays');
  }
}
function counters(c) {
  const p=c.nativeWorkspaceProbe;
  return [p.creates,p.steps,p.snapshots,p.checkpointChecks];
}

test('native workspace globals return core canonical text and a bounded validated-only receipt', t => {
  const c=bridge(t),before=state(c);
  assert.equal(typeof c.nativeSaveWorkspace,'function');
  assert.equal(typeof c.nativePreflightWorkspace,'function');
  const text=saved(c);
  assert.equal(text,run(c,'Aster.saveWorkspace(nativeAPI,binding)'));
  const doc=json(run(c,'Aster.readWorkspaceDocument(workspaceText)'));
  const receipt=json(preflight(c));
  assert.deepEqual(Object.keys(receipt).sort(),['schema','version','status','restored','source','counts',
    'projectedOutputBytes','outputByteLimit','dataset','modules'].sort());
  assert.equal(receipt.schema,'aster.workspace-preflight');assert.equal(receipt.version,1);
  assert.equal(receipt.status,'validated-only');assert.equal(receipt.restored,false);
  assert.deepEqual(receipt.source,{...doc.source,version:c.nativeModel.store.version});
  assert.deepEqual(receipt.counts,{panels:2,axes:1,series:2,indicators:2,outputs:3,drawings:1});
  assert.deepEqual(receipt.dataset,BINDING);
  assert.deepEqual(receipt.modules,[{id:'test.native-workspace',version:1,stateVersion:3,exportName:'pair',causal:true}]);
  assert.equal(receipt.projectedOutputBytes,c.nativeModel.store.capacity*3*8);
  assert.equal(receipt.outputByteLimit,268435456);
  assert.ok(JSON.stringify(receipt).length<2048,'receipt excludes full workspace and bars');
  assert.equal(saved(c),text); unchanged(c,before);
  const detached=preflight(c);detached.dataset.key='receipt-only';detached.modules[0].version=999;
  assert.deepEqual(json(preflight(c)),receipt,'receipt mutation must not affect binding or linked descriptors');
});

test('read success and failure preserve dirty held arrays, checkpoint history and listeners without calculation', t => {
  const c=bridge(t);saved(c);watchStaging(c);
  run(c, `nativeModel.store.update(3,{...nativeModel.store.at(3),volume:12345});`);
  const before=state(c),calls=counters(c);
  assert.ok([...c.nativeModel.indicators.entries.values()].every(e=>e.dirty===3));
  for(let i=0;i<12;i++) {
    assert.equal(saved(c),c.workspaceText);preflight(c);
    assert.throws(()=>preflight(c,'{broken'));
    assert.throws(()=>preflight(c,edited(c,"doc.indicators[0].outputs=['wrong']")));
    unchanged(c,before);
  }
  assert.deepEqual(counters(c),calls,'factory metadata must not create/step/snapshot/validate checkpoints');
  stagingReleased(c);
});

test('save and parser preserve fractional, negative-zero and explicit-null drawing anchors', t => {
  const c=bridge(t);
  run(c, `const drawing=nativeModel.drawings.items[0];
    nativeModel.drawings.items[0]=Object.freeze({...drawing,axisId:null,seriesId:null,
      points:Object.freeze([Object.freeze({time:1700000000000.125,price:-0}),
        Object.freeze({time:1700000000001.75,price:2.5})])});`);
  const before=state(c),text=saved(c),decoded=run(c,'Aster.readWorkspaceDocument(workspaceText)');
  assert.match(text,/\$asterNumber/);
  assert.ok(Object.is(decoded.drawings.drawings[0].points[0].price,-0));
  assert.equal(decoded.drawings.drawings[0].points[0].time,1700000000000.125);
  assert.equal(decoded.drawings.drawings[0].axisId,null);assert.equal(decoded.drawings.drawings[0].seriesId,null);
  assert.equal(preflight(c).status,'validated-only');assert.equal(saved(c),text);unchanged(c,before);
});

for(const adjustment of ['raw','split','total-return']) test('empty source read accepts explicit host '+adjustment+' binding', t => {
  const c=bridge(t,{count:0,rich:false});
  run(c, `binding.adjustment=${JSON.stringify(adjustment)};binding.adjustmentVersion='host-assertion-v2';`);
  const before=state(c);saved(c);const receipt=json(preflight(c));
  assert.deepEqual(receipt.source,{length:0,firstTime:null,lastTime:null,version:c.nativeModel.store.version});
  assert.equal(receipt.projectedOutputBytes,0);assert.deepEqual(receipt.modules,[]);unchanged(c,before);
});

test('preflight uses replacement params, canonical ordered outputs and factory defaults for hidden studies', t => {
  const c=bridge(t);saved(c);watchStaging(c);const before=state(c),calls=counters(c);
  const replacement=edited(c,"doc.indicators[1].params={};doc.indicators[1].plotOffsets={value:2,toString:2}");
  assert.equal(preflight(c,replacement).counts.indicators,2);
  assert.deepEqual(json(c.nativeWorkspaceProbe.params.at(-1)),{},'old params must not merge into replacement');
  assert.throws(()=>preflight(c,edited(c,"doc.indicators[1].outputs.reverse()")),/output|schema|definition/i);
  assert.throws(()=>preflight(c,edited(c,"doc.indicators[1].plotOffsets.value=99")),/offset|definition/i);
  assert.throws(()=>preflight(c,edited(c,"delete doc.indicators[1].plotOffsets.value")),/offset|definition/i);
  assert.throws(()=>preflight(c,edited(c,"doc.indicators[0].params.period=0")),/period/i);
  unchanged(c,before);assert.deepEqual(counters(c),calls);stagingReleased(c);
});

const attacks = {
  'document version': 'doc.version=2',
  'unknown document field': 'doc.restore=true',
  'module version': 'doc.indicators[1].module.version=2',
  'module state version': 'doc.indicators[1].module.stateVersion=4',
  'module export': "doc.indicators[1].module.exportName='wide'",
  'missing module descriptor': 'delete doc.indicators[1].module',
  'unknown factory': "doc.indicators[0].name='host-only-custom'",
  'duplicate study': 'doc.indicators.push(doc.indicators[0])',
  'bad source length': 'doc.source.length++',
  'first endpoint': 'doc.source.firstTime--',
  'last endpoint': 'doc.source.lastTime++',
  'dataset revision': "doc.dataset.revision='other-revision'",
  'adjustment revision': "doc.dataset.adjustmentVersion='other-adjustment'",
  'price units': "doc.dataset.priceUnit='EUR'",
  'missing panel': "doc.series[0].panel='missing'",
  'missing axis': "doc.series[1].axisId='missing'",
  'missing study': "doc.series[1].indicator='missing'",
  'missing drawing binding': "doc.drawings.drawings[0].axisId='missing'",
  'external series values': 'doc.series[1].values=[1,2,3]',
  'nonfinite anchor': 'doc.drawings.drawings[0].points[0].price=Infinity',
  'excess panel count': "doc.chart.panels=Array.from({length:33},(_,i)=>({id:'p'+i,weight:1}))",
};
for(const [label,mutation] of Object.entries(attacks)) test('native preflight rejects '+label+' without disturbing the live chart', t => {
  const c=bridge(t);saved(c);const before=state(c),calls=counters(c);
  assert.throws(()=>preflight(c,edited(c,mutation)));unchanged(c,before);assert.deepEqual(counters(c),calls);
});

test('a module saved by a linked bundle is unavailable in an unlinked generated bundle', t => {
  const linked=bridge(t),text=saved(linked),c=bridge(t,{rich:false,linked:false}),before=state(c);
  assert.throws(()=>preflight(c,text),/module|unsupported|factory/i);unchanged(c,before);
});

test('binding rejects hostile prototypes, accessors, reserved fields and incomplete metadata without executing getters', t => {
  const c=bridge(t);saved(c);const before=state(c);
  const badBindings=["null","[]","'text'","{}","({...binding,adjustment:'adjusted'})",
    "({...binding,revision:''})","({...binding,key:'x'.repeat(129)})","({...binding,extra:true})",
    "Object.create(binding)","Object.assign(Object.create({foreign:true}),binding)",
    "({...binding,toJSON(){throw Error('must not call toJSON')}})",
    "Object.defineProperty({...binding},'key',{get(){getterCalls++;return 'accessed'}})",
    "Object.defineProperty({...binding},'key',{value:binding.key,enumerable:false})"];
  run(c,'globalThis.getterCalls=0');
  for(const expression of badBindings) {
    assert.throws(()=>run(c,`nativeSaveWorkspace(${expression})`),expression);
    assert.throws(()=>run(c,`nativePreflightWorkspace(workspaceText,${expression})`),expression);
    unchanged(c,before);
  }
  assert.equal(c.getterCalls,0);
});

test('document text shape, numeric/prototype forms, character and byte bounds reject atomically', t => {
  const c=bridge(t);saved(c);const before=state(c);
  for(const expression of ['undefined','null','42','{}','new String(workspaceText)'])
    assert.throws(()=>run(c,`nativePreflightWorkspace(${expression},binding)`));
  for(const text of ['','{}','{bad}',c.workspaceText.replace('"schema":','"__proto__":{},"schema":'),
    c.workspaceText.replace('"schema":','"constructor":{},"schema":'),
    ' '.repeat(2097153),'界'.repeat(1398102)]) assert.throws(()=>preflight(c,text));
  unchanged(c,before);
});

test('read guards require a current live native owner', t => {
  const c=bridge(t);saved(c);c.nativeModel.dispose();
  assert.throws(()=>saved(c),/disposed|owner|live/i);assert.throws(()=>preflight(c),/disposed|owner|live/i);
  const empty=vm.createContext({console});vm.runInContext(bundle,empty);
  run(empty,`globalThis.binding=JSON.parse(${JSON.stringify(JSON.stringify(BINDING))})`);
  assert.throws(()=>run(empty,'nativeSaveWorkspace(binding)'));
  empty.inputText=c.workspaceText;assert.throws(()=>run(empty,'nativePreflightWorkspace(inputText,binding)'));
});

test('source extent mismatch rejects but matching interior data is a host assertion rather than a fingerprint', t => {
  const c=bridge(t);const text=saved(c);
  run(c,'nativeModel.store.update(3,{...nativeModel.store.at(3),volume:98765})');
  let before=state(c);assert.equal(preflight(c,text).source.version,c.nativeModel.store.version);unchanged(c,before);
  run(c,`const last=nativeModel.store.at(nativeModel.store.length-1);
    nativeModel.store.append({...last,time:last.time+60000});`);
  before=state(c);assert.throws(()=>preflight(c,text),/source|extent|length|dataset/i);unchanged(c,before);
});

test('output capacity projection sums hidden outputs and enforces the default ceiling without allocating them', t => {
  const c=bridge(t,{count:8193,rich:false});saved(c);watchStaging(c);
  const text=edited(c,`doc.indicators=Array.from({length:64},(_,i)=>({id:'wide'+i,
    name:'test.native-workspace@1/wide',params:{},module:{id:'test.native-workspace',version:1,
      stateVersion:3,exportName:'wide',causal:true},
    outputs:Array.from({length:32},(_,j)=>'value'+j),plotOffsets:{}}))`);
  const before=state(c),calls=counters(c),receipt=json(preflight(c,text));
  assert.equal(receipt.counts.outputs,2048);assert.equal(receipt.projectedOutputBytes,268435456);
  assert.equal(receipt.modules.length,1,'shared module descriptors are deduplicated');
  c.capacityText=text;
  const over=run(c,`(()=>{const doc=Aster.safeCheckpointParse(capacityText);
    doc.indicators.push({...doc.indicators[0],id:'wide-over'});return Aster.safeCheckpointStringify(doc);})()`);
  assert.throws(()=>preflight(c,over),/output|byte|limit|budget/i);
  unchanged(c,before);assert.deepEqual(counters(c),calls);stagingReleased(c);
});

test('save rejects active gestures while preflight leaves pointers and drawing transactions alone', t => {
  const c=bridge(t);const text=saved(c);
  run(c,"nativePointer('down',1,250,150)");
  assert.ok(c.nativeInput.pointers.size);assert.ok(c.nativeInput.gesture);
  let before=state(c);assert.throws(()=>saved(c),/gesture|pointer/i);
  assert.equal(preflight(c,text).status,'validated-only');unchanged(c,before);
  run(c,"nativePointer('cancel',1,250,150);nativeModel.drawings.begin()");
  before=state(c);assert.ok(c.nativeModel.drawings.transaction);
  assert.throws(()=>saved(c),/gesture|commit|cancel/i);preflight(c,text);unchanged(c,before);
  run(c,'nativeModel.drawings.cancel()');
});

test('throwing trusted metadata factory releases staging and leaves all existing state intact', t => {
  const c=bridge(t);saved(c);watchStaging(c);const before=state(c),calls=counters(c);
  run(c,"nativeWorkspaceProbe.onFactory=()=>{throw Error('metadata sentinel')}");
  assert.throws(()=>preflight(c),/metadata sentinel/);
  run(c,'nativeWorkspaceProbe.onFactory=null');unchanged(c,before);
  assert.deepEqual(counters(c),calls);stagingReleased(c);
});

const callbacks = {
  'source correction': 'nativeModel.store.update(3,{...nativeModel.store.at(3),volume:321})',
  'source replacement': 'nativeModel.store=new Aster.BarStore()',
  'model disposal': 'nativeModel.dispose()',
  'native context replacement': 'nativeInit(8,{series:[]})',
  'API replacement': 'globalThis.nativeAPI=new Aster.ChartAPI(nativeModel,{controller:nativeInput})',
  'input replacement': 'globalThis.nativeInput=new Aster.InteractionController(nativeModel,()=>nativeSize)',
};
for(const [label,action] of Object.entries(callbacks)) test('trusted factory '+label+' cannot publish a validated receipt', t => {
  const c=bridge(t);saved(c);watchStaging(c);const old=c.nativeModel,store=old.store,calls=counters(c);
  run(c,`nativeWorkspaceProbe.onFactory=()=>{nativeWorkspaceProbe.onFactory=null;${action};}`);
  assert.throws(()=>preflight(c),/stale|changed|disposed|owner|source/i);
  stagingReleased(c);assert.deepEqual(counters(c),calls);
  if(old!==c.nativeModel) assert.equal(old.disposed,true);
  if(!old.disposed) old.dispose();
  assert.equal(store.listeners.size,1,'only the explicit test subscriber survives disposal');
});

test('late trusted metadata getter and staging cleanup mutation are covered by the final source guard', t => {
  for(const phase of ['outputs','cleanup']) {
    const c=bridge(t);saved(c);watchStaging(c);const store=c.nativeModel.store,calls=counters(c);
    if(phase==='outputs') run(c,`nativeWorkspaceProbe.onOutputs=()=>{
      nativeWorkspaceProbe.onOutputs=null;nativeModel.store.update(3,{...nativeModel.store.at(3),volume:456});}`);
    else run(c,`const originalDispose=Aster.IndicatorEngine.prototype.dispose;
      Aster.IndicatorEngine.prototype.dispose=function(){const result=originalDispose.call(this);
        if(this!==liveEngine)nativeModel.store.update(3,{...nativeModel.store.at(3),volume:654});return result;};`);
    assert.throws(()=>preflight(c),/stale|changed|source/i,phase);
    assert.equal(store.at(3).volume,phase==='outputs'?456:654);
    assert.deepEqual(counters(c),calls);stagingReleased(c);
  }
});

test('an existing asynchronous capture remains valid and retains the same source buffers after reads', t => {
  const c=bridge(t);saved(c);
  const capture=JSON.parse(run(c,`nativeAsyncBegin(JSON.stringify({kind:'correction',
    bar:{...nativeModel.store.at(0),volume:800}}))`));
  t.after(()=>c.nativeAsyncRelease(capture.ticket));
  const slice=c.nativeAsyncBuffer(capture.ticket,0,0,1),before=state(c);
  saved(c);preflight(c);assert.throws(()=>preflight(c,'{bad}'));
  assert.equal(c.nativeAsyncCheck(capture.ticket),true);
  assert.equal(c.nativeAsyncBuffer(capture.ticket,0,0,1).buffer,slice.buffer);
  unchanged(c,before);
});


test('metadata staging is disposed once, with no second callback after the final guard', t => {
  const c=bridge(t);saved(c);watchStaging(c);const before=state(c);
  run(c, `globalThis.disposals=0;const originalDispose=Aster.IndicatorEngine.prototype.dispose;
    Aster.IndicatorEngine.prototype.dispose=function(){const result=originalDispose.call(this);
      if(this!==liveEngine&&++disposals===2)
        nativeModel.store.update(3,{...nativeModel.store.at(3),volume:999999});
      return result;
    };`);
  assert.equal(preflight(c).status,'validated-only');
  assert.equal(c.disposals,1,'cleanup must not execute again after the final guard');
  stagingReleased(c);unchanged(c,before);
});

for(const [label,action] of Object.entries(callbacks)) test('save metadata getter '+label+' rejects a stale native owner', t => {
  const c=bridge(t);saved(c);const old=c.nativeModel,store=old.store;
  run(c, `nativeWorkspaceProbe.onOutputs=()=>{nativeWorkspaceProbe.onOutputs=null;${action};}`);
  assert.throws(()=>saved(c),/stale|changed|disposed|owner|source/i);
  if(!old.disposed)old.dispose();
  assert.equal(store.listeners.size,1);
});

test('factory cannot silently add or replace requested parameter metadata', t => {
  const c=bridge(t);saved(c);watchStaging(c);const before=state(c),calls=counters(c);
  run(c, "nativeWorkspaceProbe.onFactory=params=>{params.silentlyAdded=true}");
  assert.throws(()=>preflight(c),/param|metadata|request/i);
  run(c,'nativeWorkspaceProbe.onFactory=null');
  unchanged(c,before);assert.deepEqual(counters(c),calls);stagingReleased(c);
});

test('validated-only receipt does not require the future calculation callback to succeed', t => {
  const c=bridge(t);saved(c);watchStaging(c);const before=state(c),calls=counters(c);
  run(c,'nativeWorkspaceProbe.failCreate=true');
  assert.equal(preflight(c).status,'validated-only');
  unchanged(c,before);assert.deepEqual(counters(c),calls);stagingReleased(c);
  assert.throws(()=>run(c, "Aster.resolveIndicatorFactory('test.native-workspace@1/pair')({}).create()"),
    /calculation unavailable/);
});

for(const [label,action] of Object.entries({
  'external values': "nativeAPI.addSeries({id:'external',type:'line',panel:'price',values:new Float64Array(nativeModel.store.length)})",
  'custom formatter': "nativeAPI.setPanel('price',{formatter:value=>'custom '+value})",
  'noncanonical factory': "nativeModel.indicators.registry.set('ema',()=>{throw Error('noncanonical must not run')})",
})) test('save rejects '+label+' while preflight validates the detached document only', t => {
  const c=bridge(t);const text=saved(c);run(c,action);const before=state(c);
  assert.throws(()=>saved(c),/external|formatter|unsupported|canonical|portable/i);
  assert.equal(preflight(c,text).status,'validated-only');unchanged(c,before);
});
