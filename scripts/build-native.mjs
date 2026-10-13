import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {buildNativeBundle} from './native-core-bundle.mjs';
import {resolve,dirname} from 'node:path';
const root = new URL('../', import.meta.url); await mkdir(new URL('artifacts/', root), {recursive:true});
const modulePaths=[];let bundleOnly=false,output=null;const args=process.argv.slice(2);for(let i=0;i<args.length;i++){if(args[i]==='--bundle-only')bundleOnly=true;else if(args[i]==='--output')output=args[++i];else if(args[i]==='--indicator-module')modulePaths.push(args[++i]);else throw new TypeError('Unknown native build argument');}
if((output||modulePaths.length)&&!bundleOnly||bundleOnly&&!output||modulePaths.some(path=>typeof path!=='string'))throw new TypeError('Custom module build requires --bundle-only --output PATH');
const bundle=await buildNativeBundle({modulePaths});
if(bundleOnly){const path=resolve(output);await mkdir(dirname(path),{recursive:true});await writeFile(path,bundle);console.log('Native bundle: '+path);process.exit(0);}
await writeFile(new URL('artifacts/aster-core.js',root),bundle);
await mkdir(new URL('native/Resources/',root),{recursive:true});
await writeFile(new URL('native/Resources/aster-core.js',root),await readFile(new URL('artifacts/aster-core.js',root)));
const cache = '/tmp/aster-swift-module-cache'; await mkdir(cache,{recursive:true});
const result = spawnSync('swiftc',['-O','-warnings-as-errors','-module-cache-path',cache,'native/AsterNative.swift','native/AsterColumns.swift','native/AsterFrameRenderer.swift','examples/native/close-subscription-verification.swift','examples/native/study-verification.swift','examples/native/parity.swift','examples/native/frame-validation.swift','examples/native/axis-verification.swift','examples/native/async.swift','examples/native/prepare.swift','examples/native/correction-benchmark.swift','examples/native/main.swift','-o','artifacts/aster-native'],{cwd:root,stdio:'inherit'}); if (result.status !== 0) process.exit(result.status ?? 1); console.log('Native build: artifacts/aster-native');
