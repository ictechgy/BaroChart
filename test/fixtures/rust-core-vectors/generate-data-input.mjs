#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BarStore,FIELDS} from '../../../src/core/data.mjs';
import {ChartModel} from '../../../src/core/model.mjs';
import {ChartAPI} from '../../../src/core/api.mjs';
import {applyDataEvent} from '../../../src/core/markets.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/data-input.leaf.jsonl');
const ORACLE={kind:'header',schema:'barochart.rust-core.data-input-leaf',version:1,
 oracleCommit:'87598ca492e6a7273b60b629c0cf9f2456268853',localRustWorkspace:'dfb8566139b045110e6e77769a4a731b2b8c585f',
 bundleSHA256:'007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512',
 dataSHA256:'4abba0d1ea3fd2e73d3cca968ba09b17a40f14f4a479bc260a55a230b9134d0b',apiSHA256:'581dfd1556e31770afc308c76afe7a1d27f75ce92d0e86f715871e832b4dffe8',
 marketsSHA256:'605de3d5a787145980b832022fbb06318bb3db65a0ec9e89933c9365ef847cf5',batchOptionsSHA256:'c75807ba10323ded93e51d4fa2c9f2135b9bc72e5cc36fd1736c0925210503be',ingestionSHA256:'a19148e3f9d6d46788ead956be6cefb6fe7f29bc662b9ae13efd66cb4eddcde5',
 node:'v22.20.0',v8:'12.4.254.21-node.33',platform:'darwin-arm64',icu:'77.1',tzdata:'2025b',seed:'data-input-v1-fixed',dialect:'ECMA-262/V8',encoding:'f64 bits; objects ordered entries',
 callSequence:['construct BarStore','subscribe','direct Store/markets or ChartAPI call','capture result/error','capture store/change ledger']};
const hashes=[['native/Resources/aster-core.js','bundleSHA256'],['src/core/data.mjs','dataSHA256'],['src/core/api.mjs','apiSHA256'],['src/core/markets.mjs','marketsSHA256'],['src/core/data-batch-options.mjs','batchOptionsSHA256'],['src/core/ingestion.mjs','ingestionSHA256']];
function verify(){for(const[path,key]of hashes){const value=createHash('sha256').update(readFileSync(join(root,path))).digest('hex');if(value!==ORACLE[key])throw new Error(`data input source hash changed: ${path}`);}}
const buffer=new ArrayBuffer(8),view=new DataView(buffer);function f64(value){view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value){if(typeof value==='number')return{$f64:f64(value)};if(value===undefined)return{$undefined:true};if(typeof value==='string'||typeof value==='boolean'||value===null)return value;if(Array.isArray(value)||ArrayBuffer.isView(value))return Array.from(value,encode);if(value&&typeof value==='object')return{$object:Object.entries(value).map(([key,child])=>[key,encode(child)])};throw new TypeError('unsupported fixture value');}
const bar=(time,close,volume=1,extra={})=>({time,open:close,high:close,low:close,close,volume,...extra});
const initial=[bar(1000,10,1),bar(2000,20,2)];
const columns=(rows,tail={})=>Object.fromEntries(FIELDS.map(key=>[key,rows.map(row=>row[key]).concat(tail[key]??[])]));
const goodColumns=columns(initial);
const event=(kind,row)=>({kind,bar:row});
const validBatch=[event('append',bar(3000,30,3)),event('update',bar(3000,31,4)),event('correction',bar(1000,11,5))];
const cases=[
 {id:'legacy-set-data',mode:'legacy',op:'setData',initial:[],args:[[bar(1,2),bar(2,3)]]},
 {id:'api-set-data',mode:'api',op:'setData',initial:[],args:[[bar(1,2),bar(2,3)]]},
 {id:'set-data-primitive-row',mode:'legacy',op:'setData',initial,args:[[null]]},
 {id:'set-data-missing-and-envelope',mode:'legacy',op:'setData',initial,args:[[{time:1,open:3,high:1,low:2,close:3,volume:-1}]]},
 {id:'legacy-columns-tail-ignored',mode:'legacy',op:'setColumns',initial:[],args:[columns(initial,{close:[Infinity]}),2]},
 {id:'api-columns-tail-infinity',mode:'api',op:'setColumns',initial:[],args:[columns(initial,{close:[Infinity]}),2]},
 {id:'legacy-columns-null-prefix',mode:'legacy',op:'setColumns',initial:[],args:[{...goodColumns,close:[null,20]},2]},
 {id:'api-columns-null-prefix',mode:'api',op:'setColumns',initial:[],args:[{...goodColumns,close:[null,20]},2]},
 {id:'api-columns-null-tail',mode:'api',op:'setColumns',initial:[],args:[columns(initial,{close:[null]}),2]},
 {id:'legacy-columns-length-first',mode:'legacy',op:'setColumns',initial:[],args:[{},-1]},
 {id:'api-columns-values-first',mode:'api',op:'setColumns',initial:[],args:[{},-1]},
 {id:'event-append',mode:'legacy',op:'applyDataEvent',initial,args:[event('append',bar(3000,30,3))]},
 {id:'event-update',mode:'api',op:'applyDataEvent',initial,args:[event('update',bar(2000,21,4))]},
 {id:'event-update-missing-time',mode:'legacy',op:'applyDataEvent',initial,args:[event('update',{open:1})]},
 {id:'event-update-null-empty',mode:'legacy',op:'applyDataEvent',initial:[],args:[event('update',null)]},
 {id:'event-update-null-nonempty',mode:'legacy',op:'applyDataEvent',initial,args:[event('update',null)],platformError:{base:'null',property:'time',expression:'event.bar.time'}},
 {id:'event-correction-undefined-empty',mode:'api',op:'applyDataEvent',initial:[],args:[{kind:'correction'}],platformError:{base:'undefined',property:'time',expression:'event.bar.time'}},
 {id:'event-correction-missing-time',mode:'legacy',op:'applyDataEvent',initial,args:[event('correction',{open:1})]},
 {id:'prepend-null-empty',mode:'legacy',op:'applyDataEvent',initial:[],args:[{kind:'prepend',bars:[null]}]},
 {id:'prepend-null-nonempty',mode:'api',op:'applyDataEvent',initial,args:[{kind:'prepend',bars:[null]}],platformError:{base:'null',property:'time',expression:'bars[bars.length - 1].time'}},
 {id:'prepend-number-nonempty',mode:'legacy',op:'applyDataEvent',initial,args:[{kind:'prepend',bars:[1]}]},
 {id:'prepend-overlap-before-finite',mode:'legacy',op:'applyDataEvent',initial,args:[{kind:'prepend',bars:[{time:1000}]}]},
 {id:'reset-bars',mode:'api',op:'applyDataEvent',initial,args:[{kind:'reset',bars:[bar(5,6)]}]},
 {id:'reset-columns',mode:'legacy',op:'applyDataEvent',initial,args:[{kind:'reset',columns:goodColumns,length:2}]},
 {id:'unknown-event',mode:'legacy',op:'applyDataEvent',initial,args:[{kind:'nope'}]},
 {id:'legacy-batch-success',mode:'legacy',op:'applyDataEvents',initial,args:[validBatch,{}]},
 {id:'api-batch-success',mode:'api',op:'applyDataEvents',initial,args:[validBatch,{}]},
 {id:'legacy-batch-kind-before-bar',mode:'legacy',op:'applyDataEvents',initial,args:[[{kind:'nope',bar:null}],{}]},
 {id:'api-batch-kind-before-bar',mode:'api',op:'applyDataEvents',initial,args:[[{kind:'nope',bar:null}],{}]},
 {id:'legacy-options-before-events',mode:'legacy',op:'applyDataEvents',initial,args:[null,{skipUnchanged:'yes'}]},
 {id:'api-options-before-events',mode:'api',op:'applyDataEvents',initial,args:[null,{maxBars:1}]},
 {id:'legacy-budget-after-bar',mode:'legacy',op:'applyDataEvents',initial,args:[[event('append',bar(3000,30))],{maxBars:2}]},
 {id:'legacy-bad-bar-before-budget',mode:'legacy',op:'applyDataEvents',initial,args:[[event('append',{time:3000})],{maxBars:2}]},
 {id:'batch-skip-unchanged',mode:'legacy',op:'applyDataEvents',initial,args:[[event('update',bar(2000,20,2))],{skipUnchanged:true}]},
 {id:'batch-skip-changed',mode:'legacy',op:'applyDataEvents',initial,args:[[event('update',bar(2000,21,2))],{skipUnchanged:true}]},
 {id:'options-explicit-undefined',mode:'legacy',op:'applyDataEvents',initial,args:[[event('update',bar(2000,20,2))],undefined]},
];
function state(store){return{length:store.length,capacity:store.capacity,version:store.version,timeVersion:store.timeVersion,bytes:store.bytes,columns:Object.fromEntries(FIELDS.map(key=>[key,Array.from(store.columns[key])]))};}
function run(spec){const store=new BarStore(spec.initial,{maxBars:16}),changes=[];store.subscribe(change=>changes.push({...change}));let invalidations=0,result,error;const target=spec.mode==='api'?new ChartAPI(new ChartModel({store}),{invalidate:()=>invalidations++}):store;try{if(spec.mode==='api')result=target[spec.op](...spec.args);else if(spec.op==='applyDataEvent')result=applyDataEvent(store,...spec.args);else if(spec.op==='applyDataEvents')result=store.applyEvents(...spec.args);else result=store[spec.op](...spec.args);}catch(cause){error=spec.platformError?{kind:'nullish-property',...spec.platformError,v8:{name:cause.name,message:cause.message}}:{kind:'js',name:cause.name,message:cause.message,code:cause.code??null};}return{kind:'case',id:spec.id,mode:spec.mode,operation:spec.op,initial:encode(spec.initial),args:encode(spec.args),result:error?null:encode(result),error:error??null,state:encode(state(store)),changes:encode(changes),invalidations};}
export function generateDataInputOracle(){verify();return[JSON.stringify(ORACLE),...cases.map(spec=>JSON.stringify(run(spec)))].join('\n')+'\n';}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&mode!=='--check')throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-data-input.mjs [--check]');const output=generateDataInputOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('data-input.leaf.jsonl is stale');console.log(`data input oracle fresh: ${cases.length} cases`);}else process.stdout.write(output);}
