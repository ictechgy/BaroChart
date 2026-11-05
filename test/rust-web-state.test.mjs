import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';
import {createWasmHarness,wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

const cargoAvailable=existsSync(join(rustupBinDirectory(process.env),'cargo'));
const target=wasmTargetAvailable();
const requireWasm=process.env.REQUIRE_WASM==='1';
const skip=requireWasm?false:(!cargoAvailable?'rustup cargo is unavailable':!target.available?target.reason:false);

test('web query namespace reports executable capability metadata and rejects unknown names',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 const capabilities=await harness.call('web.capabilities',[]);
 assert.equal(capabilities.status,0);
 assert.equal(capabilities.value.schema,'aster.web-wasm.capabilities');
 assert.equal(capabilities.value.version,1);
 assert.ok(capabilities.value.implemented.includes('web.presentationState'));
 assert.equal(capabilities.value.implemented.includes('web.dataColumn'),false);
 assert.deepEqual(capabilities.value.typedReads,['web.dataColumn']);
 assert.ok(capabilities.value.implemented.includes('web.paramsSourcePublish'));
 assert.ok(capabilities.value.implemented.includes('web.migrationSourceBegin'));
 assert.ok(capabilities.value.implemented.includes('web.layoutCapture'));
 assert.deepEqual(capabilities.value.unavailable,[]);
 const unknown=await harness.call('web.notARealQuery',[]);
 assert.equal(unknown.status,2);
 assert.equal(unknown.error?.name,'UnavailableError');
 assert.equal((await harness.call('nativeInit',[1,null])).status,0);
 assert.equal((await harness.call('web.capabilities',[])).status,0);
});

test('web presentation/configuration/drawing snapshots derive from live Rust state and omit bulk arrays',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 assert.equal((await harness.call('nativeInit',[10_000,null])).status,0);
 const presentation=await harness.call('web.presentationState',[]);
 assert.equal(presentation.status,0);
 assert.equal(presentation.value.schema,'aster.web-wasm.presentation');
 assert.equal(presentation.value.data.length,10_000);
 assert.equal(typeof presentation.value.data.version,'number');
 assert.equal(presentation.value.configuration.panels,2);
 assert.equal(presentation.value.configuration.series,3);
 assert.equal(Object.hasOwn(presentation.value,'columns'),false);
 assert.equal(Object.hasOwn(presentation.value,'values'),false);
 const configuration=await harness.call('web.configuration',[]);
 assert.equal(configuration.status,0);
 assert.equal(configuration.value.series.length,3);
 assert.ok(configuration.value.indicators.some(entry=>entry.id==='ema'&&entry.name==='ema'&&Object.keys(entry.params).length===0));
 assert.ok(configuration.value.indicators.every(entry=>Array.isArray(entry.outputs)&&!Object.hasOwn(entry,'arrays')&&!Object.hasOwn(entry,'checkpoints')));
 assert.equal(configuration.value.series.some(item=>Object.hasOwn(item,'values')),false);
 assert.equal(configuration.value.series.some(item=>Object.hasOwn(item,'indicatorValues')),false);
 const drawings=await harness.call('web.drawingsState',[]);
 assert.equal(drawings.status,0);
 assert.equal(drawings.value.items.length,0);
 assert.equal(drawings.value.canUndo,false);
 assert.equal(drawings.value.canRedo,false);
});

test('web cold indicator catalog is registry-backed and has no computed arrays',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 assert.equal((await harness.call('nativeInit',[100_000,null])).status,0);
 const catalog=await harness.call('web.indicatorCatalog',[]);
 assert.equal(catalog.status,0);
 assert.equal(catalog.value.schema,'aster.web-wasm.indicator-catalog');
 assert.equal(catalog.value.count,36);
 assert.equal(catalog.value.entries.length,36);
 assert.ok(catalog.value.entries.every(item=>Array.isArray(item.params)&&Array.isArray(item.outputs)));
 assert.ok(catalog.value.entries.every(item=>!Object.hasOwn(item,'values')&&!Object.hasOwn(item,'data')));
});

test('web read-only queries return an ordinary initialization error and do not poison the engine',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 const before=await harness.call('web.presentationState',[]);
 assert.notEqual(before.status,0);
 assert.ok(['Error','ReferenceError','TypeError'].includes(before.error?.name));
 assert.equal((await harness.call('nativeInit',[1,null])).status,0);
 assert.equal((await harness.call('web.presentationState',[])).status,0);
 assert.equal(harness.hostReleaseCount,0);
});

test('presentation interaction state follows a real nativeTool command',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 assert.equal((await harness.call('nativeInit',[10_000,null])).status,0);
 assert.equal((await harness.call('nativeTool',['trendline'])).status,0);
 assert.equal((await harness.call('nativeCommand',['setDrawingMagnet',[{mode:'weak',radiusPx:8}]])).status,0);
 const state=await harness.call('web.presentationState',[]);
 assert.equal(state.status,0);
 assert.equal(state.value.interaction.available,true);
 assert.equal(state.value.interaction.tool,'trendline');
 assert.equal(state.value.interaction.drawingMagnet.mode,'weak');
 assert.equal(typeof state.value.interaction.pointerCount,'number');
 assert.equal(Object.hasOwn(state.value.interaction,'columns'),false);
});

test('configuration preserves styled series metadata without external values',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 assert.equal((await harness.call('nativeInit',[10_000,null])).status,0);
 const added=await harness.call('nativeCommand',['addSeries',[{
   id:'styled',type:'area',panel:'price',source:'close',label:'Styled source',
   color:'#123456',fill:'#12345633',width:2,baseline:-0,visible:true,
 }]]);
 assert.equal(added.status,0);
 const configuration=await harness.call('web.configuration',[]);
 assert.equal(configuration.status,0);
 const styled=configuration.value.series.find(item=>item.id==='styled');
 assert.deepEqual(styled,{id:'styled',type:'area',panel:'price',source:'close',color:'#123456ff',fill:'#12345633',width:2,baseline:-0,offset:0,visible:true,label:'Styled source'});
 assert.equal(Object.hasOwn(styled,'values'),false);
 assert.equal((await harness.call('nativeCommand',['addIndicator',['extra-1','ema',{period:9}]] )).status,0);
 const current=(await harness.call('web.configuration',[])).value;
 assert.deepEqual(current.indicators.find(entry=>entry.id==='extra-1'),{id:'extra-1',name:'ema',params:{period:9},outputs:['value'],plotOffsets:{}});
});

test('web.dataColumn returns exact typed slices and rejects stale or invalid reads',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 const bars=[
  {time:1,open:10,high:12,low:9,close:11,volume:1},
  {time:2,open:11,high:13,low:10,close:12,volume:-0},
  {time:3,open:12,high:14,low:11,close:13,volume:3},
  {time:4,open:13,high:15,low:12,close:14,volume:4},
 ];
 assert.equal((await harness.call('nativeInit',[4,null])).status,0);
 assert.equal((await harness.call('nativeCommand',['setData',[bars]])).status,0);
 const presentation=await harness.call('web.presentationState',[]);
 const version=presentation.value.data.version;
 const read=async(field,start,count,expected=version)=>{
  const result=harness.webCall('web.dataColumn',[field,start,count,expected]);
  assert.equal(result.status,0);
  const view=new DataView(result.value.buffer,result.value.byteOffset,result.value.byteLength);
  return Array.from({length:count},(_,index)=>view.getFloat64(index*8,true));
 };
 assert.deepEqual(await read('close',0,4),[11,12,13,14]);
 const volume=await read('volume',1,1);
 assert.equal(Object.is(volume[0],-0),true);
 assert.deepEqual(await read('open',1,2),[11,12]);
 for(const args of [['bogus',0,1,version],['close',5,1,version],['close',0,262145,version],['close',0,1,version+1]]){
  const result=harness.webCall('web.dataColumn',args);
  assert.notEqual(result.status,0,args.join(','));
 }
 assert.equal((await harness.call('web.presentationState',[])).status,0);
});
