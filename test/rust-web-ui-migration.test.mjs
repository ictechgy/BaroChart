import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createWasmHarness,wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';

const target=wasmTargetAvailable(),requireWasm=process.env.REQUIRE_WASM==='1';
const skip=requireWasm?false:(!existsSync(join(rustupBinDirectory(process.env),'cargo'))?'rustup cargo is unavailable':!target.available?target.reason:false);
const REVISION=7,REGISTRATION=1,MAX_BYTES=805306368,CHUNK=16384;
const PREBUILT='artifacts/rust-wasm/harness-target/wasm32-unknown-unknown/release/barochart_wasm.wasm';let built=false;
async function harness(){if(built)return createWasmHarness({prebuiltPath:PREBUILT});const value=await createWasmHarness();built=true;return value;}
const value=async(h,name,args=[])=>{const result=await h.call(name,args);assert.equal(result.status,0,`${name}: ${JSON.stringify(result.error)}`);return result.value;};
const floats=bytes=>{assert.equal(bytes.byteLength%8,0);const output=new Float64Array(bytes.byteLength/8),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let at=0;at<output.length;at++)output[at]=view.getFloat64(at*8,true);return output;};

async function decorate(source){
 await value(source,'nativeView',[1,6]);
 await value(source,'nativeCommand',['setTheme',[{font:'17px serif',background:'#010203'}]]);
 await value(source,'nativeCommand',['addDrawing',[{id:'d1',type:'horizontal',panel:'price',points:[{time:1,price:7}]}]]);
 await value(source,'nativeCommand',['addDrawing',[{id:'d2',type:'horizontal',panel:'price',points:[{time:2,price:8}]}]]);
 await value(source,'nativeCommand',['undo',[]]);
 await value(source,'nativeCommand',['selectDrawing',['d1']]);
 await value(source,'nativeTool',['trendline']);
 await value(source,'nativeCommand',['setText',['migration-note']]);
 await value(source,'nativeCommand',['setDrawingMagnet',[{mode:'strong'}]]);
 await value(source,'nativeCommand',['setCrosshairSnap',[{mode:'ohlc'}]]);
}

async function fixture(t,count=8){
 const source=await harness(),target=await harness();t.after(async()=>{await source.dispose();await target.dispose();});
 await value(source,'nativeInit',[count,{series:[]}]);await decorate(source);
 const binding={key:'web-migration',revision:'r1',adjustmentVersion:'a1',priceUnit:'USD',adjustment:'raw'};
 const document=await value(source,'nativeSaveWorkspace',[binding]);
 return{source,target,binding,document,count};
}

async function prepare(f,{mutateDescription,workspaceOnly=false}={}){
 const begin=await value(f.source,'web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,REGISTRATION]);
 const ticket=begin.ticket;let plan;do{plan=await value(f.source,'web.migrationSourceStep',[ticket,64,REVISION]);}while(!plan.complete);
 const ui=await value(f.source,'web.migrationSourceUiBegin',[ticket,REVISION]),chunks=[];let chunk;
 do{chunk=await value(f.source,'web.migrationSourceUiNext',[ticket]);if(!JSON.parse(chunk).complete)chunks.push(chunk);}while(!JSON.parse(chunk).complete);
 await value(f.target,'web.migrationTargetCreate',[plan.metadataJSON,ticket,REGISTRATION,REVISION]);
 for(let slot=0;slot<6;slot++)for(let at=0;at<f.count;at+=CHUNK){const count=Math.min(CHUNK,f.count-at),read=f.source.webCall('nativeAsyncBuffer',[ticket,slot,at,count]);assert.equal(read.status,0);const written=f.target.webWriteF64('nativeAsyncTargetBuffer',[slot,at,count],floats(read.value));assert.deepEqual({status:written.status,didWrite:written.didWrite},{status:0,didWrite:1});}
 await value(f.target,'web.migrationTargetStart');let progress;do{progress=JSON.parse(await value(f.target,'web.migrationTargetStep',[64]));}while(!progress.complete);
 if(workspaceOnly)return{ticket,ui,chunks};
 const description=mutateDescription?mutateDescription(structuredClone(ui.description)):ui.description;
 const beginUi=await f.target.call('web.migrationTargetUiBegin',[description,ui.header]);
 if(beginUi.status!==0)return{ticket,ui,chunks,beginUi};
 for(const row of chunks)await value(f.target,'web.migrationTargetUiChunk',[row]);
 return{ticket,ui,chunks};
}

test('workspace target without UI migration resets controller and drawing history',{skip},async t=>{
 const f=await fixture(t),migration=await prepare(f,{workspaceOnly:true});
 await value(f.target,'nativeWorkspaceTargetFinish');
 const state=await value(f.target,'web.presentationState'),drawings=await value(f.target,'web.drawingsState');
 assert.equal(state.interaction.tool,'select');assert.equal(drawings.items.length,1);assert.equal(drawings.selected,null);assert.equal(drawings.canUndo,false);assert.equal(drawings.canRedo,false);
 await value(f.source,'web.migrationSourceAbort',[migration.ticket]);
});

test('workspace plus UI migration restores history, selection, controller and styles across two WASM instances',{skip},async t=>{
 const f=await fixture(t),migration=await prepare(f);
 const ready=await value(f.target,'web.migrationTargetUiFinish',[migration.ticket,REGISTRATION,REVISION]);assert.equal(ready.status,'target-ready');
 await value(f.source,'web.migrationSourceCheck',[migration.ticket,REGISTRATION,REVISION]);
 const sourceReceipt=await value(f.source,'web.migrationSourceFinish',[migration.ticket,REGISTRATION,REVISION]);assert.equal(sourceReceipt.ticket,migration.ticket);
 const sourceState=await value(f.source,'web.presentationState'),targetState=await value(f.target,'web.presentationState');
 const sourceDrawings=await value(f.source,'web.drawingsState'),targetDrawings=await value(f.target,'web.drawingsState');
 assert.deepEqual(targetState.view,sourceState.view);assert.deepEqual(targetState.interaction,sourceState.interaction);
 assert.deepEqual(targetDrawings,sourceDrawings);assert.equal(targetDrawings.items.length,1);assert.equal(targetDrawings.canUndo,true);assert.equal(targetDrawings.canRedo,true);assert.equal(targetDrawings.selected,'d1');
 assert.equal((await value(f.target,'web.configuration')).theme.font,'17px serif');
 assert.equal(await value(f.target,'nativeSaveWorkspace',[f.binding]),f.document);
});

test('migration source rejects running or pending ingestion before capture without changing the live chart',{skip},async t=>{
 const f=await fixture(t);await value(f.source,'nativeCommand',['configureDataIngestion',[{streamId:'web-migration',generation:1,firstSequence:0}]]);
 let rejected=await f.source.call('web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,REGISTRATION]);assert.notEqual(rejected.status,0);assert.match(rejected.error.message,/paused empty ingestion/);
 const state=await value(f.source,'web.presentationState'),read=field=>floats(f.source.webCall('web.dataColumn',[field,7,1,state.data.version]).value)[0];
 const bar={time:read('time'),open:read('open'),high:read('high'),low:read('low'),close:read('close'),volume:read('volume')};
 await value(f.source,'nativeCommand',['enqueueDataEvents',[{streamId:'web-migration',generation:1,firstSequence:0,events:[{kind:'update',bar}]}]]);await value(f.source,'nativeCommand',['pauseDataIngestion',[]]);
 rejected=await f.source.call('web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,REGISTRATION]);assert.notEqual(rejected.status,0);assert.match(rejected.error.message,/paused empty ingestion/);
 assert.equal((await value(f.source,'web.drawingsState')).items.length,1);
});

test('source abort releases workspace lease before and after UI capture validation',{skip},async t=>{
 const f=await fixture(t);
 const first=await value(f.source,'web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,REGISTRATION]);
 assert.equal(await value(f.source,'web.migrationSourceAbort',[first.ticket]),true);
 const second=await value(f.source,'web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,2]);let ready;do{ready=await value(f.source,'web.migrationSourceStep',[second.ticket,64,REVISION]);}while(!ready.complete);
 const invalid=await f.source.call('web.migrationSourceUiBegin',[second.ticket,REVISION+1]);assert.notEqual(invalid.status,0);
 assert.equal(await value(f.source,'web.migrationSourceAbort',[second.ticket]),true);
 const third=await value(f.source,'web.migrationSourceBegin',[f.document,f.binding,REVISION,MAX_BYTES,3]);assert.ok(third.ticket>second.ticket);assert.equal(await value(f.source,'web.migrationSourceAbort',[third.ticket]),true);
 assert.equal((await value(f.source,'web.drawingsState')).items.length,1);
});

test('paused empty ingestion is loaded once and remains byte exact after migration',{skip},async t=>{
 const f=await fixture(t);await value(f.source,'nativeCommand',['configureDataIngestion',[{streamId:'web-migration',generation:3,firstSequence:40}]]);await value(f.source,'nativeCommand',['pauseDataIngestion',[]]);
 const document=await value(f.source,'nativeCommand',['saveDataIngestion',[]]);f.document=await value(f.source,'nativeSaveWorkspace',[f.binding]);
 const migration=await prepare(f);await value(f.target,'web.migrationTargetUiFinish',[migration.ticket,REGISTRATION,REVISION]);await value(f.source,'web.migrationSourceCheck',[migration.ticket,REGISTRATION,REVISION]);await value(f.source,'web.migrationSourceFinish',[migration.ticket,REGISTRATION,REVISION]);
 assert.equal(await value(f.target,'nativeCommand',['saveDataIngestion',[]]),document);const stats=await value(f.target,'nativeCommand',['dataIngestionStats',[]]);assert.equal(stats.state,'paused');assert.equal(stats.pendingEvents,0);assert.equal(stats.nextSequence,40);
});

test('tampered target proof fails before publication and the source remains usable',{skip},async t=>{
 const f=await fixture(t),migration=await prepare(f,{mutateDescription(value){value.workspaceMetadata+='x';return value;}});assert.notEqual(migration.beginUi.status,0);
 assert.equal((await value(f.source,'web.presentationState')).data.length,8);
 assert.equal((await value(f.source,'web.drawingsState')).items.length,1);
});
