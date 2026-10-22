// Example-local recipe, not a new package API or a live-series subscription.
import {alignSeriesByTime} from '../../src/core/index.mjs';
const comparisonLimit=65536;
export function normalizeComparisonSeries(referenceTimes,points,options){
 if(!(Array.isArray(referenceTimes)||referenceTimes instanceof Float64Array)||!Array.isArray(points)||referenceTimes.length>comparisonLimit||points.length>comparisonLimit)throw new TypeError('Comparison inputs are limited to 65536 points each');
 if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).length!==1)throw new TypeError('Comparison requires only baselineTime');
 const property=Object.getOwnPropertyDescriptor(options,'baselineTime'),baselineTime=property?.value;
 if(!property?.enumerable||!Object.hasOwn(property,'value')||!Number.isSafeInteger(baselineTime)||Math.abs(baselineTime)>8640000000000000)throw new TypeError('Comparison baselineTime must be an exact UTC millisecond');
 // Capture the reference once. Alignment reads these private times, and the
 // baseline comes from the same captured/aligned observations as every output.
 const referenceLength=referenceTimes.length,pointLength=points.length,times=new Float64Array(referenceLength),capturedPoints=new Array(pointLength);
 for(let i=0;i<referenceLength;i++){const time=referenceTimes[i];if(typeof time!=='number')throw new TypeError('Comparison reference timestamps must be numbers');times[i]=time;}
 for(let i=0;i<pointLength;i++)capturedPoints[i]=points[i];
 const rawValues=alignSeriesByTime(times,capturedPoints),index=times.indexOf(baselineTime);
 if(index<0||!Number.isFinite(rawValues[index])||rawValues[index]===0)throw new RangeError('Comparison baseline must match both timelines with a finite nonzero value');
 const base=rawValues[index],values=new Float64Array(rawValues.length);
 for(let i=0;i<values.length;i++){
  const value=rawValues[i];if(Number.isNaN(value)){values[i]=NaN;continue;}
  const difference=value-base,change=(Number.isFinite(difference)?difference/base:value/base-1)*100;
  if(!Number.isFinite(change))throw new RangeError('Comparison percent change overflow');
  values[i]=value===base?0:change;
 }
 return Object.freeze({values,rawValues,baseline:Object.freeze({time:baselineTime,value:base}),alignment:'exact-utc',transformation:'signed-percent-change'});
}

export function createComparisonFixture(){
 const times=[0,1,2,3,4,7,8,9,10,11,14,15].map(day=>Date.UTC(2026,9,1+day,16)),a=[100,104,98,110,106,108,114,112,116,118,120,122],b=[200,206,null,220,214,216,null,218,228,232,null,240];
 const bars=times.map((time,i)=>({time,open:a[i],high:a[i]+2,low:a[i]-2,close:a[i],volume:100+i}));
 return {times,bars,series:[{id:'a',symbolId:'SYNTH:A',color:'#58cadb',points:times.map((time,i)=>({time,value:a[i]}))},{id:'b',symbolId:'SYNTH:B',color:'#f0b755',points:times.filter((_,i)=>i!==6).map(time=>({time,value:b[times.indexOf(time)]}))}],baselineTimes:times.filter((_,i)=>b[i]!==null)};
}
