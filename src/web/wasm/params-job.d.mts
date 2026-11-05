export interface RustParamsTargetActor {
  call(name: string, args?: unknown[]): Promise<unknown>;
  readF64(name: string, args?: unknown[]): Promise<Float64Array>;
  writeF64(name: string, args: unknown[] | undefined, values: Float64Array): Promise<boolean>;
  close(): Promise<void>;
  readonly paramsChunkLimit?: number;
  readonly paramsStepLimit?: number;
}

export interface RustParamsPort {
  /** Serialized calls into the active Rust session. */
  call(name: string, args?: unknown[]): Promise<unknown>;
  readF64(name: string, args?: unknown[]): Promise<Float64Array>;
  writeF64(name: string, args: unknown[] | undefined, values: Float64Array): Promise<boolean>;
  /** Creates the private isolated target actor. It is never returned by the job. */
  createTargetActor(): Promise<RustParamsTargetActor>;
  /** Monotonic host registration supplied by the active session owner. */
  nextRegistration(): number | Promise<number>;
  /** Host revision captured once before SourceBegin. */
  revision(): number | Promise<number>;
  /** Refresh/publish the active UI after Rust has committed. */
  committed?(receipt: RustParamsReceipt): void | Promise<void>;
  readonly paramsChunkLimit?: number;
  readonly paramsStepLimit?: number;
  readonly limits?: {
    paramsChunkLimit?: number;
    paramsStepLimit?: number;
  };
}

export interface RustParamsJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<RustParamsProgress>) => void | Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  admissionRecords?: number;
  /** At most 16384; defaults to the negotiated port limit or 16384. */
  chunkSize?: number;
  /** At most 16384; defaults to the negotiated port limit or chunkSize. */
  stepSize?: number;
}

export interface RustParamsProgress {
  readonly stage: string;
  readonly id: string;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly complete?: boolean;
  readonly done?: number;
  readonly total?: number;
  readonly slot?: number;
  readonly offset?: number;
}

export interface RustParamsReceipt {
  readonly status: 'committed' | 'unchanged';
  readonly [key: string]: unknown;
}

export class RustParamsJobError extends Error {
  readonly code: string;
  readonly phase: string | null;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly commitUncertain: boolean;
  readonly resyncRequired: boolean;
}

export class RustParamsJobAbortError extends RustParamsJobError {}
export class RustParamsJobTimeoutError extends RustParamsJobError {}
export class RustParamsCommitUncertainError extends RustParamsJobError {}
export class RustParamsResyncRequiredError extends RustParamsJobError {}

export function runRustParamsJob(
  port: RustParamsPort,
  id: string,
  params: Record<string, unknown>,
  options?: RustParamsJobOptions,
): Promise<RustParamsReceipt>;
