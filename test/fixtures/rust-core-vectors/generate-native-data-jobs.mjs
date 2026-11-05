#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BarStore,FIELDS,seededColumns} from '../../../src/core/data.mjs';
import {ChartModel} from '../../../src/core/model.mjs';
import {AsyncCapture,AsyncPrepared} from '../../../src/core/async-state.mjs';
import {PrepareCapture,PreparedData} from '../../../src/core/prepare-state.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-data-jobs.leaf.jsonl');
const sources=['src/core/async-state.mjs','src/core/prepare-state.mjs','src/core/data.mjs','src/core/model.mjs','src/core/indicators.mjs','src/core/checkpoint-validation.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function bits(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:bits(value)};
 if(value===undefined)return{$undefined:true};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));
 if(typeof value==='object'){
  if(seen.has(value))throw new TypeError('cyclic fixture');seen.add(value);
  const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;
 }
 throw new TypeError('unsupported fixture value');
}
function encodeRow(row){const result={kind:row.kind,id:row.id};for(const[key,value]of Object.entries(row))if(!['kind','id'].includes(key))result[key]=encode(value);return result;}
function sourceModel(length=8){
 const store=new BarStore();store.setColumns(seededColumns(length,42));
 const model=new ChartModel({store,panels:[{id:'price',weight:3,label:'P'},{id:'lower',weight:1}],visibleBars:5});
 model.indicators.add('ema','ema',{period:3});
 model.addSeries({id:'price',type:'candles',panel:'price'});
 model.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#f0b755'});
 return model;
}
function checkpointRows(capture){return capture.checkpoints.map((row,entry)=>({entry,maxRows:row.maxRows,keys:[...row.keys],chunks:row.keys.length?[JSON.parse(capture.checkpoint(entry,0,Math.min(row.maxRows,row.keys.length)))]:[]}));}
function transfer(capture,target){
 for(let slot=0;slot<capture.buffers.length;slot++)for(let offset=0;offset<capture.buffers[slot].length;offset+=3){const count=Math.min(3,capture.buffers[slot].length-offset);target.target(slot,offset,count).set(capture.buffer(slot,offset,count));}
 for(let entry=0;entry<capture.checkpoints.length;entry++){const row=capture.checkpoints[entry];for(let offset=0;offset<row.keys.length;offset+=row.maxRows){const count=Math.min(row.maxRows,row.keys.length-offset);target.checkpoint(entry,capture.checkpoint(entry,offset,count));}}
}
function progress(target,chunk){const rows=[];target.start();for(let guard=0;guard<1000;guard++){const row=target.step(chunk);rows.push(row);if(row.complete)return rows;}throw new Error('progress guard');}
function state(model){
 const store=model.store,indicators=[...model.indicators.entries].map(([id,e])=>({id,name:e.name,params:e.params,outputs:e.def.outputs,plotOffsets:e.def.plotOffsets??{},revision:e.revision,dirty:e.dirty,dirtyTo:e.dirtyTo??null,invalidated:e.invalidated,length:e.length,computedFrom:e.computedFrom??null,computedUntil:e.computedUntil??null,checkpointKeys:[...e.checkpoints.keys()],arrays:e.arrays.map(a=>Array.from(a.subarray(0,store.length)))}));
 return{store:{length:store.length,capacity:store.capacity,maxBars:store.maxBars,timeframeMs:store.timeframeMs,timeOrigin:store.timeOrigin,version:store.version,timeVersion:store.timeVersion,columns:Object.fromEntries(FIELDS.map(k=>[k,Array.from(store.columns[k].subarray(0,store.length))]))},view:{...model.view},follow:model.follow,theme:{...model.theme},panels:model.panels.map(p=>({...p})),axes:model.axes.map(a=>({...a})),series:model.series.map(({rangeIndex,values,...s})=>({...s,...(values?{values:Array.from(values)}:{})})),indicators};
}
function errorOf(action){try{action();return null;}catch(error){return{name:error.name,message:error.message,code:error.code??null};}}
function correctionCase(){
 const model=sourceModel(),original=model.store.at(2),event={kind:'correction',bar:{...original,close:original.close+1,high:Math.max(original.high,original.close+1),volume:-0}},capture=new AsyncCapture(model,event),target=new AsyncPrepared(capture.metadataJSON);
 try{const metadata=JSON.parse(capture.metadataJSON),buffers=capture.buffers.map((buffer,slot)=>({slot,length:buffer.length,values:Array.from(buffer)})),checkpoints=checkpointRows(capture),badSlice=errorOf(()=>capture.buffer(0,0,262145));transfer(capture,target);const steps=progress(target,2),ready=state(target.model),finished=target.finish(capture.ui(null,{width:400,height:300})),result=state(finished.model);finished.model.dispose();return{kind:'case',id:'correction',metadata,buffers,checkpoints,badSlice,steps,ready,result};}
 finally{capture.release();target.dispose();model.dispose();}
}
function correctionCacheCase(){
 const model=sourceModel();model.seriesData(model.series[1]);const original=model.store.at(2),event={kind:'correction',bar:{...original,close:original.close+1,high:Math.max(original.high,original.close+1),volume:-0}},capture=new AsyncCapture(model,event),target=new AsyncPrepared(capture.metadataJSON);
 try{const metadata=JSON.parse(capture.metadataJSON),buffers=capture.buffers.map((buffer,slot)=>({slot,length:buffer.length,values:Array.from(buffer)})),checkpoints=checkpointRows(capture);transfer(capture,target);const steps=progress(target,2),ready=state(target.model);return{kind:'case',id:'correction-cache',metadata,buffers,checkpoints,steps,ready};}
 finally{capture.release();target.dispose();model.dispose();}
}
function prepareSeededCase(){
 const model=sourceModel(0),capture=new PrepareCapture(model,{kind:'seeded',count:8,seed:42,visibleBars:5}),target=new PreparedData(capture.metadataJSON);
 try{const metadata=JSON.parse(capture.metadataJSON),steps=progress(target,2),ready=state(target.model),finished=target.finish(capture.ui(null,{width:400,height:300})),result=state(finished.model);finished.model.dispose();return{kind:'case',id:'prepare-seeded',metadata,steps,ready,result};}
 finally{capture.release();target.dispose();model.dispose();}
}
function prepareColumnsCase(){
 const model=sourceModel(0),capture=new PrepareCapture(model,{kind:'columns',length:4,seed:7,visibleBars:3}),target=new PreparedData(capture.metadataJSON),columns=seededColumns(4,7);
 try{for(let slot=0;slot<6;slot++){target.target(slot,0,2).set(columns[FIELDS[slot]].subarray(0,2));target.target(slot,2,2).set(columns[FIELDS[slot]].subarray(2,4));}const metadata=JSON.parse(capture.metadataJSON),steps=progress(target,1),ready=state(target.model),finished=target.finish(capture.ui(null,{width:400,height:300})),result=state(finished.model);finished.model.dispose();return{kind:'case',id:'prepare-columns',metadata,input:Object.fromEntries(FIELDS.map(k=>[k,Array.from(columns[k])])),steps,ready,result};}
 finally{capture.release();target.dispose();model.dispose();}
}
function prepareBigProgressCase(){
 const model=sourceModel(0),capture=new PrepareCapture(model,{kind:'seeded',count:8193,seed:42,visibleBars:200}),target=new PreparedData(capture.metadataJSON);
 try{const steps=progress(target,4096),series=target.model.series[1],data=target.model.seriesData(series);return{kind:'case',id:'prepare-big-progress',steps,cache:{blocked:data.index.constructor.name==='BlockRangeIndex',size:data.index.size,finite:data.index.finiteCount(0,8193),gaps:data.index.hasGaps(0,8193),revision:series.revision,dirtyFrom:series.dirtyFrom}};}
 finally{capture.release();target.dispose();model.dispose();}
}
function failuresCase(){
 const model=sourceModel(4),correction=new AsyncCapture(model,{kind:'correction',bar:{...model.store.at(0),volume:2}}),prepared=new AsyncPrepared(correction.metadataJSON),prepare=new PrepareCapture(model,{kind:'columns',length:2}),target=new PreparedData(prepare.metadataJSON);
 try{return{kind:'case',id:'failures',asyncIncomplete:errorOf(()=>prepared.start()),asyncTargetOrder:errorOf(()=>prepared.target(0,1,1)),prepareIncomplete:errorOf(()=>target.start()),prepareSlice:errorOf(()=>target.target(0,1,1)),sourceState:state(model)};}
 finally{correction.release();prepared.dispose();prepare.release();target.dispose();model.dispose();}
}
export function generateNativeDataJobsOracle(){
 const header={kind:'header',schema:'barochart.rust-core.native-data-jobs-leaf',version:1,oracleCommit:'8457612bda98c764bc1a9e7e794dafcf9316a47e',sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,seed:42,dialect:'ECMA-262/V8',encoding:'f64 bits; objects ordered entries',callSequence:['source capture','metadata/buffer/checkpoint copy','target start','bounded steps','finish UI/core']};
 return[JSON.stringify(header),...[
  correctionCase(),correctionCacheCase(),prepareSeededCase(),prepareColumnsCase(),prepareBigProgressCase(),failuresCase(),
 ].map(row=>JSON.stringify(encodeRow(row)))].join('\n')+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-data-jobs.mjs [--check|--write]');const output=generateNativeDataJobsOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native-data-jobs.leaf.jsonl is stale');console.log('native data jobs oracle fresh: 6 cases');}else if(mode==='--write'){writeFileSync(fixture,output);console.log('native data jobs oracle wrote: 6 cases');}else process.stdout.write(output);
}
