import type {RustBackend,RustWasmSource} from './wasm/backend.mjs';
import type {RustChartOptions,RustChartView} from './wasm/chart.mjs';
import type {RustPrepareInput,RustPrepareJobOptions} from './wasm/prepare-job.mjs';
import type {RustSession} from './wasm/session.mjs';

export interface CreateBaroChartOptions {
 readonly backend?:RustBackend|PromiseLike<RustBackend>;
 readonly load?:{source?:RustWasmSource;wasmURL?:URL|string;workerURL?:URL|string;timeoutMs?:number};
 /** Session controls are snapshotted synchronously; the nested options value is owned with structuredClone. */
 readonly session?:{count?:number;options?:unknown};
 /**
  * The payload reference is selected synchronously. Its bulk columns are copied once by RustSession.prepareData
  * when preparation starts, so callers must not mutate the selected payload before that ownership boundary.
  */
 readonly prepare?:RustPrepareInput;
 readonly prepareOptions?:Omit<RustPrepareJobOptions,'signal'|'activate'>;
 readonly view?:RustChartOptions;
 readonly signal?:AbortSignal;
}
export interface BaroChartOwner {
 readonly backend:'rust-wasm';readonly session:RustSession;readonly chart:RustChartView;readonly closed:boolean;
 destroy():Promise<void>;
}
export function createBaroChart(container:HTMLElement,options?:CreateBaroChartOptions):Promise<BaroChartOwner>;
