// Functional only. Never generates core assets or runs a comparative benchmark.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]},output=resolve(value('--output')??'/tmp/aster-cycle12-native-functional'),core=resolve(value('--core')??'native/Resources/aster-core.js');
const closed=args.includes('--closed-ring'),files=closed?['native/AsterNative.swift','native/AsterColumns.swift','examples/native/cycle12/ClosedIngestionCLI.swift']:['native/AsterNative.swift','native/AsterColumns.swift','examples/native/ingestion-verification.swift','examples/native/cycle12/IngestionCLI.swift'];await mkdir(output,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),hashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,digest(await readFile(f))]))),coreSHA256=digest(await readFile(core));
async function run(name,command,parameters){const log=join(output,name+'.log');let body='';const code=await new Promise((done,reject)=>{const child=spawn(command,parameters,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>{body+=v});child.stderr.on('data',v=>{body+=v});child.on('error',reject);child.on('close',done)});await writeFile(log,body);if(code!==0)throw Error(name+' exit '+code+'; '+log);}
const binary=join(output,'ingestion-cli'),reportPath=join(output,closed?'native-closed-ingestion.json':'native-ingestion.json');
await run('build','swiftc',['-O','-warnings-as-errors','-module-cache-path',join(output,'module-cache'),...files,'-o',binary]);
if(!args.includes('--build-only'))await run('run',binary,[core,reportPath,...['--sync','--async','--codec'].filter(v=>args.includes(v))]);
for(const f of files)if(digest(await readFile(f))!==hashes[f])throw Error('Source changed during functional run: '+f);if(digest(await readFile(core))!==coreSHA256)throw Error('Core changed during functional run');
const proof={schema:'aster.cycle12.native-functional.build',core,coreSHA256,sources:hashes,binarySHA256:digest(await readFile(binary)),buildOnly:args.includes('--build-only'),comparativeTiming:false,simulator:false};await writeFile(join(output,'build-manifest.json'),JSON.stringify(proof,null,2));
if(!proof.buildOnly){const r=JSON.parse(await readFile(reportPath,'utf8'));console.log(JSON.stringify({passed:closed?r.passed:true,closedRing:closed,ingestion:r.ingestion?.passed,codecs:r.codecs?.passed,async:r.async?.passed,coreSHA256,output}));}else{console.log(JSON.stringify(proof));}
