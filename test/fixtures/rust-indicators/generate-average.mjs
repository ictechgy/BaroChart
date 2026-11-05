#!/usr/bin/env node
// M3 average checked-in oracle: actual JS factory + generic params + step/snapshot/restore.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {validateIndicatorParams} from '../../../src/core/indicator-params.mjs';
import {builtinIndicators} from '../../../src/core/indicators.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-indicators/average-oracle.jsonl');
const ORACLE=Object.freeze({
 schema:'barochart.rust-indicators.average-oracle',version:1,
 oracleCommit:'bf851d9fda8547180207de165c46ff8dc7c09b1b',
 localRustWorkspace:'f6831d5c56c2b0b1427d46c27227099ed0b09248',
 bundleSHA256:'007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512',
 indicatorsSHA256:'31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790',
 indicatorParamsSHA256:'fb323f348b5204e39c85e31f5a88fd1b0ab08af71d2ae81fa04f820a0bd96519',
 seed:'average-v1-fixed',dialect:'ECMA-262/V8',node:'v22.20.0',v8:'12.4.254.21-node.33',
 platform:'darwin-arm64',icu:'77.1',tzdata:'2025b',
 callSequence:['validateIndicatorParams','builtinFactory','create','restore?','snapshot','step+snapshot*'],
 encoding:'f64 big-endian bits; objects as ordered entry arrays',
});

const bytes=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verifySources(){
 const rows=[
  ['native/Resources/aster-core.js','bundleSHA256'],
  ['src/core/indicators.mjs','indicatorsSHA256'],
  ['src/core/indicator-params.mjs','indicatorParamsSHA256'],
 ];
 for(const [path,key] of rows)if(bytes(join(root,path))!==ORACLE[key])throw new Error(`average oracle source hash changed: ${path}`);
}

const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function f64(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value){
 if(typeof value==='number')return {$f64:f64(value)};
 if(typeof value==='string'||typeof value==='boolean'||value===null)return value;
 if(Array.isArray(value))return value.map(encode);
 if(value&&typeof value==='object')return {$object:Object.entries(value).map(([key,child])=>[key,encode(child)])};
 if(value===undefined)return {$undefined:true};
 throw new TypeError('Unsupported average oracle value');
}

function bar(index,close,volume=1){
 const time=1700000000000+index*60000;
 return {time,open:close,high:close,low:close,close,volume};
}
function bars(values,volumes=[]){return values.map((close,index)=>bar(index,close,volumes[index]??1));}
function restoredRing(length,head=-0,sum=length){return Object.fromEntries([['sum',sum],['a',Array(length).fill(1)],['head',head]]);}
function restoredSmooth(count,value){return Object.fromEntries([['value',value],['count',count],['sum',0]]);}

const boundary=[1,2,3,4,-3,-2,-1,-0];
const cases=[
 {id:'sma-partial-wrap',program:'sma',params:{period:3,source:'close',zeta:7},bars:bars(boundary)},
 {id:'sma-period1-zero-extremes',program:'sma',params:{period:1},bars:bars([-0,0,Number.MIN_VALUE,1e300,Number.MAX_VALUE])},
 {id:'sma-numeric-source',program:'sma',params:{period:2,source:123},bars:bars([1,2,3])},
 {id:'sma-cancellation-overflow',program:'sma',params:{period:2},bars:bars([1e16,1,2,Number.MAX_VALUE,Number.MAX_VALUE])},
 {id:'sma-restored-negzero-head',program:'sma',params:{period:10000},restore:{r:restoredRing(256)},startIndex:256,bars:[bar(256,2)]},
 {id:'sma-period256-restored-wrap',program:'sma',params:{period:256},restore:{r:restoredRing(256,0)},startIndex:256,bars:[bar(256,2)]},
 {id:'vwma-extremes',program:'vwma',params:{period:2},bars:bars([10,20,30,Number.MAX_VALUE,1,2],[1,3,0,2,1,1])},
 {id:'ema-ordinary',program:'ema',params:{period:3,source:'close'},bars:bars([1,2,3,4,1e300,-1e300])},
 {id:'ema-period1-zero-subnormal',program:'ema',params:{period:1},bars:bars([-0,0,Number.MIN_VALUE])},
 {id:'ema-numeric-source',program:'ema',params:{period:2,source:123},bars:bars([1,2,3])},
 {id:'ema-restored-overflow-recovery',program:'ema',params:{period:2},restore:{e:restoredSmooth(2,-Number.MAX_VALUE)},startIndex:2,bars:[bar(2,Number.MAX_VALUE)]},
 {id:'wma-partial-wrap',program:'wma',params:{period:3},bars:bars([1,2,3,4,-0,Number.MIN_VALUE])},
 {id:'macd-cold',program:'macd',params:{fast:2,slow:3,signal:2},bars:bars([1,2,3,4,5,1e300])},
 {id:'macd-restored-reordered',program:'macd',params:{fast:2,slow:3,signal:2},restore:Object.fromEntries([['s',restoredSmooth(2,1)],['f',restoredSmooth(2,10)],['l',restoredSmooth(3,9)]]),startIndex:3,bars:[bar(3,11)]},
 {id:'bollinger-flat-cancellation-extremes',program:'bollinger',params:{period:3,deviation:2},bars:bars([5,5,5,1e16,1,2,1e300,-1e300,Number.MAX_VALUE])},
 {id:'dema-cold',program:'dema',params:{period:2},bars:bars([1,2,3,4,-0])},
 {id:'tema-cold',program:'tema',params:{period:2},bars:bars([1,2,3,4,-0])},
 {id:'hma-cold',program:'hma',params:{period:4},bars:bars([1,2,3,4,5,6,-0])},
 {id:'trix-zero-and-large',program:'trix',params:{period:2},bars:bars([0,0,1,2,1e300,Number.MAX_VALUE])},
 {id:'ppo-zero-and-large',program:'ppo',params:{fast:2,slow:3,signal:2},bars:bars([0,0,1,2,1e300,Number.MAX_VALUE])},
];

function generateCase(spec){
 validateIndicatorParams(spec.params);
 const make=builtinIndicators.get(spec.program);if(!make)throw new Error(`Missing JS average factory: ${spec.program}`);
 const definition=make(spec.params),instance=definition.create();
 if(spec.restore!==undefined)instance.restore(spec.restore);
 const frames=[{index:null,output:null,snapshot:encode(instance.snapshot())}];
 const start=spec.startIndex??0;
 for(let offset=0;offset<spec.bars.length;offset++){
  const index=start+offset,output=instance.step(spec.bars[offset],index);
  frames.push({index,output:output.map(f64),snapshot:encode(instance.snapshot())});
 }
 return {kind:'case',id:spec.id,program:spec.program,params:encode(spec.params),outputs:definition.outputs,plotOffsets:encode(definition.plotOffsets),startIndex:start,bars:spec.bars.map(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].map(f64)),restore:spec.restore===undefined?null:encode(spec.restore),frames};
}

export function generateAverageOracle(){verifySources();return [JSON.stringify({kind:'header',...ORACLE}),...cases.map(spec=>JSON.stringify(generateCase(spec)))].join('\n')+'\n';}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];
 if(process.argv.length>3||mode&&!['--check'].includes(mode))throw new Error('Usage: node test/fixtures/rust-indicators/generate-average.mjs [--check]');
 const generated=generateAverageOracle();
 if(mode==='--check'){
  const current=readFileSync(fixture,'utf8');if(current!==generated)throw new Error('average-oracle.jsonl is stale');
  console.log(`average oracle fresh: ${cases.length} cases`);
 }else process.stdout.write(generated);
}
