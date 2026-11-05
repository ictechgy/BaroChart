#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';

if(process.versions.node.split('.')[0]!=='22')throw new Error('Native chart oracle requires Node22');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-chart.leaf.jsonl');
const sources=['examples/native/bridge.mjs','src/core/api.mjs','src/core/model.mjs','src/core/indicators.mjs','src/core/drawings.mjs','src/core/ingestion.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const f64Buffer=new ArrayBuffer(8),f64View=new DataView(f64Buffer);
function f64(value){f64View.setFloat64(0,value,false);return f64View.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:f64(value)};
 if(value===undefined)return{$undefined:true};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));
 if(typeof value==='object'){
  if(seen.has(value))throw new TypeError('cyclic fixture value');seen.add(value);
  const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;
 }
 throw new TypeError('unsupported fixture value');
}
const cases=[
 {id:'legacy-null',source:`nativeInit(5,null);({inspect:nativeCommand('inspect'),indicator:nativeCommand('indicatorValues',['ema','value']),themeFont:nativeThemeFont()})`},
 {id:'legacy-undefined-default',source:`nativeInit(5,undefined);nativeCommand('inspect')`},
 {id:'typed-empty-object',source:`nativeInit(0,{});nativeCommand('inspect')`},
 {id:'typed-theme-series',source:`nativeInit(3,{theme:{background:'red'},series:[{id:'typed',type:'line',panel:'price',source:'close',color:'blue'}]});nativeCommand('inspect')`},
 {id:'legacy-scene',source:`nativeInit(5,null);JSON.parse(nativeSceneJSON(400,300))`},
 {id:'falsey-theme',source:`nativeInit(0,{theme:false,series:[]});nativeCommand('inspect')`},
 {id:'candidate-failure-atomic',source:`nativeInit(4,null);const before=nativeCommand('inspect'),owner=nativeModel;let error;try{nativeInit(2,{series:[{id:'bad',type:'line',panel:'missing'}]});}catch(cause){error={name:cause.name,message:cause.message,code:cause.code??null};}({error,sameOwner:nativeModel===owner,before,after:nativeCommand('inspect')})`},
 {id:'data-indicator-model-publication',source:`nativeInit(3,{series:[]});nativeCommand('addIndicator',['mean','ema',{period:2}]);nativeCommand('addSeries',[{id:'mean',type:'line',panel:'price',indicator:'mean'}]);nativeCommand('setData',[[{time:10,open:1,high:1,low:1,close:1,volume:1}]]);({inspect:nativeCommand('inspect'),values:nativeCommand('indicatorValues',['mean','value'])})`},
 {id:'ingestion-drain-publication',source:`nativeInit(1,{series:[]});nativeCommand('configureDataIngestion',[{streamId:'feed',generation:1,firstSequence:0,maxQueuedEvents:8,maxQueuedBytes:392,maxBatchEvents:8}]);nativeCommand('enqueueDataEvents',[{streamId:'feed',generation:1,firstSequence:0,events:[{kind:'append',bar:{time:1700000060000,open:2,high:2,low:2,close:2,volume:2}}]}]);({drain:nativeCommand('drainDataEvents',[1]),stats:nativeCommand('dataIngestionStats'),inspect:nativeCommand('inspect')})`},
 {id:'dispatch-arity-before-method',source:`nativeInit(0,{});let error;try{nativeCommand('inspect',[1]);}catch(cause){error={name:cause.name,message:cause.message,code:cause.code??null};}({error,inspect:nativeCommand('inspect')})`},
 {id:'set-series-nullish-binding',source:`nativeInit(4,{series:[]});nativeCommand('addIndicator',['mean','ema',{period:2}]);nativeCommand('addSeries',[{id:'mean',type:'line',panel:'price',indicator:'mean',output:'value'}]);nativeCommand('setSeries',['mean',{output:null,indicator:null,source:'close'}]);nativeCommand('inspect')`},
 {id:'canonical-documents',source:`nativeInit(4,{series:[]});nativeCommand('addIndicator',['mean','ema',{period:2}]);nativeCommand('addSeries',[{id:'mean',type:'line',panel:'price',indicator:'mean',color:'red'}]);nativeCommand('addDrawing',[{id:'d',type:'horizontal',panel:'price',points:[{time:1700000000000,price:-0}],style:{color:'blue',width:2}}]);({studies:nativeCommand('saveStudies'),drawings:nativeCommand('saveDrawings'),inspect:nativeCommand('inspect')})`},
];

async function runCase(bundle,spec){
 const context=vm.createContext({});vm.runInContext(bundle,context);
 try{return{kind:'case',id:spec.id,result:encode(vm.runInContext(spec.source,context,{timeout:10000}))};}
 catch(cause){return{kind:'case',id:spec.id,thrown:{name:cause.name,message:cause.message,code:cause.code??null}};}
 finally{try{vm.runInContext('nativeModel?.dispose()',context);}catch{}}
}

export async function generateNativeChartOracle(){
 const bundle=await buildNativeBundle();
 const header={kind:'header',schema:'barochart.rust-core.native-chart-leaf',version:1,
  oracleCommit:'8457612bda98c764bc1a9e7e794dafcf9316a47e',
  bundleSHA256:sha(bundle),sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),
  node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,
  seed:42,dialect:'ECMA-262/V8',encoding:'f64 bits; objects ordered entries',
  callSequence:['fresh node:vm','evaluate actual native bundle','nativeInit','nativeCommand/native ingestion','capture result/error/state']};
 const rows=[header];for(const spec of cases)rows.push(await runCase(bundle,spec));
 return rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-chart.mjs [--check|--write]');
 const output=await generateNativeChartOracle();
 if(mode==='--check'){
  if(readFileSync(fixture,'utf8')!==output)throw new Error('native-chart.leaf.jsonl is stale');
  console.log(`native chart oracle fresh: ${cases.length} cases`);
 }else if(mode==='--write'){
  writeFileSync(fixture,output);console.log(`native chart oracle wrote: ${cases.length} cases`);
 }else process.stdout.write(output);
}
