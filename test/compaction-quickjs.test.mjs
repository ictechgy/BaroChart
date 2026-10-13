import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

// Independent literal oracle: a shortened fixture cannot redefine coverage.
const EXPECTED_SCENARIOS=Object.freeze([
 'native command retains exact six-column suffix and publishes one committed event',
 'dirty visible hidden and unbound custom studies retire without callbacks or held-output writes',
 'native checkpoint maps release ledger bytes and remain reusable for fresh suffix studies',
 'shared model and standalone engine ownership reject atomically until disposed',
 'no-op permits shared owners and implicit percent without source cache or view changes',
 'paused empty ingestion preserves policy cursor counters and resumes against compacted source',
 'follow and manual views preserve drawing anchors selection and undo redo documents',
 'validation and exact peak-budget rejection preserve source caches and notifications',
 'reentrant observer sees retired caches and outer receipt retains its own commit',
 'postcommit invalidation failure returns a successful diagnostic receipt',
 'all models engines subscriptions ingestion rings and checkpoint ledgers are released'
]);
const EXPECTED_CHECKS=11;
const EXPECTED_SCOPE='bundled ChartAPI.compactData and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC, native SDK, browser or device proof';
function validateResult(result){
 assert.equal(result.case,'compaction-quickjs');assert.equal(result.passed,true);assert.equal(result.checks,EXPECTED_CHECKS);
 assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.equal(result.scope,EXPECTED_SCOPE);return result;
}
test('standalone compaction fixture runs the generated bundle in a bare Node VM',async()=>{
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 validateResult(JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/compaction-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000})));
 const probe=context.compactionQuickjsProbe;
 assert.equal(probe.models.length,14);assert.equal(new Set(probe.models).size,14);assert.equal(probe.stores.length,14);assert.equal(new Set(probe.stores).size,12);
 assert.equal(probe.models[0],context.nativeModel);assert.equal(probe.engines.length,1);assert.equal(probe.budgets.length,2);assert.equal(probe.held.length,11);assert.equal(probe.subscriptions.length,7);assert.equal(probe.sessions.length,1);
 assert.deepEqual(Array.from(probe.native.fields),['time','open','high','low','close','volume']);assert.equal(probe.native.negativeZero,true);assert.equal(probe.native.sameStore,true);assert.equal(probe.native.events,1);assert.equal(probe.native.invalidations,1);
 assert.deepEqual({...probe.native.receipt},{removed:45,length:20,capacity:32,bytes:3072,previousBytes:12288,peakSourceBytes:15360,firstRetainedTime:-0,version:4,timeVersion:4,studyHistory:'restart',invalidationFailed:false});
 assert.deepEqual({...probe.custom.afterCompaction},{factory:0,get:0,create:0,step:0,snapshot:0,restore:0,validate:0});
 assert.deepEqual({...probe.custom.calls},{factory:0,get:1,create:1,step:0,snapshot:0,restore:0,validate:0});
 assert.equal(probe.custom.studies,3);assert.equal(probe.custom.boundSeries,2);assert.equal(probe.custom.checkpointBytesAfterCompact,0);assert.equal(probe.custom.explicitErrorPreserved,true);
 assert.ok(probe.ledger.before>0);assert.equal(probe.ledger.afterCompact,0);assert.ok(probe.ledger.afterReuse>0);assert.equal(probe.ledger.mapCount,2);assert.deepEqual(Array.from(probe.ledger.recordCounts),[5,5]);assert.equal(probe.ledger.afterDispose,0);
 assert.deepEqual({...probe.owners},{rejections:2,removed:48,events:1,notifications:1});
 assert.deepEqual({...probe.noop},{checks:2,events:0,invalidations:0,sourceUnchanged:true,cacheUnchanged:true,crosshairRetained:true});
 assert.deepEqual({...probe.ingestion},{rejections:2,events:1,epochAdvance:1,savedUnchanged:true,policyUnchanged:true,nextSequence:12,accepted:2,applied:2,cancelled:0,pendingEvents:0,length:18});
 assert.deepEqual(Array.from(probe.views,row=>({...row,clamped:row.clamped?{...row.clamped}:null})),[
  {follow:true,from:19.5,to:34.5,clamped:null,historyPreserved:true,selection:'anchor',evictedAnchorPreserved:true},
  {follow:false,from:10,to:25,clamped:{from:-.5,to:14.5},historyPreserved:true,selection:'anchor',evictedAnchorPreserved:true}
 ]);
 assert.deepEqual({...probe.atomic},{rejections:4,reads:0,events:1,peakSourceBytes:15360});
 assert.deepEqual({...probe.reentry,versionDeltas:Array.from(probe.reentry.versionDeltas)},{events:2,invalidations:2,outerLength:17,outerRemoved:48,innerLength:8,innerRemoved:10,versionDeltas:[1,3],finalLength:8,listenerErrors:0});
 assert.deepEqual({...probe.invalidation},{events:1,invalidations:1,invalidationFailed:true,length:17});
 for(const model of probe.models){assert.equal(model.disposed,true);assert.equal(model.indicators.entries.size,0);assert.equal(model.dataIngestion,null);for(const series of model.series)assert.equal(series.rangeIndex,null);}
 for(const engine of probe.engines)assert.equal(engine.entries.size,0);
 for(const store of probe.stores){assert.equal(store.listeners.size,0);assert.equal(store.listenerErrors.length,0);}
 for(const row of probe.subscriptions)assert.equal(row.active,false);
 for(const session of probe.sessions){assert.equal(session.closed,true);assert.equal(session.count,0);assert.equal(session.kinds,null);assert.equal(Object.keys(session.columns).length,0);assert.equal(session.model,null);assert.equal(session.store,null);}
 for(const budget of probe.budgets)assert.equal(budget.usedBytes,0);
 for(const held of probe.held)assert.deepEqual(Array.from(held.array),Array.from(held.copy));
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone','window','document'])assert.equal(context[key],undefined,key);
});
for(const [name,mutate] of Object.entries({
 'reduced coverage':result=>{result.checks=10;result.scenarios.pop();},
 'extra coverage':result=>{result.checks=12;result.scenarios.push('unverified SDK');},
 'wrong count':result=>result.checks=10,
 'string count':result=>result.checks='11',
 'missing scenario':result=>result.scenarios.pop(),
 'duplicate scenario':result=>result.scenarios[1]=result.scenarios[0],
 'unknown scenario':result=>result.scenarios[0]='unverified native SDK',
 'reordered scenarios':result=>result.scenarios.reverse(),
 'nonboolean success':result=>result.passed='true',
 'false success':result=>result.passed=false,
 'wrong fixture':result=>result.case='set-series-presentation-quickjs',
 'wrong execution scope':result=>result.scope='bundled ChartAPI.compactData in a browser',
 'missing platform limit':result=>result.scope='bundled ChartAPI.compactData and nativeCommand in standalone QuickJS/Node VM'
}))test('compaction coverage oracle rejects '+name,()=>{
 const result={case:'compaction-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS],scope:EXPECTED_SCOPE};
 validateResult(result);mutate(result);assert.throws(()=>validateResult(result));
});
