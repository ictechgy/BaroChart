import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync,constants as zlibConstants} from 'node:zlib';
import {access,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const DEFAULT_ASSET=join(ROOT,'src/web/wasm/barochart-core.wasm');
export const DEFAULT_MANIFEST=join(ROOT,'src/web/wasm/barochart-core.manifest.json');
export const DEFAULT_TARGET=join(ROOT,'artifacts/rust-wasm/eh-stdlib-target');
export const WEB_EXPORTS=Object.freeze(['memory','bc_alloc','bc_call','bc_engine_free','bc_engine_new','bc_free','bc_web_abi_version','bc_web_capabilities','bc_web_memory_stats','bc_web_packet','bc_web_read_f64','bc_web_write_f64']);
export const WEB_IMPORTS=Object.freeze(['env.host_release','env.js_exp','env.js_hypot','env.js_log','env.zone_offset_seconds','env.zone_resolve']);
export const SCHEMA='aster.web-wasm-build';
export const VERSION=1;
export const ABI_VERSION=1;
const CRATES=['barochart-js','barochart-core','barochart-bridge','barochart-ffi','barochart-wasm'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const portable=(path,root=ROOT)=>relative(root,path).split(sep).join('/');
const EH_RUST_FLAGS=Object.freeze(['-Cpanic=unwind','-Ctarget-feature=+exception-handling','-Cllvm-args=-wasm-use-legacy-eh=false']);
const PATH_REMAP_SCOPE='all';
const PATH_REMAP_PROVENANCE=Object.freeze([
 Object.freeze({from:'$RUST_SRC',to:'/rustc-src'}),
 Object.freeze({from:'$SYSROOT',to:'/rustc'}),
 Object.freeze({from:'$CARGO_HOME',to:'/cargo-home'}),
 Object.freeze({from:'$REPO',to:'/barochart'}),
 Object.freeze({from:'$HOME',to:'/build-home'}),
]);

/** Build one Cargo encoded flag string without losing path arguments containing spaces. */
export function encodedRustFlags(baseFlags,mappings,{scope=PATH_REMAP_SCOPE}={}){
 if(!Array.isArray(baseFlags)||baseFlags.some(value=>typeof value!=='string'||!value))throw new TypeError('Rust build flags must be non-empty strings');
 if(!Array.isArray(mappings)||mappings.some(row=>!row||typeof row.source!=='string'||!row.source||typeof row.target!=='string'||!row.target))throw new TypeError('Rust path remaps require source and target strings');
 const unique=[],seen=new Set();
 for(const row of mappings){const source=resolve(row.source);if(seen.has(source))continue;seen.add(source);unique.push({source,target:row.target});}
 unique.sort((left,right)=>right.source.length-left.source.length);
 const tokens=[...baseFlags];
 for(const row of unique)tokens.push('--remap-path-prefix',`${row.source}=${row.target}`);
 tokens.push('--remap-path-scope',scope);
 return {tokens,encoded:tokens.join('\x1f')};
}

/** Reject local checkout/home paths before a module can be published. */
export function validatePortableWasmBytes(bytes,{knownPrefixes=[]}={}){
 const value=Buffer.from(bytes),patterns=[
  ['/Users/','macOS user directory'],['/home/','Linux user directory'],['C:\\Users\\','Windows user directory'],['C:/Users/','Windows user directory'],
  ...knownPrefixes.filter(path=>typeof path==='string'&&path).map(path=>[resolve(path),'known local build prefix']),
 ];
 for(const [pattern,label] of patterns)if(value.includes(Buffer.from(pattern)))throw new Error(`WASM binary contains a ${label}`);
 return true;
}

async function sourceFiles(root){
 const paths=[join(root,'rust/Cargo.toml'),join(root,'rust/Cargo.lock'),join(root,'rust/rust-toolchain.toml')];
 const visit=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()&&!entry.isSymbolicLink())await visit(path);else if(!entry.isSymbolicLink()&&entry.name.endsWith('.rs')&&portable(path,root).includes('/src/'))paths.push(path);}};
 for(const crate of CRATES)await visit(join(root,'rust/crates',crate));
 paths.push(join(root,'rust/crates/barochart-wasm/build.rs'),join(root,'scripts/rust/build-web-wasm.mjs'),join(root,'scripts/rust/prepare-wasm-eh.py'));
 return [...new Set(paths)].sort();
}
export async function fingerprintInputs(root=ROOT){
 root=resolve(root);const files=await sourceFiles(root),hash=createHash('sha256');
 for(const path of files){hash.update(portable(path,root));hash.update('\0');hash.update(await readFile(path));hash.update('\0');}
 return {sha256:hash.digest('hex'),files:files.map(path=>portable(path,root))};
}
export function validateWasmBytes(bytes,{exports=WEB_EXPORTS,imports=WEB_IMPORTS,abiVersion=ABI_VERSION}={}){
 let module;try{module=new WebAssembly.Module(bytes);}catch(error){throw new Error(`WASM compile validation failed: ${error.message}`,{cause:error});}
 const actualExports=WebAssembly.Module.exports(module).map(item=>item.name).sort(),expected=[...exports].sort();
 if(JSON.stringify(actualExports)!==JSON.stringify(expected))throw new Error(`WASM export surface mismatch: expected ${expected.join(',')}; got ${actualExports.join(',')}`);
 const descriptors=WebAssembly.Module.exports(module),actualImports=WebAssembly.Module.imports(module).map(item=>`${item.module}.${item.name}`).sort();
 const expectedImports=[...imports].sort();if(JSON.stringify(actualImports)!==JSON.stringify(expectedImports))throw new Error(`WASM import surface mismatch: expected ${expectedImports.join(',')}; got ${actualImports.join(',')}`);
 const kinds=new Map(descriptors.map(item=>[item.name,item.kind]));for(const name of expected)if(name!=='memory'&&kinds.get(name)!=='function')throw new Error(`WASM export ${name} must be a function`);if(kinds.get('memory')!=='memory')throw new Error('WASM memory export must be a memory');
 const env={host_release:()=>{},js_log:()=>0,js_exp:()=>0,js_hypot:()=>0,zone_offset_seconds:()=>0,zone_resolve:()=>0};let instance;try{instance=new WebAssembly.Instance(module,{env});}catch(error){throw new Error(`WASM import validation failed: ${error.message}`,{cause:error});}const actualAbi=instance.exports.bc_web_abi_version?.();if(actualAbi!==abiVersion)throw new Error(`WASM ABI version mismatch: expected ${abiVersion}; got ${actualAbi}`);
 return {module,imports:actualImports,exports:actualExports,instance};
}
export function validateManifest(manifest,{sourceSha256=null,wasmBytes=null}={}){
 if(!manifest||manifest.schema!==SCHEMA||manifest.version!==VERSION||manifest.protocol!==1)throw new Error('invalid web WASM manifest header');
 if(manifest.abiVersion!==ABI_VERSION||manifest.panicStrategy!=='unwind'||manifest.exceptionHandling!==true)throw new Error('manifest is not the production EH build');
 if(sourceSha256!==null&&manifest.source?.sha256!==sourceSha256)throw new Error('WASM source fingerprint is stale');
 if(!/^[0-9a-f]{64}$/.test(manifest.source?.sha256??''))throw new Error('WASM source fingerprint is not SHA-256');
 if(!manifest.source?.files?.length||manifest.source.files.some(path=>path.startsWith('/')||path.includes('\\')||path.split('/').includes('..')||path.includes('/tests/')))throw new Error('WASM manifest contains a non-portable source path');
 if(!manifest.asset?.sha256||!Number.isInteger(manifest.asset?.bytes)||manifest.asset.bytes<=0)throw new Error('missing WASM asset provenance');
 if(wasmBytes){const module=validateWasmBytes(wasmBytes);const gzipBytes=gzipSync(wasmBytes,{level:9}).length,brotliBytes=brotliCompressSync(wasmBytes,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:11}}).length;if(manifest.asset.bytes!==wasmBytes.length||manifest.asset.sha256!==sha256(wasmBytes)||manifest.asset.gzipBytes!==gzipBytes||manifest.asset.brotliBytes!==brotliBytes)throw new Error('WASM asset hash, size, or compression metadata mismatch');if(JSON.stringify(module.exports)!==JSON.stringify([...WEB_EXPORTS].sort())||JSON.stringify(module.imports)!==JSON.stringify([...WEB_IMPORTS].sort())||JSON.stringify(manifest.module?.exports)!==JSON.stringify(module.exports)||JSON.stringify(manifest.module?.imports)!==JSON.stringify(module.imports))throw new Error('WASM manifest module surface mismatch');}
 if(manifest.asset.path!=='src/web/wasm/barochart-core.wasm'||manifest.manifestPath!=='src/web/wasm/barochart-core.manifest.json')throw new Error('unexpected public WASM asset path');
 if(JSON.stringify(manifest.build?.rustFlags)!==JSON.stringify(EH_RUST_FLAGS))throw new Error('production WASM flags are not the EH build');
 if(manifest.build?.pathRemapping?.scope!==PATH_REMAP_SCOPE||JSON.stringify(manifest.build?.pathRemapping?.prefixes)!==JSON.stringify(PATH_REMAP_PROVENANCE))throw new Error('production WASM path-remap provenance is missing');
 if(!manifest.build?.cargoArgs?.includes('-Zbuild-std=std,panic_unwind'))throw new Error('production WASM build-std provenance is missing');
 if(manifest.build?.target!=='wasm32-unknown-unknown'||manifest.build?.profile!=='release'||manifest.toolchain?.release!=='1.98.1')throw new Error('WASM toolchain/profile provenance mismatch');
 if(/(?:\/Users\/|\/home\/[^$]|[A-Za-z]:\\Users\\)/.test(JSON.stringify(manifest)))throw new Error('WASM manifest contains an absolute user path');
 return true;
}
function run(command,args,{cwd=ROOT,env=process.env}={}){const result=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:64<<20});if(result.error||result.status!==0)throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message??`exit ${result.status}`}):\n${(result.stderr??'').slice(-8000)}`);return result.stdout??'';}
async function prepareEnvironment(){const value=JSON.parse(run('python3',['scripts/rust/prepare-wasm-eh.py','--offline','--json']));if(!value.environment?.RUSTC||typeof value.environment.RUSTFLAGS!=='string'||typeof value.rustSource!=='string'||typeof value.cargoHome!=='string')throw new Error('WASM EH preparation did not provide the pinned compiler environment');const baseFlags=value.environment.RUSTFLAGS.trim().split(/\s+/);if(JSON.stringify(baseFlags)!==JSON.stringify(EH_RUST_FLAGS))throw new Error('WASM EH preparation flags changed');return value;}
export async function publishPair({assetPath,manifestPath,assetBytes,manifestText,renameImpl=rename}){
 const stageDir=join(dirname(assetPath),`.web-wasm-stage-${process.pid}`),stageAsset=join(stageDir,'asset.wasm'),stageManifest=join(stageDir,'manifest.json'),backupAsset=`${assetPath}.rollback-${process.pid}`,backupManifest=`${manifestPath}.rollback-${process.pid}`;let oldAsset=false,oldManifest=false,newAsset=false,newManifest=false;
 await mkdir(stageDir,{recursive:true});await writeFile(stageAsset,assetBytes);await writeFile(stageManifest,manifestText);
 try{try{await access(assetPath);oldAsset=true;}catch{}try{await access(manifestPath);oldManifest=true;}catch{}if(oldAsset)await renameImpl(assetPath,backupAsset);if(oldManifest)await renameImpl(manifestPath,backupManifest);await renameImpl(stageAsset,assetPath);newAsset=true;await renameImpl(stageManifest,manifestPath);newManifest=true;if(oldAsset)await rm(backupAsset,{force:true});if(oldManifest)await rm(backupManifest,{force:true});
 }catch(error){await rm(stageDir,{recursive:true,force:true});if(newAsset)await rm(assetPath,{force:true});if(newManifest)await rm(manifestPath,{force:true});if(oldAsset)await renameImpl(backupAsset,assetPath).catch(()=>{});if(oldManifest)await renameImpl(backupManifest,manifestPath).catch(()=>{});throw error;
 }finally{await rm(stageDir,{recursive:true,force:true});}
}
export async function buildWebWasm({root=ROOT,assetPath=DEFAULT_ASSET,manifestPath=DEFAULT_MANIFEST,targetDirectory=DEFAULT_TARGET,offline=true}={}){
 if(!offline)throw new Error('Web WASM builder only supports approved offline mode');
 root=resolve(root);assetPath=resolve(assetPath);manifestPath=resolve(manifestPath);targetDirectory=resolve(targetDirectory);
 const sourceBefore=await fingerprintInputs(root),prepared=await prepareEnvironment(),preparedEnv=prepared.environment;
 const probeEnv={...process.env,...preparedEnv,CARGO_INCREMENTAL:'0',CARGO_TARGET_DIR:targetDirectory,CARGO_NET_OFFLINE:'true'},sysroot=run(preparedEnv.RUSTC,['--print','sysroot'],{cwd:root,env:probeEnv}).trim();
 const remaps=encodedRustFlags(EH_RUST_FLAGS,[
  {source:prepared.rustSource,target:'/rustc-src'},
  {source:sysroot,target:'/rustc'},
  {source:prepared.cargoHome,target:'/cargo-home'},
  {source:root,target:'/barochart'},
  {source:homedir(),target:'/build-home'},
 ]);
 const env={...probeEnv,CARGO_ENCODED_RUSTFLAGS:remaps.encoded};const cargoArgs=['build','--offline','--locked','-Zbuild-std=std,panic_unwind','--release','-j2','-p','barochart-wasm','--target','wasm32-unknown-unknown'];
 run(process.execPath,['scripts/rust/cargo.mjs',...cargoArgs],{cwd:root,env});const built=join(targetDirectory,'wasm32-unknown-unknown/release/barochart_wasm.wasm');const wasmBytes=await readFile(built);const module=validateWasmBytes(wasmBytes);const sourceAfter=await fingerprintInputs(root);if(sourceBefore.sha256!==sourceAfter.sha256)throw new Error('WASM source changed during build; no asset published');
 validatePortableWasmBytes(wasmBytes,{knownPrefixes:[root,homedir(),prepared.rustSource,prepared.cargoHome,sysroot]});
 const rustcLines=run(env.RUSTC,['-vV'],{cwd:root,env}).split(/\r?\n/).filter(Boolean);const rustcRelease=rustcLines.find(line=>line.startsWith('release:'))?.split(':')[1]?.trim();const manifest={schema:SCHEMA,version:VERSION,protocol:1,abiVersion:ABI_VERSION,panicStrategy:'unwind',exceptionHandling:true,source:{sha256:sourceAfter.sha256,files:sourceAfter.files},toolchain:{release:rustcRelease,rustc:rustcLines.slice(0,5)},build:{profile:'release',target:'wasm32-unknown-unknown',rustFlags:[...EH_RUST_FLAGS],pathRemapping:{scope:PATH_REMAP_SCOPE,prefixes:PATH_REMAP_PROVENANCE.map(row=>({...row}))},cargoArgs},module:{imports:module.imports,exports:module.exports},asset:{path:'src/web/wasm/barochart-core.wasm',bytes:wasmBytes.length,sha256:sha256(wasmBytes),gzipBytes:gzipSync(wasmBytes,{level:9}).length,brotliBytes:brotliCompressSync(wasmBytes,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:11}}).length},manifestPath:'src/web/wasm/barochart-core.manifest.json'};validateManifest(manifest,{sourceSha256:sourceAfter.sha256,wasmBytes});await publishPair({assetPath,manifestPath,assetBytes:wasmBytes,manifestText:JSON.stringify(manifest,null,2)+'\n'});return manifest;
}
export async function checkWebWasm({root=ROOT,assetPath=DEFAULT_ASSET,manifestPath=DEFAULT_MANIFEST}={}){root=resolve(root);const wasmBytes=await readFile(resolve(assetPath)),manifest=JSON.parse(await readFile(resolve(manifestPath),'utf8')),source=await fingerprintInputs(root);validatePortableWasmBytes(wasmBytes,{knownPrefixes:[root,homedir()]});validateManifest(manifest,{sourceSha256:source.sha256,wasmBytes});return manifest;}
function help(){console.log('Usage: node scripts/rust/build-web-wasm.mjs [--offline] [--check] [--asset PATH] [--manifest PATH] [--target-dir PATH]');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const args=new Map();for(let i=2;i<process.argv.length;i++){const arg=process.argv[i];if(arg==='--help'){help();process.exit(0);}if(arg==='--offline'){continue;}if(arg==='--check'){args.set('check',true);continue;}if(!['--asset','--manifest','--target-dir'].includes(arg)||!process.argv[i+1])throw new Error(`unknown or incomplete argument ${arg}`);args.set(arg.slice(2),process.argv[++i]);}const options={assetPath:args.get('asset')??DEFAULT_ASSET,manifestPath:args.get('manifest')??DEFAULT_MANIFEST,targetDirectory:args.get('target-dir')??DEFAULT_TARGET,offline:true};const value=args.get('check')?await checkWebWasm(options):await buildWebWasm(options);console.log(JSON.stringify({passed:true,asset:value.asset?.path,bytes:value.asset?.bytes,sourceSha256:value.source?.sha256}));}
