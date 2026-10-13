import type {ChartModel,ColumnInput,Bar,DataEvent,Panel,Axis,Series,Theme} from '../core/index.mjs';
export interface WorkerOptions {signal?:AbortSignal;timeoutMs?:number;workerURL?:URL;onProgress?:(progress:{phase:string;done:number;total:number})=>void}
export interface WorkerRequest {columns?:ColumnInput;length?:number;bars?:Bar[];event?:DataEvent;options?:{panels?:Panel[];axes?:Axis[];series?:Series[];theme?:Partial<Theme>;precision?:number;axisWidth?:number;visibleBars?:number;indicators?:{id:string;name:string;params?:Record<string,number|string>}[]}}
export function prepareChartModel(request:WorkerRequest,options?:WorkerOptions):Promise<ChartModel>;
export function recomputeInWorker(model:ChartModel,event:DataEvent,options?:WorkerOptions):Promise<ChartModel>;
/** Low-level worker transport. Prefer prepareChartModel/recomputeInWorker for validated model publication. */
export function runChartWorker(request:WorkerRequest,options?:WorkerOptions):Promise<unknown>;

export {resampleOHLCVAsync} from './resample-async.mjs';
export type {AsyncResampleSource,AsyncResampleOptions,CalculationWorker} from './resample-async.mjs';
export {setIndicatorParamsAsync} from './indicator-params-async.mjs';
export type {AsyncIndicatorParamsOptions,AsyncIndicatorParamsResult,IndicatorObserverError} from './indicator-params-async.mjs';
export {prepareWorkspaceAsync} from './workspace-async.mjs';
export type {AsyncWorkspaceOptions} from './workspace-async.mjs';
