import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

// Independent literal oracle: a shortened fixture cannot redefine coverage.
const EXPECTED_SCENARIOS=Object.freeze([
 'native command removes dirty throwing custom without calculation',
 'controller callback and method getter replacements survive stale removal',
 'remove method getter preserves replacement before deletion',
 'shared store stays live and held output survives owner disposal',
 'native checkpoint removal releases only target ledger without calculation',
 'all models entries checkpoint bytes and source listeners are released'
]);
const EXPECTED_CHECKS=6;
function validateResult(result){
 assert.equal(result.case,'remove-indicator-quickjs');assert.equal(result.passed,true);assert.equal(result.checks,EXPECTED_CHECKS);
 assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/bundled ChartAPI\.removeIndicator and nativeCommand in standalone QuickJS\/Node VM/);
 assert.match(result.scope,/no Android JNI, Apple JSC or device proof/);return result;
}
test('standalone remove indicator fixture runs the generated bundle in a bare Node VM',async()=>{
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 validateResult(JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/remove-indicator-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000})));
 const probe=context.removeIndicatorQuickjsProbe;
 assert.equal(probe.models.length,10);assert.equal(new Set(probe.models).size,10);assert.equal(probe.stores.length,8);assert.equal(probe.budgets.length,1);
 assert.equal(probe.callbacks.length,7);assert.equal(probe.held.length,3);assert.equal(probe.models[0],context.nativeModel);
 assert.deepEqual(Array.from(probe.reentries),['cancel callback','target callback','cancel getter','target getter']);
 for(const calls of probe.callbacks)for(const key of ['create','step','snapshot','restore'])assert.equal(calls[key],0,key);
 for(const model of probe.models){assert.equal(model.disposed,true);assert.equal(model.indicators.entries.size,0);}
 for(const store of probe.stores)assert.equal(store.listeners.size,0);
 for(const budget of probe.budgets)assert.equal(budget.usedBytes,0);
 for(const held of probe.held)assert.deepEqual(Array.from(held.array),Array.from(held.copy));
 assert.ok(probe.ledger.before>probe.ledger.remaining&&probe.ledger.remaining>0);assert.equal(probe.ledger.after,0);assert.equal(probe.ledger.calls,0);
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone'])assert.equal(context[key],undefined,key);
});
for(const [name,mutate] of Object.entries({
 'reduced coverage':r=>{r.checks=5;r.scenarios.pop();},
 'extra coverage':r=>{r.checks=7;r.scenarios.push('unverified SDK');},
 'missing scenario':r=>r.scenarios.pop(),
 'duplicate scenario':r=>r.scenarios[1]=r.scenarios[0],
 'unknown scenario':r=>r.scenarios[0]='unverified native SDK',
 'reordered scenarios':r=>r.scenarios.reverse(),
 'nonboolean success':r=>r.passed='true',
 'wrong fixture':r=>r.case='indicator-reentry-quickjs'
}))test('remove indicator coverage oracle rejects '+name,()=>{
 const result={case:'remove-indicator-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS],scope:'bundled ChartAPI.removeIndicator and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC or device proof'};
 validateResult(result);mutate(result);assert.throws(()=>validateResult(result));
});
