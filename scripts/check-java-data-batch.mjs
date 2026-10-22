// Optional actual JVM decoder run. Android/JNI/Engine/JSON containers are not executed.
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {JAVA_HOST_PRODUCTION_SOURCES,javaHostCompilerArguments} from './check-java-host.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function files(path){const result=[];for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.name.endsWith('.java'))result.push(p);}return result.sort();}
export async function checkJavaDataBatch({java=process.env.ASTER_JAVA??'java'}={}){
 const temporary=await mkdtemp(join(tmpdir(),'barochart-data-batch-'));
 try{
  const classes=join(temporary,'classes'),empty=join(temporary,'empty'),trace=join(temporary,'init.log');await mkdir(classes);await mkdir(empty);
  const sources=[...JAVA_HOST_PRODUCTION_SOURCES.map(p=>join(root,p)),...await files(join(root,'test/java-host-stubs')),...await files(join(root,'test/java-data-batch'))];
  const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async p=>[p.slice(root.length),createHash('sha256').update(await readFile(p)).digest('hex')])));const before=await hashes();
  const run=args=>{const r=spawnSync(java,args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});if(r.error||r.status!==0||r.stderr)throw new Error(`Java data batch check failed: ${r.error??r.status}\n${r.stdout}${r.stderr}`);return r.stdout;};
  run(javaHostCompilerArguments(classes,empty,sources));
  const stdout=run(['-ea',`-Djava.library.path=${empty}`,`-Xlog:class+init=info:file=${trace}`,'-cp',classes,'dev.aster.charts.DataBatchReceiptTest']);
  if(stdout.trim()!=='PASS checks=105 scope=production-data-batch-decoder-only')throw new Error(`Incomplete decoder evidence: ${stdout}`);
  const initialization=await readFile(trace,'utf8');if(/Initializing 'dev\/aster\/charts\/AsterEngine'/.test(initialization)||!initialization.includes("Initializing 'dev/aster/charts/AsterEngine$DataBatchReceipt'"))throw new Error('Unexpected Engine initialization');
  if(JSON.stringify(before)!==JSON.stringify(await hashes()))throw new Error('Changed compiler input');
  return {schema:'barochart.java-data-batch',checks:105,sourceSHA256:before,stdout,engineInitialized:false,androidSDK:false,JNI:false,jsonContainersExecuted:false,temporaryOutputRemoved:true};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await checkJavaDataBatch(),null,2));
