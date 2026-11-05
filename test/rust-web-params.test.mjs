import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createWasmHarness,wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';

const target=wasmTargetAvailable(),requireWasm=process.env.REQUIRE_WASM==='1';
const skip=requireWasm?false:(!existsSync(join(rustupBinDirectory(process.env),'cargo'))?'rustup cargo is unavailable':!target.available?target.reason:false);
const REVISION=3,MAX_BYTES=805306368,CHUNK=16384;
const PREBUILT='artifacts/rust-wasm/harness-target/wasm32-unknown-unknown/release/barochart_wasm.wasm';let built=false;
async function harness(){if(built)return createWasmHarness({prebuiltPath:PREBUILT});const value=await createWasmHarness();built=true;return value;}

const value=async(harness,name,args=[])=>{const result=await harness.call(name,args);assert.equal(result.status,0,`${name}: ${JSON.stringify(result.error)}`);return result.value;};
const floats=bytes=>{assert.equal(bytes.byteLength%8,0);const result=new Float64Array(bytes.byteLength/8),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let index=0;index<result.length;index++)result[index]=view.getFloat64(index*8,true);return result;};
const bits=bytes=>{assert.equal(bytes.byteLength%8,0);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return Array.from({length:bytes.byteLength/8},(_,index)=>view.getBigUint64(index*8,true));};

async function fixture(t,count=257){
 const source=await harness(),worker=await harness();t.after(async()=>{await source.dispose();await worker.dispose();});
 await value(source,'nativeInit',[count,{series:[]}]);
 await value(source,'nativeCommand',['addIndicator',['s','ema',{period:20}]]);
 await value(source,'nativeCommand',['addSeries',[{id:'s-line',type:'line',panel:'price',indicator:'s'}]]);
 return{source,worker,count};
}

async function begin(f,{registration=1,web=true,params={period:9}}={}){
 const prefix=web?'web.':'nativeParams';
 const name=web?`${prefix}paramsSourceBegin`:`${prefix}SourceBegin`;
 const row=await value(f.source,name,['s',params,REVISION,MAX_BYTES,registration]);f.ticket=row.ticket;f.registration=registration;f.web=web;
 let step;do{step=await value(f.source,web?'web.paramsSourceStep':'nativeParamsSourceStep',[row.ticket,8,REVISION]);}while(!step.complete);
 return step;
}

async function receive(f,plan){
 const s=f.source,w=f.worker,t=f.ticket,prefix=f.web?'web.paramsSource':'nativeParamsSource';
 await value(w,'nativeParamsTargetCreate',[plan.metadataJSON]);const metadata=JSON.parse(plan.metadataJSON);
 for(let slot=0;slot<6;slot++)for(let at=0;at<metadata.length;at+=CHUNK){const count=Math.min(CHUNK,metadata.length-at),read=s.webCall('nativeAsyncBuffer',[t,slot,at,count]);assert.equal(read.status,0);const write=w.webWriteF64('nativeAsyncTargetBuffer',[slot,at,count],floats(read.value));assert.deepEqual({status:write.status,didWrite:write.didWrite},{status:0,didWrite:1});}
 await value(w,'nativeParamsTargetStart');let progress;do{progress=await value(w,'nativeParamsTargetStep',[CHUNK]);}while(!progress.complete);
 const descriptor=await value(w,'nativeParamsTargetDescriptor');await value(s,`${prefix}Receive`,[t,descriptor,REVISION]);const decoded=JSON.parse(descriptor);
 f.result={decoded,prefix};return f.result;
}

async function finish(f,plan){
 const s=f.source,w=f.worker,t=f.ticket,r=f.registration,{decoded,prefix}=await receive(f,plan);let progress;
 for(let slot=0;slot<decoded.outputs.length;slot++)for(let at=0;at<decoded.capacity;at+=CHUNK){const count=Math.min(CHUNK,decoded.capacity-at),read=w.webCall('nativeAsyncBuffer',[r,slot,at,count]);assert.equal(read.status,0);await value(s,`${prefix}ArmWrite`,[t,slot,at,count,REVISION]);const write=s.webWriteF64('nativeAsyncTargetBuffer',[slot,at,count],floats(read.value));assert.deepEqual({status:write.status,didWrite:write.didWrite},{status:0,didWrite:1});}
 for(let ordinal=0;ordinal<decoded.checkpointCount;ordinal++){const row=await value(w,'nativeParamsTargetCheckpoint',[ordinal]);await value(s,`${prefix}Checkpoint`,[t,row.index,row.text,REVISION]);}
 do{progress=await value(s,`${prefix}Validate`,[t,CHUNK,REVISION]);}while(!progress.complete);
 await w.dispose();await value(s,`${prefix}Prepare`,[t,REVISION]);return value(s,`${prefix}Publish`,[t,REVISION]);
}

test('web params publishes worker results while preserving concurrent presentation, drawing and controller state',{skip},async t=>{
 const f=await fixture(t),before=f.source.webCall('nativeIndicatorBuffer',['s','value',0,f.count]);assert.equal(before.status,0);
 const plan=await begin(f);
 await value(f.source,'nativeView',[1,200]);
 await value(f.source,'nativeCommand',['setTheme',[{font:'17px serif',background:'#010203'}]]);
 await value(f.source,'nativeCommand',['addDrawing',[{id:'kept',type:'horizontal',panel:'price',points:[{time:1,price:7}]}]]);
 await value(f.source,'nativeTool',['trendline']);await value(f.source,'nativeCommand',['setText',['web-note']]);
 const rendered=f.source.webPacket(['scene',null,800,500]);assert.equal(rendered.status,0);
 const receipt=await finish(f,plan);assert.equal(receipt.status,'committed');
 const state=await value(f.source,'web.presentationState'),configuration=await value(f.source,'web.configuration'),drawings=await value(f.source,'web.drawingsState');
 assert.deepEqual([state.view.from,state.view.to,state.interaction.tool,state.interaction.text],[1,200,'trendline','web-note']);
 assert.equal(configuration.theme.font,'17px serif');assert.equal(drawings.items[0].id,'kept');assert.equal(drawings.canUndo,true);
 const after=f.source.webCall('nativeIndicatorBuffer',['s','value',0,f.count]);assert.equal(after.status,0);assert.notDeepEqual(bits(after.value),bits(before.value));
});

test('web params detects append and reset data mutations before publication',{skip},async t=>{
 for(const event of [
  {kind:'append',bar:{time:9_000_000_000_000,open:1,high:2,low:0,close:1,volume:1}},
  {kind:'reset',bars:[{time:1,open:1,high:1,low:1,close:1,volume:1}]},
 ]){
  const f=await fixture(t),old=f.source.webCall('nativeIndicatorBuffer',['s','value',0,f.count]);assert.equal(old.status,0);await begin(f);
  assert.equal((await f.source.call('nativeDataEvent',[event])).status,0);
  const checked=await f.source.call('web.paramsSourceCheck',[f.ticket,REVISION]);assert.notEqual(checked.status,0);assert.equal(checked.error?.name,'StaleSourceError');
  const current=f.source.webCall('nativeIndicatorBuffer',['s','value',0,event.kind==='append'?f.count+1:1]);assert.equal(current.status,0);assert.notDeepEqual(bits(current.value),bits(old.value));
 }
});

test('web params rejects changed series binding and symbol without publishing a partial replacement',{skip},async t=>{
 const f=await fixture(t),old=f.source.webCall('nativeIndicatorBuffer',['s','value',0,f.count]);assert.equal(old.status,0);
 await begin(f);await value(f.source,'nativeCommand',['setSeries',['s-line',{panel:'price',axisId:null,color:'#abcdef'}]]);
 const checked=await f.source.call('web.paramsSourceCheck',[f.ticket,REVISION]);assert.notEqual(checked.status,0);assert.equal(checked.error?.name,'StaleSourceError');
 assert.deepEqual(bits(f.source.webCall('nativeIndicatorBuffer',['s','value',0,f.count]).value),bits(old.value));
 const f2=await fixture(t),f2plan=await begin(f2);await receive(f2,f2plan);await value(f2.source,'nativeCommand',['setSymbol',[{id:'BTC',exchange:'DEMO',timezone:'UTC',currency:'USD',volumeUnit:'BTC',priceDecimals:2,tickSize:.01,adjustment:'raw'}]]);
 const symbolCheck=await f2.source.call('web.paramsSourceCheck',[f2.ticket,REVISION]);assert.notEqual(symbolCheck.status,0);assert.equal(symbolCheck.error?.name,'StaleSourceError');
 const f3=await fixture(t);await begin(f3);await value(f3.source,'nativeCommand',['addIndicator',['other','sma',{period:3}]]);
 const registryCheck=await f3.source.call('web.paramsSourceCheck',[f3.ticket,REVISION]);assert.notEqual(registryCheck.status,0);assert.equal(registryCheck.error?.name,'StaleSourceError');
 const f4=await fixture(t),first=Array.from({length:f4.count},(_,index)=>index),second=first.map(value=>value+1);
 await value(f4.source,'nativeCommand',['addSeries',[{id:'external',type:'line',panel:'price',values:first}]]);await begin(f4);
 await value(f4.source,'nativeCommand',['setSeriesValues',['external',second]]);
 const valuesCheck=await f4.source.call('web.paramsSourceCheck',[f4.ticket,REVISION]);assert.notEqual(valuesCheck.status,0);assert.equal(valuesCheck.error?.name,'StaleSourceError');
});

test('legacy native params keeps the strict presentation fingerprint',{skip},async t=>{
 const f=await fixture(t);await begin(f,{web:false});await value(f.source,'nativeView',[1,200]);
 const checked=await f.source.call('nativeParamsSourceCheck',[f.ticket,REVISION]);assert.notEqual(checked.status,0);assert.equal(checked.error?.name,'StaleSourceError');
});
