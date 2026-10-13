import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

test('packaged evidence accepts complete bytes and rejects missing, altered, duplicate or unsafe rows',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'aster-evidence-contract-'));
 try{
  const data=Buffer.from('{"observed":true}\n'),row={path:'report.json',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  await writeFile(join(folder,'report.json'),data);
  const base={schema:'aster.packaged-evidence.v1',includedFiles:[row],externalHostProvenance:[{path:'/tmp/private-coordinator.py',included:false,reason:'Historical host location; reusable copy separately included'}]};
  const run=async value=>{await writeFile(join(folder,'PACKAGED-MANIFEST.json'),JSON.stringify(value));return spawnSync('python3',[resolve('scripts/verify-evidence-package.py'),'--source-dir',folder],{encoding:'utf8'});};
  assert.equal((await run(base)).status,0);
  for(const patch of [{includedFiles:[{...row,path:'missing.json'}]},{includedFiles:[{...row,sha256:'0'.repeat(64)}]},
   {includedFiles:[{...row,bytes:row.bytes+1}]},{includedFiles:[]},{includedFiles:[row,row]},
   {includedFiles:[{...row,path:'../report.json'}]},{externalHostProvenance:[{path:'/tmp/x',included:true}]}]){
   assert.notEqual((await run({...base,...patch})).status,0);
  }
 }finally{await rm(folder,{recursive:true,force:true});}
});
