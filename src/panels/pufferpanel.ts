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

export interface PufferPanelCredentials {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface PufferPanelOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly image?: string;
  readonly credentials?: PufferPanelCredentials;
  readonly service?: string;
}

const DEFAULT_CREDENTIALS: PufferPanelCredentials = {
  username: 'benchmark',
  email: 'benchmark@pufferpanel.local',
  password: 'benchmark-password-123',
};

const DEFAULT_COMPOSE_FILE = path.resolve(import.meta.dirname, '..', '..', 'docker', 'pufferpanel.compose.yml');

function randomHighPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

export class PufferPanel extends DockerPanel {
  readonly name = 'pufferpanel';

  private readonly host: string;
  private readonly port: number;
  private readonly image?: string;
  private readonly credentials: PufferPanelCredentials;
  protected readonly serviceName: string;

  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };
  protected readonly healthPath = '/';

  constructor(options: PufferPanelOptions = {}) {
    super();
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? randomHighPort();
    this.image = options.image;
    this.credentials = options.credentials ?? DEFAULT_CREDENTIALS;
    this.serviceName = options.service ?? 'panel';

    const env: Record<string, string> = { PUFFERPANEL_PORT: String(this.port) };
    if (this.image !== undefined) {
      env.PUFFERPANEL_IMAGE = this.image;
    }
    this.compose = {
      file: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      project: options.project ?? 'pufferpanel-bench',
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      PUFFERPANEL_CPUS: String(limit.cpus),
      PUFFERPANEL_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  async authenticate(): Promise<AuthContext> {
    await this.seedAdminUser();

    console.log(colors.dim(`  logging in as ${this.credentials.email}...`));
    const response = await fetch(this.url('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: this.credentials.email, password: this.credentials.password }),
    });
    await response.arrayBuffer();

    if (!response.ok) {
      throw new Error(`pufferpanel login failed with status ${response.status}`);
    }

    const session = parseSetCookies(response).puffer_auth;
    if (session === undefined) {
      throw new Error('pufferpanel login did not return a puffer_auth session cookie');
    }

    console.log(colors.dim('  authenticated (session cookie acquired)'));
    return {
      mode: 'authenticated',
      headers: { Cookie: `puffer_auth=${session}`, Accept: 'application/json' },
    };
  }

  buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null {
    switch (operation) {
      case 'health':
        return { method: 'GET', url: this.url('/'), headers: { Accept: 'text/html' } };

      case 'login':
        return {
          method: 'POST',
          url: this.url('/auth/login'),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: this.credentials.email, password: this.credentials.password }),
        };

      case 'account':
        return { method: 'GET', url: this.url('/api/self'), headers: this.authHeaders(auth) };

      case 'listServers':
        return { method: 'GET', url: this.url('/api/servers'), headers: this.authHeaders(auth) };

      case 'websocketCredentials':
        return null;

      default:
        return null;
    }
  }

  private async seedAdminUser(): Promise<void> {
    console.log(colors.dim(`  seeding admin user '${this.credentials.username}' via panel CLI...`));
    const result = await composeExec(this.compose, this.serviceName, [
      '/pufferpanel/bin/pufferpanel',
      'user',
      'add',
      '--name',
      this.credentials.username,
      '--email',
      this.credentials.email,
      '--password',
      this.credentials.password,
      '--admin',
    ]);

    if (result.code !== 0 && !/exist|taken|already|unique/i.test(result.stderr + result.stdout)) {
      throw new Error(
        `failed to seed admin user (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    console.log(colors.dim(result.code === 0 ? '  admin user created' : '  admin user already existed'));
  }

  private authHeaders(auth: AuthContext): Record<string, string> {
    return auth.mode === 'authenticated' ? { ...auth.headers } : { ...UNAUTHENTICATED.headers };
  }

  private url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }
}

function parseSetCookies(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) {
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}
