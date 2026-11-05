import type {RustSession} from './session.mjs';
export type RustWasmSource=URL|string|Response|WebAssembly.Module|ArrayBuffer|ArrayBufferView;
export interface RustBackend {
 readonly backend:'rust-wasm';readonly timings:Readonly<Record<string,number>>;
 createSession(options?:{count?:number;options?:unknown;signal?:AbortSignal}):Promise<RustSession>;
 createSessionFromWorkspace(input:{columns:RustColumns;document:string;binding:Record<string,unknown>;source:RustStoreSource;size:{width:number;height:number};dataIngestion?:string;signal?:AbortSignal;onProgress?:(progress:Record<string,unknown>)=>unknown}):Promise<RustSession>;
 createSessionFromMigration(capture:RustMigrationCapture,options?:{signal?:AbortSignal;onProgress?:(progress:Record<string,unknown>)=>unknown}):Promise<RustSession>;
}
export type RustColumns=Record<'time'|'open'|'high'|'low'|'close'|'volume',Float64Array>;
export interface RustStoreSource {length:number;maxBars:number;timeframeMs:number;timeOrigin:number;version:number;timeVersion:number;}
export interface RustMigrationCapture {readonly metadataJSON:string;readonly header:string;readonly description:Record<string,unknown>;readonly uiChunks:readonly string[];readonly columns:RustColumns;}
export function loadRustBackend(options?:{source?:RustWasmSource;wasmURL?:URL|string;workerURL?:URL|string;signal?:AbortSignal;timeoutMs?:number}):Promise<RustBackend>;
