import assert from 'node:assert/strict';import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
// Deliberate mutations only in disposable copies. A nonzero exit alone is not
// enough: each failure must be the intended numeric/redo assertion.
const temp=await mkdtemp(join(tmpdir(),'aster-mutation-')),results=[];
try{
 await cp('src/core',join(temp,'src/core'),{recursive:true});await mkdir(join(temp,'test'));await cp('test/independent-indicators.test.mjs',join(temp,'test/independent-indicators.test.mjs'));await writeFile(join(temp,'package.json'),'{"type":"module"}');
 const path=join(temp,'src/core/indicators.mjs'),source=await readFile(path,'utf8');assert.ok(source.includes('sign < 0 ? tp * b.volume : 0'));await writeFile(path,source.replace('sign < 0 ? tp * b.volume : 0','0'));
 const mfi=spawnSync(process.execPath,['--test','test/independent-indicators.test.mjs'],{cwd:temp,encoding:'utf8'});const output=mfi.stdout+mfi.stderr;assert.notEqual(mfi.status,0,'MFI mutation escaped');assert.match(output,/mfi\/value\[14\]/);assert.match(output,/AssertionError/);results.push({mutation:'MFI negative flow removed',caught:true,assertion:'mixed/mfi/value[14] independent numeric reference'});
 await mkdir(join(temp,'artifacts'));await mkdir(join(temp,'benchmarks/results'),{recursive:true});const bundle=await readFile('artifacts/aster-core.js','utf8');await writeFile(join(temp,'artifacts/aster-core.js'),bundle+"\nconst oldNativeKey=globalThis.nativeKey;globalThis.nativeKey=function(key,ctrl,shift){if(key==='z'&&ctrl&&shift)return;return oldNativeKey(key,ctrl,shift);};\n");
 const redo=spawnSync(resolve('artifacts/aster-native'),['--ui-test'],{cwd:temp,encoding:'utf8',timeout:20000});const nativeOutput=redo.stdout+redo.stderr;assert.notEqual(redo.status,0,'Native redo mutation escaped');assert.match(nativeOutput,/Native redo did not restore the saved geometry/);results.push({mutation:'native redo disabled',caught:true,assertion:'exact saved drawing geometry restored'});
 await writeFile('benchmarks/results/mutation-tests.json',JSON.stringify({mutations:results,productionSourcesModified:false},null,2));console.log(JSON.stringify(results));
}finally{await rm(temp,{recursive:true,force:true});}
