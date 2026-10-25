import {registerStoreOwner,unregisterStoreOwner} from './store-owners.mjs';
import {BarStore, RangeIndex} from './data.mjs';
import {IndicatorEngine} from './indicators.mjs';
import {DrawingStore} from './drawings.mjs';
import {BlockRangeIndex} from './block-index.mjs';
import {aggregateVolumeSeries} from './scene-parts.mjs';
import {labelMetrics} from './labels.mjs';
import {optionRecord,identifier,boundedText,PANEL_KEYS,AXIS_KEYS,SERIES_KEYS,THEME_KEYS,RESOURCE_LIMITS} from './contracts.mjs';

// Keep small-series flat queries; large series use the existing32-value blocks.
// This is shared with background preparation so ready caches need no conversion.
export const SERIES_BLOCK_THRESHOLD = 65536;

// The public layout mutators accept host supplied values.  Keep their
// snapshots descriptor based so an accessor, sparse array, or a Proxy cannot
// turn validation into a partial mutation.  Managed chart state is ordinary
// data, so an owner guard can then compare the exact objects that were
// validated before committing.
const ownValue=(object,key)=>{const descriptor=Object.getOwnPropertyDescriptor(object,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
const intrinsicMapSize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
function ownData(object,key,label,optional=false){
  const descriptor=object&&Object.getOwnPropertyDescriptor(object,key);
  if(!descriptor){if(optional)return undefined;throw new TypeError(label+' own data slot required');}
  if(!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');
  return descriptor.value;
}
function staleError(message){const error=new Error(message);error.name='StaleSourceError';return error;}
function sameDataDescriptor(current,expected){return !!current&&!!expected&&Object.hasOwn(current,'value')&&Object.hasOwn(expected,'value')&&current.value===expected.value&&current.writable===expected.writable&&current.enumerable===expected.enumerable&&current.configurable===expected.configurable;}
function chartOwnerCurrent(model,owner,controller){
  const disposedDescriptor=Object.getOwnPropertyDescriptor(model,'disposed');if(disposedDescriptor&&!Object.hasOwn(disposedDescriptor,'value'))return false;
  if(disposedDescriptor?.value)return false;
  const ownerModelDescriptor=owner&&Object.getOwnPropertyDescriptor(owner,'model');if(owner&&( !ownerModelDescriptor||!Object.hasOwn(ownerModelDescriptor,'value')||ownerModelDescriptor.value!==model))return false;
  const ownerControllerDescriptor=owner&&Object.getOwnPropertyDescriptor(owner,'controller');if(owner&&(!ownerControllerDescriptor||!Object.hasOwn(ownerControllerDescriptor,'value')||ownerControllerDescriptor.value!==controller))return false;
  const ownerInvalidateDescriptor=owner&&Object.getOwnPropertyDescriptor(owner,'invalidate');if(owner&&(!ownerInvalidateDescriptor||!Object.hasOwn(ownerInvalidateDescriptor,'value')||typeof ownerInvalidateDescriptor.value!=='function'))return false;
  const controllerModelDescriptor=controller&&Object.getOwnPropertyDescriptor(controller,'model');if(controller&&(!controllerModelDescriptor||!Object.hasOwn(controllerModelDescriptor,'value')||controllerModelDescriptor.value!==model))return false;
  return true;
}
function rejectOwnedInput(controller,model){
  if(!controller)return;
  const controllerModel=Object.getOwnPropertyDescriptor(controller,'model');if(!controllerModel||!Object.hasOwn(controllerModel,'value')||controllerModel.value!==model)return;
  const gesture=ownData(controller,'gesture','Interaction controller',true),pointers=ownData(controller,'pointers','Interaction controller',true);let pointerCount=0;if(pointers!==undefined&&pointers!==null){try{pointerCount=intrinsicMapSize.call(pointers);}catch{throw new TypeError('Interaction controller pointers map required');}}if(gesture||pointerCount)throw new Error('Panel layout change during active gesture');
}
function strictArrayValues(value,label,max=RESOURCE_LIMITS.maxPanels){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError(label+' dense array required');
  const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length'),length=lengthDescriptor?.value;
  if(!lengthDescriptor||!Object.hasOwn(lengthDescriptor,'value')||!Number.isSafeInteger(length)||length<0||length>max)throw new TypeError(label+' dense array required');
  const keys=Reflect.ownKeys(value);if(keys.length!==length+1)throw new TypeError(label+' dense array required');
  const result=[];for(let index=0;index<length;index++){
    const key=String(index),descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' dense array required');
    result.push(descriptor.value);
  }
  return result;
}
function strictPlacementRecord(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Indicator placement record required');
  const keys=Reflect.ownKeys(value),allowed=['panel','axisId'];if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)))throw new TypeError('Indicator placement fields');
  const panelDescriptor=Object.getOwnPropertyDescriptor(value,'panel');if(!panelDescriptor||!panelDescriptor.enumerable||!Object.hasOwn(panelDescriptor,'value'))throw new TypeError('Indicator placement panel required');
  const axisDescriptor=Object.getOwnPropertyDescriptor(value,'axisId');if(axisDescriptor&&(!axisDescriptor.enumerable||!Object.hasOwn(axisDescriptor,'value')))throw new TypeError('Indicator placement axisId data field required');
  const panel=panelDescriptor.value,axisId=axisDescriptor?.value??null;identifier(panel,'Indicator placement panel');if(axisId!==null)identifier(axisId,'Indicator placement axis');return {panel,axisId};
}
function managedPanels(model){
  const panels=ownData(model,'panels','Panel owner');if(!Array.isArray(panels)||Object.getPrototypeOf(panels)!==Array.prototype)throw staleError('Panel owner changed');
  const refs=strictArrayValues(panels,'Panel owner',RESOURCE_LIMITS.maxPanels),ids=refs.map(panel=>{const id=ownData(panel,'id','Panel');identifier(id,'Panel id');return id;});
  if(refs.length<1||refs.length>RESOURCE_LIMITS.maxPanels||new Set(ids).size!==refs.length)throw staleError('Panel owner changed');
  return {panels,refs,ids};
}
function managedAxes(model){
  const axes=ownData(model,'axes','Axis owner');if(!Array.isArray(axes)||Object.getPrototypeOf(axes)!==Array.prototype)throw staleError('Axis owner changed');
  const refs=strictArrayValues(axes,'Axis owner',RESOURCE_LIMITS.maxAxes),records=refs.map(axis=>{const id=ownData(axis,'id','Axis'),panel=ownData(axis,'panel','Axis');identifier(id,'Axis id');identifier(panel,'Axis panel');return {ref:axis,id,panel};});
  return {axes,refs,records};
}
function panelOwnerGuard(model,owner,snapshot){
  if(!chartOwnerCurrent(model,owner,snapshot.controller)||ownData(model,'panels','Panel owner')!==snapshot.panels||snapshot.refs.length!==snapshot.panels.length||snapshot.refs.some((panel,index)=>snapshot.panels[index]!==panel||ownData(panel,'id','Panel')!==snapshot.ids[index]))throw staleError('Panel layout owner changed');
  if(!chartOwnerCurrent(model,owner,snapshot.controller))throw staleError('Panel layout owner changed');
}
function indicatorOwnerGuard(model,owner,snapshot,checkBindings=true,allowTransaction=false){
  if(!chartOwnerCurrent(model,owner,snapshot.controller)||ownData(model,'store','Chart')!==snapshot.store||snapshot.store.version!==snapshot.version||ownData(model,'indicators','Chart')!==snapshot.engine||ownData(snapshot.engine,'entries','Indicator engine')!==snapshot.entries||Map.prototype.get.call(snapshot.entries,snapshot.id)!==snapshot.entry||ownData(model,'series','Chart')!==snapshot.series||snapshot.seriesRefs.length!==snapshot.series.length||snapshot.seriesRefs.some((series,index)=>snapshot.series[index]!==series)||ownData(model,'drawings','Chart')!==snapshot.drawings||!allowTransaction&&ownData(snapshot.drawings,'transaction','Drawing store')||ownData(model,'panels','Chart')!==snapshot.panels.panels||snapshot.panels.refs.length!==snapshot.panels.panels.length||snapshot.panels.refs.some((panel,index)=>snapshot.panels.panels[index]!==panel||ownData(panel,'id','Panel')!==snapshot.panels.ids[index])||ownData(model,'axes','Chart')!==snapshot.axes.axes||snapshot.axes.refs.length!==snapshot.axes.axes.length||snapshot.axes.records.some((axis,index)=>snapshot.axes.axes[index]!==axis.ref||ownData(axis.ref,'id','Axis')!==axis.id||ownData(axis.ref,'panel','Axis')!==axis.panel))throw staleError('Indicator placement owner changed');
  if(snapshot.controller&&snapshot.targetCaptured&&(!sameDataDescriptor(Object.getOwnPropertyDescriptor(snapshot.controller,'drawingTarget'),snapshot.targetSlot)||ownData(snapshot.controller,'drawingTarget','Interaction controller',true)!==snapshot.controllerTarget))throw staleError('Indicator placement owner changed');
  if(checkBindings&&snapshot.bound.some(({ref,id,indicator,panel,axisId})=>ownData(ref,'id','Series')!==id||ownData(ref,'indicator','Series',true)!==indicator||ownData(ref,'panel','Series')!==panel||((ownData(ref,'axisId','Series',true)??null)!==(axisId??null))))throw staleError('Indicator placement owner changed');
  if(!chartOwnerCurrent(model,owner,snapshot.controller))throw staleError('Indicator placement owner changed');
}
function managedArraySnapshot(value,label,max,record){
  const refs=strictArrayValues(value,label,max);return {array:value,refs,records:refs.map(record)};
}
function managedArrayGuard(snapshot,label,max,record){
  const refs=strictArrayValues(snapshot.array,label,max);if(refs.length!==snapshot.refs.length||refs.some((value,index)=>value!==snapshot.refs[index]))throw staleError(label+' owner changed');
  if(record&&refs.some((value,index)=>{const next=record(value),before=snapshot.records[index];return Object.keys(before).some(key=>next[key]!==before[key]);}))throw staleError(label+' owner changed');
}
function drawingFrameSnapshot(value,label){return managedArraySnapshot(value,label,RESOURCE_LIMITS.maxDrawings,drawing=>({ref:drawing,panel:ownData(drawing,'panel','Drawing')}));}
function drawingFrameGuard(snapshot,label){managedArrayGuard(snapshot,label,RESOURCE_LIMITS.maxDrawings,drawing=>({ref:drawing,panel:ownData(drawing,'panel','Drawing')}));}
function drawingHistorySnapshot(drawings){
  const items=ownData(drawings,'items','Drawing store'),undo=ownData(drawings,'undoStack','Drawing store'),redo=ownData(drawings,'redoStack','Drawing store');
  const stack=(value,label)=>managedArraySnapshot(value,label,10000,frame=>({ref:frame,snapshot:drawingFrameSnapshot(frame,label+' frame')}));
  return {drawings,items:drawingFrameSnapshot(items,'Drawing items'),undo:stack(undo,'Drawing undo history'),redo:stack(redo,'Drawing redo history')};
}
function drawingHistoryGuard(snapshot){
  const drawings=snapshot.drawings;if(ownData(drawings,'transaction','Drawing store'))throw staleError('Drawing history owner changed');
  if(ownData(drawings,'items','Drawing store')!==snapshot.items.array||ownData(drawings,'undoStack','Drawing store')!==snapshot.undo.array||ownData(drawings,'redoStack','Drawing store')!==snapshot.redo.array)throw staleError('Drawing history owner changed');
  drawingFrameGuard(snapshot.items,'Drawing items');
  for(const stack of [snapshot.undo,snapshot.redo]){const refs=strictArrayValues(stack.array,stack===snapshot.undo?'Drawing undo history':'Drawing redo history',10000);if(refs.length!==stack.refs.length||refs.some((frame,index)=>frame!==stack.refs[index]))throw staleError('Drawing history owner changed');for(const record of stack.records)drawingFrameGuard(record.snapshot,stack===snapshot.undo?'Drawing undo history frame':'Drawing redo history frame');}
}
function seriesRecord(series){return {ref:series,id:ownData(series,'id','Series'),panel:ownData(series,'panel','Series'),axisId:ownData(series,'axisId','Series',true)??null,indicator:ownData(series,'indicator','Series',true)};}
function axisRecord(axis){return {ref:axis,id:ownData(axis,'id','Axis'),panel:ownData(axis,'panel','Axis')};}
function seriesStateSnapshot(series){return managedArraySnapshot(series,'Series owner',RESOURCE_LIMITS.maxSeries,seriesRecord);}
function axisStateSnapshot(axes){return managedArraySnapshot(axes,'Axis owner',RESOURCE_LIMITS.maxAxes,axisRecord);}
function seriesStateGuard(snapshot){managedArrayGuard(snapshot,'Series owner',RESOURCE_LIMITS.maxSeries,seriesRecord);}
function axisStateGuard(snapshot){managedArrayGuard(snapshot,'Axis owner',RESOURCE_LIMITS.maxAxes,axisRecord);}
function cloneSeriesPlacement(series,panel,axisId){
  const descriptors=Object.getOwnPropertyDescriptors(series);for(const descriptor of Object.values(descriptors))if(!Object.hasOwn(descriptor,'value'))throw new TypeError('Series own data fields required');
  const panelDescriptor=descriptors.panel,axisDescriptor=descriptors.axisId;descriptors.panel={value:panel,writable:true,enumerable:panelDescriptor?.enumerable??true,configurable:true};descriptors.axisId={value:axisId,writable:true,enumerable:axisDescriptor?.enumerable??true,configurable:true};
  return Object.create(Object.getPrototypeOf(series),descriptors);
}
function cloneDrawingTarget(target,panel,axisId){
  const descriptors=Object.getOwnPropertyDescriptors(target);for(const descriptor of Object.values(descriptors))if(!Object.hasOwn(descriptor,'value'))throw new TypeError('Drawing target own data fields required');
  const panelDescriptor=descriptors.panel,axisDescriptor=descriptors.axisId;descriptors.panel={value:panel,writable:true,enumerable:panelDescriptor?.enumerable??true,configurable:true};descriptors.axisId={value:axisId,writable:true,enumerable:axisDescriptor?.enumerable??true,configurable:true};return Object.create(Object.getPrototypeOf(target),descriptors);
}
function strictIndicatorBindingRecord(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Indicator binding record required');
  const keys=Reflect.ownKeys(value),allowed=['seriesId','panel','axisId'];if(keys.length!==allowed.length||keys.some(key=>typeof key!=='string'||!allowed.includes(key)))throw new TypeError('Indicator binding fields');
  const read=key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError('Indicator binding own data fields required');return descriptor.value;};
  const seriesId=read('seriesId'),panel=read('panel'),axisId=read('axisId');identifier(seriesId,'Indicator binding series');identifier(panel,'Indicator binding panel');if(axisId!==null)identifier(axisId,'Indicator binding axis');return {seriesId,panel,axisId};
}
function strictIndicatorBindings(value){return strictArrayValues(value,'Indicator bindings',RESOURCE_LIMITS.maxSeries).map(strictIndicatorBindingRecord);}

function axisStripWidths(panels,axes,axisWidth){
  let left=0,right=0;
  for(const panel of panels){let rowLeft=0,rowRight=0;if(panel.axisVisible!==false){if(panel.axisSide==='left')rowLeft=axisWidth;else rowRight=axisWidth;}
    for(const axis of axes)if(axis.panel===panel.id&&axis.visible){if(axis.side==='left')rowLeft+=axis.width??axisWidth;else rowRight+=axis.width??axisWidth;}
    left=Math.max(left,rowLeft);right=Math.max(right,rowRight);
  }
  return [left,right];
}

export const DARK_THEME = {background: '#0c1320', grid: '#1d2a3a', text: '#8093ad', up: '#35d2ab', down: '#fa6c7c', crosshair: '#b9c9de', font: '12px monospace'};
export const LIGHT_THEME = {background: '#f8fafc', grid: '#dfe6ee', text: '#53657d', up: '#078d6d', down: '#df344b', crosshair: '#304158', font: '12px monospace'};
export class ChartModel {
  constructor({store = new BarStore(), theme = DARK_THEME, panels = [{id: 'price', weight: 3}], axes = [], visibleBars = 200, axisWidth = 82, precision = 2} = {}) {
    if (!panels.length || !Number.isFinite(axisWidth) || axisWidth < 20 || !Number.isFinite(visibleBars) || visibleBars < 1 || !Number.isInteger(precision) || precision < 0 || precision > 18) throw new RangeError('Panels, width, visible bars or precision');
    if(!(store instanceof BarStore))throw new TypeError('BarStore required');optionRecord(theme,THEME_KEYS,'Theme');for(const value of Object.values(theme))boundedText(value,256,'Theme value');
    this.store = store; this.theme = {...DARK_THEME, ...theme}; this.panels = []; this.axes = []; this.series = []; this.seriesValueRevisions = new WeakMap(); this.axisWidth = axisWidth; this.precision = precision;
    this.view = {from: Math.max(-.5, store.length - visibleBars - .5), to: Math.max(visibleBars - .5, store.length - .5)}; this.crosshair = null; this.follow = true;
    // A nonempty backfill rebases existing anchors. First history has none:
    // follow the tail like append, or retain an explicitly unfollowed view.
    panels.forEach(p => this.addPanel(p));if(!Array.isArray(axes))throw new TypeError('Axes array required');axes.forEach(a=>this.addAxis(a));this.indicators=new IndicatorEngine(store);try{this.drawings=new DrawingStore(); this.unsubscribe = store._subscribeInternal(({kind, from, added, appended}) => {if(kind==='compact')return;if (kind === 'prepend' && store.length > added) {this.view.from += added; this.view.to += added;} else if (kind === 'reset') this.fit(); if ((kind === 'append'||kind==='batch'&&appended>0||kind==='prepend'&&added>0&&store.length===added) && this.follow) {const span = this.view.to - this.view.from; this.view.to = store.length + this.forwardOffset() - .5; this.view.from = this.view.to - span;} for (const s of this.series) s.dirtyFrom = Math.min(s.dirtyFrom ?? Infinity, from);});registerStoreOwner(this,store,'model');}catch(error){try{this.indicators.dispose();}catch{}throw error;}
  }
  addPanel(options) {optionRecord(options,PANEL_KEYS,'Panel');identifier(options.id,'Panel id');if(this.panels.length>=RESOURCE_LIMITS.maxPanels)throw new RangeError('Panel limit');if (!options?.id || this.panels.some(p => p.id === options.id) || !Number.isFinite(options.weight ?? 1) || (options.weight ?? 1) <= 0) throw new Error('Unique panel id and positive weight'); const p = {weight: 1, scale: 'linear', inverted: false, padding: .08, ...options}; this.validatePanel(p);if(this.drawings?.transaction)throw new Error('Panel layout change during drawing transaction'); this.panels.push(p); return p.id;}
  validatePanel(p) {if(p.axisVisible!==undefined&&typeof p.axisVisible!=='boolean'||p.axisSide!==undefined&&!['left','right'].includes(p.axisSide))throw new TypeError('Panel axis visibility/side');if(typeof p.inverted!=='boolean'||p.label!==undefined&&typeof p.label!=='string'||p.formatter!==undefined&&typeof p.formatter!=='function'||p.range&&(!Array.isArray(p.range)||p.range.length!==2))throw new TypeError('Panel label, inverted, formatter or range');if(p.label!==undefined)boundedText(p.label,256,'Panel label');if (!Number.isFinite(p.weight) || p.weight <= 0 || p.base !== undefined && !Number.isFinite(p.base) || !['linear', 'log', 'percent'].includes(p.scale) || !Number.isFinite(p.padding) || p.padding < 0 || p.padding > 1 || p.precision !== undefined && (!Number.isInteger(p.precision) || p.precision < 0 || p.precision > 18) || (p.range && (!Number.isFinite(p.range[0]) || !Number.isFinite(p.range[1]) || p.range[0] >= p.range[1] || p.scale === 'log' && p.range[0] <= 0)) || p.scale === 'percent' && p.base === 0) throw new RangeError('Panel scale/range');}
  drawingProjectionChange(previous,next,keys){return keys.some(key=>Array.isArray(previous[key])&&Array.isArray(next[key])?previous[key].length!==next[key].length||previous[key].some((v,i)=>!Object.is(v,next[key][i])):!Object.is(previous[key],next[key]));}
  drawingMarginsChange(panels=this.panels,axes=this.axes){const before=axisStripWidths(this.panels,this.axes,this.axisWidth),after=axisStripWidths(panels,axes,this.axisWidth);return before.some((value,index)=>value!==after[index]);}
  setPanel(id, patch) {optionRecord(patch,PANEL_KEYS.filter(k=>k!=='id'),'Panel patch');const i=this.panels.findIndex(p=>p.id===id);if(i<0)throw new Error('Missing panel');const previous=this.panels[i],next={...previous,...patch};this.validatePanel(next);if(this.drawings?.transaction&&(this.drawingProjectionChange(previous,next,['weight'])||this.drawingMarginsChange(this.panels.map((p,j)=>j===i?next:p))||this.drawingProjectionChange(previous,next,['scale','inverted','padding','range','base','axisVisible','axisSide'])&&[...this.drawings.items,...this.drawings.transaction].some(d=>d.panel===id)))throw new Error('Panel projection change during drawing transaction');this.panels[i]=next;}
  setPanelOrder(ids,{owner=null,controller=null}={}) {
    const disposedDescriptor=Object.getOwnPropertyDescriptor(this,'disposed');if(disposedDescriptor&&!Object.hasOwn(disposedDescriptor,'value'))throw new TypeError('Chart disposed own data slot required');if(disposedDescriptor?.value)throw new Error('Chart disposed');
    const drawings=ownData(this,'drawings','Chart'),snapshot={...managedPanels(this),drawings},requested=strictArrayValues(ids,'Panel order');
    if(requested.length!==snapshot.ids.length)throw new TypeError('Panel order must contain every current panel exactly once');
    const byId=new Map(snapshot.ids.map((id,index)=>[id,snapshot.refs[index]])),seen=new Set(),ordered=[];
    for(const id of requested){identifier(id,'Panel order id');if(seen.has(id)||!byId.has(id))throw new Error('Panel order must contain every current panel exactly once');seen.add(id);ordered.push(byId.get(id));}
    const changed=ordered.some((panel,index)=>panel!==snapshot.refs[index]);
    panelOwnerGuard(this,owner,{...snapshot,controller});
    if(ownData(this,'drawings','Chart')!==drawings)throw staleError('Panel layout owner changed');
    panelOwnerGuard(this,owner,{...snapshot,controller});
    rejectOwnedInput(controller,this);
    if(changed&&ownData(drawings,'transaction','Drawing store'))throw new Error('Panel layout change during drawing transaction');
    if(!changed)return false;
    this.panels=ordered;
    return true;
  }
  removePanel(id,{owner=null,controller=null,controllerTarget=undefined,controllerTargetSlot=undefined}={}) {
    const disposedDescriptor=Object.getOwnPropertyDescriptor(this,'disposed');if(disposedDescriptor&&!Object.hasOwn(disposedDescriptor,'value'))throw new TypeError('Chart disposed own data slot required');if(disposedDescriptor?.value)throw new Error('Chart disposed');identifier(id,'Panel id');
    rejectOwnedInput(controller,this);
    const snapshot=managedPanels(this),index=snapshot.ids.indexOf(id);if(index<0)throw new Error('Missing panel');
    if(snapshot.refs.length===1)throw new Error('Cannot remove the last panel');
    const series=ownData(this,'series','Chart'),seriesState=seriesStateSnapshot(series);if(seriesState.records.some(record=>record.panel===id))throw new Error('Panel is referenced by series');
    const axes=ownData(this,'axes','Chart'),axisState=axisStateSnapshot(axes);if(axisState.records.some(record=>record.panel===id))throw new Error('Panel is referenced by axis');
    const drawings=ownData(this,'drawings','Chart');if(!drawings||ownData(drawings,'transaction','Drawing store'))throw new Error('Panel is referenced by an active drawing transaction');
    const drawingState=drawingHistorySnapshot(drawings);if(drawingState.items.records.some(record=>record.panel===id)||[...drawingState.undo.records,...drawingState.redo.records].some(record=>record.snapshot.records.some(drawing=>drawing.panel===id)))throw new Error('Panel is referenced by drawing history');
    panelOwnerGuard(this,owner,{...snapshot,controller});
    if(ownData(this,'series','Chart')!==series||ownData(this,'axes','Chart')!==axes||ownData(this,'drawings','Chart')!==drawings)throw staleError('Panel removal owner changed');
    if(controller&&controllerTargetSlot!==undefined&&(!sameDataDescriptor(Object.getOwnPropertyDescriptor(controller,'drawingTarget'),controllerTargetSlot)||ownData(controller,'drawingTarget','Interaction controller',true)!==controllerTarget))throw staleError('Panel removal owner changed');
    seriesStateGuard(seriesState);axisStateGuard(axisState);drawingHistoryGuard(drawingState);panelOwnerGuard(this,owner,{...snapshot,controller});rejectOwnedInput(controller,this);
    this.panels=snapshot.refs.filter((_,entryIndex)=>entryIndex!==index);
  }
  _setIndicatorPlacement(id,placement,options={}) {return this._applyIndicatorBindings(id,{kind:'placement',value:placement},options);}
  _restoreIndicatorBindings(id,bindings,options={}) {return this._applyIndicatorBindings(id,{kind:'records',value:bindings},options);}
  _applyIndicatorBindings(id,request,options={}) {
    const {owner=null,controller=null,updateControllerTarget=false}=options;
    const disposedDescriptor=Object.getOwnPropertyDescriptor(this,'disposed');if(disposedDescriptor&&!Object.hasOwn(disposedDescriptor,'value'))throw new TypeError('Chart disposed own data slot required');if(disposedDescriptor?.value)throw new Error('Chart disposed');identifier(id,'Indicator id');
    const engine=ownData(this,'indicators','Chart'),entries=ownData(engine,'entries','Indicator engine'),entry=Map.prototype.get.call(entries,id);if(!entry)throw new Error('Missing indicator');
    const store=ownData(this,'store','Chart'),series=ownData(this,'series','Chart'),drawings=ownData(this,'drawings','Chart'),panels=managedPanels(this),axes=managedAxes(this);
    const seriesState=seriesStateSnapshot(series),seriesRefs=seriesState.refs,bound=seriesState.records.filter(record=>record.indicator===id).map(record=>({ref:record.ref,panel:record.panel,axisId:record.axisId,id:record.id,indicator:record.indicator}));
    if(!bound.length)throw new Error('Indicator has no bound series');
    // Capture the target before reflecting over the requested placement. A
    // host supplied field getter may reenter the chart, and the final owner
    // guard must observe the target that was current at call entry.
    const targetSlot=controller?(Object.hasOwn(options,'controllerTargetSlot')?options.controllerTargetSlot:Object.getOwnPropertyDescriptor(controller,'drawingTarget')):undefined,targetCaptured=!!controller&&!!targetSlot,controllerTarget=controller?(Object.hasOwn(options,'controllerTarget')?options.controllerTarget:ownData(controller,'drawingTarget','Interaction controller',true)):undefined;
    const targetSeriesId=targetCaptured&&controllerTarget?ownData(controllerTarget,'seriesId','Drawing target',true):undefined;
    const targetTemplate=updateControllerTarget&&targetSeriesId!==undefined&&targetSeriesId!==null?cloneDrawingTarget(controllerTarget,ownData(controllerTarget,'panel','Drawing target'),ownData(controllerTarget,'axisId','Drawing target',true)??null):null;
    const snapshot={id,engine,entries,entry,store,version:store.version,series,seriesRefs,drawings,bound,controller,panels,axes,targetCaptured,controllerTarget,targetSlot};
    let targets;
    if(request?.kind==='placement'){
      const next=strictPlacementRecord(request.value);if(panels.ids.indexOf(next.panel)<0)throw new Error('Missing placement panel');if(next.axisId!==null&&!axes.records.some(axis=>axis.id===next.axisId&&axis.panel===next.panel))throw new Error('Missing placement axis');
      targets=bound.map(record=>({id:record.id,panel:next.panel,axisId:next.axisId}));
    } else if(request?.kind==='records'){
      const requested=strictIndicatorBindings(request.value);if(requested.length!==bound.length)throw new TypeError('Indicator bindings must contain every bound series exactly once');
      const byId=new Map(bound.map(record=>[record.id,record])),seen=new Set();for(const target of requested){if(seen.has(target.seriesId))throw new TypeError('Duplicate indicator binding series');if(!byId.has(target.seriesId))throw new Error('Foreign indicator binding series');seen.add(target.seriesId);if(panels.ids.indexOf(target.panel)<0)throw new Error('Missing placement panel');if(target.axisId!==null&&!axes.records.some(axis=>axis.id===target.axisId&&axis.panel===target.panel))throw new Error('Missing placement axis');}
      if(seen.size!==bound.length)throw new TypeError('Indicator bindings must contain every bound series exactly once');const requestedById=new Map(requested.map(target=>[target.seriesId,target]));targets=bound.map(record=>{const target=requestedById.get(record.id);return {id:record.id,panel:target.panel,axisId:target.axisId};});
    } else throw new TypeError('Indicator binding request required');
    rejectOwnedInput(controller,this);indicatorOwnerGuard(this,owner,snapshot);
    const changed=bound.filter((record,index)=>record.panel!==targets[index].panel||record.axisId!==targets[index].axisId).length;
    if(!changed){indicatorOwnerGuard(this,owner,snapshot,true,true);rejectOwnedInput(controller,this);if(ownData(drawings,'transaction','Drawing store'))throw new Error('Indicator placement during drawing transaction');return {changed:0,panel:targets[0].panel,axisId:targets[0].axisId,boundIds:bound.map(record=>record.id)};}
    const targetRecord=targetSeriesId!==undefined&&targetSeriesId!==null?targets.find(target=>target.id===targetSeriesId):undefined,targetNeedsUpdate=!!targetRecord;if(targetNeedsUpdate&&(!snapshot.targetSlot||snapshot.targetSlot.writable!==true))throw new TypeError('Interaction controller drawing target must be writable own data');
    const targetsById=new Map(targets.map(target=>[target.id,target])),nextSeries=seriesRefs.slice();for(const [index,record] of seriesState.records.entries())if(record.indicator===id){const target=targetsById.get(record.id);if(record.panel!==target.panel||record.axisId!==target.axisId)nextSeries[index]=cloneSeriesPlacement(record.ref,target.panel,target.axisId);}
    if(ownData(drawings,'transaction','Drawing store'))throw new Error('Indicator placement during drawing transaction');
    indicatorOwnerGuard(this,owner,snapshot,true,true);rejectOwnedInput(controller,this);
    if(ownData(drawings,'transaction','Drawing store'))throw new Error('Indicator placement during drawing transaction');
    const seriesSlot=Object.getOwnPropertyDescriptor(this,'series');if(!seriesSlot||!Object.hasOwn(seriesSlot,'value')||seriesSlot.writable!==true)throw new TypeError('Chart series owner is not writable');
    this.series=nextSeries;
    if(updateControllerTarget&&targetNeedsUpdate)controller.drawingTarget=cloneDrawingTarget(targetTemplate,targetRecord.panel,targetRecord.axisId);
    return {changed,panel:targets[0].panel,axisId:targets[0].axisId,boundIds:bound.map(record=>record.id)};
  }
  validateAxis(a) {
    optionRecord(a,AXIS_KEYS,'Axis');identifier(a.id,'Axis id');identifier(a.panel,'Axis panel');
    if(!this.panels.some(p=>p.id===a.panel))throw new Error('Missing axis panel');
    this.validatePanel({weight:1,scale:'linear',inverted:false,padding:.08,...Object.fromEntries(['scale','inverted','padding','range','base','precision','formatter','label'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]))});
    if(!['left','right'].includes(a.side)||typeof a.visible!=='boolean'||!['fixed','scientific'].includes(a.tickFormat)||a.width!==undefined&&(!Number.isFinite(a.width)||a.width<20||a.width>256))throw new TypeError('Axis side/visibility/format/width');
    for(const key of ['prefix','suffix'])if(a[key]!==undefined)boundedText(a[key],64,'Axis '+key,true);
    if(a.scale==='percent'&&(!Number.isFinite(a.base)||a.base===0))throw new RangeError('Independent percent axis requires an explicit nonzero base');
    return true;
  }
  addAxis(options) {optionRecord(options,AXIS_KEYS,'Axis');if(this.axes.length>=RESOURCE_LIMITS.maxAxes)throw new RangeError('Axis limit');if(this.axes.some(a=>a.id===options.id))throw new Error('Duplicate axis');const a={side:'right',scale:'linear',inverted:false,padding:.08,visible:true,tickFormat:'fixed',...options};this.validateAxis(a);if(this.drawings?.transaction&&this.drawingMarginsChange(this.panels,[...this.axes,a]))throw new Error('Axis layout change during drawing transaction');this.axes.push(a);return a.id;}
  setAxis(id,patch) {optionRecord(patch,AXIS_KEYS.filter(k=>k!=='id'&&k!=='panel'),'Axis patch');const i=this.axes.findIndex(a=>a.id===id);if(i<0)throw new Error('Missing axis');const previous=this.axes[i],a={...previous,...patch};this.validateAxis(a);if(this.drawings?.transaction&&(this.drawingMarginsChange(this.panels,this.axes.map((axis,j)=>j===i?a:axis))||this.drawingProjectionChange(previous,a,['scale','inverted','padding','range','base','width','side','visible'])&&[...this.drawings.items,...this.drawings.transaction].some(d=>d.axisId===id)))throw new Error('Axis projection change during drawing transaction');this.axes[i]=a;}
  removeAxis(id) {if(this.series.some(s=>s.axisId===id)||[...this.drawings.items,...this.drawings.transaction??[],...this.drawings.undoStack.flat(),...this.drawings.redoStack.flat()].some(d=>d.axisId===id))throw new Error('Axis is referenced by series or drawing history/transaction');const axes=this.axes.filter(a=>a.id!==id);if(this.drawings.transaction&&this.drawingMarginsChange(this.panels,axes))throw new Error('Axis layout change during drawing transaction');this.axes=axes;}
  validateDrawingBinding(d,{allowOrphanSeries=false}={}) {
    if(d.panel!==undefined)identifier(d.panel,'Drawing panel');for(const key of ['axisId','seriesId'])if(d[key]!==undefined&&d[key]!==null)identifier(d[key],'Drawing '+key);
    if(!this.panels.some(p=>p.id===(d.panel??'price')))throw new Error('Missing drawing panel');
    if(d.axisId!==undefined&&d.axisId!==null&&!this.axes.some(a=>a.id===d.axisId&&a.panel===d.panel))throw new Error('Missing drawing axis binding');
    if(!allowOrphanSeries&&d.seriesId!==undefined&&d.seriesId!==null){const s=this.series.find(s=>s.id===d.seriesId);if(!s||s.panel!==d.panel||(s.axisId??null)!==(d.axisId??null))throw new Error('Missing or mismatched drawing series binding');}
    return true;
  }
  normalizedSeries(options) {
    optionRecord(options,SERIES_KEYS,'Series');identifier(options.id,'Series id');identifier(options.panel,'Series panel');
    if(options.axisId!==undefined&&options.axisId!==null){identifier(options.axisId,'Series axis');if(!this.axes.some(a=>a.id===options.axisId&&a.panel===options.panel))throw new Error('Missing series axis in panel');}
    if(options.symbolId!==undefined){identifier(options.symbolId,'Series symbol');if(!options.values)throw new TypeError('symbolId belongs to externally aligned values; store/indicator series use primary symbol');}
    if(options.label!==undefined)boundedText(options.label,256,'Series label');
    for(const key of ['color','fill','upColor','downColor'])if(options[key]!==undefined&&options[key]!==null)boundedText(options[key],128,key);
    if(options.visible!==undefined&&typeof options.visible!=='boolean'||options.width!==undefined&&(!Number.isFinite(options.width)||options.width<=0||options.width>50)||options.baseline!==undefined&&!Number.isFinite(options.baseline))throw new TypeError('Series style/visibility');
    if(!options?.id||!this.panels.some(p=>p.id===options.panel)) throw new Error('Unique series id and existing panel required');
    if(['candles','ohlc'].includes(options.type)&&(options.indicator||options.values||options.source!==undefined||options.symbolId!==undefined))throw new TypeError('Candles/OHLC use primary store OHLCV');
    if (!['candles', 'ohlc', 'line', 'area', 'histogram'].includes(options.type)) throw new Error('Unknown series type');
    if(options.values&&options.indicator)throw new TypeError('Series chooses external values or indicator output');
    if (options.values && (!(options.values instanceof Float64Array) || options.values.length !== this.store.length)) throw new TypeError('Values must be aligned Float64Array');
    const data = options.indicator ? this.indicators.get(options.indicator) : null;if(options.source!==undefined&&!['time','open','high','low','close','volume'].includes(options.source))throw new TypeError('Series source');if(data&&options.output!==undefined&&!Object.hasOwn(data.outputs,options.output))throw new Error('Missing indicator output');const output=options.output??(data?Object.keys(data.outputs)[0]:undefined),offset=options.offset??(data&&Object.hasOwn(data.plotOffsets,output)?data.plotOffsets[output]:0);
    if (!Number.isInteger(offset) || Math.abs(offset) > 10000 || ['candles','ohlc'].includes(options.type) && offset !== 0) throw new RangeError('Series plot offset');
    return {color:'#7898ff',width:['candles','ohlc'].includes(options.type)?1:1.5,...options,offset,dirtyFrom:0};
  }
  addSeries(options){if(this.series.length>=RESOURCE_LIMITS.maxSeries)throw new RangeError('Series limit');if(this.series.some(s=>s.id===options?.id))throw new Error('Duplicate series');const validated=this.normalizedSeries(options);this.series.push(validated);return validated.id;}
  removeSeries(id) {this.series = this.series.filter(s => s.id !== id);}
  setSeriesValues(id, values) {const s = this.series.find(s => s.id === id); if (!s || !(values instanceof Float64Array) || values.length !== this.store.length) throw new TypeError('Aligned values and existing series required'); if(['candles','ohlc'].includes(s.type)||s.indicator)throw new TypeError('External values require a general non-indicator series');s.values = values; s.dirtyFrom = 0;this.seriesValueRevisions.set(s,(this.seriesValueRevisions.get(s)??0)+1);this.seriesValuesRevision=(this.seriesValuesRevision??0)+1;}
  seriesData(s) {
    if(this.disposed)throw new Error('Chart disposed');
    let values, revision, computedFrom = 0,computedUntil=this.store.length;
    if (s.indicator) {const data = this.indicators.get(s.indicator); values = data.outputs[s.output ?? Object.keys(data.outputs)[0]]; if (!values) throw new Error('Missing indicator output'); revision = data.revision; computedFrom = data.computedFrom;computedUntil=data.computedUntil;}
    else {values = s.values ?? this.store.columns[s.source ?? 'close'].subarray(0, this.store.length); revision = this.store.version; computedFrom = s.dirtyFrom ?? 0;}
    // A custom indicator callback may dispose its owner during calculation.
    // Never reattach output vectors through a new index after that teardown.
    if(this.disposed)throw new Error('Chart disposed');
    const blocked=values.length>=SERIES_BLOCK_THRESHOLD,policyMismatch=s.rangeIndex&&(s.rangeIndex instanceof BlockRangeIndex)!==blocked;
    // Rebuild only on data changes; pan/zoom uses O(log N) range queries.
    // Extend a blocked index at the final dirty row first, so earlier appended
    // blocks are rescanned with the complete length rather than a partial tail.
    if (s.dirtyFrom < Infinity || s.revision !== revision || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch) {const start = Math.min(s.dirtyFrom ?? Infinity, computedFrom); if (s.indicator&&s.revision!==undefined&&revision>s.revision+1 || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch || s.rangeIndex.size !== this.store.capacity || computedUntil - start > values.length / 4) s.rangeIndex = blocked?new BlockRangeIndex(values.length,values,this.store.capacity):new RangeIndex(values.length, values, values, null, this.store.capacity, true); else {if(s.rangeIndex instanceof BlockRangeIndex){if(computedUntil>start)s.rangeIndex.update(computedUntil-1);for(let i=start;i<computedUntil;i+=s.rangeIndex.blockSize)s.rangeIndex.update(i);}else for(let i=start;i<computedUntil;i++)s.rangeIndex.update(i,values[i]);}s.revision = revision;s.dirtyFrom = Infinity;}
    return {values, index: s.rangeIndex};
  }
  forwardOffset() {return Math.max(0,...this.series.filter(s=>s.visible!==false).map(s=>s.offset??0));}
  setVisibleRange(from, to) {if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError('Visible range'); const n = Math.max(10, this.store.length + this.forwardOffset()), span = Math.min(n, Math.max(Math.min(10, n), to - from)); let a = Math.max(-.5, Math.min(n - .5 - span, from)); this.view = {from: a, to: a + span}; this.follow = Math.abs(this.view.to - (this.store.length + this.forwardOffset() - .5)) < 1;}
  fit() {this.setVisibleRange(-.5, Math.max(9.5, this.store.length + this.forwardOffset() - .5));}
  zoom(factor, anchor = .5) {if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('Zoom factor'); anchor = Math.max(0, Math.min(1, anchor)); const span = this.view.to - this.view.from, at = this.view.from + span * anchor, next = span * factor; this.setVisibleRange(at - next * anchor, at + next * (1 - anchor));}
  pan(deltaBars) {this.setVisibleRange(this.view.from + deltaBars, this.view.to + deltaBars);}
  dispose() {if(this.disposed)return;this.disposed=true;try{this.dataIngestion?.dispose();this.dataIngestion=null;this.unsubscribe();this.indicators.dispose();for(const s of this.series)s.rangeIndex=null;}finally{unregisterStoreOwner(this);}}
}

// Independent price domains share only the reference time geometry.
function axisRange(model, config, series, a, b, left, right, top, bottom) {
  let min=Infinity,max=-Infinity;
  for(const s of series){const volume=aggregateVolumeSeries(s)?model.store.aggregate(a,b,Math.max(1,Math.floor((right-left)/3))):null;
    const sa=Math.min(model.store.length,Math.max(0,Math.floor(model.view.from-(s.offset??0)))),sb=Math.max(sa,Math.min(model.store.length,Math.ceil(model.view.to+1-(s.offset??0))));
    const q=volume?{min:0,max:Math.max(0,...volume.map(b=>b.volume))}:['candles','ohlc'].includes(s.type)?model.store.index.query(a,b):model.seriesData(s).index.query(sa,sb);
    min=Math.min(min,q.min);max=Math.max(max,q.max);if(['histogram','area'].includes(s.type)){min=Math.min(min,s.baseline??0);max=Math.max(max,s.baseline??0);}
  }
  const sourceMin=min,sourceMax=max;
  if(!Number.isFinite(min)||!Number.isFinite(max)){min=config.scale==='log'?1:0;max=config.scale==='log'?10:1;}
  if(config.scale==='log'&&Number.isFinite(min)&&min<=0)throw new RangeError('Log scale requires strictly positive visible data');
  if(config.range)[min,max]=config.range;
  else{const baseline=min===0&&series.some(s=>['histogram','area'].includes(s.type)&&(s.baseline??0)===0),padding=max===min?(Math.abs(max)*.01||1)*config.padding:max*config.padding-min*config.padding;min=Math.max(-Number.MAX_VALUE,min-padding);max=Math.min(Number.MAX_VALUE,max+padding);if(baseline)min=0;}
  if(min===max){const delta=Math.abs(min)*1e-12||1;min=Math.max(-Number.MAX_VALUE,min-delta);max=Math.min(Number.MAX_VALUE,max+delta);}if(config.scale==='log'&&min<=0)throw new RangeError('Log scale requires a strictly positive visible range (adjust padding/range)');
  const base=config.base??(model.store.length?model.store.columns.close[0]:1);if(config.scale==='percent'&&base===0)throw new RangeError('Percent base cannot be zero');
  const transform=config.scale==='log'?Math.log:config.scale==='percent'?v=>(v/base-1)*100:v=>v,inverse=config.scale==='log'?Math.exp:config.scale==='percent'?v=>(v/100+1)*base:v=>v;
  const lo=transform(min),hi=transform(max);if(!Number.isFinite(lo)||!Number.isFinite(hi))throw new RangeError('Axis transform overflow');
  const delta=hi-lo,direct=Number.isFinite(delta)&&delta!==0,magnitude=Math.max(Math.abs(lo),Math.abs(hi))||1,scaledLo=lo/magnitude,scaledHi=hi/magnitude,span=scaledHi-scaledLo;
  if(!direct&&(!Number.isFinite(span)||span===0))throw new RangeError('Axis transform has no representable span');
  // TwoDiff retains the low part of hi-lo for inverse interpolation across
  // zero, without double-rounding subnormal weighted endpoint products.
  const virtualLo=direct?hi-delta:0,deltaError=direct?(hi-(delta+virtualLo))+(virtualLo-lo):0;
  // Subtract before scaling to retain narrow binary64 price differences. Very
  // wide domains and off-range values still need the overflow-safe fallback.
  const origin=config.inverted?lo:hi,extent=config.inverted?delta:-delta,scaledOrigin=config.inverted?scaledLo:scaledHi,scaledExtent=config.inverted?span:-span,pixels=bottom-top;
  const y=direct?value=>{const mapped=transform(value),difference=mapped-origin,fraction=Number.isFinite(difference)?difference/extent:(mapped/magnitude-scaledOrigin)/scaledExtent,coordinate=top+fraction*pixels;return coordinate>=-3.4028234663852886e38&&coordinate<=3.4028234663852886e38?coordinate:NaN;}:value=>{const coordinate=top+(transform(value)/magnitude-scaledOrigin)/scaledExtent*pixels;return coordinate>=-3.4028234663852886e38&&coordinate<=3.4028234663852886e38?coordinate:NaN;};
  if(Number.isFinite(sourceMin)&&(!Number.isFinite(Math.fround(y(sourceMin)))||!Number.isFinite(Math.fround(y(sourceMax)))))throw new RangeError('Axis projection overflow for visible values');
  const price=sy=>{const fraction=(sy-top)/(bottom-top),f=config.inverted?fraction:1-fraction;let value=direct?(f<=.5?lo+f*delta:hi-(1-f)*delta):NaN;if(direct&&deltaError!==0)value+=f<=.5?f*deltaError:-(1-f)*deltaError;if(!Number.isFinite(value))value=((1-f)*scaledLo+f*scaledHi)*magnitude;return inverse(value);};
  return {...config,left,right,top,bottom,min,max,base,y,price,transform,inverse,lo,hi};
}
export function createLayout(model,width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<80||width>RESOURCE_LIMITS.maxCanvasDimension||height>RESOURCE_LIMITS.maxCanvasDimension)throw new RangeError('Chart needs at least 100 × 80 CSS pixels');
  const configs=model.panels.map(p=>[{...p,axisId:null,side:p.axisSide??'right',visible:p.axisVisible!==false,width:model.axisWidth},...model.axes.filter(a=>a.panel===p.id).map(a=>({...a,axisId:a.id,width:a.width??model.axisWidth}))]);
  const [leftStrip,rightStrip]=axisStripWidths(model.panels,model.axes,model.axisWidth);
  const factor=Math.min(1,(width-32)/(leftStrip+rightStrip||1)),left=12+leftStrip*factor,right=Math.max(left+20,width-rightStrip*factor),maxWeight=Math.max(...model.panels.map(p=>p.weight)),total=model.panels.reduce((n,p)=>n+p.weight/maxWeight,0),a=Math.min(model.store.length,Math.max(0,Math.floor(model.view.from))),b=Math.max(a,Math.min(model.store.length,Math.ceil(model.view.to+1)));
  const footer=Math.min(height-24,Math.max(38,Math.ceil(labelMetrics(model.theme.font).height+20))),panelSpace=height-footer;let top=12;
  const panels=model.panels.map((p,i)=>{const row=panelSpace*(p.weight/maxWeight/total),gap=Math.min(8,row/2),bottom=top+row-gap,series=model.series.filter(s=>s.panel===p.id&&s.visible!==false);let lx=left,rx=right;
    const axes=configs[i].map(config=>{const q=axisRange(model,config,series.filter(s=>(s.axisId??null)===config.axisId),a,b,left,right,top,bottom);const w=config.visible?config.width*factor:0;q.axisLeft=config.side==='left'?lx-w:rx;q.axisRight=q.axisLeft+w;q.textX=config.side==='left'?q.axisLeft+4:q.axisLeft+8;if(config.side==='left')lx-=w;else rx+=w;return q;});
    const result={...axes[0],axes};top=bottom+gap;return result;});
  const axis=(panelId,axisId=null)=>panels.find(p=>p.id===panelId)?.axes.find(a=>a.axisId===(axisId??null));
  const drawingAxis=d=>{if(d.seriesId!==undefined&&d.seriesId!==null){const s=model.series.find(s=>s.id===d.seriesId);if(!s||s.visible===false||s.panel!==d.panel||(s.axisId??null)!==(d.axisId??null))return undefined;}return axis(d.panel,d.axisId);};
  const x=index=>left+(index-model.view.from)/(model.view.to-model.view.from)*(right-left),index=sx=>model.view.from+(sx-left)/(right-left)*(model.view.to-model.view.from);
  const geometryKey=JSON.stringify([width,height,model.view.from,model.view.to,model.store.geometryIdentity,model.store.timeVersion,...panels.flatMap(p=>p.axes.map(a=>[p.id,a.axisId,a.left,a.right,a.top,a.bottom,a.min,a.max,a.scale,a.inverted,a.base])),...model.series.map(s=>[s.id,s.panel,s.axisId,s.visible])]);
  return {geometryKey,geometryFont:model.theme.font,width,height,panels,axis,drawingAxis,x,index,from:a,to:b,toScreen:(point,panelId,axisId=null)=>{const p=axis(panelId,axisId);return p?{x:x(model.store.indexAtTime(point.time)),y:p.y(point.price)}:{x:NaN,y:NaN};},fromScreen:(sx,sy,panelId,axisId=null)=>{const p=axis(panelId,axisId);if(!p)throw new Error('Missing axis');return {time:model.store.timeAtIndex(index(sx)),price:p.price(sy)};}};
}
