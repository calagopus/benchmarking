import path from 'node:path';
import colors from 'ansi-colors';
import { composeExec } from '../core/docker.ts';
import { DockerPanel } from '../core/panel.ts';
import type { AuthContext, Operation, RequestSpec, ResourceLimit } from '../core/types.ts';
import { randomHighPort } from '../core/utils.ts';

export interface PelicanCredentials {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface PelicanPanelOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly image?: string;
  readonly credentials?: PelicanCredentials;
  readonly service?: string;
}

const DEFAULT_CREDENTIALS: PelicanCredentials = {
  username: 'benchmark',
  email: 'benchmark@pelican.local',
  password: 'benchmark-password-123',
};

const API_KEY_IDENTIFIER = 'pacc_benchmark01';
const API_KEY_TOKEN = 'benchmarkbenchmarkbenchmark12345';

const DEFAULT_COMPOSE_FILE = path.resolve(import.meta.dirname, '..', '..', 'docker', 'pelican.compose.yml');

export class PelicanPanel extends DockerPanel {
  readonly name = 'pelican';

  private readonly host: string;
  private readonly port: number;
  private readonly image?: string;
  private readonly credentials: PelicanCredentials;
  protected readonly serviceName: string;

  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };
  protected readonly healthPath = '/up';

  constructor(options: PelicanPanelOptions = {}) {
    super();
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? randomHighPort();
    this.image = options.image;
    this.credentials = options.credentials ?? DEFAULT_CREDENTIALS;
    this.serviceName = options.service ?? 'panel';

    const env: Record<string, string> = {
      PELICAN_PORT: String(this.port),
      PELICAN_URL: `http://${this.host}:${this.port}`,
    };
    if (this.image !== undefined) {
      env.PELICAN_IMAGE = this.image;
    }
    this.compose = {
      file: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      project: options.project ?? 'pelican-bench',
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      PELICAN_CPUS: String(limit.cpus),
      PELICAN_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  async authenticate(): Promise<AuthContext> {
    await this.seedAdminUser();
    await this.seedApiKey();

    console.log(colors.dim('  authenticated (client api key planted)'));
    return {
      mode: 'authenticated',
      headers: {
        Authorization: `Bearer ${API_KEY_IDENTIFIER}${API_KEY_TOKEN}`,
        Accept: 'application/json',
      },
    };
  }

  buildRequest(operation: Operation, auth: AuthContext): RequestSpec | null {
    switch (operation) {
      case 'health':
        return { method: 'GET', url: this.url('/up'), headers: { Accept: 'text/html' } };

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
      '--password',
      this.credentials.password,
      '--admin',
      '1',
      '--no-interaction',
    ]);

    if (result.code !== 0 && !/exist|taken|already/i.test(result.stderr + result.stdout)) {
      throw new Error(
        `failed to seed admin user (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    console.log(colors.dim(result.code === 0 ? '  admin user created' : '  admin user already existed'));
  }

  private async seedApiKey(): Promise<void> {
    console.log(colors.dim('  planting client api key via tinker...'));
    const script = [
      `$user = App\\Models\\User::query()->where('username', '${this.credentials.username}')->firstOrFail();`,
      `App\\Models\\ApiKey::query()->where('identifier', '${API_KEY_IDENTIFIER}')->delete();`,
      'App\\Models\\ApiKey::forceCreate([',
      "'user_id' => $user->id,",
      "'key_type' => App\\Models\\ApiKey::TYPE_ACCOUNT,",
      `'identifier' => '${API_KEY_IDENTIFIER}',`,
      `'token' => '${API_KEY_TOKEN}',`,
      "'memo' => 'benchmark',",
      "'allowed_ips' => [],",
      "'permissions' => [],",
      ']);',
      "echo 'api key planted';",
    ].join(' ');

    const result = await composeExec(this.compose, this.serviceName, ['php', 'artisan', 'tinker', '--execute', script]);
    if (result.code !== 0 || !result.stdout.includes('api key planted')) {
      throw new Error(
        `failed to plant client api key (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}
