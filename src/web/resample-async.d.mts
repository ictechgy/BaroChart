import type {BarStore,Columns,ResampleOptions,ResampledOHLCV} from '../core/index.mjs';
export type AsyncResampleSource={kind:'store';store:BarStore}|{kind:'immutable-columns';columns:Columns;length:number};
export type CalculationWorker=Pick<Worker,'onmessage'|'onerror'|'postMessage'>&{terminate():void|Promise<unknown>};
export interface AsyncResampleOptions extends ResampleOptions {signal?:AbortSignal;timeoutMs?:number;onProgress?:(progress:{phase:'snapshot'|'calendar'|'compute'|'validate';done:number;total:number})=>void;workerFactory?:(url:URL)=>CalculationWorker}
/** Dedicated-worker calculation. Raw columns/calendar must remain unchanged until settlement.
 * Store mode rejects if managed source identity/version changes, including before return.
 * Cancellation/timeout covers capture, compute and validation; no chart state is installed.
 */
export function resampleOHLCVAsync(source:AsyncResampleSource,options:AsyncResampleOptions):Promise<ResampledOHLCV>;
