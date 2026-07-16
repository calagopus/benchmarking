import path from 'node:path';
import colors from 'ansi-colors';
import { composeExec } from '../core/docker.ts';
import { DockerPanel } from '../core/panel.ts';
import {
  type AuthContext,
  type Operation,
  type RequestSpec,
  type ResourceLimit,
  UNAUTHENTICATED,
} from '../core/types.ts';

export interface CalagopusCredentials {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface CalagopusPanelOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly image?: string;
  readonly credentials?: CalagopusCredentials;
  readonly service?: string;
}

const DEFAULT_CREDENTIALS: CalagopusCredentials = {
  username: 'benchmark',
  email: 'benchmark@calagopus.local',
  password: 'benchmark-password-123',
};

const DEFAULT_COMPOSE_FILE = path.resolve(import.meta.dirname, '..', '..', 'docker', 'calagopus.compose.yml');

function randomHighPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

export class CalagopusPanel extends DockerPanel {
  readonly name = 'calagopus';

  private readonly host: string;
  private readonly port: number;
  private readonly image?: string;
  private readonly credentials: CalagopusCredentials;
  protected readonly serviceName: string;

  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };
  protected readonly healthPath = '/api/settings';

  constructor(options: CalagopusPanelOptions = {}) {
    super();
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? randomHighPort();
    this.image = options.image;
    this.credentials = options.credentials ?? DEFAULT_CREDENTIALS;
    this.serviceName = options.service ?? 'web';

    const env: Record<string, string> = { CALAGOPUS_PORT: String(this.port) };
    if (this.image !== undefined) {
      env.CALAGOPUS_IMAGE = this.image;
    }
    this.compose = {
      file: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      project: options.project ?? 'calagopus-bench',
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      CALAGOPUS_CPUS: String(limit.cpus),
      CALAGOPUS_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  async authenticate(): Promise<AuthContext> {
    await this.seedAdminUser();

    console.log(colors.dim(`  logging in as ${this.credentials.username}...`));
    const response = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: this.credentials.username, password: this.credentials.password }),
    });
    await response.arrayBuffer();

    if (!response.ok) {
      throw new Error(`calagopus login failed with status ${response.status}`);
    }

    const cookie = this.extractSessionCookie(response);
    if (cookie === null) {
      throw new Error('calagopus login did not return a session cookie');
    }

    console.log(colors.dim('  authenticated (session cookie acquired)'));
    return { mode: 'authenticated', headers: { Cookie: cookie } };
  }

  buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null {
    switch (operation) {
      case 'health':
        return { method: 'GET', url: this.url('/api/settings') };

      case 'login':
        return {
          method: 'POST',
          url: this.url('/api/auth/login'),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: this.credentials.username, password: this.credentials.password }),
        };

      case 'account':
        return { method: 'GET', url: this.url('/api/client/account'), headers: this.authHeaders(auth) };

      case 'listServers':
        return { method: 'GET', url: this.url('/api/client/servers'), headers: this.authHeaders(auth) };

      case 'websocketCredentials':
        return null;

      default:
        return null;
    }
  }

  private async seedAdminUser(): Promise<void> {
    console.log(colors.dim(`  seeding admin user '${this.credentials.username}' via panel CLI...`));
    const result = await composeExec(this.compose, this.serviceName, [
      'panel-rs',
      'users',
      'create',
      '--json',
      '--username',
      this.credentials.username,
      '--email',
      this.credentials.email,
      '--name-first',
      'Benchmark',
      '--name-last',
      'Runner',
      '--password',
      this.credentials.password,
      '--admin',
      'true',
    ]);

    if (result.code !== 0 && !/exist/i.test(result.stderr + result.stdout)) {
      throw new Error(
        `failed to seed admin user (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    console.log(colors.dim(result.code === 0 ? '  admin user created' : '  admin user already existed'));
  }

  private extractSessionCookie(response: Response): string | null {
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length === 0) {
      return null;
    }
    return setCookies.map((entry) => entry.split(';', 1)[0]).join('; ');
  }

  private authHeaders(auth: AuthContext): Record<string, string> {
    return auth.mode === 'authenticated' ? { ...auth.headers } : { ...UNAUTHENTICATED.headers };
  }

  private url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }
}
