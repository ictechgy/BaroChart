import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
import {QUICKJS_WORKSPACE_SCENARIOS,validateQuickjsCloudResults} from '../scripts/quickjs-cloud-result.mjs';
test('standalone QuickJS workspace fixture matches the Node VM oracle without host shims',async()=>{
 const bundle=await buildNativeBundle({modulePaths:['test/fixtures/native-workspace-module.mjs']}),fixture=await readFile(new URL('./fixtures/native-workspace-quickjs.js',import.meta.url),'utf8');
 const context=vm.createContext({});vm.runInContext(bundle,context);const result=JSON.parse(vm.runInContext(fixture,context,{timeout:5000}));
 assert.equal(result.passed,true);assert.equal(result.checks,130);assert.equal(result.iterations,100);assert.deepEqual([...result.scenarios].sort(),[...QUICKJS_WORKSPACE_SCENARIOS].sort());
 assert.equal(context.nativeModel.disposed,true);assert.equal(context.nativeModel.store.listeners.size,0);
});

function receipt(){return [{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...['workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'].map(name=>({case:name,passed:true,peakRequestedBytes:100,finalLiveBytes:0,finalAllocationCount:0}))];}
test('QuickJS result gate accepts complete deterministic coverage',()=>assert.equal(validateQuickjsCloudResults(receipt()).length,4));
for(const [name,mutate] of Object.entries({
 'missing case':r=>r.pop(),'duplicate case':r=>r[3]=r[2],'failed case':r=>r[1].passed=false,
 'reduced checks':r=>r[0].checks=129,'reduced repetition':r=>r[0].iterations=99,
 'missing scenario':r=>r[0].scenarios.pop(),'duplicate scenario':r=>r[0].scenarios[1]=r[0].scenarios[0],
 'nonzero live bytes':r=>r[1].finalLiveBytes=1,'nonzero allocation count':r=>r[2].finalAllocationCount=1,
 'invalid peak':r=>r[3].peakRequestedBytes=NaN,'peak above limit':r=>r[2].peakRequestedBytes=9*1024*1024
}))test('QuickJS result gate rejects '+name,()=>{const r=receipt();mutate(r);assert.throws(()=>validateQuickjsCloudResults(r));});
