export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type AuthMode = 'unauthenticated' | 'authenticated';
export type Operation = 'health' | 'login' | 'account' | 'listServers' | 'websocketCredentials';

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

export interface Scenario {
  readonly name: string;
  readonly operation: Operation;
  readonly auth: AuthMode;
  readonly load: LoadProfile;
}

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

export interface ResourceUsage {
  readonly cpuPercentMean: number;
  readonly cpuPercentMax: number;
  readonly memMbMean: number;
  readonly memMbMax: number;
  readonly samples: number;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly ok: number;
  readonly ratelimited: number;
  readonly failed: number;
  readonly errored: number;
  readonly elapsedMs: number;
  readonly throughput: number;
  readonly latency: LatencyStats | null;
  readonly statusCounts: Readonly<Record<number, number>>;
  readonly resources: ResourceUsage | null;
}

export interface VariantReport {
  readonly limit: ResourceLimit;
  readonly results: readonly ScenarioResult[];
}

export interface SuiteReport {
  readonly panel: string;
  readonly startedAt: string;
  readonly variants: readonly VariantReport[];
}
