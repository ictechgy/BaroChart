import {ChartModel,CanvasChart,attachChartToolbar,DARK_THEME,LIGHT_THEME,DRAWING_TYPES,seededColumns,saveChartUI,readChartUI,createChartUIPreset,attachChartOverlays,attachChartNavigator,attachTradeMarkers} from '../../src/index.mjs';
const $=id=>document.getElementById(id),root=$('customization-demo');
const model=new ChartModel({panels:[{id:'price',weight:3.5},{id:'volume',weight:1,precision:0}]});
model.store.setColumns(seededColumns(512));model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume',color:'#4c8cad'});
const chart=new CanvasChart($('customization-chart'),model),toolbar=attachChartToolbar($('customization-toolbar'),chart,{orientation:'vertical'});
const status=text=>{$('customization-status').textContent=text;},report=error=>status('설정 처리 중 오류입니다. 현재 반영 상태를 확인하세요: '+String(error.message).slice(0,180));
function action(fn){return()=>{try{fn();status('설정을 적용했습니다. 새로고침하면 초기화됩니다.');}catch(error){report(error);}};}
const colors=new Map();
for(const[key,name]of Object.entries({background:'배경',grid:'격자',text:'축 글자',up:'상승',down:'하락',crosshair:'십자선'})){
 const label=document.createElement('label'),input=document.createElement('input');input.type='color';input.value=DARK_THEME[key];label.append(document.createTextNode(name+' '),input);$('colors').append(label);colors.set(key,input);
 input.addEventListener('change',action(()=>chart.api.setTheme({[key]:input.value})));
}
function syncAppearance(){for(const[key,input]of colors)input.value=model.theme[key].slice(0,7);$('font-size').value=String(parseFloat(model.theme.font));}
function preset(){const theme=$('preset').value==='light'?LIGHT_THEME:DARK_THEME;chart.api.setTheme(theme);root.dataset.theme=$('preset').value;syncAppearance();}
$('preset').onchange=action(preset);$('reset-appearance').onclick=action(()=>{$('preset').value='dark';preset();});
$('font-size').onchange=action(()=>chart.api.setTheme({font:Number($('font-size').value)+'px monospace'}));
$('placement').onchange=action(()=>{const placement=$('placement').value;toolbar.setOptions({orientation:placement==='top'?'horizontal':'vertical'});root.dataset.placement=placement;chart.resize();});
$('density').onchange=action(()=>{toolbar.setOptions({density:$('density').value});root.dataset.density=$('density').value;});
for(const key of ['pointer','wheelZoom','keyboardShortcuts'])$(key).onchange=action(()=>chart.setInteractionOptions({[key]:$(key).checked}));
$('hitTolerancePx').onchange=()=>{try{chart.setInteractionOptions({hitTolerancePx:Number($('hitTolerancePx').value)});status('선택 허용 거리를 적용했습니다.');}catch(error){$('hitTolerancePx').value=String(chart.interactionOptions.hitTolerancePx);report(error);}};
for(const id of ['price','volume'])$(id+'-weight').onchange=()=>{const node=$(id+'-weight');try{const weight=Number(node.value);if(!Number.isFinite(weight)||weight<.5||weight>8)throw new RangeError('패널 비중: 0.5..8');chart.api.setPanel(id,{weight});status('패널 비중을 적용했습니다.');}catch(error){node.value=String(model.panels.find(p=>p.id===id).weight);report(error);}};
$('axis-side').onchange=()=>{try{chart.api.setPanel('price',{axisSide:$('axis-side').value});status('가격 축 위치를 적용했습니다.');}catch(error){$('axis-side').value=model.panels.find(p=>p.id==='price').axisSide??'right';report(error);}};
let ordered=['select',...DRAWING_TYPES];const selected=new Set(toolbar.snapshot().tools),choices=new Map();
function renderChoices(){
 const focused=document.activeElement;
 for(const id of ordered){let row=choices.get(id);if(!row){const box=document.createElement('input'),label=document.createElement('label'),node=document.createElement('div'),up=document.createElement('button'),down=document.createElement('button');node.className='tool-choice';box.type='checkbox';box.disabled=id==='select';label.append(box,document.createTextNode(id));up.type=down.type='button';up.textContent='↑';down.textContent='↓';up.setAttribute('aria-label',id+' 위로');down.setAttribute('aria-label',id+' 아래로');node.append(label,up,down);row={node,box,up,down};choices.set(id,row);
 box.onchange=action(()=>{const next=new Set(selected);box.checked?next.add(id):next.delete(id);toolbar.setOptions({tools:ordered.filter(x=>next.has(x))});selected.clear();for(const value of next)selected.add(value);});
 const move=delta=>action(()=>{const at=ordered.indexOf(id),to=at+delta;if(to<0||to>=ordered.length)return;const next=[...ordered];[next[at],next[to]]=[next[to],next[at]];toolbar.setOptions({tools:next.filter(x=>selected.has(x))});ordered=next;renderChoices();});up.onclick=move(-1);down.onclick=move(1);
 }row.box.checked=selected.has(id);row.up.disabled=ordered.indexOf(id)===0;row.down.disabled=ordered.indexOf(id)===ordered.length-1;const at=ordered.indexOf(id);if($('tool-choices').children[at]!==row.node)$('tool-choices').insertBefore(row.node,$('tool-choices').children[at]??null);}
 if(focused&&$('tool-choices').contains(focused)&&(document.activeElement===document.body||document.activeElement===null)){if(focused.disabled){const row=[...choices.values()].find(row=>row.node.contains(focused));[row?.box,row?.up,row?.down].find(node=>node&&!node.disabled)?.focus();}else focused.focus();}
}
$('tool-set').onchange=action(()=>{const ids=$('tool-set').value==='all'?['select',...DRAWING_TYPES]:$('tool-set').value==='analysis'?['select','trendline','fibonacci','longposition','shortposition','measurement']:['select','trendline','horizontal','rectangle'];toolbar.setOptions({tools:ids});selected.clear();for(const id of ids)selected.add(id);ordered=[...ids,...ordered.filter(id=>!selected.has(id))];renderChoices();});
const uiStorageKey='barochart.customization.web-ui.v1';
$('save-ui').onclick=()=>{try{
 if(chart.disposed)throw new Error('Chart disposed');
 const text=saveChartUI({interaction:chart.interactionOptions,toolbar:toolbar.options});
 window.localStorage.setItem(uiStorageKey,text);
 status('입력·도구 모음 설정을 이 브라우저에 저장했습니다. 차트 데이터·색상·패널·위치는 저장하지 않습니다.');
}catch(error){report(error);}};
function applyUI(ui){
 if(chart.disposed)throw new Error('Chart disposed');
 if(chart.controller.gesture||chart.controller.pointers.size||model.drawings.transaction)throw new Error('진행 중인 입력을 완료하거나 취소한 뒤 불러오세요.');if(ui.toolbar===null)throw new Error('이 데모는 도구 모음 설정이 필요합니다.');
 chart.setInteractionOptions(ui.interaction);if(chart.disposed)throw new Error('Chart disposed during UI application');
 toolbar.setOptions(ui.toolbar);if(chart.disposed)throw new Error('Chart disposed during UI application');
 for(const key of ['pointer','wheelZoom','keyboardShortcuts'])$(key).checked=chart.interactionOptions[key];
 $('hitTolerancePx').value=String(chart.interactionOptions.hitTolerancePx);
 const applied=toolbar.options;$('density').value=applied.density;root.dataset.density=applied.density;
 const placement=applied.orientation==='horizontal'?'top':$('placement').value==='right'?'right':'left';
 $('placement').value=placement;root.dataset.placement=placement;
 selected.clear();for(const id of applied.tools)selected.add(id);ordered=[...applied.tools,...ordered.filter(id=>!selected.has(id))];
 $('tool-set').value='custom';renderChoices();chart.resize();
 }
$('load-ui').onclick=()=>{try{
 if(chart.disposed)throw new Error('Chart disposed');
 const text=window.localStorage.getItem(uiStorageKey);if(text===null)throw new Error('저장된 UI 설정이 없습니다.');
 applyUI(readChartUI(text));status('저장한 입력·도구 모음 설정을 적용했습니다.');
}catch(error){report(error);}};
$('device-preset').onchange=()=>{try{applyUI(createChartUIPreset($('device-preset').value));status('선택한 기기용 입력·도구 모음을 적용했습니다. 자동 기기 감지는 하지 않습니다.');}catch(error){report(error);}finally{$('device-preset').value='';}};
let demoOverlays=null,overlayHost=null;
$('show-overlays').onchange=action(()=>{
 if(chart.disposed)throw new Error('Chart disposed');
 if(!$('show-overlays').checked){demoOverlays?.destroy();demoOverlays=null;overlayHost?.remove();overlayHost=null;return;}
 if(demoOverlays)return;
 const host=document.createElement('div');host.className='customization-overlay-host';$('customization-chart').append(host);
 let overlays;try{
  overlays=attachChartOverlays(host,chart);const note=document.createElement('span'),fit=document.createElement('button');
  note.textContent='Synthetic OHLCV · host overlay';fit.type='button';fit.textContent='Fit view';fit.onclick=()=>{if(!chart.disposed)chart.api.fit();};
  overlays.slots.topLeft.append(note);overlays.slots.topRight.append(fit);demoOverlays=overlays;overlayHost=host;
 }catch(error){overlays?.destroy();host.remove();$('show-overlays').checked=false;throw error;}
});
let demoNavigator=null;
$('show-navigator').onchange=action(()=>{
 if(chart.disposed)throw new Error('Chart disposed');
 if(!$('show-navigator').checked){demoNavigator?.destroy();demoNavigator=null;return;}
 if(!demoNavigator)try{demoNavigator=attachChartNavigator($('customization-navigator'),chart);}catch(error){$('show-navigator').checked=false;throw error;}
});
let demoTradeMarkers=null,tradeMarkerHost=null;
$('show-trade-markers').onchange=action(()=>{
 if(chart.disposed)throw new Error('Chart disposed');
 if(!$('show-trade-markers').checked){demoTradeMarkers?.destroy();demoTradeMarkers=null;tradeMarkerHost?.remove();tradeMarkerHost=null;return;}
 if(demoTradeMarkers)return;const host=document.createElement('div');host.className='customization-overlay-host';$('customization-chart').append(host);
 try{demoTradeMarkers=attachTradeMarkers(host,chart,{markers:[430,480].map((index,i)=>({id:'example-fill-'+i,tradeID:'synthetic-trade-1',time:model.store.at(index).time,price:model.store.at(index).close,panel:'price',side:i?'sell':'buy',label:'Example fill '+(i+1)})),onSelect:marker=>status('호스트 선택 콜백: '+marker.tradeID+' / '+marker.id+' (표시 예시, 주문 실행 아님)')});tradeMarkerHost=host;}
 catch(error){demoTradeMarkers?.destroy();demoTradeMarkers=null;host.remove();$('show-trade-markers').checked=false;throw error;}
});
renderChoices();syncAppearance();status('설정을 바꿔 차트를 맞춤 구성하세요.');
window.addEventListener('pagehide',event=>{if(!event.persisted)chart.destroy({disposeModel:true});});window.addEventListener('pageshow',event=>{if(event.persisted&&!chart.disposed)chart.resize();});
