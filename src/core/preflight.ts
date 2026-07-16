import { spawn } from 'node:child_process';
import colors from 'ansi-colors';

interface Dependency {
  readonly name: string;
  readonly probe: readonly string[];
  readonly hint: string;
}

const DEPENDENCIES: readonly Dependency[] = [
  {
    name: 'docker',
    probe: ['docker', '--version'],
    hint: 'install Docker: https://docs.docker.com/get-docker/',
  },
  {
    name: 'docker compose',
    probe: ['docker', 'compose', 'version'],
    hint: 'install the Compose plugin: https://docs.docker.com/compose/install/',
  },
  {
    name: 'oha',
    probe: ['oha', '--version'],
    hint: 'install oha: `cargo install oha` or see https://github.com/hatoo/oha',
  },
];

export async function ensureDependencies(): Promise<void> {
  const results = await Promise.all(DEPENDENCIES.map(async (dep) => ({ dep, ok: await probe(dep.probe) })));

  const missing = results.filter((result) => !result.ok).map((result) => result.dep);
  if (missing.length > 0) {
    const details = missing.map((dep) => `  - ${dep.name}: ${dep.hint}`).join('\n');
    throw new Error(`missing required dependencies:\n${details}`);
  }

  console.log(colors.dim(`dependencies ok: ${DEPENDENCIES.map((dep) => dep.name).join(', ')}`));
}

function probe(command: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin!, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
