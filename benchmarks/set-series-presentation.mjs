// Structural work accounting; timing is one Node API-call sample, not a latency distribution.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const [rootArg,rowsArg,output]=process.argv.slice(2),root=resolve(rootArg),rows=Number(rowsArg);
assert([100000,1000000].includes(rows));assert(output);
const {ChartModel,ChartAPI,seededColumns}=await import(pathToFileURL(resolve(root,'src/core/index.mjs')));
const cases=[];
for(const fails of [false,true]){
 const model=new ChartModel(),calls={create:0,step:0,snapshot:0,restore:0};let armed=false,notifications=0;
 const error=new Error('dirty display calculation');
 model.indicators.register('probe',()=>({outputs:['value'],create(){calls.create++;if(armed&&fails)throw error;return {step(b){calls.step++;return [b.close];},snapshot(){calls.snapshot++;return 0;},restore(){calls.restore++;}};}}));
 const api=new ChartAPI(model,{invalidate:()=>notifications++});api.addIndicator('target','probe');
 // Empty-store binding establishes a normal displayed study without dirty-data calculation.
 api.addSeries({id:'target-line',panel:'price',type:'line',indicator:'target'});
 model.store.setColumns(seededColumns(rows,42));for(const key of Object.keys(calls))calls[key]=0;
 armed=true;notifications=0;const version=model.store.version,listeners=model.store.listeners.size,start=performance.now();let caught;
 try{api.setSeries('target-line',{visible:false,color:'red',width:2,label:'Hidden study'});}catch(e){caught=e;}
 const elapsedMs=performance.now()-start;
 assert.equal(model.store.version,version);assert.equal(model.store.listeners.size,listeners);
 cases.push({fails,calls:{...calls},elapsedMs,entryRetained:model.indicators.entries.has('target'),series:model.series.length,presentation:{visible:model.series[0].visible,color:model.series[0].color,width:model.series[0].width,label:model.series[0].label},notifications,errorIdentityPreserved:caught===error,error:caught?.message??null});
 model.dispose();assert.equal(model.store.listeners.size,0);
}
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt={schema:'aster.set-series-presentation-work.v1',root,rows,node:process.version,apiSHA:sha(resolve(root,'src/core/api.mjs')),harnessSHA:sha(import.meta.filename),cases,scope:'Exact trusted callback counts for dirty presentation patch; one un-warmed Node call per case, not comparative latency, renderer, native SDK or device performance.'};
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
