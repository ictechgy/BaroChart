import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.env.ASTER_APPLE_BUILD??'artifacts/apple-transactions'),binary=join(output,'aster-transactions');
const manifest=JSON.parse(await readFile(join(output,'build-manifest.json'),'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
assert.equal(digest(await readFile(join(output,'aster-core.js'))),manifest.coreSHA256);
assert.equal(digest(await readFile(binary)),manifest.macBinarySHA256);
const red=process.argv.includes('--expect-failure'),macOnly=process.argv.includes('--mac-only'),iosOnly=process.argv.includes('--ios-only');
if(red&&(!macOnly||iosOnly))throw new Error('Expected-failure reproduction is mac-only');
const cases=['public rebind','missing binding','invalid anchor','invalid style','invalid type','rollback-only axis reference','affected projections','external viewport','external style','independent add','missing delete','tentative creation','low-level binding change','explicit manual group','unrelated target','comparison demo target'];
function verify(report,controls){
 assert(!report.failed,report.error);assert.equal(report.passed,report.checks.length);assert(report.passed>=75);
 for(const label of ['unreferenced B width','unreferenced B side','unreferenced B visibility','unreferenced B removal','new axis addition','other panel axis visibility'])assert(report.checks.includes(label+' preserves same pointer raw time/price'));
 assert.deepEqual(report.cases,cases);assert.equal(report.commonAPI.passed,13);assert.equal(report.legacyAxes.passed,22);assert.equal(report.legacyAxes.shared.passed,13);assert(report.legacyAxes.asyncContextHandoff&&report.engineClosed);
 assert.equal(report.source.coreSHA256,manifest.coreSHA256);assert.equal(report.nativeUITouchInjected,false);assert.equal(report.physicalDevice,false);
 if(controls){assert.equal(report.controls.passed,4);assert.equal(report.controls.uiControlActions,true);}
}
if(!iosOnly){for(const headless of [true,false]){
 const name=headless?'native-transactions':'native-transactions-ui',r=spawnSync(binary,[output,...(headless?['--headless']:[])],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 await writeFile(join(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 const report=JSON.parse(await readFile(join(output,name+'.json'),'utf8'));
 if(red){assert.notEqual(r.status,0);assert(report.failed&&report.error.includes('valid A3000 to B50 rebind'),report.error);}
 else{assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));verify(report,!headless);}
}}
if(red){const r=spawnSync(binary,[output,'--demo-target-only'],{encoding:'utf8',timeout:60000});await writeFile(join(output,'native-demo-target.log'),(r.stdout??'')+(r.stderr??''));const report=JSON.parse(await readFile(join(output,'native-demo-target.json'),'utf8'));assert.notEqual(r.status,0);assert(report.failed&&report.error.includes('comparison helper removes B without replacing C target'),report.error);}
let simulatorID,cleanup=[];
const sim=(args,optional=false)=>{const r=spawnSync('xcrun',['simctl',...args],{encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0&&!optional)throw new Error(r.stderr||`simctl ${args[0]} failed`);return {status:r.status,stdout:r.stdout.trim(),stderr:r.stderr.trim()};};
if(!macOnly){try{
 const app=join(output,'TransactionValidation.app');assert.equal(digest(await readFile(join(app,'aster-core.js'))),manifest.coreSHA256);assert.equal(digest(await readFile(join(app,'TransactionValidation'))),manifest.iosBinarySHA256);
 const runtimes=JSON.parse(sim(['list','runtimes','--json']).stdout).runtimes,runtime=process.env.ASTER_IOS_RUNTIME??runtimes.find(r=>r.isAvailable&&r.name.startsWith('iOS'))?.identifier;
 assert(runtime,'Installed iOS simulator runtime required');
 simulatorID=sim(['create',`Aster-transactions-${Date.now()}`,process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',runtime]).stdout;
 assert(/^[A-F0-9-]{36}$/i.test(simulatorID),'Unexpected owned simulator ID');
 await writeFile(join(output,'owned-simulator.json'),JSON.stringify({simulatorID,runtime,createdByThisRun:true},null,2)+'\n');
 sim(['boot',simulatorID]);sim(['bootstatus',simulatorID,'-b']);sim(['install',simulatorID,app]);sim(['launch',simulatorID,'dev.aster.charts.transactions']);
 const documents=join(sim(['get_app_container',simulatorID,'dev.aster.charts.transactions','data']).stdout,'Documents');let report;
 for(let i=0;i<120;i++){try{report=JSON.parse(await readFile(join(documents,'ios-transactions.json'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,500));}
 assert(report,'UIKit acceptance did not finish');await writeFile(join(output,'ios-transactions.json'),JSON.stringify({...report,runtime,ownedTemporarySimulator:true},null,2)+'\n');verify(report,true);
 await copyFile(join(documents,'ios-transactions.png'),join(output,'ios-transactions.png'));
}finally{
 if(simulatorID&&/^[A-F0-9-]{36}$/i.test(simulatorID)){for(const args of [['terminate',simulatorID,'dev.aster.charts.transactions'],['shutdown',simulatorID],['delete',simulatorID]]){const result=sim(args,true);cleanup.push({operation:args[0],status:result.status,stderr:result.stderr});}}
 await writeFile(join(output,'simulator-cleanup.json'),JSON.stringify({simulatorID:simulatorID??null,cleanup,ownedOnly:true},null,2)+'\n');
 if(simulatorID)assert(cleanup.find(r=>r.operation==='delete')?.status===0,'Owned simulator deletion failed; see simulator-cleanup.json');
}}
console.log(JSON.stringify({passed:true,red,macOnly,iosOnly,coreSHA256:manifest.coreSHA256,simulatorID:simulatorID??null}));
