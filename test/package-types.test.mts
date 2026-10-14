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
