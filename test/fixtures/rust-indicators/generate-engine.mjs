// Generates the checked-in IndicatorEngine oracle from the current JS runtime.
// Usage: ~/.nvm/versions/node/v22.20.0/bin/node test/fixtures/rust-indicators/generate-engine.mjs
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {BarStore,FIELDS,seededColumns} from '../../../src/core/data.mjs';
import {IndicatorEngine} from '../../../src/core/indicators.mjs';
import {safeCheckpointStringify} from '../../../src/core/checkpoint-validation.mjs';

const root=new URL('../../../',import.meta.url);
const hash=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
const row=(columns,index)=>Object.fromEntries(FIELDS.map(key=>[key,columns[key][index]]));
const storeFrom=(columns,length)=>new BarStore(Array.from({length},(_,index)=>row(columns,index)));
const summary=(engine,id,samples=null)=>{
 const result=engine.get(id),entry=engine.entries.get(id),indices=samples??Array.from({length:entry.length},(_,index)=>index);
 return {
  revision:result.revision,computedFrom:result.computedFrom,computedUntil:result.computedUntil,
  storeVersion:engine.store.version,storeLength:engine.store.length,
  outputOrder:Object.keys(result.outputs),plotOffsets:result.plotOffsets,
  outputsLossless:Object.fromEntries(Object.entries(result.outputs).map(([name,values])=>[name,safeCheckpointStringify(indices.map(index=>values[index]))])),
  sampleIndices:indices,
  checkpoints:[...entry.checkpoints].map(([index,state])=>({index,stateLossless:safeCheckpointStringify(state)})),
  dirty:entry.dirty,dirtyTo:entry.dirtyTo,invalidated:entry.invalidated,length:entry.length,
 };
};

console.log(JSON.stringify({
 schema:'barochart.rust-indicator-engine-oracle',version:1,
 oracleCommit:'bf851d9fda8547180207de165c46ff8dc7c09b1b',
 rustBaseCommit:'cd68770',
 bundleSha256:await hash('native/Resources/aster-core.js'),
 indicatorSourceSha256:await hash('src/core/indicators.mjs'),
 querySourceSha256:await hash('src/core/api.mjs'),
 dataSourceSha256:await hash('src/core/data.mjs'),
 seed:77,numberDialect:'Ecma',platform:'darwin-arm64',
 callSequences:['cold:add/get','incremental:add then append/get x9999','mutations:update/get,prepend/get,reset/get,batch/get'],
 runtime:{node:process.version,v8:process.versions.v8,unicode:process.versions.unicode},
 icu:process.versions.icu??null,tzdata:process.versions.tz??null,
}));

const coldColumns=seededColumns(3,77),coldStore=storeFrom(coldColumns,3),coldEngine=new IndicatorEngine(coldStore);
for(const name of coldEngine.registry.keys()){
 const id='cold:'+name;coldEngine.add(id,name,{});
 console.log(JSON.stringify({scenario:'cold-all',name,index:3,...summary(coldEngine,id)}));
}

const incrementalColumns=seededColumns(10000,91),incrementalStore=storeFrom(incrementalColumns,1),incrementalEngine=new IndicatorEngine(incrementalStore);
incrementalEngine.add('ema','ema',{period:20});
for(let index=1;index<10000;index++){incrementalStore.append(row(incrementalColumns,index));incrementalEngine.get('ema');}
console.log(JSON.stringify({scenario:'append-10000',name:'ema',index:10000,
 ...summary(incrementalEngine,'ema',[0,1,19,20,255,256,4095,4096,9998,9999])}));

const mutationColumns=seededColumns(600,123),mutationStore=storeFrom(mutationColumns,600),mutationEngine=new IndicatorEngine(mutationStore);
mutationEngine.add('sma','sma',{period:20});
const mutationRow=(phase)=>console.log(JSON.stringify({scenario:'mutations',phase,name:'sma',index:mutationStore.length,
 ...summary(mutationEngine,'sma',[0,1,19,20,Math.floor(mutationStore.length/2),mutationStore.length-2,mutationStore.length-1])}));
const corrected=mutationStore.at(300);corrected.close=(corrected.open+corrected.close)/2;mutationStore.update(300,corrected);mutationRow('deep-update');
const first=mutationStore.at(0),prepend=[
 {time:first.time-120000,open:first.open,high:first.high,low:first.low,close:first.close,volume:first.volume},
 {time:first.time-60000,open:first.open,high:first.high,low:first.low,close:first.close,volume:first.volume},
];mutationStore.prepend(prepend);mutationRow('prepend');
const resetColumns=seededColumns(40,124);mutationStore.setColumns(resetColumns,40);mutationRow('reset');
const last=mutationStore.at(mutationStore.length-1),appended={time:last.time+60000,open:last.close,high:last.close+1,low:last.close-1,close:last.close+.25,volume:321},updated={...appended,close:last.close+.5},batchCorrection=mutationStore.at(10);batchCorrection.close=(batchCorrection.open+batchCorrection.close)/2;
mutationStore.applyEvents([{kind:'append',bar:appended},{kind:'update',bar:updated},{kind:'correction',bar:batchCorrection}]);mutationRow('batch');
