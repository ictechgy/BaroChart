import {retireNativeEntryIfReplaced} from './native-checkpoints.mjs';
import {IndicatorEngine,requirePortableFactory} from './indicators.mjs';
import {indicatorModule} from './indicator-modules.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {optionRecord,SERIES_KEYS,RESOURCE_LIMITS,portableStyle} from './contracts.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from './checkpoint-validation.mjs';

function studyPick(value,keys){return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));}
function studyModuleEqual(a,b){return a===undefined&&b===undefined||!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function studyConfigurationKey(model){return JSON.stringify({definitions:[...model.indicators.entries].map(([id,e])=>[id,e.name,e.params]),series:model.series.map(s=>studyPick(s,SERIES_KEYS.filter(k=>k!=='values'))),panels:model.panels,axes:model.axes,valuesRevision:model.seriesValuesRevision??0});}
export function saveStudySetup(model){
 if(model.disposed)throw new Error('Chart disposed');
 const indicators=[...model.indicators.entries].map(([id,e])=>{requirePortableFactory(e.name,model.indicators.registry.get(e.name));validateIndicatorParams(e.params);const module=indicatorModule(e.name);return {id,name:e.name,params:{...e.params},...(module?{module}:{})};});
 // Low-level renderers allow broader CSS than portable study documents.
 // Validate the detached export styles without rewriting live or saved values.
 const series=model.series.filter(s=>s.indicator).map(s=>{const copy=studyPick(s,SERIES_KEYS.filter(k=>k!=='values'));portableStyle(copy,['color','fill','upColor','downColor'],true);return copy;});
 // Use the reader's bounded codec so every successful save is readable and
 // finite parameter -0 keeps its observable sign across module restoration.
 return safeCheckpointStringify({schema:'aster.studies',version:1,indicators,series});
}
// Synchronous atomic parameter replacement. This preserves visual bindings;
// changed output layout/offsets require an explicit remove/reconfigure operation.
export function setStudyParams(model,id,params){
 if(model.disposed)throw new Error('Chart disposed');
 const engine=model.indicators,store=model.store,version=store.version,entriesMap=engine.entries,registryMap=engine.registry,entry=entriesMap.get(id);
 if(!entry)throw new Error('Missing indicator');
 const entries=[...entriesMap],registry=[...registryMap],series=model.series,bindings=series.slice(),key=studyConfigurationKey(model);
 const current=()=>!model.disposed&&model.indicators===engine&&model.store===store&&store.version===version&&engine.entries===entriesMap&&engine.registry===registryMap&&model.series===series&&series.length===bindings.length&&bindings.every((s,i)=>series[i]===s)&&entries.length===entriesMap.size&&entries.every(([k,e])=>entriesMap.get(k)===e)&&registry.length===registryMap.size&&registry.every(([k,f])=>registryMap.get(k)===f)&&studyConfigurationKey(model)===key;
 validateIndicatorParams(params);const requested={...params};validateIndicatorParams(requested);
 if(!current())throw new Error('Indicator params stale: owner changed during snapshot');
 const same=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));
 const metadata=def=>({outputs:[...def.outputs],plotOffsets:{...def.plotOffsets}});
 if(same(entry.params,requested)){const result=metadata(entry.def);if(!current())throw new Error('Indicator params stale: owner changed during metadata');return result;}
 const candidate=new IndicatorEngine(store,{checkpointSize:engine.checkpointSize,maxOutputBytes:engine.maxOutputBytes});
 candidate.registry=new Map(registry);candidate.entries=new Map(entries);candidate.entries.delete(id);
 try{
  candidate.add(id,entry.name,{...requested});const replacement=candidate.entries.get(id);
  validateIndicatorParams(replacement.params);
  if(!same(replacement.params,requested))throw new TypeError('Indicator factory changed requested params');
  if(entry.def.outputs.length!==replacement.def.outputs.length||entry.def.outputs.some((output,i)=>output!==replacement.def.outputs[i]))throw new TypeError('Indicator parameter update cannot change output schema');
  const offset=(def,output)=>def.plotOffsets&&Object.hasOwn(def.plotOffsets,output)?def.plotOffsets[output]:0;
  if(entry.def.outputs.some(output=>!Object.is(offset(entry.def,output),offset(replacement.def,output))))throw new TypeError('Indicator parameter update cannot change plot offsets');
  const result=metadata(replacement.def);
  if(!current())throw new Error('Indicator params stale: owner changed during staging');
  entriesMap.set(id,replacement);retireNativeEntryIfReplaced(entriesMap,id);
  for(const s of series)if(s.indicator===id){s.rangeIndex=null;s.revision=undefined;s.dirtyFrom=0;}
  return result;
 }finally{candidate.dispose();}
}
// Atomic additive import. Data, layout, existing studies and drawing history are
// host-owned; all required panel/axis bindings must already exist.
export function loadStudySetup(model,text){
 if(model.disposed)throw new Error('Chart disposed');
 const doc=safeCheckpointParse(text);optionRecord(doc,['schema','version','indicators','series'],'Study setup');
 if(doc.schema!=='aster.studies'||doc.version!==1||!Array.isArray(doc.indicators)||!Array.isArray(doc.series)||doc.indicators.length>RESOURCE_LIMITS.maxIndicators||doc.series.length>RESOURCE_LIMITS.maxSeries)throw new TypeError('Study setup schema/count');
 if(model.indicators.entries.size+doc.indicators.length>RESOURCE_LIMITS.maxIndicators||model.series.length+doc.series.length>RESOURCE_LIMITS.maxSeries)throw new RangeError('Study setup capacity');
 const store=model.store,version=store.version,engine=model.indicators,entriesMap=engine.entries,registryMap=engine.registry,entries=[...engine.entries],registry=[...engine.registry],series=model.series,key=studyConfigurationKey(model);
 const candidate=new IndicatorEngine(store,{checkpointSize:engine.checkpointSize,maxOutputBytes:engine.maxOutputBytes});candidate.registry=new Map(engine.registry);candidate.entries=new Map(engine.entries);
 try{
  const ids=new Set();
  for(const e of doc.indicators){
   optionRecord(e,['id','name','params','module'],'Study definition');validateIndicatorParams(e.params);if(ids.has(e.id)||engine.entries.has(e.id))throw new Error('Duplicate study id');ids.add(e.id);
   requirePortableFactory(e.name,candidate.registry.get(e.name));const expected=indicatorModule(e.name);if(!studyModuleEqual(e.module,expected))throw new TypeError('Study module version/codec mismatch');
   candidate.add(e.id,e.name,e.params);
  }
  const proxy=Object.create(model);proxy.indicators=candidate;const seriesIds=new Set(model.series.map(s=>s.id)),added=[];
  for(const s of doc.series){optionRecord(s,SERIES_KEYS.filter(k=>k!=='values'),'Study series');if(!ids.has(s.indicator))throw new Error('Study series requires an imported indicator');if(seriesIds.has(s.id))throw new Error('Duplicate study series id');seriesIds.add(s.id);added.push(proxy.normalizedSeries(portableStyle(s,['color','fill','upColor','downColor'],true)));}
  if(model.disposed||model.store!==store||store.version!==version||model.indicators!==engine||engine.entries!==entriesMap||engine.registry!==registryMap||model.series!==series||studyConfigurationKey(model)!==key||entries.length!==engine.entries.size||entries.some(([id,e])=>engine.entries.get(id)!==e)||registry.length!==engine.registry.size||registry.some(([name,f])=>engine.registry.get(name)!==f))throw new Error('Study setup stale: owner changed during staging');
  for(const id of ids)engine.entries.set(id,candidate.entries.get(id));model.series=series.concat(added);
  return {indicators:ids.size,series:added.length};
 }finally{candidate.dispose();}
}
