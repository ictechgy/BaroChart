import type {ChartModel,ChartAPI,InteractionController,Scene,DrawingType} from '../core/index.mjs';
export function renderCanvas(ctx:CanvasRenderingContext2D,scene:Scene,dpr?:number):void;
export class CanvasChart {
 constructor(container:HTMLElement,model:ChartModel,options?:ChartOptions);readonly canvas:HTMLCanvasElement;readonly controller:InteractionController;readonly api:ChartAPI;readonly lastScene?:Scene|null;readonly timings:number[];readonly lastError?:Error|null;readonly rendererKind:'canvas'|'webgl2';readonly fallbackReason?:string;
 readonly dataExploration:DataExplorationState;readonly timeCursor:TimeCursorState|null;
 setDataExploration(active:boolean):DataExplorationState;readExploration():DataExplorationState;
 readonly renderMetrics?:{baseRedrawn:boolean;drawingsRedrawn:boolean;cachedPixelBytes:number;hoverCommands:number;cacheMode?:'raster'|'scene';framebufferBlits?:number;texturePresents?:number;msaaSamples?:number;rendererFallback?:boolean}|null;
 invalidate():void;drawNow():Scene['stats']|undefined;setTool(tool:'select'|DrawingType):void;resize():void;destroy(options?:{disposeModel?:boolean}):void;
}
export class LayerCacheBudget {constructor(maxBytes?:number);readonly maxBytes:number;readonly usedBytes:number;setLimit(maxBytes:number):this;}
export interface ChartOptions {dpr?:()=>number;interactive?:boolean;observeResize?:boolean;onFallback?:(reason:string)=>void;onError?:(error:Error)=>void;layerCaching?:boolean;maxCachedPixels?:number;rasterCaching?:'auto'|'always'|'never';cacheBudget?:LayerCacheBudget;dataExplorer?:{readout:HTMLElement;live:HTMLElement;controls?:HTMLElement[]}|null}

export interface DataExplorationState {active:boolean;time:number|null;index:number|null;seriesId:string|null;phase:'off'|'selected'|'changed'|'missing'|'read'|'error';text:string;}

/** Opt-in UTC bar-open time mapping. Redrawing a dirty chart may still compute studies. */
export class TimeCursorGroup {
 constructor(options:{match:'exact'|'at-or-before'});
 readonly size:number;
 /** At most eight live charts; one group per chart/model. Returns an idempotent detach function. */
 add(chart:CanvasChart):()=>void;
 clear():void;dispose():void;
}
export interface TimeCursorState {requestedTime:number;matchedTime:number|null;index:number|null;status:'matched'|'unmatched'|'empty'|'offscreen';kind:'pointer'|'keyboard';generation:number;}

/** Explicit session-local group selection. Never changes the canvas's single selected handle. */
export class DrawingSelectionController {
 constructor(api:ChartAPI);
 select(id:string,selected?:boolean):DrawingSelectionSnapshot;
 clear():DrawingSelectionSnapshot;refresh():DrawingSelectionSnapshot;
 snapshot(options?:{offset?:number;limit?:number}):DrawingSelectionSnapshot;
 applyStyle(patch:{color?:string;fill?:string;width?:number;font?:string}):{changed:number;invalidationFailed:boolean};
 deleteSelected():{changed:number;invalidationFailed:boolean};dispose():void;
}
export interface DrawingSelectionSnapshot {rows:{id:string;type:DrawingType;panel:string;locked:boolean;selected:boolean}[];total:number;selectedIds:string[];selectedCount:number;staleCount:number;offset:number;limit:number;}
/** Empty dedicated container, at most one panel per chart. Native controls, no canvas shortcuts. */
export function attachDrawingPanel(container:HTMLElement,chart:CanvasChart,options?:{label?:string}):{selection:DrawingSelectionController;refresh():DrawingSelectionSnapshot|null;destroy():void};

/** Opt-in synchronization of visible stored bar-open centers, not continuous market-time intervals. */
export class TimeRangeGroup {
 constructor(options:{mode:'manual'|'view';missing:'clip'|'reject'});
 readonly size:number;readonly diagnostics:{generation:number;kind:string}[];
 add(chart:CanvasChart,roles:{publish:boolean;receive:boolean}):()=>void;
 syncFrom(chart:CanvasChart):{generation:number;published:boolean;status:'empty-source'|'published';requestedTimeRange:{from:number;to:number}|null;trimmed:boolean};
 status(chart:CanvasChart):TimeRangeState|null;dispose():void;
}
export interface TimeRangeState {
 generation:number;requestedTimeRange:{from:number;to:number};matchedSourceIndices:{from:number;to:number}|null;
 effectiveIndices:{from:number;to:number};effectiveStoredTimes:{from:number;to:number}|null;
 padding:{before:number;after:number};expanded:boolean;clipped:boolean;applied:boolean;
 status:'empty'|'insufficient'|'unmatched'|'clipped'|'applied';stale:boolean;
}
