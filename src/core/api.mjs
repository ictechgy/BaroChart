import {isPositionDrawing,positionMetricsFor} from './position-drawing.mjs';
import {resolveCrosshairSnapshot} from './crosshair-snap.mjs';
import {translateDrawings,deleteDrawings,setDrawingsStyle,setDrawingsVisibility,duplicateDrawings} from './drawing-translation.mjs';
import {compactData} from './compaction.mjs';
import {createLayout} from './model.mjs';
import {crosshairValuesAt} from './scene-parts.mjs';
import {dataAt} from './data-explorer.mjs';
import {FIELDS} from './data.mjs';
import {snapshotDataBatchOptions} from './data-batch-options.mjs';
import {applyDataEvent, validateSymbol, formatPrice, zonedParts} from './markets.mjs';
import {IndicatorEngine,requirePortableFactory} from './indicators.mjs';
import {indicatorModule,indicatorModuleDefinitions} from './indicator-modules.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {saveStudySetup,loadStudySetup,setStudyParams} from './study-setup.mjs';
import {DataIngestion,restoreDataIngestion,snapshotIngestionEvents,assertDataIngestionIdle} from './ingestion.mjs';
import {IngestionError} from './ingestion-error.mjs';

import {portableColor,portableFont,portableStyle,optionRecord,SERIES_KEYS,PANEL_KEYS,AXIS_KEYS,THEME_KEYS,RESOURCE_LIMITS,rememberSymbolFormatters,boundedText,sizeLimit} from './contracts.mjs';
export {portableColor,portableFont} from './contracts.mjs';
const PRESENTATION_KEYS=new Set(['color','fill','upColor','downColor','width','visible','label']);
function style(options,colors=['color','fill','upColor','downColor']) {return portableStyle(options,colors);}
const apiTypedPrototype=Object.getPrototypeOf(Float64Array.prototype),apiTypedSlot=key=>Object.getOwnPropertyDescriptor(apiTypedPrototype,key).get;
const apiTypedLength=apiTypedSlot('length'),apiTypedBuffer=apiTypedSlot('buffer'),apiTypedOffset=apiTypedSlot('byteOffset');
const apiIterator=Object.getOwnPropertyDescriptor(apiTypedPrototype,Symbol.iterator).value,apiIteratorPrototype=Object.getPrototypeOf(new Float64Array()[Symbol.iterator]()),apiIteratorNext=Object.getOwnPropertyDescriptor(apiIteratorPrototype,'next').value;
const apiBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get,apiBufferResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
const apiColumnSet=Float64Array.prototype.set;
const apiOwnValue=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
function apiOwnData(object,key,label,optional=false){const descriptor=object&&Object.getOwnPropertyDescriptor(object,key);if(!descriptor){if(optional)return undefined;throw new TypeError(label+' own data slot required');}if(!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');return descriptor.value;}
function apiControllerSlot(controller,key,label,optional=false){return apiOwnData(controller,key,label,optional);}
function apiSameDataDescriptor(current,expected){return !!current&&!!expected&&Object.hasOwn(current,'value')&&Object.hasOwn(expected,'value')&&current.value===expected.value&&current.writable===expected.writable&&current.enumerable===expected.enumerable&&current.configurable===expected.configurable;}
const apiOwners=new WeakMap();
function apiActive(api){
 const state=apiOwners.get(api);if(!state)throw new TypeError('Actual ChartAPI required');
 const descriptor=Object.getOwnPropertyDescriptor(api,'model');if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError('Chart API own model required: owner changed');const model=descriptor.value;
 if(state.owner.active!==true)throw new Error('Chart disposed');
 if(model!==state.model){const error=new Error('Chart API owner changed');error.name='StaleSourceError';throw error;}
 if(apiOwnData(model,'disposed','Chart',true))throw new Error('Chart disposed');
 return model;
}
// Package-internal lifecycle assertion for modules that publish work staged
// outside this facade. Deliberately omitted from public package entry points.
export function assertChartAPIActive(api){return apiActive(api);}
function apiStale(message){const error=new Error(message);error.name='StaleSourceError';return error;}
function snapshotBarInput(input){if(!input||typeof input!=='object')return input;const bar={};for(const key of FIELDS)bar[key]=input[key];return bar;}
function snapshotBarsInput(bars,maxBars){if(!Array.isArray(bars))throw new TypeError('OHLCV array required');const count=bars.length;sizeLimit(count,maxBars,'Bar count');const result=new Array(count);for(let i=0;i<count;i++)result[i]=snapshotBarInput(bars[i]);if(bars.length!==count)throw new RangeError('OHLCV array length changed during snapshot');return result;}
function cloneDrawingTarget(target,panel,axisId){
 const descriptors=Object.getOwnPropertyDescriptors(target);for(const descriptor of Object.values(descriptors))if(!Object.hasOwn(descriptor,'value'))throw new TypeError('Drawing target own data fields required');
 const panelDescriptor=descriptors.panel,axisDescriptor=descriptors.axisId;descriptors.panel={value:panel,writable:true,enumerable:panelDescriptor?.enumerable??true,configurable:true};descriptors.axisId={value:axisId,writable:true,enumerable:axisDescriptor?.enumerable??true,configurable:true};return Object.create(Object.getPrototypeOf(target),descriptors);
}
function columnPrefix(input,length){
 if(!Number.isSafeInteger(length)||length<0)return null;
 let buffer,offset;try{if(length>=apiTypedLength.call(input))return null;buffer=apiTypedBuffer.call(input);offset=apiTypedOffset.call(input);apiBufferLength.call(buffer);if(apiBufferResizable?.call(buffer))return null;}catch{return null;}
 if(Object.getPrototypeOf(input)!==Float64Array.prototype||Object.hasOwn(input,Symbol.iterator)||Object.hasOwn(Float64Array.prototype,Symbol.iterator)||apiOwnValue(apiTypedPrototype,Symbol.iterator)!==apiIterator||apiOwnValue(apiIteratorPrototype,'next')!==apiIteratorNext)return null;
 // Copy this column before reading the next input property. Keep full-tail
 // validation above this path; only the temporary snapshot's extent shrinks.
 const result=new Float64Array(length),view=new Float64Array(buffer,offset,length);apiColumnSet.call(result,view);return result;
}
function values(input,prefix) {
 if (!(input instanceof Float64Array)&&!Array.isArray(input)) throw new TypeError('Values must be Float64Array or a JSON array');
 for(const x of input) if(x!==null&&typeof x!=='number'||Number.isNaN(x)&&!(input instanceof Float64Array)||x===Infinity||x===-Infinity) throw new TypeError('Finite numbers or null gaps required');
 if(prefix!==undefined&&!Array.isArray(input)){const copy=columnPrefix(input,prefix);if(copy)return copy;}
 return Float64Array.from(input,x=>{if(x!==null&&typeof x!=='number'||Number.isNaN(x)&&!(input instanceof Float64Array)||x===Infinity||x===-Infinity)throw new TypeError('Finite numbers or null gaps required');return x===null?NaN:x;});
}
function columns(input,length) {return Object.fromEntries(FIELDS.map(key=>[key,values(input?.[key],length)]));}
const COMMANDS=new Set(['compactData','setData','setColumns','applyDataEvent','applyDataEvents','configureDataIngestion','enqueueDataEvents','drainDataEvents','pauseDataIngestion','resumeDataIngestion','cancelDataEvents','dataIngestionStats','saveDataIngestion','loadDataIngestion','addPanel','setPanel','setPanelOrder','removePanel','addAxis','setAxis','removeAxis','setDrawingTarget','setDrawingMagnet','setCrosshairSnap','crosshairSnapshot','crosshairValues','dataAt','addSeries','setSeries','setSeriesValues','removeSeries','addIndicator','setIndicatorParams','setIndicatorPlacement','removeIndicator','indicatorValues','indicatorValueAt','registerIndicatorModule','saveStudies','loadStudies','addDrawing','positionMetrics','editDrawing','translateDrawings','setDrawingsStyle','setDrawingVisibility','setDrawingsVisibility','duplicateDrawing','duplicateDrawings','deleteDrawings','deleteDrawing','selectDrawing','saveDrawings','loadDrawings','undo','redo','setTool','setText','setTheme','setSymbol','setVisibleRange','fit','zoom','pan','inspect']);

/** Shared web/JavaScriptCore/QuickJS facade. JSON arguments retain Double values.
 * Factories passed as source are trusted application code, never market data.
 */
export class ChartAPI {
 constructor(model,{controller=null,invalidate=()=>{}}={},owner=null) {if(apiOwnData(model,'disposed','Chart',true))throw new Error('Chart disposed');const token=owner??{active:true};if(token.active===false)throw new Error('Chart disposed');this.model=model;this.controller=controller;this.invalidate=invalidate;apiOwners.set(this,{model,owner:token});}
 dispatch(operation,args=[]) {
  apiActive(this);
  if(!COMMANDS.has(operation)||!Array.isArray(args))throw new TypeError('Unknown chart command or argument list');
  const arity={compactData:1,setData:1,setColumns:2,applyDataEvent:1,applyDataEvents:1,configureDataIngestion:1,enqueueDataEvents:1,drainDataEvents:1,pauseDataIngestion:0,resumeDataIngestion:0,cancelDataEvents:0,dataIngestionStats:0,saveDataIngestion:0,loadDataIngestion:1,addPanel:1,setPanel:2,setPanelOrder:1,removePanel:1,addAxis:1,setAxis:2,removeAxis:1,setDrawingTarget:1,setDrawingMagnet:1,setCrosshairSnap:1,crosshairSnapshot:2,crosshairValues:2,dataAt:2,addSeries:1,setSeries:2,setSeriesValues:2,removeSeries:1,addIndicator:3,setIndicatorParams:2,setIndicatorPlacement:2,removeIndicator:1,indicatorValues:2,indicatorValueAt:4,registerIndicatorModule:2,saveStudies:0,loadStudies:1,addDrawing:1,positionMetrics:1,editDrawing:2,translateDrawings:2,setDrawingsStyle:2,setDrawingVisibility:2,setDrawingsVisibility:2,duplicateDrawing:2,duplicateDrawings:2,deleteDrawings:1,deleteDrawing:1,selectDrawing:1,saveDrawings:0,loadDrawings:1,undo:0,redo:0,setTool:1,setText:1,setTheme:1,setSymbol:1,setVisibleRange:2,fit:0,zoom:2,pan:1,inspect:0};if(args.length>arity[operation])throw new TypeError('Chart command argument count');
  return this[operation](...args)??null;
 }
 changed(result) {
  const state=apiOwners.get(this);if(!state)throw new TypeError('Actual ChartAPI required');
  const descriptor=Object.getOwnPropertyDescriptor(this,'model');if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError('Chart API own model required: owner changed');
  if(descriptor.value!==state.model)throw apiStale('Chart API owner changed');
  const disposed=apiOwnData(state.model,'disposed','Chart',true);if(state.owner.active!==true||disposed)return result;
  this.invalidate();return result;
 }
 compactData(options){return compactData(this,options,()=>apiActive(this));}
 setData(bars) {const model=apiActive(this),next=snapshotBarsInput(bars,model.store.maxBars);apiActive(this);model.store.setData(next);return this.changed();}
 setColumns(data,length) {apiActive(this);const next=columns(data,length);apiActive(this);this.model.store.setColumns(next,length);return this.changed();}
 applyDataEvent(event) {
  const model=apiActive(this),store=model.store,kind=event?.kind;
  if(kind==='batch')return this.applyDataEvents(event.events);
  if(kind==='reset'){
   const input=event.columns;
   if(input){const length=event.length,next=columns(input,length);apiActive(this);store.setColumns(next,length);}
   else{const next=snapshotBarsInput(event.bars,store.maxBars);apiActive(this);store.setData(next);}
  }else if(kind==='prepend'){const next=snapshotBarsInput(event.bars,store.maxBars);apiActive(this);applyDataEvent(store,{kind,bars:next});}
  else if(['append','update','correction'].includes(kind)){const bar=snapshotBarInput(event.bar);apiActive(this);applyDataEvent(store,{kind,bar});}
  else{apiActive(this);applyDataEvent(store,{kind});}
  return this.changed();
 }
 applyDataEvents(events,options={}){const model=apiActive(this),store=model.store,version=store.version,series=model.series,ingestion=model.dataIngestion,epoch=ingestion?.epoch,bindings=series.map(s=>[s,s.values]),limits=snapshotDataBatchOptions(options,false),snapshot=snapshotIngestionEvents(events);if(apiActive(this)!==model||model.store!==store||store.version!==version||model.dataIngestion!==ingestion||ingestion?.epoch!==epoch||model.series!==series||series.length!==bindings.length||bindings.some(([s,v],i)=>series[i]!==s||s.values!==v))throw new IngestionError('SOURCE_CHANGED','Owner changed during batch snapshot');if(snapshot.some(e=>e.kind==='append')&&series.some(s=>s.values))throw new IngestionError('EXTERNAL_ALIGNMENT','Length-changing batches require host realignment of external values');apiActive(this);const receipt=store.applyEvents(snapshot,{...limits,...(ingestion?{maxBars:ingestion.policy.maxStoredBars,maxStoreBytes:ingestion.policy.maxStoreBytes}:{})});return receipt.unchanged===true?receipt:this.changed(receipt);}
 ingestion(){apiActive(this);if(!this.model.dataIngestion)throw new IngestionError('NOT_CONFIGURED','Configure data ingestion first');return this.model.dataIngestion;}
 configureDataIngestion(options){apiActive(this);assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Drain or cancel pending data before reconfiguration');const candidate=new DataIngestion(this.model,options);try{assertDataIngestionIdle(this.model);old?.idle();apiActive(this);if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during configuration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate.dispose();throw error;}}
 enqueueDataEvents(packet){return this.ingestion().enqueue(packet,()=>apiActive(this));}
 drainDataEvents(maxEvents){const receipt=this.ingestion().drain(maxEvents);return receipt.events?this.changed(receipt):receipt;}
 pauseDataIngestion(){return this.ingestion().pause();}
 resumeDataIngestion(){return this.ingestion().resume();}
 cancelDataEvents(){return this.ingestion().cancel();}
 dataIngestionStats(){return this.ingestion().stats();}
 saveDataIngestion(){return this.ingestion().save();}
 loadDataIngestion(text){apiActive(this);assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Cancel or drain pending data before restoration');let candidate;try{candidate=restoreDataIngestion(this.model,text);assertDataIngestionIdle(this.model);old?.idle();apiActive(this);if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during restoration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate?.dispose();throw error instanceof IngestionError?error:new IngestionError('INVALID_DOCUMENT',String(error.message).slice(0,256),error);}}
 addPanel(options) {apiActive(this);return this.changed(this.model.addPanel(options,{ownerGuard:()=>apiActive(this)}));}
 setPanel(id,patch) {apiActive(this);if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new TypeError('Panel patch object');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;apiActive(this);this.model.setPanel(id,next,{ownerGuard:()=>apiActive(this)});return this.changed();}
  setPanelOrder(ids) {apiActive(this);const model=apiOwnData(this,'model','Chart API'),controller=apiOwnData(this,'controller','Chart API',true);apiOwnData(this,'invalidate','Chart API');const result=model.setPanelOrder(ids,{owner:this,controller,ownerGuard:()=>apiActive(this)});return result?this.changed(true):false;}
  removePanel(id) {apiActive(this);const model=apiOwnData(this,'model','Chart API'),controller=apiOwnData(this,'controller','Chart API',true);apiOwnData(this,'invalidate','Chart API');let target=null,clear=false,targetSlot=null;if(controller&&apiControllerSlot(controller,'model','Interaction controller',true)===model){targetSlot=Object.getOwnPropertyDescriptor(controller,'drawingTarget');if(!targetSlot||!Object.hasOwn(targetSlot,'value'))throw new TypeError('Interaction controller drawing target must be own data');target=apiControllerSlot(controller,'drawingTarget','Interaction controller',true);clear=target!==null&&target!==undefined&&apiControllerSlot(target,'panel','Drawing target',true)===id;if(clear&&targetSlot.writable!==true)throw new TypeError('Interaction controller drawing target must be writable own data');}model.removePanel(id,{owner:this,controller,controllerTarget:target,controllerTargetSlot:targetSlot,ownerGuard:()=>apiActive(this)});if(clear)controller.drawingTarget=null;return this.changed();}
 addAxis(options){apiActive(this);return this.changed(this.model.addAxis(options,{ownerGuard:()=>apiActive(this)}));}
 setAxis(id,patch){apiActive(this);optionRecord(patch,AXIS_KEYS.filter(k=>k!=='id'&&k!=='panel'),'Axis patch');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;apiActive(this);this.model.setAxis(id,next,{ownerGuard:()=>apiActive(this)});return this.changed();}
 removeAxis(id){
  apiActive(this);
  const model=apiOwnData(this,'model','Chart API'),controller=apiOwnData(this,'controller','Chart API',true),invalidate=apiOwnData(this,'invalidate','Chart API');
  if(model!==apiActive(this))throw apiStale('Chart API owner changed');
  let targetSlot,target,targetNeedsClear=false;
  if(controller!==undefined&&controller!==null){
   if(apiControllerSlot(controller,'model','Interaction controller',true)!==model)throw apiStale('Interaction controller owner changed');
   targetSlot=Object.getOwnPropertyDescriptor(controller,'drawingTarget');
   if(!targetSlot||!Object.hasOwn(targetSlot,'value'))throw new TypeError('Interaction controller drawing target must be own data');
   target=targetSlot.value;
   if(target!==null&&target!==undefined){
    const axisSlot=Object.getOwnPropertyDescriptor(target,'axisId');
    if(axisSlot&&!Object.hasOwn(axisSlot,'value'))throw new TypeError('Drawing target axisId must be own data');
    targetNeedsClear=axisSlot?.value===id;
    if(targetNeedsClear&&targetSlot.writable!==true)throw new TypeError('Interaction controller drawing target must be writable own data');
   }
  }
  const ownerGuard=()=>{
   if(apiOwnData(this,'model','Chart API')!==model||apiOwnData(this,'controller','Chart API',true)!==controller||apiOwnData(this,'invalidate','Chart API')!==invalidate)throw apiStale('Chart API owner changed');
   if(controller!==undefined&&controller!==null){
    if(apiControllerSlot(controller,'model','Interaction controller',true)!==model)throw apiStale('Interaction controller owner changed');
    const current=Object.getOwnPropertyDescriptor(controller,'drawingTarget');
    if(!apiSameDataDescriptor(current,targetSlot)||current.value!==target)throw apiStale('Interaction controller owner changed');
   }
   apiActive(this);
  };
  model.removeAxis(id,{ownerGuard,controller});
  if(targetNeedsClear)Object.defineProperty(controller,'drawingTarget',{...targetSlot,value:null});
  return this.changed();
 }
 setDrawingTarget(target){apiActive(this);if(!this.controller)throw new Error('Interaction controller required');this.controller.setDrawingTarget(target,{notify:false});return this.changed();}
 setDrawingMagnet(options){apiActive(this);if(!this.controller)throw new Error('Interaction controller required');this.controller.setDrawingMagnet(options,{notify:false});return this.changed();}
 dataAt(query,options={}){apiActive(this);const d=Object.getOwnPropertyDescriptor(this,'model');if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Data query own model required');const model=d.value,result=dataAt(model,query,options),current=Object.getOwnPropertyDescriptor(this,'model');if(!current||!Object.hasOwn(current,'value')||current.value!==model){const error=new Error('Data query API owner changed');error.name='StaleSourceError';throw error;}return result;}
 setCrosshairSnap(options){apiActive(this);if(!this.controller)throw new Error('Interaction controller required');this.controller.setCrosshairSnap(options,{notify:false});apiActive(this);this.invalidate('hover');}
 crosshairSnapshot(width,height){apiActive(this);return resolveCrosshairSnapshot(this.model,createLayout(this.model,width,height));}
 crosshairValues(width,height){apiActive(this);return crosshairValuesAt(this.model,createLayout(this.model,width,height));}
 seriesOptions(options) {
  apiActive(this);
  optionRecord(options,SERIES_KEYS,'Series');const next=style(options);
  if(next.values!==undefined&&next.values!==null)next.values=values(next.values);
  if(next.source!==undefined&&!FIELDS.includes(next.source))throw new TypeError('Unknown column source');
  if(next.width!==undefined&&(!Number.isFinite(next.width)||next.width<=0||next.width>50))throw new RangeError('Series width');
  if(next.baseline!==undefined&&!Number.isFinite(next.baseline))throw new RangeError('Series baseline');
  if(next.visible!==undefined&&typeof next.visible!=='boolean')throw new TypeError('Series visible');
  if(next.indicator){const data=this.model.indicators.get(next.indicator);if(next.output!==undefined&&next.output!==null&&!Object.hasOwn(data.outputs,next.output))throw new Error('Missing indicator output');}
  if(['candles','ohlc'].includes(next.type)&&(next.indicator||next.values||next.source!==undefined))throw new TypeError('Candles/OHLC read store OHLCV; custom source/values/indicator need a general series');
  return next;
 }
 addSeries(options) {apiActive(this);const next=this.seriesOptions(options);apiActive(this);return this.changed(this.model.addSeries(next,{ownerGuard:()=>apiActive(this)}));}
 setSeries(id,patch) {
  apiActive(this);
  const index=this.model.series.findIndex(s=>s.id===id);if(index<0)throw new Error('Missing series');
  const current=this.model.series[index];
  if(patch&&typeof patch==='object'&&Reflect.ownKeys(patch).every(key=>PRESENTATION_KEYS.has(key))){
   const model=this.model,series=model.series,store=model.store,version=store.version,engine=model.indicators,entries=engine.entries,indicator=current.indicator,entry=indicator?Map.prototype.get.call(entries,indicator):null,valuesRevision=model.seriesValuesRevision;
   const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
   const guard=()=>{apiActive(this);if(own(model,'disposed'))throw new Error('Chart disposed');if(own(this,'model')!==model||own(model,'series')!==series||series[index]!==current||own(model,'store')!==store||own(store,'version')!==version||own(model,'seriesValuesRevision')!==valuesRevision||own(model,'indicators')!==engine||own(engine,'entries')!==entries||indicator&&Map.prototype.get.call(entries,indicator)!==entry){const error=new Error('Series presentation owner changed');error.name='StaleSourceError';throw error;}};
   const presentation=this.seriesOptions(patch);if(presentation.label!==undefined)boundedText(presentation.label,256,'Series label');guard();
   if(indicator&&!entry)throw new Error(`Missing indicator: ${indicator}`);
   // The binding was already validated. Preserve its caches; only presentation changes.
   const next={...current,...presentation};for(const key of Object.keys(next))if(!SERIES_KEYS.includes(key)&&!['rangeIndex','revision','dirtyFrom'].includes(key))delete next[key];guard();
   series[index]=next;return this.changed();
  }
  const next={...current,...this.seriesOptions(patch)};
  if(next.indicator){const data=this.model.indicators.get(next.indicator);if(next.output!==undefined&&next.output!==null&&!Object.hasOwn(data.outputs,next.output))throw new Error('Missing indicator output');}
  if(['candles','ohlc'].includes(next.type)&&(next.indicator||next.values||next.source!==undefined))throw new TypeError('Candles/OHLC read store OHLCV; custom source/values/indicator need a general series');
  // Reuse core validation before replacing; retain painter order and discard
  // stale range caches. A rejected patch leaves the original series untouched.
  if(Object.hasOwn(patch,'indicator')||Object.hasOwn(patch,'output'))next.offset=patch.offset;
  if(next.indicator===null)delete next.indicator;if(next.output===null)delete next.output;if(next.values===null)delete next.values;
  const sameData=current.values===next.values&&current.indicator===next.indicator&&current.output===next.output&&(current.source??'close')===(next.source??'close');
  for(const key of Object.keys(next))if(!SERIES_KEYS.includes(key))delete next[key];
  apiActive(this);const validated=this.model.normalizedSeries({...next,id});
  if((current.axisId??null)!==(validated.axisId??null)||current.panel!==validated.panel){const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});}
  apiActive(this);this.model.series[index]={...validated,id,...(sameData?{rangeIndex:current.rangeIndex,revision:current.revision,dirtyFrom:current.dirtyFrom}:{})};const target=this.controller?.drawingTarget;if(target?.seriesId===id&&(target.panel!==validated.panel||(target.axisId??null)!==(validated.axisId??null)))this.controller.setDrawingTarget({...target,panel:validated.panel,axisId:validated.axisId??null},{notify:false});return this.changed();
 }
 setSeriesValues(id,input) {apiActive(this);const next=values(input);apiActive(this);this.model.setSeriesValues(id,next);return this.changed();}
 removeSeries(id) {apiActive(this);const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});if(this.controller?.drawingTarget?.seriesId===id)this.controller.setDrawingTarget(null,{notify:false});apiActive(this);this.model.removeSeries(id);return this.changed();}
 addIndicator(id,name,params={}) {
  const model=apiActive(this);validateIndicatorParams(params);const requested={...params};validateIndicatorParams(requested);apiActive(this);
  const engine=model.indicators,store=model.store,version=store.version,entries=engine.entries,registry=engine.registry,entrySnapshot=[...entries],registrySnapshot=[...registry];
  if(entries.size>=RESOURCE_LIMITS.maxIndicators)throw new RangeError('Indicator limit');if(entries.has(id))throw new Error('Duplicate indicator id');
  const candidate=new IndicatorEngine(store,{checkpointSize:engine.checkpointSize,maxOutputBytes:engine.maxOutputBytes});candidate.registry=new Map(registrySnapshot);
  try{
   const data=candidate.add(id,name,requested),replacement=candidate.entries.get(id);
   if(apiActive(this)!==model||model.indicators!==engine||model.store!==store||store.version!==version||engine.entries!==entries||engine.registry!==registry||entrySnapshot.length!==entries.size||entrySnapshot.some(([key,value])=>entries.get(key)!==value)||registrySnapshot.length!==registry.size||registrySnapshot.some(([key,value])=>registry.get(key)!==value))throw apiStale('Indicator owner changed during staging');
   const outputs=entrySnapshot.reduce((count,[,entry])=>count+entry.def.outputs.length,replacement.def.outputs.length);if(outputs*store.capacity*8>engine.maxOutputBytes)throw new RangeError('Indicator output byte limit');
   candidate.entries.delete(id);entries.set(id,replacement);return this.changed({outputs:Object.keys(data.outputs),plotOffsets:{...data.plotOffsets}});
  }finally{candidate.dispose();}
 }
 setIndicatorParams(id,params){apiActive(this);validateIndicatorParams(params);const requested={...params};validateIndicatorParams(requested);apiActive(this);return this.changed(setStudyParams(this.model,id,requested,()=>apiActive(this)));}
  setIndicatorPlacement(id,placement) {apiActive(this);const model=apiOwnData(this,'model','Chart API'),controller=apiOwnData(this,'controller','Chart API',true);apiOwnData(this,'invalidate','Chart API');let target=null,targetSeriesId,targetTemplate=null,targetSlot=null;if(controller&&apiControllerSlot(controller,'model','Interaction controller',true)===model){targetSlot=Object.getOwnPropertyDescriptor(controller,'drawingTarget');if(!targetSlot||!Object.hasOwn(targetSlot,'value'))throw new TypeError('Interaction controller drawing target must be own data');target=apiControllerSlot(controller,'drawingTarget','Interaction controller',true);if(target!==null&&target!==undefined){targetSeriesId=apiControllerSlot(target,'seriesId','Drawing target',true);if(targetSeriesId!==undefined&&targetSeriesId!==null)targetTemplate=cloneDrawingTarget(target,apiControllerSlot(target,'panel','Drawing target',true),apiControllerSlot(target,'axisId','Drawing target',true)??null);}}const result=model._setIndicatorPlacement(id,placement,{owner:this,controller,controllerTarget:target,controllerTargetSlot:targetSlot,ownerGuard:()=>apiActive(this)});if(!result.changed)return {changed:0};if(targetSeriesId!==undefined&&targetSeriesId!==null&&result.boundIds?.includes(targetSeriesId))controller.drawingTarget=cloneDrawingTarget(targetTemplate,result.panel,result.axisId);return this.changed({changed:result.changed});}
 removeIndicator(id) {
  apiActive(this);
  // Deletion needs entry ownership, never a calculation of data being discarded.
  const model=this.model,engine=model.indicators,entries=engine.entries,entry=entries.get(id);
  if(!entry)throw new Error(`Missing indicator: ${id}`);
  const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
  const guard=()=>{
   apiActive(this);if(own(model,'disposed'))throw new Error('Chart disposed');
   if(own(this,'model')!==model||own(model,'indicators')!==engine||own(engine,'entries')!==entries||Map.prototype.get.call(entries,id)!==entry){const error=new Error('Indicator removal owner changed');error.name='StaleSourceError';throw error;}
  };
  guard();
  const controller=this.controller,removed=model.series.filter(s=>s.indicator===id).map(s=>s.id),active=model.drawings.items.find(d=>d.id===controller?.gesture?.id);
  const cancel=removed.includes(active?.seriesId);guard();
  if(cancel){const cancelGesture=controller.cancel;guard();cancelGesture.call(controller,{notify:false});guard();}
  const clearTarget=removed.includes(controller?.drawingTarget?.seriesId);guard();
  if(clearTarget){const setTarget=controller.setDrawingTarget;guard();setTarget.call(controller,null,{notify:false});guard();}
  const remove=engine.remove;guard();
  const series=model.series.filter(s=>s.indicator!==id);guard();
  model.series=series;
  // Keep the engine's retirement path: native entries release their checkpoint ledger.
  remove.call(engine,id);return this.changed();
 }
 indicatorValues(id,output) {apiActive(this);const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];return Array.from(array,v=>Number.isFinite(v)?v:null);}
 indicatorValueAt(id,output,index,options={}) {
  apiActive(this);
  optionRecord(options,['mode','asOfIndex'],'Indicator query');const mode=options.mode??'raw',asOf=options.asOfIndex??this.model.store.length-1;
  if(!['raw','plot'].includes(mode)||!Number.isSafeInteger(index)||!Number.isSafeInteger(asOf)||asOf< -1||asOf>=this.model.store.length)throw new RangeError('Indicator query index/mode');
  const e=this.model.indicators.entries.get(id);if(!e)throw new Error('Missing indicator');requirePortableFactory(e.name,this.model.indicators.registry.get(e.name));
  const module=indicatorModule(e.name);if(module&&module.causal!==true)throw new TypeError('Unsupported noncausal study query');
  const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];
  const source=index-(mode==='plot'?(Object.hasOwn(data.plotOffsets,key)?data.plotOffsets[key]:0):0);
  if(source<0||source>=array.length||source>asOf)return {value:null,sourceIndex:null,sourceTime:null};
  return {value:Number.isFinite(array[source])?array[source]:null,sourceIndex:source,sourceTime:this.model.store.columns.time[source]};
 }
 registerIndicatorModule(id,version){apiActive(this);const entries=indicatorModuleDefinitions(id,version);for(const e of entries){const current=this.model.indicators.registry.get(e.name);if(current&&current!==e.factory)throw new Error('Indicator module name conflict');}apiActive(this);for(const e of entries)this.model.indicators.registry.set(e.name,e.factory);return this.changed(entries.map(e=>e.name));}
 saveStudies(){apiActive(this);return saveStudySetup(this.model);}
 loadStudies(text){apiActive(this);return this.changed(loadStudySetup(this.model,text,()=>apiActive(this)));}
 registerIndicator(name,factory) {apiActive(this);this.model.indicators.register(name,factory);return this.changed();}
 registerIndicatorSource(name,source) {
  apiActive(this);
  if(typeof source!=='string'||source.length>65536)throw new TypeError('Trusted factory expression, at most 64KiB');
  const factory=Function('"use strict"; return ('+source+');')();if(typeof factory!=='function')throw new TypeError('Factory function required');
  return this.registerIndicator(name,factory);
 }
 drawingOptions(options) {apiActive(this);optionRecord(options,['id','type','panel','points','style','text','locked','visible','axisId','seriesId'],'Drawing');if(options.style)optionRecord(options.style,['color','fill','width','font'],'Drawing style');const next={...options,...(options.style?{style:style(options.style,['color','fill'])}:{})};if(next.seriesId!=null&&next.axisId===undefined){const s=this.model.series.find(s=>s.id===next.seriesId);if(s)next.axisId=s.axisId??null;}return next;}
 drawingMutationContext(){apiActive(this);const d=this.model.drawings,interactive=!!this.controller?.gesture;return {items:interactive&&d.transaction?d.transaction:d.items,beforeMutation:()=>{apiActive(this);if(interactive)this.controller.cancel({notify:false});apiActive(this);}};}
 addDrawing(options) {apiActive(this);const next={panel:'price',...this.drawingOptions(options)};this.model.validateDrawingBinding(next);apiActive(this);return this.changed(this.model.drawings.add(next,this.drawingMutationContext()));}
 positionMetrics(id){apiActive(this);const d=this.model.drawings.items.find(d=>d.id===id);if(!d||!isPositionDrawing(d.type))throw new TypeError('Position drawing required');return positionMetricsFor(d);}
 duplicateDrawing(id,options){apiActive(this);return duplicateDrawings(this,[id],options,()=>apiActive(this));}
 duplicateDrawings(ids,options){apiActive(this);return duplicateDrawings(this,ids,options,()=>apiActive(this));}
 setDrawingVisibility(id,visible){apiActive(this);return setDrawingsVisibility(this,[id],visible,()=>apiActive(this));}
 setDrawingsVisibility(ids,visible){apiActive(this);return setDrawingsVisibility(this,ids,visible,()=>apiActive(this));}
 setDrawingsStyle(ids,patch){apiActive(this);return setDrawingsStyle(this,ids,patch,()=>apiActive(this));}
 deleteDrawings(ids){apiActive(this);return deleteDrawings(this,ids,()=>apiActive(this));}
 translateDrawings(ids,options){apiActive(this);return translateDrawings(this,ids,options,()=>apiActive(this));}
 editDrawing(id,patch) {apiActive(this);const context=this.drawingMutationContext(),previous=context.items.find(d=>d.id===id);if(!previous)throw new Error('Missing committed drawing');const next=this.drawingOptions(patch);this.model.validateDrawingBinding({...previous,...next});apiActive(this);this.model.drawings.edit(id,next,context);return this.changed();}
 deleteDrawing(id=this.model.drawings.selected) {apiActive(this);const context=this.drawingMutationContext();if(this.controller?.gesture?.kind==='create'&&this.controller.gesture.id===id&&!context.items.some(d=>d.id===id)){this.controller.cancel({notify:false});return this.changed(false);}apiActive(this);return this.changed(this.model.drawings.remove(id,context));}
 selectDrawing(id) {apiActive(this);if(id!==null&&!this.model.drawings.items.some(d=>d.id===id&&d.visible!==false))throw new Error('Missing or hidden drawing');if(id!==this.model.drawings.selected)this.controller?.cancel({notify:false});apiActive(this);this.model.drawings.selected=id;return this.changed();}
 saveDrawings() {apiActive(this);return this.model.drawings.save();}
 loadDrawings(text) {apiActive(this);this.model.drawings.load(text,{styleDecoder:options=>portableStyle(options,['color','fill'],true),validatePanel:id=>this.model.panels.some(p=>p.id===id),validateBinding:d=>this.model.validateDrawingBinding(d)});return this.changed();}
 undo() {apiActive(this);if(this.controller)this.controller.key('z',{ctrl:true});else this.model.drawings.undo();return this.changed();}
 redo() {apiActive(this);if(this.controller)this.controller.key('z',{ctrl:true,shift:true});else this.model.drawings.redo();return this.changed();}
 setTool(tool) {apiActive(this);if(!this.controller)throw new Error('Interaction controller required');this.controller.setTool(tool,{notify:false});return this.changed();}
 setText(text) {apiActive(this);if(!this.controller||typeof text!=='string'||text.length>2000)throw new TypeError('Drawing text, at most 2000 characters');this.controller.text=text;return this.changed();}
 setTheme(patch) {apiActive(this);optionRecord(patch,THEME_KEYS,'Theme');const next=style(patch,['background','grid','text','up','down','crosshair']);apiActive(this);this.model.theme={...this.model.theme,...next};return this.changed();}
 setSymbol(options) {
  apiActive(this);
  const symbol=validateSymbol(options);zonedParts(0,symbol.timezone);
  apiActive(this);this.model.symbol=symbol;this.model.precision=symbol.priceDecimals;this.model.priceFormatter=price=>formatPrice(price,symbol);
  this.model.timeFormatter=time=>{const p=zonedParts(time,symbol.timezone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;};rememberSymbolFormatters(this.model);return this.changed();
 }
 setVisibleRange(from,to) {apiActive(this);this.model.setVisibleRange(from,to);return this.changed();}
 fit() {apiActive(this);this.model.fit();return this.changed();}
 zoom(factor,anchor) {apiActive(this);this.model.zoom(factor,anchor);return this.changed();}
 pan(delta) {apiActive(this);this.model.pan(delta);return this.changed();}
 inspect() {apiActive(this);return JSON.parse(JSON.stringify({view:this.model.view,theme:this.model.theme,panels:this.model.panels,axes:this.model.axes,drawingTarget:this.controller?.drawingTarget??null,series:this.model.series.map(({rangeIndex,values,revision,dirtyFrom,...s})=>({...s,...(values?{valueCount:values.length}:{})})),symbol:this.model.symbol,storedBars:this.model.store.length,lastBar:this.model.store.length?this.model.store.at(this.model.store.length-1):null,drawings:this.model.drawings.items,selected:this.model.drawings.selected,tool:this.controller?.tool??null,pointers:this.controller?.pointers.size??0,gesture:this.controller?.gesture?.kind??null}));}
}
