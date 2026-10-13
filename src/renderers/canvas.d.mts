import type {ChartModel,ChartAPI,InteractionController,Scene,DrawingType} from '../core/index.mjs';
export function renderCanvas(ctx:CanvasRenderingContext2D,scene:Scene,dpr?:number):void;
export class CanvasChart {
 constructor(container:HTMLElement,model:ChartModel,options?:ChartOptions);readonly canvas:HTMLCanvasElement;readonly controller:InteractionController;readonly api:ChartAPI;readonly lastScene?:Scene|null;readonly timings:number[];readonly lastError?:Error|null;readonly rendererKind:'canvas'|'webgl2';readonly fallbackReason?:string;
 readonly dataExploration:DataExplorationState;
 setDataExploration(active:boolean):DataExplorationState;readExploration():DataExplorationState;
 readonly renderMetrics?:{baseRedrawn:boolean;drawingsRedrawn:boolean;cachedPixelBytes:number;hoverCommands:number;cacheMode?:'raster'|'scene';framebufferBlits?:number;texturePresents?:number;msaaSamples?:number;rendererFallback?:boolean}|null;
 invalidate():void;drawNow():Scene['stats']|undefined;setTool(tool:'select'|DrawingType):void;resize():void;destroy(options?:{disposeModel?:boolean}):void;
}
export class LayerCacheBudget {constructor(maxBytes?:number);readonly maxBytes:number;readonly usedBytes:number;setLimit(maxBytes:number):this;}
export interface ChartOptions {dpr?:()=>number;interactive?:boolean;observeResize?:boolean;onFallback?:(reason:string)=>void;onError?:(error:Error)=>void;layerCaching?:boolean;maxCachedPixels?:number;rasterCaching?:'auto'|'always'|'never';cacheBudget?:LayerCacheBudget;dataExplorer?:{readout:HTMLElement;live:HTMLElement;controls?:HTMLElement[]}|null}

export interface DataExplorationState {active:boolean;time:number|null;index:number|null;seriesId:string|null;phase:'off'|'selected'|'changed'|'missing'|'read'|'error';text:string;}
