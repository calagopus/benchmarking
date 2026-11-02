import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileSize } from './dataset.ts';

export interface SftpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

export interface SftpResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CIPHER = 'aes128-gcm@openssh.com';
const RUN_TIMEOUT_MS = 10 * 60_000;

export class SftpClient {
  private readonly dir: string;
  private readonly controlPath: string;
  private endpoint: SftpEndpoint | null = null;
  private master = false;

  constructor(workdir: string) {
    this.dir = path.join(workdir, 'sftp');
    this.controlPath = path.join(tmpdir(), `bench-sftp-${process.pid}-%C`);
  }

  get keyFile(): string {
    return path.join(this.dir, 'id_ed25519');
  }

  static async available(): Promise<boolean> {
    const results = await Promise.all([
      exec('ssh', ['-V'], RUN_TIMEOUT_MS),
      exec('sftp', ['-h'], RUN_TIMEOUT_MS),
      exec('ssh-keygen', ['-?'], RUN_TIMEOUT_MS),
    ]);

    return results.every((result) => result.code !== null);
  }

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if ((await fileSize(this.keyFile)) !== null) {
      return;
    }
    const result = await exec(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'bench', '-f', this.keyFile],
      30_000,
    );
    if (!result.ok) {
      throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`);
    }
  }

  async open(endpoint: SftpEndpoint): Promise<SftpResult> {
    await this.close();
    this.endpoint = endpoint;
    const result = await exec(
      'ssh',
      [
        ...this.options(),
        '-p',
        String(endpoint.port),
        '-o',
        'ControlMaster=yes',
        '-o',
        `ControlPath=${this.controlPath}`,
        '-N',
        '-f',
        `${endpoint.username}@${endpoint.host}`,
      ],
      60_000,
      undefined,
      'exit',
    );
    this.master = result.ok;
    return result;
  }

  get connected(): boolean {
    return this.master;
  }

  async close(): Promise<void> {
    const endpoint = this.endpoint;
    if (!this.master || endpoint === null) {
      return;
    }
    this.master = false;
    await exec(
      'ssh',
      [
        ...this.options(),
        '-p',
        String(endpoint.port),
        '-o',
        `ControlPath=${this.controlPath}`,
        '-O',
        'exit',
        `${endpoint.username}@${endpoint.host}`,
      ],
      30_000,
    );
  }

  /** A fresh connection that authenticates and disconnects, bypassing the shared master. */
  login(endpoint: SftpEndpoint): Promise<SftpResult> {
    return this.batch(endpoint, ['bye'], false);
  }

  run(commands: readonly string[]): Promise<SftpResult> {
    if (this.endpoint === null || !this.master) {
      throw new Error('sftp master connection is not open');
    }
    return this.batch(this.endpoint, commands, true);
  }

  private async batch(endpoint: SftpEndpoint, commands: readonly string[], shared: boolean): Promise<SftpResult> {
    const mux = shared
      ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${this.controlPath}`]
      : ['-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
    const result = await exec(
      'sftp',
      [...this.options(), ...mux, '-P', String(endpoint.port), '-b', '-', `${endpoint.username}@${endpoint.host}`],
      RUN_TIMEOUT_MS,
      `${commands.join('\n')}\n`,
    );
    if (!result.ok && shared) {
      await this.close();
    }
    return result;
  }

  private options(): string[] {
    return [
      '-F',
      '/dev/null',
      '-i',
      this.keyFile,
      '-c',
      CIPHER,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
    ];
  }
}

function exec(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  input?: string,
  settleOn: 'exit' | 'close' = 'close',
): Promise<SftpResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args as string[], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, extra = ''): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, elapsedMs: performance.now() - started, stdout, stderr: stderr + extra });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(null, String(error)));
    child.on(settleOn, (code: number | null) => finish(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}
