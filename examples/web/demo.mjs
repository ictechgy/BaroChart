import {drawingImportMessage} from './import-errors.mjs';
import {createDrawingFileImport} from './drawing-file-import.mjs';
import {createChart,DARK_THEME,LIGHT_THEME,builtinIndicators,DEMO_SYMBOLS,formatPrice,zonedParts,demoCalendar} from '../../src/index.mjs';
import {prepareChartModel} from '../../src/web/worker.mjs';
import {modelRequest} from '../../src/web/worker-state.mjs';
import {collectIndicatorGroups,indicatorGroup,copyPanelProjection,copyAxisProjection,uniqueLayoutId} from './indicator-layout.mjs';
const $=id=>document.getElementById(id);let chart,model,timer,extras=[],serial=0,job=0,controller,loadedMarket,loadedCount,streamIntent=false,light=false,preparing=false;
const generatedPanelIds=new Set(),generatedAxisIds=new Set();let layoutAxisExplicit=false,layoutDraft=null,layoutMutationOwner=null;
const journals=new Map();
let pageActive=true,pageClosed=false,resumeInitial=false;
const dataExplorer=()=>({readout:$('explorer-readout'),live:$('explorer-live'),controls:[$('explore'),$('explore-read')]});
const status=message=>{if($('status').textContent!==message)$('status').textContent=message;};
const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
const layoutStatus=message=>{const node=$('indicator-layout-status');if(node&&node.textContent!==message)node.textContent=message;};
function replaceOptions(select,choices,selected=''){
 if(!select)return '';
 const signature=choices.map(choice=>choice.value+'\u0000'+choice.label).join('\u0001');
 if(select.dataset.layoutOptions!==signature){
  const options=choices.map(choice=>{const option=document.createElement('option');option.value=choice.value;option.textContent=choice.label;return option;});
  select.replaceChildren(...options);select.dataset.layoutOptions=signature;
 }
 const accepted=choices.some(choice=>choice.value===selected)?selected:(choices[0]?.value??'');
 if(select.value!==accepted)select.value=accepted;
 return accepted;
}
function layoutAxisChoices(panelId){
 const choices=[{value:'primary',label:'기본 축'},{value:'independent',label:'새 독립 축'}];
 for(const axis of model?.axes??[])if(axis.panel===panelId)choices.push({value:'axis:'+axis.id,label:'독립 축 · '+(axis.label??axis.id)});
 return choices;
}
function layoutBinding(group){return group?.series?.map(series=>[series.id,series.panel,series.axisId??null]).map(values=>values.join('\u0000')).join('\u0001')??'';}
function acceptedLayoutDraft(group){
 const panel=group?.panelId??model?.panels?.[0]?.id??'';
 const axis=group?.mixedAxisOrigins?'independent':group?.axisId===null?'primary':group?.axisId===undefined?'independent':'axis:'+group.axisId;
 return {model,chart,indicatorId:group?.id??null,binding:layoutBinding(group),panel,axis,dirty:false};
}
function setLayoutDraft(group,panel,axis,dirty=true){layoutDraft={model,chart,indicatorId:group?.id??null,binding:layoutBinding(group),panel,axis,dirty};}
function draftIsUsable(group){
 if(!layoutDraft||!group||layoutDraft.model!==model||layoutDraft.chart!==chart||layoutDraft.indicatorId!==group.id||layoutDraft.binding!==layoutBinding(group))return false;
 if(!model.panels.some(panel=>panel.id===layoutDraft.panel))return false;
 return layoutAxisChoices(layoutDraft.panel).some(choice=>choice.value===layoutDraft.axis);
}
function refreshLayoutAxisChoices(selected){
 const panel=$('layout-panel')?.value,choices=layoutAxisChoices(panel),axis=replaceOptions($('layout-axis'),choices,selected);
 if($('layout-axis'))$('layout-axis').disabled=preparing||!model||!chart||chart.disposed||!indicatorGroup(model,$('layout-indicator')?.value);
 return axis;
}
function syncIndicatorLayoutControls(){
 const indicator=$('layout-indicator'),panel=$('layout-panel'),axis=$('layout-axis'),order=$('reorder-panel');
 if(!indicator||!panel||!axis||!order)return;
 const groups=collectIndicatorGroups(model),groupValue=groups.some(group=>group.id===indicator.value)?indicator.value:(groups[0]?.id??'');
 if(!groups.length)layoutStatus('현재 표시된 보조지표가 없습니다.');
 replaceOptions(indicator,groups.map(group=>({value:group.id,label:(group.name??group.id).toUpperCase()+' · '+group.id})),groupValue);
 const group=groups.find(candidate=>candidate.id===indicator.value)??groups[0],panels=model?.panels??[];
 if(!draftIsUsable(group)){layoutDraft=group?acceptedLayoutDraft(group):null;layoutAxisExplicit=false;}
 const draft=group&&layoutDraft?.indicatorId===group.id?layoutDraft:null;
 const acceptedPanel=replaceOptions(panel,panels.map(candidate=>({value:candidate.id,label:candidate.label??candidate.id})),draft?.panel??group?.panelId??panels[0]?.id??'');
 refreshLayoutAxisChoices(draft?.panel===acceptedPanel?draft.axis:'');
 if(group&&(group.mixedPanelOrigins||group.mixedAxisOrigins))layoutStatus('이 지표의 출력선이 여러 원본 패널/축에 걸려 있어 새 배치에서는 선형 자동 범위를 사용합니다.');
 const orderValue=replaceOptions(order,panels.map(candidate=>({value:candidate.id,label:candidate.label??candidate.id})),order.value||panels[0]?.id||'');
 const index=panels.findIndex(candidate=>candidate.id===orderValue),ready=!!model&&!model.disposed&&!!chart&&!chart.disposed&&!preparing;
 for(const node of [indicator,panel,axis,order,$('apply-indicator-placement'),$('separate-indicator-panel'),$('panel-up'),$('panel-down')])if(node)node.disabled=!ready||(!group&&node!==order&&node!==$('separate-indicator-panel'));
 if($('separate-indicator-panel'))$('separate-indicator-panel').disabled=!ready||!group;
 if($('apply-indicator-placement'))$('apply-indicator-placement').disabled=!ready||!group;
 if($('panel-up'))$('panel-up').disabled=!ready||index<=0;
 if($('panel-down'))$('panel-down').disabled=!ready||index<0||index>=panels.length-1;
}
function friendly(error,file=false){if(file)return drawingImportMessage(error);if(/positive|Log scale/.test(error.message))return '로그 축은 양수 범위만 표시할 수 있습니다. 선형 축 또는 양수 범위를 사용하세요.';if(error.name==='AbortError')return model&&!model.disposed?'계산을 취소했습니다. 이전 차트는 유지됩니다.':'첫 차트 계산을 취소했습니다. 시장이나 저장 봉 수를 선택해 다시 시작하세요.';return '변경을 적용하지 못했습니다: '+String(error.message).slice(0,180);}
const drawingFileImport=createDrawingFileImport({getChart:()=>preparing?null:chart,onStatus:status,onError:(error,{changed})=>status(changed?'도형은 반영됐지만 화면 갱신 중 오류가 발생했습니다. 다시 불러오기 전에 현재 상태를 확인하세요.':friendly(error,true))});
function stopStream(){clearInterval(timer);timer=null;$('stream').setAttribute('aria-pressed','false');$('stream').textContent='▶ 합성 스트림';}
function sync(){if(!model||!chart||chart.disposed)return;$('explore').setAttribute('aria-pressed',String(chart.dataExploration?.active??false));const d=model.drawings.items.find(d=>d.id===model.drawings.selected);$('undo').disabled=!model.drawings.undoStack.length&&!chart.controller.gesture;$('redo').disabled=!model.drawings.redoStack.length;$('delete').disabled=!d||d.locked;$('lock').disabled=!d;$('lock').textContent=d?.locked?'잠금 해제':'잠금';
 setText('selection',d?'선택: '+d.type+' · '+(d.locked?'잠김':'편집 가능'):'선택된 도형 없음');chart.canvas.style.cursor=chart.controller.tool==='select'?(chart.controller.gesture?.kind==='pan'?'grabbing':'grab'):chart.controller.tool==='text'?'text':'crosshair';
 const b=model.store.length?model.store.at(model.store.length-1):null;setText('last-time',b?model.timeFormatter(b.time):'데이터 없음');for(const k of ['open','high','low','close'])setText('last-'+k,b?formatPrice(b[k],model.symbol):'—');setText('last-volume',b?(Object.is(b.volume,-0)?'-0':String(b.volume)):'—');
 if(typeof syncIndicatorLayoutControls==='function')syncIndicatorLayoutControls();
}
function busy(value){preparing=value;if(value)drawingFileImport.cancel();$('cancel-compute').hidden=!value;$('workspace').setAttribute('aria-busy',String(value));for(const id of ['add-indicator','clear-indicators','series','scale','renderer','stream','load','layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down'])$(id).disabled=value||!model||!chart||chart.disposed;const ready=!!model&&!model.disposed&&!!chart&&!chart.disposed;for(const id of ['fit','recent','save','explore','explore-read'])$(id).disabled=!ready;for(const node of document.querySelectorAll('[data-tool]'))node.disabled=!ready;if(!value&&typeof syncIndicatorLayoutControls==='function')syncIndicatorLayoutControls();}
function progress(p){status(p.phase==='data'?'원본 데이터 준비 '+Math.round(p.done/p.total*100)+'%…':p.phase==='indicators'?'지표 계산 '+p.done+'/'+p.total+'…':'화면 인덱스를 준비합니다…');}
function defaults(market){const symbol=DEMO_SYMBOLS[market];return {panels:[{id:'price',label:'PRICE · EMA 20 · BOLLINGER 20',weight:3.5},{id:'volume',label:'VOLUME',weight:.8,precision:0},{id:'rsi',label:'RSI 14',weight:1,range:[0,100],precision:0}],series:[{id:'price',type:$('series').value,panel:'price'},{id:'volume',type:'histogram',source:'volume',panel:'volume',color:'#2b6e78'},{id:'ema',type:'line',panel:'price',indicator:'ema',color:'#f0b755'},{id:'upper',type:'line',panel:'price',indicator:'bb',output:'upper',color:'#63779e',width:1},{id:'lower',type:'line',panel:'price',indicator:'bb',output:'lower',color:'#63779e',width:1},{id:'rsi',type:'line',panel:'rsi',indicator:'rsi',color:'#aa91f7'}],indicators:[{id:'ema',name:'ema',params:{}},{id:'bb',name:'bollinger',params:{}},{id:'rsi',name:'rsi',params:{}}],precision:symbol.priceDecimals,axisWidth:market==='crypto'?125:85,theme:light?LIGHT_THEME:DARK_THEME};}
function palette(){
 // Preferences and chrome exist before the first asynchronous model does.
 document.documentElement.dataset.chartTheme=light?'light':'dark';$('theme').setAttribute('aria-pressed',String(light));
 if(!model)return;
 chart.api.setTheme(light?LIGHT_THEME:DARK_THEME);
 const colors={price:['#58cadb','#285bb9'],ema:['#f0b755','#946200'],rsi:['#aa91f7','#7150ba'],upper:['#63779e','#4a6084'],lower:['#63779e','#4a6084']};
 const extraColors=[['#f0b755','#946200'],['#aa91f7','#7150ba'],['#58cadb','#17687c']];
 for(const s of model.series){const extra=s.indicator?.startsWith('extra-'),pair=colors[s.id]??(extra?extraColors[serial%3]:null);if(!pair||s.id==='price'&&!['line','area','histogram'].includes(s.type))continue;
  // Known demo palette values follow the preset; other host colors survive.
  const patch={};if(s.color===undefined||(extra?extraColors.flat():pair).some(color=>s.color===color||s.color===color+'ff'))patch.color=pair[light?1:0];
  if(s.id==='price'&&(s.fill===undefined||['#58cadb22','#285bb933'].includes(s.fill)))patch.fill=light?'#285bb933':'#58cadb22';
  if(Object.keys(patch).length)chart.api.setSeries(s.id,patch);
 }
}
function layoutPanels(){if(!model)return;const total=model.panels.reduce((a,p)=>a+p.weight,0),min=Math.min(...model.panels.map(p=>p.weight)),height=Math.max(515,Math.ceil(72*total/min+38));$('chart-row').style.height=(height+(matchMedia('(max-width:600px)').matches?64:0))+'px';chart?.resize();}
function install(next,market,count,newExtras=extras){drawingFileImport.cancel();const same=market===loadedMarket,oldModel=model,oldChart=chart;layoutAxisExplicit=false;layoutDraft=null;if(!same){generatedPanelIds.clear();generatedAxisIds.clear();generatedPanelIds.add('rsi');}if(oldModel)journals.set(loadedMarket,oldModel.drawings);if(journals.has(market))next.drawings=journals.get(market);
 const symbol=DEMO_SYMBOLS[market];next.symbol=symbol;next.priceFormatter=v=>formatPrice(v,symbol);next.timeFormatter=t=>{const p=zonedParts(t,symbol.timezone);return p.month+'/'+p.day+' '+p.hour+':'+p.minute;};
 if(same&&oldModel){const span=oldModel.view.to-oldModel.view.from;next.setVisibleRange(oldModel.follow?next.store.length-span-.5:oldModel.view.from,oldModel.follow?next.store.length-.5:oldModel.view.to);}
 const host=document.createElement('div');host.style='width:100%;height:100%';let created;
 try{created=createChart(host,next,{renderer:$('renderer').value,dataExplorer:dataExplorer(),onError:error=>status(friendly(error)),onFallback:reason=>status('GPU를 사용할 수 없어 Canvas로 전환했습니다. '+reason.slice(0,80))});}catch(error){next.dispose();throw error;}
 oldChart?.destroy({disposeModel:true});$('chart').replaceChildren(host);model=next;chart=created;extras=newExtras;loadedMarket=market;loadedCount=count;streamCalendar=demoCalendar(market);palette();chart.setTool(document.querySelector('[data-tool][aria-pressed="true"]').dataset.tool);chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});chart.api.setDrawingMagnet({mode:$('magnet').value});chart.controller.text=$('annotation').value;chart.canvas.setAttribute('aria-describedby','keyboard-help exploration-help selection data-summary');host.addEventListener('aster:exploration',()=>{$('explore').setAttribute('aria-pressed',String(chart.dataExploration.active));});host.addEventListener('aster:render',sync);host.addEventListener('aster:state',sync);window.aster={model,chart};setText('symbol',symbol.id);setText('meta',symbol.currency+' · '+symbol.timezone+' · '+symbol.volumeUnit);layoutPanels();chart.invalidate();sync();
}
async function load(){if(!pageActive||pageClosed)return;const token=++job;controller?.abort();controller=new AbortController();stopStream();busy(true);const market=$('market').value,count=Number($('count').value),same=market===loadedMarket;const options=stripUncommittedLayoutResources(same&&model?modelRequest(model):defaults(market));
 try{const next=await prepareChartModel({market,count,options},{workerURL:new URL('./model-worker.mjs',import.meta.url),signal:controller.signal,onProgress:p=>{if(token===job&&pageActive&&!pageClosed)progress(p);}});if(token!==job){next.dispose();return;}install(next,market,count,same?extras:[]);if(!same)$('scale').value='linear';status('계산 완료 · 원본/지표는 worker에서 준비합니다. 키보드 안내와 데이터 요약을 확인하세요.');}
 catch(error){if(token===job){layoutDraft=null;layoutAxisExplicit=false;status(friendly(error));if(loadedMarket){$('market').value=loadedMarket;$('count').value=String(loadedCount);}}}finally{if(token===job){busy(false);if(streamIntent&&!document.hidden)startStream();}}
}
async function addIndicator(){if(!model||!pageActive||pageClosed)return;const token=++job;controller?.abort();controller=new AbortController();stopStream();busy(true);const version=model.store.version,options=stripUncommittedLayoutResources(modelRequest(model)),name=$('indicator').value,id='extra-'+(++serial),overlay=['sma','vwma','ema','wma','bollinger','donchian','vwap','dema','tema','hma','keltner','supertrend','ichimoku','pivots','parabolicSAR'].includes(name),panel=overlay?'price':id;
 try{const def=builtinIndicators.get(name)({});options.indicators.push({id,name,params:{}});if(!overlay)options.panels.push({id,label:name.toUpperCase(),weight:1});for(const output of def.outputs.filter(x=>x!=='direction'))options.series.push({id:id+'-'+output,type:output==='histogram'?'histogram':'line',panel,indicator:id,output,color:'#aa91f7'});
 const next=await prepareChartModel({columns:Object.fromEntries(Object.entries(model.store.columns).map(([k,a])=>[k,a.subarray(0,model.store.length)])),length:model.store.length,options},{signal:controller.signal,onProgress:p=>{if(token===job&&pageActive&&!pageClosed)progress(p);}});if(token!==job||version!==model.store.version){next.dispose();throw new Error('Data changed; prepared result discarded');}if(!overlay)generatedPanelIds.add(panel);install(next,loadedMarket,loadedCount,[...extras,{id,panel}]);status('지표를 추가했습니다.');}
 catch(error){if(token===job){layoutDraft=null;layoutAxisExplicit=false;status(friendly(error));}}finally{if(token===job){busy(false);if(streamIntent&&!document.hidden)startStream();}}
}
function selectedLayoutGroup(){return model&&indicatorGroup(model,$('layout-indicator')?.value)||collectIndicatorGroups(model)[0]||null;}
function layoutMutationReady(){if(!model||model.disposed||!chart||chart.disposed||preparing||!pageActive||pageClosed)return false;if(chart.controller?.gesture||chart.controller?.pointers?.size){layoutStatus('진행 중인 입력이 끝난 뒤 지표 배치를 변경하세요.');return false;}return true;}
function captureLayoutOwner(){return {model,chart,job};}
function layoutOwnerLive(owner){return !!owner&&model===owner.model&&chart===owner.chart&&job===owner.job&&pageActive&&!pageClosed&&!preparing&&!owner.model?.disposed&&!owner.chart?.disposed;}
function assertLayoutOwner(owner){if(!layoutOwnerLive(owner)){const error=new Error('지표 배치 소유자가 변경되어 적용을 중단했습니다.');error.name='StaleSourceError';throw error;}}
function beginLayoutMutation(owner){layoutMutationOwner=owner;}
function endLayoutMutation(owner){if(layoutMutationOwner===owner)layoutMutationOwner=null;}
function stripUncommittedLayoutResources(options){
 const owner=layoutMutationOwner;if(!owner||owner.model!==model)return options;
 const usedPanels=new Set(model.series.map(series=>series.panel)),usedAxes=new Set(model.series.map(series=>series.axisId).filter(Boolean));
 options.panels=options.panels?.filter(panel=>!generatedPanelIds.has(panel.id)||usedPanels.has(panel.id)||(model.axes??[]).some(axis=>axis.panel===panel.id)||drawingHasReference('panel',panel.id));
 options.axes=options.axes?.filter(axis=>!generatedAxisIds.has(axis.id)||usedAxes.has(axis.id)||drawingHasReference('axisId',axis.id));
 return options;
}
function rollbackCreatedResource(owner,kind,id){
 if(!layoutOwnerLive(owner))return false;
 try{
  if(kind==='axis'&&owner.model.axes.some(axis=>axis.id===id)&&!owner.model.series.some(series=>(series.axisId??null)===id)){owner.chart.api.removeAxis(id);generatedAxisIds.delete(id);return true;}
  if(kind==='panel'&&owner.model.panels.some(panel=>panel.id===id)&&!owner.model.series.some(series=>series.panel===id)&&!(owner.model.axes??[]).some(axis=>axis.panel===id)){owner.chart.api.removePanel(id);generatedPanelIds.delete(id);return true;}
 }catch{}
 return false;
}
function drawingHasReference(kind,id){
 const drawings=model?.drawings;if(!drawings)return false;
 const frames=[drawings.items,drawings.transaction,...(drawings.undoStack??[]),...(drawings.redoStack??[])];
 return frames.some(frame=>Array.isArray(frame)&&frame.some(drawing=>drawing?.[kind]===id));
}
function cleanupGeneratedLayout(owner=null){
 const retained={panels:[],axes:[],historyPanels:[],historyAxes:[],failedPanels:[],failedAxes:[]};if(!layoutMutationReady()||owner&&!layoutOwnerLive(owner))return retained;
 for(const id of [...generatedAxisIds]){
  if(owner&&!layoutOwnerLive(owner))return retained;
  if(!model.axes.some(axis=>axis.id===id)){generatedAxisIds.delete(id);continue;}
  if(model.series.some(series=>(series.axisId??null)===id))continue;
  try{chart.api.removeAxis(id);generatedAxisIds.delete(id);}catch{if(drawingHasReference('axisId',id))retained.historyAxes.push(id);else retained.failedAxes.push(id);if(owner&&!layoutOwnerLive(owner))return retained;}
 }
 for(const id of [...generatedPanelIds]){
  if(owner&&!layoutOwnerLive(owner))return retained;
  if(!model.panels.some(panel=>panel.id===id)){generatedPanelIds.delete(id);continue;}
  if(model.series.some(series=>series.panel===id)||model.axes.some(axis=>axis.panel===id))continue;
  try{chart.api.removePanel(id);generatedPanelIds.delete(id);}catch{if(drawingHasReference('panel',id))retained.historyPanels.push(id);else retained.failedPanels.push(id);if(owner&&!layoutOwnerLive(owner))return retained;}
 }
 return retained;
}
function applyIndicatorPlacement(){
 if(!layoutMutationReady())return;
 const owner=captureLayoutOwner(),group=selectedLayoutGroup(),target=$('layout-panel')?.value;
 if(!group||!model.panels.some(panel=>panel.id===target)){layoutStatus('표시된 지표와 대상 패널을 먼저 선택하세요.');return;}
 let choice=$('layout-axis')?.value??'primary';
 if(target!==group.panelId&&!layoutAxisExplicit&&choice==='primary')choice='independent';
 let axisId=null,createdAxis=null;
 try{
  beginLayoutMutation(owner);
  if(choice==='independent'){
   const id=uniqueLayoutId(group.id+'-axis',new Set((model.axes??[]).map(axis=>axis.id))),projection=copyAxisProjection(model,group);
   createdAxis=id;generatedAxisIds.add(id);owner.chart.api.addAxis({id,panel:target,label:(group.name??group.id).toUpperCase(),...projection});assertLayoutOwner(owner);axisId=id;
  }else if(choice.startsWith('axis:')){
   axisId=choice.slice(5);if(!model.axes.some(axis=>axis.id===axisId&&axis.panel===target))throw new Error('선택한 축을 찾을 수 없습니다.');
  }
  assertLayoutOwner(owner);owner.chart.api.setIndicatorPlacement(group.id,{panel:target,axisId});assertLayoutOwner(owner);
  layoutDraft=null;layoutAxisExplicit=false;const retained=cleanupGeneratedLayout(owner);assertLayoutOwner(owner);layoutPanels();assertLayoutOwner(owner);owner.chart.invalidate();assertLayoutOwner(owner);endLayoutMutation(owner);sync();
  const mixed=group.mixedPanelOrigins||group.mixedAxisOrigins;
  const historyNote=retained.historyPanels.length||retained.historyAxes.length?' · 도형 기록이 있어 이전 패널/축은 유지했습니다.':retained.failedPanels.length||retained.failedAxes.length?' · 일부 호스트 생성 패널/축을 아직 정리하지 못했습니다.':'';
  layoutStatus((mixed&&createdAxis?'여러 원본 축을 합쳐 선형 자동 범위의 독립 축으로 배치했습니다.':`${(group.name??group.id).toUpperCase()} 지표의 모든 출력선을 ${target} 패널에 배치했습니다.`)+historyNote);
  status('지표 배치를 적용했습니다.');
 }catch(error){
  if(createdAxis)rollbackCreatedResource(owner,'axis',createdAxis);
  if(createdAxis&&!owner.model.axes.some(axis=>axis.id===createdAxis))generatedAxisIds.delete(createdAxis);
  endLayoutMutation(owner);
  layoutDraft=null;layoutAxisExplicit=false;sync();layoutStatus(friendly(error));status(friendly(error));
 }
}
function separateIndicatorPanel(){
 if(!layoutMutationReady())return;
 const owner=captureLayoutOwner(),group=selectedLayoutGroup();if(!group)return;
 const id=uniqueLayoutId(group.id+'-panel',new Set((model.panels??[]).map(panel=>panel.id))),projection=copyPanelProjection(model,group),panel={id,label:(group.name??group.id).toUpperCase(),...projection};
 let added=false;
 try{beginLayoutMutation(owner);generatedPanelIds.add(id);owner.chart.api.addPanel(panel);added=true;assertLayoutOwner(owner);owner.chart.api.setIndicatorPlacement(group.id,{panel:id,axisId:null});assertLayoutOwner(owner);layoutDraft=null;layoutAxisExplicit=false;const retained=cleanupGeneratedLayout(owner);assertLayoutOwner(owner);layoutPanels();assertLayoutOwner(owner);owner.chart.invalidate();assertLayoutOwner(owner);endLayoutMutation(owner);sync();const historyNote=retained.historyPanels.length||retained.historyAxes.length?' 이전 패널/축은 도형 기록 때문에 유지했습니다.':retained.failedPanels.length||retained.failedAxes.length?' 일부 호스트 생성 패널/축을 아직 정리하지 못했습니다.':'';layoutStatus(`${(group.name??group.id).toUpperCase()} 지표를 새 패널로 분리했습니다.${historyNote}`);status('지표를 새 패널로 분리했습니다.');}
 catch(error){if(added)rollbackCreatedResource(owner,'panel',id);if(!owner.model.panels.some(panel=>panel.id===id))generatedPanelIds.delete(id);endLayoutMutation(owner);layoutDraft=null;layoutAxisExplicit=false;sync();layoutStatus(friendly(error));status(friendly(error));}
}
function reorderPanel(direction){
 if(!layoutMutationReady())return;
 const owner=captureLayoutOwner(),selected=$('reorder-panel')?.value,order=model.panels.map(panel=>panel.id),index=order.indexOf(selected),target=index+direction;
 if(index<0||target<0||target>=order.length)return;
 [order[index],order[target]]=[order[target],order[index]];
 try{beginLayoutMutation(owner);const changed=owner.chart.api.setPanelOrder(order);assertLayoutOwner(owner);if(changed===false){endLayoutMutation(owner);layoutStatus('패널 순서를 변경하지 못했습니다.');return;}layoutPanels();assertLayoutOwner(owner);owner.chart.invalidate();assertLayoutOwner(owner);endLayoutMutation(owner);sync();layoutStatus('패널 순서를 적용했습니다.');status('패널 순서를 적용했습니다.');}catch(error){endLayoutMutation(owner);sync();layoutStatus(friendly(error));status(friendly(error));}
}
function clearExtraIndicators(){
 if(!layoutMutationReady())return;
 const owner=captureLayoutOwner(),ids=[...new Set(extras.map(extra=>extra.id).filter(id=>model.indicators?.entries?.has?.(id)))];let removed=0;
 try{beginLayoutMutation(owner);for(const id of ids){if(model.series.some(series=>series.indicator===id)){owner.chart.api.removeIndicator(id);assertLayoutOwner(owner);removed++;}}extras=[];layoutDraft=null;layoutAxisExplicit=false;const retained=cleanupGeneratedLayout(owner);assertLayoutOwner(owner);layoutPanels();assertLayoutOwner(owner);owner.chart.invalidate();assertLayoutOwner(owner);endLayoutMutation(owner);sync();status(removed?(retained.historyPanels.length||retained.historyAxes.length?'추가 지표를 지웠고 도형 기록이 있는 패널/축은 유지했습니다.':retained.failedPanels.length||retained.failedAxes.length?'추가 지표를 지웠지만 일부 호스트 생성 패널/축을 아직 정리하지 못했습니다.':'추가 지표와 비어 있는 호스트 생성 패널을 지웠습니다.'):'지울 추가 지표가 없습니다.');}
 catch(error){endLayoutMutation(owner);layoutDraft=null;layoutAxisExplicit=false;sync();status(friendly(error));}
}
for(const name of builtinIndicators.keys()){const option=document.createElement('option');option.value=name;option.textContent=name.toUpperCase();$('indicator').append(option);}
$('market').onchange=load;$('count').onchange=load;$('cancel-compute').onclick=()=>controller?.abort();$('fit').onclick=()=>chart?.api.fit();$('recent').onclick=()=>chart?.api.setVisibleRange(model.store.length-200.5,model.store.length-.5);
$('series').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;const s=model.series.find(s=>s.id==='price'),old=s.type;try{chart.api.setSeries('price',{type:$('series').value});palette();chart.drawNow();}catch(error){chart.api.setSeries('price',{type:old});$('series').value=old;status(friendly(error));}chart.invalidate();};
$('scale').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;const old=model.panels.find(p=>p.id==='price').scale;try{chart.api.setPanel('price',{scale:$('scale').value});chart.drawNow();}catch(error){chart.api.setPanel('price',{scale:old});$('scale').value=old;status(friendly(error));}chart.invalidate();};
$('explore').onclick=()=>{if(!chart)return;try{chart.setDataExploration(!chart.dataExploration.active);$('explore').setAttribute('aria-pressed',String(chart.dataExploration.active));chart.canvas.focus({preventScroll:true});}catch(error){status(friendly(error));}};
$('explore-read').onclick=()=>{if(!chart)return;try{chart.readExploration();}catch(error){status(friendly(error));}};
 $('renderer').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;drawingFileImport.cancel();layoutDraft=null;layoutAxisExplicit=false;const tool=chart.controller.tool;chart.destroy();chart=createChart(chart.container,model,{renderer:$('renderer').value,dataExplorer:dataExplorer(),onError:error=>status(friendly(error))});chart.setTool(tool);chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});chart.api.setDrawingMagnet({mode:$('magnet').value});chart.controller.text=$('annotation').value;chart.canvas.setAttribute('aria-describedby','keyboard-help exploration-help selection data-summary');window.aster={model,chart};chart.invalidate();sync();};
$('theme').onclick=()=>{light=!light;palette();chart?.invalidate();};
for(const b of document.querySelectorAll('[data-tool]')){b.setAttribute('aria-pressed',String(b.dataset.tool==='select'));b.onclick=()=>{if(!chart)return;chart.setTool(b.dataset.tool);for(const x of document.querySelectorAll('[data-tool]'))x.setAttribute('aria-pressed',String(x===b));status('도구: '+b.title+' · '+(['channel','fibextension'].includes(b.dataset.tool)?'드래그 후 세 번째 핸들을 편집하세요.':'Esc로 취소할 수 있습니다.'));chart.canvas.focus({preventScroll:true});};}
$('crosshair-snap').onchange=()=>{if(chart)chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});status('십자선: '+$('crosshair-snap').selectedOptions[0].textContent+' · 포인터만 적용하며 도형 자석과 별개입니다.');};
$('magnet').onchange=()=>{if(chart)chart.api.setDrawingMagnet({mode:$('magnet').value});status('자석: '+$('magnet').selectedOptions[0].textContent+' · 보이는 OHLC 봉의 새 앵커·개별 핸들에 적용합니다.');};
$('annotation').oninput=()=>{if(chart)chart.api.setText($('annotation').value);};$('undo').onclick=()=>chart?.api.undo();$('redo').onclick=()=>chart?.api.redo();$('delete').onclick=()=>chart?.api.deleteDrawing();$('lock').onclick=()=>{if(!model||!chart||chart.disposed)return;const d=model.drawings.items.find(d=>d.id===model.drawings.selected);if(d)chart.api.editDrawing(d.id,{locked:!d.locked});};
$('save').onclick=()=>{if(!model||!chart||chart.disposed)return;try{const url=URL.createObjectURL(new Blob([chart.api.saveDrawings()],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='aster-drawings.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('도형을 저장했습니다.');}catch(error){status(friendly(error));}};
$('load').onclick=()=>{if(!model||!chart||chart.disposed||preparing)return;drawingFileImport.cancel();$('file').click();};$('file').onchange=async e=>{const file=e.target.files[0];e.target.value='';await drawingFileImport.read(file);};
$('add-indicator').onclick=addIndicator;$('clear-indicators').onclick=clearExtraIndicators;
$('layout-indicator').onchange=()=>{layoutAxisExplicit=false;const group=selectedLayoutGroup();if(group&&$('layout-panel'))$('layout-panel').value=group.panelId??model.panels[0]?.id??'';if(group)setLayoutDraft(group,$('layout-panel').value,group.mixedAxisOrigins?'independent':group.axisId===null?'primary':group.axisId===undefined?'independent':'axis:'+group.axisId,false);refreshLayoutAxisChoices(layoutDraft?.axis??'');syncIndicatorLayoutControls();};
$('layout-panel').onchange=()=>{const group=selectedLayoutGroup(),target=$('layout-panel').value;layoutAxisExplicit=false;const axis=group&&target===group.panelId&&!group.mixedAxisOrigins?(group.axisId===null?'primary':group.axisId===undefined?'independent':'axis:'+group.axisId):'independent';if(group)setLayoutDraft(group,target,axis,true);refreshLayoutAxisChoices(axis);};
$('layout-axis').onchange=()=>{const group=selectedLayoutGroup();layoutAxisExplicit=true;if(group)setLayoutDraft(group,$('layout-panel').value,$('layout-axis').value,true);};
$('apply-indicator-placement').onclick=applyIndicatorPlacement;$('separate-indicator-panel').onclick=separateIndicatorPanel;$('panel-up').onclick=()=>reorderPanel(-1);$('panel-down').onclick=()=>reorderPanel(1);
$('reorder-panel').onchange=()=>syncIndicatorLayoutControls();
function startStream(){if(timer||!model||model.disposed||!chart||chart.disposed||!pageActive||pageClosed||preparing||document.hidden)return;let ticks=0;timer=setInterval(()=>{try{const b=model.store.at(model.store.length-1),delta=Math.sin(++ticks*1.7)*.05*(model.symbol.id.endsWith('COIN')?1e-10:model.symbol.currency==='KRW'?700:1),close=Math.max(model.symbol.tickSize,b.close+delta);if(ticks%20)model.store.upsert({...b,close,high:Math.max(b.high,close),low:Math.min(b.low,close),volume:b.volume+20});else{let time=b.time+60000;const calendar=demoCalendarForStream();while(!calendar.at(time))time+=60000;model.store.append({time,open:close,high:close,low:close,close,volume:0});}}catch(error){streamIntent=false;stopStream();status(friendly(error));}},100);$('stream').setAttribute('aria-pressed','true');$('stream').textContent='Ⅱ 스트림 정지';}
let streamCalendar;function demoCalendarForStream(){return streamCalendar;}
$('stream').onclick=()=>{if(!model||!chart||chart.disposed||preparing)return;streamIntent=!streamIntent;if(streamIntent)startStream();else stopStream();};
const statsTimer=setInterval(()=>{if(!chart?.lastScene)return;const s=chart.lastScene.stats,sorted=[...chart.timings].sort((a,b)=>a-b);setText('stats',chart.rendererKind+' · 저장 '+s.storedBars.toLocaleString()+' · 표시 원본 '+s.visibleSourceBars.toLocaleString()+' · 버킷 '+s.renderedCandleBuckets+' · 제출 p95 '+(sorted[Math.floor(sorted.length*.95)]??0).toFixed(2)+'ms');},500);
window.addEventListener('resize',layoutPanels);
window.addEventListener('pagehide',e=>{drawingFileImport.cancel();
 if(pageClosed)return;
 // Preserve a suspended first-load intent across repeated pagehide events,
 // but never reinterpret an already-aborted user Cancel as a resume request.
 if(pageActive)resumeInitial=!!e.persisted&&!model&&preparing&&!controller?.signal.aborted;
 pageActive=false;if(!e.persisted){pageClosed=true;resumeInitial=false;}
 const pending=preparing;++job;controller?.abort();busy(false);stopStream();
 if(pending&&loadedMarket){$('market').value=loadedMarket;$('count').value=String(loadedCount);status('페이지 이동으로 계산을 취소했습니다. 이전 차트는 유지됩니다.');}
 if(!e.persisted){clearInterval(statsTimer);chart?.destroy({disposeModel:true});}
});
window.addEventListener('pageshow',e=>{
 if(!e.persisted||pageClosed||pageActive)return;
 pageActive=true;const retry=resumeInitial;resumeInitial=false;
 if(retry&&!model){status('중단된 첫 차트 계산을 다시 시작합니다.');void load();return;}
 chart?.resize();if(!pageActive||pageClosed)return;chart?.invalidate();if(streamIntent)startStream();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream();else if(pageActive&&!pageClosed&&streamIntent&&!preparing)startStream();});
await load();
