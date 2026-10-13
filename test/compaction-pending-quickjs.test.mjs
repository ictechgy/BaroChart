import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const expected=[
 'native command recovers a capped drain with exact pending FIFO and signed zero',
 'evicted correction rejects source and queue publication atomically',
 'future append does not retroactively authorize an earlier correction',
 'all source listeners and ingestion buffers are released',
];
test('pending compaction native fixture validates fixed scenarios in bare VM',async()=>{
 const c=vm.createContext({});vm.runInContext(await buildNativeBundle(),c,{timeout:5000});
 const result=JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/compaction-pending-quickjs.js',import.meta.url),'utf8'),c,{timeout:5000}));
 assert.deepEqual(result,{case:'compaction-pending-quickjs',passed:true,checks:4,scenarios:expected});
});
