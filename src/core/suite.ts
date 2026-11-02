import { setTimeout as sleep } from 'node:timers/promises';
import colors from 'ansi-colors';
import { type Dataset, LIST_SIZES, treeProfile } from './dataset.ts';
import { runOha, warmupOha } from './oha.ts';
import { ResourceSampler } from './resources.ts';
import type { Target, TaskOutcome, TaskRunner } from './target.ts';
import {
  type ArchiveFormat,
  type AuthContext,
  type LoadResult,
  type LoadScenario,
  type Operation,
  type ResourceLimit,
  type ResourceUsage,
  type Scenario,
  type ScenarioResult,
  type SuiteReport,
  type TargetKind,
  type TaskOperation,
  type TaskResult,
  type TaskScenario,
  UNAUTHENTICATED,
  type VariantReport,
} from './types.ts';
import { MIB } from './utils.ts';

export interface SuiteObserver {
  onVariantStart?(limit: ResourceLimit): void;
  onScenarioStart?(scenario: Scenario): void;
  onTaskRun?(scenario: TaskScenario, index: number, outcome: TaskOutcome, measured: boolean): void;
  onScenarioResult?(result: ScenarioResult): void;
  onScenarioSkipped?(scenario: Scenario, reason: string): void;
  onIdleSampled?(idle: ResourceUsage | null): void;
  onVersion?(version: string): void;
}

export const DEFAULT_PANEL_SCENARIOS: readonly Scenario[] = [
  {
    kind: 'load',
    name: 'settings (unauth)',
    operation: 'health',
    auth: 'unauthenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  {
    kind: 'load',
    name: 'account (auth)',
    operation: 'account',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  {
    kind: 'load',
    name: 'list servers (auth)',
    operation: 'listServers',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
];

const TASK_DEFAULTS = { kind: 'task', auth: 'authenticated', repetitions: 5, warmup: true } as const;

/**
 * Above this many entries a listing is measured as a sequential task instead: the response runs into
 * the megabytes, so a saturating run measures the load generator buffering bodies as much as the
 * daemon producing them, and nothing issues such listings back to back anyway.
 */
const LIST_LOAD_LIMIT = 1_000;

function listScenarioName(entries: number): string {
  return `list directory (${entries} entries)`;
}

export const DEFAULT_DAEMON_SCENARIOS: readonly Scenario[] = [
  {
    kind: 'load',
    name: 'system info',
    operation: 'system',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  ...LIST_SIZES.filter((entries) => entries <= LIST_LOAD_LIMIT).map(
    (entries): Scenario => ({
      kind: 'load',
      name: listScenarioName(entries),
      operation: 'listDirectory',
      auth: 'authenticated',
      load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
      params: { entries },
    }),
  ),
  ...LIST_SIZES.filter((entries) => entries > LIST_LOAD_LIMIT).map(
    (entries): Scenario => ({
      ...TASK_DEFAULTS,
      name: listScenarioName(entries),
      operation: 'listDirectory',
      repetitions: 10,
      params: { entries },
    }),
  ),
  {
    kind: 'load',
    name: 'download file (4 KiB)',
    operation: 'fileContents',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
    params: { file: 'small' },
  },
  {
    kind: 'load',
    name: 'download file (8 MiB)',
    operation: 'fileContents',
    auth: 'authenticated',
    load: { concurrency: 8, durationMs: 10_000, warmupMs: 1_000 },
  },
  {
    kind: 'load',
    name: 'chmod file',
    operation: 'chmod',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  ...archiveTasks('compress', [
    { tree: '100m', format: 'tar.gz' },
    { tree: '1g', format: 'tar.gz' },
    { tree: 'many', format: 'tar.gz' },
    { tree: '100m', format: 'zip' },
  ]),
  ...archiveTasks('decompress', [
    { tree: '100m', format: 'tar.gz' },
    { tree: '1g', format: 'tar.gz' },
    { tree: 'many', format: 'tar.gz' },
    { tree: '100m', format: 'zip' },
    { tree: '1g', format: 'zip' },
  ]),
  ...['100m', '1g', 'many'].map(
    (tree): Scenario => ({
      ...TASK_DEFAULTS,
      name: `delete ${treeLabel(tree)} tree`,
      operation: 'deleteTree',
      params: { tree },
    }),
  ),
  { ...TASK_DEFAULTS, name: 'upload file (256 MiB)', operation: 'writeFile' },
  { ...TASK_DEFAULTS, name: 'sftp login', operation: 'sftpLogin', repetitions: 10 },
  ...LIST_SIZES.filter((entries) => entries > LIST_LOAD_LIMIT).map(
    (entries): Scenario => ({
      ...TASK_DEFAULTS,
      name: `sftp list directory (${entries} entries)`,
      operation: 'sftpList',
      repetitions: 10,
      params: { entries },
    }),
  ),
  { ...TASK_DEFAULTS, name: 'sftp upload file (256 MiB)', operation: 'sftpUpload' },
  { ...TASK_DEFAULTS, name: 'sftp download file (256 MiB)', operation: 'sftpDownload' },
  ...['100m', 'many'].map(
    (tree): Scenario => ({
      ...TASK_DEFAULTS,
      name: `sftp download ${treeLabel(tree)} tree`,
      operation: 'sftpGetTree',
      params: { tree },
    }),
  ),
  ...['100m', 'many'].map(
    (tree): Scenario => ({
      ...TASK_DEFAULTS,
      name: `sftp upload ${treeLabel(tree)} tree`,
      operation: 'sftpPutTree',
      params: { tree },
    }),
  ),
];

interface ArchiveCase {
  readonly tree: string;
  readonly format: ArchiveFormat;
}

function archiveTasks(operation: 'compress' | 'decompress', cases: readonly ArchiveCase[]): Scenario[] {
  const noun = operation === 'compress' ? 'tree' : 'archive';
  return cases.map((entry) => ({
    ...TASK_DEFAULTS,
    name: `${operation} ${treeLabel(entry.tree)} ${noun} (${entry.format})`,
    operation,
    params: { tree: entry.tree, format: entry.format },
  }));
}

function treeLabel(tree: string): string {
  return treeProfile(tree).label;
}

export const KNOWN_LOAD_OPERATIONS: readonly Operation[] = [
  'health',
  'login',
  'account',
  'listServers',
  'websocketCredentials',
  'system',
  'listDirectory',
  'fileContents',
  'chmod',
];
export const KNOWN_TASK_OPERATIONS: readonly TaskOperation[] = [
  'compress',
  'decompress',
  'deleteTree',
  'writeFile',
  'listDirectory',
  'sftpLogin',
  'sftpUpload',
  'sftpDownload',
  'sftpList',
  'sftpGetTree',
  'sftpPutTree',
];

export const DEFAULT_VARIANTS: readonly ResourceLimit[] = [{ cpus: 1 }, { cpus: 2 }, { cpus: 4 }];

export interface LoadOverrides {
  readonly concurrency?: number;
  readonly durationMs?: number;
  readonly requests?: number;
  readonly warmupMs?: number;
}

export interface TaskOverrides {
  readonly repetitions?: number;
  readonly warmup?: boolean;
}

export interface ScenarioOptions {
  readonly filter?: ReadonlySet<string>;
  readonly trees?: ReadonlySet<string>;
  readonly formats?: ReadonlySet<string>;
  readonly load?: LoadOverrides;
  readonly task?: TaskOverrides;
}

export function defaultScenarios(kind: TargetKind): readonly Scenario[] {
  return kind === 'panel' ? DEFAULT_PANEL_SCENARIOS : DEFAULT_DAEMON_SCENARIOS;
}

export function resolveScenarios(kind: TargetKind, options: ScenarioOptions = {}): readonly Scenario[] {
  const scenarios = defaultScenarios(kind).filter((scenario) => matches(scenario, options));
  return scenarios.map((scenario) => applyOverrides(scenario, options));
}

function matches(scenario: Scenario, options: ScenarioOptions): boolean {
  if (options.filter !== undefined && !options.filter.has(scenario.operation)) {
    return false;
  }
  const params = scenario.params ?? {};
  if (options.trees !== undefined && params.tree !== undefined && !options.trees.has(String(params.tree))) {
    return false;
  }
  if (options.formats !== undefined && params.format !== undefined && !options.formats.has(String(params.format))) {
    return false;
  }
  return true;
}

function applyOverrides(scenario: Scenario, options: ScenarioOptions): Scenario {
  if (scenario.kind === 'load') {
    const overrides = options.load ?? {};
    const load = { ...scenario.load };
    if (overrides.concurrency !== undefined) {
      load.concurrency = overrides.concurrency;
    }
    if (overrides.warmupMs !== undefined) {
      load.warmupMs = overrides.warmupMs;
    }
    if (overrides.requests !== undefined) {
      load.requests = overrides.requests;
      load.durationMs = undefined;
    } else if (overrides.durationMs !== undefined) {
      load.durationMs = overrides.durationMs;
      load.requests = undefined;
    }
    return { ...scenario, load };
  }

  const overrides = options.task ?? {};
  return {
    ...scenario,
    repetitions: overrides.repetitions ?? scenario.repetitions,
    warmup: overrides.warmup ?? scenario.warmup,
  };
}

export function consoleObserver(): SuiteObserver {
  return {
    onVariantStart: (limit) => {
      const mem = limit.memoryMb !== undefined ? `, ${limit.memoryMb}MB` : '';
      console.log(colors.bold(colors.cyan(`\n=== variant: ${limit.cpus} cpu${mem} ===`)));
    },
    onScenarioStart: (scenario) => {
      if (scenario.kind === 'task') {
        const warmup = scenario.warmup ? ' + warmup' : '';
        console.log(colors.cyan(`▶ ${scenario.name}`) + colors.dim(` (${scenario.repetitions} runs${warmup})...`));
        return;
      }
      const window =
        scenario.load.durationMs !== undefined
          ? `${scenario.load.durationMs / 1000}s`
          : `${scenario.load.requests} reqs`;
      console.log(colors.cyan(`▶ ${scenario.name}`) + colors.dim(` (c=${scenario.load.concurrency}, ${window})...`));
    },
    onTaskRun: (_scenario, index, outcome, measured) => {
      const label = measured ? `run ${index}` : 'warmup';
      const state = outcome.ok
        ? `${outcome.elapsedMs.toFixed(0)} ms`
        : colors.red(`failed (${outcome.status}) ${outcome.detail ?? ''}`);
      console.log(colors.dim(`    ${label}: ${state}`));
    },
    onScenarioResult: (result) => {
      const res = result.resources;
      const resStr = res !== null ? ` · cpu ${res.cpuPercentMean.toFixed(0)}% heap ${res.heapMbMean.toFixed(0)}MB` : '';
      if (result.kind === 'task') {
        const median = result.stats !== null ? `${result.stats.median.toFixed(0)} ms median` : 'no successful runs';
        const rate = result.mbPerSec !== null ? ` · ${result.mbPerSec.toFixed(1)} MiB/s` : '';
        console.log(colors.dim(`  done: ${result.ok} ok / ${result.failed} failed · ${median}${rate}${resStr}`));
        return;
      }
      console.log(
        colors.dim(
          `  done: ${result.ok} ok / ${result.ratelimited} ratelimited / ${result.failed} failed / ${result.errored} errored · ${result.throughput.toFixed(0)} req/s${resStr}`,
        ),
      );
    },
    onScenarioSkipped: (scenario, reason) => console.log(colors.yellow(`skipped ${scenario.name}: ${reason}`)),
    onVersion: (version) => console.log(colors.dim(`  version: ${version}`)),
    onIdleSampled: (idle) => {
      if (idle !== null) {
        console.log(
          colors.dim(`  idle baseline: cpu ${idle.cpuPercentMean.toFixed(1)}% heap ${idle.heapMbMean.toFixed(0)}MB`),
        );
      }
    },
  };
}

export interface SuiteOptions {
  readonly target: Target;
  readonly scenarios?: readonly Scenario[];
  readonly scenarioOptions?: ScenarioOptions;
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
  readonly pull?: boolean;
}

const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const IDLE_SAMPLE_MS = 3_000;
const IDLE_SAMPLE_INTERVAL_MS = 500;

export class Suite {
  private readonly target: Target;
  private readonly scenarioList: readonly Scenario[];
  private readonly variantList: readonly ResourceLimit[];
  private readonly obs: SuiteObserver;
  private readonly shouldPull: boolean;
  private stackUp = false;
  private version: string | null = null;

  constructor(options: SuiteOptions) {
    this.target = options.target;
    this.scenarioList = options.scenarios ?? resolveScenarios(options.target.kind, options.scenarioOptions);
    this.variantList = options.variants ?? DEFAULT_VARIANTS;
    this.obs = options.observer ?? consoleObserver();
    this.shouldPull = options.pull ?? true;
  }

  get scenarioCount(): number {
    return this.scenarioList.length;
  }

  async run(): Promise<SuiteReport> {
    const target = this.target;
    const observer = this.obs;
    const startedAt = new Date().toISOString();
    const variants: VariantReport[] = [];

    const onSignal = this.makeSignalHandler();
    for (const signal of CLEANUP_SIGNALS) {
      process.on(signal, onSignal);
    }

    if (this.shouldPull) {
      await target.pull();
    }

    try {
      for (const limit of this.variantList) {
        observer.onVariantStart?.(limit);
        variants.push(await this.runVariant(target, limit, observer));
      }
      // Built inside the try so the notes are read before release() frees what they describe.
      return {
        target: target.label,
        kind: target.kind,
        version: this.version,
        storage: target.storage,
        startedAt,
        notes: target.notes(),
        variants,
      };
    } finally {
      for (const signal of CLEANUP_SIGNALS) {
        process.off(signal, onSignal);
      }
      // Never let a cleanup failure mask the error on its way out.
      await target.release().catch((err: unknown) => console.error(colors.red('release failed:'), err));
    }
  }

  private makeSignalHandler(): (signal: NodeJS.Signals) => void {
    let cleaningUp = false;
    return (signal) => {
      const exitCode = signal === 'SIGTERM' ? 143 : 130;
      if (cleaningUp) {
        process.exit(exitCode);
      }
      cleaningUp = true;
      console.log(colors.yellow(`\nreceived ${signal}, tearing down...`));
      const teardown = this.stackUp ? this.target.stop() : Promise.resolve();
      teardown
        .catch((err: unknown) => console.error(colors.red('cleanup failed:'), err))
        .finally(() => process.exit(exitCode));
    };
  }

  private async runVariant(target: Target, limit: ResourceLimit, observer: SuiteObserver): Promise<VariantReport> {
    const runner = target.tasks();
    const dataset = runner !== null ? await runner.prepare(this.scenarioList) : null;

    this.stackUp = true;
    try {
      await target.start(limit);
      const containerId = await target.containerId();
      await this.readVersion(target, observer);
      const idle = await this.sampleIdle(containerId, observer);
      const needsAuth = this.scenarioList.some((scenario) => scenario.auth === 'authenticated');
      const authenticated = needsAuth ? await target.authenticate() : UNAUTHENTICATED;

      const results: ScenarioResult[] = [];
      for (const scenario of this.scenarioList) {
        const auth = scenario.auth === 'authenticated' ? authenticated : UNAUTHENTICATED;
        const result =
          scenario.kind === 'load'
            ? await this.runLoad(target, scenario, auth, containerId, idle, observer)
            : await this.runTask(target, runner, scenario, auth, dataset, containerId, idle, observer);
        if (result !== null) {
          results.push(result);
        }
      }
      return { limit, idle, results };
    } finally {
      await target.stop();
      this.stackUp = false;
    }
  }

  private async readVersion(target: Target, observer: SuiteObserver): Promise<void> {
    if (this.version !== null) {
      return;
    }
    this.version = await target.version().catch(() => null);
    if (this.version !== null) {
      observer.onVersion?.(this.version);
    }
  }

  private async sampleIdle(containerId: string | null, observer: SuiteObserver): Promise<ResourceUsage | null> {
    if (containerId === null) {
      return null;
    }
    const sampler = new ResourceSampler(containerId, IDLE_SAMPLE_INTERVAL_MS, this.target.heapIncludesShmem);
    await sampler.start();
    await sleep(IDLE_SAMPLE_MS);
    const idle = await sampler.stop();
    observer.onIdleSampled?.(idle);
    return idle;
  }

  private async runLoad(
    target: Target,
    scenario: LoadScenario,
    auth: AuthContext,
    containerId: string | null,
    idle: ResourceUsage | null,
    observer: SuiteObserver,
  ): Promise<LoadResult | null> {
    const spec = target.buildRequest(scenario.operation, auth, scenario.params);
    if (spec === null) {
      observer.onScenarioSkipped?.(scenario, `operation '${scenario.operation}' unsupported by ${target.label}`);
      return null;
    }

    observer.onScenarioStart?.(scenario);

    await warmupOha(spec, scenario.load);

    const sampler = containerId !== null ? new ResourceSampler(containerId, 500, target.heapIncludesShmem) : null;
    await sampler?.start();
    const measurement = await runOha(spec, scenario.load);
    const resources = sampler !== null ? await sampler.stop() : null;

    let ok = 0;
    let failed = 0;
    let ratelimited = 0;
    for (const [status, count] of Object.entries(measurement.statusCounts)) {
      const code = Number(status);
      if (code === 429) {
        ratelimited += count;
      } else if (code < 400) {
        ok += count;
      } else {
        failed += count;
      }
    }

    const responses = ok + ratelimited + failed;
    const result: LoadResult = {
      kind: 'load',
      scenario,
      ok,
      ratelimited,
      failed,
      errored: measurement.errored,
      elapsedMs: measurement.elapsedMs,
      throughput: measurement.throughput,
      latency: measurement.latency,
      statusCounts: measurement.statusCounts,
      resources,
      cpuMsPerRequest: responses > 0 ? workCpuMs(resources, idle) / responses : null,
    };

    observer.onScenarioResult?.(result);
    return result;
  }

  private async runTask(
    target: Target,
    runner: TaskRunner | null,
    scenario: TaskScenario,
    auth: AuthContext,
    dataset: Dataset | null,
    containerId: string | null,
    idle: ResourceUsage | null,
    observer: SuiteObserver,
  ): Promise<TaskResult | null> {
    if (runner === null || dataset === null) {
      observer.onScenarioSkipped?.(scenario, `task scenarios unsupported by ${target.label}`);
      return null;
    }
    const unsupported = runner.unsupported(scenario, dataset);
    if (unsupported !== null) {
      observer.onScenarioSkipped?.(scenario, unsupported);
      return null;
    }

    observer.onScenarioStart?.(scenario);

    const total = scenario.repetitions + (scenario.warmup ? 1 : 0);
    const runsMs: number[] = [];
    const failures: string[] = [];
    const usages: (ResourceUsage | null)[] = [];
    const statusCounts: Record<number, number> = {};
    let ok = 0;
    let failed = 0;
    let bytes = 0;

    for (let index = 0; index < total; index += 1) {
      const measured = !(scenario.warmup && index === 0);
      await runner.reset(scenario, dataset);

      const sampler = containerId !== null ? new ResourceSampler(containerId, 250, target.heapIncludesShmem) : null;
      await sampler?.start();
      const outcome = await runner.run(scenario, dataset, auth);
      const usage = sampler !== null ? await sampler.stop() : null;

      observer.onTaskRun?.(scenario, scenario.warmup ? index : index + 1, outcome, measured);
      if (!measured) {
        continue;
      }
      bytes = outcome.bytes;
      statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
      if (outcome.ok) {
        ok += 1;
        runsMs.push(outcome.elapsedMs);
        usages.push(usage);
      } else {
        failed += 1;
        failures.push(outcome.detail ?? `status ${outcome.status}`);
      }
    }

    const stats = runsMs.length > 0 ? taskStats(runsMs) : null;
    const medianUsage = medianRunUsage(runsMs, usages);
    const result: TaskResult = {
      kind: 'task',
      scenario,
      ok,
      failed,
      runsMs,
      stats,
      bytes,
      mbPerSec: stats !== null && bytes > 0 && stats.median > 0 ? bytes / MIB / (stats.median / 1000) : null,
      statusCounts,
      failures,
      resources: medianUsage,
      cpuMsPerRun: medianUsage !== null ? workCpuMs(medianUsage, idle) : null,
    };

    observer.onScenarioResult?.(result);
    return result;
  }
}

function workCpuMs(usage: ResourceUsage | null, idle: ResourceUsage | null): number {
  if (usage === null) {
    return 0;
  }
  const floor = idle !== null ? (idle.cpuPercentMean / 100) * usage.windowMs : 0;
  return Math.max(0, usage.cpuMs - floor);
}

/**
 * Picks the resource sample belonging to the run whose duration is the median, so the reported CPU
 * and the reported duration describe one and the same run. With an even number of runs the lower
 * of the two middle runs is used.
 */
function medianRunUsage(runsMs: readonly number[], usages: readonly (ResourceUsage | null)[]): ResourceUsage | null {
  if (runsMs.length === 0) {
    return null;
  }
  const order = runsMs.map((ms, index) => ({ ms, index })).sort((a, b) => a.ms - b.ms);
  return usages[order[Math.floor((order.length - 1) / 2)]!.index] ?? null;
}

function taskStats(runsMs: readonly number[]): { min: number; max: number; mean: number; median: number } {
  const sorted = [...runsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  let sum = 0;
  for (const value of sorted) {
    sum += value;
  }
  return { min: sorted[0]!, max: sorted[sorted.length - 1]!, mean: sum / sorted.length, median };
}
