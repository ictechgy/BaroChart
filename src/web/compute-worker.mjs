import {BarStore} from '../core/data.mjs';import {ChartModel} from '../core/model.mjs';import {applyDataEvent} from '../core/markets.mjs';
import {packModel,transferBuffers,requestOptionsSnapshot} from './worker-state.mjs';
export async function computeRequest(request,progress=()=>{}){
 const options=requestOptionsSnapshot(request.options??{});
 const store=new BarStore();if(request.columns)store.setColumns(request.columns,request.length);else store.setData(request.bars??[]);if(request.event){if(request.event.kind==='batch'&&request.batchLimits)store.applyEvents(request.event.events,request.batchLimits);else applyDataEvent(store,request.event);}
 const model=new ChartModel({store,panels:options.panels,axes:options.axes,theme:options.theme,precision:options.precision,axisWidth:options.axisWidth,visibleBars:options.visibleBars});
 try{let done=0;for(const e of options.indicators??[]){progress({phase:'indicators',done,total:options.indicators.length});model.indicators.add(e.id,e.name,e.params);done++;}for(const s of options.series??[])model.addSeries(s);progress({phase:'indices',done,total:done});const packet=packModel(model);return packet;}finally{model.dispose();}
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=async ({data})=>{try{const packet=await computeRequest(data,p=>self.postMessage({progress:p}));self.postMessage({packet},transferBuffers(packet));}catch(error){self.postMessage({error:String(error.message).slice(0,256),...(error.name==='UnsupportedIndicatorError'?{errorName:error.name,errorCode:error.code}:{})});}};
