import type {ChartAPI} from '../core/index.mjs';
import type {CalculationWorker} from './resample-async.mjs';
export interface IndicatorObserverError {readonly name:string;readonly message:string}
export interface AsyncIndicatorParamsOptions {signal?:AbortSignal;timeoutMs?:number;onProgress?:(progress:{phase:'snapshot'|'compute'|'validate';done:number;total:number})=>void;workerFactory?:(url:URL)=>CalculationWorker;onObserverError?:(error:IndicatorObserverError)=>void}
export interface AsyncIndicatorParamsResult {outputs:string[];plotOffsets:Record<string,number>;observerError?:IndicatorObserverError}
/** Entry-only atomic publication after dedicated Worker cleanup. Managed changes reject stale jobs.
 * Same-target concurrent requests reject BusyError. Cancel and await settlement before replacing.
 * Notification exceptions are reported in the resolved result, never as a failed committed mutation.
 */
export function setIndicatorParamsAsync(chart:ChartAPI,id:string,params:Record<string,number|string>,options?:AsyncIndicatorParamsOptions):Promise<AsyncIndicatorParamsResult>;
