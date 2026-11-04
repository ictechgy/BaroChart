// Node 22 oracle for Tier-A semantic exploration and in-place compaction.
// Usage: ~/.nvm/versions/node/v22.20.0/bin/node test/fixtures/rust-core-vectors/generate-explorer-compaction.mjs [--check]
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BarStore,ChartModel,ChartAPI} from '../../../src/core/index.mjs';
import {safeCheckpointStringify} from '../../../src/core/checkpoint-validation.mjs';

const directory=fileURLToPath(new URL('.',import.meta.url)),root=new URL('../../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',import.meta.url),'utf8'));
const hash=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
const bars=length=>Array.from({length},(_,index)=>({time:1700000000000+index*60000,open:index+10,high:index+12,low:index+9,close:index+11,volume:index+1}));
const fixture=(length=40)=>{const model=new ChartModel({store:new BarStore(bars(length))}),api=new ChartAPI(model);api.addIndicator('ema','ema',{period:2});api.addIndicator('pressure','aster.volume-direction@1/pressure',{shift:1});api.addSeries({id:'close',type:'line',panel:'price',source:'close'});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',output:'value'});api.addSeries({id:'pressure-line',type:'line',panel:'price',indicator:'pressure',output:'cumulative',offset:1});api.addSeries({id:'external',type:'line',panel:'price',values:Array.from({length},(_,i)=>20+i),symbolId:'OTHER',visible:false});return{model,api};};
const state=model=>({
 store:{
  length:model.store.length,capacity:model.store.capacity,version:model.store.version,timeVersion:model.store.timeVersion,
  columns:Object.fromEntries(['time','open','high','low','close','volume'].map(key=>[key,safeCheckpointStringify([...model.store.columns[key]])])),
  index:{min:safeCheckpointStringify([...model.store.index.min]),max:safeCheckpointStringify([...model.store.index.max]),sum:safeCheckpointStringify([...model.store.index.sum])},
 },
 entries:[...model.indicators.entries].map(([id,entry])=>({id,revision:entry.revision,dirty:entry.dirty,dirtyTo:entry.dirtyTo,invalidated:entry.invalidated,length:entry.length,computedFrom:entry.computedFrom,computedUntil:entry.computedUntil,arrays:entry.arrays.map(values=>safeCheckpointStringify([...values])),checkpoints:[...entry.checkpoints].map(([index,value])=>[index,safeCheckpointStringify(value)])})),
 series:model.series.map(series=>({id:series.id,rangeIndex:series.rangeIndex===null?null:!!series.rangeIndex,revision:series.revision,dirtyFrom:series.dirtyFrom})),
 view:model.view,follow:model.follow,crosshair:model.crosshair,
});
const rows=[];
{
 const f=fixture(4);f.api.setSymbol({id:'PRIMARY',exchange:'TEST',timezone:'UTC',currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw'});
 rows.push({suite:'explorer',name:'index-negative-zero',resultLossless:safeCheckpointStringify(f.api.dataAt({index:-0}))});
 rows.push({suite:'explorer',name:'time-at-or-before',resultLossless:safeCheckpointStringify(f.api.dataAt({time:1700000000000+90000,match:'at-or-before'},{includeHidden:true}))});
 const b=f.model.store.at(0);f.model.store.update(0,b);const before=f.model.indicators.entries.get('ema').revision,cached=f.api.dataAt({index:1},{indicatorMode:'cached'}),afterCached=f.model.indicators.entries.get('ema').revision,calculated=f.api.dataAt({index:1}),afterCalculate=f.model.indicators.entries.get('ema').revision;
 rows.push({suite:'explorer',name:'cached-then-calculate',before,afterCached,afterCalculate,cachedLossless:safeCheckpointStringify(cached),calculatedLossless:safeCheckpointStringify(calculated)});f.model.dispose();
}
{
 const f=fixture(40);f.model.series=f.model.series.filter(series=>series.id!=='external');f.model.series[0].rangeIndex={sentinel:true};f.model.series[0].revision=9;f.model.series[0].dirtyFrom=7;const before=state(f.model),receipt=f.api.compactData({keepLastBars:12,studyHistory:'restart'}),after=state(f.model);rows.push({suite:'compaction',name:'restart-keep12',before,receiptLossless:safeCheckpointStringify(receipt),after});f.model.dispose();
}
{
 const f=fixture(8);const before=state(f.model),receipt=f.api.compactData({keepLastBars:8,studyHistory:'restart'}),after=state(f.model);rows.push({suite:'compaction',name:'noop',before,receiptLossless:safeCheckpointStringify(receipt),after});f.model.dispose();
}
{
 const f=fixture(40);f.model.series=f.model.series.filter(series=>series.id!=='external');f.api.configureDataIngestion({streamId:'feed',generation:7,firstSequence:-0,maxQueuedEvents:8,maxQueuedBytes:392,maxBatchEvents:8});const correction=f.model.store.at(30),last=f.model.store.at(39),append={...last,time:last.time+60000,close:last.close+1,high:last.high+1,volume:5},update={...append,close:append.close+.5,high:append.high+.5};f.api.enqueueDataEvents({streamId:'feed',generation:7,firstSequence:-0,events:[{kind:'correction',bar:correction},{kind:'append',bar:append},{kind:'update',bar:update}]});f.api.pauseDataIngestion();const ingestionBefore=f.api.saveDataIngestion(),receipt=f.api.compactData({keepLastBars:12,studyHistory:'restart',pendingData:'preserve-retained'}),ingestionAfter=f.api.saveDataIngestion();f.api.resumeDataIngestion();const drain=f.api.drainDataEvents();rows.push({suite:'compaction',name:'pending-preserve',receiptLossless:safeCheckpointStringify(receipt),ingestionBefore,ingestionAfter,drainLossless:safeCheckpointStringify(drain),after:state(f.model)});f.model.dispose();
}

const metadata={schema:'aster.rust-explorer-compaction-leaf',version:1,oracleCommit:manifest.oracleCommit,bundleSha256:await hash('native/Resources/aster-core.js'),explorerSourceSha256:await hash('src/core/data-explorer.mjs'),compactionSourceSha256:await hash('src/core/compaction.mjs'),nativeBridgeSha256:await hash('examples/native/exploration-bridge.mjs'),seed:20261104,dialect:'Ecma',runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,tz:process.versions.tz,platform:process.platform,arch:process.arch}};
const text=[{metadata},...rows].map(row=>JSON.stringify(row)).join('\n')+'\n',path=directory+'explorer-compaction.leaf.jsonl';if(process.argv.includes('--check')){const stored=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse),current=text.trim().split('\n').map(JSON.parse);current[0].metadata.runtime=stored[0].metadata.runtime;if(JSON.stringify(current)!==JSON.stringify(stored))throw new Error('Explorer/compaction vectors are stale');}else await writeFile(path,text);process.stdout.write(`Explorer/compaction oracle: ${rows.length} sequences\n`);
