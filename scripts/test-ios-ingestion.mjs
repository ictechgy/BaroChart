// Owned temporary Simulator only. Long execution requires coordinator QUIET GO.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateIOSIngestionEvidence,collectIOSProcessEvidence} from './ios-ingestion-contract.mjs';
const args=process.argv.slice(2),value=n=>{const i=args.indexOf(n);return i<0?null:args[i+1]},output=resolve(value('--output')??'/tmp/aster-cycle12-ios-build'),manifest=JSON.parse(await readFile(join(output,'build-manifest.json'),'utf8'));
const pilot=args.includes('--pilot'),seconds=Number(value('--seconds')??(pilot?60:900)),bars=Number(value('--bars')??(pilot?1024:100000)),warmup=pilot?2:30;
assert(pilot?seconds>=30&&seconds<=60:seconds===900);assert(Number.isInteger(bars)&&bars>=512&&bars<=100000);if(!pilot&&!args.includes('--quiet-go'))throw Error('900s run requires explicit coordinator --quiet-go');
const hash=b=>createHash('sha256').update(b).digest('hex'),appBinarySHA256=hash(await readFile(join(manifest.appPath,'Cycle12Apple'))),coreSHA256=hash(await readFile(join(manifest.appPath,'aster-core.js'))),validatorSHA256=hash(await readFile(new URL('./ios-ingestion-contract.mjs',import.meta.url)));assert.equal(appBinarySHA256,manifest.appBinarySHA256);assert.equal(coreSHA256,manifest.coreSHA256);
// A failed new run cannot retain a previous positive certificate. Completed
// evidence is immutable; use a fresh build/output for each execution.
try{await readFile(join(output,'acceptance.json'));throw Error('Existing acceptance: use a fresh output directory');}catch(error){if(error.code!=='ENOENT')throw error;}
async function run(command,params,{timeout=60000,optional=false}={}){let stdout='',stderr='';let pid;const status=await new Promise((done,reject)=>{const child=spawn(command,params,{stdio:['ignore','pipe','pipe']});pid=child.pid;const timer=setTimeout(()=>{stderr+='\nOWNED_CHILD_TIMEOUT';child.kill('SIGTERM')},timeout);child.stdout.on('data',v=>{stdout+=v});child.stderr.on('data',v=>{stderr+=v});child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',n=>{clearTimeout(timer);done(n)})});if(status!==0&&!optional)throw Error(command+' exit '+status+': '+stderr.slice(-8000));return{status,stdout:stdout.trim(),stderr:stderr.trim(),pid}}
const sim=(params,options)=>run('xcrun',['simctl',...params],options);let id,evidence,cleanupReport;const cleanup=[];
try{
 const runtime=process.env.ASTER_IOS_RUNTIME??JSON.parse((await sim(['list','runtimes','--json'])).stdout).runtimes.find(r=>r.isAvailable&&r.name.startsWith('iOS'))?.identifier;assert(runtime);
 id=(await sim(['create','Aster-cycle12-ingestion-'+Date.now(),process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',runtime])).stdout;assert(/^[a-f0-9-]{36}$/i.test(id));const ownedRun={id,runtime,createdByThisRun:true,pilot,seconds,bars};await writeFile(join(output,'owned-simulator.json'),JSON.stringify(ownedRun,null,2));
 await sim(['boot',id]);await sim(['bootstatus',id,'-b'],{timeout:180000});
 const config={CYCLE12_SECONDS:String(seconds),CYCLE12_BARS:String(bars),CYCLE12_WARMUP:String(warmup),...(pilot?{CYCLE12_FUNCTIONAL_PILOT:'1'}:{})},testRun=join(output,'owned.xctestrun');
 // Keep __TESTROOT__ pointing at the original products directory. Environment
 // goes to the XCTest runner; it forwards only these four values to the app.
 const patch=`import plistlib,json,sys\np=sys.argv[1];x=plistlib.load(open(p,'rb'));env=json.loads(sys.argv[2])\nfor k,v in x.items():\n if k.startswith('__'):continue\n if isinstance(v,dict):\n  for name in ['EnvironmentVariables','TestingEnvironmentVariables']:\n   v.setdefault(name,{}).update(env)\nplistlib.dump(x,open(sys.argv[3],'wb'))\n`;
 const envRun=join(manifest.xctestrunPath.substring(0,manifest.xctestrunPath.lastIndexOf('/')),'cycle12-owned.xctestrun');await run('python3',['-c',patch,manifest.xctestrunPath,JSON.stringify(config),envRun]);await writeFile(testRun,await readFile(envRun));
 const result=await run('xcodebuild',['test-without-building','-xctestrun',envRun,'-destination','id='+id,'-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-collect-test-diagnostics','never','-resultBundlePath',join(output,pilot?'pilot.xcresult':'pressure900.xcresult'),'-only-testing:Cycle12SystemTests/Cycle12SystemTests/testSystemInputWhileTwoSymbolsReceiveData'],{timeout:(seconds+warmup+420)*1000,optional:true});await writeFile(join(output,'xctest.log'),result.stdout+'\n'+result.stderr);
 const container=(await sim(['get_app_container',id,'dev.aster.cycle12.apple','data'])).stdout,rawReport=JSON.parse(await readFile(join(container,'Documents/cycle12-apple.json'),'utf8'));
 const report={...rawReport,simulatorID:id,runtime,pilot,xcodebuildStatus:result.status,coreSHA256:manifest.coreSHA256,originalUIKitSHA256:manifest.originalUIKitSHA256,instrumented:manifest.instrumented},serialized=JSON.stringify(report,null,2);
 await writeFile(join(output,'ios-ingestion.json'),serialized);
 const traces=[];for(const file of ['applied-symbol-0.bin','applied-symbol-1.bin']){const bytes=await readFile(join(container,'Documents',file));traces.push({file,bytes});await copyFile(join(container,'Documents',file),join(output,file));}
 evidence={report,reportSHA256:hash(serialized),manifest,run:ownedRun,xctest:{status:result.status,stdout:result.stdout,appBinarySHA256,coreSHA256},traces};
}finally{
 if(id&&/^[a-f0-9-]{36}$/i.test(id)){for(const operation of ['terminate','shutdown','delete']){const result=await sim(operation==='terminate'?[operation,id,'dev.aster.cycle12.apple']:[operation,id],{optional:true});cleanup.push({operation,status:result.status,stderr:result.stderr})}}
 const inventory=JSON.parse((await sim(['list','devices','--json'])).stdout),remaining=Object.values(inventory.devices).flat().some(v=>v.udid===id);let processQuery;try{processQuery=await run('/bin/ps',['-A','-o','pid=,command='],{optional:true});}catch(error){processQuery={status:null,stdout:'',stderr:String(error)};}cleanupReport={id:id??null,ownedOnly:true,cleanup,remaining,...collectIOSProcessEvidence(processQuery,id)};await writeFile(join(output,'simulator-cleanup.json'),JSON.stringify(cleanupReport,null,2));if(id){assert.equal(cleanup.find(v=>v.operation==='delete')?.status,0);assert.equal(remaining,false);assert.equal(cleanupReport.processQueryStatus,0,'Process query unavailable: cleanup is unverified');assert.equal(cleanupReport.ownedUUIDProcessCount,0)}
}

// No positive certificate precedes required data/UI proof and actual OS cleanup.
const verdict=validateIOSIngestionEvidence({...evidence,executionPolicy:'fresh',simulatorCleanup:cleanupReport});
await writeFile(join(output,'acceptance.json'),JSON.stringify({...verdict,actualOSInput:true,publicXCTest:true,seconds,bars,validatorSHA256,reportSHA256:evidence.reportSHA256},null,2));console.log(JSON.stringify({...verdict,id}));
