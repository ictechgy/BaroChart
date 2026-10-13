// Independent observable metric: actual owned range-index bytes, not an estimate.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const root=resolve(process.argv[2]??'.');const A=await import(pathToFileURL(resolve(root,'src/core/index.mjs')));
const s=new A.BarStore();s.setColumns(A.seededColumns(100000,42));const m=new A.ChartModel({store:s});
for(let i=0;i<32;i++)m.addSeries({id:'v'+i,type:'line',panel:'price',values:Float64Array.from(s.columns.close.subarray(0,s.length),v=>v+i*.1)});
let bytes=0;for(const series of m.series){const {values,index}=m.seriesData(series);bytes+=index.bytes;for(const [from,to] of [[0,100000],[99799,100000],[1234,2345]]){const q=index.query(from,to);let lo=Infinity,hi=-Infinity;for(let j=from;j<to;j++){lo=Math.min(lo,values[j]);hi=Math.max(hi,values[j]);}assert.equal(q.min,lo);assert.equal(q.max,hi);assert.equal(index.hasGaps(from,to),false);}}
m.dispose();assert.equal(s.listeners.size,0);console.log('range_index_bytes='+bytes);
