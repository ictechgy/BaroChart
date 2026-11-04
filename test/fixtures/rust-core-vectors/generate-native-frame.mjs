#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-frame.leaf.jsonl');
const sources=['src/core/frame-cache.mjs','src/core/scene.mjs','src/core/scene-parts.mjs','src/core/model.mjs','examples/native/bridge.mjs','src/renderers/native-command-packet.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function bits(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:bits(value)};if(value===undefined)return{$undefined:true};if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));if(typeof value==='object'){if(seen.has(value))throw new TypeError('cyclic frame fixture');seen.add(value);const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;}throw new TypeError('unsupported frame fixture value');
}
function run(context,source){return vm.runInContext(source,context,{timeout:10000});}
function frame(context,id,{force=false,token='view-a'}={}){
 const json=JSON.parse(context.nativeRenderFrameJSON(token,640,360,force));
 const packet=context.nativeScenePacket('frame',token==='view-a'?'view-b':token+'-packet',640,360,force);
 return{kind:'frame',id,force,token,json,packet:{metadata:JSON.parse(packet.metadata),numbers:packet.numbers}};
}
export async function generateNativeFrameOracle(){
 const bundle=await buildNativeBundle(),context=vm.createContext({});vm.runInContext(bundle,context);
 const rows=[];
 try{
  run(context,`nativeInit(16,{series:[]});nativeCommand('addSeries',[{id:'price',type:'candles',panel:'price'}]);nativeCommand('addIndicator',['ema','ema',{period:3}]);nativeCommand('addSeries',[{id:'ema-line',type:'line',panel:'price',indicator:'ema'}]);globalThis.externalValues=Float64Array.from({length:16},(_,i)=>200+i);nativeAPI.addSeries({id:'external',type:'line',panel:'price',values:externalValues,color:'#abcdef'});nativeCommand('addDrawing',[{id:'d',type:'trendline',panel:'price',points:[{time:nativeModel.store.at(2).time,price:nativeModel.store.at(2).close},{time:nativeModel.store.at(12).time,price:nativeModel.store.at(12).close}]}]);nativeCommand('selectDrawing',[null]);`);
  rows.push(frame(context,'initial'));
  rows.push(frame(context,'unchanged'));
  run(context,`nativePointer('move',0,240,140)`);rows.push(frame(context,'hover'));
  run(context,`nativeCommand('setSeries',['price',{color:'#ff0000'}])`);rows.push(frame(context,'style'));
  run(context,`nativeCommand('setVisibleRange',[2.5,12.5])`);rows.push(frame(context,'view'));
  run(context,`(()=>{const b=nativeModel.store.at(4);nativeCommand('applyDataEvent',[{kind:'correction',bar:{...b,close:b.close+1,high:Math.max(b.high,b.close+1)}}]);})()`);rows.push(frame(context,'data-lazy-build'));
  rows.push(frame(context,'lazy-indicator-stable'));
  run(context,`nativeCommand('selectDrawing',['d'])`);rows.push(frame(context,'drawing-select'));
  run(context,`nativeCommand('editDrawing',['d',{points:nativeModel.drawings.items[0].points.map(p=>({...p,price:p.price+1}))}])`);rows.push(frame(context,'drawing-edit'));
  run(context,`nativeCommand('undo',[])`);rows.push(frame(context,'drawing-undo'));
  run(context,`nativeModel.view={...nativeModel.view};nativeModel.panels=nativeModel.panels.map(p=>({...p}))`);rows.push(frame(context,'same-primitives-replacement'));
  rows.push(frame(context,'second-view-initial',{token:'view-c'}));
  rows.push(frame(context,'first-view-stable'));
  run(context,`nativeModel.theme={...nativeModel.theme}`);rows.push(frame(context,'raw-theme-object-same'));
  run(context,`nativeTheme({grid:'#123456'})`);rows.push(frame(context,'raw-theme-value'));
  run(context,`nativeAPI.setSeriesValues('external',Float64Array.from(externalValues))`);rows.push(frame(context,'equal-values-replacement'));
  run(context,`nativeAPI.setSymbol({id:'BTC-USD',exchange:'DEMO',timezone:'UTC',currency:'USD',volumeUnit:'BTC',priceDecimals:2,tickSize:.01,adjustment:'raw'})`);rows.push(frame(context,'symbol-setter'));
  rows.push(frame(context,'force',{force:true}));
 }finally{try{run(context,`nativeReleaseFrameCaches();nativeModel?.dispose()`);}catch{}}
 const header={kind:'header',schema:'barochart.rust-core.native-frame-leaf',version:1,oracleCommit:'8457612bda98c764bc1a9e7e794dafcf9316a47e',bundleSHA256:sha(bundle),sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,seed:42,dialect:'ECMA-262/V8',encoding:'all f64 command/packet numbers as exact bits',sequence:rows.map(row=>row.id)};
 return[JSON.stringify(header),...rows.map(row=>JSON.stringify({kind:row.kind,id:row.id,result:encode(row)}))].join('\n')+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-frame.mjs [--check|--write]');const output=await generateNativeFrameOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native-frame.leaf.jsonl is stale');console.log('native frame oracle fresh: 18 frames');}else if(mode==='--write'){writeFileSync(fixture,output);console.log('native frame oracle wrote: 18 frames');}else process.stdout.write(output);}
