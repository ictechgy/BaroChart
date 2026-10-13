import {setIndicatorParamsAsync} from '../src/index.mjs';
function cancelled(){const error=new Error('Indicator edit superseded or disposed');error.name='AbortError';return error;}
// Host-owned latest-request coordinator. The SDK itself rejects concurrent jobs
// for one target. Wait for cancellation/termination before launching the next.
export function createIndicatorParamsEditor(chart,id,options={}){
 let generation=0,active=null,settling=Promise.resolve(),disposed=false;
 return {
  update(params){
   if(disposed)return Promise.reject(cancelled());const mine=++generation;active?.controller.abort();const previous=settling;
   const operation=(async()=>{try{await previous;}catch{}if(disposed||mine!==generation)throw cancelled();const controller=new AbortController();active={generation:mine,controller};try{return await setIndicatorParamsAsync(chart,id,params,{...options,signal:controller.signal});}finally{if(active?.generation===mine)active=null;}})();
   settling=operation;return operation;
  },
  async dispose(){disposed=true;generation++;active?.controller.abort();try{await settling;}catch{}},
 };
}
