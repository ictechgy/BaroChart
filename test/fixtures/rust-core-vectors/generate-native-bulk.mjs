#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ChartAPI} from '../../../src/core/api.mjs';
import {BarStore,FIELDS} from '../../../src/core/data.mjs';
import {ChartModel} from '../../../src/core/model.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-bulk.leaf.jsonl');
const sources=['src/core/data.mjs','src/core/api.mjs','src/core/markets.mjs','src/core/ingestion.mjs','src/core/data-batch-options.mjs'];
const sha256=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
const header={kind:'header',schema:'barochart.native-bulk-leaf',version:1,node:process.version,v8:process.versions.v8,sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha256(path)])),contract:'JSON.parse complete before receiver/data; state captured from current BarStore/ChartAPI source'};

const cases=[
 {id:'legacy-escaped-duplicate-extra',function:'nativeSetData',text:'[[{"ti\\u006de":0,"time":1,"open":2,"high":4,"low":1,"close":3,"volume":5,"extra":{"deep":[1,2,3]}}],{"ignored":true}]'},
 {id:'command-set-data-outer-extra',function:'nativeCommand',text:'["setData",[[{"time":1,"open":2,"high":4,"low":1,"close":3,"volume":5,"ignored":9}]],"ignored"]'},
 {id:'command-set-columns-last-duplicate-null-tail',function:'nativeCommand',text:'["setColumns",[{"ti\\u006de":[1,2,99],"open":[2,3,99],"high":[4,5,99],"low":[1,2,99],"close":[999],"close":[3,4,null],"volume":[5,6,99],"ignored":{"x":1}},2]]'},
 {id:'command-arity',function:'nativeCommand',text:'["setData",[[],1]]'},
 {id:'late-syntax',function:'nativeCommand',text:'["setData",[[{"time":1}]],]'},
];

function state(store){return{length:store.length,columns:Object.fromEntries(FIELDS.map(key=>[key,Array.from(store.columns[key].subarray(0,store.length))]))};}
function run(spec){let args;try{args=JSON.parse(spec.text);}catch(error){return{kind:'case',...spec,outcome:'syntax',error:{name:error.name}};}const store=new BarStore();try{if(spec.function==='nativeSetData')store.setData(args[0]);else new ChartAPI(new ChartModel({store})).dispatch(args[0],args[1]);return{kind:'case',...spec,outcome:'ok',state:state(store)};}catch(error){return{kind:'case',...spec,outcome:'error',error:{name:error.name,message:error.message,code:error.code??null},state:state(store)};}}
export function generateNativeBulkOracle(){return[header,...cases.map(run)].map(value=>JSON.stringify(value)).join('\n')+'\n';}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&mode!=='--check')throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-bulk.mjs [--check]');
 const output=generateNativeBulkOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native-bulk.leaf.jsonl is stale');console.log(`native bulk oracle fresh: ${cases.length} cases`);}else process.stdout.write(output);
}
