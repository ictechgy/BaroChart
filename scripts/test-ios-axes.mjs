// Own a temporary simulator; never unlock the host or change its automation settings.
import {spawnSync} from 'node:child_process';
import {readFile,copyFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const run=(args,{allowFailure=false}={})=>{
 const r=spawnSync('xcrun',['simctl',...args],{encoding:'utf8'});
 if(r.status!==0&&!allowFailure)throw new Error(r.stderr||`simctl ${args[0]} failed`);
 return r.stdout.trim();
};
const runtime=process.env.ASTER_IOS_RUNTIME??JSON.parse(run(['list','runtimes','--json'])).runtimes.find(r=>r.isAvailable&&r.name.startsWith('iOS'))?.identifier;
if(!runtime)throw new Error('No installed iOS simulator runtime');
let id;
try{
 id=run(['create',`Aster-axes-${Date.now()}`,process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',runtime]);
 if(!/^[A-F0-9-]{36}$/i.test(id))throw new Error('Invalid new device ID');
 run(['boot',id]);run(['bootstatus',id,'-b']);run(['install',id,'artifacts/AsterValidation.app']);
 run(['launch',id,'dev.aster.charts.validation','--axes-test']);
 const documents=join(run(['get_app_container',id,'dev.aster.charts.validation','data']),'Documents');
 let report;
 for(let i=0;i<120;i++){
  try{report=JSON.parse(await readFile(join(documents,'ios-axes-validation.json'),'utf8'));}catch{}
  if(report?.failed)throw new Error(report.error);
  if(report?.passed===22&&report.uiPassed===7&&report.shared?.passed===13&&report.asyncContextHandoff)break;
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(report?.passed!==22||report.uiPassed!==7||report.shared?.passed!==13||!report.asyncContextHandoff)throw new Error('iOS independent-axis verification did not finish');
 const bundled=await readFile('artifacts/AsterValidation.app/aster-core.js');
 await mkdir('benchmarks/results',{recursive:true});
 await writeFile('benchmarks/results/ios-axes-validation.json',JSON.stringify({...report,runtime,ownedTemporarySimulator:true,bundleSHA256:createHash('sha256').update(bundled).digest('hex')},null,2)+'\n');
 await copyFile(join(documents,'ios-native-axes.png'),'artifacts/ios-native-axes.png');
 console.log(JSON.stringify({nativeChecks:report.passed,uiChecks:report.uiPassed,sharedChecks:report.shared.passed,runtime,nativeUITouchInjected:report.nativeUITouchInjected,asyncContextHandoff:report.asyncContextHandoff}));
}finally{
 if(id&&/^[A-F0-9-]{36}$/i.test(id)){
  run(['terminate',id,'dev.aster.charts.validation'],{allowFailure:true});
  run(['shutdown',id],{allowFailure:true});run(['delete',id],{allowFailure:true});
 }
}
