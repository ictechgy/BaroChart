import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const fixture=await readFile(new URL('./fixtures/data-explorer-cached-native.js',import.meta.url),'utf8');
for(const kind of ['generated','shipped'])test('cached dataAt executes through '+kind+' native command bundle',async()=>{
 const source=kind==='generated'?await buildNativeBundle():await readFile(new URL('../native/Resources/aster-core.js',import.meta.url),'utf8'),context=vm.createContext({});
 vm.runInContext(source,context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(fixture,context,{timeout:5000}));
 assert.equal(result.status,'passed');assert.equal(result.checks,9);assert.equal(result.names.length,9);assert.equal(new Set(result.names).size,9);
 for(const name of ['TextEncoder','Buffer','process','require','setTimeout','structuredClone'])assert.equal(context[name],undefined);
});
