#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-runtime.leaf.jsonl');
const sources=['examples/native/bridge.mjs','examples/native/params-bridge.mjs','src/core/async-state.mjs','src/core/prepare-state.mjs','src/core/native-workspace-source.mjs','src/core/native-workspace-target.mjs','src/core/native-params-source.mjs','src/core/native-params-target.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function bits(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:bits(value)};
 if(value===undefined)return{$undefined:true};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));
 if(typeof value==='object'){if(seen.has(value))throw new TypeError('cyclic runtime fixture');seen.add(value);const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;}
 throw new TypeError('unsupported runtime fixture value');
}
function encodeRow(row){const result={kind:row.kind,id:row.id};for(const[key,value]of Object.entries(row))if(!['kind','id'].includes(key))result[key]=encode(value);return result;}
function run(context,source){return vm.runInContext(source,context,{timeout:10000});}
function errorOf(action){try{action();return null;}catch(error){return{name:error.name,message:error.message,code:error.code??null};}}
function beginSummary(text){const value=JSON.parse(text),metadata=JSON.parse(value.metadataJSON);return{ticket:value.ticket,buffers:value.buffers,checkpoints:value.checkpoints,metadata:{schema:metadata.schema,protocol:metadata.protocol,event:metadata.event??null,request:metadata.request??null,bufferLengths:metadata.bufferLengths??null}};}
function workspaceStepSummary(value){return{phase:value.phase,complete:value.complete,ticket:value.ticket??null,registration:value.registration??null,buffers:value.buffers??null,checkpoints:value.checkpoints??null,plan:value.plan??null,metadataSchema:value.metadataJSON?JSON.parse(value.metadataJSON).schema:null};}
function paramsStepSummary(value){return{phase:value.phase,complete:value.complete,metadataSchema:value.metadataJSON?JSON.parse(value.metadataJSON).schema:null,plan:value.plan??null};}
function workspaceSetup(context){run(context,`globalThis.binding={key:'dataset',revision:'r1',adjustmentVersion:'a1',priceUnit:'USD',adjustment:'raw'};globalThis.workspaceText=nativeSaveWorkspace(binding);`);}
async function runtime(){const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context);return context;}

async function sourceRoutingCase(){
 const context=await runtime();run(context,'nativeInit(16)');workspaceSetup(context);
 const event=run(context,`(()=>{const b=nativeModel.store.at(2);return JSON.stringify({kind:'correction',bar:{...b,close:b.close+1,high:Math.max(b.high,b.close+1)}});})()`);
 const asyncText=context.nativeAsyncBegin(event),asyncBegin=beginSummary(asyncText),asyncSlice=Array.from(context.nativeAsyncBuffer(asyncBegin.ticket,0,0,4));
 const sourceBusy=errorOf(()=>context.nativePrepareBegin('{"kind":"seeded","count":2}'));
 const wrongRelease=context.nativeAsyncRelease(999),stillActive=context.nativeAsyncCheck(asyncBegin.ticket),released=context.nativeAsyncRelease(asyncBegin.ticket);
 const prepareText=context.nativePrepareBegin('{"kind":"seeded","count":4,"seed":7,"visibleBars":3}'),prepareBegin=beginSummary(prepareText),prepareBufferError=errorOf(()=>context.nativeAsyncBuffer(prepareBegin.ticket,0,0,0));
 context.nativeAsyncRelease(prepareBegin.ticket);
 const workspaceBegin=run(context,'nativeWorkspaceSourceBegin(workspaceText,binding,3,805306368,5)'),workspaceRows=[];let workspaceStep;
 do{workspaceStep=run(context,`nativeWorkspaceSourceStep(${workspaceBegin.ticket},64,3)`);workspaceRows.push(workspaceStepSummary(workspaceStep));}while(!workspaceStep.complete);
 const workspaceSlice=Array.from(context.nativeAsyncBuffer(workspaceBegin.ticket,0,0,4)),workspaceWrongAbort=context.nativeWorkspaceSourceAbort(4),workspaceAbort=context.nativeWorkspaceSourceAbort(5),workspaceMissing=errorOf(()=>context.nativeWorkspaceSourceCheck(workspaceBegin.ticket,3)),workspaceRegistrationError=errorOf(()=>run(context,'nativeWorkspaceSourceBegin(workspaceText,binding,3,805306368,5)'));
 const paramsBegin=run(context,`nativeParamsSourceBegin('ema',{period:9},7,805306368,6)`),paramsRows=[];let paramsStep;
 do{paramsStep=context.nativeParamsSourceStep(paramsBegin.ticket,64,7);paramsRows.push(paramsStepSummary(paramsStep));}while(!paramsStep.complete);
 const paramsSlice=Array.from(context.nativeAsyncBuffer(paramsBegin.ticket,0,0,4)),unarmedWrite=errorOf(()=>context.nativeAsyncTargetBuffer(0,0,1)),paramsActive=context.nativeParamsSourceStatus(6),paramsAbort=context.nativeParamsSourceAbort(6);
 for(let registration=7;registration<=11;registration++){run(context,`nativeParamsSourceBegin('ema',{period:9},7,805306368,${registration})`);context.nativeParamsSourceAbort(registration);}
 const terminalStatuses=[7,8,9,10,11,12].map(registration=>context.nativeParamsSourceStatus(registration));
 run(context,'nativeModel.dispose()');
 return{kind:'case',id:'source-routing',asyncBegin,asyncSlice,sourceBusy,wrongRelease,stillActive,released,prepareBegin,prepareBufferError,workspaceBegin,workspaceRows,workspaceSlice,workspaceWrongAbort,workspaceAbort,workspaceMissing,workspaceRegistrationError,paramsBegin,paramsRows,paramsSlice,unarmedWrite,paramsActive,paramsAbort,terminalStatuses};
}

async function ownerStalenessCase(){
 const context=await runtime();run(context,'nativeInit(16)');workspaceSetup(context);
 const first=run(context,'nativeWorkspaceSourceBegin(workspaceText,binding,1,805306368,1)');context.nativeResize(641,361);const sizeStale=errorOf(()=>context.nativeWorkspaceSourceCheck(first.ticket,1)),sizeAbort=context.nativeWorkspaceSourceAbort(1);
 const second=run(context,'nativeWorkspaceSourceBegin(workspaceText,binding,2,805306368,2)');context.nativeTool('trendline');const toolStale=errorOf(()=>context.nativeWorkspaceSourceCheck(second.ticket,2)),toolAbort=context.nativeWorkspaceSourceAbort(2);
 context.nativeTool('select');context.nativePointer('down',1,200,100);const activePointer=errorOf(()=>run(context,'nativeWorkspaceSourceBegin(workspaceText,binding,3,805306368,3)'));context.nativePointer('cancel',1,0,0);
 const params=run(context,`nativeParamsSourceBegin('ema',{period:9},4,805306368,4)`);context.nativeResize(642,362);const paramsStale=errorOf(()=>context.nativeParamsSourceCheck(params.ticket,4)),paramsStatus=context.nativeParamsSourceStatus(4);
 run(context,'nativeModel.dispose()');
 return{kind:'case',id:'owner-staleness',sizeStale,sizeAbort,toolStale,toolAbort,activePointer,paramsStale,paramsStatus};
}

async function targetRoutingCase(){
 const source=await runtime(),prepareTarget=await runtime();run(source,'nativeInit(4)');
 const prepareText=source.nativePrepareBegin('{"kind":"columns","length":4,"visibleBars":3}'),prepare=JSON.parse(prepareText),prepareCreated=prepareTarget.nativePrepareCreate(prepare.metadataJSON),prepareSlice=prepareTarget.nativeAsyncTargetBuffer(0,0,2);prepareSlice.set([1,2]);
 const prepareOrder=errorOf(()=>prepareTarget.nativeAsyncTargetBuffer(0,0,1)),targetBusy=errorOf(()=>prepareTarget.nativeAsyncCreate(prepare.metadataJSON));source.nativeAsyncRelease(prepare.ticket);
 const paramsSource=await runtime(),paramsTarget=await runtime();run(paramsSource,'nativeInit(4)');const paramsBegin=run(paramsSource,`nativeParamsSourceBegin('ema',{period:3},5,805306368,1)`);let admission;do{admission=paramsSource.nativeParamsSourceStep(paramsBegin.ticket,64,5);}while(!admission.complete);
 const paramsCreated=paramsTarget.nativeParamsTargetCreate(admission.metadataJSON),metadata=JSON.parse(admission.metadataJSON);
 for(let slot=0;slot<6;slot++)paramsTarget.nativeAsyncTargetBuffer(slot,0,metadata.length).set(paramsSource.nativeAsyncBuffer(paramsBegin.ticket,slot,0,metadata.length));
 const paramsStart=paramsTarget.nativeParamsTargetStart(),steps=[];for(let guard=0;guard<100;guard++){const step=paramsTarget.nativeParamsTargetStep(4);steps.push(step);if(step.complete)break;}
 const output=Array.from(paramsTarget.nativeAsyncBuffer(1,0,0,2)),wrongRegistration=errorOf(()=>paramsTarget.nativeAsyncBuffer(2,0,0,1)),paramsDisposed=paramsTarget.nativeParamsTargetDispose();paramsSource.nativeParamsSourceAbort(1);
 const liveWorkspace=await runtime();run(liveWorkspace,'nativeInit(0)');const workspaceVacancy=errorOf(()=>liveWorkspace.nativeWorkspaceTargetCreate('{}'));
 run(source,'nativeModel.dispose()');run(paramsSource,'nativeModel.dispose()');run(liveWorkspace,'nativeModel.dispose()');
 return{kind:'case',id:'target-routing',prepareCreated,prepareLength:prepareSlice.length,prepareOrder,targetBusy,paramsCreated,paramsStart,steps,output,wrongRegistration,paramsDisposed,workspaceVacancy};
}

async function paramsArmCase(){
 const context=await runtime();run(context,'nativeInit(4)');const begin=run(context,`nativeParamsSourceBegin('ema',{period:3},1,805306368,1)`);let step;do{step=context.nativeParamsSourceStep(begin.ticket,64,1);}while(!step.complete);
 const invalid=errorOf(()=>context.nativeParamsSourceArmWrite(begin.ticket,99,0,1,1)),status=context.nativeParamsSourceStatus(1);const second=run(context,`nativeParamsSourceBegin('ema',{period:3},1,805306368,2)`);do{step=context.nativeParamsSourceStep(second.ticket,64,1);}while(!step.complete);const validArm=context.nativeParamsSourceArmWrite(second.ticket,0,0,1,1),invalidWrite=errorOf(()=>context.nativeAsyncTargetBuffer(0,0,1)),status2=context.nativeParamsSourceStatus(2);run(context,'nativeModel.dispose()');return{kind:'case',id:'params-arm-error',invalid,status,validArm,invalidWrite,status2};
}

export async function generateNativeRuntimeOracle(){
 const bundle=await buildNativeBundle(),header={kind:'header',schema:'barochart.rust-core.native-runtime-leaf',version:1,oracleCommit:'8457612bda98c764bc1a9e7e794dafcf9316a47e',bundleSHA256:sha(bundle),sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,seed:42,dialect:'ECMA-262/V8',encoding:'f64 bits; objects ordered entries',coverage:['shared ticket/source busy','F64 routing priority','registration marks and four-row ledger','source owner staleness','target busy and routing','ArmWrite first error/drop']};
 return[JSON.stringify(header),...(await Promise.all([sourceRoutingCase(),ownerStalenessCase(),targetRoutingCase(),paramsArmCase()])).map(row=>JSON.stringify(encodeRow(row)))].join('\n')+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-runtime.mjs [--check|--write]');const output=await generateNativeRuntimeOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native-runtime.leaf.jsonl is stale');console.log('native runtime oracle fresh: 4 cases');}else if(mode==='--write'){writeFileSync(fixture,output);console.log('native runtime oracle wrote: 4 cases');}else process.stdout.write(output);}
