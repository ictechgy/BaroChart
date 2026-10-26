import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);let sdk=root,out=join(root,'artifacts/layout-notifications');
for(let i=0;i<args.length;i++){if(args[i]==='--sdk')sdk=resolve(args[++i]);else if(args[i]==='--output')out=resolve(args[++i]);else throw new TypeError('Unknown layout notification argument');}
await mkdir(join(out,'module-cache'),{recursive:true});
await writeFile(join(out,'main.swift'),'import Foundation\nlet report=try verifyNativeLayoutNotifications(URL(fileURLWithPath:CommandLine.arguments[1]))\nlet data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])\nprint(String(data:data,encoding:.utf8)!)\nif report["failed"] as? Bool == true {exit(1)}\n');
const run=async(command,argv,log)=>{const result=spawnSync(command,argv,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});await writeFile(join(out,log),(result.stdout??'')+(result.stderr??''));if(result.error)throw result.error;return result;};
const sources=['AsterNative.swift','AsterColumns.swift','AsterFrameRenderer.swift'].map(name=>join(sdk,'native',name));
const compile=await run('swiftc',['-O','-warnings-as-errors','-module-cache-path',join(out,'module-cache'),...sources,join(root,'examples/native/layout-notification-verification.swift'),join(out,'main.swift'),'-o',join(out,'probe')],'build.log');
if(compile.status!==0)throw new Error('Layout observer compile failed: '+compile.stderr);
const bundle=join(sdk,'native/Resources/aster-core.js'),result=await run(join(out,'probe'),[bundle],'run.log'),report=JSON.parse(result.stdout),sha=data=>createHash('sha256').update(data).digest('hex');
report.sourceSHA256=Object.fromEntries(await Promise.all([...sources,bundle,join(root,'examples/native/layout-notification-verification.swift')].map(async path=>[path.startsWith(root)?path.slice(root.length+1):path,sha(await readFile(path))])));
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,output:out}));
process.exit(result.status??1);
