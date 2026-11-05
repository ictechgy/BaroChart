export interface RustWasmLoadTimings { compileMs: number }
export interface RustWasmLoadResult { module: WebAssembly.Module; timings: RustWasmLoadTimings }
export interface RustWasmPacket { metadata: unknown; numbers: Float64Array }
export interface RustWasmCapabilities {
 readonly schema: 'barochart.web-wasm.capabilities';
 readonly version: 1;
 readonly abi: 1;
 readonly transfer: 'f64-le';
 readonly packetVersion: 1;
 readonly maxTransfer: number;
 readonly implemented: readonly string[];
 readonly unavailable: readonly string[];
}
export interface RustWasmRuntimeOptions { host?: typeof globalThis; requiredOperations?: string[] }
export interface RustWasmRuntime {
 readonly module: WebAssembly.Module;
 readonly instance: WebAssembly.Instance;
 readonly engine: number;
 readonly quarantined: boolean;
 readonly closed: boolean;
 readonly hostReleased: boolean;
 readonly hostReleaseCount: number;
 call(name: string, args?: unknown[], flags?: number): unknown;
 readF64(name: string, args?: unknown[], flags?: number): Float64Array;
 writeF64(name: string, args: unknown[] | undefined, values: Float64Array, flags?: number): boolean;
 packet(args?: unknown[]): RustWasmPacket;
 capabilities(): RustWasmCapabilities;
 capabilitiesJson(): RustWasmCapabilities;
 memoryStats(): unknown;
 resynchronize(): true;
 close(): void;
}
export class RustWasmError extends Error { code: string | null; status: number | null }
export class RustWasmLoadError extends RustWasmError {}
export class RustWasmCapabilityError extends RustWasmError {}
export class RustWasmCallError extends RustWasmError {}
export function loadRustModule(source: string | URL | Response | WebAssembly.Module | ArrayBuffer | ArrayBufferView, options?: {signal?: AbortSignal}): Promise<RustWasmLoadResult>;
export function instantiateRustRuntime(module: WebAssembly.Module, options?: RustWasmRuntimeOptions): RustWasmRuntime;
export function createRustRuntime(options: {source: string | URL | Response | WebAssembly.Module | ArrayBuffer | ArrayBufferView; signal?: AbortSignal} & RustWasmRuntimeOptions): Promise<RustWasmRuntime & {readonly timings: RustWasmLoadTimings}>;
