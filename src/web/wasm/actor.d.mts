import type {RustWasmPacket} from './runtime.d.mts';

export interface RustActorError extends Error {
  code: string | null;
  status: number | null;
  phase: string;
  quarantine: boolean;
}
export interface RustActor {
  readonly protocol: number;
  readonly generation: string;
  readonly closed: boolean;
  readonly quarantined: boolean;
  readonly initialCapabilities: unknown;
  call(name: string, args?: unknown[], flags?: number): Promise<unknown>;
  readF64(name: string, args?: unknown[], flags?: number): Promise<Float64Array>;
  writeF64(name: string, args: unknown[] | undefined, values: Float64Array, flags?: number): Promise<boolean>;
  packet(args?: unknown[]): Promise<RustWasmPacket>;
  capabilities(): Promise<unknown>;
  memoryStats(): Promise<unknown>;
  close(): Promise<void>;
}
export function createRustActor(options: {
  module: WebAssembly.Module;
  workerURL?: string | URL;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RustActor>;
export const RUST_ACTOR_PROTOCOL_VERSION: number;
export const RUST_ACTOR_METHODS: ReadonlySet<string>;
export class RustActorError extends Error { code: string | null; status: number | null; phase: string; quarantine: boolean }
export class RustActorProtocolError extends RustActorError {}
export class RustActorTimeoutError extends RustActorError {}
export class RustActorClosedError extends RustActorError {}
export class RustActorQuarantinedError extends RustActorError {}
