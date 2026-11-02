export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type AuthMode = 'unauthenticated' | 'authenticated';
export type TargetKind = 'panel' | 'daemon';

export type Operation =
  | 'health'
  | 'login'
  | 'account'
  | 'listServers'
  | 'websocketCredentials'
  | 'system'
  | 'listDirectory'
  | 'fileContents'
  | 'chmod';

export type TaskOperation =
  | 'compress'
  | 'decompress'
  | 'deleteTree'
  | 'writeFile'
  | 'listDirectory'
  | 'sftpLogin'
  | 'sftpUpload'
  | 'sftpDownload'
  | 'sftpList'
  | 'sftpGetTree'
  | 'sftpPutTree';

export type ArchiveFormat = 'tar.gz' | 'zip';

export type ScenarioParams = Readonly<Record<string, string | number>>;

export interface RequestSpec {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface AuthContext {
  readonly mode: AuthMode;
  readonly headers: Readonly<Record<string, string>>;
}

export const UNAUTHENTICATED: AuthContext = Object.freeze({
  mode: 'unauthenticated',
  headers: Object.freeze({}),
});

export interface LoadProfile {
  readonly concurrency: number;
  readonly requests?: number;
  readonly durationMs?: number;
  readonly warmupMs?: number;
}

export interface LoadScenario {
  readonly kind: 'load';
  readonly name: string;
  readonly operation: Operation;
  readonly auth: AuthMode;
  readonly load: LoadProfile;
  readonly params?: ScenarioParams;
}

export interface TaskScenario {
  readonly kind: 'task';
  readonly name: string;
  readonly operation: TaskOperation;
  readonly auth: AuthMode;
  readonly repetitions: number;
  readonly warmup: boolean;
  readonly params?: ScenarioParams;
}

export type Scenario = LoadScenario | TaskScenario;

export interface ResourceLimit {
  readonly cpus: number;
  readonly memoryMb?: number;
}

export interface LatencyStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

export interface TaskStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
}

export interface ResourceUsage {
  readonly cpuMs: number;
  readonly windowMs: number;
  readonly cpuPercentMean: number;
  readonly cpuPercentMax: number;
  /** Anonymous + shared-anonymous memory (`anon + shmem`); page cache and slab are excluded. */
  readonly heapMbMean: number;
  readonly heapMbMax: number;
  readonly samples: number;
}

export interface LoadResult {
  readonly kind: 'load';
  readonly scenario: LoadScenario;
  readonly ok: number;
  readonly ratelimited: number;
  readonly failed: number;
  readonly errored: number;
  readonly elapsedMs: number;
  readonly throughput: number;
  readonly latency: LatencyStats | null;
  readonly statusCounts: Readonly<Record<number, number>>;
  readonly resources: ResourceUsage | null;
  /**
   * CPU milliseconds spent per response, with the target's idle floor removed. Unlike raw CPU
   * percent — which pins to the quota once the target saturates — this stays meaningful under
   * saturation, and lower is unambiguously better.
   */
  readonly cpuMsPerRequest: number | null;
}

export interface TaskResult {
  readonly kind: 'task';
  readonly scenario: TaskScenario;
  readonly ok: number;
  readonly failed: number;
  readonly runsMs: readonly number[];
  readonly stats: TaskStats | null;
  readonly bytes: number;
  readonly mbPerSec: number | null;
  readonly statusCounts: Readonly<Record<number, number>>;
  readonly failures: readonly string[];
  readonly resources: ResourceUsage | null;
  /**
   * CPU milliseconds consumed by the median run, with the idle floor removed. Separates total CPU
   * cost from wall-clock duration: a task that parallelises finishes sooner but may cost more.
   */
  readonly cpuMsPerRun: number | null;
}

export type ScenarioResult = LoadResult | TaskResult;

export interface VariantReport {
  readonly limit: ResourceLimit;
  readonly idle: ResourceUsage | null;
  readonly results: readonly ScenarioResult[];
}

export interface SuiteReport {
  readonly target: string;
  readonly kind: TargetKind;
  readonly version: string | null;
  readonly storage: 'tmpfs' | 'disk' | null;
  readonly startedAt: string;
  readonly notes: readonly string[];
  readonly variants: readonly VariantReport[];
}
