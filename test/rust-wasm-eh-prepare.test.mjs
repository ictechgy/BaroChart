import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const testDirectory=dirname(fileURLToPath(import.meta.url));
const repositoryRoot=join(testDirectory,'..');
const pythonTest=join(repositoryRoot,'scripts/rust/prepare_wasm_eh_test.py');

test('offline WASM EH preparer standard-library tests',()=>{
 const python=process.env.PYTHON||'python3';
 const result=spawnSync(python,[pythonTest],{cwd:repositoryRoot,encoding:'utf8'});
 assert.equal(result.error,undefined,result.error?.message);
 assert.equal(result.status,0,`${result.stdout||''}${result.stderr||''}`);
});
