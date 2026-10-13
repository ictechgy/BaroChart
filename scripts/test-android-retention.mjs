import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';

const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk');
const serial=process.env.ASTER_ANDROID_SERIAL;
if(!serial)throw new Error('Explicit ASTER_ANDROID_SERIAL required');
const option=(name,fallback)=>{const index=process.argv.indexOf(name);if(index<0)return fallback;if(!process.argv[index+1]||process.argv[index+1].startsWith('--'))throw new Error(`${name} requires a value`);return process.argv[index+1];};
const apk=option('--apk','artifacts/android/aster-native.apk');
const output=option('--output','benchmarks/results/android-retention-validation.json');
const expectRetained=process.argv.includes('--expect-retained');
const adb=(args,optional=false)=>{const result=spawnSync(join(sdk,'platform-tools/adb'),['-s',serial,...args],{encoding:'utf8'});if(result.status&&!optional)throw new Error(result.stderr||result.stdout);return result.stdout;};
const api=Number(adb(['shell','getprop','ro.build.version.sdk']).trim());
const abi=adb(['shell','getprop','ro.product.cpu.abi']).trim();
if(api!==36||abi!=='arm64-v8a')throw new Error(`Retention fixture requires API36 arm64-v8a; selected ${api} ${abi}`);
adb(['shell','am','force-stop','dev.aster.charts.demo']);
adb(['install','-r',apk]);
adb(['shell','run-as','dev.aster.charts.demo','rm','-f','files/android-retention-validation.json']);
adb(['shell','am','start','-n','dev.aster.charts.demo/dev.aster.charts.DemoActivity','--ez','retention-test','true']);
let report;
for(let attempt=0;attempt<120;attempt++){
    try{report=JSON.parse(adb(['exec-out','run-as','dev.aster.charts.demo','cat','files/android-retention-validation.json'],true));break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
}
report??={failed:true,error:'No Android retention report within60seconds'};
report.execution={serial,api,abi,apk,expectRetained};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
if(expectRetained){
    if(!report.failed||report.retainedTerminalHandles!==11||!report.rows?.some(row=>row.terminalFieldsNull?.listener===false&&row.weakCleared?.listener===false))throw new Error('Frozen retention regression was not reproduced');
    if(report.rows.some(row=>row.terminalCount!==1||row.progressAfterTerminal!==0||row.result?.status!==row.expectedStatus)||report.nativeHandles?.processLiveNativeHandles!==1||report.activityAttachments!==2||!report.originalActivityDestroyed)throw new Error('Frozen probe failed outside the intended Java retention regression');
}else if(report.failed||report.retainedTerminalHandles!==11||report.rows?.length!==11||!report.originalActivityCollected)throw new Error(report.error??`Retention verification failed: ${report.failures?.join('; ')}`);
console.log(JSON.stringify({passed:report.passed,failed:report.failed,retainedTerminalHandles:report.retainedTerminalHandles,api,abi,serial,output,expectRetained}));
