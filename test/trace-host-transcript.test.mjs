// Opt-in host callback transcripts stay deliberately narrow. The default
// recorder/replayer contract is covered by trace-replay.test.mjs; these tests
// exercise the one vetted callback profile used by the Android timezone shim.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {copyFileSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installTraceRecorder} from '../scripts/trace/record.mjs';
import {replayTrace} from '../scripts/trace/replay-js.mjs';
import {parseLossless} from '../scripts/trace/bcjson.mjs';

const BUNDLE=`// Generated from src/core\n\n`+
`globalThis.nativeCall=function(...args){return asterZonedParts(...args);};\n`;

function scratch(){return mkdtempSync(join(tmpdir(),'barochart-host-transcript-'));}

function metadata(){return {globals:'{}',hostGlobals:[],opaqueGlobals:['asterZonedParts'],stopped:null};}

function contextWithCallback(source=`globalThis.asterZonedParts=function(first,second,...rest){if(this!==globalThis)throw new Error('receiver');return [first,second,...rest];};`,bundle=BUNDLE){
 const context=vm.createContext({});
 vm.runInContext(source,context);
 vm.runInContext(bundle,context);
 return context;
}

function record(dir,{source,hostCallbacks,bundle=BUNDLE,name='session'}={}){
 const path=join(dir,`${name}.jsonl`);
 const context=contextWithCallback(source,bundle);
 const recorder=installTraceRecorder(context,{path,meta:metadata(),hostCallbacks});
 return {path,context,recorder};
}

function lines(path){return readFileSync(path,'utf8').split('\n').filter(Boolean).map(parseLossless);}

function replayBundle(dir,bundle=BUNDLE,name='bundle.js'){
 const path=join(dir,name);
 writeFileSync(path,bundle);
 return path;
}

function readMeta(dir,name='session'){return JSON.parse(readFileSync(join(dir,`${name}.meta.json`),'utf8'));}

function writeMeta(dir,meta,name='session'){writeFileSync(join(dir,`${name}.meta.json`),JSON.stringify(meta)+'\n');}

test('preload requires explicit host-callback opt-in and finalizes its transcript',()=>{
 const dir=scratch();
 try{
  const output=join(dir,'traces'),script=join(dir,'session.mjs'),preload=fileURLToPath(new URL('./helpers/trace-preload.mjs',import.meta.url));
  writeFileSync(script,`import vm from 'node:vm';
const context=vm.createContext({});
vm.runInContext(${JSON.stringify(`globalThis.asterZonedParts=function(first,second,...rest){if(this!==globalThis)throw new Error('receiver');return [first,second,...rest];};`)},context);
vm.runInContext(${JSON.stringify(BUNDLE)},context);
vm.runInContext('nativeCall(1)',context);
`);
  const result=spawnSync(process.execPath,['--import',preload,script],{cwd:dir,env:{...process.env,BAROCHART_TRACE_DIR:output,BAROCHART_TRACE_HOST_CALLBACKS:'asterZonedParts'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const trace=join(output,'session-1.jsonl'),meta=JSON.parse(readFileSync(join(output,'session-1.meta.json'),'utf8'));
  assert.deepEqual(meta.opaqueGlobals,[]);
  assert.equal(meta.hostCallbacks.asterZonedParts.complete,true);
  assert.deepEqual(replayTrace(trace),{calls:1,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('opt-in does not launder unrelated Android shim globals',()=>{
 const dir=scratch();
 try{
  const output=join(dir,'traces'),script=join(dir,'session.mjs'),preload=fileURLToPath(new URL('./helpers/trace-preload.mjs',import.meta.url));
  writeFileSync(script,`import vm from 'node:vm';
const context=vm.createContext({});
vm.runInContext(${JSON.stringify(`globalThis.hostCalls=[];globalThis.asterZonedParts=function(first,second){hostCalls.push([first,second]);return [first,second];};globalThis.Intl={DateTimeFormat:function(){this.formatToParts=function(){return asterZonedParts(1,'UTC');};}};`)},context);
vm.runInContext(${JSON.stringify(BUNDLE)},context);
vm.runInContext('nativeCall(1)',context);
`);
  const result=spawnSync(process.execPath,['--import',preload,script],{cwd:dir,env:{...process.env,BAROCHART_TRACE_DIR:output,BAROCHART_TRACE_HOST_CALLBACKS:'asterZonedParts'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const trace=join(output,'session-1.jsonl'),meta=JSON.parse(readFileSync(join(output,'session-1.meta.json'),'utf8'));
  assert.deepEqual(meta.opaqueGlobals,['hostCalls','Intl']);
  assert.throws(()=>replayTrace(trace),/cannot reproduce: hostCalls, Intl/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('registered host callback records exact calls and replays them one-for-one',()=>{
 const dir=scratch();
 try{
  const {path,context,recorder}=record(dir,{hostCallbacks:['asterZonedParts']});
  const first=vm.runInContext(`nativeCall(NaN,-0,undefined)`,context);
  const second=vm.runInContext(`nativeCall('second',false)`,context);
  assert.equal(vm.runInContext('asterZonedParts.length',context),2);
  assert.equal(first.length,3);assert.ok(Number.isNaN(first[0]));assert.ok(Object.is(first[1],-0));assert.equal(first[2],undefined);
  assert.equal(second.length,2);assert.equal(second[0],'second');assert.equal(second[1],false);
  recorder.finalize();
  const meta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(meta.opaqueGlobals,[],'the configured callback is removable only after finalization');
  assert.deepEqual(meta.hostCallbacks.asterZonedParts.profile,'asterZonedParts');
  assert.deepEqual(meta.hostCallbacks.asterZonedParts.calls,[
   {phase:'native',nativeOrdinal:0,receiver:'undefined',args:'[NaN,-0,undefined]',ok:'[NaN,-0,undefined]'},
   {phase:'native',nativeOrdinal:1,receiver:'undefined',args:'["second",false]',ok:'["second",false]'},
  ]);
  assert.deepEqual(lines(path).map(line=>line.fn),['nativeCall','nativeCall']);
  assert.deepEqual(replayTrace(path,{bundlePath:replayBundle(dir)}),{calls:2,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('registered callback captures native Error fields and falsy thrown values losslessly',()=>{
 const dir=scratch();
 try{
  const bundle=`// Generated from src/core\n\n`+
   `globalThis.nativeCall=function(value){try{return ['ok',asterZonedParts(value)];}catch(error){return error instanceof Error?['error',error.name,error.message,error.code]:['thrown',error];}};\n`;
  const source=`globalThis.asterZonedParts=function(value){
   if(value==='error'){const error=new RangeError('invalid');error.code=0;throw error;}
   if(value==='false')throw false;
   if(value==='zero')throw -0;
   return value;
  };`;
  const {path,context,recorder}=record(dir,{source,bundle,hostCallbacks:['asterZonedParts']});
  assert.deepEqual(Array.from(vm.runInContext(`nativeCall('error')`,context)),['error','RangeError','invalid',0]);
  assert.deepEqual(Array.from(vm.runInContext(`nativeCall('false')`,context)),['thrown',false]);
  const zero=vm.runInContext(`nativeCall('zero')`,context);assert.equal(zero[0],'thrown');assert.ok(Object.is(zero[1],-0));
  recorder.finalize();
  const meta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(meta.hostCallbacks.asterZonedParts.calls,[
   {phase:'native',nativeOrdinal:0,receiver:'undefined',args:'["error"]',err:{name:'RangeError',message:'invalid',code:'0'}},
   {phase:'native',nativeOrdinal:1,receiver:'undefined',args:'["false"]',thrown:'false'},
   {phase:'native',nativeOrdinal:2,receiver:'undefined',args:'["zero"]',thrown:'-0'},
  ]);
  assert.deepEqual(replayTrace(path,{bundlePath:replayBundle(dir,bundle)}),{calls:3,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('callback inspection never invokes getters or toJSON and unsupported outcomes stay opaque',()=>{
 const dir=scratch();
 try{
  const source=`globalThis.hits=0;globalThis.asterZonedParts=function(){
   const value={};Object.defineProperty(value,'bad',{enumerable:true,get(){hits++;return 1;}});
   value.toJSON=()=>{hits++;return 1;};return value;
  };`;
  const {path,context,recorder}=record(dir,{source,hostCallbacks:['asterZonedParts']});
  const returned=vm.runInContext(`nativeCall(1)`,context);
  assert.equal(typeof Object.getOwnPropertyDescriptor(returned,'bad').get,'function');
  assert.equal(vm.runInContext('hits',context),0);
  recorder.finalize();
  const meta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(meta.opaqueGlobals,['asterZonedParts']);
  assert.equal(meta.hostCallbacks.asterZonedParts.complete,false);
  assert.deepEqual(lines(path),[],'the native call is not presented as a replayable prefix');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('unregistered, untracked, replaced and unknown callbacks remain opaque',()=>{
 const dir=scratch();
 try{
  const plain=record(dir);
  vm.runInContext(`nativeCall(1)`,plain.context);
  plain.recorder.finalize();
  assert.throws(()=>replayTrace(plain.path,{bundlePath:replayBundle(dir)}),/cannot reproduce: asterZonedParts/);

  const untracked=record(dir,{hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext('asterZonedParts(1)',untracked.context)[0],1);
  untracked.recorder.finalize();
  const untrackedMeta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(untrackedMeta.opaqueGlobals,['asterZonedParts']);

  const replaced=record(dir,{hostCallbacks:['asterZonedParts']});
  vm.runInContext(`nativeCall(1)`,replaced.context);
  replaced.context.asterZonedParts=function(){return 'replacement';};
  replaced.recorder.finalize();
  const replacedMeta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(replacedMeta.opaqueGlobals,['asterZonedParts']);
  assert.equal(replacedMeta.hostCallbacks.asterZonedParts.complete,false);
  assert.throws(()=>replayTrace(replaced.path,{bundlePath:replayBundle(dir,`throw new Error('BUNDLE_EXECUTED');`)}),/cannot reproduce: asterZonedParts/);

  const unknown=record(dir,{hostCallbacks:['notARegisteredCallback']});
  vm.runInContext(`nativeCall(1)`,unknown.context);
  unknown.recorder.finalize();
  const unknownMeta=JSON.parse(readFileSync(join(dir,'session.meta.json'),'utf8'));
  assert.deepEqual(unknownMeta.opaqueGlobals,['asterZonedParts']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('replay rejects callback argument mismatches and missing or extra transcript consumption',()=>{
 const dir=scratch();
 try{
  const {path,context,recorder}=record(dir,{hostCallbacks:['asterZonedParts']});
  vm.runInContext(`nativeCall(1);nativeCall(2)`,context);
  recorder.finalize();
  const bundlePath=replayBundle(dir);
  const extra=join(dir,'extra.jsonl');
  writeFileSync(extra,readFileSync(path,'utf8')+readFileSync(path,'utf8'));
  copyFileSync(join(dir,'session.meta.json'),join(dir,'extra.meta.json'));
  assert.throws(()=>replayTrace(extra,{bundlePath}),/extra call|unmatched/i);
  const missing=join(dir,'missing.jsonl');
  writeFileSync(missing,lines(path).slice(0,1).map(JSON.stringify).join('\n')+'\n');
  copyFileSync(join(dir,'session.meta.json'),join(dir,'missing.meta.json'));
  assert.throws(()=>replayTrace(missing,{bundlePath}),/missing call|not consumed|missing transcript/i);
  const mismatch=join(dir,'mismatch.jsonl');
  const first=lines(path)[0];first.args='[99]';writeFileSync(mismatch,JSON.stringify(first)+'\n'+JSON.stringify(lines(path)[1])+'\n');
  copyFileSync(join(dir,'session.meta.json'),join(dir,'mismatch.meta.json'));
  assert.throws(()=>replayTrace(mismatch,{bundlePath}),/argument mismatch|host callback transcript/i);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('malformed callback outcomes fail even when the bundle catches the decoder exception',()=>{
 const dir=scratch();
 try{
  const bundle=`// Generated from src/core\n\n`+
   `globalThis.nativeCall=function(value){try{asterZonedParts(value);return 'unexpected';}catch{return 'caught';}};\n`;
  const source=`globalThis.asterZonedParts=function(){throw false;};`;
  const {path,context,recorder}=record(dir,{source,bundle,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext(`nativeCall(1)`,context),'caught');
  recorder.finalize();
  const meta=readMeta(dir);
  assert.equal(meta.hostCallbacks.asterZonedParts.calls[0].thrown,'false');
  meta.hostCallbacks.asterZonedParts.calls[0].thrown='{';
  writeMeta(dir,meta);
  assert.throws(()=>replayTrace(path,{bundlePath:replayBundle(dir,bundle)}),/host callback transcript|BCJSON|invalid/i);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('callback outcomes use argument-grade values and preserve plain thrown objects',()=>{
 const dir=scratch();
 try{
  const unsupported=[
   ['float64','new Float64Array([1,2])'],
   ['shared','(()=>{const child={value:1};return {left:child,right:child};})()'],
   ['frozen','Object.freeze({value:1})'],
  ];
  for(const [name,expression] of unsupported){
   const source=`globalThis.asterZonedParts=function(){return ${expression};};`;
   const recorded=record(dir,{name,source,hostCallbacks:['asterZonedParts']});
   vm.runInContext('nativeCall(1)',recorded.context);
   recorded.recorder.finalize();
   const meta=readMeta(dir,name);
   assert.equal(meta.hostCallbacks.asterZonedParts.complete,false,name);
   assert.deepEqual(meta.opaqueGlobals,['asterZonedParts'],name);
   assert.deepEqual(lines(recorded.path),[],name);
  }

  const proxySource=`globalThis.hits=0;globalThis.asterZonedParts=function(){return new Proxy({}, {ownKeys(){hits++;return [];},getOwnPropertyDescriptor(){hits++;return undefined;}});};`;
  const proxy=record(dir,{name:'proxy',source:proxySource,hostCallbacks:['asterZonedParts']});
  vm.runInContext('nativeCall(1)',proxy.context);proxy.recorder.finalize();
  assert.equal(vm.runInContext('hits',proxy.context),0);
  assert.equal(readMeta(dir,'proxy').hostCallbacks.asterZonedParts.complete,false);

  const caughtBundle=`// Generated from src/core\n\n`+
   `globalThis.nativeCall=function(){try{return asterZonedParts();}catch(error){return [error.name,error.message,error.detail,error instanceof Error];}};\n`;
  const plain=record(dir,{name:'plain',bundle:caughtBundle,source:`globalThis.asterZonedParts=function(){throw {name:'Plain',message:'plain',detail:7};};`,hostCallbacks:['asterZonedParts']});
  assert.deepEqual(Array.from(vm.runInContext('nativeCall()',plain.context)),['Plain','plain',7,false]);
  plain.recorder.finalize();
  const plainCall=readMeta(dir,'plain').hostCallbacks.asterZonedParts.calls[0];
  assert.equal(plainCall.thrown,`{"name":"Plain","message":"plain","detail":7}`);
  assert.equal(Object.hasOwn(plainCall,'err'),false);
  assert.deepEqual(replayTrace(plain.path,{bundlePath:replayBundle(dir,caughtBundle,'plain-bundle.js')}),{calls:1,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('native Error capture is realm-safe and never prepares stack text',()=>{
 const dir=scratch();
 try{
  const bundle=`// Generated from src/core\n\n`+
   `globalThis.hits=0;Error.prepareStackTrace=function(){hits++;return 'prepared';};globalThis.nativeCall=function(){try{return asterZonedParts();}catch(error){return [error.name,error.message,error.code,hits];}};\n`;
  const source=`globalThis.asterZonedParts=function(){const error=new RangeError('bad');error.code=0;throw error;};`;
  const {path,context,recorder}=record(dir,{source,bundle,hostCallbacks:['asterZonedParts']});
  assert.deepEqual(Array.from(vm.runInContext('nativeCall()',context)),['RangeError','bad',0,0]);
  recorder.finalize();
  assert.equal(readMeta(dir).hostCallbacks.asterZonedParts.complete,true);
  assert.deepEqual(replayTrace(path,{bundlePath:replayBundle(dir,bundle)}),{calls:1,mismatches:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('callback entries are bound to exact native-call ordinals and never consumed during bootstrap',()=>{
 const dir=scratch();
 try{
  const bundle=`// Generated from src/core\n\n`+
   `globalThis.nativeNoCallback=function(value){return value;};globalThis.nativeCall=function(value){return asterZonedParts(value);};\n`;
  const {path,context,recorder}=record(dir,{bundle,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext(`nativeNoCallback('same')`,context),'same');
  assert.deepEqual(Array.from(vm.runInContext(`nativeCall('same')`,context)),['same',undefined]);
  recorder.finalize();
  assert.equal(readMeta(dir).hostCallbacks.asterZonedParts.calls[0].nativeOrdinal,1);
  const bundlePath=replayBundle(dir,bundle);
  assert.deepEqual(replayTrace(path,{bundlePath}),{calls:2,mismatches:[]});

  const moved=readMeta(dir);moved.hostCallbacks.asterZonedParts.calls[0].nativeOrdinal=0;writeMeta(dir,moved);
  assert.throws(()=>replayTrace(path,{bundlePath}),/native call|ordinal|missing|extra/i);

  moved.hostCallbacks.asterZonedParts.calls[0].nativeOrdinal=1;writeMeta(dir,moved);
  const bootstrap=`// Generated from src/core\n\n`+
   `try{asterZonedParts('same');}catch{}globalThis.nativeNoCallback=function(value){return value;};globalThis.nativeCall=function(value){return [value,undefined];};\n`;
  assert.throws(()=>replayTrace(path,{bundlePath:replayBundle(dir,bootstrap,'bootstrap.js')}),/outside native call|bootstrap|host callback transcript/i);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('callback wrappers preserve strict, sloppy, global, and unsupported receivers',()=>{
 const dir=scratch();
 try{
  const strict=record(dir,{name:'strict',source:`globalThis.asterZonedParts=function(){'use strict';return this===undefined;};`,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext('nativeCall()',strict.context),true);strict.recorder.finalize();
  assert.equal(readMeta(dir,'strict').hostCallbacks.asterZonedParts.calls[0].receiver,'undefined');
  assert.deepEqual(replayTrace(strict.path,{bundlePath:replayBundle(dir,BUNDLE,'strict.js')}),{calls:1,mismatches:[]});

  const sloppy=record(dir,{name:'sloppy',source:`globalThis.asterZonedParts=function(){return this===globalThis;};`,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext('nativeCall()',sloppy.context),true);sloppy.recorder.finalize();

  const globalBundle=`// Generated from src/core\n\n`+`globalThis.nativeCall=function(value){return asterZonedParts.call(globalThis,value);};\n`;
  const explicit=record(dir,{name:'global',bundle:globalBundle,source:`globalThis.asterZonedParts=function(){'use strict';return this===globalThis;};`,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext('nativeCall(1)',explicit.context),true);explicit.recorder.finalize();
  assert.equal(readMeta(dir,'global').hostCallbacks.asterZonedParts.calls[0].receiver,'global');
  assert.deepEqual(replayTrace(explicit.path,{bundlePath:replayBundle(dir,globalBundle,'global.js')}),{calls:1,mismatches:[]});
  assert.throws(()=>replayTrace(explicit.path,{bundlePath:replayBundle(dir,`// Generated from src/core\n\nglobalThis.nativeCall=function(value){return asterZonedParts(value);};\n`,'bare.js')}),/receiver mismatch/i);

  const otherBundle=`// Generated from src/core\n\n`+`globalThis.nativeCall=function(value){return asterZonedParts.call({tag:'other'},value);};\n`;
  const other=record(dir,{name:'other',bundle:otherBundle,source:`globalThis.asterZonedParts=function(){return this.tag;};`,hostCallbacks:['asterZonedParts']});
  assert.equal(vm.runInContext('nativeCall(1)',other.context),'other');other.recorder.finalize();
  assert.equal(readMeta(dir,'other').hostCallbacks.asterZonedParts.complete,false);
  assert.deepEqual(lines(other.path),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('propagated primitive callback throws retain the existing top-level trace schema',()=>{
 const dir=scratch();
 try{
  const source=`globalThis.asterZonedParts=function(){throw false;};`;
  const {path,context,recorder}=record(dir,{source,hostCallbacks:['asterZonedParts']});
  assert.throws(()=>vm.runInContext('nativeCall()',context),value=>value===false);
  recorder.finalize();
  assert.deepEqual(lines(path),[],'no top-level thrown outcome is introduced');
  const meta=readMeta(dir);
  assert.match(meta.stopped.reason,/error: primitive/);
  assert.equal(meta.hostCallbacks.asterZonedParts.complete,false);
  assert.deepEqual(meta.opaqueGlobals,['asterZonedParts']);

  const plain=record(dir,{name:'default'});vm.runInContext(`nativeCall(NaN,-0,undefined)`,plain.context);plain.recorder.finalize();
  assert.equal(readFileSync(plain.path,'utf8'),`{"fn":"nativeCall","args":[NaN,-0,undefined],"ok":[NaN,-0,undefined]}\n`);
  assert.equal(Object.hasOwn(readMeta(dir,'default'),'hostCallbacks'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('host transcript metadata is exact and rejected before bundle evaluation',()=>{
 const dir=scratch();
 try{
  const {path,context,recorder}=record(dir,{hostCallbacks:['asterZonedParts']});
  vm.runInContext('nativeCall(1)',context);recorder.finalize();
  const valid=readMeta(dir),invalidBundle=`throw new Error('BUNDLE_EXECUTED');`;
  const cases=[
   ['multiple outcomes',entry=>{entry.thrown='false';}],
   ['non-string outcome',entry=>{entry.ok=1;}],
   ['bad receiver',entry=>{entry.receiver='other';}],
   ['bad native ordinal',entry=>{entry.nativeOrdinal='0';}],
   ['bad phase',entry=>{entry.phase='bootstrap';}],
   ['malformed arguments',entry=>{entry.args='{';}],
   ['extra field',entry=>{entry.extra=true;}],
   ['unsupported error name',entry=>{delete entry.ok;entry.err={name:'CustomError',message:'bad',code:'undefined'};}],
   ['incomplete transcript',(_entry,meta)=>{meta.hostCallbacks.asterZonedParts.complete=false;}],
   ['unsupported version',(_entry,meta)=>{meta.hostCallbacks.asterZonedParts.version=3;}],
  ];
  for(const [index,[label,mutate]] of cases.entries()){
   const name=`tampered-${index}`,tampered=structuredClone(valid);
   mutate(tampered.hostCallbacks.asterZonedParts.calls[0],tampered);
   copyFileSync(path,join(dir,`${name}.jsonl`));writeMeta(dir,tampered,name);
   let error=null;
   try{replayTrace(join(dir,`${name}.jsonl`),{bundlePath:replayBundle(dir,invalidBundle,`${name}.js`)});}catch(caught){error=caught;}
   assert.ok(error instanceof Error,`${label}: invalid metadata must throw`);
   assert.doesNotMatch(error.message,/BUNDLE_EXECUTED/,label);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('default preload contexts add no exit listeners and opt-in uses one finalizer',()=>{
 const dir=scratch();
 try{
  const preload=fileURLToPath(new URL('./helpers/trace-preload.mjs',import.meta.url));
  const script=join(dir,'many.mjs');
  writeFileSync(script,`import vm from 'node:vm';
const before=process.listenerCount('exit');const held=[];
for(let index=0;index<16;index++){const context=vm.createContext({});held.push(context);vm.runInContext(${JSON.stringify(`globalThis.asterZonedParts=function(value){return value;};`)},context);vm.runInContext(${JSON.stringify(BUNDLE)},context);vm.runInContext('nativeCall(1)',context);}
process.stdout.write(JSON.stringify({before,after:process.listenerCount('exit')}));
`);
  const baseEnv={...process.env,BAROCHART_TRACE_DIR:join(dir,'default'),BAROCHART_TRACE_HOST_CALLBACKS:'',BAROCHART_TRACE_HOST_TRANSCRIPTS:''};
  const defaultRun=spawnSync(process.execPath,['--import',preload,script],{cwd:dir,env:baseEnv,encoding:'utf8'});
  assert.equal(defaultRun.status,0,defaultRun.stderr);
  const defaultListeners=JSON.parse(defaultRun.stdout);
  assert.equal(defaultListeners.after-defaultListeners.before,0);
  assert.equal(readdirSync(join(dir,'default')).filter(name=>name.endsWith('.jsonl')).length,16);

  const optinRun=spawnSync(process.execPath,['--import',preload,script],{cwd:dir,env:{...baseEnv,BAROCHART_TRACE_DIR:join(dir,'optin'),BAROCHART_TRACE_HOST_CALLBACKS:'asterZonedParts'},encoding:'utf8'});
  assert.equal(optinRun.status,0,optinRun.stderr);
  const optinListeners=JSON.parse(optinRun.stdout);
  assert.equal(optinListeners.after-optinListeners.before,1);
  const metas=readdirSync(join(dir,'optin')).filter(name=>name.endsWith('.meta.json')).map(name=>JSON.parse(readFileSync(join(dir,'optin',name),'utf8')));
  assert.equal(metas.length,16);
  for(const meta of metas){assert.equal(meta.hostCallbacks.asterZonedParts.complete,true);assert.deepEqual(meta.opaqueGlobals,[]);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

