// Pure model helpers for the demo's indicator placement controls. The demo
// derives accepted state from rendered series so a stale host-side record can
// never move or remove the wrong panel.

const PANEL_PROJECTION_KEYS=['scale','inverted','padding','range','base','precision'];
const AXIS_PROJECTION_KEYS=['side','scale','inverted','padding','range','base','precision','tickFormat','visible'];

const cloneRange=value=>Array.isArray(value)&&value.length===2?[value[0],value[1]]:undefined;

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
