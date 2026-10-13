import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('attachable partitions preserve every source/evidence byte and refuse replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aster-split-contract-'));
 const archive=join(dir,'fixture.zip'),output=join(dir,'parts');
 const fixture={
  'package.json':JSON.stringify({version:'0.2.13',private:true,license:'UNLICENSED'}),
  'src/core/data.mjs':'export const value=1;',
  'test/fixtures/local.mjs':'export const evidence={synthetic:true};',
  'benchmarks/results/cycle12/apple/raw.json':'{"preserved":"apple"}',
  'benchmarks/results/cycle12/android/raw.json':'{"preserved":"android"}',
  'benchmarks/results/cycle13/web/raw.json':'{"diagnostic":"web"}',
  'benchmarks/results/cycle13/android/raw.json':'{"diagnostic":"android"}',
  'benchmarks/results/cycle13/verification/raw.json':'{"diagnostic":"verdict"}'
 };
 const run=(code,args=[])=>spawnSync('python3',['-c',code,...args],{encoding:'utf8'});
 try{
  const created=run('import json,sys,hashlib,zipfile\nf=json.loads(sys.argv[2]);m={k:{"bytes":len(v.encode()),"sha256":hashlib.sha256(v.encode()).hexdigest()} for k,v in f.items()}\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for k,v in f.items():z.writestr("aster-charts/"+k,v)\n z.writestr("aster-charts/SOURCE-MANIFEST.json",json.dumps(m))',[archive,JSON.stringify(fixture)]);
  assert.equal(created.status,0,created.stderr);
  const before=await readFile(archive),command=['scripts/package-split.py',archive,'--output-dir',output,'--baseline-revision','synthetic-test-baseline'];
  const split=spawnSync('python3',command,{encoding:'utf8'});assert.equal(split.status,0,split.stderr);
  const proof=JSON.parse(split.stdout);assert.equal(proof.coverage_complete,true);assert.equal(proof.archives.length,6);
  const checked=run('import json,sys,hashlib,zipfile\np=json.loads(sys.argv[1]);original=json.loads(sys.argv[2]);seen=set()\nfor a in p["archives"]:\n assert a["bytes"]<15000000\n with zipfile.ZipFile(a["path"]) as z:\n  assert z.testzip() is None\n  m=json.loads(z.read("aster-charts/"+a["manifest"]))\n  for k,e in m.items():\n   b=z.read("aster-charts/"+k);assert len(b)==e["bytes"] and hashlib.sha256(b).hexdigest()==e["sha256"]\n   if k in original:\n    assert k not in seen and b==original[k].encode();seen.add(k)\n assert a["original_files"]>0\nassert seen==set(original)\n',[JSON.stringify(proof),JSON.stringify(fixture)]);assert.equal(checked.status,0,checked.stderr);
  assert.deepEqual(await readFile(archive),before);
  const first=await Promise.all(proof.archives.map(a=>readFile(a.path)));
  const again=spawnSync('python3',command,{encoding:'utf8'});assert.equal(again.status,0,again.stderr);
  assert.deepEqual(await Promise.all(proof.archives.map(a=>readFile(a.path))),first);
  const source=proof.archives.find(a=>a.group==='source');await writeFile(source.path,'existing distinct delivery');
  const refused=spawnSync('python3',command,{encoding:'utf8'});assert.notEqual(refused.status,0);assert.match(refused.stderr,/Refusing to overwrite/);
  assert.equal(await readFile(source.path,'utf8'),'existing distinct delivery');
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),proof.input_sha256);
 }finally{await rm(dir,{recursive:true,force:true});}
});
