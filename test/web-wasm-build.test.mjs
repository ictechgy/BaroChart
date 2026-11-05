import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {brotliCompressSync,gzipSync,constants as zlibConstants} from 'node:zlib';
import {WEB_EXPORTS,WEB_IMPORTS,encodedRustFlags,fingerprintInputs,publishPair,validateManifest,validatePortableWasmBytes,validateWasmBytes} from '../scripts/rust/build-web-wasm.mjs';

const bytes=(...values)=>Uint8Array.from(values);
const leb=value=>{const out=[];do{let part=value&0x7f;value>>>=7;if(value)part|=0x80;out.push(part);}while(value);return out;};
const vec=items=>[...leb(items.length),...items.flatMap(item=>item)];
const name=value=>[...leb(value.length),...Buffer.from(value)];
function section(id,payload){return [id,...leb(payload.length),...payload];}
function fixtureModule(exportNames=WEB_EXPORTS,abiValue=1,importNames=WEB_IMPORTS){
 const functionNames=exportNames.filter(value=>value!=='memory');
 const type=section(1,vec([[0x60,0,0],[0x60,0,1,0x7f]]));
 const importEntries=importNames.map(value=>{const [module,field]=value.split('.');return [...name(module),...name(field),0,0];});
 const imports=section(2,vec(importEntries));
 const functions=section(3,vec(functionNames.map(value=>[value==='bc_web_abi_version'?1:0])));
 const memory=section(5,vec([[0,1]]));
 const exports=section(7,vec([[...name('memory'),2,0],...functionNames.map((value,index)=>[...name(value),0,importNames.length+index])]));
 const code=section(10,vec(functionNames.map(value=>{const body=value==='bc_web_abi_version'?[0,0x41,abiValue,0x0b]:[0,0x0b];return [...leb(body.length),...body];})));
 return bytes(0,0x61,0x73,0x6d,1,0,0,0,...type,...imports,...functions,...memory,...exports,...code);
}
const sha256=value=>createHash('sha256').update(value).digest('hex');
function manifest(asset,source='0'.repeat(64)){
 const module=validateWasmBytes(asset);
 return {schema:'aster.web-wasm-build',version:1,protocol:1,abiVersion:1,panicStrategy:'unwind',exceptionHandling:true,source:{sha256:source,files:['rust/Cargo.toml']},toolchain:{release:'1.98.1',rustc:['rustc 1.98.1']},build:{profile:'release',target:'wasm32-unknown-unknown',rustFlags:['-Cpanic=unwind','-Ctarget-feature=+exception-handling','-Cllvm-args=-wasm-use-legacy-eh=false'],pathRemapping:{scope:'all',prefixes:[{from:'$RUST_SRC',to:'/rustc-src'},{from:'$SYSROOT',to:'/rustc'},{from:'$CARGO_HOME',to:'/cargo-home'},{from:'$REPO',to:'/barochart'},{from:'$HOME',to:'/build-home'}]},cargoArgs:['build','-Zbuild-std=std,panic_unwind']},module:{imports:module.imports,exports:module.exports},asset:{path:'src/web/wasm/barochart-core.wasm',bytes:asset.length,sha256:sha256(asset),gzipBytes:gzipSync(asset,{level:9}).length,brotliBytes:brotliCompressSync(asset,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:11}}).length},manifestPath:'src/web/wasm/barochart-core.manifest.json'};
}

test('WASM fixture has the exact planned export/import surface',()=>{
 const module=validateWasmBytes(fixtureModule());
 assert.deepEqual(module.exports,[...WEB_EXPORTS].sort());
 assert.deepEqual(module.imports,[...WEB_IMPORTS].sort());
});

test('manifest validation rejects stale source and tampered bytes',()=>{
 const asset=fixtureModule();
 const hash=sha256(asset), row=manifest(asset);
 row.asset.sha256=hash;row.source.sha256='0'.repeat(64);
 assert.equal(validateManifest(row,{sourceSha256:'0'.repeat(64),wasmBytes:asset}),true);
 assert.throws(()=>validateManifest(row,{sourceSha256:'1'.repeat(64),wasmBytes:asset}),/source fingerprint is stale/);
 const tamperedManifest={...row,asset:{...row.asset,sha256:'0'.repeat(64)}};
 assert.throws(()=>validateManifest(tamperedManifest,{sourceSha256:'0'.repeat(64),wasmBytes:asset}),/asset hash, size, or compression metadata mismatch/);
});

test('manifest validation rejects wrong export surface and non-EH provenance',()=>{
 const asset=fixtureModule(WEB_EXPORTS.map((name,index)=>index===0?`${name}-wrong`:name));
 assert.throws(()=>validateWasmBytes(asset),/export surface mismatch/);
 const valid=fixtureModule(),row=manifest(valid);row.asset.sha256=sha256(valid);row.panicStrategy='abort';
 assert.throws(()=>validateManifest(row,{sourceSha256:'0'.repeat(64),wasmBytes:valid}),/production EH build/);
 assert.throws(()=>validateWasmBytes(fixtureModule(WEB_EXPORTS,2)),/ABI version mismatch/);
});

test('manifest validator requires every import and records truthful module surface',()=>{
 const missingImport=fixtureModule(WEB_EXPORTS,1,WEB_IMPORTS.slice(1));
 assert.throws(()=>validateWasmBytes(missingImport),/import surface mismatch/);
 const valid=fixtureModule(),row=manifest(valid);row.module.exports=[...row.module.exports,'fake'];row.asset.sha256=sha256(valid);
 assert.throws(()=>validateManifest(row,{sourceSha256:'0'.repeat(64),wasmBytes:valid}),/module surface mismatch/);
});

test('pair publication rolls back an existing asset when manifest rename fails',async()=>{
 const directory=await import('node:fs/promises').then(fs=>fs.mkdtemp('/tmp/web-wasm-publish-'));
 const assetPath=`${directory}/asset.wasm`,manifestPath=`${directory}/manifest.json`,oldAsset=Buffer.from('old-asset'),oldManifest='old-manifest\n';
 const fs=await import('node:fs/promises');await fs.writeFile(assetPath,oldAsset);await fs.writeFile(manifestPath,oldManifest);
 let manifestRenames=0;const renameImpl=async(from,to)=>{if(String(to)===manifestPath&&manifestRenames++===0)throw new Error('injected manifest publish failure');return fs.rename(from,to);};
 await assert.rejects(publishPair({assetPath,manifestPath,assetBytes:Buffer.from('new-asset'),manifestText:'new-manifest\n',renameImpl}),/injected manifest publish failure/);
 assert.deepEqual(await fs.readFile(assetPath),oldAsset);assert.equal(await fs.readFile(manifestPath,'utf8'),oldManifest);await fs.rm(directory,{recursive:true,force:true});
});

test('manifest paths are portable and asset compression metadata is present',()=>{
 const asset=fixtureModule(),row=manifest(asset);row.asset.sha256=sha256(asset);
 assert.equal(validateManifest(row,{sourceSha256:'0'.repeat(64),wasmBytes:asset}),true);
 assert.equal(row.asset.gzipBytes>0,true);assert.equal(row.asset.brotliBytes>0,true);
 row.source.files=['/Users/private/Cargo.toml'];
 assert.throws(()=>validateManifest(row,{sourceSha256:'0'.repeat(64),wasmBytes:asset}),/non-portable source path/);
});

test('encoded Rust flags preserve remap paths containing spaces and the EH flags',()=>{
 const base=['-Cpanic=unwind','-Ctarget-feature=+exception-handling','-Cllvm-args=-wasm-use-legacy-eh=false'];
 const result=encodedRustFlags(base,[{source:'/tmp/project with spaces',target:'/barochart'},{source:'/tmp',target:'/build-home'}]);
 assert.deepEqual(result.tokens.slice(0,3),base);
 assert.ok(result.tokens.includes('/tmp/project with spaces=/barochart'));
 assert.deepEqual(result.tokens.slice(-2),['--remap-path-scope','all']);
 assert.deepEqual(result.encoded.split('\x1f'),result.tokens);
});

test('binary portability validation rejects home prefixes without exposing them',()=>{
 assert.equal(validatePortableWasmBytes(Buffer.from('portable /barochart/src/lib.rs')),true);
 for(const path of ['/Users/private/project','/home/person/project','C:\\Users\\person\\project'])assert.throws(()=>validatePortableWasmBytes(Buffer.from(`debug ${path}`)),/user directory/);
 assert.throws(()=>validatePortableWasmBytes(Buffer.from('debug /private/build/project'),{knownPrefixes:['/private/build/project']}),/known local build prefix/);
});

test('production fingerprint includes source and excludes Rust tests/targets',async()=>{
 const fingerprint=await fingerprintInputs();
 assert.ok(fingerprint.files.includes('rust/crates/barochart-core/src/lib.rs'));
 assert.ok(fingerprint.files.includes('rust/crates/barochart-wasm/build.rs'));
 assert.ok(fingerprint.files.includes('scripts/rust/build-web-wasm.mjs'));
 assert.ok(fingerprint.files.every(path=>!path.includes('/tests/')));
 assert.ok(fingerprint.files.every(path=>!path.includes('/target/')));
 assert.match(fingerprint.sha256,/^[0-9a-f]{64}$/);
});
