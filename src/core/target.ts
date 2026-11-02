import { setTimeout as sleep } from 'node:timers/promises';
import colors from 'ansi-colors';
import type { Dataset } from './dataset.ts';
import {
  type ComposeConfig,
  composeContainerId,
  composeDown,
  composePull,
  composeServices,
  composeUp,
  isPortConflict,
} from './docker.ts';
import {
  type AuthContext,
  type Operation,
  type RequestSpec,
  type ResourceLimit,
  type Scenario,
  type ScenarioParams,
  type TargetKind,
  type TaskScenario,
  UNAUTHENTICATED,
} from './types.ts';
import { PORT_ATTEMPTS, portAvailable } from './utils.ts';

export interface TaskOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly elapsedMs: number;
  readonly bytes: number;
  readonly detail?: string;
}

export interface TaskRunner {
  prepare(scenarios: readonly Scenario[]): Promise<Dataset>;
  unsupported(scenario: TaskScenario, dataset: Dataset): string | null;
  reset(scenario: TaskScenario, dataset: Dataset): Promise<void>;
  run(scenario: TaskScenario, dataset: Dataset, auth: AuthContext): Promise<TaskOutcome>;
}

export abstract class Target {
  abstract readonly name: string;
  abstract readonly kind: TargetKind;
  abstract readonly baseUrl: string;

  abstract start(limit: ResourceLimit): Promise<void>;
  abstract stop(): Promise<void>;

  async pull(): Promise<void> {
    return undefined;
  }

  async version(): Promise<string | null> {
    return null;
  }

  /** Frees what the target generated on disk, once its suite no longer needs it. */
  async release(): Promise<void> {
    return undefined;
  }

  abstract containerId(): Promise<string | null>;
  abstract authenticate(): Promise<AuthContext>;

  abstract buildRequest(operation: Operation, auth: AuthContext, params?: ScenarioParams): RequestSpec | null;

  get label(): string {
    return `${this.kind}:${this.name}`;
  }

  tasks(): TaskRunner | null {
    return null;
  }

  notes(): readonly string[] {
    return [];
  }
}

export interface ReadinessOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export abstract class DockerTarget extends Target {
  protected abstract readonly compose: ComposeConfig;
  protected abstract readonly serviceName: string;
  protected readonly healthPath: string = '/';

  protected abstract resourceEnv(limit: ResourceLimit): Record<string, string>;

  /** The host port the stack publishes, and the hook that moves it to `port` when it is contended. */
  protected abstract get hostPort(): number;
  protected abstract rebindPort(port: number): void;

  /** Further host ports the stack publishes, which move along with `hostPort` on a rebind. */
  protected get extraHostPorts(): readonly number[] {
    return [];
  }

  /** An explicitly requested port is never moved: it usually implies a tunnel or firewall rule. */
  protected portPinned = false;

  protected siblingServices: readonly string[] = [];

  async start(limit: ResourceLimit): Promise<void> {
    await this.bringUp(limit);
  }

  async stop(): Promise<void> {
    await composeDown(this.compose);
  }

  override async pull(): Promise<void> {
    console.log(colors.dim(`  pulling images for ${this.label}...`));
    try {
      await composePull(this.compose);
    } catch (error) {
      // A registry that cannot be reached is not fatal on its own: the images may already be
      // cached locally, and if they are not, bringing the stack up fails with a clearer error.
      console.log(colors.yellow(`  image pull failed, continuing with local images: ${String(error)}`));
    }
  }

  async containerId(): Promise<string | null> {
    return composeContainerId(this.compose, this.serviceName);
  }

  protected async bringUp(limit: ResourceLimit): Promise<void> {
    const base = this.hostPort;
    const attempts = this.portPinned ? 1 : PORT_ATTEMPTS;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const last = attempt + 1 >= attempts;
      if (!last && !(await this.portsAvailable())) {
        console.log(colors.yellow(`  host port ${this.hostPort} is in use, moving to ${base + attempt + 1}`));
        this.rebindPort(base + attempt + 1);
        continue;
      }
      try {
        await this.composeUpOnce(limit);
        break;
      } catch (error) {
        if (last || !isPortConflict(error)) {
          throw error;
        }
        // Compose reuses the healthy siblings and recreates only the published container, so the
        // partially created stack is left in place rather than torn down between attempts.
        console.log(colors.yellow(`  host port ${this.hostPort} was taken, retrying on ${base + attempt + 1}`));
        this.rebindPort(base + attempt + 1);
      }
    }

    console.log(colors.dim(`  waiting for ${this.label} at ${this.baseUrl}${this.healthPath}...`));
    await this.waitUntilReady();
    console.log(colors.dim(`  ${this.label} is ready`));
  }

  private async portsAvailable(): Promise<boolean> {
    for (const port of [this.hostPort, ...this.extraHostPorts]) {
      if (!(await portAvailable(port))) {
        return false;
      }
    }
    return true;
  }

  private async composeUpOnce(limit: ResourceLimit): Promise<void> {
    const config = { ...this.compose, env: { ...this.compose.env, ...this.resourceEnv(limit) } };
    this.siblingServices = (await composeServices(config)).filter((name) => name !== this.serviceName);
    console.log(colors.dim(`  bringing up compose stack (project '${config.project}', cpus=${limit.cpus})...`));
    await composeUp(config);
  }

  protected readinessHeaders(): Record<string, string> {
    return {};
  }

  protected async waitUntilReady(options: ReadinessOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const url = new URL(this.healthPath, this.baseUrl).toString();
    const headers = this.readinessHeaders();
    const deadline = performance.now() + timeoutMs;

    let lastError: unknown;
    let attempt = 0;
    while (performance.now() < deadline) {
      attempt += 1;
      try {
        const response = await fetch(url, { method: 'GET', headers });
        await response.arrayBuffer();
        if (response.ok) {
          return;
        }
        lastError = new Error(`readiness probe returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt % 5 === 0) {
        console.log(colors.dim(`    still waiting (${attempt} probes, last: ${String(lastError)})...`));
      }
      await sleep(intervalMs);
    }

    throw new Error(`${this.label} not ready after ${timeoutMs}ms: ${String(lastError)}`);
  }

  protected url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }

  protected authHeaders(auth: AuthContext): Record<string, string> {
    return auth.mode === 'authenticated' ? { ...auth.headers } : { ...UNAUTHENTICATED.headers };
  }
}
