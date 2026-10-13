import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
import {QUICKJS_DATA_EXPLORER_SCENARIOS,validateQuickjsDataExplorerResults} from '../scripts/quickjs-cloud-result.mjs';

// Independent literal oracle: do not obtain expected labels/counts from the
// executed fixture or the result validator under test.
const EXPECTED_SCENARIOS=Object.freeze([
 'index selection defaults to last stored row','exact stored timestamp selection','exact missing session timestamp returns null',
 'at-or-before crosses missing session gap','selection before history returns null','selection after history finds last row',
 'index beyond history returns null','selection after explicit cutoff returns null','primary OHLCV preserves stored time and symbol',
 'hidden rows omitted by default','hidden rows explicitly included','series labels axes panels and symbols remain distinct',
 'row causality distinguishes host alignment from canonical provenance',
 'positive plot offset uses earlier source','negative plot offset permits current hindsight','negative plot offset respects historical cutoff',
 'plot offset outside source remains missing','SMA current values match independent arithmetic','canonical SMA historical values match independent arithmetic',
 'SMA warmup retains source position','external NaN gap retains source position','raw Float64 values avoid display rounding',
 'raw signed zero survives native command','queries preserve source buffers versions and listeners','queries preserve model viewport hover and input',
 'queries preserve drawing transaction and history','queries preserve pending ingestion and pause state','queries never invoke core invalidate callback',
 'returned snapshots own their records and arrays','external infinity is reported as an explicit gap','historical cutoff uses currently corrected source',
 'query accessor rejected without invocation','option accessor rejected without invocation','optional prototype getters are never invoked',
 'inherited selection record rejected','invalid selections reject as a bounded group','invalid options reject as a bounded group',
 'native command rejects excess arguments','accessor API owner rejected without invocation','invalid reads preserve getter and notification counters',
 'custom historical cutoff is unsupported','custom historical query skips lazy calculation','custom latest cutoff remains available',
 'custom latest cutoff executes one lazy calculation','linked causal declaration is not historical certification','linked historical query skips lazy calculation',
 'linked latest cutoff remains available','registry name cannot forge canonical definition origin','forged historical query skips lazy calculation',
 'altered canonical create loses historical certification','altered canonical outputs lose historical certification','altered canonical offsets lose historical certification',
 'replaced canonical registry loses historical certification','source callback reentry rejects a mixed snapshot','query recovers after source callback reentry',
 'disposing one model preserves shared source owner','shared source owner observes supported updates','disposed ingestion releases pending ownership',
 'disposed data query rejected','exact 256 series result limit','series limit rejects overflow without truncation',
 'empty source returns null','all models release listeners and preserve source buffers'
]);
const EXPECTED_CHECKS=63;
function receipt(){return [{case:'data-explorer-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS]},
 ...['workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'].map(name=>({case:name,passed:true,peakRequestedBytes:100,finalLiveBytes:0,finalAllocationCount:0}))];}

test('standalone explorer fixture runs the generated native command bridge in a bare Node VM',async()=>{
 const context=vm.createContext({});
 const modulePath=fileURLToPath(new URL('./fixtures/native-checkpoint-quickjs-module.mjs',import.meta.url));
 vm.runInContext(await buildNativeBundle({modulePaths:[modulePath]}),context,{timeout:5000});
 // Instrument, rather than replace, the real generated dispatch entry point.
 vm.runInContext(`globalThis.explorerNativeCalls=0;globalThis.nativeCommand=(function(original){return function(operation,args){if(operation==='dataAt')globalThis.explorerNativeCalls++;return original(operation,args);};})(globalThis.nativeCommand);`,context);
 const result=JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/data-explorer-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000}));
 assert.equal(result.case,'data-explorer-quickjs');assert.equal(result.passed,true);assert.equal(result.checks,EXPECTED_CHECKS);
 assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/nativeCommand dataAt in standalone QuickJS\/Node VM/);assert.match(result.scope,/no Android JNI, Apple JSC or device proof/);
 const probe=context.dataExplorerQuickjsProbe;
 assert.equal(context.explorerNativeCalls,85);assert.equal(probe.queryCalls,84);assert.equal(probe.accessorReads,0);
 assert.equal(probe.models.length,4);assert.equal(probe.stores.length,3);assert.equal(probe.sessions.length,1);
 // A source-reentrant failed query resets its still-owned calculation; the next
 // successful read recomputes all 12 custom rows. The common engine now stops
 // the failed calculation after its first reentrant step (49 total, not 60).
 assert.equal(probe.customCreates,5);assert.equal(probe.customSteps,49);assert.equal(probe.linkedCreates,2);assert.equal(probe.forgedCreates,2);
 assert.equal(probe.sourceStore.length,12);assert.equal(probe.sourceStore.at(0).close,10.5);assert.equal(probe.sourceStore.at(1).close,12.75);
 const held=JSON.parse(JSON.stringify(probe.heldSnapshot));
 assert.deepEqual(held.primary,{symbol:{id:'PRIMARY',currency:'USD',volumeUnit:'shares'},bar:{time:1700000360123,open:13.75,high:15,low:13,close:14,volume:128}});
 assert.equal(held.index,4);assert.equal(held.time,1700000360123);assert.equal(held.asOfIndex,11);
 assert.deepEqual(held.series.map(s=>s.causality),['stored-source','canonical-builtin','canonical-builtin','canonical-builtin','host-aligned']);
 assert.deepEqual(held.series.map(s=>[s.id,s.value,s.sourceIndex,s.status]),[
  ['close',14,4,'value'],['sma',40/3,4,'value'],['lag',11,2,'value'],['lead',43/3,6,'value'],['external',400,4,'value']
 ]);
 for(const model of probe.models){assert.equal(model.disposed,true);assert.equal(model.dataIngestion,null);assert.equal(model.indicators.entries.size,0);}
 for(const store of probe.stores)assert.equal(store.listeners.size,0,'each store releases its model and indicator subscriptions');
 for(const key of ['time','open','high','low','close','volume'])assert.ok(probe.sourceStore.columns[key].buffer.byteLength>0,'shared source buffers remain attached after model cleanup');
 const session=probe.sessions[0];assert.equal(session.closed,true);assert.equal(session.leased,false);assert.equal(session.model,null);assert.equal(session.store,null);assert.equal(session.count,0);assert.equal(session.kinds,null);assert.equal(Object.keys(session.columns).length,0);
 // Node/web helpers and native SDK shims are not supplied to make this pass.
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone'])assert.equal(context[key],undefined,key);
});

test('explorer result gate matches the independent fixed scenario oracle',()=>{
 assert.equal(QUICKJS_DATA_EXPLORER_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual([...QUICKJS_DATA_EXPLORER_SCENARIOS],EXPECTED_SCENARIOS);
 assert.equal(new Set(QUICKJS_DATA_EXPLORER_SCENARIOS).size,EXPECTED_CHECKS);
});
test('explorer result gate accepts complete deterministic coverage and cleanup',()=>{
 const results=receipt();assert.equal(validateQuickjsDataExplorerResults(results),results);
});
test('explorer result gate accepts exact allocator limits',()=>{
 const results=receipt();results[1].peakRequestedBytes=128*1024*1024;results[2].peakRequestedBytes=results[3].peakRequestedBytes=8*1024*1024;
 assert.equal(validateQuickjsDataExplorerResults(results),results);
});
for(const [name,mutate] of Object.entries({
 'wrong fixture case':r=>r[0].case='native-workspace-source-quickjs',
 'failed fixture':r=>r[0].passed=false,
 'nonboolean fixture success':r=>r[0].passed='true',
 'null fixture':r=>r[0]=null,
 'missing checks':r=>delete r[0].checks,
 'reduced checks':r=>r[0].checks=62,
 'extra checks':r=>r[0].checks=64,
 'string checks':r=>r[0].checks='63',
 'missing scenario':r=>r[0].scenarios.pop(),
 'extra scenario':r=>r[0].scenarios.push('unverified native SDK'),
 'duplicate scenario':r=>r[0].scenarios[1]=r[0].scenarios[0],
 'unknown scenario':r=>r[0].scenarios[0]='unverified device result',
 'sparse scenarios':r=>delete r[0].scenarios[0],
 'nonarray scenarios':r=>r[0].scenarios={},
 'missing scenarios':r=>delete r[0].scenarios,
 'missing runtime cleanup':r=>r.splice(1,1),
 'missing OOM cleanup':r=>r.splice(2,1),
 'missing interrupt cleanup':r=>r.pop(),
 'duplicate cleanup':r=>r[3]=r[2],
 'extra cleanup case':r=>r.push({...r[3]}),
 'reordered cleanup':r=>[r[1],r[2]]=[r[2],r[1]],
 'null cleanup':r=>r[1]=null,
 'failed runtime cleanup':r=>r[1].passed=false,
 'failed OOM cleanup':r=>r[2].passed=false,
 'failed interrupt cleanup':r=>r[3].passed=false,
 'nonboolean cleanup success':r=>r[2].passed=1,
 'nonzero live bytes':r=>r[1].finalLiveBytes=1,
 'nonzero allocation count':r=>r[2].finalAllocationCount=1,
 'missing cleanup accounting':r=>delete r[3].finalLiveBytes,
 'string live bytes':r=>r[1].finalLiveBytes='0',
 'string allocation count':r=>r[3].finalAllocationCount='0',
 'invalid peak':r=>r[3].peakRequestedBytes=NaN,
 'zero peak':r=>r[1].peakRequestedBytes=0,
 'negative peak':r=>r[1].peakRequestedBytes=-1,
 'fractional peak':r=>r[2].peakRequestedBytes=1.5,
 'string peak':r=>r[3].peakRequestedBytes='100',
 'runtime peak above limit':r=>r[1].peakRequestedBytes=128*1024*1024+1,
 'OOM peak above limit':r=>r[2].peakRequestedBytes=8*1024*1024+1,
 'interrupt peak above limit':r=>r[3].peakRequestedBytes=8*1024*1024+1
}))test('explorer result gate rejects '+name,()=>{
 const results=receipt();mutate(results);assert.throws(()=>validateQuickjsDataExplorerResults(results));
});
for(const [name,value] of [['null',null],['object',{}],['empty',[]]])test('explorer result gate rejects '+name+' input',()=>assert.throws(()=>validateQuickjsDataExplorerResults(value)));
