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
import {requirePortableFactory} from './indicators.mjs';
import {indicatorModule,indicatorModuleDefinitions} from './indicator-modules.mjs';
import {saveStudySetup,loadStudySetup,setStudyParams} from './study-setup.mjs';
import {DataIngestion,restoreDataIngestion,snapshotIngestionEvents,assertDataIngestionIdle} from './ingestion.mjs';
import {IngestionError} from './ingestion-error.mjs';

import {portableColor,portableFont,portableStyle,optionRecord,SERIES_KEYS,PANEL_KEYS,AXIS_KEYS,THEME_KEYS,rememberSymbolFormatters,boundedText} from './contracts.mjs';
export {portableColor,portableFont} from './contracts.mjs';
const PRESENTATION_KEYS=new Set(['color','fill','upColor','downColor','width','visible','label']);
function style(options,colors=['color','fill','upColor','downColor']) {return portableStyle(options,colors);}
const apiTypedPrototype=Object.getPrototypeOf(Float64Array.prototype),apiTypedSlot=key=>Object.getOwnPropertyDescriptor(apiTypedPrototype,key).get;
const apiTypedLength=apiTypedSlot('length'),apiTypedBuffer=apiTypedSlot('buffer'),apiTypedOffset=apiTypedSlot('byteOffset');
const apiIterator=Object.getOwnPropertyDescriptor(apiTypedPrototype,Symbol.iterator).value,apiIteratorPrototype=Object.getPrototypeOf(new Float64Array()[Symbol.iterator]()),apiIteratorNext=Object.getOwnPropertyDescriptor(apiIteratorPrototype,'next').value;
const apiBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get,apiBufferResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
const apiColumnSet=Float64Array.prototype.set;
const apiOwnValue=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
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
const COMMANDS=new Set(['compactData','setData','setColumns','applyDataEvent','applyDataEvents','configureDataIngestion','enqueueDataEvents','drainDataEvents','pauseDataIngestion','resumeDataIngestion','cancelDataEvents','dataIngestionStats','saveDataIngestion','loadDataIngestion','addPanel','setPanel','addAxis','setAxis','removeAxis','setDrawingTarget','setDrawingMagnet','setCrosshairSnap','crosshairSnapshot','crosshairValues','dataAt','addSeries','setSeries','setSeriesValues','removeSeries','addIndicator','setIndicatorParams','removeIndicator','indicatorValues','indicatorValueAt','registerIndicatorModule','saveStudies','loadStudies','addDrawing','positionMetrics','editDrawing','translateDrawings','setDrawingsStyle','setDrawingVisibility','setDrawingsVisibility','duplicateDrawing','duplicateDrawings','deleteDrawings','deleteDrawing','selectDrawing','saveDrawings','loadDrawings','undo','redo','setTool','setText','setTheme','setSymbol','setVisibleRange','fit','zoom','pan','inspect']);

/** Shared web/JavaScriptCore/QuickJS facade. JSON arguments retain Double values.
 * Factories passed as source are trusted application code, never market data.
 */
export class ChartAPI {
 constructor(model,{controller=null,invalidate=()=>{}}={}) {this.model=model;this.controller=controller;this.invalidate=invalidate;}
 dispatch(operation,args=[]) {
  if(!COMMANDS.has(operation)||!Array.isArray(args))throw new TypeError('Unknown chart command or argument list');
  const arity={compactData:1,setData:1,setColumns:2,applyDataEvent:1,applyDataEvents:1,configureDataIngestion:1,enqueueDataEvents:1,drainDataEvents:1,pauseDataIngestion:0,resumeDataIngestion:0,cancelDataEvents:0,dataIngestionStats:0,saveDataIngestion:0,loadDataIngestion:1,addPanel:1,setPanel:2,addAxis:1,setAxis:2,removeAxis:1,setDrawingTarget:1,setDrawingMagnet:1,setCrosshairSnap:1,crosshairSnapshot:2,crosshairValues:2,dataAt:2,addSeries:1,setSeries:2,setSeriesValues:2,removeSeries:1,addIndicator:3,setIndicatorParams:2,removeIndicator:1,indicatorValues:2,indicatorValueAt:4,registerIndicatorModule:2,saveStudies:0,loadStudies:1,addDrawing:1,positionMetrics:1,editDrawing:2,translateDrawings:2,setDrawingsStyle:2,setDrawingVisibility:2,setDrawingsVisibility:2,duplicateDrawing:2,duplicateDrawings:2,deleteDrawings:1,deleteDrawing:1,selectDrawing:1,saveDrawings:0,loadDrawings:1,undo:0,redo:0,setTool:1,setText:1,setTheme:1,setSymbol:1,setVisibleRange:2,fit:0,zoom:2,pan:1,inspect:0};if(args.length>arity[operation])throw new TypeError('Chart command argument count');
  return this[operation](...args)??null;
 }
 changed(result) {this.invalidate();return result;}
 compactData(options){return compactData(this,options);}
 setData(bars) {this.model.store.setData(bars);return this.changed();}
 setColumns(data,length) {this.model.store.setColumns(columns(data,length),length);return this.changed();}
 applyDataEvent(event) {if(event?.kind==='batch')return this.applyDataEvents(event.events);const next=event?.kind==='reset'&&event.columns?{...event,columns:columns(event.columns)}:event;applyDataEvent(this.model.store,next);return this.changed();}
 applyDataEvents(events,options={}){const model=this.model;if(model.disposed)throw new Error('Chart disposed');const store=model.store,version=store.version,series=model.series,ingestion=model.dataIngestion,epoch=ingestion?.epoch,bindings=series.map(s=>[s,s.values]),limits=snapshotDataBatchOptions(options,false),snapshot=snapshotIngestionEvents(events);if(Object.getOwnPropertyDescriptor(this,'model')?.value!==model||model.disposed||model.store!==store||store.version!==version||model.dataIngestion!==ingestion||ingestion?.epoch!==epoch||model.series!==series||series.length!==bindings.length||bindings.some(([s,v],i)=>series[i]!==s||s.values!==v))throw new IngestionError('SOURCE_CHANGED','Owner changed during batch snapshot');if(snapshot.some(e=>e.kind==='append')&&series.some(s=>s.values))throw new IngestionError('EXTERNAL_ALIGNMENT','Length-changing batches require host realignment of external values');const receipt=store.applyEvents(snapshot,{...limits,...(ingestion?{maxBars:ingestion.policy.maxStoredBars,maxStoreBytes:ingestion.policy.maxStoreBytes}:{})});return receipt.unchanged===true?receipt:this.changed(receipt);}
 ingestion(){if(this.model.disposed)throw new Error('Chart disposed');if(!this.model.dataIngestion)throw new IngestionError('NOT_CONFIGURED','Configure data ingestion first');return this.model.dataIngestion;}
 configureDataIngestion(options){if(this.model.disposed)throw new Error('Chart disposed');assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Drain or cancel pending data before reconfiguration');const candidate=new DataIngestion(this.model,options);try{assertDataIngestionIdle(this.model);old?.idle();if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during configuration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate.dispose();throw error;}}
 enqueueDataEvents(packet){return this.ingestion().enqueue(packet);}
 drainDataEvents(maxEvents){const receipt=this.ingestion().drain(maxEvents);if(receipt.events)this.invalidate();return receipt;}
 pauseDataIngestion(){return this.ingestion().pause();}
 resumeDataIngestion(){return this.ingestion().resume();}
 cancelDataEvents(){return this.ingestion().cancel();}
 dataIngestionStats(){return this.ingestion().stats();}
 saveDataIngestion(){return this.ingestion().save();}
 loadDataIngestion(text){if(this.model.disposed)throw new Error('Chart disposed');assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Cancel or drain pending data before restoration');let candidate;try{candidate=restoreDataIngestion(this.model,text);assertDataIngestionIdle(this.model);old?.idle();if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during restoration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate?.dispose();throw error instanceof IngestionError?error:new IngestionError('INVALID_DOCUMENT',String(error.message).slice(0,256),error);}}
 addPanel(options) {return this.changed(this.model.addPanel(options));}
 setPanel(id,patch) {if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new TypeError('Panel patch object');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;this.model.setPanel(id,next);return this.changed();}
 addAxis(options){return this.changed(this.model.addAxis(options));}
 setAxis(id,patch){optionRecord(patch,AXIS_KEYS.filter(k=>k!=='id'&&k!=='panel'),'Axis patch');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;this.model.setAxis(id,next);return this.changed();}
 removeAxis(id){this.model.removeAxis(id);if(this.controller?.drawingTarget?.axisId===id)this.controller.setDrawingTarget(null,{notify:false});return this.changed();}
 setDrawingTarget(target){if(!this.controller)throw new Error('Interaction controller required');this.controller.setDrawingTarget(target,{notify:false});return this.changed();}
 setDrawingMagnet(options){if(!this.controller)throw new Error('Interaction controller required');this.controller.setDrawingMagnet(options,{notify:false});return this.changed();}
 dataAt(query,options={}){const d=Object.getOwnPropertyDescriptor(this,'model');if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Data query own model required');const model=d.value,result=dataAt(model,query,options),current=Object.getOwnPropertyDescriptor(this,'model');if(!current||!Object.hasOwn(current,'value')||current.value!==model){const error=new Error('Data query API owner changed');error.name='StaleSourceError';throw error;}return result;}
 setCrosshairSnap(options){if(!this.controller)throw new Error('Interaction controller required');this.controller.setCrosshairSnap(options,{notify:false});this.invalidate('hover');}
 crosshairSnapshot(width,height){return resolveCrosshairSnapshot(this.model,createLayout(this.model,width,height));}
 crosshairValues(width,height){return crosshairValuesAt(this.model,createLayout(this.model,width,height));}
 seriesOptions(options) {
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
 addSeries(options) {return this.changed(this.model.addSeries(this.seriesOptions(options)));}
 setSeries(id,patch) {
  const index=this.model.series.findIndex(s=>s.id===id);if(index<0)throw new Error('Missing series');
  const current=this.model.series[index];
  if(patch&&typeof patch==='object'&&Reflect.ownKeys(patch).every(key=>PRESENTATION_KEYS.has(key))){
   const model=this.model,series=model.series,store=model.store,version=store.version,engine=model.indicators,entries=engine.entries,indicator=current.indicator,entry=indicator?Map.prototype.get.call(entries,indicator):null,valuesRevision=model.seriesValuesRevision;
   const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
   const guard=()=>{if(own(model,'disposed'))throw new Error('Chart disposed');if(own(this,'model')!==model||own(model,'series')!==series||series[index]!==current||own(model,'store')!==store||own(store,'version')!==version||own(model,'seriesValuesRevision')!==valuesRevision||own(model,'indicators')!==engine||own(engine,'entries')!==entries||indicator&&Map.prototype.get.call(entries,indicator)!==entry){const error=new Error('Series presentation owner changed');error.name='StaleSourceError';throw error;}};
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
  const validated=this.model.normalizedSeries({...next,id});
  if((current.axisId??null)!==(validated.axisId??null)||current.panel!==validated.panel){const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});}
  this.model.series[index]={...validated,id,...(sameData?{rangeIndex:current.rangeIndex,revision:current.revision,dirtyFrom:current.dirtyFrom}:{})};const target=this.controller?.drawingTarget;if(target?.seriesId===id&&(target.panel!==validated.panel||(target.axisId??null)!==(validated.axisId??null)))this.controller.setDrawingTarget({...target,panel:validated.panel,axisId:validated.axisId??null},{notify:false});return this.changed();
 }
 setSeriesValues(id,input) {this.model.setSeriesValues(id,values(input));return this.changed();}
 removeSeries(id) {const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});if(this.controller?.drawingTarget?.seriesId===id)this.controller.setDrawingTarget(null,{notify:false});this.model.removeSeries(id);return this.changed();}
 addIndicator(id,name,params={}) {const data=this.model.indicators.add(id,name,params);return this.changed({outputs:Object.keys(data.outputs),plotOffsets:{...data.plotOffsets}});}
 setIndicatorParams(id,params){return this.changed(setStudyParams(this.model,id,params));}
 removeIndicator(id) {
  // Deletion needs entry ownership, never a calculation of data being discarded.
  const model=this.model,engine=model.indicators,entries=engine.entries,entry=entries.get(id);
  if(!entry)throw new Error(`Missing indicator: ${id}`);
  const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
  const guard=()=>{
   if(own(model,'disposed'))throw new Error('Chart disposed');
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
 indicatorValues(id,output) {const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];return Array.from(array,v=>Number.isFinite(v)?v:null);}
 indicatorValueAt(id,output,index,options={}) {
  optionRecord(options,['mode','asOfIndex'],'Indicator query');const mode=options.mode??'raw',asOf=options.asOfIndex??this.model.store.length-1;
  if(!['raw','plot'].includes(mode)||!Number.isSafeInteger(index)||!Number.isSafeInteger(asOf)||asOf< -1||asOf>=this.model.store.length)throw new RangeError('Indicator query index/mode');
  const e=this.model.indicators.entries.get(id);if(!e)throw new Error('Missing indicator');requirePortableFactory(e.name,this.model.indicators.registry.get(e.name));
  const module=indicatorModule(e.name);if(module&&module.causal!==true)throw new TypeError('Unsupported noncausal study query');
  const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];
  const source=index-(mode==='plot'?(Object.hasOwn(data.plotOffsets,key)?data.plotOffsets[key]:0):0);
  if(source<0||source>=array.length||source>asOf)return {value:null,sourceIndex:null,sourceTime:null};
  return {value:Number.isFinite(array[source])?array[source]:null,sourceIndex:source,sourceTime:this.model.store.columns.time[source]};
 }
 registerIndicatorModule(id,version){const entries=indicatorModuleDefinitions(id,version);for(const e of entries){const current=this.model.indicators.registry.get(e.name);if(current&&current!==e.factory)throw new Error('Indicator module name conflict');}for(const e of entries)this.model.indicators.registry.set(e.name,e.factory);return this.changed(entries.map(e=>e.name));}
 saveStudies(){return saveStudySetup(this.model);}
 loadStudies(text){return this.changed(loadStudySetup(this.model,text));}
 registerIndicator(name,factory) {this.model.indicators.register(name,factory);return this.changed();}
 registerIndicatorSource(name,source) {
  if(typeof source!=='string'||source.length>65536)throw new TypeError('Trusted factory expression, at most 64KiB');
  const factory=Function('"use strict"; return ('+source+');')();if(typeof factory!=='function')throw new TypeError('Factory function required');
  return this.registerIndicator(name,factory);
 }
 drawingOptions(options) {optionRecord(options,['id','type','panel','points','style','text','locked','visible','axisId','seriesId'],'Drawing');if(options.style)optionRecord(options.style,['color','fill','width','font'],'Drawing style');const next={...options,...(options.style?{style:style(options.style,['color','fill'])}:{})};if(next.seriesId!=null&&next.axisId===undefined){const s=this.model.series.find(s=>s.id===next.seriesId);if(s)next.axisId=s.axisId??null;}return next;}
 drawingMutationContext(){const d=this.model.drawings,interactive=!!this.controller?.gesture;return {items:interactive&&d.transaction?d.transaction:d.items,beforeMutation:interactive?()=>this.controller.cancel({notify:false}):null};}
 addDrawing(options) {const next={panel:'price',...this.drawingOptions(options)};this.model.validateDrawingBinding(next);return this.changed(this.model.drawings.add(next,this.drawingMutationContext()));}
 positionMetrics(id){const d=this.model.drawings.items.find(d=>d.id===id);if(!d||!isPositionDrawing(d.type))throw new TypeError('Position drawing required');return positionMetricsFor(d);}
 duplicateDrawing(id,options){return duplicateDrawings(this,[id],options);}
 duplicateDrawings(ids,options){return duplicateDrawings(this,ids,options);}
 setDrawingVisibility(id,visible){return setDrawingsVisibility(this,[id],visible);}
 setDrawingsVisibility(ids,visible){return setDrawingsVisibility(this,ids,visible);}
 setDrawingsStyle(ids,patch){return setDrawingsStyle(this,ids,patch);}
 deleteDrawings(ids){return deleteDrawings(this,ids);}
 translateDrawings(ids,options){return translateDrawings(this,ids,options);}
 editDrawing(id,patch) {const context=this.drawingMutationContext(),previous=context.items.find(d=>d.id===id);if(!previous)throw new Error('Missing committed drawing');const next=this.drawingOptions(patch);this.model.validateDrawingBinding({...previous,...next});this.model.drawings.edit(id,next,context);return this.changed();}
 deleteDrawing(id=this.model.drawings.selected) {const context=this.drawingMutationContext();if(this.controller?.gesture?.kind==='create'&&this.controller.gesture.id===id&&!context.items.some(d=>d.id===id)){this.controller.cancel({notify:false});return this.changed(false);}return this.changed(this.model.drawings.remove(id,context));}
 selectDrawing(id) {if(id!==null&&!this.model.drawings.items.some(d=>d.id===id&&d.visible!==false))throw new Error('Missing or hidden drawing');if(id!==this.model.drawings.selected)this.controller?.cancel({notify:false});this.model.drawings.selected=id;return this.changed();}
 saveDrawings() {return this.model.drawings.save();}
 loadDrawings(text) {this.model.drawings.load(text,{styleDecoder:options=>portableStyle(options,['color','fill'],true),validatePanel:id=>this.model.panels.some(p=>p.id===id),validateBinding:d=>this.model.validateDrawingBinding(d)});return this.changed();}
 undo() {if(this.controller)this.controller.key('z',{ctrl:true});else this.model.drawings.undo();return this.changed();}
 redo() {if(this.controller)this.controller.key('z',{ctrl:true,shift:true});else this.model.drawings.redo();return this.changed();}
 setTool(tool) {if(!this.controller)throw new Error('Interaction controller required');this.controller.setTool(tool,{notify:false});return this.changed();}
 setText(text) {if(!this.controller||typeof text!=='string'||text.length>2000)throw new TypeError('Drawing text, at most 2000 characters');this.controller.text=text;return this.changed();}
 setTheme(patch) {optionRecord(patch,THEME_KEYS,'Theme');const next=style(patch,['background','grid','text','up','down','crosshair']);this.model.theme={...this.model.theme,...next};return this.changed();}
 setSymbol(options) {
  const symbol=validateSymbol(options);zonedParts(0,symbol.timezone);
  this.model.symbol=symbol;this.model.precision=symbol.priceDecimals;this.model.priceFormatter=price=>formatPrice(price,symbol);
  this.model.timeFormatter=time=>{const p=zonedParts(time,symbol.timezone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;};rememberSymbolFormatters(this.model);return this.changed();
 }
 setVisibleRange(from,to) {this.model.setVisibleRange(from,to);return this.changed();}
 fit() {this.model.fit();return this.changed();}
 zoom(factor,anchor) {this.model.zoom(factor,anchor);return this.changed();}
 pan(delta) {this.model.pan(delta);return this.changed();}
 inspect() {return JSON.parse(JSON.stringify({view:this.model.view,theme:this.model.theme,panels:this.model.panels,axes:this.model.axes,drawingTarget:this.controller?.drawingTarget??null,series:this.model.series.map(({rangeIndex,values,revision,dirtyFrom,...s})=>({...s,...(values?{valueCount:values.length}:{})})),symbol:this.model.symbol,storedBars:this.model.store.length,lastBar:this.model.store.length?this.model.store.at(this.model.store.length-1):null,drawings:this.model.drawings.items,selected:this.model.drawings.selected,tool:this.controller?.tool??null,pointers:this.controller?.pointers.size??0,gesture:this.controller?.gesture?.kind??null}));}
}
