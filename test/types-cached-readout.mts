import type {ChartAPI,DataQueryOptions,DataSeriesValue} from '../src/core/index.mjs';

declare const api:ChartAPI;
const cached:DataQueryOptions={indicatorMode:'cached',includeHidden:true,asOfIndex:4};
const calculated:DataQueryOptions={indicatorMode:'calculate'};
const result=api.dataAt({index:4},cached)??api.dataAt({index:4},calculated);
const row:DataSeriesValue|undefined=result?.series[0];
if(row?.status==='pending'){
 const value:null|number=row.value;
 const sourceIndex:null|number=row.sourceIndex;
 void value;void sourceIndex;
}
if(row?.status==='unsupported-cache'){
 const value:null|number=row.value;
 const sourceIndex:null|number=row.sourceIndex;
 void value;void sourceIndex;
}
// @ts-expect-error indicator mode is a closed public union
api.dataAt({index:4},{indicatorMode:'stale'});
