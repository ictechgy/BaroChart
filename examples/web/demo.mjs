import {drawingImportMessage} from './import-errors.mjs';
import {createDrawingFileImport} from './drawing-file-import.mjs';
import {createChart,DARK_THEME,LIGHT_THEME,builtinIndicators,DEMO_SYMBOLS,formatPrice,zonedParts,demoCalendar} from '../../src/index.mjs';
import {prepareChartModel} from '../../src/web/worker.mjs';
import {modelRequest} from '../../src/web/worker-state.mjs';
const $=id=>document.getElementById(id);let chart,model,timer,extras=[],serial=0,job=0,controller,loadedMarket,loadedCount,streamIntent=false,light=false,preparing=false;
const journals=new Map();
let pageActive=true,pageClosed=false,resumeInitial=false;
const dataExplorer=()=>({readout:$('explorer-readout'),live:$('explorer-live'),controls:[$('explore'),$('explore-read')]});
const status=message=>{if($('status').textContent!==message)$('status').textContent=message;};
const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
function friendly(error,file=false){if(file)return drawingImportMessage(error);if(/positive|Log scale/.test(error.message))return '로그 축은 양수 범위만 표시할 수 있습니다. 선형 축 또는 양수 범위를 사용하세요.';if(error.name==='AbortError')return model&&!model.disposed?'계산을 취소했습니다. 이전 차트는 유지됩니다.':'첫 차트 계산을 취소했습니다. 시장이나 저장 봉 수를 선택해 다시 시작하세요.';return '변경을 적용하지 못했습니다: '+String(error.message).slice(0,180);}
const drawingFileImport=createDrawingFileImport({getChart:()=>preparing?null:chart,onStatus:status,onError:(error,{changed})=>status(changed?'도형은 반영됐지만 화면 갱신 중 오류가 발생했습니다. 다시 불러오기 전에 현재 상태를 확인하세요.':friendly(error,true))});
function stopStream(){clearInterval(timer);timer=null;$('stream').setAttribute('aria-pressed','false');$('stream').textContent='▶ 합성 스트림';}
function sync(){if(!model||!chart||chart.disposed)return;$('explore').setAttribute('aria-pressed',String(chart.dataExploration?.active??false));const d=model.drawings.items.find(d=>d.id===model.drawings.selected);$('undo').disabled=!model.drawings.undoStack.length&&!chart.controller.gesture;$('redo').disabled=!model.drawings.redoStack.length;$('delete').disabled=!d||d.locked;$('lock').disabled=!d;$('lock').textContent=d?.locked?'잠금 해제':'잠금';
 setText('selection',d?'선택: '+d.type+' · '+(d.locked?'잠김':'편집 가능'):'선택된 도형 없음');chart.canvas.style.cursor=chart.controller.tool==='select'?(chart.controller.gesture?.kind==='pan'?'grabbing':'grab'):chart.controller.tool==='text'?'text':'crosshair';
 const b=model.store.length?model.store.at(model.store.length-1):null;setText('last-time',b?model.timeFormatter(b.time):'데이터 없음');for(const k of ['open','high','low','close'])setText('last-'+k,b?formatPrice(b[k],model.symbol):'—');setText('last-volume',b?(Object.is(b.volume,-0)?'-0':String(b.volume)):'—');
}
function busy(value){preparing=value;if(value)drawingFileImport.cancel();$('cancel-compute').hidden=!value;$('workspace').setAttribute('aria-busy',String(value));for(const id of ['add-indicator','clear-indicators','series','scale','renderer','stream','load'])$(id).disabled=value||!model||!chart||chart.disposed;const ready=!!model&&!model.disposed&&!!chart&&!chart.disposed;for(const id of ['fit','recent','save','explore','explore-read'])$(id).disabled=!ready;for(const node of document.querySelectorAll('[data-tool]'))node.disabled=!ready;}
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
function install(next,market,count,newExtras=extras){drawingFileImport.cancel();const same=market===loadedMarket,oldModel=model,oldChart=chart;if(oldModel)journals.set(loadedMarket,oldModel.drawings);if(journals.has(market))next.drawings=journals.get(market);
 const symbol=DEMO_SYMBOLS[market];next.symbol=symbol;next.priceFormatter=v=>formatPrice(v,symbol);next.timeFormatter=t=>{const p=zonedParts(t,symbol.timezone);return p.month+'/'+p.day+' '+p.hour+':'+p.minute;};
 if(same&&oldModel){const span=oldModel.view.to-oldModel.view.from;next.setVisibleRange(oldModel.follow?next.store.length-span-.5:oldModel.view.from,oldModel.follow?next.store.length-.5:oldModel.view.to);}
 const host=document.createElement('div');host.style='width:100%;height:100%';let created;
 try{created=createChart(host,next,{renderer:$('renderer').value,dataExplorer:dataExplorer(),onError:error=>status(friendly(error)),onFallback:reason=>status('GPU를 사용할 수 없어 Canvas로 전환했습니다. '+reason.slice(0,80))});}catch(error){next.dispose();throw error;}
 oldChart?.destroy({disposeModel:true});$('chart').replaceChildren(host);model=next;chart=created;extras=newExtras;loadedMarket=market;loadedCount=count;streamCalendar=demoCalendar(market);palette();chart.setTool(document.querySelector('[data-tool][aria-pressed="true"]').dataset.tool);chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});chart.api.setDrawingMagnet({mode:$('magnet').value});chart.controller.text=$('annotation').value;chart.canvas.setAttribute('aria-describedby','keyboard-help exploration-help selection data-summary');host.addEventListener('aster:exploration',()=>{$('explore').setAttribute('aria-pressed',String(chart.dataExploration.active));});host.addEventListener('aster:render',sync);host.addEventListener('aster:state',sync);window.aster={model,chart};setText('symbol',symbol.id);setText('meta',symbol.currency+' · '+symbol.timezone+' · '+symbol.volumeUnit);layoutPanels();chart.invalidate();sync();
}
async function load(){if(!pageActive||pageClosed)return;const token=++job;controller?.abort();controller=new AbortController();stopStream();busy(true);const market=$('market').value,count=Number($('count').value),same=market===loadedMarket;const options=same&&model?modelRequest(model):defaults(market);
 try{const next=await prepareChartModel({market,count,options},{workerURL:new URL('./model-worker.mjs',import.meta.url),signal:controller.signal,onProgress:p=>{if(token===job&&pageActive&&!pageClosed)progress(p);}});if(token!==job){next.dispose();return;}install(next,market,count,same?extras:[]);if(!same)$('scale').value='linear';status('계산 완료 · 원본/지표는 worker에서 준비합니다. 키보드 안내와 데이터 요약을 확인하세요.');}
 catch(error){if(token===job){status(friendly(error));if(loadedMarket){$('market').value=loadedMarket;$('count').value=String(loadedCount);}}}finally{if(token===job){busy(false);if(streamIntent&&!document.hidden)startStream();}}
}
async function addIndicator(){if(!model||!pageActive||pageClosed)return;const token=++job;controller?.abort();controller=new AbortController();stopStream();busy(true);const version=model.store.version,options=modelRequest(model),name=$('indicator').value,id='extra-'+(++serial),overlay=['sma','vwma','ema','wma','bollinger','donchian','vwap','dema','tema','hma','keltner','supertrend','ichimoku','pivots','parabolicSAR'].includes(name),panel=overlay?'price':id;
 try{const def=builtinIndicators.get(name)({});options.indicators.push({id,name,params:{}});if(!overlay)options.panels.push({id,label:name.toUpperCase(),weight:1});for(const output of def.outputs.filter(x=>x!=='direction'))options.series.push({id:id+'-'+output,type:output==='histogram'?'histogram':'line',panel,indicator:id,output,color:'#aa91f7'});
 const next=await prepareChartModel({columns:Object.fromEntries(Object.entries(model.store.columns).map(([k,a])=>[k,a.subarray(0,model.store.length)])),length:model.store.length,options},{signal:controller.signal,onProgress:p=>{if(token===job&&pageActive&&!pageClosed)progress(p);}});if(token!==job||version!==model.store.version){next.dispose();throw new Error('Data changed; prepared result discarded');}install(next,loadedMarket,loadedCount,[...extras,{id,panel}]);status('지표를 추가했습니다.');}
 catch(error){if(token===job)status(friendly(error));}finally{if(token===job){busy(false);if(streamIntent&&!document.hidden)startStream();}}
}
for(const name of builtinIndicators.keys()){const option=document.createElement('option');option.value=name;option.textContent=name.toUpperCase();$('indicator').append(option);}
$('market').onchange=load;$('count').onchange=load;$('cancel-compute').onclick=()=>controller?.abort();$('fit').onclick=()=>chart?.api.fit();$('recent').onclick=()=>chart?.api.setVisibleRange(model.store.length-200.5,model.store.length-.5);
$('series').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;const s=model.series.find(s=>s.id==='price'),old=s.type;try{chart.api.setSeries('price',{type:$('series').value});palette();chart.drawNow();}catch(error){chart.api.setSeries('price',{type:old});$('series').value=old;status(friendly(error));}chart.invalidate();};
$('scale').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;const old=model.panels.find(p=>p.id==='price').scale;try{chart.api.setPanel('price',{scale:$('scale').value});chart.drawNow();}catch(error){chart.api.setPanel('price',{scale:old});$('scale').value=old;status(friendly(error));}chart.invalidate();};
$('explore').onclick=()=>{if(!chart)return;try{chart.setDataExploration(!chart.dataExploration.active);$('explore').setAttribute('aria-pressed',String(chart.dataExploration.active));chart.canvas.focus({preventScroll:true});}catch(error){status(friendly(error));}};
$('explore-read').onclick=()=>{if(!chart)return;try{chart.readExploration();}catch(error){status(friendly(error));}};
$('renderer').onchange=()=>{if(!model||!chart||chart.disposed||preparing)return;drawingFileImport.cancel();const tool=chart.controller.tool;chart.destroy();chart=createChart(chart.container,model,{renderer:$('renderer').value,dataExplorer:dataExplorer(),onError:error=>status(friendly(error))});chart.setTool(tool);chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});chart.api.setDrawingMagnet({mode:$('magnet').value});chart.controller.text=$('annotation').value;chart.canvas.setAttribute('aria-describedby','keyboard-help exploration-help selection data-summary');window.aster={model,chart};chart.invalidate();sync();};
$('theme').onclick=()=>{light=!light;palette();chart?.invalidate();};
for(const b of document.querySelectorAll('[data-tool]')){b.setAttribute('aria-pressed',String(b.dataset.tool==='select'));b.onclick=()=>{if(!chart)return;chart.setTool(b.dataset.tool);for(const x of document.querySelectorAll('[data-tool]'))x.setAttribute('aria-pressed',String(x===b));status('도구: '+b.title+' · '+(['channel','fibextension'].includes(b.dataset.tool)?'드래그 후 세 번째 핸들을 편집하세요.':'Esc로 취소할 수 있습니다.'));chart.canvas.focus({preventScroll:true});};}
$('crosshair-snap').onchange=()=>{if(chart)chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});status('십자선: '+$('crosshair-snap').selectedOptions[0].textContent+' · 포인터만 적용하며 도형 자석과 별개입니다.');};
$('magnet').onchange=()=>{if(chart)chart.api.setDrawingMagnet({mode:$('magnet').value});status('자석: '+$('magnet').selectedOptions[0].textContent+' · 보이는 OHLC 봉의 새 앵커·개별 핸들에 적용합니다.');};
$('annotation').oninput=()=>{if(chart)chart.api.setText($('annotation').value);};$('undo').onclick=()=>chart?.api.undo();$('redo').onclick=()=>chart?.api.redo();$('delete').onclick=()=>chart?.api.deleteDrawing();$('lock').onclick=()=>{if(!model||!chart||chart.disposed)return;const d=model.drawings.items.find(d=>d.id===model.drawings.selected);if(d)chart.api.editDrawing(d.id,{locked:!d.locked});};
$('save').onclick=()=>{if(!model||!chart||chart.disposed)return;try{const url=URL.createObjectURL(new Blob([chart.api.saveDrawings()],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='aster-drawings.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('도형을 저장했습니다.');}catch(error){status(friendly(error));}};
$('load').onclick=()=>{if(!model||!chart||chart.disposed||preparing)return;drawingFileImport.cancel();$('file').click();};$('file').onchange=async e=>{const file=e.target.files[0];e.target.value='';await drawingFileImport.read(file);};
$('add-indicator').onclick=addIndicator;$('clear-indicators').onclick=()=>{if(!model||!chart||chart.disposed||preparing)return;for(const x of extras){chart.api.removeIndicator(x.id);if(x.panel!=='price'){if(model.drawings.items.some(d=>d.panel===x.panel)){const previous=chart.lastScene.layout.panels.find(p=>p.id===x.panel);if(previous)model.setPanel(x.panel,{range:[previous.min,previous.max],label:x.id+' · 도형 유지'});status('지표는 제거했고 도형이 있는 패널과 축은 유지했습니다.');}else model.panels=model.panels.filter(p=>p.id!==x.panel);}}extras=[];layoutPanels();chart.invalidate();};
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
