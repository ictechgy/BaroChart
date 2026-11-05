export interface RustMigrationTargetActor {
  call(name: string, args?: unknown[]): Promise<unknown>;
  writeF64(name: string, args: unknown[] | undefined, values: Float64Array): Promise<boolean>;
  close(): Promise<void>;
  readonly generation?: string;
}

export interface RustMigrationPort {
  /** Serialized calls into the active Rust session. */
  call(name: string, args?: unknown[]): Promise<unknown>;
  readF64(name: string, args?: unknown[]): Promise<Float64Array>;
  /** Creates an isolated Worker-owned target actor. */
  createTargetActor(): Promise<RustMigrationTargetActor>;
  /** Monotonic registration allocated by the active session owner. */
  nextRegistration(): number | Promise<number>;
  /** Revision captured before SourceBegin. */
  revision(): number | Promise<number>;
}

export interface RustMigrationCandidate {
  readonly actor: RustMigrationTargetActor;
  readonly generation: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly metadataJSON: string;
  readonly header: string;
  readonly description: Readonly<Record<string, unknown>>;
  readonly uiChunks: readonly string[];
  /** Mark actor ownership as transferred before an activation callback can fail. */
  readonly handoff: () => void;
}

export interface RustMigrationProgress {
  readonly stage: string;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly [key: string]: unknown;
}

export interface RustMigrationJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<RustMigrationProgress>) => void | Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  admissionRecords?: number;
  chunkSize?: number;
  stepSize?: number;
  /**
   * Optional atomic facade hook. It is called after source validation and
   * source finish. Once called, an error is commit-uncertain and the target
   * actor is retained for explicit recovery.
   */
  activate?: (candidate: RustMigrationCandidate) => unknown | Promise<unknown>;
}

export interface RustMigrationResult {
  readonly schema: 'aster.web-wasm.migration-result';
  readonly version: 1;
  readonly status: 'target-ready';
  readonly ticket: number;
  readonly registration: number;
  readonly revision: number;
  readonly sourceReceipt: Readonly<Record<string, unknown>>;
  readonly targetReceipt: Readonly<Record<string, unknown>>;
  readonly candidate: RustMigrationCandidate;
  readonly activation: unknown;
}

export class RustMigrationJobError extends Error {
  readonly code: string;
  readonly phase: string | null;
  readonly registration: number | null;
  readonly ticket: number | null;
  readonly commitUncertain: boolean;
  readonly resyncRequired: boolean;
}

export class RustMigrationJobAbortError extends RustMigrationJobError {}
export class RustMigrationJobTimeoutError extends RustMigrationJobError {}
export class RustMigrationCommitUncertainError extends RustMigrationJobError {}

export function runRustMigrationJob(
  port: RustMigrationPort,
  document: string,
  binding: Record<string, unknown>,
  options?: RustMigrationJobOptions,
): Promise<RustMigrationResult>;

export function runRustMigrationJob(
  port: RustMigrationPort,
  config: {document: string; binding: Record<string, unknown>},
  options?: RustMigrationJobOptions,
): Promise<RustMigrationResult>;
