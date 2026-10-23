import {BarStore, ChartModel, ChartAPI,InteractionController,createLayout, CanvasChart, createChart, WebGLRenderer, drawingPointCount, seededColumns, IndicatorEngine, applyDataEvent, TickAggregator, demoCalendar, prepareChartModel,recomputeInWorker,RESOURCE_LIMITS,type Bar,type Axis,type AxisPatch,type DrawingTarget,type CrosshairValues} from '../src/index.mjs';
const store = new BarStore(); store.setColumns(seededColumns(1000));
const model = new ChartModel({store,panels:[{id:'price',scale:'linear'}]});
model.addSeries({id:'p',type:'candles',panel:'price'});
const engine = new IndicatorEngine(store);
const axis:Axis={id:'foreign',panel:'price',side:'left',scale:'percent',base:100,precision:5,prefix:'$',suffix:' USD',tickFormat:'scientific'};
model.addAxis(axis);const axisPatch:AxisPatch={range:null,precision:4};
const controller=new InteractionController(model,()=>({width:1200,height:700}));const api=new ChartAPI(model,{controller});api.setAxis('foreign',axisPatch);
const panelOrderChanged:boolean=api.setPanelOrder(['price']);const placementChanged:{changed:number}=api.setIndicatorPlacement('ema',{panel:'price',axisId:null});void [panelOrderChanged,placementChanged];
// @ts-expect-error indicator placement axis identifiers are strings or null
api.setIndicatorPlacement('ema',{panel:'price',axisId:7});
model.addSeries({id:'f',type:'line',panel:'price',axisId:'foreign',symbolId:'FOREIGN',label:'Aligned foreign',values:new Float64Array(store.length)});
api.setSeries('f',{axisId:null,label:'Primary scale'});const target:DrawingTarget={panel:'price',seriesId:'f',axisId:null};api.setDrawingTarget(target);controller.setDrawingTarget(null);
const crosshair:CrosshairValues|null=api.crosshairValues(1200,700);crosshair?.series.forEach(s=>{s.label.toUpperCase();s.value?.toFixed();s.sourceTime?.toFixed();s.axisId?.toUpperCase();});crosshair?.axes.forEach(a=>a.formatted.toUpperCase());
const layout=createLayout(model,1200,700);layout.axis('price','foreign')?.transform(100);layout.axis('price',null)?.axisLeft.toFixed();layout.toScreen({time:1,price:100},'price','foreign');layout.fromScreen(100,100,'price',null);
api.addDrawing({type:'horizontal',panel:'price',axisId:null,seriesId:'f',points:[{time:1,price:100}]});api.inspect().axes[0].side?.toUpperCase();api.inspect().drawingTarget?.panel.toUpperCase();
model.drawings.load('{"schema":"aster.drawings","version":1,"drawings":[]}',{validateBinding:d=>model.validateDrawingBinding(d,{allowOrphanSeries:true})});RESOURCE_LIMITS.maxAxes.toFixed();
// @ts-expect-error independent axis cannot move to another panel through a patch
api.setAxis('foreign',{panel:'osc'});
// @ts-expect-error unsupported axis tick format
model.addAxis({id:'invalid',panel:'price',tickFormat:'currency'});
// @ts-expect-error drawing target identifier types are strings
api.setDrawingTarget({panel:'price',axisId:7});
// @ts-expect-error panel axis side uses left/right
model.setPanel('price',{axisSide:'center'});
engine.register('custom',()=>({outputs:['value'],create(){let sum=0;return {step(b){sum+=b.close;return [sum]},snapshot:()=>sum,restore:s=>{sum=s;}}}}));
applyDataEvent(store,{kind:'reset',bars:[]});
const bar:Bar={time:1,open:1,high:2,low:0,close:1,volume:0};store.append(bar);
const ticks=new TickAggregator({calendar:demoCalendar('crypto'),latePolicy:'correct'});ticks.push({time:1,price:1e-12,volume:1});
if (typeof document !== 'undefined') {
 const chart=createChart(document.body,model,{renderer:'webgl2',onFallback:reason=>reason.toUpperCase()});
 const kind:'canvas'|'webgl2'=chart.rendererKind;
 chart.fallbackReason?.toUpperCase();chart.setTool('channel');chart.destroy();
 chart.api.setTheme({font:'bold 18px sans-serif'});
 chart.api.addIndicator('trend','supertrend',{period:10}).outputs.includes('value');
 chart.api.setSeries('p',{visible:false});chart.api.setText('한국 🚀');
 // @ts-expect-error OHLC rows must retain numeric UTC milliseconds
 chart.api.setData([{time:'invalid',open:1,high:2,low:0,close:1,volume:1}]);
 const renderer=new WebGLRenderer(document.createElement('canvas'));
 renderer.metrics?.screenBufferBytes.toFixed();renderer.dispose();
 new CanvasChart(document.body,model,{onFallback:reason=>reason.length}).destroy({disposeModel:true});
}
model.indicators.add('cloud','ichimoku',{displacement:26}).plotOffsets.spanA.toFixed();
drawingPointCount('fibextension');
// @ts-expect-error unsupported renderer is intentionally rejected
createChart(document.body,model,{renderer:'metal'});
// @ts-expect-error invalid drawing tool is intentionally rejected
model.drawings.add({type:'invalid',points:[{time:1,price:2}]});

async function workerContract(columns:ReturnType<typeof seededColumns>,controller:AbortController) {
 const m=await prepareChartModel({columns,options:{axes:[axis],indicators:[{id:'e',name:'ema',params:{period:20}}],series:[{id:'e',type:'line',panel:'price',indicator:'e',axisId:'foreign',label:'EMA'}]}},{signal:controller.signal,onProgress:p=>p.phase.toUpperCase()});
 await recomputeInWorker(m,{kind:'correction',bar},{timeoutMs:30000});
 new BarStore([],{maxBars:RESOURCE_LIMITS.maxBars,onListenerError:(error,change)=>change.from.toFixed()});
}

const changedStudy=api.setIndicatorParams('ema',{period:50});
changedStudy.outputs[0].toUpperCase();changedStudy.plotOffsets.value?.toFixed();
// @ts-expect-error indicator params remain number/string primitives
api.setIndicatorParams('ema',{period:true});

// Explicit session resampling and decision-time alignment.
import {resampleOHLCV,alignConfirmedByTime,SessionCalendar as ResampleCalendar,type ResampledOHLCV} from '../src/core/index.mjs';
const resampleColumns={time:new Float64Array(),open:new Float64Array(),high:new Float64Array(),low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};
const resampleOptions={sourceIntervalMs:60000,targetIntervalMs:300000,calendar:new ResampleCalendar('UTC',()=>[{open:'00:00',close:'00:00'}]),kinds:['regular'] as const,asOf:0,partialTarget:'reject' as const};
const resampled:ResampledOHLCV=resampleOHLCV({columns:resampleColumns,length:0},resampleOptions);
const confirmedAligned:Float64Array=alignConfirmedByTime([0],resampled.columns.close,resampled);
void confirmedAligned;
// @ts-expect-error partialTarget policy is mandatory
resampleOHLCV({columns:resampleColumns,length:0},{sourceIntervalMs:60000,targetIntervalMs:300000,calendar:resampleOptions.calendar,kinds:['regular'],asOf:0});
// @ts-expect-error values must preserve Float64 representation
alignConfirmedByTime([0],[1],resampled);

import {resampleOHLCVAsync,type AsyncResampleOptions} from '../src/index.mjs';
const asyncResampleConfig:AsyncResampleOptions={...resampleOptions,signal:new AbortController().signal,workerFactory:url=>new Worker(url,{type:'module'})};
const resampleJob:Promise<ResampledOHLCV>=resampleOHLCVAsync({kind:'immutable-columns',columns:resampleColumns,length:0},asyncResampleConfig);
void resampleJob;
// @ts-expect-error explicit input ownership mode required
resampleOHLCVAsync({columns:resampleColumns,length:0},asyncResampleConfig);
// @ts-expect-error async options retain mandatory partial-target policy
resampleOHLCVAsync({kind:'immutable-columns',columns:resampleColumns,length:0},{sourceIntervalMs:60000,targetIntervalMs:300000,calendar:resampleOptions.calendar,kinds:['regular'],asOf:0});

import {setIndicatorParamsAsync, type AsyncIndicatorParamsResult} from '../src/index.mjs';
import {setIndicatorParamsAsync as workerSetParams} from '../src/web/worker.mjs';
const asyncParamResult:Promise<AsyncIndicatorParamsResult>=setIndicatorParamsAsync(new ChartAPI(new ChartModel()),'ema',{period:10},{signal:new AbortController().signal,onProgress:p=>{const phase:'snapshot'|'compute'|'validate'=p.phase;void phase;},onObserverError:error=>{const message:string=error.message;void message;}});
void asyncParamResult;void workerSetParams;

// Portable workspace preparation is explicit about external data identity.
import {saveWorkspace,prepareWorkspaceAsync, type WorkspaceDatasetBinding} from '../src/index.mjs';
const workspaceBinding:WorkspaceDatasetBinding={key:'venue/symbol/1m',revision:'42',adjustmentVersion:'1',priceUnit:'USD',adjustment:'raw'};
const workspaceModel=new ChartModel();
const workspaceAPI=new ChartAPI(workspaceModel);
const workspaceText:string=saveWorkspace(workspaceAPI,workspaceBinding);
import {saveBoundDrawings,loadBoundDrawings,type DrawingIdentity} from '../src/index.mjs';
const drawingIdentity:DrawingIdentity={symbolId:'TEST',exchange:'VENUE',priceUnit:'USD',timeframe:'1m',adjustment:'raw',adjustmentVersion:'raw-v1'};
const boundDrawingText:string=saveBoundDrawings(workspaceAPI,drawingIdentity);
const boundDrawingResult:void=loadBoundDrawings(workspaceAPI,boundDrawingText,drawingIdentity);
// @ts-expect-error missing explicit destination identity
loadBoundDrawings(workspaceAPI,boundDrawingText);
// @ts-expect-error unknown adjustment mode
saveBoundDrawings(workspaceAPI,{...drawingIdentity,adjustment:'unknown'});
const workspaceReady:Promise<ChartModel>=prepareWorkspaceAsync(workspaceModel.store,workspaceText,{datasetBinding:workspaceBinding});

import type {DataSnapshot,DataSeriesValue} from '../src/core/index.mjs';
const explored:DataSnapshot|null=api.dataAt({time:1700000000000,match:'at-or-before'},{asOfIndex:0,includeHidden:true});
const row:DataSeriesValue|undefined=explored?.series[0];
api.dataAt({index:0});void row;
// @ts-expect-error timestamp matching policy must be explicit
api.dataAt({time:0});
// @ts-expect-error index and timestamp selection are mutually exclusive
api.dataAt({index:0,time:0,match:'exact'});
// @ts-expect-error cutoff is an integer index, not a date string
api.dataAt({index:0},{asOfIndex:'today'});

{
 const readout=document.createElement('div'),live=document.createElement('div'),button=document.createElement('button');
 const chart=createChart(document.body,new ChartModel(),{dataExplorer:{readout,live,controls:[button]}});
 const state=chart.setDataExploration(true);const selectedTime:number|null=state.time;
 chart.readExploration().text.toUpperCase();chart.dataExploration.phase;chart.setDataExploration(false);
 // @ts-expect-error mode is explicitly boolean
 chart.setDataExploration('true');
 // @ts-expect-error output elements must be DOM elements
 new CanvasChart(document.body,new ChartModel(),{dataExplorer:{readout:'text',live}});
 void selectedTime;
}
const styleReceipt=api.setDrawingsStyle(['text'],{color:'#abc',fill:'#def',width:2,font:'24px monospace'});styleReceipt.changed.toFixed();styleReceipt.invalidationFailed.valueOf();
// @ts-expect-error batch style does not accept lock or coordinate changes
api.setDrawingsStyle(['text'],{locked:true});
// @ts-expect-error explicit null is not a batch style reset
api.setDrawingsStyle(['text'],{fill:null});

import {DrawingSelectionController,attachDrawingPanel,type DrawingSelectionSnapshot} from '../src/index.mjs';
const groups=new DrawingSelectionController(api);const groupState:DrawingSelectionSnapshot=groups.snapshot({offset:0,limit:32});groupState.rows.forEach(row=>row.id.toUpperCase());groups.dispose();
const externalPanel=attachDrawingPanel(document.createElement('div'),{} as CanvasChart,{label:'Drawing controls'});externalPanel.destroy();
// @ts-expect-error group selection is explicit string identifiers
groups.select(42);

// Direct JavaScript optional final-state publication suppression.
const unchangedOption: Parameters<import("../src/core/index.mjs").ChartAPI["applyDataEvents"]>[1] = {skipUnchanged:true};
void unchangedOption;

import type {DrawingMagnetOptions} from '../src/index.mjs';
const magnetOptions:DrawingMagnetOptions={mode:'weak',radiusPx:12};
api.setDrawingMagnet(magnetOptions);controller.setDrawingMagnet({mode:'strong'});
const magnetMode:'off'|'weak'|'strong'=controller.drawingMagnet.mode;
controller.drawingMagnet.radiusPx.toFixed();void magnetMode;
// @ts-expect-error unknown mode
api.setDrawingMagnet({mode:'always'});
// @ts-expect-error radius is numeric
controller.setDrawingMagnet({mode:'weak',radiusPx:'8'});
// @ts-expect-error configuration is read-only
controller.drawingMagnet.mode='off';

import type {CrosshairSnapOptions,CrosshairSnapshot} from '../src/index.mjs';
const cursorOptions:CrosshairSnapOptions={mode:'ohlc',target:{panel:'price',axisId:'foreign'}};
api.setCrosshairSnap(cursorOptions);controller.setCrosshairSnap({mode:'close'});
const cursorSnapshot:CrosshairSnapshot|null=api.crosshairSnapshot(1200,700);
cursorSnapshot?.field?.toUpperCase();cursorSnapshot?.price?.toFixed();cursorSnapshot?.raw.x.toFixed();
// @ts-expect-error snap mode differs from drawing magnet modes
api.setCrosshairSnap({mode:'strong'});
// @ts-expect-error no implicit target identifier coercion
controller.setCrosshairSnap({mode:'close',target:{panel:3}});
// @ts-expect-error setting is read-only
controller.crosshairSnap.mode='free';
const positionId=api.addDrawing({type:'longposition',points:[{time:1,price:100},{time:1,price:95},{time:1,price:110},{time:2,price:100}]});
const positionRatio:number=api.positionMetrics(positionId).ratio;
const positionPercent:number|null=api.positionMetrics(positionId).riskPercent;
api.setTool('shortposition');

const visibilityReceipt:{changed:number;invalidationFailed:boolean}=api.setDrawingVisibility('text',false);
api.setDrawingsVisibility(['text'] as const,true);visibilityReceipt.changed.toFixed();
api.addDrawing({type:'horizontal',visible:false,points:[{time:1,price:1}]});
api.editDrawing('text',{visible:true});
groups.setVisibility(false);groups.setRowVisibility(groupState.rows[0],true);groupState.rows[0].visible.valueOf();
// @ts-expect-error visibility is a boolean, not a mode
api.setDrawingVisibility('text','hidden');
// @ts-expect-error explicit array required
api.setDrawingsVisibility('text',false);
// @ts-expect-error Drawing visibility cannot be null
api.editDrawing('text',{visible:null});

import type {DrawingDuplicateReceipt,DrawingDuplicateOptions} from '../src/index.mjs';
const copyOptions:DrawingDuplicateOptions={deltaTimeMs:.5,deltaPrice:2};
const copied:DrawingDuplicateReceipt=api.duplicateDrawing('text',copyOptions);
api.duplicateDrawings(['text'] as const,copyOptions);groups.duplicate(copyOptions);
copied.created[0].sourceId.toUpperCase();copied.created[0].id.toUpperCase();
// @ts-expect-error both offsets required
api.duplicateDrawing('text',{deltaPrice:1});
// @ts-expect-error copy receipt is immutable
copied.created[0].id='other';
// @ts-expect-error readonly created collection
copied.created.push({sourceId:'a',id:'b'});

import {DrawingStylePresets,type DrawingStylePreset,type DrawingStylePatch} from '../src/index.mjs';
const presets=new DrawingStylePresets(),stylePatch:DrawingStylePatch={color:'red',width:2};
presets.set('Alert',stylePatch);presets.capture(api,'text','Saved',{replace:true});
const preset:DrawingStylePreset|undefined=presets.get('Alert');presets.list().forEach(p=>p.name.toUpperCase());
presets.apply(api,['text'],'Alert').changed.toFixed();presets.load(presets.save(),{replace:true});presets.remove('Saved');
const presetPanel=attachDrawingPanel(document.createElement('div'),{} as CanvasChart,{stylePresets:presets});
presetPanel.selection.captureStylePreset(presets,'Saved');presetPanel.selection.applyStylePreset(presets,'Alert');presetPanel.destroy();
// @ts-expect-error presets contain styles only
presets.set('Bad',{locked:true});
// @ts-expect-error null does not clear a style field
presets.set('Bad',{fill:null});
// @ts-expect-error preset metadata is immutable
if(preset)preset.style.width=4;
// @ts-expect-error replacement requires an explicit boolean
presets.load('{}',{replace:'yes'});

import {BarReplay,type BarReplayFrame,type BarReplayReceipt} from '../src/index.mjs';
const replay=new BarReplay([] as readonly Bar[],{initialCount:0,visibleBars:200,priceScale:'log',indicators:[{id:'e',kind:'ema',period:20}]});
const replayReceipt:BarReplayReceipt=replay.start();replayReceipt.state.lastTime?.toFixed();replay.step(2);replay.pause();replay.seek(0);replay.reset();
const replayFrame:BarReplayFrame=replay.frame(800,480);replayFrame.axes[0]?.min.toFixed();replay.indicatorValues('e').buffer;replay.barAt(0).close.toFixed();replay.dispose();
// @ts-expect-error replay has no mutable model escape
replay.model;
// @ts-expect-error only canonical bounded studies are available
new BarReplay([],{indicators:[{id:'w',kind:'wma',period:20}]});
// @ts-expect-error snapshot fields are read-only
replayReceipt.state.count=3;
// @ts-expect-error replay accepts no live model
new BarReplay([],{model});

import {renderCanvas as renderReplayCanvas} from '../src/index.mjs';
declare const replayContext:CanvasRenderingContext2D;renderReplayCanvas(replayContext,replayFrame);

import {saveChartUI,readChartUI,type ChartUIConfiguration} from '../src/index.mjs';
const portableUI:ChartUIConfiguration=readChartUI(saveChartUI({interaction:{wheelZoom:false},toolbar:{tools:['select','text'],actions:[]}}));
portableUI.interaction.hitTolerancePx.toFixed();
// @ts-expect-error persisted UI is immutable
portableUI.interaction.pointer=false;
// @ts-expect-error transient toolbar state is not persisted
saveChartUI({toolbar:{activeTool:'select'}});
// @ts-expect-error UI preferences do not accept DOM or host placement
saveChartUI({placement:'left'});

import {createChartUIPreset} from '../src/index.mjs';
const mobileUI:ChartUIConfiguration=createChartUIPreset('mobile');saveChartUI(mobileUI);
// @ts-expect-error presets are explicit and bounded
createChartUIPreset('automatic');

import {attachChartToolbar as attachPresetToolbar,CanvasChart as PresetChart} from '../src/index.mjs';
declare const mobilePresetHost:HTMLElement, mobilePresetChart:PresetChart;
attachPresetToolbar(mobilePresetHost,mobilePresetChart,createChartUIPreset('mobile').toolbar);

import {attachChartOverlays} from '../src/index.mjs';
const overlaySlots=attachChartOverlays(mobilePresetHost,mobilePresetChart,{label:'Study controls'});overlaySlots.slots.topRight.append(document.createElement('button'));overlaySlots.destroy();
// @ts-expect-error slots are fixed, not arbitrary docking positions
overlaySlots.slots.center;

import {attachChartNavigator,type ChartNavigatorState} from '../src/index.mjs';
const navigator=attachChartNavigator(mobilePresetHost,mobilePresetChart,{label:'History range'});
const navigatorState:ChartNavigatorState=navigator.snapshot();navigatorState.from.toFixed();navigator.refresh();navigator.destroy();
// @ts-expect-error effective range snapshots are immutable
navigatorState.from=1;

const replayForSession = new BarReplay([]);
const replayBookmark = replayForSession.addBookmark({id:'point',label:'Point'});
replayForSession.renameBookmark(replayBookmark.id,'Renamed');
replayForSession.seekBookmark(replayBookmark.id);
const replaySessionBinding = {key:'example',revision:'1',adjustmentVersion:'1',priceUnit:'USD',adjustment:'raw' as const};
const resumedReplay = BarReplay.restoreSession([],replayForSession.saveSession(replaySessionBinding),{datasetBinding:replaySessionBinding});
resumedReplay.bookmarks().forEach(b=>b.count.toFixed());
// @ts-expect-error bookmarks cannot specify future positions
replayForSession.addBookmark({id:'future',label:'Future',count:10});
// @ts-expect-error independently supplied dataset binding is required
BarReplay.restoreSession([],replayForSession.saveSession(replaySessionBinding));
// @ts-expect-error immutable bookmark metadata
replayBookmark.count = 3;
resumedReplay.dispose();replayForSession.dispose();

import {attachTradeMarkers,type TradeMarker,type TradeMarkerState} from '../src/index.mjs';
const hostTradeMarker:TradeMarker={id:'fill',tradeID:'external',time:1000,price:12,panel:'price',side:'buy'};
const tradeMarkers=attachTradeMarkers(mobilePresetHost,mobilePresetChart,{markers:[hostTradeMarker],onSelect:marker=>marker.tradeID.toUpperCase()});
const markerStates:readonly TradeMarkerState[]=tradeMarkers.snapshot();
tradeMarkers.setMarkers([]);tradeMarkers.refresh();tradeMarkers.destroy();
// @ts-expect-error external trade identity is required
const missingTradeID:TradeMarker={id:'fill',time:1000,price:12,panel:'price'};
// @ts-expect-error selection records are readonly
markerStates[0].marker.price=5;
void missingTradeID;
