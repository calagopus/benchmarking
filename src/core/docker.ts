import { spawn } from 'node:child_process';

export interface ComposeConfig {
  readonly file: string;
  readonly project: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function composeUp(config: ComposeConfig): Promise<void> {
  await run('docker', ['compose', '-p', config.project, '-f', config.file, 'up', '-d', '--wait'], config.env);
}

export async function composeDown(config: ComposeConfig): Promise<void> {
  await run('docker', ['compose', '-p', config.project, '-f', config.file, 'down', '-v'], config.env);
}

export function composeExec(config: ComposeConfig, service: string, command: readonly string[]): Promise<ExecResult> {
  const args = ['compose', '-p', config.project, '-f', config.file, 'exec', '-T', service, ...command];
  return capture('docker', args, config.env);
}

export async function composeContainerId(config: ComposeConfig, service: string): Promise<string | null> {
  const result = await capture(
    'docker',
    ['compose', '-p', config.project, '-f', config.file, 'ps', '-q', service],
    config.env,
  );
  const id = result.stdout.trim();
  return id.length > 0 ? id : null;
}

function run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

function capture(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
