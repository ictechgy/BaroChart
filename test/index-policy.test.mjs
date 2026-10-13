import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,RangeIndex,seededColumns} from '../src/core/data.mjs';
import {BlockRangeIndex} from '../src/core/block-index.mjs';
import {ChartModel,createLayout} from '../src/core/model.mjs';
import {buildScene} from '../src/core/scene.mjs';
import {AsyncCapture,AsyncPrepared} from '../src/core/async-state.mjs';
import {PrepareCapture,PreparedData} from '../src/core/prepare-state.mjs';
import {packModel,modelRequest,hydrateModel,installRecomputed,validatePreparedPacketAsync} from '../src/web/worker-state.mjs';

const THRESHOLD=65536;
function modelWith(length){const store=new BarStore();store.setColumns(seededColumns(length));return new ChartModel({store,panels:[{id:'price',weight:1,padding:0}]});}
function range(values,from,to){let min=Infinity,max=-Infinity,count=0;for(let i=from;i<to;i++){const v=values[i];if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);count++;}}return {min,max,count};}
function exact(index,values,from,to){const wanted=range(values,from,to);assert.deepEqual(index.query(from,to),{min:wanted.min,max:wanted.max,sum:0});assert.equal(index.finiteCount(from,to),wanted.count);assert.equal(index.hasGaps(from,to),wanted.count!==to-from);}
function copy(capture){const p=new AsyncPrepared(capture.metadataJSON);for(let slot=0;slot<capture.buffers.length;slot++)for(let from=0;from<capture.buffers[slot].length;from+=262144){const n=Math.min(262144,capture.buffers[slot].length-from);p.target(slot,from,n).set(capture.buffer(slot,from,n));}for(let entry=0;entry<capture.checkpoints.length;entry++)for(let from=0;from<capture.checkpoints[entry].keys.length;from+=64)p.checkpoint(entry,capture.checkpoint(entry,from,Math.min(64,capture.checkpoints[entry].keys.length-from)));return p;}

for(const length of [THRESHOLD-1,THRESHOLD,THRESHOLD+1,100000])test(`series index policy at ${length} preserves full and recent ranges`,()=>{
 const m=modelWith(length);m.addSeries({id:'close',type:'line',panel:'price',source:'close'});
 const {values,index}=m.seriesData(m.series[0]);assert.equal(index instanceof BlockRangeIndex,length>=THRESHOLD);
 exact(index,values,0,length);exact(index,values,length-201,length);exact(index,values,31,65);m.dispose();
});

test('32 aligned100k lines meet the independent75-percent index-byte target',()=>{
 const m=modelWith(100000);for(let i=0;i<32;i++)m.addSeries({id:'market-'+i,type:'line',panel:'price',values:Float64Array.from(m.store.columns.close.subarray(0,100000),v=>v+i*.1)});
 let bytes=0;for(const s of m.series){const {values,index}=m.seriesData(s);bytes+=index.bytes;exact(index,values,99799,100000);}
 const baselineBytes=201326592;assert(bytes<=baselineBytes*.25,`owned index bytes ${bytes} exceed75-percent reduction target`);assert.equal(bytes,6291456);for(const s of m.series)assert(s.rangeIndex instanceof BlockRangeIndex);m.dispose();
});

test('threshold crossing converts an existing flat cache before its capacity grows',()=>{
 const m=modelWith(THRESHOLD-1);m.addSeries({id:'close',type:'line',panel:'price',source:'close'});const s=m.series[0],old=m.seriesData(s).index,capacity=m.store.capacity,last=m.store.at(m.store.length-1);
 assert(old instanceof RangeIndex);m.store.append({...last,time:last.time+60000});assert.equal(m.store.capacity,capacity);
 const current=m.seriesData(s);assert(current.index instanceof BlockRangeIndex);assert(current.index.bytes<old.bytes*.25);exact(current.index,current.values,0,THRESHOLD);exact(current.index,current.values,THRESHOLD-201,THRESHOLD);
 const index=current.index;m.store.update(THRESHOLD-10,{...m.store.at(THRESHOLD-10),high:1000,close:1000});assert.equal(m.seriesData(s).index,index);exact(index,m.seriesData(s).values,THRESHOLD-201,THRESHOLD);m.dispose();
});

test('100k sparse aligned values keep gap bounds and offset autoscale',()=>{
 const m=modelWith(100000),values=Float64Array.from({length:100000},(_,i)=>100+Math.sin(i*.03));for(const i of [31,32,65535,65536,99830])values[i]=NaN;
 m.addSeries({id:'market',type:'line',panel:'price',values,offset:17});const s=m.series[0],index=m.seriesData(s).index;assert(index instanceof BlockRangeIndex);
 for(const [from,to] of [[0,100000],[30,65],[65530,65545],[99799,100000]])exact(index,values,from,to);
 m.setVisibleRange(99800,99999);const from=Math.floor(m.view.from-17),to=Math.ceil(m.view.to+1-17),wanted=range(values,from,to),layout=createLayout(m,1200,700);
 assert.equal(layout.panels[0].min,wanted.min);assert.equal(layout.panels[0].max,wanted.max);buildScene(m,1200,700);assert.equal(s.rangeIndex,index);
 values[99830]=101;m.setSeriesValues(s.id,values);exact(m.seriesData(s).index,values,from,to);assert.equal(m.seriesData(s).index.hasGaps(from,to),false);m.dispose();
});

test('blocked incremental indicator correction gap recovery and append retain the cache',()=>{
 const m=modelWith(100000);m.indicators.register('gap-close',()=>({outputs:['value'],create:()=>({step:b=>[b.volume===0?NaN:b.close],snapshot:()=>0,restore(){}})}));m.indicators.add('g','gap-close');m.addSeries({id:'g',type:'line',panel:'price',indicator:'g'});
 const s=m.series[0],index=m.seriesData(s).index;assert(index instanceof BlockRangeIndex);
 for(const volume of [0,123]){m.store.update(99990,{...m.store.at(99990),volume});const data=m.seriesData(s);assert.equal(data.index,index);exact(index,data.values,99799,100000);assert.equal(index.hasGaps(99989,99992),volume===0);}
 const last=m.store.at(99999);m.store.append({...last,time:last.time+60000,volume:0});const data=m.seriesData(s);assert.equal(data.index,index);exact(index,data.values,99800,100001);assert.equal(index.hasGaps(100000,100001),true);m.dispose();
});

test('native prepare uses the same threshold and reuses ready indexes on first scene',()=>{
 for(const length of [THRESHOLD-1,THRESHOLD,100000]){const source=modelWith(0);source.indicators.add('s','sma',{period:20});source.addSeries({id:'s',type:'line',panel:'price',indicator:'s',offset:13});source.addSeries({id:'close',type:'line',panel:'price',source:'close'});
  const capture=new PrepareCapture(source,{kind:'seeded',count:length,seed:42}),p=new PreparedData(capture.metadataJSON);p.start();while(!p.step(4096).complete){}
  const indexes=p.model.series.map(s=>s.rangeIndex);for(const index of indexes)assert.equal(index instanceof BlockRangeIndex,length>=THRESHOLD);assert.equal(indexes[0].hasGaps(0,20),true);assert.equal(indexes[0].hasGaps(19,length),false);
  const done=p.finish(capture.ui(null,{width:1200,height:700})).model;buildScene(done,1200,700);for(let i=0;i<done.series.length;i++){const data=done.seriesData(done.series[i]);assert.equal(data.index,indexes[i]);exact(data.index,data.values,Math.max(0,length-201),length);}assert.equal(source.store.length,0);source.dispose();p.dispose();
 }
});

test('native correction converts an old100k flat cache on worker without touching source',()=>{
 const m=modelWith(100000);m.indicators.add('s','sma',{period:20});m.addSeries({id:'s',type:'line',panel:'price',indicator:'s'});const s=m.series[0],values=m.seriesData(s).values,legacy=new RangeIndex(values.length,values,values,null,m.store.capacity,true);s.rangeIndex=legacy;
 const capture=new AsyncCapture(m,{kind:'correction',bar:{...m.store.at(99990),volume:123}}),p=copy(capture);p.start();while(!p.step(4096).complete){}const target=p.model.series[0],index=target.rangeIndex;assert(index instanceof BlockRangeIndex);assert.equal(m.series[0].rangeIndex,legacy);assert.equal(p.model.seriesData(target).index,index);exact(index,p.model.seriesData(target).values,0,100000);m.dispose();p.dispose();
});

test('web cache restore and corrupt-count rejection remain atomic at100k',async()=>{
 const m=modelWith(100000),values=Float64Array.from({length:100000},(_,i)=>i%257?100+i*.001:NaN);m.addSeries({id:'aligned',type:'line',panel:'price',values,offset:-9});const options=modelRequest(m),packet=structuredClone(packModel(m)),validation=await validatePreparedPacketAsync(packet,options,{yieldTask:()=>Promise.resolve()}),done=hydrateModel(packet,options,validation),s=done.series[0],index=s.rangeIndex;
 assert(index instanceof BlockRangeIndex);buildScene(done,1200,700);assert.equal(done.seriesData(s).index,index);exact(index,done.seriesData(s).values,0,100000);exact(index,done.seriesData(s).values,99799,100000);
 const corrupt=structuredClone(packet),version=m.store.version,columns=m.store.columns,sourceIndex=m.series[0].rangeIndex;corrupt.indices[0].tree.sum[1]++;await assert.rejects(validatePreparedPacketAsync(corrupt,options,{yieldTask:()=>Promise.resolve()}),/count/i);
 assert.throws(()=>installRecomputed(m,corrupt,{kind:'correction',bar:{...m.store.at(99990),volume:123}},options),/count/i);assert.equal(m.store.version,version);assert.equal(m.store.columns,columns);assert.equal(m.series[0].rangeIndex,sourceIndex);m.dispose();done.dispose();
});
