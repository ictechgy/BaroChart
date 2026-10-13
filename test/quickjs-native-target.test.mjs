import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
import {QUICKJS_NATIVE_TARGET_SCENARIOS,validateQuickjsNativeTargetResults} from '../scripts/quickjs-cloud-result.mjs';

// Deliberately independent of both the executable fixture and the runner gate.
const EXPECTED_SCENARIOS=Object.freeze([
 'isolated target admission','bounded logical admission','copied source buffers','bounded target progress',
 'canonical restored configuration','saved chart configuration','fractional offscreen view','fractional bound drawing anchors',
 'transient UI reset','restored source metadata','owned source columns','source remains unchanged','finish drops wrapper references',
 'single finish ownership','wrapper dispose preserves returned model',
 'initial ema/value','initial rsi/value','initial bollinger/middle','initial bollinger/upper','initial bollinger/lower','initial bounded checkpoints',
 'source changes stay independent',
 'update ema/value','update rsi/value','update bollinger/middle','update bollinger/upper','update bollinger/lower','update bounded checkpoints',
 'append ema/value','append rsi/value','append bollinger/middle','append bollinger/upper','append bollinger/lower','append bounded checkpoints',
 'correction ema/value','correction rsi/value','correction bollinger/middle','correction bollinger/upper','correction bollinger/lower','correction bounded checkpoints',
 'target changes stay independent','indicator retirement preserves held outputs','retired checkpoint access rejected','returned model cleanup',
 'malformed target metadata','target binding mismatch','target output schema mismatch','combined admission limit','partial transfer rejected',
 'partial transfer cleanup','malformed copied column rejected','malformed copied column cleanup','partial calculation owns checkpoints',
 'partial calculation cleanup','cancelled checkpoint access rejected','ready mutation rejected','ready mutation cleanup',
 'empty target configuration','empty bounded checkpoints','empty target ownership','empty target cleanup',
 'failed targets preserve source','all source and target listeners released'
]);
const EXPECTED_CHECKS=63;
function receipt(){return [{case:'native-workspace-target-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS]},
 ...['workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'].map(name=>({case:name,passed:true,peakRequestedBytes:100,finalLiveBytes:0,finalAllocationCount:0}))];}

test('standalone native target fixture evaluates the real built bundle in a bare Node VM',async()=>{
 const context=vm.createContext({});
 vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/native-workspace-target-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000}));
 assert.equal(result.case,'native-workspace-target-quickjs');assert.equal(result.passed,true);
 assert.equal(result.checks,EXPECTED_CHECKS);assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);
 assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/isolated target/);assert.match(result.scope,/no source capture, host runtime swap, SDK restore/);
 const probe=context.nativeWorkspaceTargetQuickjsProbe;
 assert.equal(probe.models.length,6);assert.equal(probe.stores.length,11);assert.equal(probe.targets.length,6);
 assert.notEqual(probe.sourceModel,probe.targetModel);assert.notEqual(probe.sourceStore,probe.targetStore);
 assert.equal(probe.sourceStore.length,513);assert.equal(probe.targetStore.length,514);
 assert.equal(probe.sourceModel.theme.background,'#223344ff');assert.equal(probe.targetModel.theme.background,'#112233');
 for(const model of probe.models)assert.equal(model.disposed,true,'every source and prepared model is disposed');
 for(const store of probe.stores)assert.equal(store.listeners.size,0,'every source, target and oracle store releases its listeners');
 for(const target of probe.targets){
  assert.equal(target.closed,true);assert.equal(target.checkpointBudget.usedBytes,0);
  assert.equal(target.model,null);assert.equal(target.store,null);assert.equal(Object.keys(target.columns).length,0);
  assert.equal(target.workspaceEntries.length,0);assert.equal(target.workspaceColumnRefs.length,0);
 }
 for(const key of ['time','open','high','low','close','volume'])assert.notEqual(probe.sourceStore.columns[key].buffer,probe.targetStore.columns[key].buffer);
 // The direct target fixture must not initialize or replace any live bridge runtime.
 assert.equal(context.nativeModel,undefined);assert.equal(context.nativeAPI,undefined);assert.equal(context.nativeInput,undefined);
});

test('native target runner coverage matches the independent fixed scenario oracle',()=>{
 assert.equal(QUICKJS_NATIVE_TARGET_SCENARIOS.length,EXPECTED_CHECKS);
 assert.deepEqual([...QUICKJS_NATIVE_TARGET_SCENARIOS].sort(),[...EXPECTED_SCENARIOS].sort());
 assert.equal(new Set(QUICKJS_NATIVE_TARGET_SCENARIOS).size,EXPECTED_CHECKS);
});
test('native target result gate accepts complete deterministic coverage and cleanup',()=>{
 const results=receipt();assert.equal(validateQuickjsNativeTargetResults(results),results);
});
for(const [name,mutate] of Object.entries({
 'wrong fixture case':r=>r[0].case='workspace-quickjs',
 'failed fixture':r=>r[0].passed=false,
 'nonboolean success':r=>r[0].passed='true',
 'reduced checks':r=>r[0].checks=62,
 'extra checks':r=>r[0].checks=64,
 'string checks':r=>r[0].checks='63',
 'missing scenario':r=>r[0].scenarios.pop(),
 'extra scenario':r=>r[0].scenarios.push('unverified host restore'),
 'duplicate scenario':r=>r[0].scenarios[1]=r[0].scenarios[0],
 'unknown scenario':r=>r[0].scenarios[0]='SDK restore complete',
 'nonarray scenarios':r=>r[0].scenarios={},
 'missing runtime cleanup':r=>r.splice(1,1),
 'missing OOM cleanup':r=>r.splice(2,1),
 'missing interrupt cleanup':r=>r.pop(),
 'duplicate cleanup':r=>r[3]=r[2],
 'extra cleanup case':r=>r.push({...r[3]}),
 'reordered cleanup':r=>[r[1],r[2]]=[r[2],r[1]],
 'failed runtime cleanup':r=>r[1].passed=false,
 'failed OOM cleanup':r=>r[2].passed=false,
 'failed interrupt cleanup':r=>r[3].passed=false,
 'nonzero live bytes':r=>r[1].finalLiveBytes=1,
 'nonzero allocation count':r=>r[2].finalAllocationCount=1,
 'missing cleanup accounting':r=>delete r[3].finalLiveBytes,
 'invalid peak':r=>r[3].peakRequestedBytes=NaN,
 'zero peak':r=>r[1].peakRequestedBytes=0,
 'fractional peak':r=>r[2].peakRequestedBytes=1.5,
 'string peak':r=>r[3].peakRequestedBytes='100',
 'runtime peak above limit':r=>r[1].peakRequestedBytes=128*1024*1024+1,
 'OOM peak above limit':r=>r[2].peakRequestedBytes=8*1024*1024+1,
 'interrupt peak above limit':r=>r[3].peakRequestedBytes=8*1024*1024+1
}))test('native target result gate rejects '+name,()=>{
 const results=receipt();mutate(results);assert.throws(()=>validateQuickjsNativeTargetResults(results));
});
for(const [name,value] of [['null',null],['object',{}],['empty',[]]])test('native target result gate rejects '+name+' result input',()=>assert.throws(()=>validateQuickjsNativeTargetResults(value)));
