import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {writePackageVerificationReport} from '../scripts/package-report.mjs';
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'barochart-report-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('package report creates a missing default artifacts parent',async t=>{
 const root=await temporary(t),output=join(root,'artifacts/npm-package-verification.json'),value={packageName:'barochart',passed:true};
 await assert.rejects(access(join(root,'artifacts')),{code:'ENOENT'});await writePackageVerificationReport(output,value);
 assert.equal(await readFile(output,'utf8'),JSON.stringify(value,null,2)+'\n');
});
test('package report preserves an existing directory and replaces only the requested output',async t=>{
 const root=await temporary(t),output=join(root,'report.json'),neighbor=join(root,'keep.txt');await writeFile(neighbor,'keep');await writeFile(output,'old');
 await writePackageVerificationReport(output,{passed:true});assert.equal(await readFile(neighbor,'utf8'),'keep');assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{passed:true});
});
test('nested custom output stays at its selected path without a default artifacts side effect',async t=>{
 const root=await temporary(t),output=join(root,'custom/deep/report.json');await writePackageVerificationReport(output,{custom:true});
 assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{custom:true});await assert.rejects(access(join(root,'artifacts')),{code:'ENOENT'});
});
test('mkdir permission error is propagated by identity without writing a report',async()=>{
 const error=Object.assign(new Error('synthetic permission denied'),{code:'EACCES',path:'/synthetic/report-parent'});let writes=0;
 await assert.rejects(writePackageVerificationReport('/synthetic/report-parent/result.json',{}, {mkdir:async()=>{throw error;},writeFile:async()=>{writes++;}}),e=>e===error);
 assert.equal(writes,0);assert.equal(error.code,'EACCES');
});
test('write permission error is propagated by identity after recursive parent admission',async()=>{
 const error=Object.assign(new Error('synthetic write denied'),{code:'EACCES'}),calls=[];
 await assert.rejects(writePackageVerificationReport('/synthetic/parent/result.json',{}, {mkdir:async(...args)=>calls.push(args),writeFile:async()=>{throw error;}}),e=>e===error);
 assert.deepEqual(calls,[['/synthetic/parent',{recursive:true}]]);
});
test('a real file in the parent path remains unchanged and raises the filesystem error',async t=>{
 const root=await temporary(t),parent=join(root,'occupied');await writeFile(parent,'original');
 await assert.rejects(writePackageVerificationReport(join(parent,'nested/report.json'),{}),e=>['ENOTDIR','EEXIST'].includes(e.code)&&typeof e.path==='string');assert.equal(await readFile(parent,'utf8'),'original');
});
test('serialization errors are not hidden and no partial report is written',async t=>{
 const root=await temporary(t),output=join(root,'artifacts/result.json'),value={};value.self=value;
 await assert.rejects(writePackageVerificationReport(output,value),TypeError);await assert.rejects(access(output),{code:'ENOENT'});
});
