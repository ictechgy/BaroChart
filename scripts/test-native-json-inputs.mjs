import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
let sdk=root,out=await mkdtemp(join(tmpdir(),'aster-native-json-inputs-'));
for(let i=0;i<args.length;i++){
 if(args[i]==='--sdk')sdk=resolve(args[++i]);
 else if(args[i]==='--output')out=resolve(args[++i]);
 else throw new TypeError('Unknown native JSON input argument');
}
const moduleCache=join(out,'module-cache');
const main=join(out,'main.swift');
await mkdir(moduleCache,{recursive:true});
await writeFile(main,'import Foundation\nlet report=try verifyNativeJSONInputs(URL(fileURLWithPath:CommandLine.arguments[1]))\nlet data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])\nprint(String(data:data,encoding:.utf8)!)\nif report["failed"] as? Bool == true {exit(1)}\n');
const run=async(command,argv,log)=>{const result=spawnSync(command,argv,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});await writeFile(join(out,log),(result.stdout??'')+(result.stderr??''));if(result.error)throw result.error;return result;};
const sources=['AsterNative.swift','AsterColumns.swift','AsterFrameRenderer.swift'].map(name=>join(sdk,'native',name));
const compile=await run('swiftc',['-O','-warnings-as-errors','-module-cache-path',moduleCache,...sources,join(root,'examples/native/json-input-verification.swift'),main,'-o',join(out,'probe')],'build.log');
if(compile.status!==0)throw new Error('Native JSON input compile failed; see '+join(out,'build.log'));
const result=await run(join(out,'probe'),[join(sdk,'native/Resources/aster-core.js')],'run.log');
if(result.status!==0)throw new Error(`Native JSON input probe failed with status ${result.status}; see ${join(out,'run.log')}`);
const report=JSON.parse(result.stdout);
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,output:out}));
process.exit(report.failed?1:0);
