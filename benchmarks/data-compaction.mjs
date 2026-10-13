// Absolute synchronous compaction cost and logical ownership, not RSS or UI FPS.
import {performance} from 'node:perf_hooks';
import {ChartModel,ChartAPI,seededColumns} from '../src/core/index.mjs';
const count=Number(process.argv[2]??100000),keep=Math.floor(count/4);
if(!Number.isSafeInteger(count)||count<64||count>1000000)throw Error('count 64..1000000');
const model=new ChartModel(),api=new ChartAPI(model);model.store.setColumns(seededColumns(count));
let callbacks=0;model.indicators.register('retention-probe',()=>({outputs:['value'],create(){callbacks++;let last=NaN;return {step(bar){callbacks++;last=bar.close;return [last];},snapshot(){callbacks++;return last;},restore(value){callbacks++;last=value;}};}}));
api.addIndicator('probe','retention-probe');api.addSeries({id:'probe',type:'line',panel:'price',indicator:'probe'});model.seriesData(model.series[0]);
const entry=model.indicators.entries.get('probe'),before={sourceBytes:model.store.bytes,outputBytes:entry.arrays.reduce((n,a)=>n+a.byteLength,0),checkpointCount:entry.checkpoints.size,rangeIndexPresent:!!model.series[0].rangeIndex};callbacks=0;
const start=performance.now(),receipt=api.compactData({keepLastBars:keep,studyHistory:'restart'}),elapsedMs=performance.now()-start;
const after={sourceBytes:model.store.bytes,outputBytes:entry.arrays.reduce((n,a)=>n+a.byteLength,0),checkpointCount:entry.checkpoints.size,rangeIndexPresent:!!model.series[0].rangeIndex,callbacks};
if(after.callbacks||after.outputBytes||after.checkpointCount||after.rangeIndexPresent||receipt.length!==keep)throw Error('compaction ownership/callback contract');
const readStart=performance.now(),values=model.indicators.get('probe').outputs.value,firstReadMs=performance.now()-readStart;
for(let i=0;i<keep;i++)if(!Object.is(values[i],model.store.columns.close[i]))throw Error('fresh suffix oracle');
model.dispose();if(model.store.listeners.size)throw Error('cleanup');
console.log(JSON.stringify({case:'data-compaction',node:process.version,count,keep,elapsedMs,firstReadMs,before,after,receipt,scope:'single-process synchronous Node core; source typed byte accounting excludes held views, checkpoints objects, GC and RSS; no UI/device proof'}));
