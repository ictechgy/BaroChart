import {DARK_THEME,LIGHT_THEME,DEMO_SYMBOLS,demoCalendar,formatPrice} from '../../src/index.mjs';
import {createRustChart} from '../../src/web/wasm/chart.mjs';
import {safeCheckpointStringify} from '../../src/core/checkpoint-validation.mjs';
import {readDemoAnalysis,MAX_ANALYSIS_BARS,MAX_ANALYSIS_BYTES} from './analysis-session.mjs';
import {createRustDemoWidgets} from './rust-demo-widgets.mjs';
import {currentLayoutHistoryFrame,emptyLayoutHistoryState,readLayoutFrame,readLayoutHistoryState} from './layout-history.mjs';
import {RUST_LAYOUT_STORAGE_KEY,MAX_RUST_LAYOUT_BYTES,parseRustLayoutPreset,stringifyRustLayoutPreset,captureRustLayoutPreset,rustLayoutPlan,canonicalPresetToRustTarget,parseRustLayoutMemory,stringifyRustLayoutMemory} from './rust-layout-codec.mjs';

const FIELDS=Object.freeze(['time','open','high','low','close','volume']);
const COUNTS=new Set([10000,100000,1000000]);
const MAX_DRAWING_BYTES=8*1024*1024;
const BASE_INDICATORS=new Set(['ema','bb','rsi']);
const OVERLAYS=new Set(['sma','vwma','ema','wma','bollinger','donchian','vwap','dema','tema','hma','keltner','supertrend','ichimoku','pivots','parabolicSAR']);
const SERIES_PALETTE=Object.freeze({price:Object.freeze(['#58cadb','#285bb9']),ema:Object.freeze(['#f0b755','#946200']),rsi:Object.freeze(['#aa91f7','#7150ba']),upper:Object.freeze(['#63779e','#4a6084']),lower:Object.freeze(['#63779e','#4a6084'])});
const EXTRA_PALETTES=Object.freeze([Object.freeze(['#f0b755','#946200']),Object.freeze(['#aa91f7','#7150ba']),Object.freeze(['#58cadb','#17687c'])]);

function clone(value){return structuredClone(value);}
function layoutCodecConfiguration(value){const output=clone(value);for(const series of output.series??[])if(series.axisId===null)delete series.axisId;return output;}
function boundedText(text,max,label){
 if(typeof text!=='string'||text.length>max||new TextEncoder().encode(text).byteLength>max)throw new RangeError(label);
 return text;
}
function finite(value,fallback=0){return typeof value==='number'&&Number.isFinite(value)?value:fallback;}
function identifier(value,label){if(typeof value!=='string'||!value||value.length>128||['__proto__','constructor','prototype'].includes(value))throw new TypeError(label);return value;}
function pinState(value,label){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>32)throw new TypeError(`${label} pins`);
 return value.map(row=>{if(!Array.isArray(row)||row.length!==2)throw new TypeError(`${label} pin`);const id=identifier(row[0],`${label} pin id`),range=row[1]?.range;if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite))throw new TypeError(`${label} pin range`);return [id,{range:[...range]}];});
}
function exactColumns(columns,expected){
 if(!columns||typeof columns!=='object'||Array.isArray(columns))throw new TypeError('OHLCV columns required');
 const output={};let length=null;
 for(const field of FIELDS){const value=columns[field];if(!(value instanceof Float64Array))throw new TypeError(`Float64Array ${field} required`);if(length===null)length=value.length;else if(value.length!==length)throw new RangeError('OHLCV column lengths');output[field]=new Float64Array(value);}
 if(expected!==undefined&&length!==expected)throw new RangeError('Loaded bar count changed');
 return output;
}
function query(root,id){return root.querySelector?.(`#${id}`)??null;}
function choices(node,items,selected=''){
 if(!node)return '';
 const document=node.ownerDocument,accepted=items.some(item=>item.value===selected)?selected:(items[0]?.value??'');
 node.replaceChildren(...items.map(item=>{const option=document.createElement('option');option.value=item.value;option.textContent=item.label;return option;}));node.value=accepted;return accepted;
}
function createDefaults(market,light,seriesType='candles'){
 const symbol=DEMO_SYMBOLS[market];if(!symbol)throw new RangeError('Unknown demo market');
 return {
  panels:[{id:'price',label:'PRICE',weight:3.5},{id:'volume',label:'VOLUME',weight:.8,precision:0},{id:'rsi',label:'RSI',weight:1,range:[0,100],precision:0}],
  series:[
   {id:'price',label:'가격',type:seriesType,panel:'price',color:'#58cadb'},
   {id:'volume',label:'거래량',type:'histogram',source:'volume',panel:'volume',color:'#2b6e78'},
   {id:'ema',label:'EMA',type:'line',panel:'price',indicator:'ema',color:'#f0b755'},
   {id:'upper',label:'볼린저 상단',type:'line',panel:'price',indicator:'bb',output:'upper',color:'#63779e',width:1},
   {id:'lower',label:'볼린저 하단',type:'line',panel:'price',indicator:'bb',output:'lower',color:'#63779e',width:1},
   {id:'rsi',label:'RSI',type:'line',panel:'rsi',indicator:'rsi',color:'#aa91f7'},
  ],
  indicators:[{id:'ema',name:'ema',params:{}},{id:'bb',name:'bollinger',params:{}},{id:'rsi',name:'rsi',params:{}}],
  precision:symbol.priceDecimals,axisWidth:market==='crypto'?125:85,theme:light?LIGHT_THEME:DARK_THEME,
 };
}
function outputSeriesType(output){return output==='histogram'?'histogram':'line';}
function colorMatches(value,candidates){if(typeof value!=='string')return false;const normalized=value.toLowerCase();return candidates.some(color=>normalized===color||normalized===`${color}ff`);}
function extraPaletteIndex(id){const match=/^extra-(\d+)$/.exec(String(id??''));if(match){const value=Number(match[1]);if(Number.isSafeInteger(value)&&value>0)return(value-1)%EXTRA_PALETTES.length;}let hash=0;for(const character of String(id??''))hash=(hash*31+character.codePointAt(0))%EXTRA_PALETTES.length;return hash;}
function analysisBinding({market,light,count,revision}){const symbol=DEMO_SYMBOLS[market];if(!symbol||typeof light!=='boolean'||!COUNTS.has(count)||!Number.isSafeInteger(revision)||revision<0)throw new TypeError('Analysis settings');return {key:`barochart-demo:${market}`,revision:String(revision),adjustmentVersion:'raw-v1',priceUnit:symbol.currency,adjustment:'raw'};}
function encodeAnalysisNumber(value){if(!Number.isFinite(value))throw new TypeError('Analysis finite OHLCV required');return Object.is(value,-0)?'-0':value;}

/** Main-demo controller backed by one Worker-owned Rust session. */
export async function mountRustDemo({root=globalThis.document,backend,initialSession=null,initialState=null,publish=true,loadData,signal,chartFactory=createRustChart,widgetsFactory=createRustDemoWidgets}={}){
 if(!root||typeof root.querySelector!=='function'||typeof root.querySelectorAll!=='function')throw new TypeError('Rust demo root must support querySelector');
 if(!backend||typeof backend.createSession!=='function')throw new TypeError('Rust backend required');
 if(!initialSession&&typeof loadData!=='function')throw new TypeError('Rust demo loadData required');
 if(typeof chartFactory!=='function'||typeof widgetsFactory!=='function')throw new TypeError('Rust demo factories required');
 if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');
 if(signal?.aborted)throw new DOMException('Rust demo mount aborted','AbortError');
 const document=root.nodeType===9?root:root.ownerDocument,view=document?.defaultView??globalThis.window??globalThis;
 if(!document?.createElement)throw new TypeError('Rust demo owner document required');
 const $=id=>query(root,id),chartRoot=$('chart');if(!chartRoot)throw new TypeError('Rust demo chart root required');
 const listeners=[],timeouts=new Set();
 const listen=(node,type,handler,options)=>{if(!node?.addEventListener)return;node.addEventListener(type,handler,options);listeners.push([node,type,handler,options]);};
 const later=(fn,delay)=>{const id=view.setTimeout(()=>{timeouts.delete(id);fn();},delay);timeouts.add(id);return id;};
 const state={market:initialState?.market??$('market')?.value??'us',count:Number(initialState?.count??$('count')?.value??100000),light:!!initialState?.light,generatedPanels:new Set(initialState?.generatedPanels??['rsi']),generatedAxes:new Set(initialState?.generatedAxes??[]),panelPins:pinState(initialState?.panelPins,'Panel'),axisPins:pinState(initialState?.axisPins,'Axis')};
 if(!DEMO_SYMBOLS[state.market]||!COUNTS.has(state.count))throw new RangeError('Rust demo initial state');
 let rememberedMemory={enabled:true,preset:null};
 if(!initialSession&&initialState?.preferencesChanged!==true){try{const remembered=view.localStorage?.getItem(RUST_LAYOUT_STORAGE_KEY);if(remembered)rememberedMemory=parseRustLayoutMemory(remembered);const value=rememberedMemory.preset;if(rememberedMemory.enabled&&value){state.market=value.market;state.count=value.count;state.light=value.light;state.generatedPanels=new Set(value.managed.panels);state.generatedAxes=new Set(value.managed.axes);}}catch{rememberedMemory={enabled:true,preset:null};}}
 const initialInput=initialState?.input,desiredInput={tool:initialInput?.tool??root.querySelector('[data-tool][aria-pressed="true"]')?.dataset?.tool??'select',text:Object.hasOwn(initialInput??{},'text')?initialInput.text:($('annotation')?.value??'관찰 메모'),crosshairSnap:clone(initialInput?.crosshairSnap??{mode:$('crosshair-snap')?.value??'free'}),drawingMagnet:clone(initialInput?.drawingMagnet??{mode:$('magnet')?.value??'off'})};
 let session=null,chart=null,unsubscribe=null,widgets=null,configuration=null,drawings=null,lastLayoutTarget=null;
 let autoPublish=!!publish,published=false,disposed=false,pageActive=true,paused=false,busy=false,layoutMutation=false,layoutAxisExplicit=false,desiredInputPending=false,extraSerial=0,job=0,jobController=null,loadQueue=Promise.resolve(),streamTimer=null,streamIntent=initialState?.streamIntent===true,streamTick=0,streamBusy=false,refreshQueued=false,refreshEpoch=0,statsTimer=null,rememberEnabled=rememberedMemory.enabled,memoryTimer=null,disposePromise=null,lastLoadError=null,fileRequest=null,fileEpoch=0,paramsJobs=0,palettePending=false,paletteQueue=Promise.resolve();
 let initialResolve,initialReject,initialSettled=false;
 const initialReady=new Promise((resolve,reject)=>{initialResolve=resolve;initialReject=reject;});void initialReady.catch(()=>{});
 const settleInitial=error=>{if(initialSettled)return;initialSettled=true;error?initialReject(error):initialResolve();};
 let initialPreferencesChanged=initialState?.preferencesChanged===true;
 const layoutUndo=[],layoutRedo=[],marketJournals=new Map();

 function compactLayoutTarget(target){
  if(!target)return null;
  const panels=clone(target.generatedPanels),axes=clone(target.generatedAxes),panelPins=new Set(state.panelPins.map(([id])=>id)),axisPins=new Set(state.axisPins.map(([id])=>id));for(const row of panels)if(panelPins.has(row.id))delete row.options.range;for(const row of axes)if(axisPins.has(row.id))delete row.options.range;
  return readLayoutFrame({panelOrder:clone(target.panelOrder),placements:target.placements.filter(row=>typeof row.indicatorId==='string').map(row=>({seriesId:row.seriesId,indicatorId:row.indicatorId,panelId:row.panelId,axisId:row.axisId??null})),generatedPanels:panels,generatedAxes:axes});
 }
 function frameIdentity(frame){return safeCheckpointStringify({panelOrder:frame.panelOrder,placements:frame.placements,generatedPanels:frame.generatedPanels.map(row=>[row.id]),generatedAxes:frame.generatedAxes.map(row=>[row.id,row.panel])});}
 function exportLayoutHistory(){
  if(!lastLayoutTarget)return emptyLayoutHistoryState();
  const current=compactLayoutTarget(lastLayoutTarget),commands=[];
  for(let index=0;index<layoutUndo.length;index++)commands.push({label:layoutUndo[index].label,before:clone(layoutUndo[index].frame),after:clone(index+1<layoutUndo.length?layoutUndo[index+1].frame:current)});
  let before=current;
  for(const record of [...layoutRedo].reverse()){commands.push({label:record.label,before:clone(before),after:clone(record.frame)});before=record.frame;}
  return readLayoutHistoryState({schema:'barochart.layout-history',version:1,commands,cursor:layoutUndo.length});
 }
 function importLayoutHistory(value){
  const history=readLayoutHistoryState(value),actual=compactLayoutTarget(lastLayoutTarget),expected=currentLayoutHistoryFrame(history);
  if(expected&&frameIdentity(expected)!==frameIdentity(actual))throw new Error('Layout history current frame does not match the Rust chart');
  if(history.commands.length){if(history.cursor>0)history.commands[history.cursor-1].after=clone(actual);else history.commands[0].before=clone(actual);if(history.cursor<history.commands.length)history.commands[history.cursor].before=clone(actual);}
  layoutUndo.splice(0,layoutUndo.length,...history.commands.slice(0,history.cursor).map(command=>({label:command.label,frame:clone(command.before)})));
  layoutRedo.splice(0,layoutRedo.length,...history.commands.slice(history.cursor).map(command=>({label:command.label,frame:clone(command.after)})).reverse());
 }
 function mergePanelOrder(current,desired,retained){const wanted=new Set(desired),extras=new Set(current.filter(id=>!wanted.has(id)&&retained.has(id))),merged=[];let index=0;for(const id of current){if(extras.has(id))merged.push(id);else if(index<desired.length)merged.push(desired[index++]);}while(index<desired.length)merged.push(desired[index++]);return [...new Set(merged)];}
 function layoutReferences(value){
  if(!value||value.schema!=='aster.web-wasm.layout-references'||value.version!==1||!Array.isArray(value.panels)||!Array.isArray(value.axes))throw new TypeError('Rust layout references');
  return{panels:new Set(value.panels),axes:new Set(value.axes)};
 }
 function expandLayoutIntent(intent,base,referenceValue){
  const frame=readLayoutFrame(intent),target=clone(base),references=layoutReferences(referenceValue),currentPanels=new Map(target.generatedPanels.map(row=>[row.id,row])),wantedPanels=new Map(frame.generatedPanels.map(row=>[row.id,row])),currentAxes=new Map(target.generatedAxes.map(row=>[row.id,row])),wantedAxes=new Map(frame.generatedAxes.map(row=>[row.id,row]));
  for(const series of target.series)if(!series.indicator){references.panels.add(series.panel);if(series.axisId)references.axes.add(series.axisId);}
  for(const axis of target.axes)if(references.axes.has(axis.id))references.panels.add(axis.panel);
  const retainedPanels=new Set(target.panels.filter(row=>!currentPanels.has(row.id)||references.panels.has(row.id)).map(row=>row.id)),retainedAxes=new Set(target.axes.filter(row=>!currentAxes.has(row.id)||references.axes.has(row.id)).map(row=>row.id));
  target.panels=target.panels.filter(row=>!currentPanels.has(row.id)||wantedPanels.has(row.id)||retainedPanels.has(row.id));target.axes=target.axes.filter(row=>!currentAxes.has(row.id)||wantedAxes.has(row.id)||retainedAxes.has(row.id));
  const panelPinMap=new Map(state.panelPins),axisPinMap=new Map(state.axisPins),runtimePanels=frame.generatedPanels.map(row=>{const next=clone(row),pin=panelPinMap.get(row.id);if(pin&&!Object.hasOwn(next.options,'range'))next.options.range=clone(pin.range);return next;}),runtimeAxes=frame.generatedAxes.map(row=>{const next=clone(row),pin=axisPinMap.get(row.id);if(pin&&!Object.hasOwn(next.options,'range'))next.options.range=clone(pin.range);return next;});
  for(const row of runtimePanels){const next={id:row.id,...clone(row.options)},index=target.panels.findIndex(panel=>panel.id===row.id);if(index<0)target.panels.push(next);else target.panels[index]=next;}
  for(const row of runtimeAxes){const next={id:row.id,panel:row.panel,...clone(row.options)},index=target.axes.findIndex(axis=>axis.id===row.id);if(index<0)target.axes.push(next);else target.axes[index]=next;}
  target.panelOrder=mergePanelOrder(base.panelOrder,frame.panelOrder,new Set([...retainedPanels].filter(id=>!frame.panelOrder.includes(id))));
  target.generatedPanels=[...runtimePanels,...target.generatedPanels.filter(row=>!wantedPanels.has(row.id)&&retainedPanels.has(row.id))];target.generatedAxes=[...runtimeAxes,...target.generatedAxes.filter(row=>!wantedAxes.has(row.id)&&retainedAxes.has(row.id))];target.placements=clone(frame.placements);
  target.panels.sort((left,right)=>target.panelOrder.indexOf(left.id)-target.panelOrder.indexOf(right.id));
  const placements=new Map(frame.placements.map(row=>[row.seriesId,row]));for(const series of target.series){const placement=placements.get(series.id);if(placement){series.panel=placement.panelId;series.axisId=placement.axisId;}}
  return target;
 }

 function status(message,id='status'){const node=$(id);if(node)node.textContent=String(message).slice(0,300);}
 function friendly(error){if(error?.name==='AbortError')return session?'작업을 취소했습니다. 현재 차트는 유지됩니다.':'차트 준비를 취소했습니다.';return `변경을 적용하지 못했습니다: ${String(error?.message??error).slice(0,180)}`;}
 function setText(id,value){const node=$(id);if(node&&node.textContent!==String(value))node.textContent=String(value);}
 function staleFileError(){const error=new Error('파일을 읽는 동안 차트 소유자나 분석 상태가 바뀌었습니다. 다시 선택하세요.');error.name='StaleSourceError';return error;}
 function stableFileSnapshot(value){
  const interaction=value?.interaction??{};
  return {data:value?.data,view:value?.view,configuration:value?.configuration,drawings:value?.drawings,interaction:{tool:interaction.tool,text:interaction.text,gestureKind:interaction.gestureKind,pointerCount:interaction.pointerCount,crosshairSnap:interaction.crosshairSnap,drawingMagnet:interaction.drawingMagnet,drawingTarget:interaction.drawingTarget}};
 }
 function cancelFileRequest(){
  if(!fileRequest)return false;
  const request=fileRequest;fileRequest=null;fileEpoch++;request.controller.abort();request.unsubscribe?.();request.unsubscribe=null;setBusy(false);return true;
 }
 function fileSize(file,maxBytes,label){
  if(!file||typeof file.text!=='function'||!Number.isSafeInteger(file.size)||file.size<0||file.size>maxBytes)throw new RangeError(label);
 }
 function beginFileRequest(kind,file,maxBytes,label){
  cancelFileRequest();fileSize(file,maxBytes,label);
  if(!ready()||busy||layoutMutation||session?.activeJob||!configuration||!drawings)throw new Error('차트가 준비된 뒤 파일을 선택하세요.');
  const ownerSession=session,ownerChart=chart,snapshot=ownerSession.snapshot(),controller=new AbortController(),request={kind,file,epoch:++fileEpoch,controller,signal:controller.signal,owner:{session:ownerSession,generation:ownerSession.generation,chart:ownerChart,canvas:ownerChart.canvas,stable:safeCheckpointStringify(stableFileSnapshot(snapshot)),configuration:safeCheckpointStringify(configuration),drawings:safeCheckpointStringify(drawings),outcomeId:ownerSession.lastOutcome?.id??0},unsafe:false,unsubscribe:null};
  if(snapshot.interaction?.gestureKind||snapshot.interaction?.pointerCount)throw new Error('진행 중인 입력이 끝난 뒤 파일을 선택하세요.');
  let lastOutcome=request.owner.outcomeId;
  request.unsubscribe=ownerSession.subscribe(next=>{
   const outcome=ownerSession.lastOutcome,outcomeChanged=(outcome?.id??0)!==lastOutcome;lastOutcome=outcome?.id??lastOutcome;
   const stable=safeCheckpointStringify(stableFileSnapshot(next)),benign=(outcome?.operation==='nativePointer'||outcome?.operation==='nativeHoverExit')&&!next.interaction?.gestureKind&&!next.interaction?.pointerCount&&stable===request.owner.stable;
   if(next.interaction?.gestureKind||next.interaction?.pointerCount||stable!==request.owner.stable||outcomeChanged&&!benign)request.unsafe=true;
  });
  fileRequest=request;setBusy(true);return request;
 }
 function finishFileRequest(request){if(fileRequest===request){fileRequest=null;setBusy(false);}request.unsubscribe?.();request.unsubscribe=null;}
 async function readRequestFile(request){
  const reading=Promise.resolve().then(()=>request.file.text());reading.catch(()=>{});
  let abort;const stopped=new Promise((_resolve,reject)=>{abort=()=>reject(new DOMException('File request aborted','AbortError'));request.signal.addEventListener('abort',abort,{once:true});});
  try{const text=await Promise.race([reading,stopped]);if(typeof text!=='string')throw new TypeError('File text required');return text;}
  finally{request.signal.removeEventListener('abort',abort);}
 }
 function sameFileOwner(request){return fileRequest===request&&!request.signal.aborted&&!disposed&&pageActive&&!paused&&session===request.owner.session&&session.generation===request.owner.generation&&chart===request.owner.chart&&chart?.canvas===request.owner.canvas;}
 async function assertFileOwner(request){
  if(!sameFileOwner(request)||request.unsafe)throw staleFileError();
  await request.owner.session.resync();
  if(!sameFileOwner(request)||request.unsafe)throw staleFileError();
  const [nextConfiguration,nextDrawings]=await Promise.all([request.owner.session.query('web.configuration'),request.owner.session.query('web.drawingsState')]),snapshot=request.owner.session.snapshot();
  if(!sameFileOwner(request)||request.unsafe||safeCheckpointStringify(stableFileSnapshot(snapshot))!==request.owner.stable||safeCheckpointStringify(nextConfiguration)!==request.owner.configuration||safeCheckpointStringify(nextDrawings)!==request.owner.drawings)throw staleFileError();
  return {configuration:nextConfiguration,drawings:nextDrawings,snapshot};
 }
 async function handleFileSelection(event,{kind,maxBytes,sizeMessage,statusId='status',apply}){
  const input=event.target,file=input.files?.[0];input.value='';if(!file)return;
  let request;
  try{request=beginFileRequest(kind,file,maxBytes,sizeMessage);const text=await readRequestFile(request);await assertFileOwner(request);await apply(text,request);}
  catch(error){if(request&&fileRequest!==request)return;if(error?.name!=='AbortError')status(friendly(error),statusId);}
  finally{if(request)finishFileRequest(request);}
 }
 function currentState(){return Object.freeze({market:state.market,count:state.count,light:state.light,streamIntent,layoutBusy:busy||layoutMutation,generatedPanels:Object.freeze([...state.generatedPanels]),generatedAxes:Object.freeze([...state.generatedAxes]),panelPins:Object.freeze(clone(state.panelPins)),axisPins:Object.freeze(clone(state.axisPins)),layoutHistory:exportLayoutHistory()});}
 function publishCurrent(){if(disposed||!session||!chart||chart.disposed)return false;autoPublish=true;published=true;view.aster={backend:'rust-wasm',session,chart};document.documentElement?.setAttribute?.('data-chart-theme',state.light?'light':'dark');if(streamIntent&&!document.hidden)startStream();return {session,chart};}
 function setBusy(value){busy=!!value;$('workspace')?.setAttribute?.('aria-busy',String(busy));$('cancel-compute')&&( $('cancel-compute').hidden=!busy);widgets?.setBusy(busy);updateDisabled();}
 function ready(){return !!session&&!!chart&&!chart.disposed&&!disposed&&pageActive&&!paused;}
 function updateDisabled(){
  const unavailable=!ready(),blocked=unavailable||busy||layoutMutation;
  for(const id of ['fit','recent','stream','renderer','series','scale','load','save','layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down','layout-undo','layout-redo','save-chart-layout','load-chart-layout','save-analysis','load-analysis','drawing-manager-controls'])if($(id))$(id).disabled=blocked;
  for(const node of root.querySelectorAll('[data-tool]'))node.disabled=blocked;
  if($('undo'))$('undo').disabled=blocked||!drawings?.canUndo;if($('redo'))$('redo').disabled=blocked||!drawings?.canRedo;
  const selected=drawings?.items?.find(item=>item.id===drawings.selected);if($('delete'))$('delete').disabled=blocked||!selected||selected.locked;if($('lock'))$('lock').disabled=blocked||!selected;
  if($('layout-undo'))$('layout-undo').disabled=blocked||!layoutUndo.length;if($('layout-redo'))$('layout-redo').disabled=blocked||!layoutRedo.length;
 }
 function progress(row){const total=finite(row?.total,0),done=finite(row?.done,0),percent=total?Math.round(done/total*100):0;status(total?`차트를 준비하고 있습니다 · ${percent}%`:'차트를 준비하고 있습니다…');}
 async function applyPalette(owner,light){
  const current=await owner.query('web.configuration'),extraColors=EXTRA_PALETTES.flat();
  for(const series of current.series){
   const extra=typeof series.indicator==='string'&&series.indicator.startsWith('extra-'),pair=SERIES_PALETTE[series.id]??(extra?EXTRA_PALETTES[extraPaletteIndex(series.indicator)]:null);
   if(!pair||series.id==='price'&&!['line','area','histogram'].includes(series.type))continue;
   const patch={},known=extra?extraColors:pair;if(series.color===undefined||colorMatches(series.color,known))patch.color=pair[light?1:0];
   if(series.id==='price'&&(series.fill===undefined||colorMatches(series.fill,['#58cadb22','#285bb933'])))patch.fill=light?'#285bb933':'#58cadb22';
   if(Object.keys(patch).length)await owner.command('setSeries',[series.id,patch]);
  }
 }
 function requestPalette(){
  palettePending=true;if(paramsJobs||disposed)return paletteQueue;
  paletteQueue=paletteQueue.catch(()=>{}).then(async()=>{
   if(paramsJobs||!palettePending||disposed)return;const owner=session;palettePending=false;
   try{await applyPalette(owner,state.light);if(owner===session){await refresh();await captureCurrentLayout(false);scheduleMemory();}}
   catch(error){if(owner===session&&owner.activeJob==='params')palettePending=true;else if(owner===session)status(friendly(error));}
  });
  return paletteQueue;
 }
 async function applyDesiredInput(owner){
  await owner.command('setTool',[desiredInput.tool]);await owner.command('setText',[desiredInput.text]);await owner.command('setCrosshairSnap',[clone(desiredInput.crosshairSnap)]);await owner.command('setDrawingMagnet',[clone(desiredInput.drawingMagnet)]);desiredInputPending=false;
 }
 function stopStream(){if(streamTimer!==null){view.clearInterval(streamTimer);streamTimer=null;}if($('stream')){$('stream').setAttribute('aria-pressed','false');$('stream').textContent='▶ 합성 스트림';}}
 async function streamStep(){
  if(streamBusy||!ready()||busy||document.hidden||!session?.snapshot()?.data?.length)return;streamBusy=true;
  try{
   const snapshot=session.snapshot(),index=snapshot.data.length-1,result=await session.command('dataAt',[{index},{indicatorMode:'cached'}]),bar=result?.primary?.bar;
   if(!bar)return;const symbol=DEMO_SYMBOLS[state.market],delta=Math.sin(++streamTick*1.7)*.05*(state.market==='kr'?700:state.market==='crypto'?1e-10:1),close=Math.max(symbol.tickSize,bar.close+delta);
   if(streamTick%20)await session.command('applyDataEvent',[{kind:'update',bar:{...bar,close,high:Math.max(bar.high,close),low:Math.min(bar.low,close),volume:bar.volume+20}}]);
   else{let time=bar.time+60000,calendar=demoCalendar(state.market);while(!calendar.at(time))time+=60000;await session.command('applyDataEvent',[{kind:'append',bar:{time,open:close,high:close,low:close,close,volume:0}}]);}
  }catch(error){streamIntent=false;stopStream();status(friendly(error));}finally{streamBusy=false;}
 }
 function startStream(){if(streamTimer!==null||!streamIntent||!autoPublish||!published||!ready()||busy||document.hidden)return;streamTimer=view.setInterval(()=>void streamStep(),100);$('stream')?.setAttribute('aria-pressed','true');if($('stream'))$('stream').textContent='Ⅱ 스트림 정지';}

 function candidateHost(){const host=document.createElement('div'),rect=chartRoot.getBoundingClientRect?.()??{width:800,height:500};host.style.width=`${Math.max(100,Math.floor(rect.width||800))}px`;host.style.height=`${Math.max(80,Math.floor(rect.height||500))}px`;host.style.minWidth='0';host.style.maxWidth='100%';host.style.overflow='hidden';host.style.visibility='hidden';host.style.pointerEvents='none';host.inert=true;chartRoot.append(host);return host;}
 async function install(nextSession,{market=state.market,count=state.count,light=state.light,generatedPanels=null,generatedAxes=null,panelPins=null,axisPins=null,layoutHistoryState=null,token=job,closePrevious=true,beforeCommit=null}={}){
  let nextChart,host=candidateHost();
  try{nextChart=await chartFactory(host,nextSession,{renderer:$('renderer')?.value??'canvas',onError:error=>status(friendly(error))});await nextChart.flush?.();if(disposed||token!==job||!pageActive)throw new DOMException('Rust demo candidate cancelled','AbortError');await beforeCommit?.();if(disposed||token!==job||!pageActive)throw new DOMException('Rust demo candidate cancelled','AbortError');}
  catch(error){await nextChart?.destroy?.();await nextSession.close?.();host.remove();throw error;}
  const previousSession=session,previousUnsubscribe=unsubscribe;
  try{chartRoot.replaceChildren(host);host.style.width='100%';host.style.height='100%';host.style.visibility='';host.style.pointerEvents='';host.inert=false;}
  catch(error){await nextChart.destroy?.();await nextSession.close?.();throw error;}
  session=nextSession;chart=nextChart;state.market=market;state.count=count;state.light=light;
  if(generatedPanels)state.generatedPanels=new Set(generatedPanels);if(generatedAxes)state.generatedAxes=new Set(generatedAxes);
  if(panelPins)state.panelPins=pinState(panelPins,'Panel');if(axisPins)state.axisPins=pinState(axisPins,'Axis');
  state.panelPins=state.panelPins.filter(([id])=>state.generatedPanels.has(id));state.axisPins=state.axisPins.filter(([id])=>state.generatedAxes.has(id));
  configuration=null;drawings=null;lastLayoutTarget=null;layoutUndo.length=0;layoutRedo.length=0;
  previousUnsubscribe?.();unsubscribe=session.subscribe(()=>scheduleRefresh());
  if(autoPublish)publishCurrent();
  if(closePrevious&&previousSession&&previousSession!==nextSession)try{await previousSession.close?.();}catch{status('새 차트는 적용됐지만 이전 Worker 정리를 확인하지 못했습니다.');}
  try{await refresh();await captureCurrentLayout(false);if(layoutHistoryState){importLayoutHistory(layoutHistoryState);syncLayoutControls();updateDisabled();}}catch(error){status(`새 차트는 적용됐지만 컨트롤 갱신을 확인하지 못했습니다: ${String(error?.message??error).slice(0,120)}`);}
  return {session:nextSession,previousSession};
 }
 async function buildMarket(market,count,columns,signal,token){
  if(signal.aborted||token!==job)throw new DOMException('Rust demo load cancelled','AbortError');
  const options=createDefaults(market,state.light,$('series')?.value??'candles'),{indicators,series,...initialOptions}=options,next=await backend.createSession({count:0,options:{...initialOptions,series:[]},signal});
  try{for(const entry of indicators)await next.command('addIndicator',[entry.id,entry.name,entry.params]);for(const row of series)await next.command('addSeries',[row]);await next.command('setSymbol',[DEMO_SYMBOLS[market]]);await next.prepareData({kind:'columns',columns,visibleBars:200},{signal,onProgress:progress});await applyDesiredInput(next);await applyPalette(next,state.light);return next;}catch(error){await next.close?.();throw error;}
 }
 function portableJournalCapture(capture){return Object.freeze({metadataJSON:String(capture.metadataJSON),header:String(capture.header),description:clone(capture.description),uiChunks:Object.freeze(capture.uiChunks.map(String))});}
 async function captureMarketJournal(owner,signal){
  const hostState={market:state.market,selectedCount:state.count,light:state.light,generatedPanels:[...state.generatedPanels],generatedAxes:[...state.generatedAxes],panelPins:clone(state.panelPins),axisPins:clone(state.axisPins),layoutHistory:exportLayoutHistory()},binding=migrationBinding(owner);
  const result=await owner.withMigrationCapture(binding,{signal,onProgress:progress,consume:capture=>Object.freeze({market:state.market,actualCount:capture.length,selectedCount:state.count,capture:portableJournalCapture(capture),hostState}),activate:async candidate=>{candidate.handoff();return candidate.value;}});
  return result.value;
 }
 async function restoreMarketJournal(journal,market,count,columns,signal,token){
  const sourceColumns=journal.actualCount===count?columns:exactColumns(await loadData({market,count:journal.actualCount,signal,onProgress:progress}),journal.actualCount);if(signal.aborted||token!==job)throw new DOMException('Rust demo load cancelled','AbortError');
  const next=await backend.createSessionFromMigration({...journal.capture,columns:sourceColumns},{signal,onProgress:progress});
  try{if(journal.actualCount!==count)await next.prepareData({kind:'columns',columns,visibleBars:200},{signal,onProgress:progress});if(desiredInputPending)await applyDesiredInput(next);if(journal.hostState.light!==state.light){await next.command('setTheme',[state.light?LIGHT_THEME:DARK_THEME]);await applyPalette(next,state.light);}return next;}catch(error){await next.close().catch(()=>{});throw error;}
 }
 function loadMarket(){
  if(disposed||!pageActive)return Promise.resolve();cancelFileRequest();const market=$('market')?.value??state.market,count=Number($('count')?.value??state.count),token=++job,controller=new AbortController(),localSignal=controller.signal,previous=loadQueue;jobController?.abort();jobController=controller;lastLoadError=null;stopStream();setBusy(true);status('시세와 지표를 준비하고 있습니다…');
  const task=(async()=>{
   await previous.catch(()=>{});
   try{
    if(localSignal.aborted||token!==job)throw new DOMException('Rust demo load cancelled','AbortError');
    const columns=exactColumns(await loadData({market,count,signal:localSignal,onProgress:progress}),count);if(localSignal.aborted||token!==job)throw new DOMException('Rust demo load cancelled','AbortError');
    if(session&&market===state.market){await session.prepareData({kind:'columns',columns,visibleBars:200},{signal:localSignal,onProgress:progress});if(desiredInputPending)await applyDesiredInput(session);if(localSignal.aborted||token!==job)throw new DOMException('Rust demo load cancelled','AbortError');state.count=count;if($('count'))$('count').value=String(count);await refresh();await resetLayoutHistoryToCurrent();status('저장 봉 수를 바꿨습니다. 현재 지표와 도형 분석은 유지됩니다.');}
    else{
     const sourceSession=session;if(sourceSession)marketJournals.set(state.market,await captureMarketJournal(sourceSession,localSignal));
     const journal=marketJournals.get(market),next=journal?await restoreMarketJournal(journal,market,count,columns,localSignal,token):await buildMarket(market,count,columns,localSignal,token),host=journal?.hostState;
     await install(next,{market,count,light:state.light,generatedPanels:host?.generatedPanels??['rsi'],generatedAxes:host?.generatedAxes??[],panelPins:host?.panelPins??[],axisPins:host?.axisPins??[],layoutHistoryState:host?.layoutHistory??null,token,beforeCommit:()=>desiredInputPending?applyDesiredInput(next):undefined});status(journal?'이 시장의 도형 분석을 복원했습니다.':'차트가 준비됐습니다. 지표와 도형으로 분석을 시작하세요.');await restoreRemembered();
    }
    settleInitial();
   }catch(error){if(token===job){lastLoadError=error;if($('market'))$('market').value=state.market;if($('count'))$('count').value=String(state.count);status(friendly(error));if(!session)settleInitial(error);}}
   finally{if(token===job){setBusy(false);if(streamIntent)startStream();}}
  })();
  loadQueue=task;return task;
 }

 async function queryPresentation(providedState){
  const owner=session,token=++refreshEpoch;if(!owner)return;
  const [nextConfiguration,nextDrawings]=await Promise.all([owner.query('web.configuration'),owner.query('web.drawingsState')]);
  if(disposed||owner!==session||token!==refreshEpoch)return;
  configuration=nextConfiguration;drawings=nextDrawings;const snapshot=providedState??owner.snapshot();
  if(!desiredInputPending){desiredInput.tool=snapshot.interaction?.tool??desiredInput.tool;desiredInput.text=snapshot.interaction?.text??desiredInput.text;desiredInput.crosshairSnap=clone(snapshot.interaction?.crosshairSnap??desiredInput.crosshairSnap);desiredInput.drawingMagnet=clone(snapshot.interaction?.drawingMagnet??desiredInput.drawingMagnet);}
  const symbol=configuration.symbol??DEMO_SYMBOLS[state.market];setText('symbol',symbol?.id??DEMO_SYMBOLS[state.market].id);setText('meta',`${symbol?.currency??''} · ${symbol?.timezone??''} · ${symbol?.volumeUnit??''}`);
  const price=configuration.series?.find(row=>row.id==='price'),panel=configuration.panels?.find(row=>row.id==='price');if(price&&$('series'))$('series').value=price.type;if(panel&&$('scale'))$('scale').value=panel.scale;
  const displayInput=desiredInputPending?desiredInput:snapshot.interaction;
  if($('crosshair-snap')&&displayInput?.crosshairSnap?.mode)$('crosshair-snap').value=displayInput.crosshairSnap.mode;if($('magnet')&&displayInput?.drawingMagnet?.mode)$('magnet').value=displayInput.drawingMagnet.mode;if($('annotation'))$('annotation').value=displayInput?.text??'';
  for(const node of root.querySelectorAll('[data-tool]'))node.setAttribute('aria-pressed',String(node.dataset.tool===(displayInput?.tool??'select')));
  const selected=drawings.items?.find(item=>item.id===drawings.selected);
  setText('selection',selected?`선택: ${selected.type} · ${selected.locked?'잠김':'편집 가능'}`:'선택된 도형 없음');
  if($('lock'))$('lock').textContent=selected?.locked?'잠금 해제':'잠금';
  await syncLatest(snapshot,owner,token);
  layoutPanels();syncLayoutControls();updateDisabled();
  await widgets?.refresh({configuration:nextConfiguration,drawings:nextDrawings,state:snapshot});
 }
 function scheduleRefresh(){
  if(refreshQueued||disposed)return;
  refreshQueued=true;
  queueMicrotask(()=>{refreshQueued=false;void refresh().catch(error=>status(friendly(error)));});
 }
 async function refresh(){return queryPresentation();}
 async function syncLatest(snapshot,owner,token){
  if(!snapshot.data.length){
   for(const id of ['last-time','last-open','last-high','last-low','last-close','last-volume'])setText(id,'—');
   return;
  }
  try{
   const row=await owner.command('dataAt',[{index:snapshot.data.length-1},{indicatorMode:'cached'}]);
   if(owner!==session||token!==refreshEpoch)return;
   const bar=row?.primary?.bar;if(!bar)return;const symbol=configuration?.symbol??DEMO_SYMBOLS[state.market],time=new Intl.DateTimeFormat('ko-KR',{timeZone:symbol.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(bar.time));
   setText('last-time',time);
   for(const field of ['open','high','low','close'])setText(`last-${field}`,formatPrice(bar[field],symbol));
   setText('last-volume',Object.is(bar.volume,-0)?'-0':String(bar.volume));
  }catch{}
 }
 function layoutPanels(){
  const panels=configuration?.panels??[],weights=panels.map(panel=>finite(panel.weight,1)).filter(weight=>weight>0);if(!weights.length)return;
  const total=weights.reduce((sum,value)=>sum+value,0),minimum=Math.min(...weights),height=Math.max(515,Math.ceil(72*total/minimum+38))+(view.matchMedia?.('(max-width:600px)')?.matches?64:0),row=$('chart-row');if(row)row.style.height=`${height}px`;chart?.resize();
 }

 async function mutate(operation,args=[]){
  if(!ready()||busy)throw new Error('Rust demo is busy');cancelFileRequest();
  const result=await session.command(operation,args);
  await refresh();return result;
 }
 async function updateInputPreference(key,value,operation,args){
  desiredInput[key]=clone(value);desiredInputPending=true;if(!ready()||busy)return;cancelFileRequest();const owner=session;
  try{await owner.command(operation,args);if(owner===session)desiredInputPending=false;await refresh();}
  catch(error){if(owner===session&&(busy||owner.activeJob))return;throw error;}
 }
 function migrationBinding(owner=session){
  const snapshot=owner.snapshot(),symbol=configuration?.symbol??DEMO_SYMBOLS[state.market];
  return {key:`barochart-demo:${state.market}`,revision:String(snapshot.data.version),adjustmentVersion:'raw-v1',priceUnit:symbol.currency,adjustment:symbol.adjustment??'raw'};
 }
 async function mutateInCandidate(label,operation){
  cancelFileRequest();const sourceSession=session,binding=migrationBinding(sourceSession),token=++job,controller=new AbortController(),localSignal=controller.signal;jobController?.abort();jobController=controller;
  let activated,result,nextPanels=[...state.generatedPanels],nextAxes=[...state.generatedAxes];
  setBusy(true);stopStream();status(`${label} 후보를 준비합니다…`);
  try{
   await sourceSession.withMigrationCapture(binding,{signal:localSignal,onProgress:progress,
    consume:async capture=>{
     const candidate=await backend.createSessionFromMigration(capture,{signal:localSignal,onProgress:progress});
     try{result=await operation(candidate,{generatedPanels:nextPanels,generatedAxes:nextAxes,setGeneratedPanels:value=>{nextPanels=[...value];},setGeneratedAxes:value=>{nextAxes=[...value];}});return candidate;}
     catch(error){await candidate.close().catch(()=>{});throw error;}
    },
    activate:async({value,handoff})=>{activated=await install(value,{market:state.market,count:state.count,light:state.light,generatedPanels:nextPanels,generatedAxes:nextAxes,token,closePrevious:false});handoff();return activated;},
   });
   if(activated?.previousSession&&activated.previousSession!==session)try{await activated.previousSession.close();}catch{status('변경은 적용됐지만 이전 Worker 정리를 확인하지 못했습니다.');}
   status(`${label}을 적용했습니다.`);return result;
  }finally{if(token===job){setBusy(false);if(streamIntent)startStream();}}
 }
 async function addIndicator(name,koreanLabel=name){
  return mutateInCandidate('지표 추가',async(candidate,ownership)=>{
   const [catalog,current]=await Promise.all([candidate.query('web.indicatorCatalog'),candidate.query('web.configuration')]),meta=catalog.entries?.find(row=>row.name===name);
   if(!meta)throw new Error('Rust indicator is unavailable');
   let id;const ids=new Set([...current.indicators,...current.panels,...current.axes,...current.series].map(row=>row.id)),seriesIds=current.series.map(row=>row.id);do{id=`extra-${++extraSerial}`;}while(ids.has(id)||seriesIds.some(value=>value.startsWith(`${id}-`)));
   const label=typeof koreanLabel==='string'&&koreanLabel.trim()?koreanLabel.trim().slice(0,80):name.toUpperCase();
   const overlay=OVERLAYS.has(name),panel=overlay?'price':id;
   if(!overlay){await candidate.command('addPanel',[{id,label,weight:1}]);ownership.setGeneratedPanels([...ownership.generatedPanels,id]);}
   await candidate.command('addIndicator',[id,name,{}]);
   for(const output of meta.outputs.filter(value=>value!=='direction'))await candidate.command('addSeries',[{id:`${id}-${output}`,label:meta.outputs.length>1?`${label} · ${output}`:label,type:outputSeriesType(output),panel,indicator:id,output,color:'#aa91f7'}]);
   return id;
  });
 }
 async function clearIndicators(){
  return mutateInCandidate('추가 지표 지우기',async(candidate,ownership)=>{
   let current=await candidate.query('web.configuration');const extras=current.indicators.filter(row=>!BASE_INDICATORS.has(row.id));
   for(const entry of extras){for(const series of current.series.filter(row=>row.indicator===entry.id))await candidate.command('removeSeries',[series.id]);await candidate.command('removeIndicator',[entry.id]);}
   current=await candidate.query('web.configuration');const remainingPanels=[];
   for(const id of ownership.generatedPanels){if(current.series.some(row=>row.panel===id)){remainingPanels.push(id);continue;}try{await candidate.command('removePanel',[id]);}catch{remainingPanels.push(id);}}
   ownership.setGeneratedPanels(remainingPanels);return extras.length;
  });
 }
 async function removeIndicator({id,seriesIds}){
  return mutateInCandidate('지표 삭제',async(candidate,ownership)=>{
   for(const seriesId of seriesIds)await candidate.command('removeSeries',[seriesId]);await candidate.command('removeIndicator',[id]);
   const current=await candidate.query('web.configuration'),remainingPanels=[];
   for(const panelId of ownership.generatedPanels){if(current.series.some(row=>row.panel===panelId)){remainingPanels.push(panelId);continue;}try{await candidate.command('removePanel',[panelId]);}catch{remainingPanels.push(panelId);}}
   ownership.setGeneratedPanels(remainingPanels);return id;
  });
 }

 function targetIds(rows){return new Set((rows??[]).map(row=>row.id));}
 async function captureFrame(){return session.query('web.layoutCapture',[[...state.generatedPanels],[...state.generatedAxes]]);}
 async function captureCurrentLayout(record=false,label='배치 변경'){
  const frame=await captureFrame(),next=clone(frame.target);
  if(record&&lastLayoutTarget&&safeCheckpointStringify(compactLayoutTarget(lastLayoutTarget))!==safeCheckpointStringify(compactLayoutTarget(next))){layoutUndo.push({label,frame:compactLayoutTarget(lastLayoutTarget)});if(layoutUndo.length>30)layoutUndo.shift();layoutRedo.length=0;}
  lastLayoutTarget=next;syncLayoutControls();scheduleMemory();return next;
 }
 async function applyTarget(target,{record=true,label='지표 배치'}={}){
  const frame=await captureFrame(),previous=clone(frame.target);frame.target=clone(target);
  await session.applyLayoutFrame(frame);
  const accepted=await session.query('web.layoutCapture',[(target.generatedPanels??[]).map(row=>row.id),(target.generatedAxes??[]).map(row=>row.id)]);lastLayoutTarget=clone(accepted.target);
  if(record&&safeCheckpointStringify(compactLayoutTarget(previous))!==safeCheckpointStringify(compactLayoutTarget(accepted.target))){layoutUndo.push({label,frame:compactLayoutTarget(previous)});if(layoutUndo.length>30)layoutUndo.shift();layoutRedo.length=0;}
  state.generatedPanels=new Set((accepted.target.generatedPanels??[]).map(row=>row.id));
  state.generatedAxes=new Set((accepted.target.generatedAxes??[]).map(row=>row.id));
  state.panelPins=state.panelPins.filter(([id])=>state.generatedPanels.has(id));state.axisPins=state.axisPins.filter(([id])=>state.generatedAxes.has(id));
  status(`${label}을 적용했습니다.`,'indicator-layout-status');scheduleMemory();await refresh();
 }
 async function withLayoutMutation(operation){
  if(layoutMutation||busy)throw new Error('Rust demo layout mutation is already active');
  cancelFileRequest();layoutMutation=true;updateDisabled();
  try{return await operation();}finally{layoutMutation=false;syncLayoutControls();updateDisabled();}
 }
 async function resetLayoutHistoryToCurrent(){layoutUndo.length=0;layoutRedo.length=0;lastLayoutTarget=null;const frame=await captureFrame();lastLayoutTarget=clone(frame.target);syncLayoutControls();scheduleMemory();}
 function indicatorGroups(){return (configuration?.indicators??[]).map(entry=>({...entry,series:(configuration?.series??[]).filter(row=>row.indicator===entry.id)})).filter(group=>group.series.length);}
 function groupOrigin(group){
  const panels=[...new Set(group?.series?.map(row=>row.panel)??[])],axes=[...new Set(group?.series?.map(row=>row.axisId??null)??[])];if(panels.length!==1||axes.length!==1)return null;
  const panel=configuration.panels.find(row=>row.id===panels[0]),axis=axes[0]===null?null:configuration.axes.find(row=>row.id===axes[0]&&row.panel===panels[0]);return panel&&(axes[0]===null||axis)?{panel,axis,axisId:axes[0]}:null;
 }
 async function projection(group,kind){
  const source=groupOrigin(group);if(!source)return kind==='panel'?{weight:1,scale:'linear',inverted:false,padding:.08}:{side:'right',scale:'linear',inverted:false,padding:.08,tickFormat:'fixed',visible:true};
  const origin=source.axis??source.panel,keys=kind==='panel'?['scale','inverted','padding','range','base','precision']:['side','scale','inverted','padding','range','base','precision','tickFormat','visible'],result=kind==='panel'?{weight:1}:{};
  for(const key of keys)if(origin[key]!==undefined)result[key]=key==='range'?clone(origin[key]):origin[key];
  if(kind==='axis'){
   result.side??=source.panel.axisSide??'right';result.scale??='linear';result.inverted??=false;result.padding??=.08;result.tickFormat??='fixed';result.visible??=true;
   if(result.scale==='percent'&&result.base===undefined&&source.axis===null&&session.snapshot().data.length){const first=await session.command('dataAt',[{index:0},{indicatorMode:'cached'}]),close=first?.primary?.bar?.close;if(Number.isFinite(close)&&close!==0)result.base=close;}
  }
  return result;
 }
 function syncLayoutControls(){
  if(!configuration)return;
  const groups=indicatorGroups(),panels=configuration.panels??[];
  const groupId=choices($('layout-indicator'),groups.map(row=>({value:row.id,label:`${row.name.toUpperCase()} · ${row.id}`})),$('layout-indicator')?.value);
  const group=groups.find(row=>row.id===groupId);
  const origin=group&&groupOrigin(group),panelId=choices($('layout-panel'),panels.map(row=>({value:row.id,label:row.label??row.id})),$('layout-panel')?.value??origin?.panel.id??group?.series[0]?.panel);
  const axes=(configuration.axes??[]).filter(row=>row.panel===panelId);
  const defaultAxis=!origin||panelId!==origin.panel.id?'independent':origin.axisId===null?'primary':`axis:${origin.axisId}`,selectedAxis=layoutAxisExplicit?$('layout-axis')?.value:defaultAxis;
  choices($('layout-axis'),[{value:'primary',label:'기본 축'},{value:'independent',label:'새 독립 축'},...axes.map(row=>({value:`axis:${row.id}`,label:row.label??row.id}))],selectedAxis);
  const order=choices($('reorder-panel'),panels.map(row=>({value:row.id,label:row.label??row.id})),$('reorder-panel')?.value),index=panels.findIndex(row=>row.id===order);
  if($('panel-up'))$('panel-up').disabled=busy||layoutMutation||index<=0;
  if($('panel-down'))$('panel-down').disabled=busy||layoutMutation||index<0||index===panels.length-1;
  setText('layout-history-summary',`배치 기록 ${layoutUndo.length} · 다시 실행 ${layoutRedo.length} · 최대 30단계`);
 }
 async function placeIndicator({separate=false}={}){
  const group=indicatorGroups().find(row=>row.id===$('layout-indicator')?.value);
  if(!group)throw new Error('표시된 지표를 선택하세요.');
  const frame=await captureFrame(),target=frame.target,origin=groupOrigin(group);let panelId=$('layout-panel')?.value,axisId=null;
  if(separate){
   let serial=1;const used=targetIds(target.panels);do{panelId=`${group.id}-panel${serial===1?'':`-${serial}`}`;serial++;}while(used.has(panelId));
   const panel={id:panelId,label:group.name.toUpperCase(),...await projection(group,'panel')};
   target.panels.push(panel);target.panelOrder.push(panelId);
   target.generatedPanels.push({id:panelId,options:Object.fromEntries(Object.entries(panel).filter(([key])=>key!=='id'))});
  }
  let axisChoice=separate?'primary':$('layout-axis')?.value??'primary';if(!separate&&!layoutAxisExplicit&&origin&&panelId!==origin.panel.id&&axisChoice==='primary')axisChoice='independent';
  if(axisChoice.startsWith('axis:'))axisId=axisChoice.slice(5);
  else if(!separate&&axisChoice==='independent'){
   let serial=1;const used=targetIds(target.axes);do{axisId=`${group.id}-axis${serial===1?'':`-${serial}`}`;serial++;}while(used.has(axisId));
   const axis={id:axisId,panel:panelId,label:group.name.toUpperCase(),...await projection(group,'axis')};
   target.axes.push(axis);
   target.generatedAxes.push({id:axisId,panel:panelId,options:Object.fromEntries(Object.entries(axis).filter(([key])=>!['id','panel'].includes(key)))});
  }
  for(const series of group.series){
   const row=target.series.find(item=>item.id===series.id),placement=target.placements.find(item=>item.seriesId===series.id);
   if(row){row.panel=panelId;row.axisId=axisId;}
   if(placement){placement.panelId=panelId;placement.axisId=axisId;}
  }
  await applyTarget(target,{label:separate?'새 지표 패널':'지표 배치'});layoutAxisExplicit=false;
 }
 async function reorderPanel(delta){const frame=await captureFrame(),target=frame.target,id=$('reorder-panel')?.value,index=target.panelOrder.indexOf(id),next=index+delta;if(index<0||next<0||next>=target.panelOrder.length)return;target.panelOrder.splice(index,1);target.panelOrder.splice(next,0,id);await applyTarget(target,{label:'패널 순서'});}
 async function navigateLayout(direction){
  const source=direction==='undo'?layoutUndo:layoutRedo,destination=direction==='undo'?layoutRedo:layoutUndo;if(!source.length)return;
  const record=source.at(-1),[frame,references]=await Promise.all([captureFrame(),session.query('web.layoutReferences')]),current=compactLayoutTarget(frame.target),target=expandLayoutIntent(record.frame,frame.target,references);
  await applyTarget(target,{record:false,label:direction==='undo'?'이전 배치':'다음 배치'});source.pop();destination.push({label:record.label,frame:current});syncLayoutControls();updateDisabled();
 }

 function currentLayoutPreset(){if(!lastLayoutTarget||!configuration)throw new Error('차트 배치가 준비되지 않았습니다.');return captureRustLayoutPreset(layoutCodecConfiguration(configuration),{market:state.market,count:state.count,light:state.light,generatedPanelIds:[...state.generatedPanels],generatedAxisIds:[...state.generatedAxes],panelPins:state.panelPins,axisPins:state.axisPins});}
 function layoutText(){return stringifyRustLayoutPreset(currentLayoutPreset());}
 function graphIdentity(value){const layout=value.layout??value;return safeCheckpointStringify({panels:layout.panels.map(row=>row.id),axes:layout.axes.map(row=>row.id),series:layout.series.map(row=>row.id),indicators:layout.indicators.map(row=>[row.id,row.name])});}
 function orderCanAppend(current,wanted){const wantedSet=new Set(wanted),currentSet=new Set(current),retained=current.filter(id=>wantedSet.has(id)),added=wanted.filter(id=>!currentSet.has(id));return [...retained,...added].every((id,index)=>id===wanted[index])&&retained.length+added.length===wanted.length;}
 async function reconcileIndicators(owner,documentValue){
  let currentConfiguration=await owner.query('web.configuration');const interaction=clone(owner.snapshot().interaction);
  const wanted=new Map(documentValue.indicators.map(row=>[row.id,row])),wantedSeries=new Set(documentValue.target.series.map(row=>row.id)),rebuild=!orderCanAppend(currentConfiguration.series.map(row=>row.id),documentValue.target.series.map(row=>row.id))||!orderCanAppend(currentConfiguration.indicators.map(row=>row.id),documentValue.indicators.map(row=>row.id));
  if(rebuild){
   for(const series of [...currentConfiguration.series].reverse())await owner.command('removeSeries',[series.id]);
   for(const indicator of [...currentConfiguration.indicators].reverse())await owner.command('removeIndicator',[indicator.id]);
  }else{
   for(const series of currentConfiguration.series)if(!wantedSeries.has(series.id))await owner.command('removeSeries',[series.id]);
   for(const indicator of currentConfiguration.indicators)if(!wanted.has(indicator.id))await owner.command('removeIndicator',[indicator.id]);
  }
  currentConfiguration=await owner.query('web.configuration');
  for(const axis of currentConfiguration.axes)if(!documentValue.target.axes.some(row=>row.id===axis.id))await owner.command('removeAxis',[axis.id]);
  for(const panel of currentConfiguration.panels)if(!['price','volume'].includes(panel.id)&&!documentValue.target.panels.some(row=>row.id===panel.id))await owner.command('removePanel',[panel.id]);
  currentConfiguration=await owner.query('web.configuration');
  for(const panel of documentValue.target.panels)if(!currentConfiguration.panels.some(row=>row.id===panel.id))await owner.command('addPanel',[panel]);
  for(const axis of documentValue.target.axes)if(!currentConfiguration.axes.some(row=>row.id===axis.id))await owner.command('addAxis',[axis]);
  const existing=new Map(currentConfiguration.indicators.map(row=>[row.id,row]));
  for(const [id,row] of wanted){
   const old=existing.get(id);
   if(!old)await owner.command('addIndicator',[id,row.name,row.params]);
   else if(safeCheckpointStringify(old.params)!==safeCheckpointStringify(row.params))await owner.setIndicatorParams(id,row.params);
  }
  currentConfiguration=await owner.query('web.configuration');
  for(const series of documentValue.target.series)if(!currentConfiguration.series.some(row=>row.id===series.id))await owner.command('addSeries',[series]);
  if(rebuild){await owner.command('setDrawingTarget',[interaction.drawingTarget??null]);await owner.command('setCrosshairSnap',[interaction.crosshairSnap]);await owner.command('setDrawingMagnet',[interaction.drawingMagnet]);await owner.command('setTool',[interaction.tool]);await owner.command('setText',[interaction.text]);}
  for(const panel of documentValue.target.panels)await owner.command('setPanel',[panel.id,Object.fromEntries(Object.entries(panel).filter(([key])=>key!=='id'))]);
  for(const axis of documentValue.target.axes)await owner.command('setAxis',[axis.id,Object.fromEntries(Object.entries(axis).filter(([key])=>!['id','panel'].includes(key)))]);
  for(const series of documentValue.target.series)await owner.command('setSeries',[series.id,Object.fromEntries(Object.entries(series).filter(([key])=>key!=='id'))]);
  await owner.command('setPanelOrder',[documentValue.target.panels.map(row=>row.id)]);
  return owner.query('web.configuration');
 }
 async function importLayoutText(text,{request=null}={}){
  const next=parseRustLayoutPreset(text),plan=rustLayoutPlan(next);if(request)await assertFileOwner(request);
  const sourceSession=request?.owner.session??session,before={target:await captureCurrentLayout(),generation:sourceSession.generation,drawings:clone(drawings),configuration:clone(configuration)};
  if(request)await assertFileOwner(request);
  const symbol=configuration.symbol??DEMO_SYMBOLS[state.market],snapshot=sourceSession.snapshot(),binding={key:`barochart-demo:${state.market}`,revision:String(snapshot.data.version),adjustmentVersion:'raw-v1',priceUnit:symbol.currency,adjustment:symbol.adjustment??'raw'};
  const token=++job,controller=request?.controller??new AbortController(),localSignal=controller.signal;if(jobController&&jobController!==controller)jobController.abort();jobController=controller;let activated;
  if(memoryTimer!==null){view.clearTimeout(memoryTimer);memoryTimer=null;}
  setBusy(true);stopStream();
  try{
   await sourceSession.withMigrationCapture(binding,{signal:localSignal,onProgress:progress,
    consume:async capture=>{
     const candidate=await backend.createSessionFromMigration(capture,{signal:localSignal,onProgress:progress});
     try{
      const intent={indicators:plan.layout.indicators,target:{panels:plan.layout.panels,axes:plan.layout.axes,series:plan.layout.series}},accepted=layoutCodecConfiguration(await reconcileIndicators(candidate,intent));
      const frame=await candidate.query('web.layoutCapture',[[...state.generatedPanels],[...state.generatedAxes]]),converted=canonicalPresetToRustTarget(frame,next,accepted,{panelPins:state.panelPins,axisPins:state.axisPins});
      await candidate.applyLayoutFrame(converted);await candidate.command('setTheme',[next.light?LIGHT_THEME:DARK_THEME]);
      return candidate;
     }catch(error){await candidate.close().catch(()=>{});throw error;}
    },
    activate:async({value,handoff})=>{
     activated=await install(value,{market:state.market,count:state.count,light:next.light,generatedPanels:plan.managed.panels,generatedAxes:plan.managed.axes,token,closePrevious:false});
     handoff();return activated;
    },
   });
   if(activated?.previousSession&&activated.previousSession!==session)try{await activated.previousSession.close();}catch{status('새 배치는 적용됐지만 이전 Worker 정리를 확인하지 못했습니다.');}
   if(graphIdentity(before.configuration)===graphIdentity(plan.layout)){layoutUndo.push({label:'배치 파일 불러오기',frame:compactLayoutTarget(before.target)});if(layoutUndo.length>30)layoutUndo.shift();}layoutRedo.length=0;
   await refresh();scheduleMemory();status('배치를 불러왔습니다.','chart-layout-status');
  }catch(error){
   if(session===sourceSession&&sourceSession.generation===before.generation){configuration=before.configuration;drawings=before.drawings;await refresh().catch(()=>{});}
   throw error;
  }
  finally{if(token===job){setBusy(false);if(streamIntent)startStream();}}
 }
 function scheduleMemory(){
  if(!rememberEnabled||!lastLayoutTarget||disposed)return;
  if(memoryTimer!==null)view.clearTimeout(memoryTimer);
  memoryTimer=view.setTimeout(()=>{memoryTimer=null;try{view.localStorage?.setItem(RUST_LAYOUT_STORAGE_KEY,stringifyRustLayoutMemory({enabled:true,preset:currentLayoutPreset()}));status('배치를 저장했습니다.','chart-layout-status');}catch{status('레이아웃 저장소를 사용할 수 없습니다.','chart-layout-status');}},300);
 }
 async function restoreRemembered(){if(initialSettled||initialPreferencesChanged)return;let text;try{text=view.localStorage?.getItem(RUST_LAYOUT_STORAGE_KEY);}catch{}if(!text)return;try{const memory=parseRustLayoutMemory(text);rememberEnabled=memory.enabled;if($('remember-chart-layout'))$('remember-chart-layout').checked=rememberEnabled;if(memory.enabled&&memory.preset)await importLayoutText(stringifyRustLayoutPreset(memory.preset));}catch{status('저장된 배치가 유효하지 않아 기본 배치를 사용합니다.','chart-layout-status');}}

 function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');link.href=url;link.download=name;try{link.click();}finally{later(()=>URL.revokeObjectURL(url),1000);}}
 async function importDrawingsText(text,request){
  boundedText(text,MAX_DRAWING_BYTES,'도형 파일은 8 MiB 이하여야 합니다.');await assertFileOwner(request);let committed=false;
  try{
   await request.owner.session.command('loadDrawings',[text]);committed=true;
   if(sameFileOwner(request))try{await refresh();status('도형을 불러왔습니다.');}catch{status('도형은 반영됐지만 화면 갱신을 확인하지 못했습니다. 다시 불러오기 전에 현재 상태를 확인하세요.');}
  }catch(error){if(committed||error?.code==='RESYNC_REQUIRED'||error?.code==='COMMIT_UNCERTAIN'){status('도형 반영 결과를 확정하지 못했습니다. 화면 상태를 확인하세요. 다시 불러오기는 상태 확인 뒤에만 시도하세요.');return;}throw error;}
 }
 async function saveAnalysis(){
  const snapshot=session.snapshot();if(snapshot.data.length>MAX_ANALYSIS_BARS)throw new RangeError('분석 파일 저장은 250,000봉까지 지원합니다.');setBusy(true);
  try{
   const exported=await session.exportColumns({maxBars:MAX_ANALYSIS_BARS}),binding=analysisBinding({...state,revision:exported.version}),workspace=await session.saveWorkspace(binding);
   const columns=Object.fromEntries(FIELDS.map(field=>[field,Array.from(exported.columns[field],encodeAnalysisNumber)]));
   const documentValue={schema:'barochart.demo-analysis',version:1,market:state.market,count:state.count,light:state.light,revision:exported.version,columns,workspace};
   const text=boundedText(JSON.stringify(documentValue),MAX_ANALYSIS_BYTES,'분석 파일은 32 MiB 이하여야 합니다.');
   download(text,'barochart-analysis.json','application/json');status('시세·지표·도형·표시 범위를 분석 파일에 저장했습니다.','analysis-status');
  }
  finally{setBusy(false);}
 }
 async function importAnalysisText(text,request){
  if(!backend.createSessionFromWorkspace)throw new Error('Rust workspace session factory is unavailable');await assertFileOwner(request);
  const token=++job,controller=request.controller,localSignal=controller.signal;if(jobController&&jobController!==controller)jobController.abort();jobController=controller;stopStream();setBusy(true);let next;
  try{
   const saved=readDemoAnalysis(text),store=saved.store,length=store.length,columns=Object.fromEntries(FIELDS.map(field=>[field,new Float64Array(store.columns[field].subarray(0,length))]));
   const source={length,maxBars:store.maxBars,timeframeMs:store.timeframeMs,timeOrigin:store.timeOrigin,version:store.version,timeVersion:store.timeVersion};
   const ownerChart=request.owner.chart,rect=ownerChart?.container?.getBoundingClientRect?.(),width=ownerChart?.lastScene?.width??rect?.width,height=ownerChart?.lastScene?.height??rect?.height;
   if(!Number.isFinite(width)||width<100||!Number.isFinite(height)||height<80)throw new RangeError('복원할 차트의 실제 화면 크기를 확인할 수 없습니다.');
   next=await backend.createSessionFromWorkspace({columns,document:saved.workspace,binding:saved.binding,source,size:{width,height},signal:localSignal,onProgress:progress});
   await assertFileOwner(request);
   await install(next,{market:saved.market,count:saved.count,light:saved.light,generatedPanels:[],generatedAxes:[],token,beforeCommit:()=>assertFileOwner(request)});next=null;streamIntent=false;if($('market'))$('market').value=saved.market;if($('count'))$('count').value=String(saved.count);status('분석을 복원했고 합성 스트림은 일시 정지했습니다.','analysis-status');
  }
  catch(error){await next?.close?.().catch(()=>{});throw error;}finally{if(token===job)setBusy(false);}
 }

 widgets=widgetsFactory({root,getSession:()=>session,getChart:()=>chart,onAddIndicator:addIndicator,onClearIndicators:clearIndicators,onRemoveIndicator:removeIndicator,onMutation:async()=>{cancelFileRequest();await captureCurrentLayout(true);await refresh();},onError:error=>status(friendly(error)),onJob:event=>{if(event?.kind!=='params')return;if(event.active)paramsJobs++;else{paramsJobs=Math.max(0,paramsJobs-1);if(!paramsJobs&&palettePending)void requestPalette();}}});
 function bindControls(){
  listen($('market'),'change',()=>{if(!initialSettled)initialPreferencesChanged=true;void loadMarket();});
  listen($('count'),'change',()=>{if(!initialSettled)initialPreferencesChanged=true;void loadMarket();});
  listen($('cancel-compute'),'click',()=>{cancelFileRequest();jobController?.abort();});
  listen($('fit'),'click',()=>void mutate('fit').catch(error=>status(friendly(error))));
  listen($('recent'),'click',()=>{const length=session?.snapshot()?.data?.length??0;void mutate('setVisibleRange',[Math.max(-.5,length-200.5),length-.5]).catch(error=>status(friendly(error)));});
  listen($('stream'),'click',()=>{streamIntent=!streamIntent;streamIntent?startStream():stopStream();});
  listen($('theme'),'click',()=>{if(!initialSettled){if(initialSession)return;initialPreferencesChanged=true;state.light=!state.light;if(autoPublish)document.documentElement?.setAttribute?.('data-chart-theme',state.light?'light':'dark');$('theme')?.setAttribute('aria-pressed',String(state.light));void loadMarket();return;}void (async()=>{const previous=state.light;state.light=!state.light;try{await mutate('setTheme',[state.light?LIGHT_THEME:DARK_THEME]);if(autoPublish)document.documentElement?.setAttribute?.('data-chart-theme',state.light?'light':'dark');$('theme')?.setAttribute('aria-pressed',String(state.light));palettePending=true;await requestPalette();}catch(error){state.light=previous;throw error;}})().catch(error=>status(friendly(error)));});
  listen($('renderer'),'change',()=>{cancelFileRequest();void chart?.replaceRenderer($('renderer').value).then(()=>widgets.refresh(),error=>status(friendly(error)));});
  listen($('series'),'change',()=>void mutate('setSeries',['price',{type:$('series').value}]).catch(error=>status(friendly(error))));
  listen($('scale'),'change',()=>void withLayoutMutation(async()=>{await mutate('setPanel',['price',{scale:$('scale').value}]);await resetLayoutHistoryToCurrent();}).catch(error=>status(friendly(error))));
  listen($('crosshair-snap'),'change',()=>{const value={mode:$('crosshair-snap').value};void updateInputPreference('crosshairSnap',value,'setCrosshairSnap',[value]).catch(error=>status(friendly(error)));});
  listen($('magnet'),'change',()=>{const value={mode:$('magnet').value};void updateInputPreference('drawingMagnet',value,'setDrawingMagnet',[value]).catch(error=>status(friendly(error)));});
  listen($('annotation'),'input',()=>void updateInputPreference('text',$('annotation').value,'setText',[$('annotation').value]).catch(error=>status(friendly(error))));
  for(const button of root.querySelectorAll('[data-tool]'))listen(button,'click',()=>void updateInputPreference('tool',button.dataset.tool,'setTool',[button.dataset.tool]).catch(error=>status(friendly(error))));
  listen($('undo'),'click',()=>void mutate('undo').catch(error=>status(friendly(error))));
  listen($('redo'),'click',()=>void mutate('redo').catch(error=>status(friendly(error))));
  listen($('delete'),'click',()=>void mutate('deleteDrawing',[drawings?.selected]).catch(error=>status(friendly(error))));
  listen($('lock'),'click',()=>{const row=drawings?.items?.find(item=>item.id===drawings.selected);if(row)void mutate('editDrawing',[row.id,{locked:!row.locked}]).catch(error=>status(friendly(error)));});
  listen($('save'),'click',()=>void session?.command('saveDrawings').then(text=>{download(text,'aster-drawings.json','application/json');status('도형을 저장했습니다.');},error=>status(friendly(error))));
  listen($('load'),'click',()=>$('file')?.click());
  listen($('file'),'change',event=>void handleFileSelection(event,{kind:'drawings',maxBytes:MAX_DRAWING_BYTES,sizeMessage:'도형 파일은 8 MiB 이하여야 합니다.',apply:importDrawingsText}));
  listen($('layout-indicator'),'change',()=>{layoutAxisExplicit=false;const group=indicatorGroups().find(row=>row.id===$('layout-indicator')?.value),origin=group&&groupOrigin(group);if(origin&&$('layout-panel'))$('layout-panel').value=origin.panel.id;syncLayoutControls();});
  listen($('layout-panel'),'change',()=>{layoutAxisExplicit=false;syncLayoutControls();});
  listen($('layout-axis'),'change',()=>{layoutAxisExplicit=true;});
  listen($('apply-indicator-placement'),'click',()=>void withLayoutMutation(()=>placeIndicator()).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('separate-indicator-panel'),'click',()=>void withLayoutMutation(()=>placeIndicator({separate:true})).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('panel-up'),'click',()=>void withLayoutMutation(()=>reorderPanel(-1)).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('panel-down'),'click',()=>void withLayoutMutation(()=>reorderPanel(1)).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('layout-undo'),'click',()=>void withLayoutMutation(()=>navigateLayout('undo')).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('layout-redo'),'click',()=>void withLayoutMutation(()=>navigateLayout('redo')).catch(error=>status(friendly(error),'indicator-layout-status')));
  listen($('save-chart-layout'),'click',()=>{try{download(layoutText(),'barochart-layout.json','application/json');status('배치를 저장했습니다.','chart-layout-status');}catch(error){status(friendly(error),'chart-layout-status');}});
  listen($('load-chart-layout'),'click',()=>$('chart-layout-file')?.click());
  listen($('chart-layout-file'),'change',event=>void handleFileSelection(event,{kind:'layout',maxBytes:MAX_RUST_LAYOUT_BYTES,sizeMessage:'배치 파일은 512 KiB 이하여야 합니다.',statusId:'chart-layout-status',apply:(text,request)=>importLayoutText(text,{request})}));
  listen($('remember-chart-layout'),'change',()=>{rememberEnabled=!!$('remember-chart-layout').checked;try{view.localStorage?.setItem(RUST_LAYOUT_STORAGE_KEY,stringifyRustLayoutMemory({enabled:rememberEnabled,preset:rememberEnabled&&lastLayoutTarget?currentLayoutPreset():null}));if(rememberEnabled)scheduleMemory();}catch{status('레이아웃 저장소를 사용할 수 없습니다.','chart-layout-status');}});
  listen($('forget-chart-layout'),'click',()=>{try{view.localStorage?.setItem(RUST_LAYOUT_STORAGE_KEY,stringifyRustLayoutMemory({enabled:false,preset:null}));rememberEnabled=false;if($('remember-chart-layout'))$('remember-chart-layout').checked=false;status('저장된 배치를 지웠습니다.','chart-layout-status');}catch{status('저장된 배치를 지우지 못했습니다.','chart-layout-status');}});
  listen($('save-analysis'),'click',()=>void saveAnalysis().catch(error=>status(friendly(error),'analysis-status')));
  listen($('load-analysis'),'click',()=>$('analysis-file')?.click());
  listen($('analysis-file'),'change',event=>void handleFileSelection(event,{kind:'analysis',maxBytes:MAX_ANALYSIS_BYTES,sizeMessage:'분석 파일은 32 MiB 이하여야 합니다.',statusId:'analysis-status',apply:importAnalysisText}));
  listen($('open-drawing-manager'),'click',()=>{if($('drawing-manager'))$('drawing-manager').open=true;});
 }
 bindControls();
 const onResize=()=>layoutPanels(),onPageHide=event=>{if(event.persisted)pause();else void dispose();},onPageShow=event=>{if(event.persisted)resume();},onVisibility=()=>{if(document.hidden)stopStream();else if(streamIntent)startStream();};
 listen(view,'resize',onResize);listen(view,'pagehide',onPageHide);listen(view,'pageshow',onPageShow);listen(document,'visibilitychange',onVisibility);
 statsTimer=view.setInterval(()=>{const metrics=chart?.renderMetrics,stats=chart?.lastScene?.stats;if(!metrics||!stats)return;setText('stats',`${chart.rendererKind} · 저장 ${Number(stats.storedBars??0).toLocaleString()} · 표시 원본 ${Number(stats.visibleSourceBars??0).toLocaleString()} · 버킷 ${stats.renderedCandleBuckets??0} · 제출 ${finite(metrics.elapsedMs).toFixed(2)}ms`);},500);

 function pause(){if(disposed)return;cancelFileRequest();paused=true;pageActive=false;++job;jobController?.abort();stopStream();setBusy(false);}
 function resume(){if(disposed)return;paused=false;pageActive=true;chart?.resize();chart?.invalidate();if(!session)void loadMarket();else if(streamIntent)startStream();updateDisabled();}
 async function dispose(){
  if(disposePromise)return disposePromise;
  cancelFileRequest();disposed=true;pageActive=false;paused=true;++job;jobController?.abort();stopStream();settleInitial(new DOMException('Rust demo mount disposed','AbortError'));
  if(statsTimer!==null)view.clearInterval(statsTimer);if(memoryTimer!==null)view.clearTimeout(memoryTimer);
  for(const id of timeouts)view.clearTimeout(id);timeouts.clear();
  for(const [node,type,handler,options] of listeners)node.removeEventListener?.(type,handler,options);
  listeners.length=0;unsubscribe?.();widgets?.dispose();if(view.aster?.session===session)delete view.aster;
  disposePromise=(async()=>{try{await chart?.destroy?.();}finally{await session?.close?.();}})().catch(()=>{});return disposePromise;
 }

 if($('market'))$('market').value=state.market;if($('count'))$('count').value=String(state.count);if($('theme'))$('theme').setAttribute('aria-pressed',String(state.light));if($('remember-chart-layout'))$('remember-chart-layout').checked=rememberEnabled;
 let initializing=true;
 const abortMount=()=>{if(!initializing)return;jobController?.abort();void dispose();};
 signal?.addEventListener('abort',abortMount,{once:true});
 try{
  if(initialSession){const token=++job;setBusy(true);await install(initialSession,{...state,layoutHistoryState:initialState?.layoutHistory??null,token});setBusy(false);settleInitial();}
  else void loadMarket();
  await initialReady;
  if(disposed||signal?.aborted)throw new DOMException('Rust demo mount aborted','AbortError');
  if(!session||!chart)throw lastLoadError??new Error('Rust demo did not produce an initial chart');
 }catch(error){await dispose();throw error;}
 finally{initializing=false;signal?.removeEventListener('abort',abortMount);}
 return Object.freeze({backend:'rust-wasm',get session(){return session;},get chart(){return chart;},get state(){return currentState();},pause,resume,dispose,publish:publishCurrent,refresh,load:loadMarket});
}
