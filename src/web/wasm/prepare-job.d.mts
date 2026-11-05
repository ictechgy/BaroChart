export interface RustPrepareTargetActor {
  call(name: string, args?: unknown[]): Promise<unknown>;
  writeF64(name: string, args: unknown[] | undefined, values: Float64Array): Promise<boolean>;
  close(): Promise<void>;
  readonly generation?: string;
}

export interface RustPreparePort {
  /** Serialized calls into the active source session. */
  call(name: string, args?: unknown[]): Promise<unknown>;
  /** Creates a private Worker-owned target actor. */
  createTargetActor(): Promise<RustPrepareTargetActor>;
}

export interface RustPrepareColumns {
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

export interface RustPrepareInputSeeded {
  readonly kind: 'seeded';
  readonly count: number;
  readonly seed?: number;
  readonly visibleBars?: number;
  readonly options?: {readonly visibleBars?: number};
}

export interface RustPrepareInputColumns {
  readonly kind: 'columns';
  readonly columns: RustPrepareColumns;
  readonly visibleBars?: number;
  readonly options?: {readonly visibleBars?: number};
}

export type RustPrepareInput = RustPrepareInputSeeded | RustPrepareInputColumns;

export interface RustPrepareProgress {
  readonly phase: string;
  readonly ticket: number | null;
  readonly [key: string]: unknown;
}

export interface RustPrepareJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<RustPrepareProgress>) => void | Promise<void>;
  timeoutMs?: number;
  chunkSize?: number;
  stepSize?: number;
  activate?: (candidate: RustPrepareCandidate) => unknown | Promise<unknown>;
}

export interface RustPrepareCandidate {
  readonly actor: RustPrepareTargetActor;
  readonly generation: string | null;
  readonly ticket: number;
  readonly kind: 'seeded' | 'columns';
  readonly count: number;
  readonly request: Readonly<Record<string, unknown>>;
  readonly metadataJSON: string;
  readonly uiHeader: string;
  readonly uiChunks: readonly string[];
  /** Mark actor ownership as transferred before an activation callback can fail. */
  readonly handoff: () => void;
}

export interface RustPrepareResult {
  readonly schema: 'aster.web-wasm.prepare-result';
  readonly version: 1;
  readonly status: 'target-ready';
  readonly ticket: number;
  readonly kind: 'seeded' | 'columns';
  readonly count: number;
  readonly metadataJSON: string;
  readonly uiHeader: string;
  readonly uiChunks: readonly string[];
  readonly actor: RustPrepareTargetActor;
  readonly generation: string | null;
  readonly candidate: RustPrepareCandidate;
  readonly activation: unknown;
}

export class RustPrepareJobError extends Error {
  readonly code: string;
  readonly phase: string | null;
  readonly ticket: number | null;
  readonly commitUncertain: boolean;
  readonly resyncRequired: boolean;
}

export class RustPrepareJobAbortError extends RustPrepareJobError {}
export class RustPrepareJobTimeoutError extends RustPrepareJobError {}
export class RustPrepareCommitUncertainError extends RustPrepareJobError {}

export function runRustPrepareJob(
  port: RustPreparePort,
  input: RustPrepareInput,
  options?: RustPrepareJobOptions,
): Promise<RustPrepareResult>;
