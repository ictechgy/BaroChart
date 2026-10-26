import {retireNativeEntryIfReplaced} from '../core/native-checkpoints.mjs';
import {assertChartAPIActive} from '../core/api.mjs';
import {BarStore,FIELDS} from '../core/data.mjs';
import {requirePortableFactory} from '../core/indicators.mjs';
import {indicatorModule} from '../core/indicator-modules.mjs';
import {validateIndicatorParams} from '../core/indicator-params.mjs';
import {RESOURCE_LIMITS,SERIES_KEYS,identifier,sizeLimit} from '../core/contracts.mjs';
import {runCalculationJob,runDedicatedCalculationWorker} from './calculation-job.mjs';
import {paramSlot,paramVector,paramSame,paramDefinition,paramLayout,paramLayoutSame} from './indicator-params-protocol.mjs';
import {validateIndicatorParamsPacket} from './indicator-params-packet.mjs';
const activeParameterJobs=new WeakMap();
function paramError(name,message){const e=new Error(message);e.name=name;return e;}
function paramConfiguration(model){return JSON.stringify({series:model.series.map(s=>Object.fromEntries(SERIES_KEYS.filter(k=>k!=='values'&&s[k]!==undefined).map(k=>[k,s[k]]))),panels:model.panels,axes:model.axes,valuesRevision:model.seriesValuesRevision??0});}
function observerDiagnostic(error){let name='ObserverError',message='Chart invalidation callback failed';try{const n=Object.getOwnPropertyDescriptor(error??{},'name'),m=Object.getOwnPropertyDescriptor(error??{},'message');if(n&&Object.hasOwn(n,'value')&&typeof n.value==='string')name=n.value.slice(0,64);if(m&&Object.hasOwn(m,'value')&&typeof m.value==='string')message=m.value.slice(0,256);}catch{}return Object.freeze({name,message});}
export function setIndicatorParamsAsync(chart,id,params,options={}){
 let model,token,notification,report;
 const release=()=>{if(token&&model&&activeParameterJobs.get(model)?.get(id)===token){const jobs=activeParameterJobs.get(model);jobs.delete(id);if(!jobs.size)activeParameterJobs.delete(model);}};
 const operation=runCalculationJob(options,async context=>{
  model=assertChartAPIActive(chart);identifier(id,'Indicator id');
  report=options.onObserverError;if(report!==undefined&&typeof report!=='function')throw new TypeError('Observer error callback required');notification=paramSlot(chart,'invalidate');if(typeof notification!=='function')throw new TypeError('Chart invalidation callback required');
  let jobs=activeParameterJobs.get(model);if(jobs?.has(id))throw paramError('BusyError','Indicator parameter job already active');if(!jobs){jobs=new Map();activeParameterJobs.set(model,jobs);}token={};jobs.set(id,token);
  const engine=model.indicators,store=model.store;if(!(store instanceof BarStore))throw new TypeError('Actual BarStore required');
  const columns=paramSlot(store,'columns'),length=paramSlot(store,'length'),capacity=paramSlot(store,'capacity'),version=paramSlot(store,'version'),entriesMap=engine.entries,registryMap=engine.registry,entry=entriesMap.get(id),series=model.series,bindings=series.slice(),entries=[...entriesMap],registry=[...registryMap],panels=model.panels,panelBindings=panels.slice(),axes=model.axes,axisBindings=axes.slice(),key=paramConfiguration(model);
  if(!entry)throw new Error('Missing indicator');if(engine.checkpointSize!==256)throw new RangeError('Async parameter checkpoint size must be256');
  sizeLimit(length,RESOURCE_LIMITS.maxBars,'Parameter source length');if(!Number.isSafeInteger(capacity)||capacity<16||capacity<length||capacity>RESOURCE_LIMITS.maxBars||(capacity&(capacity-1)))throw new RangeError('Parameter source capacity');
  const source=FIELDS.map(k=>paramVector(paramSlot(columns,k),Float64Array,length));
  let currentKey=key;const guard=()=>{if(assertChartAPIActive(chart)!==model||model.indicators!==engine||model.store!==store||paramSlot(store,'version')!==version||paramSlot(store,'length')!==length||paramSlot(store,'capacity')!==capacity||paramSlot(store,'columns')!==columns||FIELDS.some((k,i)=>paramSlot(columns,k)!==source[i])||engine.entries!==entriesMap||engine.registry!==registryMap||model.series!==series||series.length!==bindings.length||bindings.some((s,i)=>series[i]!==s)||entries.length!==entriesMap.size||entries.some(([k,e])=>entriesMap.get(k)!==e)||registry.length!==registryMap.size||registry.some(([k,f])=>registryMap.get(k)!==f)||model.panels!==panels||model.axes!==axes||panels.length!==panelBindings.length||panelBindings.some((p,i)=>panels[i]!==p)||axes.length!==axisBindings.length||axisBindings.some((a,i)=>axes[i]!==a)||currentKey!==key)throw paramError('StaleSourceError','Indicator parameters stale: owner changed');};context.guard=guard;context.current=()=>{currentKey=paramConfiguration(model);guard();};
  validateIndicatorParams(params);const requested={...params};validateIndicatorParams(requested);context.current();
  const oldLayout=paramLayout(entry.def);context.current();
  if(paramSame(entry.params,requested)){const metadata=paramLayout(entry.def);context.current();context.publish(()=>metadata);return;}
  requirePortableFactory(entry.name,registryMap.get(entry.name));const module=indicatorModule(entry.name),def=paramDefinition(entry.name,requested,module),layout=paramLayout(def),create=def.create;if(!paramLayoutSame(oldLayout,layout))throw new TypeError('Indicator parameter update cannot change output schema or plot offsets');context.current();
  const outputBytes=()=>{const count=[...entriesMap].reduce((n,[key,e])=>n+(key===id?layout.outputs.length:e.def.outputs.length),0);if(entriesMap.size>RESOURCE_LIMITS.maxIndicators||count*capacity*8>engine.maxOutputBytes)throw new RangeError('Indicator output byte limit');};outputBytes();
  const checkpoints=length===0?0:Math.floor(length/256)+1;
  // Typed transport + capacity-sized outputs and bounded codec transients.
  // Existing chart buffers and arbitrary trusted factory state are not RSS limits.
  context.reserve(length*48+capacity*layout.outputs.length*16+128*1024*1024+16*(checkpoints+1));
  const factory=options.workerFactory;if(factory!==undefined&&typeof factory!=='function')throw new TypeError('Worker factory required');const transport={workerFactory:factory??(()=>new Worker(new URL('./indicator-params-worker.mjs',import.meta.url),{type:'module'}))};
  const owned={};let done=0;context.progress('snapshot',0,length*6);for(let j=0;j<FIELDS.length;j++){const to=new Float64Array(length);owned[FIELDS[j]]=to;for(let start=0;start<length;start+=16384){context.check();context.current();const end=Math.min(length,start+16384);for(let i=start;i<end;i++)to[i]=source[j][i];done+=end-start;context.progress('snapshot',done,length*6);await context.yield();}}
  const binding={id,name:entry.name,params:{...requested},module:module??undefined,length,capacity,checkpointSize:256};context.progress('compute',0,1);
  const packet=await runDedicatedCalculationWorker({schema:'aster.params-request',version:1,jobId:context.id,kind:'indicator-params',binding,columns:owned},new URL('./indicator-params-worker.mjs',import.meta.url),transport,context,FIELDS.map(k=>owned[k].buffer));context.progress('compute',1,1);
  const replacement=await validateIndicatorParamsPacket(packet,{jobId:context.id,binding,def,layout,signal:options.signal},context),metadata=paramLayout(def);if(def.create!==create||!paramLayoutSame(metadata,layout)||!paramSame(metadata.plotOffsets,layout.plotOffsets))throw new TypeError('Indicator definition changed during staging');context.check();context.current();
  context.publish(()=>{outputBytes();context.current();context.check();guard();entriesMap.set(id,replacement);retireNativeEntryIfReplaced(entriesMap,id);for(const s of series)if(s.indicator===id){s.rangeIndex=null;s.revision=undefined;s.dirtyFrom=0;}return metadata;});
 });
 return operation.then(result=>{release();try{notification.call(chart);}catch(error){const diagnostic=observerDiagnostic(error);result={...result,observerError:diagnostic};try{report?.(diagnostic);}catch{}}return result;},error=>{release();throw error;});
}
