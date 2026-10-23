import {ChartModel,CanvasChart,attachChartToolbar,DARK_THEME,LIGHT_THEME,DRAWING_TYPES,seededColumns,saveChartUI,readChartUI,createChartUIPreset,attachChartOverlays,attachChartNavigator,attachTradeMarkers} from '../../src/index.mjs';
import {saveCustomizationProfile,readCustomizationProfile} from './customization-profile.mjs';

const $=id=>document.getElementById(id),root=$('customization-demo');
const NEW_STORAGE_KEY='barochart.customization.profile.v1',LEGACY_STORAGE_KEY='barochart.customization.web-ui.v1',MAX_FILE_CHARS=64*1024;
const koreanLabels=Object.freeze({select:'선택 / 이동',trendline:'추세선',horizontal:'수평선',fibonacci:'피보나치 되돌림',rectangle:'사각형',ellipse:'타원',text:'텍스트',ray:'광선',extendedline:'연장선',channel:'채널',fibextension:'피보나치 확장',fibfan:'피보나치 팬',fibtimezones:'피보나치 시간대',freehand:'자유 그리기',longposition:'롱 포지션',shortposition:'숏 포지션',measurement:'측정',fit:'전체 보기',zoomIn:'확대',zoomOut:'축소',undo:'실행 취소',redo:'다시 실행'});
const colorLabels={background:'배경',grid:'격자',text:'축 글자',up:'상승',down:'하락',crosshair:'십자선'};
const model=new ChartModel({panels:[{id:'price',weight:3.5,axisSide:'right'},{id:'volume',weight:1,precision:0,axisSide:'right'}]});
model.store.setColumns(seededColumns(512));
model.addSeries({id:'price',type:'candles',panel:'price'});
model.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume',color:'#4c8cad'});
const chart=new CanvasChart($('customization-chart'),model),toolbar=attachChartToolbar($('customization-toolbar'),chart,{orientation:'vertical',tools:['select','trendline','horizontal','rectangle'],labels:koreanLabels});
const statusNode=$('customization-status'),stateNode=$('profile-state');
const stateText={ready:'준비됨',dirty:'변경됨',saved:'저장됨',error:'오류'};
const PROFILE_TEXT_CHARS=16384;
let draftRevision=0,fileGeneration=0,statusGeneration=0,savedBaselineText=null,defaultProfileText='';

function status(text,state='ready'){
 statusGeneration++;
 statusNode.textContent=String(text);statusNode.setAttribute('data-state',state);stateNode.textContent=stateText[state]??state;stateNode.setAttribute('data-state',state);
}
function errorMessage(error){return String(error?.message??error??'알 수 없는 오류').replace(/\s+/g,' ').slice(0,220);}
function syncActualControls(){if(chart.disposed)return;syncAppearance();syncToolbar();syncInput();syncLayout();syncExtrasControls();}
function report(error){status('오류: '+errorMessage(error),'error');try{syncActualControls();}catch{}}
function invalidatePending(){fileGeneration++;draftRevision++;}
function currentDraftState(){try{const current=profileText();if(savedBaselineText!==null)return current===savedBaselineText?'saved':'dirty';return defaultProfileText&&current===defaultProfileText?'ready':'dirty';}catch{return 'dirty';}}
function announceDraft(message){status(message,currentDraftState());}
function live(){if(chart.disposed)throw new Error('Chart disposed');return true;}
function activeGesture(){return !!chart.controller?.gesture||!!chart.controller?.pointers?.size||!!model.drawings?.transaction;}
function guard(){live();if(activeGesture())throw new Error('진행 중인 입력을 완료하거나 취소한 뒤 다시 시도하세요.');}
function changed(fn,message='설정을 적용했습니다.'){
 try{let before=null;try{before=profileText();}catch{}const result=fn();syncSummaries();const after=profileText();if(before===null||after!==before){fileGeneration++;draftRevision++;}status(message,currentDraftState());return result;}catch(error){report(error);return undefined;}
}

const colors=new Map();
for(const[key,name]of Object.entries(colorLabels)){
 const label=document.createElement('label'),input=document.createElement('input');input.type='color';input.value=String(DARK_THEME[key]).slice(0,7);label.append(document.createTextNode(name),input);$('colors').append(label);colors.set(key,input);
 input.onchange=()=>changed(()=>chart.api.setTheme({[key]:input.value}),name+' 색상을 적용했습니다.');
}
function baseColor(value){const text=String(value??'').toLowerCase();return /^#[\da-f]{8}$/.test(text)?text.slice(0,7):text;}
function backgroundLuminance(value){const hex=baseColor(value).slice(1);if(!/^[\da-f]{6}$/.test(hex))return 0;const rgb=[0,2,4].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function sameTheme(a,b){return Object.keys(colorLabels).every(key=>baseColor(a[key])===baseColor(b[key]))&&String(a.font)===String(b.font);}
function syncAppearance(){
 for(const[key,input]of colors)input.value=baseColor(model.theme[key]);
 const match=String(model.theme.font??'').match(/(\d+(?:\.\d+)?)px/);$('font-size').value=match?.[1]??'12';
 const preset=sameTheme(model.theme,DARK_THEME)?'dark':sameTheme(model.theme,LIGHT_THEME)?'light':'custom';$('preset').value=preset;root.dataset.theme=backgroundLuminance(model.theme.background)>=.5?'light':'dark';
 $('appearance-summary').textContent=(preset==='dark'?'다크':preset==='light'?'라이트':'사용자 정의')+' · 6색';
}
function setPreset(){guard();const value=$('preset').value;if(value==='custom')return;chart.api.setTheme(value==='light'?LIGHT_THEME:DARK_THEME);root.dataset.theme=value;syncAppearance();}
$('preset').onchange=()=>changed(setPreset,'테마를 적용했습니다.');
$('font-size').onchange=()=>changed(()=>{const value=Number($('font-size').value);if(!Number.isFinite(value)||value<10||value>24)throw new RangeError('차트 글자 크기: 10..24');chart.api.setTheme({font:value+'px monospace'});syncAppearance();},'차트 글자 크기를 적용했습니다.');
$('reset-appearance').onclick=()=>changed(()=>{guard();chart.api.setTheme(DARK_THEME);syncAppearance();},'모양을 초기화했습니다.');

let ordered=['select',...DRAWING_TYPES],selected=new Set(toolbar.snapshot().tools),choices=new Map();
function renderChoices(){
 const host=$('tool-choices'),focused=document.activeElement;
 for(const id of ordered){
  let row=choices.get(id);
  if(!row){
   const box=document.createElement('input'),label=document.createElement('label'),node=document.createElement('div'),up=document.createElement('button'),down=document.createElement('button');
   box.type='checkbox';box.disabled=id==='select';label.append(box,document.createTextNode(koreanLabels[id]??id));node.className='tool-choice';node.append(label,up,down);up.type=down.type='button';up.textContent='↑';down.textContent='↓';up.setAttribute('aria-label',(koreanLabels[id]??id)+' 위로');down.setAttribute('aria-label',(koreanLabels[id]??id)+' 아래로');row={node,box,up,down};choices.set(id,row);
   box.onchange=()=>changed(()=>{const next=new Set(selected);box.checked?next.add(id):next.delete(id);toolbar.setOptions({tools:ordered.filter(value=>next.has(value))});selected=next;renderChoices();},'도구 구성을 적용했습니다.');
   const move=delta=>changed(()=>{const at=ordered.indexOf(id),to=at+delta;if(at<0||to<0||to>=ordered.length)return;const next=[...ordered];[next[at],next[to]]=[next[to],next[at]];toolbar.setOptions({tools:next.filter(value=>selected.has(value))});ordered=next;renderChoices();},'도구 순서를 적용했습니다.');
   up.onclick=()=>move(-1);down.onclick=()=>move(1);
  }
  row.box.checked=selected.has(id);row.up.disabled=ordered.indexOf(id)===0;row.down.disabled=ordered.indexOf(id)===ordered.length-1;
  const at=ordered.indexOf(id);if(host.children[at]!==row.node)host.insertBefore(row.node,host.children[at]??null);
 }
 if(focused&&host.contains(focused)&&(document.activeElement===null||document.activeElement===document.body))focused.focus();
}
function syncToolbar(){
 const options=toolbar.options,placement=$('placement').value;
 $('density').value=options.density;root.dataset.density=options.density;$('placement').value=placement;root.dataset.placement=placement;
 selected=new Set(options.tools);ordered=[...options.tools,...ordered.filter(id=>!selected.has(id))];renderChoices();
 $('tool-set').value='custom';
 $('toolbar-summary').textContent=(placement==='top'?'위쪽':placement==='right'?'오른쪽':'왼쪽')+' · '+(options.density==='compact'?'촘촘하게':'편안하게');
}
function placementOrientation(value){return value==='top'?'horizontal':'vertical';}
$('placement').onchange=()=>changed(()=>{guard();const placement=$('placement').value;toolbar.setOptions({orientation:placementOrientation(placement)});root.dataset.placement=placement;chart.resize();syncToolbar();},'도구 모음 위치를 적용했습니다.');
$('density').onchange=()=>changed(()=>{guard();toolbar.setOptions({density:$('density').value});root.dataset.density=$('density').value;syncToolbar();},'도구 모음 간격을 적용했습니다.');
$('tool-set').onchange=()=>changed(()=>{guard();const value=$('tool-set').value,ids=value==='all'?['select',...DRAWING_TYPES]:value==='analysis'?['select','trendline','fibonacci','longposition','shortposition','measurement']:['select','trendline','horizontal','rectangle'];toolbar.setOptions({tools:ids});selected=new Set(ids);ordered=[...ids,...ordered.filter(id=>!selected.has(id))];renderChoices();},'도구 구성을 적용했습니다.');

for(const key of ['pointer','wheelZoom','keyboardShortcuts'])$(key).onchange=()=>changed(()=>{live();chart.setInteractionOptions({[key]:$(key).checked});syncInput();},'입력 설정을 적용했습니다.');
$('hitTolerancePx').onchange=()=>changed(()=>{const node=$('hitTolerancePx'),value=Number(node.value);if(!Number.isFinite(value)||value<1||value>32)throw new RangeError('선택 허용 거리: 1..32');chart.setInteractionOptions({hitTolerancePx:value});syncInput();},'선택 허용 거리를 적용했습니다.');
function syncInput(){const options=chart.interactionOptions;for(const key of ['pointer','wheelZoom','keyboardShortcuts'])$(key).checked=options[key];$('hitTolerancePx').value=String(options.hitTolerancePx);$('input-summary').textContent=[options.pointer&&'포인터',options.wheelZoom&&'휠',options.keyboardShortcuts&&'단축키'].filter(Boolean).join(' · ')||'입력 꺼짐';}
$('device-preset').onchange=()=>{const value=$('device-preset').value;try{if(!value)return;changed(()=>{guard();const preset=createChartUIPreset(value);chart.setInteractionOptions(preset.interaction);if(preset.toolbar){toolbar.setOptions(preset.toolbar);const placement=preset.toolbar.orientation==='horizontal'?'top':'left';$('placement').value=placement;root.dataset.placement=placement;}syncAll();},value==='mobile'?'모바일 입력 프리셋을 적용했습니다.':'데스크톱 입력 프리셋을 적용했습니다.');}catch(error){report(error);}finally{$('device-preset').value='';}};

for(const id of ['price','volume'])$(id+'-weight').onchange=()=>changed(()=>{const node=$(id+'-weight'),weight=Number(node.value);if(!Number.isFinite(weight)||weight<.5||weight>8)throw new RangeError('패널 비중: 0.5..8');chart.api.setPanel(id,{weight});syncLayout();},'패널 비중을 적용했습니다.');
$('axis-side').onchange=()=>changed(()=>{guard();chart.api.setPanel('price',{axisSide:$('axis-side').value});syncLayout();},'가격 축 위치를 적용했습니다.');
function syncLayout(){const price=model.panels.find(panel=>panel.id==='price'),volume=model.panels.find(panel=>panel.id==='volume');$('price-weight').value=String(price.weight);$('volume-weight').value=String(volume.weight);$('axis-side').value=price.axisSide??'right';$('layout-summary').textContent='가격 '+price.weight+' · 거래량 '+volume.weight;}

let demoOverlays=null,overlayHost=null,demoNavigator=null,demoTradeMarkers=null,tradeMarkerHost=null;
function setOverlays(enabled){
 if(!enabled){demoOverlays?.destroy();demoOverlays=null;overlayHost?.remove();overlayHost=null;return;}
 if(demoOverlays)return;const host=document.createElement('div');host.className='customization-overlay-host';$('customization-chart').append(host);let overlays;
 try{overlays=attachChartOverlays(host,chart);const note=document.createElement('span'),fit=document.createElement('button');note.textContent='Synthetic OHLCV · host overlay';fit.type='button';fit.textContent='Fit view';fit.onclick=()=>{if(!chart.disposed)chart.api.fit();};overlays.slots.topLeft.append(note);overlays.slots.topRight.append(fit);demoOverlays=overlays;overlayHost=host;}catch(error){overlays?.destroy();host.remove();throw error;}
}
function setNavigator(enabled){if(!enabled){demoNavigator?.destroy();demoNavigator=null;return;}if(!demoNavigator)demoNavigator=attachChartNavigator($('customization-navigator'),chart);}
function setTradeMarkers(enabled){
 if(!enabled){demoTradeMarkers?.destroy();demoTradeMarkers=null;tradeMarkerHost?.remove();tradeMarkerHost=null;return;}
 if(demoTradeMarkers)return;const host=document.createElement('div');host.className='customization-overlay-host';$('customization-chart').append(host);
 try{demoTradeMarkers=attachTradeMarkers(host,chart,{markers:[430,480].map((index,i)=>({id:'example-fill-'+i,tradeID:'synthetic-trade-1',time:model.store.at(index).time,price:model.store.at(index).close,panel:'price',side:i?'sell':'buy',label:'Example fill '+(i+1)})),onSelect:marker=>announceDraft('호스트 선택 콜백: '+marker.tradeID+' / '+marker.id+' (표시 예시)')});tradeMarkerHost=host;}catch(error){demoTradeMarkers?.destroy();demoTradeMarkers=null;host.remove();throw error;}
}
function syncExtrasControls(extras={navigator:!!demoNavigator,overlays:!!demoOverlays,tradeMarkers:!!demoTradeMarkers}){$('show-navigator').checked=!!extras.navigator;$('show-overlays').checked=!!extras.overlays;$('show-trade-markers').checked=!!extras.tradeMarkers;$('extras-summary').textContent=[extras.navigator&&'navigator',extras.overlays&&'overlay',extras.tradeMarkers&&'markers'].filter(Boolean).join(' · ')||'표시 없음';}
function setExtras(extras){setNavigator(!!extras.navigator);setOverlays(!!extras.overlays);setTradeMarkers(!!extras.tradeMarkers);syncExtrasControls();}
for(const[id,key,label]of[['show-navigator','navigator','navigator 표시를'],['show-overlays','overlays','overlay 표시를'],['show-trade-markers','tradeMarkers','tradeID 마커를']])$(id).onchange=()=>changed(()=>{guard();const extras={navigator:$('show-navigator').checked,overlays:$('show-overlays').checked,tradeMarkers:$('show-trade-markers').checked};setExtras(extras);},label+' 적용했습니다.');

function profileConfig(){
 const price=model.panels.find(panel=>panel.id==='price'),volume=model.panels.find(panel=>panel.id==='volume');
 return {theme:{...model.theme},layout:{priceWeight:price.weight,volumeWeight:volume.weight,axisSide:price.axisSide??'right',placement:$('placement').value},ui:{interaction:{...chart.interactionOptions},toolbar:toolbar.options},extras:{navigator:$('show-navigator').checked,overlays:$('show-overlays').checked,tradeMarkers:$('show-trade-markers').checked}};
}
function profileText(){return saveCustomizationProfile(profileConfig());}
function applyProfile(profile,{state=null,message='저장한 프로필을 적용했습니다.',mark=true,invalidate=true,announce=true}={}){
 guard();if(!profile?.ui?.toolbar)throw new TypeError('프로필 도구 모음 설정이 필요합니다.');
 if(invalidate)invalidatePending();
 const theme={...profile.theme},layout={...profile.layout},interaction={...profile.ui.interaction},toolbarOptions={...profile.ui.toolbar};toolbarOptions.orientation=placementOrientation(layout.placement);
 chart.api.setTheme(theme);chart.setInteractionOptions(interaction);chart.api.setPanel('price',{weight:layout.priceWeight,axisSide:layout.axisSide});chart.api.setPanel('volume',{weight:layout.volumeWeight});$('placement').value=layout.placement;root.dataset.placement=layout.placement;toolbar.setOptions(toolbarOptions);root.dataset.density=toolbarOptions.density;setExtras(profile.extras);syncAll();if(mark)draftRevision++;if(announce)status(message,state??currentDraftState());
}
function syncSummaries(){syncActualControls();}
function syncAll(){syncActualControls();}

function storage(){if(!window.localStorage)throw new Error('브라우저 로컬 저장소를 사용할 수 없습니다.');return window.localStorage;}
$('save-ui').onclick=()=>{
 try{guard();invalidatePending();const text=profileText();storage().setItem(NEW_STORAGE_KEY,text);savedBaselineText=text;$('profile-json').value=text;status('전체 프로필을 이 브라우저에 저장했습니다.','saved');}
 catch(error){report(error);}
};
function applyLegacy(ui,{invalidate=true}={}){
 guard();if(invalidate)invalidatePending();if(ui.toolbar===null)throw new Error('이전 UI 저장에는 도구 모음 설정이 없습니다.');chart.setInteractionOptions(ui.interaction);toolbar.setOptions(ui.toolbar);const placement=ui.toolbar.orientation==='horizontal'?'top':$('placement').value==='right'?'right':'left';$('placement').value=placement;root.dataset.placement=placement;root.dataset.density=ui.toolbar.density;syncAll();announceDraft('이전 UI 저장을 적용했습니다. 외관·레이아웃·표시 옵션은 포함되지 않았습니다.');
}
$('load-ui').onclick=()=>{
 try{guard();invalidatePending();const store=storage(),text=store.getItem(NEW_STORAGE_KEY);if(text!==null){const profile=readCustomizationProfile(text),canonical=saveCustomizationProfile(profile);applyProfile(profile,{message:'저장한 전체 프로필을 적용했습니다.',mark:false,invalidate:false,announce:false});savedBaselineText=canonical;$('profile-json').value=text;status('저장한 전체 프로필을 적용했습니다.',currentDraftState());return;}const legacy=store.getItem(LEGACY_STORAGE_KEY);if(legacy===null)throw new Error('저장된 프로필이 없습니다.');const ui=readChartUI(legacy);applyLegacy(ui,{invalidate:false});}
 catch(error){report(error);}
};

function importText(text,{generation=null,startedDraft=null,message='가져온 프로필을 적용했습니다.',invalidate=true}={}){
 if(generation!==null&&(generation!==fileGeneration||startedDraft!==draftRevision))return false;
 if(typeof text!=='string'||text.length>MAX_FILE_CHARS)throw new RangeError('가져오기 파일은 64KiB 이하이어야 합니다.');
 if(text.length>PROFILE_TEXT_CHARS)throw new RangeError('파일은 64KiB 이하, 프로필 본문은 16,384자 이하이어야 합니다.');
 const profile=readCustomizationProfile(text);
 if(generation!==null&&(generation!==fileGeneration||startedDraft!==draftRevision))return false;
 applyProfile(profile,{message,mark:true,invalidate});$('profile-json').value=text;return true;
}
$('export-profile').onclick=()=>{try{guard();const text=profileText();$('profile-json').value=text;announceDraft('현재 프로필 JSON을 채웠습니다.');}catch(error){report(error);}};
$('import-profile').onclick=()=>{try{guard();invalidatePending();importText($('profile-json').value,{invalidate:false});}catch(error){report(error);}};
$('profile-json').oninput=()=>{fileGeneration++;statusGeneration++;};
$('copy-profile').onclick=async()=>{const generation=statusGeneration;try{const text=$('profile-json').value;if(!text)throw new Error('먼저 JSON을 채우거나 붙여 넣으세요.');const clipboard=globalThis.navigator?.clipboard;if(!clipboard?.writeText)throw new Error('클립보드 API를 사용할 수 없습니다.');await clipboard.writeText(text);if(chart.disposed||statusGeneration!==generation)return;announceDraft('프로필 JSON을 클립보드에 복사했습니다.');}catch(error){if(!chart.disposed&&statusGeneration===generation)report(error);}};
$('download-profile').onclick=()=>{try{const text=$('profile-json').value;if(!text)throw new Error('먼저 JSON을 채우거나 붙여 넣으세요.');if(typeof Blob==='undefined'||!globalThis.URL?.createObjectURL)throw new Error('파일 저장 API를 사용할 수 없습니다.');const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='barochart-customization-profile.json';link.click();URL.revokeObjectURL(url);announceDraft('프로필 JSON 파일을 만들었습니다.');}catch(error){report(error);}};
$('profile-file').onchange=event=>{const input=event.target,file=input?.files?.[0];if(!file)return;const generation=++fileGeneration,startedDraft=draftRevision;input.value='';(async()=>{try{if(file.size>MAX_FILE_CHARS)throw new RangeError('가져오기 파일은 64KiB 이하이어야 합니다.');const text=await file.text();if(generation!==fileGeneration||startedDraft!==draftRevision||chart.disposed)return;importText(text,{generation,startedDraft,message:'파일에서 프로필을 적용했습니다.'});}catch(error){if(generation===fileGeneration&&!chart.disposed)report(error);}finally{if(generation===fileGeneration)input.value='';}})();};
$('reset-profile').onclick=()=>{try{guard();invalidatePending();const defaults=readCustomizationProfile(defaultProfileText);applyProfile(defaults,{message:'현재 초안을 기본값으로 초기화했습니다.',mark:true,invalidate:false});}catch(error){report(error);}};

renderChoices();syncAll();defaultProfileText=saveCustomizationProfile(profileConfig());status('설정을 바꿔 차트를 맞춤 구성하세요.','ready');
window.customizationStudio={chart,model,toolbar,ready:true,actions:{save:()=>$('save-ui').click(),load:()=>$('load-ui').click(),reset:()=>$('reset-profile').click(),export:()=>$('export-profile').click(),import:text=>{ $('profile-json').value=text;$('import-profile').click(); }}};
window.addEventListener('pagehide',event=>{if(!event.persisted)chart.destroy({disposeModel:true});});
window.addEventListener('pageshow',event=>{if(event.persisted&&!chart.disposed){chart.resize();syncAll();}});
