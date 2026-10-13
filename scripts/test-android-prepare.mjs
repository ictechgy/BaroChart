import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';import {homedir} from 'node:os';
const sdk=process.env.ANDROID_SDK_ROOT??join(homedir(),'Library/Android/sdk'),serial=process.env.ASTER_ANDROID_SERIAL;if(!serial)throw new Error('Explicit owned ASTER_ANDROID_SERIAL required');
const adb=(args,optional=false)=>{const r=spawnSync(join(sdk,'platform-tools/adb'),['-s',serial,...args],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status&&!optional)throw new Error(r.stderr);return r.stdout;};
const bench=process.argv.includes('--bench'),soak=process.argv.includes('--soak');if(bench&&soak)throw new Error('Select bench or soak');const mode=soak?'soak':bench?'prepare-bench':'prepare-test',file=soak?'android-soak-validation.json':bench?'android-prepare-benchmark.json':'android-prepare-validation.json';
const duration=Number(process.env.ASTER_SOAK_MS??180000),events=[];assert(Number.isSafeInteger(duration)&&duration>=180000&&duration<=900000);
adb(['shell','am','force-stop','dev.aster.charts.demo']);adb(['install','-r','artifacts/android/aster-native.apk']);adb(['shell','run-as','dev.aster.charts.demo','rm','-f','files/'+file]);
adb(['shell','am','start','-n','dev.aster.charts.demo/dev.aster.charts.DemoActivity','--ez',soak?'soak-test':mode,'true',...(bench?['--ei','prepare-bars',process.env.ASTER_PREPARE_BARS??'1000000']:[]),...(soak?['--el','soak-duration',String(duration)]:[])]);
let report;const started=Date.now(),done=new Set(),drive=(id,args)=>{if(done.has(id))return;adb(args);done.add(id);events.push({elapsedMs:Date.now()-started,action:id});};
try{while(Date.now()-started<(soak?duration+45000:bench?360000:240000)){
 const elapsed=Date.now()-started;
 if(soak){if(elapsed>=30000)drive('background-home',['shell','input','keyevent','KEYCODE_HOME']);if(elapsed>=34000)drive('foreground',['shell','am','start','-n','dev.aster.charts.demo/dev.aster.charts.DemoActivity','-f','0x20000000']);if(elapsed>=65000)drive('actual-activity-recreate',['shell','am','start','-n','dev.aster.charts.demo/dev.aster.charts.DemoActivity','-f','0x20000000','--ez','soak-recreate','true']);if(elapsed>=100000)drive('owned-emulator-resize',['shell','wm','size','720x1280']);if(elapsed>=110000)drive('owned-emulator-size-reset',['shell','wm','size','reset']);}
 try{report=JSON.parse(adb(['exec-out','run-as','dev.aster.charts.demo','cat','files/'+file],true));break;}catch{}
 await new Promise(r=>setTimeout(r,500));
}
if(!report)throw new Error('No completed '+mode+' report');await writeFile('benchmarks/results/'+file,JSON.stringify({...report,serial,runnerLifecycleEvents:events},null,2)+'\n');assert(!report.failed&&report.passed>0,report.error??'Native verification failed');
if(soak){assert.equal(report.status,'completed');assert(report.elapsedMs>=duration);assert(report.generations>=2);for(const kind of ['pause','stop','resume','requested-recreate'])assert(report.events.some(e=>e.event===kind),'Missing actual lifecycle '+kind);assert(report.chartSourcesCreated===report.chartSourcesClosed);assert.equal(report.processRuntimeAfterSourceClose.processLiveNativeHandles,1);}
console.log(JSON.stringify({passed:report.passed,mode,serial,elapsedMs:report.elapsedMs,checks:report.checks?.length}));
}finally{if(soak){adb(['shell','wm','size','reset'],true);adb(['shell','am','force-stop','dev.aster.charts.demo'],true);}}
