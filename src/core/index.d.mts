// DOM-free core declarations: this entry never imports browser or React types.
export interface Bar { time:number; open:number; high:number; low:number; close:number; volume:number }
export interface Columns {time:Float64Array;open:Float64Array;high:Float64Array;low:Float64Array;close:Float64Array;volume:Float64Array}
export interface Point {time:number;price:number}
export interface DataChange {from:number;kind:'reset'|'append'|'update'|'prepend'|'batch';version:number;added?:number;appended?:number;to?:number}
export const FIELDS: readonly (keyof Bar)[];
export function validateBar(bar:Bar,previous?:number):void;
export function seededColumns(length:number,seed?:number):Columns;
export class RangeIndex {
 constructor(length:number,low:Float64Array,high?:Float64Array,volume?:Float64Array|null,capacity?:number,countFinite?:boolean);
 readonly size:number;readonly bytes:number;query(start:number,end:number):{min:number;max:number;sum:number};update(index:number,low:number,high?:number,volume?:number):void;finiteCount(from:number,to:number):number;hasGaps(from:number,to:number):boolean;
}
export interface Bucket extends Bar {start:number;end:number;index:number}
export class BarStore {
 constructor(bars?:Bar[],options?:{timeframeMs?:number;timeOrigin?:number;maxBars?:number;onListenerError?:(error:unknown,change:DataChange)=>void}); readonly length:number;readonly capacity:number;readonly version:number;readonly columns:Columns;readonly index:RangeIndex;readonly bytes:number;readonly listenerErrors:{error:unknown;change:DataChange}[];readonly listeners:Set<(change:DataChange)=>void>;
 compactData(options:DataCompactionOptions):DataCompactionReceipt;
 setData(bars:Bar[]):void;setColumns(columns:Columns,length?:number):void;at(index:number):Bar;append(bar:Bar):number;update(index:number,bar:Bar):void;upsert(bar:Bar):void;prepend(bars:Bar[]):void;
 /** Atomic ordered transaction, one notification; no eviction/sorting/deduplication. */
 applyEvents(events:readonly OrderedDataEvent[],options?:{maxBars?:number;maxStoreBytes?:number;skipUnchanged?:boolean}):BatchReceipt;
 subscribe(fn:(change:DataChange)=>void):()=>void;lowerBound(time:number):number;indexAtTime(time:number):number;timeAtIndex(index:number):number;aggregate(start:number,end:number,maxBuckets:number):Bucket[];
}
export interface IndicatorInstance<State=unknown> {step(bar:Readonly<Bar>,index:number):number[];snapshot():State;restore(state:State):void}
export interface IndicatorDefinition<State=unknown> {outputs:string[];plotOffsets?:Record<string,number>;create():IndicatorInstance<State>}
export type IndicatorFactory=(params?:Record<string,number|string>)=>IndicatorDefinition<any>;
export const builtinIndicators:Map<string,IndicatorFactory>;
export class IndicatorEngine {
 constructor(store:BarStore,options?:{checkpointSize?:number;maxOutputBytes?:number});register(name:string,factory:IndicatorFactory):void;
 add(id:string,name:string,params?:Record<string,number|string>):IndicatorResult;get(id:string):IndicatorResult;remove(id:string):void;dispose():void;
}
export interface IndicatorResult {outputs:Record<string,Float64Array>;plotOffsets:Record<string,number>;revision:number;computedFrom:number;computedUntil:number}
export type DrawingType='trendline'|'horizontal'|'fibonacci'|'rectangle'|'ellipse'|'text'|'ray'|'extendedline'|'channel'|'fibextension'|'fibfan'|'fibtimezones'|'freehand'|'measurement'|'longposition'|'shortposition';
export const DRAWING_TYPES:readonly DrawingType[];
/** Position points: [entry(start,entry), stop(start,stop), target(start,target), extent(end,entry)]. */
export interface PositionMetrics {direction:'long'|'short';startTime:number;endTime:number;entry:number;stop:number;target:number;risk:number;reward:number;riskPercent:number|null;rewardPercent:number|null;ratio:number}
export interface DrawingDuplicateOptions {deltaTimeMs:number;deltaPrice:number}
export interface DrawingDuplicateReceipt {readonly changed:number;readonly created:readonly {readonly sourceId:string;readonly id:string}[];readonly invalidationFailed:boolean}
export interface Drawing {id:string;type:DrawingType;panel:string;axisId?:string|null;seriesId?:string|null;points:Point[];style?:{color?:string;fill?:string;width?:number;font?:string};text?:string;locked?:boolean;visible?:boolean}
export class DrawingStore {
 constructor(options?:{historyLimit?:number;maxDrawings?:number;maxPoints?:number;maxDocumentChars?:number;historyBytes?:number});readonly retainedHistoryBytes?:number;readonly items:Drawing[];selected:string|null;readonly undoStack:Drawing[][];readonly redoStack:Drawing[][];readonly transaction:Drawing[]|null;
 add(drawing:Omit<Drawing,'id'|'panel'> & {id?:string;panel?:string}):string;edit(id:string,patch:Partial<Omit<Drawing,'id'>>):void;remove(id:string|null):boolean;
 begin():void;commit():void;cancel():void;undo():boolean;redo():boolean;save():string;load(text:string,options?:{styleDecoder?:((style:NonNullable<Drawing['style']>)=>Drawing['style'])|null;validatePanel?:((panel:string)=>boolean)|null;validateBinding?:((drawing:Drawing)=>boolean)|null}):void;snapshot():Drawing[];
}
export interface Theme {background:string;grid:string;text:string;up:string;down:string;crosshair:string;font:string}
export const DARK_THEME:Theme;export const LIGHT_THEME:Theme;
export interface Panel {id:string;weight?:number;label?:string;scale?:'linear'|'log'|'percent';inverted?:boolean;padding?:number;range?:[number,number];base?:number;precision?:number;formatter?:(value:number)=>string;axisVisible?:boolean;axisSide?:'left'|'right'}
/** Independent value domain. Formatter callbacks are synchronous-only; async preparation rejects them. */
export interface Axis {id:string;panel:string;side?:'left'|'right';scale?:'linear'|'log'|'percent';inverted?:boolean;padding?:number;range?:[number,number];base?:number;precision?:number;tickFormat?:'fixed'|'scientific';prefix?:string;suffix?:string;label?:string;visible?:boolean;width?:number;formatter?:(value:number)=>string}
/** Per-controller pointer aid. Defaults to off, radius 8 logical pixels (1..32). */
export interface DrawingMagnetOptions {mode:'off'|'weak'|'strong';radiusPx?:number}
export interface DrawingTarget {panel:string;axisId?:string|null;seriesId?:string|null}
/** Local pointer snapping, separate from drawing magnet and time-cursor sync. */
export interface CrosshairSnapOptions {mode:'free'|'close'|'ohlc';target?:DrawingTarget|null}
export interface CrosshairSnapshot {mode:'free'|'close'|'ohlc';raw:{x:number;y:number};resolved:{x:number;y:number};panel:string;snapped:boolean;reason:'free'|'no-eligible'|'snapped';index:number|null;time:number|null;field:'open'|'high'|'low'|'close'|null;price:number|null;axisId:string|null;seriesId:string|null;storeVersion:number|null}
export interface CrosshairSeriesValue {id:string;label:string;symbolId:string|null;axisId:string|null;panel:string;value:number|null;sourceTime:number|null;sourceIndex:number}
export interface CrosshairAxisValue {id:string|null;panel:string;value:number;formatted:string}
export interface CrosshairValues {index:number;time:number;primary:{symbolId:string|null;bar:Bar};series:CrosshairSeriesValue[];axes:CrosshairAxisValue[]}
export type DataSelection = {index:number;time?:never;match?:never}|{time:number;match:'exact'|'at-or-before';index?:never};
export interface DataQueryOptions {asOfIndex?:number;includeHidden?:boolean;indicatorMode?:'calculate'|'cached'}
export interface DataSeriesValue {id:string;label:string;panel:string;axisId:string|null;symbolId:string|null;visible:boolean;type:Series['type'];kind:'source'|'indicator'|'external';causality:'stored-source'|'host-aligned'|'canonical-builtin'|'unverified-study';offset:number;source:keyof Columns|null;indicator:string|null;output:string|null;value:number|null;sourceIndex:number|null;sourceTime:number|null;status:'value'|'non-finite'|'outside-source'|'after-cutoff'|'unsupported-causality'|'unsupported-cache'|'pending'}
export interface DataSnapshot {index:number;time:number;asOfIndex:number;storeVersion:number;primary:{symbol:{id:string;currency:string;volumeUnit:string}|null;bar:Bar};series:DataSeriesValue[]}
export interface Series {id:string;axisId?:string|null;symbolId?:string;label?:string;type:'candles'|'ohlc'|'line'|'area'|'histogram';panel:string;source?:keyof Columns;values?:Float64Array;indicator?:string;output?:string;color?:string;fill?:string;width?:number;baseline?:number;offset?:number;upColor?:string;downColor?:string;visible?:boolean}
export class ChartModel {
 readonly disposed?:boolean;
 constructor(options?:{store?:BarStore;theme?:Partial<Theme>;panels?:Panel[];axes?:Axis[];visibleBars?:number;axisWidth?:number;precision?:number});readonly store:BarStore;readonly indicators:IndicatorEngine;readonly drawings:DrawingStore;
 theme:Theme;panels:Panel[];axes:Axis[];series:Series[];view:{from:number;to:number};crosshair:{x:number;y:number}|null;follow:boolean;priceFormatter?:(value:number)=>string;timeFormatter?:(time:number)=>string;symbol?:SymbolMetadata;
 addPanel(panel:Panel):string;setPanel(id:string,patch:Partial<Panel>):void;setPanelOrder(ids:readonly string[]):boolean;removePanel(id:string):void;addAxis(axis:Axis):string;setAxis(id:string,patch:Partial<Omit<Axis,'id'|'panel'>>):void;removeAxis(id:string):void;validateAxis(axis:Axis):true;validateDrawingBinding(drawing:DrawingTarget,options?:{allowOrphanSeries?:boolean}):true;addSeries(series:Series):string;removeSeries(id:string):void;setSeriesValues(id:string,values:Float64Array):void;
 setVisibleRange(from:number,to:number):void;zoom(factor:number,anchor?:number):void;pan(deltaBars:number):void;fit():void;dispose():void;
}
export interface PanelLayout extends Panel {axes:AxisLayout[];axisId:null;left:number;right:number;top:number;bottom:number;min:number;max:number;y:(price:number)=>number;price:(y:number)=>number}
export interface AxisLayout extends Omit<Axis,'id'|'panel'|'side'|'base'> {id:string;panel?:string;axisId:string|null;side:'left'|'right';base:number;left:number;right:number;top:number;bottom:number;axisLeft:number;axisRight:number;textX:number;min:number;max:number;lo:number;hi:number;transform:(value:number)=>number;inverse:(value:number)=>number;y:(value:number)=>number;price:(y:number)=>number}
export interface Layout {width:number;height:number;panels:PanelLayout[];axis:(panel:string,axisId?:string|null)=>AxisLayout|undefined;drawingAxis:(drawing:Drawing)=>AxisLayout|undefined;from:number;to:number;x:(index:number)=>number;index:(x:number)=>number;toScreen:(point:Point,panel:string,axisId?:string|null)=>{x:number;y:number};fromScreen:(x:number,y:number,panel:string,axisId?:string|null)=>Point}
export function createLayout(model:ChartModel,width:number,height:number):Layout;
export interface Scene {width:number;height:number;background:string;commands:DisplayCommand[];layout:Layout;stats:{storedBars:number;visibleSourceBars:number;renderedCandleBuckets:number;commandCount:number}}
export interface DisplayCommand {op:'lines'|'rects'|'path'|'box'|'ellipse'|'text';coords?:number[];points?:number[];x?:number;y?:number;w?:number;h?:number;color:string;width?:number;fill?:string|null;baseline?:number;text?:string;font?:string;clip?:number[]|null;dash?:number[]|null;role?:'price-tick'|'time-tick'|'panel-title'|'axis-title'|'crosshair-price'|'crosshair-time';fullText?:string;labelBounds?:number[];panelId?:string;axisId?:string|null}
export function buildScene(model:ChartModel,width:number,height:number,options?:{crosshair?:boolean;drawings?:boolean}):Scene;
export function drawingHitTest(store:DrawingStore,layout:Layout,x:number,y:number,tolerance?:number):{id:string;handle:number;locked?:boolean}|null;
export class InteractionController {
 constructor(model:ChartModel,size:()=>{width:number;height:number},invalidate?:()=>void);tool:'select'|DrawingType;text:string;drawingTarget:DrawingTarget|null;readonly drawingMagnet:Readonly<Required<DrawingMagnetOptions>>;readonly crosshairSnap:Readonly<{mode:CrosshairSnapOptions['mode'];target:Readonly<DrawingTarget>|null}>;readonly pointers:Map<number,{x:number;y:number}>;readonly gesture:unknown;
 setTool(tool:'select'|DrawingType):void;setDrawingTarget(target:DrawingTarget|null):void;setDrawingMagnet(options:DrawingMagnetOptions):void;setCrosshairSnap(options:CrosshairSnapOptions):void;down(id:number,x:number,y:number,hitTolerance?:number):void;move(id:number,x:number,y:number):void;up(id:number):void;cancel():void;wheel(delta:number,x:number):void;key(key:string,options?:{ctrl?:boolean;shift?:boolean}):void;layout():Layout;
}
export interface SymbolMetadata {id:string;exchange:string;timezone:string;currency:string;priceDecimals:number;tickSize:number;volumeUnit:string;adjustment:'raw'|'split'|'total-return';provider?:string;adjustmentVersion?:string}
export function validateSymbol(symbol:SymbolMetadata):Readonly<SymbolMetadata>;
export function formatPrice(value:number,symbol:SymbolMetadata):string;
/** Decimal timestamp strings: <=128 characters, exponent |e|<=10000, exact integer ms; no rounding. Number inputs retain binary64 scaling. */
export function normalizeOHLCV(rows:unknown[],options?:{timeUnit?:'ms'|'s';format?:'objects'|'tuples'}):Bar[];
export function zonedParts(time:number,timezone:string):Record<string,string>;
export function marketDate(time:number,timezone:string):string;
export function shiftDate(date:string,days:number):string;
export function zonedEpoch(date:string,clock:string,timezone:string,ambiguity?:'earlier'|'later'|'reject'):number;
export interface Session {date:string;open:number;close:number;kind:string}
export class SessionCalendar {
 constructor(timezone:string,provider:(date:string)=>{open:string;close:string;kind?:string}[],options?:{maxCachedDays?:number});readonly timezone:string;invalidate():void;sessions(date:string):Session[];at(time:number,kinds?:string[]):Session|null;bucket(time:number,interval:number|'day'|'week'|'month',kinds?:string[]):{time:number;sessionDate:string;kind:string}|null;
}
export interface Tick {id?:string;time:number;price:number;volume:number}
export class TickAggregator {
 constructor(options:{calendar:SessionCalendar;interval?:number|'day'|'week'|'month';kinds?:string[];latePolicy?:'reject'|'correct';maxBuckets?:number;maxTicksPerBucket?:number});push(tick:Tick):{status:string;bar?:Bar;sessionDate?:string;sessionKind?:string};reset():void;
}
export interface OrderedDataEvent {kind:'append'|'update'|'correction';bar:Bar}
export interface BatchReceipt {/** Present only for explicit skipUnchanged:true; compares final OHLCV, not feed freshness. */ readonly unchanged?:boolean;readonly events:number;readonly appended:number;readonly from:number;readonly to:number;readonly version:number;readonly length:number;readonly capacity:number;readonly bytes:number}
export type DataEvent={kind:'reset';bars:Bar[]}|{kind:'reset';columns:Columns;length?:number}|OrderedDataEvent|{kind:'prepend';bars:Bar[]}|{kind:'batch';events:readonly OrderedDataEvent[]};
export function applyDataEvent(store:BarStore,event:DataEvent):void|BatchReceipt;
export class IngestionError extends Error {readonly code:string;constructor(code:string,message:string,cause?:unknown)}
export interface DataIngestionOptions {streamId:string;generation:number;firstSequence?:number;maxQueuedEvents?:number;maxQueuedBytes?:number;maxBatchEvents?:number;maxStoredBars?:number;maxStoreBytes?:number}
export interface DataIngestionPacket {streamId:string;generation:number;firstSequence:number;events:readonly OrderedDataEvent[]}
export interface DataIngestionStats {policy:Required<DataIngestionOptions>;state:'running'|'paused'|'busy';nextSequence:number;accepted:number;applied:number;cancelled:number;rejectedPackets:number;rejectedEvents:number;failedDrains:number;pendingEvents:number;pendingBytes:number;ownedBytes:number;peakPendingEvents:number;peakPendingBytes:number;lastAppliedSequence:number|null;lastCancelledSequence:number|null;lastError:{code:string;message:string}|null;storedBars:number;storeBytes:number}
export interface DataIngestionEnqueueReceipt {events:number;firstSequence:number;nextSequence:number;pendingEvents:number;pendingBytes:number}
export interface DataIngestionDrainReceipt extends BatchReceipt {firstSequence:number|null;lastSequence:number|null}
export interface DataIngestionCancelReceipt {events:number;firstSequence:number|null;lastSequence:number|null}
export const DEMO_SYMBOLS:Record<'kr'|'us'|'crypto',SymbolMetadata>;
/** Owned exact timestamp join; missing values are NaN. No carry, interpolation or union timeline. */
export function alignSeriesByTime(referenceTimes:readonly number[]|Float64Array,points:readonly {time:number;value:number|null}[]):Float64Array;
export function demoCalendar(market:'kr'|'us'|'crypto'):SessionCalendar;
/** All policies are explicit. Source bars label half-open UTC intervals. */
export interface ResampleOptions {sourceIntervalMs:number;targetIntervalMs:number;calendar:SessionCalendar;kinds:readonly string[];asOf:number;partialTarget:'reject'|'omit'|'include-unconfirmed'}
export interface ConfirmationTiming {length:number;endTime:Float64Array;availableAt:Float64Array;complete:Uint8Array;confirmed:Uint8Array;asOf:number}
export interface ResampledOHLCV extends ConfirmationTiming {columns:Columns;sourceFrom:Uint32Array;sourceTo:Uint32Array;sourceIntervalMs:number;targetIntervalMs:number}
/** Owned result; sourceFrom/sourceTo are half-open original input indices. */
export function resampleOHLCV(input:{columns:Columns;length:number},options:ResampleOptions):ResampledOHLCV;
/** Explicit as-of carry. Confirmed NaN resets the carry; null is unsupported. */
export function alignConfirmedByTime(decisionTimes:readonly number[]|Float64Array,values:Float64Array,timing:ConfirmationTiming):Float64Array;


export function drawingPointCount(type:DrawingType):number;
export function drawingGeometry(drawing:Drawing,layout:Layout):DisplayCommand[];
export type ColumnInput=Record<keyof Columns,Float64Array|number[]>;
export type SeriesInput=Omit<Series,'values'> & {values?:Float64Array|(number|null)[]};
export type SeriesPatch=Partial<Omit<SeriesInput,'id'|'indicator'|'output'|'values'>>&{indicator?:string|null;output?:string|null;values?:Float64Array|(number|null)[]|null};
export type AxisPatch=Partial<Omit<Axis,'id'|'panel'|'range'|'base'>>&{range?:[number,number]|null;base?:number|null};
export type PanelPatch=Partial<Omit<Panel,'range'|'base'>>&{range?:[number,number]|null;base?:number|null};
export interface ChartSnapshot {view:{from:number;to:number};theme:Theme;panels:Panel[];axes:Axis[];series:(Omit<Series,'values'>&{valueCount?:number})[];symbol?:SymbolMetadata;storedBars:number;lastBar:Bar|null;drawings:Drawing[];selected:string|null;tool:'select'|DrawingType|null;drawingTarget:DrawingTarget|null;pointers:number;gesture:string|null}
export function portableColor(value:string):string;
export function portableFont(value:string):string;
export interface IndicatorModuleRef {readonly id:string;readonly version:number;readonly stateVersion:number;readonly exportName:string;readonly causal:boolean}
export interface TrustedIndicatorModule {id:string;version:number;stateVersion:number;indicators:Record<string,{factory:IndicatorFactory;causal:boolean;validateCheckpoint:(params:Record<string,number|string>,state:unknown,index:number)=>unknown}>}
/** Trusted static build code only. Link the same exact module in owner and workers. */
export function defineIndicatorModule(module:TrustedIndicatorModule):readonly {name:string;factory:IndicatorFactory;module:IndicatorModuleRef}[];
export function indicatorModule(name:string):IndicatorModuleRef|undefined;
export function indicatorModuleDefinitions(id:string,version:number):readonly {name:string;factory:IndicatorFactory;module:IndicatorModuleRef}[];
export class UnsupportedIndicatorError extends Error {readonly code:string}
export interface PortableSessionSpec {timezone:string;weekdays:number[];windows:SessionWindow[];exceptions?:Record<string,SessionWindow[]>;ambiguity?:'earlier'|'later'|'reject'}
export interface SessionWindow {open:string;close:string;kind?:string}
/** Returns bounded JSON text for params.calendar. Exchange holiday truth is host supplied. */
export function portableSessionCalendar(options:PortableSessionSpec):string;
export interface IndicatorQueryOptions {mode?:'raw'|'plot';asOfIndex?:number}
export interface IndicatorPoint {value:number|null;sourceIndex:number|null;sourceTime:number|null}
export interface DataCompactionOptions {keepLastBars:number;studyHistory:'restart';maxPeakStoreBytes?:number;pendingData?:'reject'|'preserve-retained'}
export interface DataCompactionReceipt {removed:number;length:number;capacity:number;bytes:number;previousBytes:number;peakSourceBytes:number;firstRetainedTime:number;version:number;timeVersion:number;studyHistory:'restart';invalidationFailed:boolean}
export class ChartAPI {
 constructor(model:ChartModel,options?:{controller?:InteractionController;invalidate?:(kind?:string)=>void});
 dispatch(operation:string,args?:unknown[]):unknown;inspect():ChartSnapshot;
 compactData(options:DataCompactionOptions):DataCompactionReceipt;
 setData(bars:Bar[]):void;setColumns(columns:ColumnInput,length?:number):void;applyDataEvent(event:DataEvent|{kind:'reset';columns:ColumnInput;length?:number}):void|BatchReceipt;applyDataEvents(events:readonly OrderedDataEvent[],options?:{skipUnchanged?:boolean}):BatchReceipt;
 configureDataIngestion(options:DataIngestionOptions):DataIngestionStats;enqueueDataEvents(packet:DataIngestionPacket):DataIngestionEnqueueReceipt;drainDataEvents(maxEvents?:number):DataIngestionDrainReceipt;pauseDataIngestion():DataIngestionStats;resumeDataIngestion():DataIngestionStats;cancelDataEvents():DataIngestionCancelReceipt;dataIngestionStats():DataIngestionStats;saveDataIngestion():string;loadDataIngestion(text:string):DataIngestionStats;
 addPanel(options:Panel):string;setPanel(id:string,patch:PanelPatch):void;setPanelOrder(ids:readonly string[]):boolean;removePanel(id:string):void;addAxis(options:Axis):string;setAxis(id:string,patch:AxisPatch):void;removeAxis(id:string):void;crosshairValues(width:number,height:number):CrosshairValues|null;crosshairSnapshot(width:number,height:number):CrosshairSnapshot|null;dataAt(query:DataSelection,options?:DataQueryOptions):DataSnapshot|null;addSeries(options:SeriesInput):string;setSeries(id:string,patch:SeriesPatch):void;setSeriesValues(id:string,values:Float64Array|(number|null)[]):void;removeSeries(id:string):void;
 addIndicator(id:string,name:string,params?:Record<string,number|string>):{outputs:string[];plotOffsets:Record<string,number>};setIndicatorParams(id:string,params:Record<string,number|string>):{outputs:string[];plotOffsets:Record<string,number>};setIndicatorPlacement(id:string,placement:{panel:string;axisId?:string|null}):{changed:number};removeIndicator(id:string):void;indicatorValues(id:string,output?:string):(number|null)[];registerIndicator(name:string,factory:IndicatorFactory):void;registerIndicatorSource(name:string,source:string):void;
 registerIndicatorModule(id:string,version:number):string[];indicatorValueAt(id:string,output:string|undefined,index:number,options?:IndicatorQueryOptions):IndicatorPoint;saveStudies():string;loadStudies(text:string):{indicators:number;series:number};
 duplicateDrawing(id:string,options:DrawingDuplicateOptions):DrawingDuplicateReceipt;duplicateDrawings(ids:readonly string[],options:DrawingDuplicateOptions):DrawingDuplicateReceipt;
 setDrawingVisibility(id:string,visible:boolean):{changed:number;invalidationFailed:boolean};setDrawingsVisibility(ids:readonly string[],visible:boolean):{changed:number;invalidationFailed:boolean};
 positionMetrics(id:string):PositionMetrics;
 addDrawing(options:Omit<Drawing,'id'|'panel'>&{id?:string;panel?:string}):string;editDrawing(id:string,patch:Partial<Omit<Drawing,'id'>>):void;translateDrawings(ids:readonly string[],options:{deltaTimeMs:number;deltaPrice:number}):{changed:number;invalidationFailed:boolean};setDrawingsStyle(ids:readonly string[],patch:{color?:string;fill?:string;width?:number;font?:string}):{changed:number;invalidationFailed:boolean};deleteDrawings(ids:readonly string[]):{changed:number;invalidationFailed:boolean};deleteDrawing(id?:string|null):boolean;selectDrawing(id:string|null):void;saveDrawings():string;loadDrawings(text:string):void;undo():void;redo():void;setTool(tool:'select'|DrawingType):void;setText(text:string):void;setDrawingTarget(target:DrawingTarget|null):void;setDrawingMagnet(options:DrawingMagnetOptions):void;setCrosshairSnap(options:CrosshairSnapOptions):void;
 setTheme(patch:Partial<Theme>):void;setSymbol(symbol:SymbolMetadata):void;setVisibleRange(from:number,to:number):void;fit():void;zoom(factor:number,anchor?:number):void;pan(delta:number):void;
}

export const RESOURCE_LIMITS:Readonly<{maxBars:number;maxCanvasDimension:number;maxCanvasPixels:number;maxDrawings:number;maxDrawingPoints:number;maxDocumentChars:number;maxHistoryBytes:number;maxPanels:number;maxAxes:number;maxSeries:number;maxIndicators:number}>;
export class BlockRangeIndex {constructor(length:number,values:Float64Array,capacity?:number,blockSize?:number);readonly size:number;readonly bytes:number;query(from:number,to:number):{min:number;max:number;sum:number};update(index:number):void;finiteCount(from:number,to:number):number;hasGaps(from:number,to:number):boolean;}

/** Explicit host assertions for the exact data revision and price domain. No content hash is implied. */
export interface WorkspaceDatasetBinding {key:string;revision:string;adjustmentVersion:string;priceUnit:string;adjustment:'raw'|'split'|'total-return'}
/** Save portable chart metadata without source bars or executable callbacks. Active gestures reject. */
export function saveWorkspace(chart:ChartAPI,datasetBinding:WorkspaceDatasetBinding):string;
/** Exact, host-declared primary-price identity. Does not authenticate source bars. */
export interface DrawingIdentity {symbolId:string;exchange:string;priceUnit:string;timeframe:string;adjustment:'raw'|'split'|'total-return';adjustmentVersion:string}
/** Primary price panel only, with no axisId/seriesId bindings; legacy formats are unchanged. */
export function saveBoundDrawings(chart:ChartAPI,identity:DrawingIdentity):string;
export function loadBoundDrawings(chart:ChartAPI,text:string,expectedIdentity:DrawingIdentity):void;

/** Nonempty at runtime. Missing keys inherit the target drawing's stored style. */
export interface DrawingStylePatch {color?:string;fill?:string;width?:number;font?:string;}
export interface DrawingStylePreset {readonly name:string;readonly style:Readonly<DrawingStylePatch>;}
/** Host-owned registry: 64 presets, separate explicit JSON persistence, no chart ownership. */
export class DrawingStylePresets {
 get(name:string):DrawingStylePreset|undefined;list():readonly DrawingStylePreset[];
 set(name:string,style:DrawingStylePatch,options?:{replace?:boolean}):Readonly<{changed:number}>;
 capture(api:ChartAPI,id:string,name:string,options?:{replace?:boolean}):Readonly<{changed:number}>;
 remove(name:string):Readonly<{changed:number}>;
 apply(api:ChartAPI,ids:readonly string[],name:string):Readonly<{changed:number;invalidationFailed:boolean}>;
 save():string;load(text:string,options?:{replace?:boolean}):Readonly<{changed:number}>;
}

export interface BarReplayOptions {initialCount?:number;visibleBars?:number;priceScale?:'linear'|'log';inverted?:boolean;volume?:boolean;theme?:Partial<Theme>;indicators?:readonly {id:string;kind:'sma'|'ema'|'rsi';period:number;color?:string}[];}
export interface BarReplayState {readonly count:number;readonly total:number;readonly initialCount:number;readonly lastTime:number|null;readonly paused:boolean;readonly ended:boolean;readonly generation:number;}
export interface BarReplayBookmark {readonly id:string;readonly label:string;readonly count:number;}
export interface BarReplayReceipt {readonly changed:boolean;readonly state:BarReplayState;}
export interface BarReplayFrame {width:number;height:number;background:string;commands:Scene['commands'];stats:Scene['stats'];axes:{id:string;min:number;max:number;scale:string;inverted:boolean}[];}
/** Manual-only private prefix model. Cold rebuild on changed count; no live API/model getter. */
export class BarReplay {
 constructor(bars:readonly Bar[],options?:BarReplayOptions);
 static restoreSession(bars:readonly Bar[],text:string,options:{datasetBinding:WorkspaceDatasetBinding}):BarReplay;
 bookmarks():readonly BarReplayBookmark[];addBookmark(input:{id:string;label:string}):BarReplayBookmark;
 renameBookmark(id:string,label:string):BarReplayBookmark;removeBookmark(id:string):boolean;seekBookmark(id:string):BarReplayReceipt;saveSession(datasetBinding:WorkspaceDatasetBinding):string;
 snapshot():BarReplayState;start():BarReplayReceipt;pause():BarReplayReceipt;step(count?:number):BarReplayReceipt;
 seek(revealedCount:number):BarReplayReceipt;reset():BarReplayReceipt;
 barAt(index:number):Readonly<Bar>;indicatorValues(id:string):Float64Array;
 frame(width:number,height:number):BarReplayFrame;dispose():void;
}
