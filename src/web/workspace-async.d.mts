import type {BarStore,ChartModel,WorkspaceDatasetBinding} from '../core/index.mjs';
import type {CalculationWorker} from './resample-async.mjs';
export interface AsyncWorkspaceOptions {datasetBinding:WorkspaceDatasetBinding;signal?:AbortSignal;timeoutMs?:number;onProgress?:(progress:{phase:'snapshot'|'compute'|'validate';done:number;total:number})=>void;workerFactory?:(url:URL)=>CalculationWorker}
/** Returns a new model sharing the caller-owned store. Managed changes during preparation reject.
 * Caller owns the returned model and must dispose it if mounting fails. Existing charts are untouched.
 * Dataset bindings are host assertions, not hashes or point-in-time authentication.
 */
export function prepareWorkspaceAsync(store:BarStore,text:string,options:AsyncWorkspaceOptions):Promise<ChartModel>;
