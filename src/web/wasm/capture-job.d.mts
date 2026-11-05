export interface RustCapturePort {
  /** Serialized calls into the active Rust session. */
  call(name: string, args?: unknown[]): Promise<unknown>;
  readF64(name: string, args?: unknown[]): Promise<Float64Array>;
  nextRegistration(): number | Promise<number>;
  revision(): number | Promise<number>;
}

export interface RustCaptureColumns {
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

export interface RustCaptureData {
  readonly schema: 'aster.web-wasm.capture/v1';
  readonly version: 1;
  readonly ticket: number;
  readonly registration: number;
  readonly revision: number;
  readonly length: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly metadataJSON: string;
  readonly header: string;
  readonly description: Readonly<Record<string, unknown>>;
  readonly uiChunks: readonly string[];
  readonly columns: RustCaptureColumns;
}

export interface RustCaptureActivationCandidate<T = unknown> {
  readonly capture: RustCaptureData;
  readonly value: T;
  /** Mark candidate ownership as transferred before activation can fail. */
  readonly handoff: () => void;
}

export interface RustCaptureProgress {
  readonly stage: string;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly [key: string]: unknown;
}

export interface RustCaptureJobOptions<T = unknown, A = unknown> {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<RustCaptureProgress>) => void | Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  admissionRecords?: number;
  chunkSize?: number;
  /**
   * Build a JS candidate while the source lease is held. On any pre-handoff
   * failure, a returned object with `dispose()` is preferred; otherwise
   * `close()` is called exactly once when available.
   */
  consume: (capture: RustCaptureData) => T | Promise<T>;
  activate?: (candidate: RustCaptureActivationCandidate<T>) => A | Promise<A>;
}

export interface RustCaptureResult<T = unknown, A = unknown> {
  readonly schema: 'aster.web-wasm.capture-result';
  readonly version: 1;
  readonly status: 'captured';
  readonly capture: RustCaptureData;
  readonly value: T;
  readonly sourceReceipt: Readonly<Record<string, unknown>>;
  readonly activation: A | undefined;
  readonly candidate: RustCaptureActivationCandidate<T>;
}

export class RustCaptureJobError extends Error {
  readonly code: string;
  readonly phase: string | null;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly commitUncertain: boolean;
  readonly resyncRequired: boolean;
}

export class RustCaptureJobAbortError extends RustCaptureJobError {}
export class RustCaptureJobTimeoutError extends RustCaptureJobError {}
export class RustCaptureCommitUncertainError extends RustCaptureJobError {}

export function runRustCaptureJob<T = unknown, A = unknown>(
  port: RustCapturePort,
  document: string,
  binding: Record<string, unknown>,
  options: RustCaptureJobOptions<T, A>,
): Promise<RustCaptureResult<T, A>>;
