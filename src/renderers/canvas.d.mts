import type {ChartModel,ChartAPI,InteractionController,Scene,DrawingType,DrawingDuplicateOptions,DrawingDuplicateReceipt,DrawingStylePresets} from '../core/index.mjs';
export function renderCanvas(ctx:CanvasRenderingContext2D,scene:Pick<Scene,'width'|'height'|'background'|'commands'>,dpr?:number):void;
export class CanvasChart {
 constructor(container:HTMLElement,model:ChartModel,options?:ChartOptions);readonly disposed:boolean;readonly canvas:HTMLCanvasElement;readonly controller:InteractionController;readonly api:ChartAPI;readonly lastScene?:Scene|null;readonly timings:number[];readonly lastError?:Error|null;readonly rendererKind:'canvas'|'webgl2';readonly fallbackReason?:string;
 readonly interactionOptions:Readonly<InteractionOptions>;setInteractionOptions(patch:Partial<InteractionOptions>):Readonly<InteractionOptions>;
 readonly dataExploration:DataExplorationState;readonly timeCursor:TimeCursorState|null;
 setDataExploration(active:boolean):DataExplorationState;readExploration():DataExplorationState;
 readonly renderMetrics?:{baseRedrawn:boolean;drawingsRedrawn:boolean;cachedPixelBytes:number;hoverCommands:number;cacheMode?:'raster'|'scene';framebufferBlits?:number;texturePresents?:number;msaaSamples?:number;rendererFallback?:boolean}|null;
 invalidate():void;drawNow():Scene['stats']|undefined;setTool(tool:'select'|DrawingType):void;resize():void;destroy(options?:{disposeModel?:boolean}):void;
}
export class LayerCacheBudget {constructor(maxBytes?:number);readonly maxBytes:number;readonly usedBytes:number;setLimit(maxBytes:number):this;}
export interface InteractionOptions {pointer:boolean;wheelZoom:boolean;keyboardShortcuts:boolean;hitTolerancePx:number}
export interface ChartOptions {interaction?:Partial<InteractionOptions>;dpr?:()=>number;interactive?:boolean;observeResize?:boolean;onFallback?:(reason:string)=>void;onError?:(error:Error)=>void;layerCaching?:boolean;maxCachedPixels?:number;rasterCaching?:'auto'|'always'|'never';cacheBudget?:LayerCacheBudget;dataExplorer?:{readout:HTMLElement;live:HTMLElement;controls?:HTMLElement[]}|null}

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

/** Explicit session-local group selection. Hiding a selected drawing clears its canvas handle. */
export class DrawingSelectionController {
 constructor(api:ChartAPI);
 select(id:string,selected?:boolean):DrawingSelectionSnapshot;
 clear():DrawingSelectionSnapshot;refresh():DrawingSelectionSnapshot;
 snapshot(options?:{offset?:number;limit?:number}):DrawingSelectionSnapshot;
 duplicate(options:DrawingDuplicateOptions):DrawingDuplicateReceipt;
 setVisibility(visible:boolean):{changed:number;invalidationFailed:boolean};setRowVisibility(row:DrawingSelectionSnapshot['rows'][number],visible:boolean):{changed:number;invalidationFailed:boolean};
 captureStylePreset(presets:DrawingStylePresets,name:string,options?:{replace?:boolean}):Readonly<{changed:number}>;applyStylePreset(presets:DrawingStylePresets,name:string):{changed:number;invalidationFailed:boolean};
 applyStyle(patch:{color?:string;fill?:string;width?:number;font?:string}):{changed:number;invalidationFailed:boolean};
 deleteSelected():{changed:number;invalidationFailed:boolean};dispose():void;
}
export interface DrawingSelectionSnapshot {rows:{id:string;type:DrawingType;panel:string;locked:boolean;visible:boolean;selected:boolean}[];total:number;selectedIds:string[];selectedCount:number;staleCount:number;offset:number;limit:number;}
/** Empty dedicated container, at most one panel per chart. Native controls, no canvas shortcuts. */
export function attachDrawingPanel(container:HTMLElement,chart:CanvasChart,options?:{label?:string;stylePresets?:DrawingStylePresets}):{selection:DrawingSelectionController;refresh():DrawingSelectionSnapshot|null;destroy():void};

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

export type ChartToolbarToolId='select'|DrawingType;
export type ChartToolbarActionId='fit'|'zoomIn'|'zoomOut'|'undo'|'redo';
export type ChartToolbarControlId=ChartToolbarToolId|ChartToolbarActionId;
export type ChartToolbarLabels=Readonly<Partial<Record<ChartToolbarControlId,string>>>;
export interface ChartToolbarOptions {
 label?:string;tools?:readonly ChartToolbarToolId[];
 actions?:readonly ChartToolbarActionId[];
 orientation?:'horizontal'|'vertical';density?:'comfortable'|'compact';
 labels?:ChartToolbarLabels;
}
export interface ChartToolbarState {
 readonly label:string;readonly tools:readonly ChartToolbarToolId[];
 readonly actions:readonly ChartToolbarActionId[];readonly labels:ChartToolbarLabels;
 readonly orientation:'horizontal'|'vertical';readonly density:'comfortable'|'compact';
 readonly activeTool:'select'|DrawingType;readonly canUndo:boolean;readonly canRedo:boolean;
}
export interface ChartUIOptions {interaction?:Partial<InteractionOptions>;toolbar?:ChartToolbarOptions|null}
export type ChartOverlaySlot='topLeft'|'topRight'|'bottomLeft'|'bottomRight';
export interface ChartNavigatorState {readonly from:number;readonly to:number;readonly follow:boolean;readonly totalBars:number;readonly extentBars:number;readonly overviewSamples:number}
/** Optional native range controls and at most 256 uniformly sampled close values. */
export function attachChartNavigator(container:HTMLElement,chart:CanvasChart,options?:{label?:string}):{
 snapshot():ChartNavigatorState;refresh():ChartNavigatorState|null;destroy():void;
};
/** Host positions a dedicated empty overlay container. No price/time anchoring. */
export function attachChartOverlays(container:HTMLElement,chart:CanvasChart,options?:{label?:string}):{
 readonly slots:Readonly<Record<ChartOverlaySlot,HTMLElement>>;destroy():void;
};
export interface ChartUIConfiguration {readonly interaction:Readonly<InteractionOptions>;readonly toolbar:Readonly<Required<ChartToolbarOptions>>|null}
/** Versioned web preferences only. Host owns storage and fresh-chart installation. */
export function saveChartUI(options?:ChartUIOptions):string;
export function readChartUI(text:string):ChartUIConfiguration;
/** Explicit opt-in preference values, not device detection or native UI parity. */
export function createChartUIPreset(name:'desktop'|'mobile'):ChartUIConfiguration & {readonly toolbar:Readonly<Required<ChartToolbarOptions>>};
/** Opt-in controls; at most one toolbar per chart. Host owns container placement. */
export function attachChartToolbar(container:HTMLElement,chart:CanvasChart,options?:ChartToolbarOptions):{
 readonly options:Readonly<Required<ChartToolbarOptions>>;
 setOptions(patch:ChartToolbarOptions):ChartToolbarState|null;snapshot():ChartToolbarState;
 refresh():ChartToolbarState|null;destroy():void;
};

export interface TradeMarker {readonly id:string;readonly tradeID:string;readonly time:number;readonly price:number;readonly panel:string;readonly axisId?:string|null;readonly side?:'buy'|'sell'|null;readonly label?:string}
export interface TradeMarkerState {readonly marker:Readonly<Required<TradeMarker>>;readonly status:'unrendered'|'unmatched'|'unbound'|'offscreen'|'visible';readonly x:number|null;readonly y:number|null}
/** Host-owned external annotations; exact bar-open matching and CSS-aligned overlay required. */
export function attachTradeMarkers(container:HTMLElement,chart:CanvasChart,options?:{markers?:readonly TradeMarker[];label?:string;onSelect?:(marker:Readonly<Required<TradeMarker>>)=>void}):{
 setMarkers(markers:readonly TradeMarker[]):readonly TradeMarkerState[]|null;snapshot():readonly TradeMarkerState[];refresh():readonly TradeMarkerState[]|null;destroy():void;
};
