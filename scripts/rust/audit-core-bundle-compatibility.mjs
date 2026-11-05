// One-time-compatible bundle provenance audit. This compares the frozen
// JavaScript oracle calls; it never regenerates Rust/JS expected outcomes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

import {parseLossless,stringifyLossless} from '../trace/bcjson.mjs';
import {readScenarios} from './core-conformance.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const DEFAULT_BASELINE='e530a5f';
const DEFAULT_OUTPUT=resolve(ROOT,'docs/measurements/core-bundle-compatibility.json');
const BUNDLE_PATH='native/Resources/aster-core.js';
const MANIFEST_PATH=resolve(ROOT,'test/fixtures/rust-core-vectors/manifest.json');
const sha256=value=>createHash('sha256').update(value).digest('hex');

const MATERIALIZE=`globalThis.__bcMaterialize=function build(node){
 const tag=node[0],value=node[1];
 if(tag==='u')return undefined;if(tag==='z')return null;if(tag==='n')return Number(value);
 if(tag==='b'||tag==='s')return value;if(tag==='a')return value.map(build);
 const object={};for(const [key,child] of value)Object.defineProperty(object,key,{value:build(child),writable:true,enumerable:true,configurable:true});return object;
};`;

function dataTree(value){
 if(value===undefined)return['u'];if(value===null)return['z'];
 if(typeof value==='number')return['n',Object.is(value,-0)?'-0':String(value)];
 if(typeof value==='string')return['s',value];if(typeof value==='boolean')return['b',value];
 if(Array.isArray(value))return['a',value.map(dataTree)];
 assert.equal(Object.getPrototypeOf(value),Object.prototype,'oracle arguments must be plain data');
 return['o',Object.keys(value).map(key=>[key,dataTree(value[key])])];
}

function oracle(source,label){
 const context=vm.createContext({Intl});
 vm.runInContext(source,context,{timeout:5_000,filename:label});
 vm.runInContext(MATERIALIZE,context,{timeout:1_000,filename:'materialize.mjs'});
 return{
  call(name,args){
   const callable=context[name];if(typeof callable!=='function')return{status:'missing'};
   const tree=JSON.stringify(dataTree(args));
   const realmArgs=vm.runInContext(`__bcMaterialize(JSON.parse(${JSON.stringify(tree)}))`,context,{timeout:1_000});
   try{return{status:0,value:Reflect.apply(callable,context,realmArgs)}}
   catch(error){return{status:error.name==='UnavailableError'?2:1,error:{name:error.name,message:error.message,code:error.code??null}}}
  },
 };
}

function outcomeText(outcome){
 return stringifyLossless(outcome.status===0?{status:0,value:outcome.value}:{status:outcome.status,error:outcome.error});
}

function argument(name,args){const at=args.indexOf(name);return at<0?null:args[at+1];}

export async function audit({baselineRef=DEFAULT_BASELINE,output=DEFAULT_OUTPUT,write=true}={}){
 assert.equal(process.versions.node?.split('.')[0],'22','Bundle compatibility audit requires pinned Node 22');
 const baseline=spawnSync('git',['show',`${baselineRef}:${BUNDLE_PATH}`],{cwd:ROOT,encoding:'utf8',maxBuffer:64*1024*1024});
 if(baseline.status!==0)throw new Error(`Could not read baseline bundle ${baselineRef}: ${baseline.stderr.trim()}`);
 const current=await readFile(resolve(ROOT,BUNDLE_PATH),'utf8');
 const scenarios=await readScenarios(),manifest=JSON.parse(await readFile(MANIFEST_PATH,'utf8'));
 const currentSha256=sha256(current),baselineSha256=sha256(baseline.stdout);
 assert.equal(manifest.bundleSha256,currentSha256,'Manifest must bind the audited current bundle');
 const scenarioHashes=new Set(scenarios.map(value=>value.metadata?.bundleSha256));
 assert.deepEqual([...scenarioHashes],[currentSha256],'Scenario metadata must bind the audited current bundle');
 const oracleCommits=new Set(scenarios.map(value=>value.metadata?.oracleCommit));
 assert.equal(oracleCommits.size,1,'Frozen scenarios must have one oracle commit');

 let totalCallCount=0,parityCallCount=0,rustPolicyCallCount=0;
 const mismatches=[];
 for(const scenario of scenarios){
  const oldOracle=oracle(baseline.stdout,`${baselineRef}:${BUNDLE_PATH}`),currentOracle=oracle(current,BUNDLE_PATH);
  for(const [index,call]of scenario.calls.entries()){
   totalCallCount++;
   if(call.comparison==='rust-policy'){rustPolicyCallCount++;continue;}
   parityCallCount++;
   const args=parseLossless(call.arguments),old=outcomeText(oldOracle.call(call.name,args)),next=outcomeText(currentOracle.call(call.name,args));
   if(old!==next||old!==call.expected||next!==call.expected)mismatches.push({suite:scenario.suite,scenario:scenario.name,index,name:call.name,oldEqualsCurrent:old===next,oldEqualsExpected:old===call.expected,currentEqualsExpected:next===call.expected});
  }
 }
 const behavior=scenarios.map(({suite,name,calls})=>({suite,name,calls}));
 const expected=scenarios.flatMap(({suite,name,calls})=>calls.map((call,index)=>({suite,name,index,comparison:call.comparison??'parity',expected:call.expected})));
 const report={
  schema:'barochart.core-bundle-compatibility',version:1,
  baseline:{ref:baselineRef,bundleSha256:baselineSha256},current:{bundleSha256:currentSha256},
  fixture:{oracleCommit:[...oracleCommits][0],scenarioCount:scenarios.length,totalCallCount,parityCallCount,rustPolicyCallCount,behaviorSha256:sha256(JSON.stringify(behavior)),expectedPayloadSha256:sha256(JSON.stringify(expected))},
  validation:{oldEqualsCurrent:mismatches.length===0,oldEqualsFrozenExpected:mismatches.length===0,currentEqualsFrozenExpected:mismatches.length===0,mismatchCount:mismatches.length,mismatches},
  runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,tz:process.versions.tz},
  scope:'Fresh VM per stateful scenario. Parity calls compare baseline JS, current JS, and stored expected bytes. Explicit rust-policy calls are counted but not compared to JavaScript because their expected values intentionally describe Rust-only rejection policy.',
  note:'Only bundle provenance may be updated after this audit passes. Stored expected outcomes, arguments, comparison policies, and oracleCommit remain frozen.',
 };
 assert.equal(mismatches.length,0,JSON.stringify(mismatches));
 if(write){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
 return report;
}

async function main(){
 const args=process.argv.slice(2),baselineRef=argument('--baseline-ref',args)??DEFAULT_BASELINE,output=resolve(argument('--output',args)??DEFAULT_OUTPUT),check=args.includes('--check');
 for(const name of args.filter(value=>value.startsWith('--')))assert.ok(['--baseline-ref','--output','--check'].includes(name),`Unknown option ${name}`);
 const report=await audit({baselineRef,output,write:!check});
 if(check){const stored=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(stored,report,'Bundle compatibility report is stale');}
 process.stdout.write(JSON.stringify({status:'passed',baseline:report.baseline.bundleSha256,current:report.current.bundleSha256,scenarios:report.fixture.scenarioCount,parityCalls:report.fixture.parityCallCount,expectedPayloadSha256:report.fixture.expectedPayloadSha256,report:'docs/measurements/core-bundle-compatibility.json'})+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
