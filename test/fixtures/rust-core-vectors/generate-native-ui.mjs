#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';
import {AsyncCapture} from '../../../src/core/async-state.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-ui.leaf.jsonl');
const sources=['src/core/async-ui.mjs','src/core/async-state.mjs','src/core/interaction.mjs','src/core/drawings.mjs','examples/native/bridge.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function bits(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:bits(value)};
 if(value===undefined)return{$undefined:true};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));
 if(typeof value==='object'){if(seen.has(value))throw new TypeError('cyclic UI fixture');seen.add(value);const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;}
 throw new TypeError('unsupported UI fixture value');
}
function encodeRow(row){const result={kind:row.kind,id:row.id};for(const[key,value]of Object.entries(row))if(!['kind','id'].includes(key))result[key]=encode(value);return result;}
function run(context,source){return vm.runInContext(source,context,{timeout:10000});}
function errorOf(action){try{action();return null;}catch(error){return{name:error.name,message:error.message,code:error.code??null};}}
async function runtime(){const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context);return context;}
function configureUI(context){run(context,`(()=>{const a=nativeModel.store.at(1),b=nativeModel.store.at(6);nativeCommand('addDrawing',[{id:'d',type:'trendline',panel:'price',points:[{time:a.time,price:a.close},{time:b.time,price:b.close}]}]);nativeCommand('editDrawing',['d',{points:[{time:a.time,price:a.close+1},{time:b.time,price:b.close+1}]}]);nativeCommand('undo',[]);nativeCommand('selectDrawing',['d']);nativeCommand('setText',['hello']);nativeCommand('setDrawingTarget',[{panel:'price'}]);nativeCommand('setSymbol',[{id:'BTC-USD',exchange:'DEMO',timezone:'UTC',currency:'USD',volumeUnit:'BTC',priceDecimals:2,tickSize:.01,adjustment:'raw'}]);nativeView(1,6);nativeTool('trendline');nativePointer('move',0,240,140);})()`);}
function beginEvent(context){return run(context,`(()=>{const b=nativeModel.store.at(2);return nativeAsyncBegin(JSON.stringify({kind:'correction',bar:{...b,close:b.close+1,high:Math.max(b.high,b.close+1)}}));})()`);}
function stream(context,ticket){const header=context.nativeAsyncUIBegin(ticket),chunks=[];for(let guard=0;guard<1000;guard++){const text=context.nativeAsyncUINext(ticket),row=JSON.parse(text);chunks.push(text);if(row.complete)return{header,chunks};}throw new Error('UI stream guard');}

async function captureCase(){
 const context=await runtime();run(context,'nativeInit(8)');configureUI(context);const begin=JSON.parse(beginEvent(context)),direct=context.nativeAsyncUI(begin.ticket),transfer=stream(context,begin.ticket);
 const magnet=run(context,`nativeInput.setDrawingMagnet({mode:'weak',radiusPx:9})`),checkAfterMagnet=context.nativeAsyncUICheck(begin.ticket);context.nativeTool('select');const stale=errorOf(()=>context.nativeAsyncUICheck(begin.ticket));context.nativeAsyncRelease(begin.ticket);run(context,'nativeModel.dispose()');
 return{kind:'case',id:'capture',direct,header:transfer.header,chunks:transfer.chunks,magnet:magnet??null,checkAfterMagnet,stale};
}

async function importCase(){
 const source=await runtime(),target=await runtime();run(source,'nativeInit(8)');configureUI(source);const begin=JSON.parse(beginEvent(source));target.nativeAsyncCreate(begin.metadataJSON);
 for(const descriptor of begin.buffers)for(let at=0;at<descriptor.length;at+=3){const count=Math.min(3,descriptor.length-at);target.nativeAsyncTargetBuffer(descriptor.slot,at,count).set(source.nativeAsyncBuffer(begin.ticket,descriptor.slot,at,count));}
 for(const descriptor of begin.checkpoints)for(let at=0;at<descriptor.total;at+=descriptor.maxRows){const count=Math.min(descriptor.maxRows,descriptor.total-at);target.nativeAsyncCheckpointImport(descriptor.entry,source.nativeAsyncCheckpoint(begin.ticket,descriptor.entry,at,count));}
 target.nativeAsyncStart();const steps=[];for(let guard=0;guard<1000;guard++){const text=target.nativeAsyncStep(2),row=JSON.parse(text);steps.push(row);if(row.complete)break;}
 const transfer=stream(source,begin.ticket),importBegin=target.nativeAsyncUIImportBegin(transfer.header);for(const text of transfer.chunks)if(!JSON.parse(text).complete)target.nativeAsyncUIImportChunk(text);const importEnd=target.nativeAsyncUIImportEnd(),finished=target.nativeAsyncFinish(),state=run(target,`({inspect:JSON.parse(nativeInspect()),view:{...nativeModel.view},follow:nativeModel.follow,crosshair:nativeModel.crosshair,theme:{...nativeModel.theme},symbol:nativeModel.symbol,tool:nativeInput.tool,text:nativeInput.text,drawingTarget:nativeInput.drawingTarget,size:{...nativeSize},drawings:{items:nativeModel.drawings.items,undo:nativeModel.drawings.undoStack,redo:nativeModel.drawings.redoStack,selected:nativeModel.drawings.selected,serial:nativeModel.drawings.serial}})`);
 source.nativeAsyncRelease(begin.ticket);run(source,'nativeModel.dispose()');run(target,'nativeModel.dispose()');
 return{kind:'case',id:'import',steps,header:transfer.header,chunks:transfer.chunks,importBegin,importEnd,finished,state};
}

async function failuresCase(){
 const context=await runtime(),target=await runtime();run(context,'nativeInit(8)');configureUI(context);const begin=JSON.parse(beginEvent(context)),missingSource=errorOf(()=>context.nativeAsyncUINext(begin.ticket)),targetMissing=errorOf(()=>target.nativeAsyncUIImportChunk('{}')),targetUnavailable=errorOf(()=>target.nativeAsyncUIImportBegin('{}'));
 target.nativeAsyncCreate(begin.metadataJSON);const badHeader=errorOf(()=>target.nativeAsyncUIImportBegin('{}')),transfer=stream(context,begin.ticket);target.nativeAsyncUIImportBegin(transfer.header);const duplicateBegin=errorOf(()=>target.nativeAsyncUIImportBegin(transfer.header)),incomplete=errorOf(()=>target.nativeAsyncUIImportEnd());context.nativeAsyncRelease(begin.ticket);run(context,'nativeModel.dispose()');
 return{kind:'case',id:'failures',missingSource,targetMissing,targetUnavailable,badHeader,duplicateBegin,incomplete};
}

function directLimitCase(){const exact='x'.repeat(8_388_600),over='x'.repeat(8_388_601),fakeExact={uiState(){return{x:exact};}},fakeOver={uiState(){return{x:over};}},text=AsyncCapture.prototype.ui.call(fakeExact,null,null),overError=errorOf(()=>AsyncCapture.prototype.ui.call(fakeOver,null,null));return{kind:'case',id:'direct-limit',length:text.length,first:text.slice(0,8),last:text.slice(-8),overError};}

export async function generateNativeUIOracle(){
 const bundle=await buildNativeBundle(),header={kind:'header',schema:'barochart.rust-core.native-ui-leaf',version:1,oracleCommit:'8457612bda98c764bc1a9e7e794dafcf9316a47e',bundleSHA256:sha(bundle),sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,seed:42,dialect:'ECMA-262/V8',encoding:'f64 bits; exact header/chunk strings and ordered state',coverage:['direct 8 MiB limit','stream header/chunks/history refs','UI identity staleness','target import/publication']};
 const rows=[await captureCase(),await importCase(),await failuresCase(),directLimitCase()];return[JSON.stringify(header),...rows.map(row=>JSON.stringify(encodeRow(row)))].join('\n')+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-ui.mjs [--check|--write]');const output=await generateNativeUIOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native-ui.leaf.jsonl is stale');console.log('native UI oracle fresh: 4 cases');}else if(mode==='--write'){writeFileSync(fixture,output);console.log('native UI oracle wrote: 4 cases');}else process.stdout.write(output);}
