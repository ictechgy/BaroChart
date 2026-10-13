import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
import {QUICKJS_INDICATOR_REENTRY_SCENARIOS,validateQuickjsIndicatorReentryResults} from '../scripts/quickjs-cloud-result.mjs';

// Independent literal oracle, not copied at runtime from fixture/gate output.
const EXPECTED_SCENARIOS=Object.freeze([
 'native model exposes bundled indicator engine','direct get rejects source mutation and recovers',
 'callback reset invalidates and recovers','callback empty invalidates and recovers',
 'middle yield source mutation rejects before writes','final yield source mutation rejects before writes',
 'same entry recursion rejects and releases owner','independent entry calculation remains allowed',
 'superseded next preserves new generation','superseded return preserves new generation','superseded throw preserves new generation',
 'suspended remove cannot write retired buffers','suspended replacement cannot write retired buffers','suspended dispose cannot revive entries',
 'failed add preserves callback replacement','partial EMA supersede matches fresh oracle','partial EMA return matches fresh oracle','partial EMA throw matches fresh oracle',
 'native checkpoint validator mutation rejects and recovers','native checkpoint validator reset rejects and recovers','native checkpoint validator disposal rejects clean publication',
 'realm depth 31 succeeds across one and multiple engines','realm depth 32 succeeds across one and multiple engines','realm depth 33 rejects across one and multiple engines',
 'fresh remove add recursion stops at 32 and recovers',
 'all models engines checkpoints and listeners released'
]);
const EXPECTED_CHECKS=26;
function receipt(){return [{case:'indicator-reentry-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS]},
 ...['workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'].map(name=>({case:name,passed:true,peakRequestedBytes:100,finalLiveBytes:0,finalAllocationCount:0}))];}

test('standalone indicator reentry fixture runs the generated bundle in a bare Node VM',async()=>{
 const context=vm.createContext({}),modulePath=fileURLToPath(new URL('./fixtures/native-checkpoint-quickjs-module.mjs',import.meta.url));
 vm.runInContext(await buildNativeBundle({modulePaths:[modulePath]}),context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/indicator-reentry-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000}));
 assert.equal(result.case,'indicator-reentry-quickjs');assert.equal(result.passed,true);assert.equal(result.checks,EXPECTED_CHECKS);
 assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/bundled IndicatorEngine and nativeModel in standalone QuickJS\/Node VM/);assert.match(result.scope,/no Android JNI, Apple JSC or device proof/);
 const probe=context.indicatorReentryQuickjsProbe;assert.equal(probe.models.length,1);assert.equal(probe.engines.length,129);assert.equal(probe.stores.length,30);assert.equal(probe.budgets.length,12);
 assert.equal(probe.models[0],context.nativeModel);assert.equal(probe.models[0].disposed,true);
 for(const engine of probe.engines)assert.equal(engine.entries.size,0);
 for(const store of probe.stores)assert.equal(store.listeners.size,0);
 for(const budget of probe.budgets)assert.equal(budget.usedBytes,0);
 assert.equal(context.nativeCheckpointQuickjsProbe.onValidate,null);
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone'])assert.equal(context[key],undefined,key);
});
test('indicator reentry gate matches the independent fixed coverage oracle',()=>{
 assert.equal(QUICKJS_INDICATOR_REENTRY_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual([...QUICKJS_INDICATOR_REENTRY_SCENARIOS],EXPECTED_SCENARIOS);
 assert.equal(new Set(QUICKJS_INDICATOR_REENTRY_SCENARIOS).size,EXPECTED_CHECKS);
});
test('indicator reentry gate accepts complete coverage and exact allocator limits',()=>{
 const results=receipt();results[1].peakRequestedBytes=128*1024*1024;results[2].peakRequestedBytes=results[3].peakRequestedBytes=8*1024*1024;
 assert.equal(validateQuickjsIndicatorReentryResults(results),results);
});
for(const [name,mutate] of Object.entries({
 'wrong fixture case':r=>r[0].case='data-explorer-quickjs',
 'failed fixture':r=>r[0].passed=false,
 'nonboolean fixture success':r=>r[0].passed='true',
 'null fixture':r=>r[0]=null,
 'missing checks':r=>delete r[0].checks,
 'previous coverage count':r=>r[0].checks=22,
 'reduced checks':r=>r[0].checks=25,
 'extra checks':r=>r[0].checks=27,
 'string checks':r=>r[0].checks='26',
 'missing scenario':r=>r[0].scenarios.pop(),
 'extra scenario':r=>r[0].scenarios.push('unverified device result'),
 'duplicate scenario':r=>r[0].scenarios[1]=r[0].scenarios[0],
 'unknown scenario':r=>r[0].scenarios[0]='unverified native SDK',
 'sparse scenarios':r=>delete r[0].scenarios[0],
 'nonarray scenarios':r=>r[0].scenarios={},
 'missing scenarios':r=>delete r[0].scenarios,
 'missing runtime cleanup':r=>r.splice(1,1),
 'missing OOM cleanup':r=>r.splice(2,1),
 'missing interrupt cleanup':r=>r.pop(),
 'duplicate cleanup':r=>r[3]=r[2],
 'extra cleanup':r=>r.push({...r[3]}),
 'reordered cleanup':r=>[r[1],r[2]]=[r[2],r[1]],
 'null cleanup':r=>r[1]=null,
 'failed runtime cleanup':r=>r[1].passed=false,
 'failed OOM cleanup':r=>r[2].passed=false,
 'failed interrupt cleanup':r=>r[3].passed=false,
 'nonzero live bytes':r=>r[1].finalLiveBytes=1,
 'nonzero allocation count':r=>r[2].finalAllocationCount=1,
 'missing accounting':r=>delete r[3].finalLiveBytes,
 'invalid peak':r=>r[3].peakRequestedBytes=NaN,
 'zero peak':r=>r[1].peakRequestedBytes=0,
 'fractional peak':r=>r[2].peakRequestedBytes=1.5,
 'runtime peak above limit':r=>r[1].peakRequestedBytes=128*1024*1024+1,
 'OOM peak above limit':r=>r[2].peakRequestedBytes=8*1024*1024+1,
 'interrupt peak above limit':r=>r[3].peakRequestedBytes=8*1024*1024+1
}))test('indicator reentry gate rejects '+name,()=>{
 const results=receipt();mutate(results);assert.throws(()=>validateQuickjsIndicatorReentryResults(results));
});
for(const [name,value] of [['null',null],['object',{}],['empty',[]]])test('indicator reentry gate rejects '+name+' input',()=>assert.throws(()=>validateQuickjsIndicatorReentryResults(value)));
