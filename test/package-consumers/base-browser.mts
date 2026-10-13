import {BarStore,ChartModel,CanvasChart,createChart,WebGLRenderer,prepareChartModel,type ChartOptions} from 'barochart';
import {CanvasChart as Canvas,renderCanvas,LayerCacheBudget} from 'barochart/canvas';
import {GPUChart,createChart as createGPU} from 'barochart/webgl';
import {runChartWorker,type WorkerRequest} from 'barochart/worker';

const model=new ChartModel({store:new BarStore()}),container=document.createElement('div'),options:ChartOptions={observeResize:false,cacheBudget:new LayerCacheBudget(1024)};
new CanvasChart(container,model,options).destroy();new Canvas(container,model).destroy();new GPUChart(container,model).destroy();createChart(container,model,{renderer:'canvas'}).destroy();createGPU(container,model,{renderer:'webgl2'}).destroy();new WebGLRenderer(document.createElement('canvas')).dispose();
const request:WorkerRequest={columns:{time:new Float64Array(),open:new Float64Array(),high:new Float64Array(),low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()}};
void prepareChartModel(request);void runChartWorker(request);void renderCanvas;
