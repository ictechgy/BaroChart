import test from 'node:test';import assert from 'node:assert/strict';
import {BlockRangeIndex,BarStore,ChartModel,seededColumns,buildScene} from '../src/index.mjs';
test('block tree matches brute force on unaligned ranges, NaN gaps and corrected blocks',()=>{
 const values=new Float64Array(4096);for(let i=0;i<4001;i++)values[i]=i%17===0?NaN:Math.sin(i)*10;
 const index=new BlockRangeIndex(4001,values,4096);for(let i=0;i<300;i++){const from=i*17%3800,to=from+(i*13%200)+1,q=index.query(from,to),v=Array.from(values.subarray(from,to)).filter(Number.isFinite);assert.equal(q.min,Math.min(...v));assert.equal(q.max,Math.max(...v));}
 values[77]=900;index.update(77);assert.equal(index.query(64,96).max,900);values[4001]=-999;index.update(4001);assert.equal(index.query(3999,4002).min,-999);
});
test('million-value index allocation is reduced and appends/current/history corrections remain exact',()=>{
 const s=new BarStore();s.setColumns(seededColumns(262144));const m=new ChartModel({store:s});m.indicators.add('e','ema');m.addSeries({id:'e',type:'line',panel:'price',indicator:'e'});buildScene(m,1200,700);const idx=m.series[0].rangeIndex;
 assert.ok(idx instanceof BlockRangeIndex);assert.ok(idx.bytes<2*1024*1024);
 const last=s.at(s.length-1);s.append({...last,time:last.time+60000});buildScene(m,1200,700);let values=m.indicators.get('e').outputs.value;assert.equal(m.series[0].rangeIndex.query(s.length-1,s.length).max,values.at(-1));
 s.update(100,{...s.at(100),close:1000,high:1000});buildScene(m,1200,700);values=m.indicators.get('e').outputs.value;assert.equal(m.series[0].rangeIndex.query(99,102).max,Math.max(...values.subarray(99,102)));m.dispose();
});
test('drawing history structurally shares unchanged items and respects a byte budget',async()=>{
 const {DrawingStore}=await import('../src/index.mjs'),d=new DrawingStore({historyBytes:1000});d.add({type:'text',points:[{time:1,price:1}],text:'one'});d.add({type:'text',points:[{time:2,price:2}],text:'two'});const unchanged=d.items[0];for(let i=0;i<20;i++)d.edit(d.items[1].id,{text:'new '+i});assert.equal(d.items[0],unchanged);assert.ok(d.retainedHistoryBytes<=1000);assert.ok(d.undoStack.length<20);assert.ok(Object.isFrozen(unchanged));const saved=d.save();d.undo();d.redo();assert.equal(d.save(),saved);
});
