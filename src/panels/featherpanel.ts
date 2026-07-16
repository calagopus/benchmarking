import path from 'node:path';
import colors from 'ansi-colors';
import { DockerPanel } from '../core/panel.ts';
import type { AuthContext, Operation, RequestSpec, ResourceLimit } from '../core/types.ts';
import { parseSetCookies, randomHighPort } from '../core/utils.ts';

export interface FeatherPanelCredentials {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface FeatherPanelPanelOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly image?: string;
  readonly credentials?: FeatherPanelCredentials;
  readonly service?: string;
}

const DEFAULT_CREDENTIALS: FeatherPanelCredentials = {
  username: 'benchmark',
  email: 'benchmark@featherpanel.local',
  password: 'benchmark-password-123',
};

const DEFAULT_COMPOSE_FILE = path.resolve(import.meta.dirname, '..', '..', 'docker', 'featherpanel.compose.yml');

export class FeatherPanelPanel extends DockerPanel {
  readonly name = 'featherpanel';

  private readonly host: string;
  private readonly port: number;
  private readonly image?: string;
  private readonly credentials: FeatherPanelCredentials;
  protected readonly serviceName: string;

  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };
  protected readonly healthPath = '/api/system/settings';

  constructor(options: FeatherPanelPanelOptions = {}) {
    super();
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? randomHighPort();
    this.image = options.image;
    this.credentials = options.credentials ?? DEFAULT_CREDENTIALS;
    this.serviceName = options.service ?? 'backend';

    const env: Record<string, string> = { FEATHERPANEL_PORT: String(this.port) };
    if (this.image !== undefined) {
      env.FEATHERPANEL_IMAGE = this.image;
    }
    this.compose = {
      file: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      project: options.project ?? 'featherpanel-bench',
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      FEATHERPANEL_CPUS: String(limit.cpus),
      FEATHERPANEL_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  async authenticate(): Promise<AuthContext> {
    await this.registerUser();

    console.log(colors.dim(`  logging in as ${this.credentials.username}...`));
    const response = await fetch(this.url('/api/user/auth/login'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username_or_email: this.credentials.username,
        password: this.credentials.password,
      }),
    });
    await response.arrayBuffer();

    if (!response.ok) {
      throw new Error(`featherpanel login failed with status ${response.status}`);
    }

    const token = parseSetCookies(response).remember_token;
    if (token === undefined) {
      throw new Error('featherpanel login did not return a remember_token cookie');
    }

    console.log(colors.dim('  authenticated (session cookie acquired)'));
    return {
      mode: 'authenticated',
      headers: { Cookie: `remember_token=${token}`, Accept: 'application/json' },
    };
  }

  buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null {
    switch (operation) {
      case 'health':
        return { method: 'GET', url: this.url('/api/system/settings'), headers: { Accept: 'application/json' } };

      case 'account':
        return { method: 'GET', url: this.url('/api/user/session'), headers: this.authHeaders(auth) };

      case 'listServers':
        return { method: 'GET', url: this.url('/api/user/servers'), headers: this.authHeaders(auth) };

      case 'login':
      case 'websocketCredentials':
        return null;

      default:
        return null;
    }
  }

  private async registerUser(): Promise<void> {
    console.log(colors.dim(`  registering user '${this.credentials.username}' via public api...`));
    const response = await fetch(this.url('/api/user/auth/register'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username: this.credentials.username,
        email: this.credentials.email,
        password: this.credentials.password,
        first_name: 'Benchmark',
        last_name: 'Runner',
      }),
    });
    const body = await response.text();

    if (!response.ok && !/ALREADY_EXISTS/i.test(body)) {
      throw new Error(`failed to register user (status ${response.status}): ${body.slice(0, 300)}`);
    }
    console.log(colors.dim(response.ok ? '  user registered' : '  user already existed'));
  }
}
