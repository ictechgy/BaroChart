import {createIndicatorEditor} from './indicator-editor.mjs';
import {createIndicatorPicker,INDICATOR_CATALOG} from './indicator-picker.mjs';

// Presentation-only controls for the Rust demo. The facade passed to the
// existing editor contains bounded metadata; chart data and calculations stay
// in the Worker-owned Rust session.
const CONTROL_IDS=[
 'indicator-search','indicator-category','indicator','indicator-search-summary',
 'add-indicator','clear-indicators','indicator-editor','drawing-controls',
 'chart-readout','explore','explore-read','explorer-readout','explorer-live',
];
const MAX_TEXT=4096;
const DRAWING_PAGE=32;
const own=value=>value&&typeof value==='object'?structuredClone(value):value;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const string=(value,fallback='')=>typeof value==='string'?value:fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const rawNumber=value=>value===null||value===undefined?'없음':Object.is(value,-0)?'-0':String(value);

function query(root,id){
 if(root?.nodeType===9&&typeof root.getElementById==='function')return root.getElementById(id);
 return root?.querySelector?.(`#${id}`)??null;
}
function button(document,label,action){const node=document.createElement('button');node.type='button';node.textContent=label;node.dataset.action=action;return node;}
function disabled(node,value){if(node)node.disabled=!!value;}
function bounded(message){return String(message??'').slice(0,MAX_TEXT);}

export function createRustDemoWidgets({root=globalThis.document,getSession,getChart,onAddIndicator,onClearIndicators,onRemoveIndicator,onMutation,onError,onJob}={}){
 if(!root||typeof root!=='object')throw new TypeError('Rust demo root required');
 if(typeof getSession!=='function')throw new TypeError('Rust session getter required');
 if(typeof getChart!=='function')throw new TypeError('Rust chart getter required');
 for(const [name,value] of Object.entries({onAddIndicator,onClearIndicators,onRemoveIndicator,onMutation,onError,onJob}))if(value!==undefined&&typeof value!=='function')throw new TypeError(`${name} callback required`);
 const document=root.nodeType===9?root:root.ownerDocument;
 if(!document?.createElement)throw new TypeError('Rust demo document required');
 const nodes=Object.fromEntries(CONTROL_IDS.map(id=>[id,query(root,id)]));
 if(!nodes['indicator-editor'])throw new TypeError('Rust indicator editor root required');
 let disposed=false,epoch=0,externalBusy=false,pending=0,configuration=null,drawings=null,state=null,catalog=[],picker=null,pickerSignature='';
 let facade={model:{disposed:false,indicators:{entries:new Map()},series:[]}};
 let drawingSelection=new Set(),drawingOffset=0,drawingMessage='',chartCanvas=null,explorer={active:false,index:null,seriesId:null,phase:'off'};
 let readoutKey='',readoutSequence=0;
 const listeners=[];
 const isBusy=()=>externalBusy||pending>0;
 const alive=token=>!disposed&&token===epoch;
 const report=error=>{if(disposed)return;try{onError?.(error instanceof Error?error:new Error(String(error)));}catch{}};
 const announce=(message,node=nodes['indicator-search-summary'])=>{if(node&&!disposed)node.textContent=bounded(message);};
 const listen=(node,type,handler,options)=>{if(!node?.addEventListener)return;node.addEventListener(type,handler,options);listeners.push([node,type,handler,options]);};
 const emitJob=(kind,operation,active)=>{try{onJob?.({kind,operation,active});}catch{}};

 let editor;
 function updateDisabled(){
  const blocked=isBusy(),ready=!!configuration;
  for(const node of [nodes['indicator-search'],nodes['indicator-category'],nodes.indicator])disabled(node,blocked||!picker);
  disabled(nodes['add-indicator'],blocked||typeof onAddIndicator!=='function'||!picker?.selectedName);
  disabled(nodes['clear-indicators'],blocked||typeof onClearIndicators!=='function'||!ready||!configuration?.indicators?.length);
  disabled(nodes.explore,blocked||!ready||!state?.data?.length);
  disabled(nodes['explore-read'],blocked||!explorer.active||explorer.index===null);
  editor?.sync();
  for(const node of nodes['drawing-controls']?.querySelectorAll?.('button,input')??[])disabled(node,blocked||node.dataset?.baseDisabled==='true'||node.dataset?.requiresSelection==='true'&&!drawingSelection.size);
 }

 async function withJob(kind,operation,work){
  if(disposed)throw new Error('Rust demo widgets disposed');
  if(isBusy())throw new Error('Rust demo is busy');
  pending++;emitJob(kind,operation,true);updateDisabled();
  try{return await work();}
  finally{pending--;emitJob(kind,operation,false);updateDisabled();}
 }
 async function refreshAfterCandidateMutation(operation,args,result,token){
  let callbackError;try{await onMutation?.({operation,args:own(args),result:own(result)});}catch(error){callbackError=error;}
  if(alive(token))await refresh();
  if(callbackError)throw callbackError;
  return result;
 }
 async function runOwnedMutation(source,token,operation,args,work){
  let result,primary;
  try{result=await work();}catch(error){primary=error;}
  if(!primary&&(!alive(token)||getSession()!==source)){primary=new Error('Rust mutation owner changed');report(primary);}
  if(!primary){
   try{await onMutation?.({operation,args:own(args),result:own(result)});}catch(error){primary=error;}
   if(!primary&&(!alive(token)||getSession()!==source)){primary=new Error('Rust mutation owner changed');report(primary);}
  }
  if(!disposed){try{await refresh();}catch(error){if(!primary)primary=error;else report(error);}}
  if(primary)throw primary;return result;
 }
 async function mutate(operation,args=[]){
  const token=epoch,session=getSession();
  if(!session?.command)throw new Error('Rust session unavailable');
  return withJob('mutation',operation,()=>runOwnedMutation(session,token,operation,args,()=>session.command(operation,own(args))));
 }
 async function removeIndicator(id){
  const indicator=activeIndicatorRows().find(row=>row?.id===id);if(!indicator)throw new Error('Rust indicator owner changed');
  const seriesIds=(configuration?.series??[]).filter(row=>row?.indicator===id&&typeof row.id==='string').map(row=>row.id);
  if(new Set(seriesIds).size!==seriesIds.length)throw new Error('Rust indicator series binding changed');
  const token=epoch,session=getSession(),ensureOwner=()=>{if(disposed||epoch!==token||getSession()!==session)throw new Error('Rust indicator owner changed');};
  return withJob('indicator','remove',async()=>{
   let result,primary;
   try{
    if(onRemoveIndicator){result=await onRemoveIndicator({id,seriesIds:[...seriesIds]});ensureOwner();}
    else{
     const removed=[];for(const seriesId of seriesIds){ensureOwner();removed.push(await session.command('removeSeries',[seriesId]));}
     ensureOwner();result={series:removed,indicator:await session.command('removeIndicator',[id])};
    }
    try{await onMutation?.({operation:'removeIndicator',args:[id],seriesIds:[...seriesIds],result:own(result)});}catch(error){primary=error;}
   }catch(error){primary=error;}
   if(!disposed&&getSession()===session){try{await refresh();}catch(error){if(!primary)primary=error;else report(error);}}
   if(primary)throw primary;return result;
  });
 }
 async function drawingMutation(operation,args){
  const owner=getSession(),token=epoch;
  return withJob('drawing',operation,async()=>{
   let result,primary;
   try{
    result=await owner.command(operation,own(args));
    if(disposed||getSession()!==owner||epoch!==token)throw new Error('Rust drawing owner changed');
    try{await onMutation?.({operation,args:own(args),result:own(result)});if(disposed||getSession()!==owner||epoch!==token)throw new Error('Rust drawing owner changed');}catch(error){primary=error;}
   }catch(error){primary=error;}
   if(!disposed){try{await refresh();}catch(error){if(!primary)primary=error;else report(error);}}
   if(primary)throw primary;return result;
  });
 }

 function activeIndicatorRows(){return Array.isArray(configuration?.indicators)?configuration.indicators:[];}
 function rebuildFacade(){
  const entries=new Map();
  for(const row of activeIndicatorRows()){
   if(!row||typeof row.id!=='string'||typeof row.name!=='string')continue;
   const outputs=Array.isArray(row.outputs)?[...row.outputs]:[];
   entries.set(row.id,{name:row.name,params:own(row.params??{}),outputs,def:{outputs,plotOffsets:own(row.plotOffsets??{})}});
  }
  facade={model:{disposed:false,indicators:{entries},series:Array.isArray(configuration?.series)?own(configuration.series):[]}};
 }
 function rebuildPicker(){
  const available=new Set(catalog.map(row=>row.name)),usable=INDICATOR_CATALOG.filter(row=>available.has(row.id));
  const signature=usable.map(row=>row.id).join('\0');
  if(signature===pickerSignature&&picker)return;
  const selected=picker?.selectedName??nodes.indicator?.value;
  picker?.destroy();picker=null;pickerSignature=signature;
  if(nodes['indicator-search']&&nodes.indicator&&nodes['indicator-search-summary']){
   picker=createIndicatorPicker({search:nodes['indicator-search'],category:nodes['indicator-category'],select:nodes.indicator,summary:nodes['indicator-search-summary'],catalog:usable,onSelect:()=>updateDisabled()});
   if(selected&&usable.some(row=>row.id===selected))nodes.indicator.value=selected;
  }
 }

 editor=createIndicatorEditor({
  root:nodes['indicator-editor'],getChart:()=>facade,isBusy,
  onApplyParams:(id,params)=>withJob('params',id,async()=>{
   const token=epoch,session=getSession();if(!session?.setIndicatorParams)throw new Error('Rust params API unavailable');
   return runOwnedMutation(session,token,'setIndicatorParams',[id,params],()=>session.setIndicatorParams(id,params));
  }),
  onApplyStyle:(id,patch)=>mutate('setSeries',[id,patch]),
  onRemove:removeIndicator,
  onStatus:message=>announce(message),
 });

 function renderDrawings(){
  const panel=nodes['drawing-controls'];if(!panel)return;
  const items=Array.isArray(drawings?.items)?drawings.items:[],existing=new Set(items.map(item=>item?.id).filter(id=>typeof id==='string'));
  drawingSelection=new Set([...drawingSelection].filter(id=>existing.has(id)));if(drawingOffset>=items.length&&drawingOffset)drawingOffset=Math.max(0,Math.floor((items.length-1)/DRAWING_PAGE)*DRAWING_PAGE);panel.replaceChildren();
  const count=document.createElement('p');count.dataset.role='drawing-count';count.textContent=`${drawingSelection.size}개 선택 · 전체 ${items.length}개 · ${items.length?drawingOffset+1:0}–${Math.min(drawingOffset+DRAWING_PAGE,items.length)} 표시 · 다른 페이지의 선택도 작업에 포함됩니다.`;panel.append(count);
  const list=document.createElement('ul');list.setAttribute('aria-label','Rust 도형 목록');
  for(const item of items.slice(drawingOffset,drawingOffset+DRAWING_PAGE)){
   if(!item||typeof item.id!=='string')continue;
   const row=document.createElement('li'),label=document.createElement('label'),check=document.createElement('input'),description=document.createElement('span'),toggle=button(document,item.visible===false?'표시':'숨기기','row-visibility');row.dataset.drawingId=item.id;toggle.dataset.drawingId=item.id;
   check.type='checkbox';check.value=item.id;check.checked=drawingSelection.has(item.id);check.setAttribute('aria-label',`${item.id} 선택`);
   check.onchange=()=>{check.checked?drawingSelection.add(item.id):drawingSelection.delete(item.id);renderDrawings();};
   toggle.onclick=()=>runDrawing('setDrawingVisibility',()=>[item.id,item.visible===false]);
   description.textContent=`${string(item.type,'drawing')} · ${item.id}${item.visible===false?' · 숨김':''}${item.locked?' · 잠김':''}`;
   label.append(check,description);row.append(label,toggle);list.append(row);
  }
  panel.append(list);
  if(!items.length){const empty=document.createElement('p'),status=document.createElement('p');empty.textContent='저장된 도형이 없습니다.';status.dataset.role='drawing-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent=drawingMessage;panel.append(empty,status);return;}
  const navigation=document.createElement('div'),previous=button(document,'이전 페이지','previous-page'),next=button(document,'다음 페이지','next-page'),clear=button(document,'선택 해제','clear-selection');
  previous.dataset.baseDisabled=String(drawingOffset===0);next.dataset.baseDisabled=String(drawingOffset+DRAWING_PAGE>=items.length);clear.dataset.requiresSelection='true';
  previous.onclick=()=>{drawingOffset=Math.max(0,drawingOffset-DRAWING_PAGE);renderDrawings();};next.onclick=()=>{drawingOffset+=DRAWING_PAGE;renderDrawings();};clear.onclick=()=>{drawingSelection.clear();drawingMessage='선택을 해제했습니다.';renderDrawings();};navigation.append(previous,next,clear);panel.append(navigation);
  const duplicate=document.createElement('fieldset'),duplicateLegend=document.createElement('legend'),timeLabel=document.createElement('label'),timeOffset=document.createElement('input'),priceLabel=document.createElement('label'),priceOffset=document.createElement('input');duplicateLegend.textContent='복제 원시 오프셋';
  timeLabel.textContent='시간 오프셋(ms)';timeOffset.type='text';timeOffset.value='0';timeOffset.maxLength=64;timeOffset.dataset.field='deltaTimeMs';timeLabel.append(timeOffset);
  priceLabel.textContent='가격 오프셋';priceOffset.type='text';priceOffset.value='0';priceOffset.maxLength=64;priceOffset.dataset.field='deltaPrice';priceLabel.append(priceOffset);duplicate.append(duplicateLegend,timeLabel,priceLabel);
  const style=document.createElement('fieldset'),styleLegend=document.createElement('legend');styleLegend.textContent='체크한 스타일만 적용';style.append(styleLegend);const styleFields=new Map();
  for(const [name,value] of Object.entries({color:'#3366cc',fill:'#99bbff',width:'2',font:'12px monospace'})){const row=document.createElement('div'),enabledLabel=document.createElement('label'),enabled=document.createElement('input'),valueLabel=document.createElement('label'),input=document.createElement('input');enabled.type='checkbox';enabled.dataset.enableField=name;enabled.setAttribute('aria-label',`${name} 적용`);input.type='text';input.value=value;input.maxLength=name==='font'?256:128;input.dataset.field=name;input.setAttribute('aria-label',`${name} 값`);enabledLabel.append(enabled,document.createTextNode?.(`${name} 적용`)??document.createElement('span'));valueLabel.append(input);row.append(enabledLabel,valueLabel);style.append(row);styleFields.set(name,{enabled,input});}
  const actions=document.createElement('div');
  const action=(label,name,args)=>{const node=button(document,label,name);node.dataset.requiresSelection='true';node.onclick=()=>{if(drawingSelection.size)runDrawing(name,()=>args([...drawingSelection]));};actions.append(node);};
  action('선택 삭제','deleteDrawings',ids=>[ids]);action('선택 숨김','setDrawingsVisibility',ids=>[ids,false]);action('선택 표시','setDrawingsVisibility',ids=>[ids,true]);
  action('선택 복제','duplicateDrawings',ids=>{const time=String(timeOffset.value).trim(),price=String(priceOffset.value).trim(),deltaTimeMs=Number(time),deltaPrice=Number(price);if(!time||!price||!Number.isFinite(deltaTimeMs)||!Number.isFinite(deltaPrice))throw new TypeError('복제 오프셋은 유한한 숫자여야 합니다.');return[ids,{deltaTimeMs,deltaPrice}];});
  action('선택 스타일 적용','setDrawingsStyle',ids=>{const patch={};for(const [name,{enabled,input}]of styleFields)if(enabled.checked){const value=String(input.value).trim();if(!value)throw new TypeError('체크한 스타일 값은 비워 둘 수 없습니다.');if(name==='width'){const width=Number(value);if(!Number.isFinite(width)||width<.1||width>50)throw new RangeError('선 너비는 0.1–50이어야 합니다.');patch.width=width;}else patch[name]=value;}if(!Object.keys(patch).length)throw new TypeError('적용할 스타일을 하나 이상 체크하세요.');return[ids,patch];});
  const status=document.createElement('p');status.dataset.role='drawing-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent=drawingMessage;panel.append(duplicate,style,actions,status);updateDisabled();
 }
 function runDrawing(operation,argsFactory){
  if(isBusy())return;let args;try{args=argsFactory();}catch(error){drawingMessage=string(error?.message,'도형 작업 입력을 확인하세요.');renderDrawings();report(error);return;}
  void drawingMutation(operation,args).then(result=>{drawingMessage=`${result?.changed??0}개 도형을 변경했습니다.`;renderDrawings();},error=>{drawingMessage=string(error?.message,'도형 작업에 실패했습니다.');renderDrawings();report(error);});
 }

 function selectedCrosshairIndex(){
  const length=state?.data?.length;if(!Number.isSafeInteger(length)||length<1)return null;
  const cursor=state?.interaction?.crosshair;if(!cursor||!finite(cursor.x))return length-1;
  const chart=getChart(),width=chart?.lastScene?.width??chart?.canvas?.clientWidth;
  if(!finite(width)||width<=20)return clamp(Math.round(state?.view?.to??length-1),0,length-1);
  const from=finite(state?.view?.from)?state.view.from:0,to=finite(state?.view?.to)?state.view.to:length-1;
  const left=12,right=Math.max(left+20,width-(finite(configuration?.axisWidth)?configuration.axisWidth:85));
  return clamp(Math.round(from+(clamp(cursor.x,left,right)-left)/(right-left)*(to-from)),0,length-1);
 }
 function priceDigits(){const value=configuration?.symbol?.priceDecimals??configuration?.precision;return Number.isSafeInteger(value)&&value>=0&&value<=20?value:2;}
 function numberText(value,digits=priceDigits()){
  if(value===null||value===undefined)return '없음';if(!finite(value))return rawNumber(value);
  try{return new Intl.NumberFormat('ko-KR',{minimumFractionDigits:digits,maximumFractionDigits:digits,useGrouping:true}).format(value);}catch{return rawNumber(value);}
 }
 function timeText(value){
  if(!finite(value))return rawNumber(value);const timezone=string(configuration?.symbol?.timezone,'UTC');
  try{return new Intl.DateTimeFormat('ko-KR',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}
  catch{try{return new Date(value).toISOString();}catch{return rawNumber(value);}}
 }
 function snapshotText(result,label){
  if(!result?.primary?.bar)return{visual:`${label} · 데이터 없음`,raw:`${label}; no data`};
  const bar=result.primary.bar,row=result.series?.find(item=>item.id===explorer.seriesId)??result.series?.[0],unit=string(configuration?.symbol?.currency),volumeUnit=string(configuration?.symbol?.volumeUnit);
  const visual=bounded(`${label} · 봉 ${result.index+1} · ${timeText(result.time)} · 시가 ${numberText(bar.open)} · 고가 ${numberText(bar.high)} · 저가 ${numberText(bar.low)} · 종가 ${numberText(bar.close)}${unit?` ${unit}`:''} · 거래량 ${numberText(bar.volume,Math.min(8,priceDigits()))}${volumeUnit?` ${volumeUnit}`:''}${row?` · ${row.label??row.id} ${row.status}: ${numberText(row.value)}`:''}`);
  const raw=bounded(`${label}; index ${rawNumber(result.index)}; time ${rawNumber(result.time)}; open ${rawNumber(bar.open)}; high ${rawNumber(bar.high)}; low ${rawNumber(bar.low)}; close ${rawNumber(bar.close)}; volume ${rawNumber(bar.volume)}${row?`; series ${row.id}; status ${row.status}; value ${rawNumber(row.value)}`:''}`);
  return{visual,raw};
 }
 function publishSnapshot(node,result,label){if(!node)return;const value=snapshotText(result,label);node.textContent=value.visual;node.setAttribute('aria-label',value.raw);}
 async function readData(index,{token=epoch}={}){
  if(!Number.isSafeInteger(index)||index<0)return null;
  const result=await getSession().command('dataAt',[{index},{indicatorMode:'cached'}]);
  if(!alive(token))return null;
  return result;
 }
 function scheduleReadout(){
  const index=selectedCrosshairIndex(),cursor=state?.interaction?.crosshair,key=`${state?.data?.version}:${index}:${cursor?.x}:${cursor?.y}`;
  if(index===null){if(nodes['chart-readout'])nodes['chart-readout'].textContent='데이터가 없습니다.';return;}
  if(key===readoutKey)return;readoutKey=key;const sequence=++readoutSequence,token=epoch;
  if(nodes['chart-readout'])nodes['chart-readout'].textContent=cursor?'Rust 십자선 값을 읽는 중…':'Rust 최신 봉 값을 읽는 중…';
  getSession().command('dataAt',[{index},{indicatorMode:'cached'}]).then(result=>{if(alive(token)&&sequence===readoutSequence)publishSnapshot(nodes['chart-readout'],result,cursor?'Rust 십자선':'Rust 최신 봉');},error=>{if(alive(token)&&sequence===readoutSequence){report(error);if(nodes['chart-readout'])nodes['chart-readout'].textContent='Rust 값을 읽지 못했습니다.';}});
 }

 function visibleSeries(){return (configuration?.series??[]).filter(row=>row?.visible!==false&&typeof row?.id==='string');}
 function explorerText(){
  if(!explorer.active)return '데이터 탐색을 켜세요.';
  const length=state?.data?.length??0,row=visibleSeries().find(item=>item.id===explorer.seriesId);
  return length?`봉 ${(explorer.index??0)+1} / ${length} · ${row?.label??row?.id??'표시 시리즈 없음'} · Enter로 값을 읽습니다.`:'저장된 봉이 없습니다.';
 }
 function publishExplorer(message=explorerText()){if(nodes['explorer-readout'])nodes['explorer-readout'].textContent=bounded(message);if(nodes.explore)nodes.explore.setAttribute('aria-pressed',String(explorer.active));disabled(nodes['explore-read'],isBusy()||!explorer.active||explorer.index===null);}
 function setExplorer(active){
  explorer.active=!!active;explorer.phase=active?'selected':'off';
  if(active){const length=state?.data?.length??0;explorer.index=length?clamp(Math.floor(state?.view?.to??length-1),0,length-1):null;explorer.seriesId=visibleSeries()[0]?.id??null;}else{explorer.index=null;explorer.seriesId=null;}
  publishExplorer();
 }
 async function readExplorer(){
  if(!explorer.active||explorer.index===null)return;const token=epoch;explorer.phase='reading';
  try{const result=await withJob('read','dataAt',()=>readData(explorer.index,{token}));if(alive(token)&&result){explorer.phase='read';publishSnapshot(nodes['explorer-readout'],result,'키보드 선택');if(nodes['explorer-live'])nodes['explorer-live'].textContent='데이터 탐색 값을 읽었습니다.';}}
  catch(error){if(alive(token)){explorer.phase='error';publishExplorer('값 읽기에 실패했습니다. Enter로 다시 시도하세요.');report(error);}}
 }
 function explorerKey(event){
  if(!explorer.active||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
  const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter','Escape'];if(!keys.includes(event.key))return;
  event.preventDefault?.();event.stopImmediatePropagation?.();event.stopPropagation?.();
  if(event.key==='Escape'){setExplorer(false);return;}if(event.key==='Enter'){void readExplorer();return;}
  const length=state?.data?.length??0,rows=visibleSeries();
  if(event.key==='Home'||event.key==='End')explorer.index=length?(event.key==='Home'?0:length-1):null;
  else if(event.key==='ArrowLeft'||event.key==='ArrowRight')explorer.index=length?clamp((explorer.index??0)+(event.key==='ArrowLeft'?-1:1),0,length-1):null;
  else{const current=Math.max(0,rows.findIndex(row=>row.id===explorer.seriesId)),next=clamp(current+(event.key==='ArrowUp'?-1:1),0,Math.max(0,rows.length-1));explorer.seriesId=rows[next]?.id??null;}
  explorer.phase='selected';publishExplorer();
 }
 function bindChartCanvas(){
  let chart;try{chart=getChart();}catch{return;}const next=chart?.canvas??null;if(next===chartCanvas)return;
  if(chartCanvas)chartCanvas.removeEventListener?.('keydown',explorerKey,true);chartCanvas=next;if(chartCanvas)chartCanvas.addEventListener?.('keydown',explorerKey,true);
 }

 listen(nodes['add-indicator'],'click',()=>{const name=picker?.selectedName;if(name&&!isBusy()){const token=epoch,label=bounded(picker.selected?.koreanName??name);void withJob('indicator','add',async()=>refreshAfterCandidateMutation('addIndicator',[name,label],await onAddIndicator?.(name,label),token)).catch(report);}});
 listen(nodes['clear-indicators'],'click',()=>{if(!isBusy()){const token=epoch;void withJob('indicator','clear',async()=>refreshAfterCandidateMutation('clearIndicators',[],await onClearIndicators?.(),token)).catch(report);}});
 listen(nodes.explore,'click',()=>{if(!isBusy())setExplorer(!explorer.active);});listen(nodes['explore-read'],'click',()=>void readExplorer());

 async function refresh(next={}){
  const token=++epoch,session=getSession();
  try{
   const [nextConfiguration,nextDrawings,nextCatalog]=await Promise.all([
    next.configuration!==undefined?own(next.configuration):session.query('web.configuration'),
    next.drawings!==undefined?own(next.drawings):session.query('web.drawingsState'),
    catalog.length?null:session.query('web.indicatorCatalog'),
   ]);
   if(!alive(token))return;
   configuration=nextConfiguration;drawings=nextDrawings;state=next.state!==undefined?own(next.state):own(session.snapshot());if(nextCatalog)catalog=Array.isArray(nextCatalog.entries)?own(nextCatalog.entries):[];
   rebuildFacade();rebuildPicker();editor.sync();renderDrawings();bindChartCanvas();
   if(explorer.active){const length=state?.data?.length??0;explorer.index=length?clamp(explorer.index??Math.floor(state?.view?.to??length-1),0,length-1):null;if(!visibleSeries().some(row=>row.id===explorer.seriesId))explorer.seriesId=visibleSeries()[0]?.id??null;publishExplorer();}
   scheduleReadout();updateDisabled();
  }catch(error){if(alive(token))report(error);throw error;}
 }
 function setBusy(value){externalBusy=!!value;updateDisabled();}
 function dispose(){
  if(disposed)return;disposed=true;epoch++;readoutSequence++;picker?.destroy();editor.dispose();if(chartCanvas)chartCanvas.removeEventListener?.('keydown',explorerKey,true);chartCanvas=null;
  for(const [node,type,handler,options] of listeners)node.removeEventListener(type,handler,options);listeners.length=0;
 }
 return Object.freeze({refresh,setBusy,dispose,get disposed(){return disposed;}});
}
