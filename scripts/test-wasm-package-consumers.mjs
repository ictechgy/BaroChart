// Offline package consumer verification for the optional Rust/WASM web backend.
// This script packs the current source into an isolated npm consumer, checks
// the public WASM subpaths and types, then (when local bundlers are available)
// emits a real browser Worker plus .wasm asset. It never publishes or downloads.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {copyFile,access,mkdir,mkdtemp,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {dirname,extname,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const {values}=parseArgs({options:{
  'source-root':{type:'string'},workdir:{type:'string'},'tools-dir':{type:'string'},
  'skip-browser':{type:'boolean',default:false},'allow-missing-vite':{type:'boolean',default:false},report:{type:'string'},
}});
const sourceRoot=resolve(values['source-root']??join(import.meta.dirname,'..'));
const workdir=resolve(values.workdir??await mkdtemp('/tmp/barochart-wasm-consumer-'));
if(!workdir.startsWith('/tmp/barochart-wasm-consumer-'))throw new Error('Consumer workdir must be /tmp/barochart-wasm-consumer-*');
await mkdir(workdir,{recursive:true});
const cache=join(workdir,'npm-cache'),userConfig=join(workdir,'npm-user.conf'),globalConfig=join(workdir,'npm-global.conf');
await mkdir(cache,{recursive:true});await writeFile(userConfig,'');await writeFile(globalConfig,'');
const npmPrefix=['--cache',cache,'--userconfig',userConfig,'--globalconfig',globalConfig];
const commands=[];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=path=>access(path).then(()=>true,()=>false);
function run(executable,args,cwd=sourceRoot,{allowFailure=false}={}){
 const result=spawnSync(executable,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024});
 commands.push({executable,args,cwd,exitCode:result.status,stdout:result.stdout??'',stderr:result.stderr??''});
 if(!allowFailure&&result.status!==0)throw new Error(`${executable} ${args.join(' ')} failed (${result.status})\n${result.stdout??''}${result.stderr??''}`);
 return result;
}
function npm(args,cwd=sourceRoot){return run('npm',[...npmPrefix,...args],cwd);}
function toolRoot(){
 const candidates=[];
 if(values['tools-dir'])candidates.push(resolve(values['tools-dir']));
 candidates.push(join(sourceRoot,'artifacts/toolchain'));
 candidates.push(join(dirname(sourceRoot),'BaroChart-review-20261023/artifacts/toolchain'));
 return candidates.find(path=>path&&existsSync(path))||null;
}
function packageTool(root,name,version){
 const direct=join(root??'','node_modules',name);
 if(direct&&existsSync(direct))return direct;
 const path=join(root??'',`${name}-${version}`,'node_modules',name);
 return path;
}
async function allFiles(root){
 const out=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name);if(entry.isDirectory())out.push(...await allFiles(path));else out.push(path);
 }
 return out;
}
async function writeFixture(consumer,name){await copyFile(join(sourceRoot,'test/package-consumers',name),join(consumer,name));}
async function installTarball(tarball){
 const consumer=join(workdir,'consumer');await mkdir(consumer,{recursive:true});
 await writeFile(join(consumer,'package.json'),JSON.stringify({name:'barochart-wasm-consumer',private:true,type:'module'},null,2));
 npm(['install','--offline','--ignore-scripts','--no-audit','--no-fund',tarball],consumer);
 return consumer;
}
async function verifyTarball(){
 const packDir=join(workdir,'pack');await mkdir(packDir,{recursive:true});
 const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',packDir]).stdout)[0];
 if(!packed?.filename)throw new Error('npm pack did not return a tarball');
 const tarball=join(packDir,packed.filename),consumer=await installTarball(tarball),installed=join(consumer,'node_modules','barochart');
 const packageJSON=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
 assert.equal(packageJSON.name,'barochart');assert.equal(Object.keys(packageJSON.dependencies??{}).length,0);
 const requiredFiles=['src/web/wasm/index.mjs','src/web/wasm/index.d.mts','src/web/wasm/asset.mjs','src/web/wasm/worker-entry.mjs','src/web/wasm/javascript-migration.mjs','src/web/wasm/barochart-core.wasm','src/web/wasm/barochart-core.manifest.json'];
 for(const file of requiredFiles)assert(await exists(join(installed,file)),`Missing packaged WASM file ${file}`);
 const wasm=await readFile(join(installed,'src/web/wasm/barochart-core.wasm')),manifest=JSON.parse(await readFile(join(installed,'src/web/wasm/barochart-core.manifest.json'),'utf8'));
 assert.equal(manifest.asset.path,'src/web/wasm/barochart-core.wasm');assert.equal(manifest.asset.bytes,wasm.length);assert.equal(manifest.asset.sha256,sha256(wasm));assert.equal(manifest.manifestPath,'src/web/wasm/barochart-core.manifest.json');
 const packageFiles=packed.files.map(file=>file.path);
 assert(!packageFiles.some(file=>/^(artifacts|benchmarks|test|examples|scripts)\//.test(file)),'Development files leaked into the npm package');
 await writeFixture(consumer,'wasm-node.mjs');await writeFixture(consumer,'wasm-types.mts');
 const nodeFixture=run(process.execPath,['wasm-node.mjs'],consumer);const nodeResult=JSON.parse(nodeFixture.stdout.trim());assert.equal(nodeResult.ssrSafe,true);assert(nodeResult.wasmExports.includes('loadRustBackend'));assert(nodeResult.migrationExports.includes('captureJavaScriptMigration'));
 const tscRoot=toolRoot(),tscPackage=tscRoot&&packageTool(tscRoot,'typescript','5.9.3'),tsc=tscPackage&&join(tscPackage,'lib/tsc.js');let types={status:'skipped',reason:'TypeScript 5.9.3 toolchain not found'};
 if(tsc&&await exists(tsc)){
  await writeFile(join(consumer,'tsconfig-wasm.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,skipLibCheck:false,module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022',lib:['ES2022','DOM'],types:[]},files:['wasm-types.mts']}));
  const result=run(process.execPath,[tsc,'--project','tsconfig-wasm.json'],consumer,{allowFailure:true});if(result.status!==0)throw new Error(`WASM package TypeScript consumer failed:\n${result.stdout}${result.stderr}`);types={status:'passed',typescript:JSON.parse(await readFile(join(tscPackage,'package.json'),'utf8')).version};
 }
 const nodeSources=await allFiles(join(installed,'src/web/wasm'));for(const file of nodeSources.filter(path=>path.endsWith('.mjs'))){const text=await readFile(file,'utf8');assert(!/from ['"]node:|require\(['"](?:fs|path|worker_threads)/.test(text),`Node-only import leaked into ${relative(installed,file)}`);}
 return {tarball,consumer,package:{name:packageJSON.name,version:packageJSON.version,bytes:packed.size,unpackedBytes:packed.unpackedSize,fileCount:packed.files.length,sha256:sha256(await readFile(tarball)),exports:Object.keys(packageJSON.exports??{})},asset:{bytes:wasm.length,sha256:sha256(wasm),manifestSha256:manifest.asset.sha256},node:nodeResult,types,packageFiles};
}
async function sourceSnapshot(){
 const files=['package.json','src/web/wasm/index.mjs','src/web/wasm/index.d.mts','src/web/wasm/backend.mjs','src/web/wasm/worker-entry.mjs','src/web/wasm/asset.mjs','src/web/wasm/javascript-migration.mjs'];
 const snapshot={};for(const file of files){const bytes=await readFile(join(sourceRoot,file));snapshot[file]={bytes:bytes.length,sha256:sha256(bytes)};}
 const packageJSON=JSON.parse(await readFile(join(sourceRoot,'package.json')));return {files:snapshot,exports:Object.keys(packageJSON.exports??{}),runtimeSubpaths:Object.keys(packageJSON.exports??{}).filter(key=>key.startsWith('./wasm'))};
}
async function toolReport(){
 const root=toolRoot(),names=['vite','rollup','esbuild','typescript'],versions={};
 for(const name of names){const path=root&&packageTool(root,name,name==='vite'?'7.3.7':name==='rollup'?'4.64.5':name==='esbuild'?'0.28.2':'5.9.3');if(path&&await exists(join(path,'package.json')))versions[name]=JSON.parse(await readFile(join(path,'package.json'),'utf8')).version;}
 const lockPath=root&&join(root,'package-lock.json');return {root,versions,lock:lockPath&&await exists(lockPath)?{path:lockPath,sha256:sha256(await readFile(lockPath)),lockfileVersion:JSON.parse(await readFile(lockPath,'utf8')).lockfileVersion}:null};
}
async function esbuildProof(consumer){
 const root=toolRoot(),entry=packageTool(root,'esbuild','0.28.2'),result={status:'skipped',reason:'esbuild 0.28.2 toolchain not found'};
 if(!entry||!await exists(join(entry,'lib/main.js')))return result;
 const esbuild=await import(pathToFileURL(join(entry,'lib/main.js')).href),outdir=join(workdir,'esbuild-dist');await mkdir(outdir,{recursive:true});
 await writeFile(join(consumer,'wasm-bundle-entry.mjs'),bundleEntryText());
 const built=await esbuild.build({absWorkingDir:consumer,entryPoints:['wasm-bundle-entry.mjs','node_modules/barochart/src/web/wasm/worker-entry.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outdir,entryNames:'[name]',assetNames:'assets/[name]-[hash]',loader:{'.wasm':'file'},metafile:true,logLevel:'silent'});
 const outputs=Object.keys(built.metafile.outputs).map(path=>relative(outdir,resolve(consumer,path)));const files=await allFiles(outdir);
 const wasmFiles=files.filter(path=>path.endsWith('.wasm')),workerFiles=files.filter(path=>/worker-entry|worker/.test(path));assert(wasmFiles.length>=1,'esbuild did not emit the .wasm asset');assert(workerFiles.length>=1,'esbuild did not emit the Worker entry');
 const entryFile=outputs.find(path=>/wasm-bundle-entry\.js$/.test(path))??outputs.find(path=>path.endsWith('.js')&&!/worker-entry/.test(path));assert(entryFile,'esbuild production entry missing');
 return {status:'passed',version:'0.28.2',outdir,entryFile,outputs,wasmFiles:wasmFiles.map(path=>relative(outdir,path)),workerFiles:workerFiles.map(path=>relative(outdir,path)),metafile:built.metafile};
}
async function viteProof(consumer){
 const root=toolRoot(),entry=packageTool(root,'vite','7.3.7'),result={status:'skipped',reason:'Vite 7.3.7 toolchain not found'};
 if(!entry||!await exists(join(entry,'dist/node/index.js')))return result;
 const vite=await import(pathToFileURL(join(entry,'dist/node/index.js')).href),viteRootPath=join(consumer,'vite-app');await mkdir(viteRootPath,{recursive:true});const viteRoot=await realpath(viteRootPath),dist=join(viteRoot,'dist');
 await writeFile(join(viteRoot,'index.html'),'<!doctype html><html><body><script type="module" src="/wasm-browser-vite.mjs"></script></body></html>');
 await copyFile(join(consumer,'node_modules/barochart/src/web/wasm/barochart-core.wasm'),join(viteRoot,'barochart-core.wasm'));
 // Vite's worker plugin must resolve the package entry through the public
 // export map so its relative runtime imports are bundled as one Worker.
 await writeFile(join(viteRoot,'wasm-browser-vite.mjs'),viteEntryText());
 const config={root:viteRoot,configFile:false,logLevel:'silent',build:{outDir:dist,emptyOutDir:true,target:'es2022'}};await vite.build(config);const files=await allFiles(dist),wasmFiles=files.filter(path=>path.endsWith('.wasm')),workerFiles=files.filter(path=>/worker-entry|worker/.test(path));assert(wasmFiles.length>=1,'Vite did not emit the .wasm asset');assert(workerFiles.length>=1,'Vite did not emit the Worker entry');let entryPath=null;for(const path of files.filter(path=>path.endsWith('.js'))){if(/__bundleResult|Vite WASM chart Worker\/bar count mismatch/.test(await readFile(path,'utf8'))){entryPath=path;break;}}assert(entryPath,'Vite production entry did not retain the Rust smoke call');
 return {status:'passed',version:'7.3.7',dist,entryFile:relative(dist,entryPath),wasmFiles:wasmFiles.map(path=>relative(dist,path)),workerFiles:workerFiles.map(path=>relative(dist,path))};
}
function mime(path){return extname(path)==='.wasm'?'application/wasm':extname(path)==='.html'?'text/html; charset=utf-8':'text/javascript; charset=utf-8';}
async function staticServer(root){
 const server=createServer(async(req,res)=>{try{const requestPath=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname),file=resolve(root,'.'+requestPath);if(!file.startsWith(root+('/') )&&!file.startsWith(root+'\\'))throw new Error('outside root');const bytes=await readFile(file);res.statusCode=200;res.setHeader('Content-Type',mime(file));res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none';");res.end(bytes);}catch{res.statusCode=404;res.end('Not found');}});
 await new Promise((resolveServer,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveServer);});return server;
}
async function browserProof(consumer){
 if(values['skip-browser'])return {status:'skipped',reason:'--skip-browser'};
 const {launchBrowser}=await import(pathToFileURL(join(sourceRoot,'scripts/cdp.mjs')).href),server=await staticServer(consumer);let browser;
 try{
  browser=await launchBrowser({width:1280,height:900,dpr:1});const html='<!doctype html><html><head><script>globalThis.__wasmConsumerErrors=[];addEventListener("error",event=>globalThis.__wasmConsumerErrors.push(String(event.error?.stack??event.message)));addEventListener("unhandledrejection",event=>globalThis.__wasmConsumerErrors.push(String(event.reason?.stack??event.reason)));</script><script type="importmap">{"imports":{"barochart/wasm":"/node_modules/barochart/src/web/wasm/index.mjs","barochart/wasm-asset":"/node_modules/barochart/src/web/wasm/asset.mjs","barochart/wasm-worker-entry":"/node_modules/barochart/src/web/wasm/worker-entry.mjs","barochart/wasm-migration":"/node_modules/barochart/src/web/wasm/javascript-migration.mjs"}}</script></head><body><script type="module" src="/wasm-browser.mjs"></script></body></html>';await writeFile(join(consumer,'index.html'),html);await browser.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`},browser.sessionId);const result=await browser.evaluate(`(async()=>{for(let i=0;i<50;i++){if(globalThis.__wasmConsumerResult)return globalThis.__wasmConsumerResult;if(globalThis.__wasmConsumerErrors?.length)throw new Error(globalThis.__wasmConsumerErrors.join('\\n'));await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Browser consumer timed out');})()`,{timeout:10000,label:'wasm package consumer'});assert(result&&!result.error,JSON.stringify(result));return {status:'passed',browser:result,userAgent:await browser.send('Browser.getVersion',{},null)};
 }finally{await browser?.close();await new Promise(resolveServer=>server.close(resolveServer));}
}
async function browserBundleProof(root,entryFile,label){
 const {launchBrowser}=await import(pathToFileURL(join(sourceRoot,'scripts/cdp.mjs')).href),server=await staticServer(root);let browser;
 try{
  const relativeEntry=entryFile.replaceAll('\\','/');
  const page=label==='vite'?'index-smoke.html':`smoke-${label}.html`;
  const runnerName=`${page.replace(/\.html$/,'')}-runner.mjs`;
  const runner=`globalThis.__bundleErrors=[];addEventListener('error',event=>globalThis.__bundleErrors.push(String(event.error?.stack??event.message)));addEventListener('unhandledrejection',event=>globalThis.__bundleErrors.push(String(event.reason?.stack??event.reason)));${label==='vite'?`import '/${relativeEntry}';`:`import * as module from '/${relativeEntry}';module.smoke().then(result=>globalThis.__bundleResult=result).catch(error=>globalThis.__bundleError=String(error?.stack??error));`}`;
  const html=`<!doctype html><html><head></head><body><script type="module" src="/${runnerName}"></script></body></html>`;
  await writeFile(join(root,runnerName),runner);await writeFile(join(root,page),html);browser=await launchBrowser({width:1280,height:900,dpr:1});await browser.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/${page}`},browser.sessionId);
  const result=await browser.evaluate(`(async()=>{for(let i=0;i<100;i++){if(globalThis.__bundleError)return {timeout:false,error:globalThis.__bundleError};if(globalThis.__bundleErrors?.length)return {timeout:false,error:globalThis.__bundleErrors.join('\\n')};if(globalThis.__bundleResult){const response=await fetch(globalThis.__bundleResult.wasmURL);return {...globalThis.__bundleResult,wasmMime:response.headers.get('content-type'),wasmStatus:response.status,timeout:false};}await new Promise(resolve=>setTimeout(resolve,100));}return {timeout:true,errors:globalThis.__bundleErrors??[],ready:document.readyState,scripts:[...document.scripts].map(script=>script.src),href:location.href};})()`,{timeout:15000,label:`${label} bundled WASM consumer`});
  if(result.timeout)throw new Error(`Bundled ${label} consumer timed out: ${JSON.stringify(result)}`);if(result.error)throw new Error(result.error);assert.equal(result.bars,10000);assert.equal(result.created,result.terminated);assert.equal(result.wasmStatus,200);assert.equal(result.wasmMime,'application/wasm');return {status:'passed',label,browser:result,userAgent:await browser.send('Browser.getVersion',{},null)};
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
function browserFixtureText(){return `import {loadRustBackend,createRustChart} from '/node_modules/barochart/src/web/wasm/index.mjs';
const NativeWorker=globalThis.Worker;let created=0,terminated=0;globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);created++;this.closed=false;}terminate(){if(!this.closed){this.closed=true;terminated++;}return super.terminate();}};
(async()=>{try{const backend=await loadRustBackend(),session=await backend.createSession({count:10000}),host=document.createElement('div');host.style='width:640px;height:360px';document.body.append(host);const chart=await createRustChart(host,session,{renderer:'canvas',dpr:()=>1});await chart.flush();if(chart.lastScene.stats.storedBars!==10000)throw new Error('Rust package chart bar count mismatch');await chart.destroy({closeSession:true});if(created!==terminated)throw new Error('Rust package Worker leak');const response=await fetch(new URL('./node_modules/barochart/src/web/wasm/barochart-core.wasm',location.href));const wasmMime=response.headers.get('content-type');if(!response.ok||wasmMime!=='application/wasm')throw new Error('WASM response contract: '+response.status+' '+wasmMime);globalThis.__wasmConsumerResult={bars:10000,created,terminated,renderer:chart.rendererKind,wasmMime};}catch(error){globalThis.__wasmConsumerResult={error:{name:error.name,message:error.message}};}})();
`;}
function bundleEntryText(){return `import {loadRustBackend,createRustChart} from 'barochart/wasm';
import packagedWasmAsset from './node_modules/barochart/src/web/wasm/barochart-core.wasm';
export const packagedWasmURL=new URL(packagedWasmAsset,import.meta.url);
export const packagedWorkerURL=new URL('./worker-entry.js',import.meta.url);
const NativeWorker=globalThis.Worker;let created=0,terminated=0;globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);created++;this.closed=false;}terminate(){if(!this.closed){this.closed=true;terminated++;}return super.terminate();}};
export async function smoke(){const backend=await loadRustBackend({wasmURL:packagedWasmURL,workerURL:packagedWorkerURL});const session=await backend.createSession({count:10000});const host=document.createElement('div');host.style='width:640px;height:360px';document.body.append(host);const chart=await createRustChart(host,session,{renderer:'canvas',dpr:()=>1});await chart.flush();const bars=chart.lastScene.stats.storedBars;await chart.destroy({closeSession:true});if(bars!==10000||created!==terminated)throw new Error('bundled WASM Worker/bar count mismatch');return {bars,created,terminated,wasmURL:String(packagedWasmURL),workerURL:String(packagedWorkerURL)};}
`;}
function viteEntryText(){return `import {loadRustBackend,createRustChart} from 'barochart/wasm';
import packagedWorkerAsset from 'barochart/wasm-worker-entry?worker&url';
export const packagedWasmURL=new URL('./barochart-core.wasm',import.meta.url);
export const packagedWorkerURL=new URL(packagedWorkerAsset,import.meta.url);
const NativeWorker=globalThis.Worker;let created=0,terminated=0;globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);created++;this.closed=false;}terminate(){if(!this.closed){this.closed=true;terminated++;}return super.terminate();}};
export async function smoke(){const backend=await loadRustBackend({wasmURL:packagedWasmURL,workerURL:packagedWorkerURL});const session=await backend.createSession({count:10000});const host=document.createElement('div');host.style='width:640px;height:360px';document.body.append(host);const chart=await createRustChart(host,session,{renderer:'canvas',dpr:()=>1});await chart.flush();const bars=chart.lastScene.stats.storedBars;await chart.destroy({closeSession:true});if(bars!==10000||created!==terminated)throw new Error('Vite WASM chart Worker/bar count mismatch');return {bars,created,terminated,wasmURL:String(packagedWasmURL),workerURL:String(packagedWorkerURL)};}
if(typeof document!=='undefined')smoke().then(result=>globalThis.__bundleResult=result).catch(error=>globalThis.__bundleError=String(error?.stack??error));
`;}
async function main(){
 const report={schema:'barochart.wasm-package-consumer',version:1,timestamp:new Date().toISOString(),sourceRoot,workdir,network:'registry.npmjs.org public packages in project-only cache; no publication',node:process.version,platform:process.platform,arch:process.arch,commands:[]};
 try{const packed=await verifyTarball();await writeFixture(packed.consumer,'wasm-browser.mjs');
  // The browser fixture is intentionally a separate file from the Node SSR fixture.
  await writeFile(join(packed.consumer,'wasm-browser.mjs'),browserFixtureText());
  report.package=packed.package;report.asset=packed.asset;report.nodeConsumer=packed.node;report.types=packed.types;report.tools=await toolReport();report.sourceSnapshot=await sourceSnapshot();report.esbuild=await esbuildProof(packed.consumer);report.esbuildBrowser=values['skip-browser']?{status:'skipped',reason:'--skip-browser'}:await browserBundleProof(report.esbuild.outdir,report.esbuild.entryFile,'esbuild');report.vite=await viteProof(packed.consumer);report.viteBrowser=values['skip-browser']?{status:'skipped',reason:'--skip-browser'}:await browserBundleProof(report.vite.dist,report.vite.entryFile,'vite');report.browser=await browserProof(packed.consumer);
  const missing=[];for(const [name,value] of Object.entries({types:report.types,esbuild:report.esbuild,esbuildBrowser:report.esbuildBrowser,vite:report.vite,viteBrowser:report.viteBrowser,browser:report.browser}))if(value.status!=='passed')missing.push(`${name}: ${value.reason??value.status}`);
  if(missing.length&&!values['allow-missing-vite'])throw new Error(`WASM package consumer gates incomplete: ${missing.join('; ')}`);
  report.status=missing.length?'incomplete':'passed';report.gateNotes=missing;
 }catch(error){report.status='failed';report.error={name:error.name,message:error.message,stack:error.stack};throw error;}
 finally{report.commands=commands;const output=resolve(values.report??join(sourceRoot,'artifacts/web-rust-wasm/package-consumer-current.json'));await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,report:output,package:report.package,asset:report.asset,types:report.types,esbuild:report.esbuild?.status,vite:report.vite?.status,browser:report.browser?.status,error:report.error?.message},null,2));}
}
await main();
