import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {BarStore,ChartModel,ChartAPI,InteractionController,seededColumns,FIELDS} from '../src/core/index.mjs';
import {saveWorkspace} from '../src/core/workspace.mjs';
import {captureJavaScriptMigration,importJavaScriptMigration} from '../src/web/wasm/javascript-migration.mjs';
import {createWasmHarness} from '../scripts/rust/wasm-harness.mjs';
import {computeRequest} from '../src/web/compute-worker.mjs';
import {hydrateModel,modelRequest,validatePreparedPacketAsync} from '../src/web/worker-state.mjs';

const SIZE=Object.freeze({width:894,height:446});
const BINDING=Object.freeze({key:'web-js-migration',revision:'r1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'});
const PRODUCTION_WASM='src/web/wasm/barochart-core.wasm';
const floats=bytes=>{const result=new Float64Array(bytes.byteLength/8),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let index=0;index<result.length;index++)result[index]=view.getFloat64(index*8,true);return result;};

function fixture(t,{custom=false}={}){
 const store=new BarStore([],{maxBars:4096,timeframeMs:60000,timeOrigin:123});store.setColumns(seededColumns(64,17),64);
 const model=new ChartModel({store,visibleBars:30,precision:5,axisWidth:73}),input=new InteractionController(model,()=>SIZE),api=new ChartAPI(model,{controller:input});
 api.addPanel({id:'volume',weight:1});
 api.addIndicator('ema-id','ema',{period:9});api.addIndicator('pressure-id','aster.volume-direction@1/pressure',{factor:.5,shift:1});
 api.addSeries({id:'price',type:'candles',panel:'price'});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema-id',color:'#123456',width:3});api.addSeries({id:'pressure-line',type:'histogram',panel:'volume',indicator:'pressure-id',output:'signed'});
 api.setTheme({background:'#010203',font:'17px serif'});api.setVisibleRange(7.25,37.25);
 api.addDrawing({id:'kept',type:'horizontal',panel:'price',points:[{time:store.at(4).time,price:77}],style:{color:'#abcdef'}});
 api.addDrawing({id:'redo',type:'text',panel:'price',points:[{time:store.at(5).time,price:78}],text:'history'});api.undo();api.selectDrawing('kept');
 input.setTool('trendline');input.text='migration-note';input.setDrawingTarget({panel:'price',seriesId:'ema-line'});input.setDrawingMagnet({mode:'strong'});input.setCrosshairSnap({mode:'ohlc'});model.crosshair={x:320,y:180};
 api.configureDataIngestion({streamId:'web-js',generation:4,firstSequence:20,maxQueuedEvents:8,maxBatchEvents:8});api.pauseDataIngestion();
 const document=saveWorkspace(api,BINDING);
 if(custom){api.registerIndicator('source-only',()=>({outputs:['value'],create(){return{step:bar=>[bar.close],snapshot:()=>0,restore(){}};}}));api.addIndicator('source-only-id','source-only');}
 t.after(()=>{if(!model.disposed)model.dispose();});return{store,model,input,api,document};
}

test('actual JavaScript source round-trips workspace, segmented UI/history, controls, linked indicator and ingestion exactly',async t=>{
 const f=fixture(t),expectedDrawings=f.model.drawings.save(),expectedIngestion=f.api.saveDataIngestion(),expectedUndo=f.model.drawings.undoStack.length,expectedRedo=f.model.drawings.redoStack.length,expectedSerial=f.model.drawings.serial;
 const capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:7,chunkSize:11,admissionRecords:2});t.after(()=>capture.dispose());
 assert.equal(capture.description.schema,'aster.web-ui-migration');assert.equal(capture.description.workspaceMetadata,capture.metadataJSON);assert.equal(capture.description.header,capture.header);
 for(const key of ['time','open','high','low','close','volume']){assert.notEqual(capture.columns[key].buffer,f.model.store.columns[key].buffer);assert.deepEqual(capture.columns[key],f.model.store.columns[key].subarray(0,f.model.store.length));}
 const candidate=await importJavaScriptMigration(capture,{chunkSize:13,stepSize:17});t.after(()=>candidate.dispose());
 assert.ok(candidate.model instanceof ChartModel);assert.ok(candidate.input instanceof InteractionController);assert.ok(candidate.api instanceof ChartAPI);
 assert.equal(saveWorkspace(candidate.api,BINDING),f.document);assert.equal(candidate.model.drawings.save(),expectedDrawings);assert.equal(candidate.model.drawings.undoStack.length,expectedUndo);assert.equal(candidate.model.drawings.redoStack.length,expectedRedo);assert.equal(candidate.model.drawings.selected,'kept');assert.equal(candidate.model.drawings.serial,expectedSerial);
 assert.deepEqual([...candidate.model.indicators.entries.keys()],['ema-id','pressure-id']);assert.deepEqual(candidate.model.indicators.entries.get('pressure-id').params,{factor:.5,shift:1});
 assert.equal(candidate.input.tool,'trendline');assert.equal(candidate.input.text,'migration-note');assert.deepEqual(candidate.input.drawingTarget,{panel:'price',axisId:null,seriesId:'ema-line'});assert.deepEqual(candidate.input.drawingMagnet,{mode:'strong',radiusPx:8});assert.deepEqual(candidate.input.crosshairSnap,{mode:'ohlc',target:null});
 assert.equal(candidate.api.saveDataIngestion(),expectedIngestion);assert.equal(candidate.api.dataIngestionStats().state,'paused');assert.equal(candidate.api.dataIngestionStats().pendingEvents,0);assert.equal(candidate.api.dataIngestionStats().nextSequence,20);
 assert.equal(capture.check(),true);const receipt=capture.finish();assert.equal(receipt.revision,7);assert.notEqual(f.model.disposed,true);
 const handed=candidate.handoff();assert.equal(handed.model,candidate.model);assert.equal(candidate.dispose(),false);handed.model.dispose();assert.notEqual(f.model.disposed,true);
});

test('source UI mutation invalidates the exact capture and dispose releases its ingestion fence',async t=>{
 const f=fixture(t),capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:9,chunkSize:16});
 f.input.setDrawingMagnet({mode:'weak'});assert.throws(()=>capture.check(),/stale|UI/i);assert.equal(capture.dispose(),true);assert.doesNotThrow(()=>f.api.resumeDataIngestion());
});

test('worker-hydrated lazy checkpoints are captured without decoding the retained stream and remain stale-guarded',async t=>{
 const source=fixture(t),options=modelRequest(source.model),packet=await computeRequest({columns:source.model.store.columns,length:source.model.store.length,options}),validation=await validatePreparedPacketAsync(packet,options),model=hydrateModel(packet,options,validation),input=new InteractionController(model,()=>SIZE),api=new ChartAPI(model,{controller:input});
 t.after(()=>{if(!model.disposed)model.dispose();});
 const binding={...BINDING,key:'web-lazy-checkpoints'},document=saveWorkspace(api,binding),entry=model.indicators.entries.get('ema-id'),lazy=entry.checkpoints;
 assert.equal(lazy.cache.size,0);
 const capture=await captureJavaScriptMigration({api,input,size:SIZE,document,binding,revision:10,chunkSize:16});
 t.after(()=>capture.dispose());
 assert.equal(lazy.cache.size,0,'workspace admission keeps the encoded stream lazy');
 assert.equal(capture.check(),true);
 lazy.set(0,{e:{count:9,sum:0,value:123}});
 assert.throws(()=>capture.check(),/stale|changed/i);
 assert.equal(capture.dispose(),true);
 assert.doesNotThrow(()=>api.configureDataIngestion({streamId:'lazy-checkpoints',generation:1,firstSequence:0}));api.pauseDataIngestion();
 const secondDocument=saveWorkspace(api,binding),replacement=await captureJavaScriptMigration({api,input,size:SIZE,document:secondDocument,binding,revision:11,chunkSize:16});
 entry.checkpoints=new Map();
 assert.throws(()=>replacement.check(),/stale|changed/i);
 assert.equal(replacement.dispose(),true);
 assert.doesNotThrow(()=>api.resumeDataIngestion(),'aborting a lazy checkpoint capture releases its ingestion lease');
});

test('non-portable callback indicators fail with an explicit backend requirement before source admission',async t=>{
 const f=fixture(t,{custom:true});await assert.rejects(captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:11}),error=>error?.code==='JAVASCRIPT_BACKEND_REQUIRED');
 assert.doesNotThrow(()=>f.api.resumeDataIngestion());
});

test('aborted import disposes its isolated candidate and leaves a reusable owned capture',async t=>{
 const f=fixture(t),capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:13}),controller=new AbortController();t.after(()=>capture.dispose());
 await assert.rejects(importJavaScriptMigration(capture,{signal:controller.signal,onProgress:progress=>{if(progress.stage==='workspace-prepare')controller.abort();}}),error=>error?.name==='AbortError');
 assert.equal(capture.check(),true);capture.dispose();
});

test('portable input rejects accessors before reading them and snapshots every accepted field once',async t=>{
 const f=fixture(t),capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:15});t.after(()=>capture.dispose());let reads=0;
 const accessor={columns:capture.columns,header:capture.header,uiChunks:capture.uiChunks,description:capture.description,get metadataJSON(){reads++;return reads===1?capture.metadataJSON:'{}';}};
 await assert.rejects(importJavaScriptMigration(accessor),/own data property/i);assert.equal(reads,0);assert.equal(capture.check(),true);
 let descriptors=0;const proxy=new Proxy({metadataJSON:capture.metadataJSON,columns:capture.columns,header:capture.header,uiChunks:capture.uiChunks,description:capture.description},{getOwnPropertyDescriptor(target,key){descriptors++;return Reflect.getOwnPropertyDescriptor(target,key);}}),candidate=await importJavaScriptMigration(proxy);t.after(()=>candidate.dispose());
 assert.equal(descriptors,5);assert.equal(candidate.model.store.length,f.model.store.length);
});

test('tampered symbol or ingestion UI fails in the isolated candidate without changing its source',async t=>{
 const f=fixture(t),capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:16});t.after(()=>capture.dispose());const beforeWorkspace=saveWorkspace(f.api,BINDING),beforeIngestion=f.api.saveDataIngestion();
 for(const kind of ['symbol','ingestion']){const parsed=JSON.parse(capture.header);if(kind==='symbol')parsed.state.symbol={...parsed.state.symbol,currency:'EUR'};else parsed.state.dataIngestion=parsed.state.dataIngestion+' ';const header=JSON.stringify(parsed),description={...capture.description,header};await assert.rejects(importJavaScriptMigration({metadataJSON:capture.metadataJSON,columns:capture.columns,header,uiChunks:capture.uiChunks,description}),/symbol changed|ingestion changed/i);assert.equal(capture.check(),true);assert.equal(saveWorkspace(f.api,BINDING),beforeWorkspace);assert.equal(f.api.saveDataIngestion(),beforeIngestion);}
});

test('production Rust migration header and workspace import into an actual JavaScript model',{skip:!existsSync(PRODUCTION_WASM)},async t=>{
 const h=await createWasmHarness({prebuiltPath:PRODUCTION_WASM});t.after(()=>h.dispose());const value=async(name,args=[])=>{const result=await h.call(name,args);assert.equal(result.status,0,`${name}: ${JSON.stringify(result.error)}`);return result.value;};
 await value('nativeInit',[32,{series:[]}]);await value('nativeCommand',['addPanel',[{id:'volume',weight:1}]]);await value('nativeCommand',['addIndicator',['pressure-id','aster.volume-direction@1/pressure',{factor:.5,shift:1}]]);await value('nativeCommand',['addSeries',[{id:'pressure-line',type:'histogram',panel:'volume',indicator:'pressure-id',output:'signed'}]]);await value('nativeCommand',['addDrawing',[{id:'rust-line',type:'horizontal',panel:'price',points:[{time:1700000000000,price:99}]}]]);await value('nativeTool',['trendline']);await value('nativeCommand',['setDrawingMagnet',[{mode:'strong'}]]);await value('nativeCommand',['setCrosshairSnap',[{mode:'ohlc'}]]);
 const revision=17,registration=3,document=await value('nativeSaveWorkspace',[BINDING]),begin=await value('web.migrationSourceBegin',[document,BINDING,revision,805306368,registration]);let admission;do{admission=await value('web.migrationSourceStep',[begin.ticket,64,revision]);}while(!admission.complete);
 const ui=await value('web.migrationSourceUiBegin',[begin.ticket,revision]),uiChunks=[];for(;;){const text=await value('web.migrationSourceUiNext',[begin.ticket]),row=JSON.parse(text);if(row.complete)break;uiChunks.push(text);}
 const metadata=JSON.parse(admission.metadataJSON),columns={};for(let slot=0;slot<FIELDS.length;slot++){const read=h.webCall('nativeAsyncBuffer',[begin.ticket,slot,0,metadata.source.length]);assert.equal(read.status,0);columns[FIELDS[slot]]=floats(read.value);}
 const candidate=await importJavaScriptMigration({metadataJSON:admission.metadataJSON,columns,header:ui.header,uiChunks,description:ui.description});t.after(()=>candidate.dispose());
 assert.equal(candidate.model.store.length,32);assert.equal(candidate.model.indicators.entries.get('pressure-id').name,'aster.volume-direction@1/pressure');assert.equal(candidate.model.drawings.items[0].id,'rust-line');assert.equal(candidate.input.tool,'trendline');assert.equal(candidate.input.drawingMagnet.mode,'strong');assert.equal(candidate.input.crosshairSnap.mode,'ohlc');assert.equal(saveWorkspace(candidate.api,BINDING),document);
 await value('web.migrationSourceCheck',[begin.ticket,registration,revision]);await value('web.migrationSourceFinish',[begin.ticket,registration,revision]);
});

test('actual JavaScript capture is accepted by the production Rust workspace and UI target',{skip:!existsSync(PRODUCTION_WASM)},async t=>{
 const f=fixture(t),capture=await captureJavaScriptMigration({api:f.api,input:f.input,size:SIZE,document:f.document,binding:BINDING,revision:19,chunkSize:17});t.after(()=>capture.dispose());
 const h=await createWasmHarness({prebuiltPath:PRODUCTION_WASM});t.after(()=>h.dispose());const value=async(name,args=[])=>{const result=await h.call(name,args);assert.equal(result.status,0,`${name}: ${JSON.stringify(result.error)}`);return result.value;},d=capture.description;
 await value('web.migrationTargetCreate',[capture.metadataJSON,d.workspaceTicket,d.workspaceRegistration,d.sourceRevision]);
 for(let slot=0;slot<FIELDS.length;slot++)for(let offset=0;offset<capture.columns[FIELDS[slot]].length;offset+=23){const count=Math.min(23,capture.columns[FIELDS[slot]].length-offset),write=h.webWriteF64('nativeAsyncTargetBuffer',[slot,offset,count],capture.columns[FIELDS[slot]].subarray(offset,offset+count));assert.deepEqual({status:write.status,didWrite:write.didWrite},{status:0,didWrite:1});}
 await value('web.migrationTargetStart');let progress;do{progress=JSON.parse(await value('web.migrationTargetStep',[31]));}while(!progress.complete);
 await value('web.migrationTargetUiBegin',[d,capture.header]);for(const chunk of capture.uiChunks)await value('web.migrationTargetUiChunk',[chunk]);const ready=await value('web.migrationTargetUiFinish',[d.workspaceTicket,d.workspaceRegistration,d.sourceRevision]);assert.equal(ready.status,'target-ready');
 const configuration=await value('web.configuration'),drawings=await value('web.drawingsState'),state=await value('web.presentationState');assert.ok(configuration.indicators.some(row=>row.id==='pressure-id'&&row.name==='aster.volume-direction@1/pressure'));assert.equal(drawings.selected,'kept');assert.equal(drawings.canUndo,true);assert.equal(drawings.canRedo,true);assert.equal(state.interaction.tool,'trendline');assert.equal(state.interaction.drawingMagnet.mode,'strong');assert.equal(state.interaction.crosshairSnap.mode,'ohlc');
 assert.equal(capture.check(),true);capture.finish();
});
