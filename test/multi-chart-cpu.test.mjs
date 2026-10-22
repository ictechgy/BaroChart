import test from 'node:test';
import assert from 'node:assert/strict';
import {runCase,distribution} from '../benchmarks/multi-chart-cpu.mjs';
for(const charts of [1,4,8])for(const operation of ['clean','update','append'])test(`CPU harness ${charts} independent charts ${operation} checks source/study/ranges`,()=>{
 const r=runCase({charts,bars:64,operation,warmup:1,samples:2});assert.equal(r.rawMs.length,2);assert.equal(r.sceneCalls,charts*3);assert.equal(r.events,operation==='clean'?0:charts*3);assert.equal(r.correctness.rangeQueries,charts*3);assert.equal(r.correctness.checkedValues,charts*(operation==='append'?67:64)*7);assert.equal(r.initialTotalBars,charts*64);assert(r.rawMs.every(x=>Number.isFinite(x)&&x>=0));assert.equal(r.averagePerChartEquivalentMs.p50,r.groupMs.p50/charts);assert.equal(r.policies.length,charts);assert(r.policies.every(x=>x.capacity===(operation==='append'?128:64)));assert.match(r.cleanup,/disposed/);
});
test('reported distribution retains maximum and uses nearest-rank quantiles',()=>{const raw=[9,1,4,2];assert.deepEqual(distribution(raw),{count:4,p50:2,p95:9,max:9});assert.deepEqual(raw,[9,1,4,2]);});
test('invalid work sizes reject before creating models',()=>{for(const options of [{charts:9},{bars:31},{samples:41},{warmup:-1},{operation:'unknown'}])assert.throws(()=>runCase({charts:1,bars:64,operation:'clean',...options}));});
