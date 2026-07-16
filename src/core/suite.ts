import colors from 'ansi-colors';
import { runOha } from './oha.ts';
import type { Panel } from './panel.ts';
import { ResourceSampler } from './resources.ts';
import {
  type AuthContext,
  type ResourceLimit,
  type Scenario,
  type ScenarioResult,
  type SuiteReport,
  UNAUTHENTICATED,
  type VariantReport,
} from './types.ts';

export interface SuiteObserver {
  onVariantStart?(limit: ResourceLimit): void;
  onScenarioStart?(scenario: Scenario): void;
  onScenarioResult?(result: ScenarioResult): void;
  onScenarioSkipped?(scenario: Scenario, reason: string): void;
}

export const DEFAULT_SCENARIOS: readonly Scenario[] = [
  {
    name: 'settings (unauth)',
    operation: 'health',
    auth: 'unauthenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  {
    name: 'account (auth)',
    operation: 'account',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
  {
    name: 'list servers (auth)',
    operation: 'listServers',
    auth: 'authenticated',
    load: { concurrency: 32, durationMs: 10_000, warmupMs: 1_000 },
  },
];

export const DEFAULT_VARIANTS: readonly ResourceLimit[] = [{ cpus: 1 }, { cpus: 2 }, { cpus: 4 }];

export function consoleObserver(): SuiteObserver {
  return {
    onVariantStart: (limit) => {
      const mem = limit.memoryMb !== undefined ? `, ${limit.memoryMb}MB` : '';
      console.log(colors.bold(colors.cyan(`\n=== variant: ${limit.cpus} cpu${mem} ===`)));
    },
    onScenarioStart: (scenario) => {
      const window =
        scenario.load.durationMs !== undefined
          ? `${scenario.load.durationMs / 1000}s`
          : `${scenario.load.requests} reqs`;
      console.log(colors.cyan(`▶ ${scenario.name}`) + colors.dim(` (c=${scenario.load.concurrency}, ${window})...`));
    },
    onScenarioResult: (result) => {
      const res = result.resources;
      const resStr = res !== null ? ` · cpu ${res.cpuPercentMean.toFixed(0)}% mem ${res.memMbMean.toFixed(0)}MB` : '';
      console.log(
        colors.dim(
          `  done: ${result.ok} ok / ${result.ratelimited} ratelimited / ${result.failed} failed / ${result.errored} errored · ${result.throughput.toFixed(0)} req/s${resStr}`,
        ),
      );
    },
    onScenarioSkipped: (scenario, reason) => console.log(colors.yellow(`skipped ${scenario.name}: ${reason}`)),
  };
}

export interface SuiteOptions {
  readonly panel: Panel;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export class Suite {
  private readonly panelInstance: Panel;
  private readonly scenarioList: readonly Scenario[];
  private readonly variantList: readonly ResourceLimit[];
  private readonly obs: SuiteObserver;
  private stackUp = false;

  constructor(options: SuiteOptions) {
    this.panelInstance = options.panel;
    this.scenarioList = options.scenarios ?? DEFAULT_SCENARIOS;
    this.variantList = options.variants ?? DEFAULT_VARIANTS;
    this.obs = options.observer ?? consoleObserver();
  }

  async run(): Promise<SuiteReport> {
    const panel = this.panelInstance;
    const observer = this.obs;
    const startedAt = new Date().toISOString();
    const variants: VariantReport[] = [];

    const onSignal = this.makeSignalHandler();
    for (const signal of CLEANUP_SIGNALS) {
      process.on(signal, onSignal);
    }

    try {
      for (const limit of this.variantList) {
        observer.onVariantStart?.(limit);
        variants.push({ limit, results: await this.runVariant(panel, limit, observer) });
      }
    } finally {
      for (const signal of CLEANUP_SIGNALS) {
        process.off(signal, onSignal);
      }
    }

    return { panel: panel.name, startedAt, variants };
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
      const teardown = this.stackUp ? this.panelInstance.stop() : Promise.resolve();
      teardown
        .catch((err: unknown) => console.error(colors.red('cleanup failed:'), err))
        .finally(() => process.exit(exitCode));
    };
  }

  private async runVariant(panel: Panel, limit: ResourceLimit, observer: SuiteObserver): Promise<ScenarioResult[]> {
    this.stackUp = true;
    await panel.start(limit);
    try {
      const containerId = await panel.containerId();
      const needsAuth = this.scenarioList.some((scenario) => scenario.auth === 'authenticated');
      const authenticated = needsAuth ? await panel.authenticate() : UNAUTHENTICATED;

      const results: ScenarioResult[] = [];
      for (const scenario of this.scenarioList) {
        const result = await this.runScenario(panel, scenario, authenticated, containerId, observer);
        if (result !== null) {
          results.push(result);
        }
      }
      return results;
    } finally {
      await panel.stop();
      this.stackUp = false;
    }
  }

  private async runScenario(
    panel: Panel,
    scenario: Scenario,
    authenticated: AuthContext,
    containerId: string | null,
    observer: SuiteObserver,
  ): Promise<ScenarioResult | null> {
    const auth = scenario.auth === 'authenticated' ? authenticated : UNAUTHENTICATED;
    const spec = panel.buildRequest(scenario.operation, auth);
    if (spec === null) {
      observer.onScenarioSkipped?.(scenario, `operation '${scenario.operation}' unsupported by ${panel.name}`);
      return null;
    }

    observer.onScenarioStart?.(scenario);

    const sampler = containerId !== null ? new ResourceSampler(containerId) : null;
    sampler?.start();
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

    const result: ScenarioResult = {
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
    };

    observer.onScenarioResult?.(result);
    return result;
  }
}
