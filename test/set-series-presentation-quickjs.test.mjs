import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

// Independent literal oracle: a shortened fixture cannot redefine coverage.
const EXPECTED_SCENARIOS=Object.freeze([
 'native command applies all presentation keys without get or calculation',
 'entry replacement and original getter errors preserve uncommitted state',
 'nonpresentation and mixed patches retain explicit calculation failures',
 'native checkpoint ledgers held output and range index survive presentation',
 'hidden failing study renders lazily and displayed explicit read retains error',
 'all models entries checkpoint bytes and source listeners are released'
]);
const EXPECTED_CHECKS=6;
function validateResult(result){
 assert.equal(result.case,'set-series-presentation-quickjs');assert.equal(result.passed,true);assert.equal(result.checks,EXPECTED_CHECKS);
 assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/bundled ChartAPI\.setSeries and nativeCommand in standalone QuickJS\/Node VM/);
 assert.match(result.scope,/no Android JNI, Apple JSC, native SDK, browser or device proof/);return result;
}
test('standalone presentation fixture runs the generated bundle in a bare Node VM',async()=>{
 const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 validateResult(JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/set-series-presentation-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000})));
 const probe=context.setSeriesPresentationQuickjsProbe;
 assert.equal(probe.models.length,5);assert.equal(new Set(probe.models).size,5);assert.equal(probe.stores.length,5);assert.equal(new Set(probe.stores).size,5);
 assert.equal(probe.budgets.length,1);assert.equal(probe.callbacks.length,4);assert.equal(probe.held.length,3);assert.equal(probe.models[0],context.nativeModel);
 assert.deepEqual(Array.from(probe.styles),['color','fill','upColor','downColor','width','visible','label']);
 const calls=probe.callbacks.map(row=>Object.fromEntries(Object.entries(row)));
 assert.deepEqual(Array.from(calls),[
  {get:0,create:0,step:0,snapshot:0,restore:0},{get:0,create:0,step:0,snapshot:0,restore:0},
  {get:9,create:9,step:0,snapshot:0,restore:0},{get:1,create:1,step:0,snapshot:0,restore:0}
 ]);
 assert.deepEqual({...probe.reentry},{reads:3,notifications:1,replacementPreserved:true,originalPreserved:true});
 assert.equal(probe.fallback.checks,9);assert.deepEqual(Array.from(probe.fallback.keys),['output','offset','panel','axisId','type','source','baseline','id','color+output']);
 assert.ok(probe.ledger.targetBytes>0&&probe.ledger.keepBytes>0);assert.equal(probe.ledger.before,probe.ledger.targetBytes+probe.ledger.keepBytes);
 assert.equal(probe.ledger.afterPatch,probe.ledger.before);assert.equal(probe.ledger.gets,0);assert.equal(probe.ledger.creates,0);assert.equal(probe.ledger.afterDispose,0);
 assert.ok(probe.visibility.commands>0);assert.equal(probe.visibility.hiddenGet,0);assert.equal(probe.visibility.hiddenCalculation,0);assert.equal(probe.visibility.shownGetBeforeRead,0);assert.equal(probe.visibility.explicitReadErrorPreserved,true);
 for(const model of probe.models){assert.equal(model.disposed,true);assert.equal(model.indicators.entries.size,0);for(const series of model.series)assert.equal(series.rangeIndex,null);}
 for(const store of probe.stores)assert.equal(store.listeners.size,0);
 for(const budget of probe.budgets)assert.equal(budget.usedBytes,0);
 for(const held of probe.held)assert.deepEqual(Array.from(held.array),Array.from(held.copy));
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone','window','document'])assert.equal(context[key],undefined,key);
});
for(const [name,mutate] of Object.entries({
 'reduced coverage':r=>{r.checks=5;r.scenarios.pop();},
 'extra coverage':r=>{r.checks=7;r.scenarios.push('unverified SDK');},
 'missing scenario':r=>r.scenarios.pop(),
 'duplicate scenario':r=>r.scenarios[1]=r.scenarios[0],
 'unknown scenario':r=>r.scenarios[0]='unverified native SDK',
 'reordered scenarios':r=>r.scenarios.reverse(),
 'nonboolean success':r=>r.passed='true',
 'wrong fixture':r=>r.case='remove-indicator-quickjs',
 'wrong execution scope':r=>r.scope='bundled ChartAPI.setSeries in a browser',
 'missing platform limit':r=>r.scope='bundled ChartAPI.setSeries and nativeCommand in standalone QuickJS/Node VM'
}))test('presentation coverage oracle rejects '+name,()=>{
 const result={case:'set-series-presentation-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS],scope:'bundled ChartAPI.setSeries and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC, native SDK, browser or device proof'};
 validateResult(result);mutate(result);assert.throws(()=>validateResult(result));
});
