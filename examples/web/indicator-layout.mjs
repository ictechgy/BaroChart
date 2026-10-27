// Pure model helpers for the demo's indicator placement controls. The demo
// derives accepted state from rendered series so a stale host-side record can
// never move or remove the wrong panel.

const PANEL_PROJECTION_KEYS=['scale','inverted','padding','range','base','precision'];
const AXIS_PROJECTION_KEYS=['side','scale','inverted','padding','range','base','precision','tickFormat','visible'];

const cloneRange=value=>Array.isArray(value)&&value.length===2?[value[0],value[1]]:undefined;
const validRange=value=>{const range=cloneRange(value);return range&&range.every(Number.isFinite)&&range[0]<range[1]?range:undefined;};
const sameRange=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===2&&b.length===2&&Object.is(a[0],b[0])&&Object.is(a[1],b[1]);
const resourceFor=(model,kind,id)=>kind==='panel'?model?.panels?.find(panel=>panel.id===id):model?.axes?.find(axis=>axis.id===id);
const rangeAPI=(api,kind,id,range)=>kind==='panel'?api.setPanel(id,{range}):api.setAxis(id,{range});

function sceneAxis(scene,panelId,axisId=null){return scene?.layout?.axis?.(panelId,axisId)??null;}

export function captureLayoutDomains(model,scene){
 const result={panels:new Map(),axes:new Map()};
 for(const panel of model?.panels??[]){const axis=sceneAxis(scene,panel.id,null),range=validRange(axis&&[axis.min,axis.max]);if(range)result.panels.set(panel.id,range);}
 for(const axis of model?.axes??[]){const projection=sceneAxis(scene,axis.panel,axis.id),range=validRange(projection&&[projection.min,projection.max]);if(range)result.axes.set(axis.id,range);}
 return result;
}

export function pinSyntheticRange({model,api,pins,kind,id,range,assertOwner=()=>{}}){
 if(!(pins instanceof Map)||!['panel','axis'].includes(kind))throw new TypeError('Synthetic range pin store');
 const resource=resourceFor(model,kind,id),next=validRange(range);
 if(!resource||!next){pins.delete(id);return false;}
 const existing=pins.get(id);
 if(Array.isArray(resource.range)){
  if(existing?.model===model&&existing.rangeRef===resource.range&&sameRange(existing.range,resource.range))return false;
  pins.delete(id);return false;
 }
 // The API publishes this exact range before notifying the host. A reentrant
 // worker reload must see its ownership while taking the model snapshot.
 const entry={model,range:next,rangeRef:next};pins.set(id,entry);
 try{rangeAPI(api,kind,id,next);assertOwner();return true;}
 catch(error){if(pins.get(id)===entry&&resourceFor(model,kind,id)?.range!==next)pins.delete(id);throw error;}
}

export function clearSyntheticRange({model,api,pins,kind,id,assertOwner=()=>{}}){
 if(!(pins instanceof Map)||!['panel','axis'].includes(kind))throw new TypeError('Synthetic range pin store');
 const entry=pins.get(id),resource=resourceFor(model,kind,id);
 if(!entry)return false;
 if(!resource||entry.model!==model||resource.range!==entry.rangeRef||!sameRange(entry.range,resource.range)){pins.delete(id);return false;}
 const originalModel=entry.model,originalRangeRef=entry.rangeRef;
 try{rangeAPI(api,kind,id,null);assertOwner();return true;}
 finally{if(pins.get(id)===entry&&entry.model===originalModel&&entry.rangeRef===originalRangeRef&&resourceFor(model,kind,id)?.range!==originalRangeRef)pins.delete(id);}
}

export function rebindSyntheticRangePins(model,panelPins=new Map(),axisPins=new Map()){
 let changed=false;
 for(const [kind,pins] of [['panel',panelPins],['axis',axisPins]])for(const [id,entry] of [...pins]){
  const resource=resourceFor(model,kind,id);
  if(!resource||!Array.isArray(resource.range)||!sameRange(entry.range,resource.range)){pins.delete(id);changed=true;continue;}
  entry.model=model;entry.rangeRef=resource.range;
 }
 return changed;
}

export function pruneSyntheticRangePins(model,panelPins=new Map(),axisPins=new Map()){
 let changed=false;
 for(const [kind,pins] of [['panel',panelPins],['axis',axisPins]])for(const [id,entry] of [...pins]){
  const resource=resourceFor(model,kind,id);
  if(entry.model!==model||!resource||resource.range!==entry.rangeRef||!sameRange(entry.range,resource.range)){pins.delete(id);changed=true;}
 }
 return changed;
}

export function collectIndicatorGroups(model){
 const groups=new Map();
 for(const series of model?.series??[]){
  const id=series?.indicator;
  if(!id)continue;
  let group=groups.get(id);
  if(!group){
   const entry=model.indicators?.entries?.get?.(id);
   group={id,name:entry?.name??id,series:[],panelIds:[],axisIds:[]};groups.set(id,group);
  }
  group.series.push(series);
  if(!group.panelIds.includes(series.panel))group.panelIds.push(series.panel);
  const axisId=series.axisId??null;
  if(!group.axisIds.some(value=>Object.is(value,axisId)))group.axisIds.push(axisId);
 }
 return [...groups.values()].map(group=>({
  ...group,
  panelId:group.panelIds.length===1?group.panelIds[0]:null,
  axisId:group.axisIds.length===1?group.axisIds[0]:null,
  mixedPanelOrigins:group.panelIds.length!==1,
  mixedAxisOrigins:group.axisIds.length!==1
 }));
}

export function indicatorGroup(model,id){return collectIndicatorGroups(model).find(group=>group.id===id)??null;}

function projectionSource(model,group){
 if(!group||group.mixedPanelOrigins||group.mixedAxisOrigins||!group.panelId)return null;
 const panel=model.panels?.find(panel=>panel.id===group.panelId);
 if(!panel)return null;
 const axisId=group.axisId??null;
 const axis=axisId===null?null:model.axes?.find(candidate=>candidate.id===axisId&&candidate.panel===group.panelId);
 if(axisId!==null&&!axis)return null;
 return {panel,axis};
}

export function copyPanelProjection(model,group){
 const source=projectionSource(model,group);
 if(!source)return {weight:1,scale:'linear',inverted:false,padding:.08};
 const origin=source.axis??source.panel,result={weight:1};
 for(const key of PANEL_PROJECTION_KEYS){
  const value=origin[key];
  if(value!==undefined)result[key]=key==='range'?cloneRange(value):value;
 }
 return result;
}

export function copyAxisProjection(model,group){
 const source=projectionSource(model,group),panel=source?.panel;
 if(!source||!panel)return {side:'right',scale:'linear',inverted:false,padding:.08,tickFormat:'fixed',visible:true};
 const origin=source.axis??panel,result={};
 for(const key of AXIS_PROJECTION_KEYS){
  const value=origin[key];
  if(value!==undefined)result[key]=key==='range'?cloneRange(value):value;
 }
 if(result.side===undefined)result.side=panel.axisSide??'right';
 if(result.scale===undefined)result.scale='linear';
 if(result.scale==='percent'&&result.base===undefined&&source.axis===null){
  const resolved=model.store?.length?model.store.columns?.close?.[0]:1;
  if(Number.isFinite(resolved)&&resolved!==0)result.base=resolved;
 }
 if(result.inverted===undefined)result.inverted=false;
 if(result.padding===undefined)result.padding=.08;
 if(result.tickFormat===undefined)result.tickFormat='fixed';
 if(result.visible===undefined)result.visible=true;
 return result;
}

export function uniqueLayoutId(seed,taken){
 const base=String(seed||'layout').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')||'layout';
 let id=base,index=2;
 while(taken?.has(id)){id=`${base}-${index++}`;}
 return id;
}

export function groupPanelIds(model,group){return new Set(group?.series?.map(series=>series.panel).filter(Boolean)??[]);}
export function groupAxisIds(model,group){return new Set(group?.series?.map(series=>series.axisId??null)??[]);}
