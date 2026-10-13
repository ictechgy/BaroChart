import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {cpus,release,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const SHA_BASELINE='4d601b4a413887ade500a3e9c5606c295aadd29291fe1670f853e4ed348e8df3';
const ROOT=resolve(import.meta.dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const option=(name,fallback)=>{const key='--'+name,inline=process.argv.find(s=>s.startsWith(key+'=')),i=process.argv.indexOf(key);return inline?inline.slice(key.length+1):i<0?fallback:process.argv[i+1];};
const SDK=['native/AsterNative.swift','native/AsterColumns.swift','native/AsterFrameRenderer.swift'];
const RESOURCE='native/Resources/aster-core.js';
const PROVENANCE=[...SDK,RESOURCE,'native/AsterUIKit.swift','examples/native/bridge.mjs'];
async function hashes(root){return Object.fromEntries(await Promise.all(PROVENANCE.map(async p=>[p,sha(await readFile(join(root,p)))])));}
function stats(a){const s=[...a].sort((a,b)=>a-b);return {samples:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.min(s.length-1,Math.floor(s.length*.95))],max:s.at(-1)};}

// Preparation is explicitly separate from measurement. Original SDK files and
// original JS resource are copied unchanged; no cycle10 Swift or bundle probes.
async function prepare({baseline,candidate,output,expected,harness}){
 const sources={};assert.ok(baseline,'--baseline PATH required');assert.match(expected??'',/^[a-f0-9]{64}$/,'Root-frozen candidate-core-sha required');
 for(const version of ['baseline','candidate']){
  const input=version==='baseline'?baseline:candidate,sourceHashes=await hashes(input),wanted=version==='baseline'?SHA_BASELINE:expected;
  assert.equal(sourceHashes[RESOURCE],wanted,version+' resource SHA mismatch');
  if(version==='candidate')assert.ok((await readFile(join(input,RESOURCE),'utf8')).includes('nativeAccessibilityText'), 'Frozen candidate lacks production text helper; do not substitute generated working source');
  const folder=join(output,version+'-'+wanted.slice(0,12));await mkdir(folder,{recursive:true});
  for(const p of PROVENANCE){await mkdir(dirname(join(folder,p)),{recursive:true});await copyFile(join(input,p),join(folder,p));}
  assert.deepEqual(await hashes(folder),sourceHashes,'Snapshot copy drift');
  const binary=join(folder,'readout'),cache=join(folder,'module-cache');await mkdir(cache,{recursive:true});
  const flags=['-O','-warnings-as-errors','-module-cache-path',cache,...SDK.map(p=>join(folder,p)),harness,'-o',binary];
  const compiled=spawnSync('swiftc',flags,{encoding:'utf8',maxBuffer:8*1024*1024});await writeFile(join(folder,'compile.log'),compiled.stdout+compiled.stderr);
  assert.equal(compiled.status,0,version+' original SDK compile failed: '+compiled.stderr);
  sources[version]={inputRoot:input,snapshotRoot:folder,sourceHashes,resource:join(folder,RESOURCE),binary,binarySHA256:sha(await readFile(binary)),compileExit:compiled.status,compilerFlags:flags};
 }
 const version=spawnSync('swiftc',['--version'],{encoding:'utf8'});assert.equal(version.status,0);
 const manifest={schema:'aster.cycle11.native-readout-prepared',timestamp:new Date().toISOString(),baselineCommit:'dc06b4ba8448a30574c924cb93d28ef5d01eeb02',sources,harness,harnessSHA256:sha(await readFile(harness)),driverSHA256:sha(await readFile(import.meta.filename)),swift:version.stdout.trim(),environment:{node:process.version,platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0]?.model},fixture:{bars:100000,seed:42,candle:1,externalLines:[1,32],ranges:['recent200','full100k'],css:[1200,700],warmup:15,samples:60,pairs:3,order:['AB','BA','AB'],timed:'JSC + Foundation production UIKit value consumption; no raster/View/FPS'},measurementRan:false};
 await writeFile(join(output,'prepared.json'),JSON.stringify(manifest,null,2));return manifest;
}
async function run(output){
 const prepared=JSON.parse(await readFile(join(output,'prepared.json')));assert.equal(sha(await readFile(prepared.harness)),prepared.harnessSHA256,'Harness changed since prepare');assert.equal(sha(await readFile(import.meta.filename)),prepared.driverSHA256,'Driver changed since prepare');
 for(const source of Object.values(prepared.sources)){assert.deepEqual(await hashes(source.inputRoot),source.sourceHashes,'Current source differs from freeze');assert.deepEqual(await hashes(source.snapshotRoot),source.sourceHashes,'Copied source differs');assert.equal(sha(await readFile(source.binary)),source.binarySHA256,'Prepared executable changed');}
 const folder=join(output,'results');await mkdir(folder,{recursive:true});const runs=[],orders=[['baseline','candidate'],['candidate','baseline'],['baseline','candidate']];
 for(let pair=0;pair<orders.length;pair++)for(const version of orders[pair]){
  const source=prepared.sources[version],file=join(folder,`pair${pair+1}-${version}.json`),mode=version==='baseline'?'legacy':'text';console.log(`Serial native readout pair ${pair+1} ${version}`);
  const processResult=spawnSync(source.binary,[source.resource,file,mode,'--isolated'],{stdio:'inherit'});runs.push({pair:pair+1,version,file,exit:processResult.status});
  if(processResult.status!==0){await writeFile(join(folder,'runs.json'),JSON.stringify({runs,failure:'Child failed; partial raw JSON retained'},null,2));throw new Error('Native runtime fixture failed: '+file);}
  const report=JSON.parse(await readFile(file));assert.equal(report.resourceSHA256,source.sourceHashes[RESOURCE]);assert.equal(report.cases.length,4);report.provenance={pair:pair+1,version,source,harnessSHA256:prepared.harnessSHA256,driverSHA256:prepared.driverSHA256,swift:prepared.swift};await writeFile(file,JSON.stringify(report,null,2));
 }
 const reports=await Promise.all(runs.map(async r=>({...r,report:JSON.parse(await readFile(r.file))}))),rows=[];
 for(let pair=1;pair<=3;pair++){
  const a=reports.find(r=>r.pair===pair&&r.version==='baseline').report,b=reports.find(r=>r.pair===pair&&r.version==='candidate').report;
  for(const old of a.cases){const current=b.cases.find(c=>c.lines===old.lines&&c.range===old.range);assert.deepEqual(current.everyHoverValueSHA256,old.everyHoverValueSHA256,'Every warm+measured hover preserves exact UIKit value bytes');assert.deepEqual(current.proof,old.proof,'Same data vectors/raw/view/document/public crosshair');}
 }
 for(const lines of [1,32])for(const range of ['recent200','full100k']){
  const pooled={},perProcess={};for(const version of ['baseline','candidate']){
   const cases=reports.filter(r=>r.version===version).map(r=>({pair:r.pair,case:r.report.cases.find(c=>c.lines===lines&&c.range===range)}));
   for(const {case:c} of cases){assert.equal(c.raw.length,60);assert.equal(c.everyHoverValueSHA256.length,75);assert.equal(c.coreListenerLedgerAfterExplicitDispose,0);assert.equal(c.hostObserversAfterClose,0);assert.equal(c.hostFrameCleanupAfterClose,0);assert.equal(c.measuredBaseRedraws,0);assert.equal(c.weakEngineNilAfterScope,true);assert.equal(c.closedCallRejected,true);}
   pooled[version]=Object.fromEntries(['jsUs','hostConsumptionUs','hostAssemblyUs','totalUs'].map(k=>[k,stats(cases.flatMap(({case:c})=>c.raw.map(s=>s[k])))]));perProcess[version]=cases.map(({pair,case:c})=>({pair,summary:c.summary,memoryResidentBytes:c.memoryResidentBytes,cleanup:{coreListenerLedgerAfterExplicitDispose:c.coreListenerLedgerAfterExplicitDispose,hostObserversAfterClose:c.hostObserversAfterClose,hostFrameCleanupAfterClose:c.hostFrameCleanupAfterClose,weakEngineNilAfterScope:c.weakEngineNilAfterScope}}));
  }rows.push({lines,range,pooledMicroseconds:pooled,perFreshProcess:perProcess});
 }
 await writeFile(join(folder,'runs.json'),JSON.stringify({schema:'aster.cycle11.native-readout-runs',timestamp:new Date().toISOString(),runs,exactEveryHoverValueAndDataEquality:true},null,2));await writeFile(join(folder,'summary.json'),JSON.stringify({schema:'aster.cycle11.native-readout-summary',rows,exactEveryHoverValueAndDataEquality:true,scope:'180samples/version/condition from3serial fresh processes; JSC/Foundation old production UIKit value vs new text.toString only. Source/SDK compile, injected pointer/frame prep, proof/oracle/memory capture excluded from timer. Explicit core model disposal is distinguished from Engine.close; private Map/whole VM/RSS peak/physical FPS are not inferred.'},null,2));console.log(join(folder,'summary.json'));
}
export async function main(){const baselineArg=option('baseline'),baseline=baselineArg?resolve(baselineArg):undefined,candidate=resolve(option('candidate',ROOT)),output=resolve(option('output',join(tmpdir(),'aster-cycle11-native-readout'))),expected=option('candidate-core-sha'),harness=join(ROOT,'benchmarks/cycle11-native-readout.swift'),preparing=process.argv.includes('--prepare'),approved=process.argv.includes('--isolated');
 if(!preparing&&!approved){console.log(JSON.stringify({measurementRan:false,buildRan:false,awaiting:'Final source freeze and ROOT quietGO',baseline,candidate,output,commands:{prepare:'--prepare --baseline PATH --candidate PATH --output PATH --candidate-core-sha SHA',measure:'--isolated --output PATH'},harness,boundary:'Old Foundation UIKit value assembly vs new text.toString. No raster/View/FPS.'},null,2));return;}
 await mkdir(output,{recursive:true});if(preparing){await prepare({baseline,candidate,output,expected,harness});console.log(join(output,'prepared.json'));}if(approved)await run(output);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
