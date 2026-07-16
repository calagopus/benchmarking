import { setTimeout as sleep } from 'node:timers/promises';
import colors from 'ansi-colors';
import { type ComposeConfig, composeContainerId, composeDown, composeUp } from './docker.ts';
import { type AuthContext, type Operation, type RequestSpec, type ResourceLimit, UNAUTHENTICATED } from './types.ts';

export abstract class Panel {
  abstract readonly name: string;
  abstract readonly baseUrl: string;

  abstract start(limit: ResourceLimit): Promise<void>;
  abstract stop(): Promise<void>;

  abstract containerId(): Promise<string | null>;
  abstract authenticate(): Promise<AuthContext>;

  abstract buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null;
}

export interface ReadinessOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export abstract class DockerPanel extends Panel {
  protected abstract readonly compose: ComposeConfig;
  protected abstract readonly serviceName: string;
  protected readonly healthPath: string = '/';

  protected abstract resourceEnv(limit: ResourceLimit): Record<string, string>;

  async start(limit: ResourceLimit): Promise<void> {
    const config = { ...this.compose, env: { ...this.compose.env, ...this.resourceEnv(limit) } };
    console.log(colors.dim(`  bringing up compose stack (project '${config.project}', cpus=${limit.cpus})...`));
    await composeUp(config);
    console.log(colors.dim(`  waiting for ${this.name} at ${this.baseUrl}${this.healthPath}...`));
    await this.waitUntilReady();
    console.log(colors.dim(`  ${this.name} is ready`));
  }

  async stop(): Promise<void> {
    await composeDown(this.compose);
  }

  async containerId(): Promise<string | null> {
    return composeContainerId(this.compose, this.serviceName);
  }

  protected async waitUntilReady(options: ReadinessOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const url = new URL(this.healthPath, this.baseUrl).toString();
    const deadline = performance.now() + timeoutMs;

    let lastError: unknown;
    let attempt = 0;
    while (performance.now() < deadline) {
      attempt += 1;
      try {
        const response = await fetch(url, { method: 'GET' });
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

    throw new Error(`${this.name} not ready after ${timeoutMs}ms: ${String(lastError)}`);
  }

  protected url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }

  protected authHeaders(auth: AuthContext): Record<string, string> {
    return auth.mode === 'authenticated' ? { ...auth.headers } : { ...UNAUTHENTICATED.headers };
  }
}
