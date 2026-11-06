import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingStore,drawingHitTest} from '../src/core/index.mjs';

const SAMPLE_COUNT=1<<18;

// This oracle does not use the production distance equation. The closest
// sample is an upper bound, while subtracting half a sample interval's maximum
// arc length gives a lower bound for the continuous ellipse.
function sampledDistanceIntervals({centerX,centerY,radiusX,radiusY},probes){
 const upper=probes.map(()=>Infinity);
 for(let i=0;i<SAMPLE_COUNT;i++){
  const angle=2*Math.PI*i/SAMPLE_COUNT,x=centerX+radiusX*Math.cos(angle),y=centerY+radiusY*Math.sin(angle);
  for(let j=0;j<probes.length;j++)upper[j]=Math.min(upper[j],Math.hypot(probes[j][0]-x,probes[j][1]-y));
 }
 const gap=Math.max(radiusX,radiusY)*Math.PI/SAMPLE_COUNT;
 return upper.map(value=>({lower:Math.max(0,value-gap),upper:value}));
}

function fixture(a,b){
 const margin=100,panel={id:'price',left:Math.min(a[0],b[0])-margin,right:Math.max(a[0],b[0])+margin,top:Math.min(a[1],b[1])-margin,bottom:Math.max(a[1],b[1])+margin};
 const layout={panels:[panel],drawingAxis:()=>panel,toScreen:point=>({x:point.time,y:point.price})};
 const store=new DrawingStore(),id=store.add({type:'ellipse',points:[a,b].map(([time,price])=>({time,price})),style:{width:1.5}});store.selected=null;
 return {id,hit:(x,y)=>drawingHitTest(store,layout,x,y,1)};
}

for(const orientation of ['horizontal','vertical'])test(`high-aspect ${orientation} ellipse uses Euclidean outline distance`,()=>{
 const horizontal=orientation==='horizontal',a=horizontal?[-1000,-10]:[-10,-1000],b=horizontal?[1000,10]:[10,1000];
 const probes=(horizontal?[[900,0],[900,4],[900,5],[900,6]]:[[0,900],[4,900],[5,900],[6,900]]);
 const intervals=sampledDistanceIntervals({centerX:0,centerY:0,radiusX:horizontal?1000:10,radiusY:horizontal?10:1000},probes);
 assert.ok(intervals[0].lower>1,`interior false-positive probe is ${JSON.stringify(intervals[0])}px from the outline`);
 assert.ok(intervals[1].upper<1&&intervals[2].upper<1,'near-boundary probes are independently within 1px');
 assert.ok(intervals[3].lower>1,'far exterior probe is independently beyond 1px');
 const f=fixture(a,b);
 assert.equal(f.hit(...probes[0]),null);
 assert.equal(f.hit(...probes[1])?.id,f.id);
 assert.equal(f.hit(...probes[2])?.id,f.id);
 assert.equal(f.hit(...probes[3]),null);
});

test('circle, reversed signed bounds, and large finite coordinates keep the 1px boundary',()=>{
 const cases=[
  {a:[-30,-40],b:[-10,-20],near:[-20,-39.25],far:[-20,-38.75]},
  {a:[2**45+1000,2**45+10],b:[2**45-1000,2**45-10],near:[2**45+900,2**45+4],far:[2**45+900,2**45+6]},
 ];
 for(const entry of cases){
  const f=fixture(entry.a,entry.b);
  assert.equal(f.hit(...entry.near)?.id,f.id);
  assert.equal(f.hit(...entry.far),null);
 }
});
