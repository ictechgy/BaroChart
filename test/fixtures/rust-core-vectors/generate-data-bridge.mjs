// Actual native bundle sequences; one JS realm per scenario, mirrored by one WASM engine.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createJavaScriptOracle} from '../../../scripts/rust/core-conformance.mjs';
import {parseLossless,stringifyLossless} from '../../../scripts/trace/bcjson.mjs';

assert.ok(process.version.startsWith('v22.'), 'Use the pinned Node 22 oracle');
const manifest=JSON.parse(await readFile(new URL('manifest.json',import.meta.url),'utf8'));
const metadata={schema:'aster.rust-core-vectors',version:1,oracleCommit:manifest.oracleCommit,bundleSha256:manifest.bundleSha256,seed:42,dialect:'Ecma',runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,tz:process.versions.tz,platform:process.platform,arch:process.arch},scope:'data/store and ingestion envelopes; complete chart/view state is a later gate'};
const bar=(time,close=1)=>({time,open:close,high:close+1,low:close-1,close,volume:1});
const event=(kind,time,close=1)=>({kind,bar:bar(time,close)});
const call=(name,args)=>({name,arguments:stringifyLossless(args)});
const command=(operation,...args)=>call('nativeCommand',[operation,args]);
const ingest=(operation,...args)=>call('nativeDataIngestionCommand',[operation,args]);
const definitions=[
 {suite:'data-store',name:'legacy-and-facade-mutations-errors-and-continued-state',calls:[
   call('nativeSetData',[null]),call('nativeDataEvent',[null]),call('nativeCommand',[]),
   call('nativeInit',[0,{}]),call('nativeSetData',[[bar(1000),bar(2000,2)]]),
   call('nativeDataEvent',[event('update',2000,3)]),call('nativeDataEvent',[event('correction',1000,2)]),
   call('nativeDataEvent',[event('append',1500)]),call('nativeDataEvent',[event('append',3000)]),
   call('nativeDataEvent',[{kind:'update',bar:null}]),call('nativeDataEvent',[{kind:'prepend',bars:[null]}]),
   command('setColumns',{time:[4000],open:[1],high:[2],low:[0],close:[1],volume:[1]}),
   command('applyDataEvent',event('update',4000,2)),command('applyDataEvents',[event('append',5000),event('update',5000,3)]),
   call('nativeApplyUnchangedDataEvents',[[event('update',5000,3)]]),
   call('nativeApplyUnchangedDataEvents',[[event('update',5000,4)]]),
   command('applyDataEvent',{kind:'batch',events:[event('append',6000)]}),
   command('applyDataEvents',[]),command('setData',null),command('setData',[]),
   call('nativeDataEvent',[event('update',6000)]),call('nativeDataEvent',[event('append',7000)]),
   call('nativeCommand',['setData',null]),call('nativeCommand',['setData',[[bar(1)],123]]),
   call('nativeCommand',['doesNotExist',[]]),command('applyDataEvent',{kind:'prepend',bars:[{time:'9000'}]}),
   command('applyDataEvent',{kind:'correction',bar:{time:{toString:0}}}),call('nativeEcho',[-0]),
 ]},
 {suite:'ingestion',name:'all-nine-commands-defaults-save-load-close-and-generic-routing',calls:[
   ingest('notAnOperation'),ingest('dataIngestionStats'),call('nativeInit',[0,{}]),
   ingest('dataIngestionStats'),ingest('configureDataIngestion',{streamId:'s',generation:1,firstSequence:-0,maxQueuedEvents:4,maxQueuedBytes:196,maxBatchEvents:2}),
   ingest('enqueueDataEvents',{streamId:'s',generation:1,firstSequence:-0,events:[event('append',1000),event('append',2000)]}),
   ingest('pauseDataIngestion'),ingest('drainDataEvents'),ingest('resumeDataIngestion'),ingest('drainDataEvents',undefined),
   ingest('dataIngestionStats'),ingest('saveDataIngestion'),
   command('enqueueDataEvents',{streamId:'s',generation:1,firstSequence:2,events:[event('append',3000)]}),
   command('pauseDataIngestion'),command('resumeDataIngestion'),command('cancelDataEvents'),command('dataIngestionStats'),
   ingest('loadDataIngestion','{}'),ingest('dataIngestionStats'),
   call('nativeDataIngestionCommand',['dataIngestionStats',[1]]),call('nativeDataIngestionCommand',['saveDataIngestion',null]),
   call('nativeReleaseDataIngestion',[]),ingest('dataIngestionStats'),ingest('resumeDataIngestion'),command('dataIngestionStats'),
 ]},
];
const scenarios=[];
for(const definition of definitions){
 const oracle=await createJavaScriptOracle();
 const calls=definition.calls.map(spec=>({...spec,expected:stringifyLossless(oracle.call(spec.name,parseLossless(spec.arguments)))}));
 scenarios.push({metadata,suite:definition.suite,name:definition.name,calls});
}
const output=scenarios.map(value=>JSON.stringify(value)).join('\n')+'\n';
const path=new URL('data-bridge.jsonl',import.meta.url);
if(process.argv.includes('--check')) assert.equal(await readFile(path,'utf8'),output);else await writeFile(path,output);
process.stdout.write(`Native data bridge oracle: ${scenarios.reduce((n,s)=>n+s.calls.length,0)} calls\n`);
