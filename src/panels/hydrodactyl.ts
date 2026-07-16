import path from 'node:path';
import colors from 'ansi-colors';
import { composeExec } from '../core/docker.ts';
import { DockerPanel } from '../core/panel.ts';
import type { AuthContext, Operation, RequestSpec, ResourceLimit } from '../core/types.ts';
import { cookieHeader, parseSetCookies, randomHighPort } from '../core/utils.ts';

export interface HydrodactylCredentials {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface HydrodactylPanelOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly image?: string;
  readonly credentials?: HydrodactylCredentials;
  readonly service?: string;
}

const DEFAULT_CREDENTIALS: HydrodactylCredentials = {
  username: 'benchmark',
  email: 'benchmark@hydrodactyl.local',
  password: 'benchmark-password-123',
};

const DEFAULT_COMPOSE_FILE = path.resolve(import.meta.dirname, '..', '..', 'docker', 'hydrodactyl.compose.yml');

export class HydrodactylPanel extends DockerPanel {
  readonly name = 'hydrodactyl';

  private readonly host: string;
  private readonly port: number;
  private readonly image?: string;
  private readonly credentials: HydrodactylCredentials;
  protected readonly serviceName: string;

  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };
  protected readonly healthPath = '/';

  constructor(options: HydrodactylPanelOptions = {}) {
    super();
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? randomHighPort();
    this.image = options.image;
    this.credentials = options.credentials ?? DEFAULT_CREDENTIALS;
    this.serviceName = options.service ?? 'panel';

    const env: Record<string, string> = {
      HYDRODACTYL_PORT: String(this.port),
      HYDRODACTYL_URL: `http://${this.host}:${this.port}`,
    };
    if (this.image !== undefined) {
      env.HYDRODACTYL_IMAGE = this.image;
    }
    this.compose = {
      file: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      project: options.project ?? 'hydrodactyl-bench',
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      HYDRODACTYL_CPUS: String(limit.cpus),
      HYDRODACTYL_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  async authenticate(): Promise<AuthContext> {
    await this.seedAdminUser();

    console.log(colors.dim(`  logging in as ${this.credentials.username}...`));
    const primer = await fetch(this.url('/auth/login'), { headers: { Accept: 'text/html' } });
    await primer.arrayBuffer();
    let cookies = parseSetCookies(primer);

    const xsrf = decodeURIComponent(cookies['XSRF-TOKEN'] ?? '');
    const response = await fetch(this.url('/auth/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': xsrf,
        Cookie: cookieHeader(cookies),
      },
      body: JSON.stringify({ user: this.credentials.username, password: this.credentials.password }),
    });
    await response.arrayBuffer();

    if (!response.ok) {
      throw new Error(`hydrodactyl login failed with status ${response.status}`);
    }

    cookies = { ...cookies, ...parseSetCookies(response) };
    if (Object.keys(cookies).every((name) => !name.endsWith('_session'))) {
      throw new Error('hydrodactyl login did not return a session cookie');
    }

    console.log(colors.dim('  authenticated (session cookie acquired)'));
    return { mode: 'authenticated', headers: { Cookie: cookieHeader(cookies), Accept: 'application/json' } };
  }

  buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null {
    switch (operation) {
      case 'health':
        return { method: 'GET', url: this.url('/'), headers: { Accept: 'text/html' } };

      case 'account':
        return { method: 'GET', url: this.url('/api/client/account'), headers: this.authHeaders(auth) };

      case 'listServers':
        return { method: 'GET', url: this.url('/api/client'), headers: this.authHeaders(auth) };

      case 'login':
      case 'websocketCredentials':
        return null;

      default:
        return null;
    }
  }

  private async seedAdminUser(): Promise<void> {
    console.log(colors.dim(`  seeding admin user '${this.credentials.username}' via panel CLI...`));
    const result = await composeExec(this.compose, this.serviceName, [
      'php',
      'artisan',
      'p:user:make',
      '--email',
      this.credentials.email,
      '--username',
      this.credentials.username,
      '--name-first',
      'Benchmark',
      '--name-last',
      'Runner',
      '--password',
      this.credentials.password,
      '--admin',
      '--no-interaction',
    ]);

    if (result.code !== 0 && !/exist|taken|already/i.test(result.stderr + result.stdout)) {
      throw new Error(
        `failed to seed admin user (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    console.log(colors.dim(result.code === 0 ? '  admin user created' : '  admin user already existed'));
  }
}
