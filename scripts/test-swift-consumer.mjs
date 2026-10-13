import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const sourceRoot=resolve(import.meta.dirname,'..'),sdkFiles=['Package.swift','native/AsterNative.swift','native/AsterColumns.swift','native/AsterFrameRenderer.swift','native/AsterUIKit.swift','native/Resources/aster-core.js'];
async function fingerprint(root){const result={};for(const file of sdkFiles)result[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');return result;}
async function walk(root){const out=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())out.push(...await walk(path));else out.push(path);}return out;}
export async function testSwiftConsumer({sdk=sourceRoot,output=null,mode='all',baselineCore=false}={}){
 if(!['all','mac','ios'].includes(mode))throw new RangeError('Consumer mode all/mac/ios');sdk=resolve(sdk);
 const directory=output?resolve(output):await mkdtemp(join(tmpdir(),'aster-swift-consumer-'));await mkdir(join(directory,'logs'),{recursive:true});
 const report={timestamp:new Date().toISOString(),sdk,directory,mode,baselineCore,sdkBefore:await fingerprint(sdk),steps:[],method:'Independent copied consumer only; local SwiftPM product dependency. No SDK source in app target, no existing demo imports, no explicit app bundleURL. Functional builds/automated simulator input, no physical performance claim.'};let simulator;
 async function command(name,tool,args,{env={},allowFailure=false,timeout=180000}={}){
  console.error('Swift consumer: '+name);const log=join(directory,'logs',name+'.log'),stream=createWriteStream(log),started=Date.now();
  const result=await new Promise((done,reject)=>{let stdout='',stderr='';const child=spawn(tool,args,{cwd:directory,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(name+' timed out'));},timeout);child.stdout.on('data',data=>{stdout+=data;stream.write(data)});child.stderr.on('data',data=>{stderr+=data;stream.write(data)});child.on('error',error=>{clearTimeout(timer);stream.end();reject(error)});child.on('close',(code,signal)=>{clearTimeout(timer);stream.end();done({code,signal,stdout,stderr})});});
  report.steps.push({name,tool,args,code:result.code,log,elapsedMs:Date.now()-started});
  if(result.code!==0&&!allowFailure)throw new Error(name+' failed: '+(result.stderr||result.stdout).slice(-6000));return result;
 }
 try{
  const consumer=join(directory,'consumer');await cp(join(sourceRoot,'examples/swift-consumer'),consumer,{recursive:true,filter:path=>!['.build','.swiftpm'].includes(basename(path))});
  report.swift=(await command('swift-version','swift',['--version'])).stdout.trim();report.xcode=(await command('xcode-version','xcodebuild',['-version'])).stdout.trim();
  const manifest=JSON.parse((await command('sdk-manifest','swift',['package','--package-path',sdk,'--cache-path',join(directory,'manifest-cache'),'--config-path',join(directory,'manifest-config'),'--security-path',join(directory,'manifest-security'),'dump-package'])).stdout);assert.deepEqual(manifest.dependencies,[]);report.upstreamSwiftDependencies=0;
  const macFlags=['--package-path',consumer,'--scratch-path',join(directory,'mac-build'),'--cache-path',join(directory,'mac-cache'),'--config-path',join(directory,'mac-config'),'--security-path',join(directory,'mac-security')],swiftEnv={ASTER_NATIVE_PACKAGE_PATH:sdk};
  if(mode!=='ios'){
   await command('mac-build','swift',['build',...macFlags,'-Xswiftc','-warnings-as-errors','-Xswiftc','-module-cache-path','-Xswiftc',join(directory,'mac-modules'),...(baselineCore?[]:['-Xswiftc','-DASTER_SDK_LABEL_METADATA'])],{env:swiftEnv});
   const bin=(await command('mac-bin-path','swift',['build',...macFlags,'--show-bin-path'],{env:swiftEnv})).stdout.trim().split('\n').at(-1),executable=join(bin,'AsterSDKProbe');
   const resource=(await walk(bin)).filter(path=>basename(path)==='aster-core.js');assert.equal(resource.length,1);assert.equal(createHash('sha256').update(await readFile(resource[0])).digest('hex'),report.sdkBefore['native/Resources/aster-core.js']);report.macResource=resource[0];
   report.mac=JSON.parse((await command('mac-probe','/usr/bin/env',[executable])).stdout.trim().split('\n').at(-1));assert.ok(report.mac.passed>=10);
   const hidden=resource[0]+'.negative-test-disabled';await rename(resource[0],hidden);try{const negative=await command('mac-missing-resource','/usr/bin/env',[executable,'--expect-missing-resource']);assert.match(negative.stdout,/missing SwiftPM resource rejected/);report.missingResourceRejected=true;}finally{await rename(hidden,resource[0]);}
  }
  if(mode!=='mac'){
   const project=join(consumer,'iOS/AsterSDKConsumer.xcodeproj'),pbx=join(project,'project.pbxproj'),text=await readFile(pbx,'utf8');assert.ok(text.includes('relativePath = "../../..";'));let configured=text.replace('relativePath = "../../..";',`relativePath = ${JSON.stringify(sdk)};`);if(baselineCore)configured=configured.replaceAll('$(inherited) ASTER_SDK_EXPLICIT_VIEW_DISPOSE','$(inherited)');await writeFile(pbx,configured);
   // Scope the consumer feature flag to its App target. A global command-line
   // override would erase SwiftPM's SWIFT_PACKAGE condition in the SDK itself.
   const iosFlags=['-project',project,'-scheme','AsterSDKConsumer','-configuration','Debug','-derivedDataPath',join(directory,'ios-derived'),'-clonedSourcePackagesDirPath',join(directory,'ios-packages'),'-disableAutomaticPackageResolution','CODE_SIGNING_ALLOWED=NO','SWIFT_TREAT_WARNINGS_AS_ERRORS=YES'];
   await command('ios-build','xcodebuild',[...iosFlags,'-destination','generic/platform=iOS Simulator','build-for-testing'],{timeout:240000});
   const app=join(directory,'ios-derived/Build/Products/Debug-iphonesimulator/AsterSDKConsumer.app'),resources=(await walk(app)).filter(path=>basename(path)==='aster-core.js');assert.equal(resources.length,1);assert.ok(resources[0].includes('.bundle/'));assert.equal(createHash('sha256').update(await readFile(resources[0])).digest('hex'),report.sdkBefore['native/Resources/aster-core.js']);report.iosResource=resources[0];
   const runtimes=JSON.parse((await command('simulator-runtimes','xcrun',['simctl','list','runtimes','--json'])).stdout).runtimes,runtime=process.env.ASTER_IOS_RUNTIME??runtimes.find(r=>r.isAvailable&&r.name==='iOS 27.0')?.identifier;if(!runtime)throw Error('Installed iOS runtime required; nothing downloaded');report.runtime=runtime;
   simulator=(await command('simulator-create','xcrun',['simctl','create','Aster-SDK-consumer-'+Date.now(),process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',runtime])).stdout.trim();assert.match(simulator,/^[A-F0-9-]{36}$/i);report.ownedSimulator=simulator;
   await command('simulator-boot','xcrun',['simctl','boot',simulator]);await command('simulator-bootstatus','xcrun',['simctl','bootstatus',simulator,'-b']);
   await command('simulator-install','xcrun',['simctl','install',simulator,app]);await command('simulator-launch','xcrun',['simctl','launch',simulator,'dev.aster.sdkconsumer.ios']);
   await command('ios-xcui','xcodebuild',[...iosFlags,'-destination','id='+simulator,'-parallel-testing-enabled','NO','-resultBundlePath',join(directory,'ios.xcresult'),'test-without-building'],{timeout:240000});
   await command('ios-attachments','xcrun',['xcresulttool','export','attachments','--path',join(directory,'ios.xcresult'),'--output-path',join(directory,'ios-attachments')]);
   const data=(await command('simulator-data','xcrun',['simctl','get_app_container',simulator,'dev.aster.sdkconsumer.ios','data'])).stdout.trim();report.ios=JSON.parse(await readFile(join(data,'Documents/sdk-validation.json'),'utf8'));assert.ok(report.ios.passed>=10);assert.ok(report.ios.interactionCallbacks>0);assert.equal(report.ios.borrowedEngineClosedByView,false);assert.equal(report.ios.sourceCopyDemoImport,false);
   await command('simulator-screenshot','xcrun',['simctl','io',simulator,'screenshot',join(directory,'ios-consumer.png')]);report.explicitViewDispose=!baselineCore;
  }
  report.sdkAfter=await fingerprint(sdk);assert.deepEqual(report.sdkAfter,report.sdkBefore,'SDK changed while consumer matrix was running');report.status='passed';
 }catch(error){report.status='failed';report.error=error.message;throw error;}
 finally{
  if(simulator&&/^[A-F0-9-]{36}$/i.test(simulator)){
   await command('simulator-terminate','xcrun',['simctl','terminate',simulator,'dev.aster.sdkconsumer.ios'],{allowFailure:true});await command('simulator-shutdown','xcrun',['simctl','shutdown',simulator],{allowFailure:true});const deleted=await command('simulator-delete','xcrun',['simctl','delete',simulator],{allowFailure:true});report.ownedSimulatorDeleted=deleted.code===0;if(deleted.code!==0){report.status='failed';report.cleanupError='Owned simulator deletion failed';}
  }
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.error('Swift consumer report: '+join(directory,'report.json'));
 }
 if(report.status!=='passed')throw Error(report.error??report.cleanupError);return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2),read=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1]};try{const report=await testSwiftConsumer({sdk:read('--sdk'),output:read('--output'),mode:read('--mode')??'all',baselineCore:args.includes('--baseline-core')});console.log(JSON.stringify({status:report.status,directory:report.directory,macChecks:report.mac?.passed,iosChecks:report.ios?.passed,ownedSimulatorDeleted:report.ownedSimulatorDeleted}));}catch(error){console.error(error.message);process.exitCode=1;}}
