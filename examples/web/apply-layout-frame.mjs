import {ChartAPI} from '../../src/core/api.mjs';
import {ChartModel} from '../../src/core/model.mjs';
import {AXIS_KEYS,PANEL_KEYS,RESOURCE_LIMITS,identifier} from '../../src/core/contracts.mjs';
import {restoreIndicatorBindings} from '../../src/core/internal-indicator-bindings.mjs';

const PANEL_FRAME_KEYS=PANEL_KEYS.filter(key=>key!=='id'&&key!=='formatter');
const AXIS_FRAME_KEYS=AXIS_KEYS.filter(key=>key!=='id'&&key!=='panel'&&key!=='formatter');
const FRAME_KEYS=['panelOrder','placements','generatedPanels','generatedAxes'];
const PANEL_OPTION_KEYS=new Set(PANEL_FRAME_KEYS);
const AXIS_OPTION_KEYS=new Set(AXIS_FRAME_KEYS);

function ownData(value,key,label,optional=false){
 const descriptor=value&&Object.getOwnPropertyDescriptor(value,key);
 if(!descriptor){if(optional)return undefined;throw new TypeError(label+' own data slot required');}
 if(!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');
 return descriptor.value;
}

function plainRecord(value,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+': plain object required');
 for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))throw new TypeError(label+': string own keys required');
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': own data fields required');
 }
 return value;
}

function denseArray(value,label,max){
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError(label+': dense array required');
 const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
 if(!Number.isSafeInteger(length)||length<0||length>max)throw new RangeError(label+': limit '+max);
 const keys=Reflect.ownKeys(value);
 if(keys.length!==length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^[0-9]+$/.test(key)||Number(key)>=length)))throw new TypeError(label+': dense array required');
 for(let index=0;index<length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
  if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': own data elements required');
 }
 return value;
}

function primitive(value,label){
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 throw new TypeError(label+': portable primitive required');
}

function cloneRange(value,label){
 if(value===null)return null;
 denseArray(value,label,2);
 if(value.length!==2)throw new TypeError(label+': two values required');
 return [primitive(ownData(value,0,label),label),primitive(ownData(value,1,label),label)];
}

function cloneOptions(value,kind,label){
 plainRecord(value,label);
 const allowed=kind==='panel'?PANEL_OPTION_KEYS:AXIS_OPTION_KEYS,result={};
 for(const key of Object.keys(value)){
  if(!allowed.has(key))throw new TypeError(label+': unsupported field '+key);
  const input=ownData(value,key,label);
  if(input===undefined)throw new TypeError(label+': undefined fields are not portable');
  result[key]=key==='range'?cloneRange(input,label+' range'):primitive(input,label+' '+key);
 }
 return result;
}

function clonePlacement(value,label){
 plainRecord(value,label);
 const keys=['seriesId','indicatorId','panelId','axisId'],own=Object.keys(value);
 if(own.length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||own.some(key=>!keys.includes(key)))throw new TypeError(label+': exact fields required');
 const seriesId=primitive(ownData(value,'seriesId',label),label+' seriesId');
 const indicatorId=primitive(ownData(value,'indicatorId',label),label+' indicatorId');
 const panelId=primitive(ownData(value,'panelId',label),label+' panelId');
 const axisInput=ownData(value,'axisId',label),axisId=axisInput===null?null:primitive(axisInput,label+' axisId');
 identifier(seriesId,label+' seriesId');identifier(indicatorId,label+' indicatorId');identifier(panelId,label+' panelId');if(axisId!==null)identifier(axisId,label+' axisId');
 return {seriesId,indicatorId,panelId,axisId};
}

function cloneGeneratedPanel(value,label){
 plainRecord(value,label);
 const keys=['id','options'],own=Object.keys(value);
 if(own.length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||own.some(key=>!keys.includes(key)))throw new TypeError(label+': exact fields required');
 const id=primitive(ownData(value,'id',label),label+' id');identifier(id,label+' id');
 return {id,options:cloneOptions(ownData(value,'options',label),'panel',label+' options')};
}

function cloneGeneratedAxis(value,label){
 plainRecord(value,label);
 const keys=['id','panel','options'],own=Object.keys(value);
 if(own.length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||own.some(key=>!keys.includes(key)))throw new TypeError(label+': exact fields required');
 const id=primitive(ownData(value,'id',label),label+' id');
 const panel=primitive(ownData(value,'panel',label),label+' panel');
 identifier(id,label+' id');identifier(panel,label+' panel');
 return {id,panel,options:cloneOptions(ownData(value,'options',label),'axis',label+' options')};
}

function cloneFrame(value){
 plainRecord(value,'Layout frame');
 const own=Object.keys(value);
 if(own.length!==FRAME_KEYS.length||FRAME_KEYS.some(key=>!Object.hasOwn(value,key))||own.some(key=>!FRAME_KEYS.includes(key)))throw new TypeError('Layout frame: exact fields required');
 const panelOrder=denseArray(ownData(value,'panelOrder','Layout frame'),'Layout frame panelOrder',RESOURCE_LIMITS.maxPanels).map((id,index)=>{const result=primitive(id,'Layout frame panelOrder '+index);identifier(result,'Layout frame panelOrder '+index);return result;});
 if(panelOrder.length===0)throw new TypeError('Layout frame: at least one panel required');
 if(new Set(panelOrder).size!==panelOrder.length)throw new TypeError('Layout frame: duplicate panel order id');
 const placements=denseArray(ownData(value,'placements','Layout frame'),'Layout frame placements',RESOURCE_LIMITS.maxSeries).map((entry,index)=>clonePlacement(entry,'Layout frame placement '+index));
 const placementIds=new Set();for(const entry of placements)if(!placementIds.add(entry.seriesId))throw new TypeError('Layout frame: duplicate placement series id');
 const generatedPanels=denseArray(ownData(value,'generatedPanels','Layout frame'),'Layout frame generatedPanels',RESOURCE_LIMITS.maxPanels).map((entry,index)=>cloneGeneratedPanel(entry,'Layout frame generatedPanel '+index));
 const generatedPanelIds=new Set();for(const entry of generatedPanels){if(!generatedPanelIds.add(entry.id))throw new TypeError('Layout frame: duplicate generated panel id');if(!panelOrder.includes(entry.id))throw new TypeError('Layout frame: generated panel is not in panel order');}
 const generatedAxes=denseArray(ownData(value,'generatedAxes','Layout frame'),'Layout frame generatedAxes',RESOURCE_LIMITS.maxAxes).map((entry,index)=>cloneGeneratedAxis(entry,'Layout frame generatedAxis '+index));
 const generatedAxisIds=new Set();for(const entry of generatedAxes){if(!generatedAxisIds.add(entry.id))throw new TypeError('Layout frame: duplicate generated axis id');if(!panelOrder.includes(entry.panel))throw new TypeError('Layout frame: generated axis panel is not in panel order');}
 for(const entry of placements)if(!panelOrder.includes(entry.panelId))throw new Error('Layout frame: placement panel is missing from panel order');
 return {panelOrder,placements,generatedPanels,generatedAxes};
}

function idSet(value,label){
 if(value===undefined)return new Set();
 if(!(value instanceof Set))throw new TypeError(label+' Set required');
 const result=new Set();for(const id of value){identifier(id,label+' id');result.add(id);}return result;
}

function stale(message){const error=new Error(message);error.name='StaleSourceError';return error;}

function readArray(model,key,label,max){
 const value=ownData(model,key,'ChartModel');return denseArray(value,label,max);
}

function resourceId(value,label){
 plainRecord(value,label);const id=primitive(ownData(value,'id',label,true),label+' id');identifier(id,label+' id');return id;
}

function readCurrentState(model){
 const panelValues=readArray(model,'panels','Chart panels',RESOURCE_LIMITS.maxPanels),axisValues=readArray(model,'axes','Chart axes',RESOURCE_LIMITS.maxAxes),seriesValues=readArray(model,'series','Chart series',RESOURCE_LIMITS.maxSeries);
 const panels=[],axes=[],series=[],panelIds=new Set(),axisIds=new Set(),seriesIds=new Set(),panelById=new Map(),axisById=new Map(),indicatorSeries=new Map();
 for(const [index,panel] of panelValues.entries()){
  const id=resourceId(panel,'Chart panel '+index);if(!panelIds.add(id))throw new TypeError('Duplicate panel id');
  panels.push({ref:panel,id});panelById.set(id,panel);
 }
 for(const [index,axis] of axisValues.entries()){
  const id=resourceId(axis,'Chart axis '+index),panel=primitive(ownData(axis,'panel','Chart axis '+index,true),'Chart axis panel');identifier(panel,'Chart axis panel');
  if(!panelIds.has(panel))throw new Error('Chart axis panel is missing');if(!axisIds.add(id))throw new TypeError('Duplicate axis id');
  const record={ref:axis,id,panel};axes.push(record);axisById.set(id,record);
 }
 for(const [index,entry] of seriesValues.entries()){
  const id=resourceId(entry,'Chart series '+index);if(!seriesIds.add(id))throw new TypeError('Duplicate series id');
  const indicator=ownData(entry,'indicator','Chart series '+index,true),panel=ownData(entry,'panel','Chart series '+index,true),axisInput=ownData(entry,'axisId','Chart series '+index,true);
  if(panel!==undefined){identifier(panel,'Chart series panel');if(!panelIds.has(panel))throw new Error('Chart series panel is missing');}
  const axisId=axisInput===undefined||axisInput===null?null:primitive(axisInput,'Chart series axis');if(axisId!==null){identifier(axisId,'Chart series axis');const axis=axisById.get(axisId);if(!axis||axis.panel!==panel)throw new Error('Chart series axis is missing');}
  let indicatorId=null;if(indicator!==undefined&&indicator!==null){indicatorId=primitive(indicator,'Chart series indicator');identifier(indicatorId,'Chart series indicator');indicatorSeries.set(id,{id,indicatorId,panel,axisId});}
  series.push({ref:entry,id,indicatorId,panel,axisId});
 }
 const indicators=ownData(ownData(model,'indicators','ChartModel'),'entries','Indicator engine');if(!(indicators instanceof Map))throw new TypeError('Indicator entries Map required');
 for(const record of indicatorSeries.values())if(!indicators.has(record.indicatorId))throw new Error('Missing indicator: '+record.indicatorId);
 return {panels,axes,series,panelIds,axisIds,seriesIds,panelById,axisById,indicatorSeries,indicators};
}

function ensureIdle(model,controller){
 const drawings=ownData(model,'drawings','ChartModel'),transaction=ownData(drawings,'transaction','Drawing store',true);
 if(transaction)throw new Error('Panel layout change during drawing transaction');
 if(!controller)return;
 const gesture=ownData(controller,'gesture','Interaction controller',true),pointers=ownData(controller,'pointers','Interaction controller',true);
 if(gesture||!(pointers instanceof Map)||pointers.size)throw new Error('Panel layout change during active gesture');
}

function assertStable(api,model,controller,assertOwner){
 assertOwner();
 if(ownData(api,'model','Chart API')!==model||ownData(api,'controller','Chart API',true)!==controller||ownData(model,'disposed','Chart',true)===true)throw stale('Layout owner changed');
 if(controller&&ownData(controller,'model','Interaction controller',true)!==model)throw stale('Layout controller owner changed');
 ensureIdle(model,controller);
}

function preflightControllerTarget(model,controller,targetsBySeries){
 if(!controller)return;
 const targetSlot=Object.getOwnPropertyDescriptor(controller,'drawingTarget');if(!targetSlot||!Object.hasOwn(targetSlot,'value'))throw new TypeError('Interaction controller drawing target must be own data');
 const target=targetSlot.value;if(target===null||target===undefined)return;
 plainRecord(target,'Drawing target');const seriesId=ownData(target,'seriesId','Drawing target',true);if(seriesId===undefined||seriesId===null)return;
 const next=targetsBySeries.get(seriesId);if(!next)return;
 if((ownData(target,'panel','Drawing target',true)!==next.panel)||(ownData(target,'axisId','Drawing target',true)??null)!==next.axisId){
  if(targetSlot.writable!==true)throw new TypeError('Interaction controller drawing target must be writable own data');
  for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(target)))if(!Object.hasOwn(descriptor,'value'))throw new TypeError('Drawing target own data fields required');
 }
}

function validatePanelTemplate(model,id,options){
 const candidate={weight:1,scale:'linear',inverted:false,padding:.08,id,...options};model.validatePanel(candidate);
}

function validateAxisTemplate(model,id,panel,options){
 const projection={weight:1,scale:'linear',inverted:false,padding:.08};for(const key of ['scale','inverted','padding','range','base','precision'])if(Object.hasOwn(options,key))projection[key]=options[key];
 model.validatePanel(projection);
 const side=options.side??'right',visible=options.visible??true,tickFormat=options.tickFormat??'fixed',width=options.width;
 if(!['left','right'].includes(side)||typeof visible!=='boolean'||!['fixed','scientific'].includes(tickFormat)||width!==undefined&&(!Number.isFinite(width)||width<20||width>256))throw new TypeError('Axis side/visibility/format/width');
 for(const key of ['prefix','suffix'])if(options[key]!==undefined&&(typeof options[key]!=='string'||options[key].length>64))throw new TypeError('Axis '+key);
 if(options.label!==undefined&&(typeof options.label!=='string'||options.label.length===0||options.label.length>256))throw new TypeError('Axis label');
 if(options.scale==='percent'&&(!Number.isFinite(options.base)||options.base===0))throw new RangeError('Independent percent axis requires an explicit nonzero base');
 void model;void id;void panel;
}

function sameValue(a,b){
 if(Object.is(a,b))return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>sameValue(value,b[index]));
 return false;
}

function structuralState(model){
 const panelState=readArray(model,'panels','Chart panels',RESOURCE_LIMITS.maxPanels).map((panel,index)=>[ownData(panel,'id','Chart panel '+index),...PANEL_FRAME_KEYS.map(key=>{const value=ownData(panel,key,'Chart panel '+index,true);return key==='range'&&Array.isArray(value)?cloneRange(value,'Chart panel '+index+' range'):value;})]);
 const axisState=readArray(model,'axes','Chart axes',RESOURCE_LIMITS.maxAxes).map((axis,index)=>[ownData(axis,'id','Chart axis '+index),ownData(axis,'panel','Chart axis '+index),...AXIS_FRAME_KEYS.map(key=>{const value=ownData(axis,key,'Chart axis '+index,true);return key==='range'&&Array.isArray(value)?cloneRange(value,'Chart axis '+index+' range'):value;})]);
 const seriesState=readArray(model,'series','Chart series',RESOURCE_LIMITS.maxSeries).map(series=>[ownData(series,'id','Series'),ownData(series,'indicator','Series',true)??null,ownData(series,'panel','Series',true),ownData(series,'axisId','Series',true)??null]);
 return {panelState,axisState,seriesState};
}

function sameState(a,b){
 return sameValue(a.panelState,b.panelState)&&sameValue(a.axisState,b.axisState)&&sameValue(a.seriesState,b.seriesState);
}

function mergePanelOrder(currentIds,targetIds){
 const targetSet=new Set(targetIds),extras=currentIds.filter(id=>!targetSet.has(id)),targetSlots=currentIds.length-extras.length;
 if(targetSlots<targetIds.length)throw stale('Target panel was removed during layout cleanup');
 let targetIndex=0;return currentIds.map(id=>targetSet.has(id)?targetIds[targetIndex++]:id);
}

function validateIndicatorMembership(state,placements){
 for(const placement of placements){const current=state.indicatorSeries.get(placement.seriesId);if(!current||current.indicatorId!==placement.indicatorId)throw stale('Indicator series membership changed');}
 if(state.indicatorSeries.size!==placements.length)throw stale('Indicator series membership changed');
 for(const [seriesId,current] of state.indicatorSeries)if(!placements.some(placement=>placement.seriesId===seriesId&&placement.indicatorId===current.indicatorId))throw stale('Indicator series membership changed');
}

function verifyExactPlacements(model,placements){
 const state=readCurrentState(model),seriesById=new Map(state.series.map(record=>[record.id,record]));
 validateIndicatorMembership(state,placements);
 for(const placement of placements){
  const current=seriesById.get(placement.seriesId);
  if(!current||current.indicatorId!==placement.indicatorId||current.panel!==placement.panelId||current.axisId!==placement.axisId)throw stale('Indicator series placement changed during layout');
 }
 return state;
}

function verifyPanelOrder(model,expected){
 const current=readArray(model,'panels','Chart panels',RESOURCE_LIMITS.maxPanels).map(panel=>resourceId(panel,'Chart panel'));
 if(current.length!==expected.length||current.some((id,index)=>id!==expected[index]))throw stale('Panel order changed during layout');
}

function verifyProtectedTargets(model,frameValue,targetAxisParents,{allowUncreatedGenerated=false,existingPanelIds=new Set(),existingAxisIds=new Set(),generatedPanelById=new Map(),generatedAxisById=new Map()}={}){
 const state=readCurrentState(model);
 for(const id of frameValue.panelOrder)if(!state.panelIds.has(id)&&!(allowUncreatedGenerated&&generatedPanelById.has(id)&&!existingPanelIds.has(id)))throw stale('Target panel was removed during layout cleanup');
 for(const [id,parent] of targetAxisParents){const axis=state.axisById.get(id);if((!axis||axis.panel!==parent)&&!(allowUncreatedGenerated&&generatedAxisById.has(id)&&!existingAxisIds.has(id)))throw stale('Target axis was removed or rebound during layout cleanup');}
 return state;
}

function rollbackCreated({api,model,controller,assertOwner,createdPanels,createdAxes,generatedPanelIds,generatedAxisIds,addedPanelOwnership,addedAxisOwnership}){
 const stillCurrent=()=>{try{assertStable(api,model,controller,assertOwner);return true;}catch{return false;}};
 for(const record of [...createdAxes].reverse()){
  if(!stillCurrent())return;
  const id=record.id,current=model.axes.find(axis=>ownData(axis,'id','Axis')===id),currentArray=ownData(model,'axes','ChartModel');
  if(!current){if(addedAxisOwnership.has(id))generatedAxisIds.delete(id);continue;}
  if(!record.ref||current!==record.ref){if(addedAxisOwnership.has(id)&&currentArray!==record.ownerArray)generatedAxisIds.delete(id);continue;}
  if(model.series.some(series=>(ownData(series,'axisId','Series',true)??null)===id))continue;
  try{api.removeAxis(id);assertStable(api,model,controller,assertOwner);if(addedAxisOwnership.has(id))generatedAxisIds.delete(id);}catch{return;}
 }
 for(const record of [...createdPanels].reverse()){
  if(!stillCurrent())return;
  const id=record.id,current=model.panels.find(panel=>ownData(panel,'id','Panel')===id),currentArray=ownData(model,'panels','ChartModel');
  if(!current){if(addedPanelOwnership.has(id))generatedPanelIds.delete(id);continue;}
  if(!record.ref||current!==record.ref){if(addedPanelOwnership.has(id)&&currentArray!==record.ownerArray)generatedPanelIds.delete(id);continue;}
  if(model.series.some(series=>ownData(series,'panel','Series',true)===id)||(model.axes??[]).some(axis=>ownData(axis,'panel','Axis')===id))continue;
  try{api.removePanel(id);assertStable(api,model,controller,assertOwner);if(addedPanelOwnership.has(id))generatedPanelIds.delete(id);}catch{return;}
 }
}

export function applyLayoutFrame({api,frame,generatedPanelIds,generatedAxisIds,assertOwner=()=>{},cleanup=()=>{},domains}={}){
 if(!(api instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');
 const model=ownData(api,'model','Chart API');if(!(model instanceof ChartModel))throw new TypeError('Actual ChartModel required');
 const controller=ownData(api,'controller','Chart API',true)??null;if(controller&&ownData(controller,'model','Interaction controller',true)!==model)throw new Error('Chart API controller belongs to a different ChartModel');
 if(typeof assertOwner!=='function')throw new TypeError('assertOwner function required');
 if(typeof cleanup!=='function')throw new TypeError('cleanup function required');
 const generatedPanels=idSet(generatedPanelIds,'Generated panel'),generatedAxes=idSet(generatedAxisIds,'Generated axis');
 // Keep the caller's live sets. The copies above are only an untrusted-input
 // preflight; successful creation below unions ids into the original sets.
 if(generatedPanelIds!==undefined&&!(generatedPanelIds instanceof Set))throw new TypeError('Generated panel Set required');
 if(generatedAxisIds!==undefined&&!(generatedAxisIds instanceof Set))throw new TypeError('Generated axis Set required');
 const frameValue=cloneFrame(frame),generatedPanelById=new Map(frameValue.generatedPanels.map(entry=>[entry.id,entry])),generatedAxisById=new Map(frameValue.generatedAxes.map(entry=>[entry.id,entry])),targetPanels=new Set(frameValue.panelOrder),targetAxes=new Set(frameValue.generatedAxes.map(entry=>entry.id)),targetAxisParents=new Map(frameValue.generatedAxes.map(entry=>[entry.id,entry.panel]));
 let state=readCurrentState(model),panelsById=new Map(state.panels.map(record=>[record.id,record])),axesById=new Map(state.axes.map(record=>[record.id,record]));
 validateIndicatorMembership(state,frameValue.placements);
 for(const placement of frameValue.placements){
  if(placement.axisId===null)continue;
  targetAxes.add(placement.axisId);const previous=targetAxisParents.get(placement.axisId);if(previous!==undefined&&previous!==placement.panelId)throw stale('Target axis parent changed');targetAxisParents.set(placement.axisId,placement.panelId);
 }
 for(const entry of frameValue.generatedPanels)if(panelsById.has(entry.id))continue;
 else if(!targetPanels.has(entry.id))throw stale('Generated panel is not a target panel');
 for(const id of frameValue.panelOrder)if(!panelsById.has(id)&&!generatedPanelById.has(id))throw stale('Missing target panel: '+id);
 for(const entry of frameValue.generatedAxes){if(axesById.has(entry.id)&&axesById.get(entry.id).panel!==entry.panel)throw stale('Generated axis parent changed');if(!targetPanels.has(entry.panel))throw stale('Generated axis parent panel is missing');}
 for(const [axisId,parent] of targetAxisParents){const axis=axesById.get(axisId),template=generatedAxisById.get(axisId),actual=axis?.panel??template?.panel;if(!actual||actual!==parent)throw stale('Target axis parent changed');}
 for(const entry of frameValue.generatedPanels)validatePanelTemplate(model,entry.id,entry.options);
 for(const entry of frameValue.generatedAxes)validateAxisTemplate(model,entry.id,entry.panel,entry.options);
 const targetBySeries=new Map(frameValue.placements.map(placement=>[placement.seriesId,{panel:placement.panelId,axisId:placement.axisId}]));preflightControllerTarget(model,controller,targetBySeries);
 assertStable(api,model,controller,assertOwner);
 const before=structuralState(model),protectedTargets=()=>({panels:new Set(frameValue.panelOrder),axes:new Set(targetAxes)}),createdPanels=[],createdAxes=[],addedPanelOwnership=new Set(),addedAxisOwnership=new Set();
 let panelUnion=new Set([...state.panelIds,...targetPanels]),axisUnion=new Set([...state.axisIds,...targetAxes]);
 if(panelUnion.size>RESOURCE_LIMITS.maxPanels||axisUnion.size>RESOURCE_LIMITS.maxAxes){
  cleanup(domains,protectedTargets());assertStable(api,model,controller,assertOwner);
  state=verifyProtectedTargets(model,frameValue,targetAxisParents,{allowUncreatedGenerated:true,existingPanelIds:new Set(state.panelIds),existingAxisIds:new Set(state.axisIds),generatedPanelById,generatedAxisById});validateIndicatorMembership(state,frameValue.placements);
  panelsById=new Map(state.panels.map(record=>[record.id,record]));axesById=new Map(state.axes.map(record=>[record.id,record]));
  panelUnion=new Set([...state.panelIds,...targetPanels]);axisUnion=new Set([...state.axisIds,...targetAxes]);
  if(panelUnion.size>RESOURCE_LIMITS.maxPanels)throw new RangeError('Panel limit');if(axisUnion.size>RESOURCE_LIMITS.maxAxes)throw new RangeError('Axis limit');
 }
 try{
  for(const entry of frameValue.generatedPanels){
   if(panelsById.has(entry.id))continue;
   const record={id:entry.id,ref:null,ownerArray:ownData(model,'panels','ChartModel')};createdPanels.push(record);if(generatedPanelIds!==undefined&&!generatedPanelIds.has(entry.id)){generatedPanelIds.add(entry.id);addedPanelOwnership.add(entry.id);}
   api.addPanel({id:entry.id,...entry.options});assertStable(api,model,controller,assertOwner);if(ownData(model,'panels','ChartModel')!==record.ownerArray)throw stale('Created panel owner changed during notification');record.ref=readArray(model,'panels','Chart panels',RESOURCE_LIMITS.maxPanels).find(panel=>resourceId(panel,'Chart panel')===entry.id);if(!record.ref)throw stale('Created panel was removed during notification');
  }
  for(const entry of frameValue.generatedAxes){
   if(axesById.has(entry.id))continue;
   const record={id:entry.id,ref:null,ownerArray:ownData(model,'axes','ChartModel')};createdAxes.push(record);if(generatedAxisIds!==undefined&&!generatedAxisIds.has(entry.id)){generatedAxisIds.add(entry.id);addedAxisOwnership.add(entry.id);}
   api.addAxis({id:entry.id,panel:entry.panel,...entry.options});assertStable(api,model,controller,assertOwner);if(ownData(model,'axes','ChartModel')!==record.ownerArray)throw stale('Created axis owner changed during notification');record.ref=readArray(model,'axes','Chart axes',RESOURCE_LIMITS.maxAxes).find(axis=>resourceId(axis,'Chart axis')===entry.id);if(!record.ref||ownData(record.ref,'panel','Axis')!==entry.panel)throw stale('Created axis was removed or rebound during notification');
  }
  const groups=new Map();for(const placement of frameValue.placements){const group=groups.get(placement.indicatorId)??[];group.push({seriesId:placement.seriesId,panel:placement.panelId,axisId:placement.axisId});groups.set(placement.indicatorId,group);}
  for(const [indicatorId,bindings] of groups){
   const changed=bindings.some(binding=>{const current=state.indicatorSeries.get(binding.seriesId);return current.panel!==binding.panel||current.axisId!==binding.axisId;});
   if(!changed)continue;
   assertStable(api,model,controller,assertOwner);restoreIndicatorBindings(api,indicatorId,bindings);assertStable(api,model,controller,assertOwner);
  }
  cleanup(domains,protectedTargets());assertStable(api,model,controller,assertOwner);state=verifyProtectedTargets(model,frameValue,targetAxisParents);validateIndicatorMembership(state,frameValue.placements);
  const currentPanels=readArray(model,'panels','Chart panels',RESOURCE_LIMITS.maxPanels),currentIds=currentPanels.map(panel=>resourceId(panel,'Chart panel'));
  const order=mergePanelOrder(currentIds,frameValue.panelOrder);if(order.some((id,index)=>id!==currentIds[index])){api.setPanelOrder(order);assertStable(api,model,controller,assertOwner);}
  assertStable(api,model,controller,assertOwner);verifyProtectedTargets(model,frameValue,targetAxisParents);verifyPanelOrder(model,order);verifyExactPlacements(model,frameValue.placements);
  return {changed:!sameState(before,structuralState(model))};
 }catch(error){
  rollbackCreated({api,model,controller,assertOwner,createdPanels,createdAxes,generatedPanelIds:generatedPanelIds??new Set(),generatedAxisIds:generatedAxisIds??new Set(),addedPanelOwnership,addedAxisOwnership});
  throw error;
 }
}
