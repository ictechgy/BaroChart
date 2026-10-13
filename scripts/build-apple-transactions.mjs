// Compile acceptance hosts only; the coordinator generates the shared core.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const output=resolve(process.env.ASTER_APPLE_BUILD??'artifacts/apple-transactions');
const core=resolve(process.env.ASTER_APPLE_CORE??'native/Resources/aster-core.js');
const digest=b=>createHash('sha256').update(b).digest('hex');
const coreBytes=await readFile(core),coreSHA256=digest(coreBytes);
if(process.env.ASTER_APPLE_CORE_SHA&&coreSHA256!==process.env.ASTER_APPLE_CORE_SHA)throw new Error('Frozen native core SHA mismatch');
const common=['native/AsterNative.swift','native/AsterColumns.swift','native/AsterFrameRenderer.swift','examples/native/parity.swift','examples/native/axis-verification.swift','examples/native/transaction-verification.swift'];
const sources=[...common,'native/AsterUIKit.swift','examples/native/transaction-main.swift','examples/ios/TransactionApp.swift','scripts/build-apple-transactions.mjs','scripts/test-apple-transactions.mjs','package.json'];
const hashes=Object.fromEntries(await Promise.all(sources.map(async f=>[f,digest(await readFile(f))])));
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
const run=(command,args)=>{const r=spawnSync(command,args,{stdio:'inherit'});if(r.status!==0)throw new Error(`${command} failed ${r.status}`);};
const read=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
await mkdir(output,{recursive:true});await writeFile(join(output,'aster-core.js'),coreBytes);
const cache='/tmp/aster-swift-module-cache';await mkdir(cache,{recursive:true});
run('swiftc',['-parse-as-library','-O','-warnings-as-errors','-module-cache-path',cache,...common,'examples/native/transaction-main.swift','-o',join(output,'aster-transactions')]);
const macOnly=process.argv.includes('--mac-only'),app=join(output,'TransactionValidation.app');
if(!macOnly){
 await mkdir(app,{recursive:true});await writeFile(join(app,'aster-core.js'),coreBytes);
 await copyFile('examples/ios/Info.plist',join(app,'Info.plist'));
 run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier dev.aster.charts.transactions',join(app,'Info.plist')]);
 run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleExecutable TransactionValidation',join(app,'Info.plist')]);
 run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Aster Transaction Acceptance',join(app,'Info.plist')]);
 run('/usr/libexec/PlistBuddy',['-c',`Set :CFBundleShortVersionString ${packageVersion}`,join(app,'Info.plist')]);
 const sdk=read('xcrun',['--sdk','iphonesimulator','--show-sdk-path']);
 run('xcrun',['--sdk','iphonesimulator','swiftc','-parse-as-library','-O','-warnings-as-errors','-module-cache-path',cache,'-target','arm64-apple-ios17.0-simulator','-sdk',sdk,...common,'native/AsterUIKit.swift','examples/ios/TransactionApp.swift','-o',join(app,'TransactionValidation')]);
}
for(const f of sources)if(digest(await readFile(f))!==hashes[f])throw new Error(`Source changed during compilation: ${f}`);
if(digest(await readFile(core))!==coreSHA256)throw new Error('Frozen core changed during compilation');
const manifest={schema:'aster.apple.acceptance.build',protocol:1,packageVersion,gitHead:read('git',['rev-parse','HEAD']),corePath:core,coreSHA256,sources:hashes,macBinarySHA256:digest(await readFile(join(output,'aster-transactions'))),iosBinarySHA256:macOnly?null:digest(await readFile(join(app,'TransactionValidation'))),iosTarget:macOnly?null:'arm64-apple-ios17.0-simulator',productionSourceEdited:false};
await writeFile(join(output,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(!macOnly)await copyFile(join(output,'build-manifest.json'),join(app,'build-manifest.json'));
console.log(JSON.stringify({output,coreSHA256,macOnly}));
