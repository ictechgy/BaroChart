import {BarStore,ChartModel,ChartAPI,InteractionController,drawingGeometry,drawingPointCount,createLayout,alignSeriesByTime,type Axis,type AxisPatch,type AxisLayout,type DrawingTarget,type CrosshairValues} from 'barochart/core';
import {CanvasChart,renderCanvas} from 'barochart/canvas';
import {GPUChart,WebGLRenderer,createChart} from 'barochart/webgl';
import {prepareChartModel,recomputeInWorker,runChartWorker,type WorkerRequest} from 'barochart/worker';
import type {Columns,Drawing,Scene} from 'barochart';
const model=new ChartModel({store:new BarStore()});
const axis:Axis={id:'usd',panel:'price',side:'right',scale:'linear',prefix:'$',precision:2};model.addAxis(axis);
const patch:AxisPatch={range:[1,10],base:null};const input=new InteractionController(model,()=>({width:800,height:600})),api=new ChartAPI(model,{controller:input});api.setAxis('usd',patch);
const target:DrawingTarget={panel:'price',axisId:'usd'};api.setDrawingTarget(target);const hover:CrosshairValues|null=api.crosshairValues(800,600);hover?.axes[0].formatted.toLowerCase();
const domain:AxisLayout|undefined=createLayout(model,800,600).axis('price','usd');domain?.inverse(1);domain?.base.toFixed();api.setDrawingTarget(null);
const drawing:Drawing={id:'t',type:'trendline',panel:'price',points:[{time:1,price:1},{time:2,price:2}]};
const aligned:Float64Array=alignSeriesByTime([1,2],[{time:2,value:100}]);
const count:number=drawingPointCount(drawing.type);
const commands:Scene['commands']=drawingGeometry(drawing,createLayout(model,800,600));
const request:WorkerRequest={columns:{} as Columns,options:{axes:[axis],indicators:[{id:'e',name:'ema',params:{period:20}}],series:[{id:'e',type:'line',panel:'price',axisId:'usd',label:'Trend',indicator:'e'}]}};
const raw:Promise<unknown>=runChartWorker(request,{timeoutMs:30000});
const prepared:Promise<ChartModel>=prepareChartModel(request);
const revised:Promise<ChartModel>=recomputeInWorker(model,{kind:'reset',bars:[]});
if(typeof document!=='undefined'){
 const canvas=document.createElement('canvas');renderCanvas(canvas.getContext('2d')!,{} as Scene);
 new CanvasChart(document.body,model).destroy();new GPUChart(document.body,model).destroy();
 new WebGLRenderer(canvas).dispose();createChart(document.body,model,{renderer:'auto'}).destroy();
}
void [aligned,count,commands,raw,prepared,revised];

import {saveWorkspace,type WorkspaceDatasetBinding} from 'barochart/core';
import {prepareWorkspaceAsync,type AsyncWorkspaceOptions} from 'barochart/worker';
const workspaceBinding:WorkspaceDatasetBinding={key:'feed/symbol/1m',revision:'1',adjustmentVersion:'1',priceUnit:'USD',adjustment:'raw'};
const workspaceOptions:AsyncWorkspaceOptions={datasetBinding:workspaceBinding};
const workspaceDocument:string=saveWorkspace(api,workspaceBinding);
import {saveBoundDrawings,loadBoundDrawings,type DrawingIdentity} from 'barochart/core';
const drawingIdentity:DrawingIdentity={symbolId:'TEST',exchange:'VENUE',priceUnit:'USD',timeframe:'1m',adjustment:'raw',adjustmentVersion:'raw-v1'};
const boundDrawingDocument:string=saveBoundDrawings(api,drawingIdentity);
const boundDrawingResult:void=loadBoundDrawings(api,boundDrawingDocument,drawingIdentity);
// @ts-expect-error explicit identity is required
saveBoundDrawings(api);
const workspacePrepared:Promise<ChartModel>=prepareWorkspaceAsync(model.store,workspaceDocument,workspaceOptions);

import {TimeCursorGroup,type TimeCursorState} from 'barochart/canvas';
const linkedCursors=new TimeCursorGroup({match:'exact'});
if(typeof document!=='undefined'){
 const linkedChart=new CanvasChart(document.body,new ChartModel());
 const unlink:()=>void=linkedCursors.add(linkedChart);
 const cursorSnapshot:TimeCursorState|null=linkedChart.timeCursor;
 cursorSnapshot?.requestedTime.toFixed();unlink();linkedChart.destroy({disposeModel:true});
}
linkedCursors.dispose();
// @ts-expect-error policy is explicit, not nearest
new TimeCursorGroup({match:'nearest'});
// @ts-expect-error policy is required
new TimeCursorGroup();
const groupReceipt:{changed:number;invalidationFailed:boolean}=api.translateDrawings(['t'] as const,{deltaTimeMs:.5,deltaPrice:2});
groupReceipt.changed.toFixed();
// @ts-expect-error both raw deltas are explicit
api.translateDrawings(['t'],{deltaPrice:1});
const deleteReceipt:{changed:number;invalidationFailed:boolean}=api.deleteDrawings(['t'] as const);
deleteReceipt.changed.toFixed();
// @ts-expect-error an explicit ID array is required
api.deleteDrawings('t');
import {TimeRangeGroup,type TimeRangeState} from 'barochart/canvas';
const ranges=new TimeRangeGroup({mode:'view',missing:'clip'});
if(typeof document!=='undefined'){
 const rangeChart=new CanvasChart(document.body,new ChartModel());
 const leaveRange:()=>void=ranges.add(rangeChart,{publish:true,receive:true});
 const result=ranges.syncFrom(rangeChart);result.requestedTimeRange?.from.toFixed();
 const rangeStatus:TimeRangeState|null=ranges.status(rangeChart);rangeStatus?.padding.after.toFixed();leaveRange();rangeChart.destroy({disposeModel:true});
}
ranges.dispose();
// @ts-expect-error explicit missing-data policy required
new TimeRangeGroup({mode:'view'});
// @ts-expect-error unknown policy
new TimeRangeGroup({mode:'automatic',missing:'clip'});

import type {DrawingMagnetOptions as PackageMagnet} from 'barochart/core';
const packageMagnet:PackageMagnet={mode:'off'};
input.setDrawingMagnet(packageMagnet);api.setDrawingMagnet({mode:'strong'});

import type {CrosshairSnapOptions as PackageCursor,CrosshairSnapshot as PackageCursorSnapshot} from 'barochart/core';
const packageCursor:PackageCursor={mode:'close'};input.setCrosshairSnap(packageCursor);api.setCrosshairSnap({mode:'free'});
const packageCursorSnapshot:PackageCursorSnapshot|null=api.crosshairSnapshot(800,600);packageCursorSnapshot?.seriesId?.toUpperCase();
import type {PositionMetrics as PackagePositionMetrics} from 'barochart/core';
const packagePositionId=api.addDrawing({type:'shortposition',points:[{time:1,price:100},{time:1,price:105},{time:1,price:90},{time:2,price:100}]});
const packagePosition:PackagePositionMetrics=api.positionMetrics(packagePositionId);packagePosition.ratio.toFixed(3);
input.setTool('longposition');

api.setDrawingVisibility('t',false).changed.toFixed();api.setDrawingsVisibility(['t'] as const,true).invalidationFailed.valueOf();
const hiddenDrawing:Drawing={...drawing,visible:false};void hiddenDrawing;
// @ts-expect-error installed public visibility contract requires boolean
api.setDrawingsVisibility(['t'],0);

import type {DrawingDuplicateOptions,DrawingDuplicateReceipt} from 'barochart';
const copyOptions:DrawingDuplicateOptions={deltaTimeMs:0,deltaPrice:0};
const copyReceipt:DrawingDuplicateReceipt=api.duplicateDrawings(['t'] as const,copyOptions);
copyReceipt.created[0].sourceId.toUpperCase();api.duplicateDrawing('t',copyOptions);
// @ts-expect-error duplicate options cannot omit time delta
api.duplicateDrawings(['t'],{deltaPrice:0});

import {DrawingStylePresets} from 'barochart/core';
import {attachDrawingPanel} from 'barochart/canvas';
const portablePresets=new DrawingStylePresets();portablePresets.set('Portable',{width:2});
portablePresets.list().map(entry=>entry.style.color);portablePresets.load(portablePresets.save(),{replace:true});
void attachDrawingPanel;

import {BarReplay as PackageBarReplay} from 'barochart/core';
import type {BarReplayOptions,BarReplayState} from 'barochart';
const replayOptions:BarReplayOptions={volume:true,indicators:[{id:'r',kind:'rsi',period:14}]};
const packageReplay=new PackageBarReplay([],replayOptions),replayState:BarReplayState=packageReplay.snapshot();
replayState.count.toFixed();packageReplay.frame(800,480).commands.forEach(c=>void c);packageReplay.dispose();
// @ts-expect-error no arbitrary replay panel configuration
new PackageBarReplay([],{panels:[]});

import {renderCanvas as renderPackageReplayCanvas} from 'barochart/canvas';
declare const packageReplayContext:CanvasRenderingContext2D;renderPackageReplayCanvas(packageReplayContext,packageReplay.frame(800,480));

import {attachChartToolbar,type InteractionOptions,type ChartToolbarState} from 'barochart/canvas';
import {attachChartToolbar as rootToolbar} from 'barochart';
const webChart=new CanvasChart(document.createElement('div'),model,{interaction:{wheelZoom:false,hitTolerancePx:12}});
const inputPolicy:Readonly<InteractionOptions>=webChart.setInteractionOptions({pointer:false});
const tools=attachChartToolbar(document.createElement('div'),webChart,{tools:['select','trendline'],actions:['undo','redo'],orientation:'vertical',density:'compact'});
const toolbarState:ChartToolbarState=tools.snapshot();toolbarState.tools.map(id=>id.toUpperCase());tools.setOptions({actions:[]});tools.refresh();tools.destroy();void [inputPolicy,rootToolbar];
// @ts-expect-error interaction switches require booleans
webChart.setInteractionOptions({wheelZoom:1});
// @ts-expect-error unsupported shortcut remapping is not part of this contract
webChart.setInteractionOptions({shortcuts:{undo:'u'}});
// @ts-expect-error toolbar options use a bounded orientation
attachChartToolbar(document.body,webChart,{orientation:'diagonal'});
// @ts-expect-error snapshots cannot be mutated
inputPolicy.pointer=true;
// @ts-expect-error tool list snapshots cannot be pushed
 toolbarState.tools.push('select');
