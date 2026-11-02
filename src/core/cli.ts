import { parseArgs } from 'node:util';
import { ARCHIVE_FORMATS, TREE_IDS } from './dataset.ts';
import type { StorageMode } from './ramfs.ts';
import { KNOWN_LOAD_OPERATIONS, KNOWN_TASK_OPERATIONS, type ScenarioOptions } from './suite.ts';
import type { ResourceLimit } from './types.ts';

export interface StackOptions {
  host?: string;
  port?: number;
  sftpPort?: number;
  image?: string;
  project?: string;
  service?: string;
}

export interface CommonDaemonOptions {
  workdir?: string;
  settleMs?: number;
  prune?: boolean;
  ramfs?: boolean;
  storage?: StorageMode;
}

export interface CliConfig {
  readonly target: string;
  readonly stack: StackOptions;
  readonly daemon: CommonDaemonOptions;
  readonly variants?: readonly ResourceLimit[];
  readonly scenarioOptions: ScenarioOptions;
  readonly json: boolean;
  readonly pull: boolean;
  readonly outputDir?: string;
  readonly compare?: string;
}

export class CliError extends Error {}

export const HELP_TEXT = `Usage: bench [target] [options]

Panel targets (HTTP load against the panel API):
  panel:calagopus (default)  Benchmark the Calagopus panel
  panel:pterodactyl          Benchmark the Pterodactyl panel
  panel:pelican              Benchmark the Pelican panel
  panel:pufferpanel          Benchmark the PufferPanel panel
  panel:featherpanel         Benchmark the FeatherPanel panel
  panel:hydrodactyl          Benchmark the Hydrodactyl panel

Daemon targets (Wings file API against a mocked panel):
  daemon:calagopus           Benchmark Calagopus Wings
  daemon:pterodactyl         Benchmark Pterodactyl Wings
  daemon:pelican             Benchmark Pelican Wings

Groups:
  all                        Benchmark every target in series
  panel:all                  Benchmark every panel in series
  daemon:all                 Benchmark every daemon in series

Comparison:
      --compare <target>   Also benchmark this target (in serial, after the
                           first) with the same load/variant settings, then
                           print a comparison. Target options apply to both runs.
                           Cannot be combined with group targets.

Load shaping (applied to every load scenario):
  -c, --concurrency <n>    Concurrent connections
  -d, --duration <s>       Measurement window in seconds (mutually exclusive with --requests)
  -n, --requests <n>       Fixed request count instead of a timed window
  -w, --warmup <s>         Warmup window in seconds (0 disables warmup, also the
                           discarded first run of task scenarios)
      --scenarios <list>   Only run these operations (comma-separated, e.g.
                           health,account,listServers or compress,deleteTree).
                           'listDirectory' spans both kinds: the small listing runs
                           as load, the large ones as tasks

Task shaping (applied to every task scenario):
      --repetitions <n>    Measured runs per task scenario
      --trees <list>       Only run archive/delete tasks on these tree fixtures
                           (comma-separated, from 100m,1g,many). '100m' and '1g'
                           are byte-dominated; 'many' is 50k small files, which
                           isolates per-file overhead from raw throughput.
      --formats <list>     Only run archive tasks with these formats
                           (comma-separated, from tar.gz,zip)

Resource sweep:
      --cpus <list>        CPU variants to sweep (comma-separated, e.g. 1,2,4)
      --memory <mb>        Memory limit in MB applied to every variant (0 = unlimited)

Target:
      --no-pull            Skip 'docker compose pull'; run against the images already
                           cached locally (useful offline, or to pin a comparison to
                           the images a previous run used)
      --host <host>        Target host (default localhost)
      --port <n>           Target port (default: a fixed per-target port from 20000-20999,
                           moved forward on a conflict; an explicit port is never moved)
      --sftp-port <n>      Daemon SFTP host port (default: --port + 1, moved along with it;
                           an explicit port pins both; daemon targets only)
      --image <ref>        Override the container image
      --project <name>     docker compose project name
      --service <name>     docker compose service name
      --workdir <dir>      Daemon workdir for config, data and logs (default ./.bench;
                           daemon targets only)
      --settle <s>         Seconds to wait after a daemon is ready (default 10;
                           daemon targets only)
      --prune              Delete a target's generated dataset and logs once it is done
                           instead of keeping them cached. Frees ~5GB per daemon, at the
                           cost of regenerating the fixtures (~40s each) on the next run.
                           Transient outputs are always freed (daemon targets only)
      --no-ramfs           Serve daemon files from disk instead of a tmpfs. By default
                           a size-capped tmpfs is mounted in the workdir and fixtures are
                           swapped into it from the on-disk cache per task, so only what
                           the current task needs is held in RAM (~2.3 GiB peak with the
                           default scenarios). Falls back to disk when mounting fails
                           (needs root), when memory is short, or with --memory, since
                           tmpfs pages the daemon writes count against its limit

Output:
      --json               Emit the raw report as JSON on stdout (progress to stderr)
  -o, --output-dir <dir>   Write each suite report to <dir>/<target>.json with the
                           ':' replaced by '-' (pretty-printed; the directory is
                           created if needed)

  -h, --help               Show this help
`;

const KNOWN_OPERATIONS: readonly string[] = [...new Set<string>([...KNOWN_LOAD_OPERATIONS, ...KNOWN_TASK_OPERATIONS])];

export function parseCli(argv: readonly string[]): CliConfig | 'help' {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv as string[], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const { values, positionals } = parsed;
  if (values.help) {
    return 'help';
  }
  if (positionals.length > 1) {
    throw new CliError(`unexpected argument '${positionals[1]}'`);
  }

  const target = positionals[0] ?? 'panel:calagopus';

  let config: CliConfig = {
    target,
    stack: parseStack(values),
    daemon: parseDaemon(values),
    variants: parseVariants(values),
    scenarioOptions: parseScenarioOptions(values),
    json: values.json === true,
    pull: values['no-pull'] !== true,
  };
  if (values['output-dir'] !== undefined) {
    config = { ...config, outputDir: values['output-dir'] };
  }
  if (values.compare !== undefined) {
    config = { ...config, compare: values.compare };
  }
  return config;
}

const OPTIONS = {
  concurrency: { type: 'string', short: 'c' },
  duration: { type: 'string', short: 'd' },
  requests: { type: 'string', short: 'n' },
  warmup: { type: 'string', short: 'w' },
  scenarios: { type: 'string' },
  repetitions: { type: 'string' },
  trees: { type: 'string' },
  formats: { type: 'string' },
  cpus: { type: 'string' },
  memory: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'sftp-port': { type: 'string' },
  image: { type: 'string' },
  project: { type: 'string' },
  service: { type: 'string' },
  workdir: { type: 'string' },
  settle: { type: 'string' },
  prune: { type: 'boolean' },
  'no-ramfs': { type: 'boolean' },
  compare: { type: 'string' },
  json: { type: 'boolean' },
  'no-pull': { type: 'boolean' },
  'output-dir': { type: 'string', short: 'o' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function parseStack(values: Values): StackOptions {
  const stack: StackOptions = {};
  if (values.host !== undefined) {
    stack.host = values.host;
  }
  const port = optionalInt(values.port, '--port', { min: 1, max: 65_535 });
  if (port !== undefined) {
    stack.port = port;
  }
  const sftpPort = optionalInt(values['sftp-port'], '--sftp-port', { min: 1, max: 65_535 });
  if (sftpPort !== undefined) {
    stack.sftpPort = sftpPort;
  }
  if (values.image !== undefined) {
    stack.image = values.image;
  }
  if (values.project !== undefined) {
    stack.project = values.project;
  }
  if (values.service !== undefined) {
    stack.service = values.service;
  }
  return stack;
}

function parseDaemon(values: Values): CommonDaemonOptions {
  const daemon: CommonDaemonOptions = {};
  if (values.workdir !== undefined) {
    daemon.workdir = values.workdir;
  }
  const settleS = optionalInt(values.settle, '--settle', { min: 0 });
  if (settleS !== undefined) {
    daemon.settleMs = settleS * 1000;
  }
  if (values.prune === true) {
    daemon.prune = true;
  }
  if (values['no-ramfs'] === true) {
    daemon.ramfs = false;
  }
  return daemon;
}

function parseVariants(values: Values): readonly ResourceLimit[] | undefined {
  const memoryMb = optionalInt(values.memory, '--memory', { min: 0 });
  if (values.cpus === undefined) {
    if (memoryMb === undefined) {
      return undefined;
    }
    throw new CliError('--memory requires --cpus to define the variant sweep');
  }

  const cpus = values.cpus.split(',').map((raw) => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0) {
      throw new CliError(`invalid --cpus value '${raw.trim()}' (expected a positive number)`);
    }
    return value;
  });
  if (cpus.length === 0) {
    throw new CliError('--cpus requires at least one value');
  }

  return cpus.map((cpu) => (memoryMb !== undefined ? { cpus: cpu, memoryMb } : { cpus: cpu }));
}

function parseScenarioOptions(values: Values): ScenarioOptions {
  const concurrency = optionalInt(values.concurrency, '--concurrency', { min: 1 });
  const durationS = optionalInt(values.duration, '--duration', { min: 1 });
  const requests = optionalInt(values.requests, '--requests', { min: 1 });
  const warmupS = optionalInt(values.warmup, '--warmup', { min: 0 });
  const repetitions = optionalInt(values.repetitions, '--repetitions', { min: 1 });
  if (durationS !== undefined && requests !== undefined) {
    throw new CliError('--duration and --requests are mutually exclusive');
  }

  const load: { concurrency?: number; durationMs?: number; requests?: number; warmupMs?: number } = {};
  if (concurrency !== undefined) {
    load.concurrency = concurrency;
  }
  if (durationS !== undefined) {
    load.durationMs = durationS * 1000;
  }
  if (requests !== undefined) {
    load.requests = requests;
  }
  if (warmupS !== undefined) {
    load.warmupMs = warmupS * 1000;
  }

  const task: { repetitions?: number; warmup?: boolean } = {};
  if (repetitions !== undefined) {
    task.repetitions = repetitions;
  }
  if (warmupS !== undefined) {
    task.warmup = warmupS > 0;
  }

  const options: {
    filter?: ReadonlySet<string>;
    trees?: ReadonlySet<string>;
    formats?: ReadonlySet<string>;
    load: typeof load;
    task: typeof task;
  } = { load, task };
  if (values.scenarios !== undefined) {
    options.filter = parseFilter(values.scenarios);
  }
  if (values.trees !== undefined) {
    options.trees = new Set(parseList(values.trees, '--trees', TREE_IDS));
  }
  if (values.formats !== undefined) {
    options.formats = new Set(parseList(values.formats, '--formats', ARCHIVE_FORMATS));
  }
  return options;
}

function parseList(raw: string, flag: string, allowed: readonly string[]): string[] {
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (values.length === 0) {
    throw new CliError(`${flag} requires at least one value`);
  }
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new CliError(`unknown ${flag} value '${value}' (available: ${allowed.join(', ')})`);
    }
  }
  return values;
}

function parseFilter(raw: string): ReadonlySet<string> {
  const wanted = new Set<string>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '') {
      continue;
    }
    if (!KNOWN_OPERATIONS.includes(name)) {
      throw new CliError(`unknown scenario operation '${name}' (available: ${KNOWN_OPERATIONS.join(', ')})`);
    }
    wanted.add(name);
  }
  if (wanted.size === 0) {
    throw new CliError('--scenarios requires at least one operation');
  }
  return wanted;
}

interface IntBounds {
  readonly min?: number;
  readonly max?: number;
}

function optionalInt(raw: string | undefined, flag: string, bounds: IntBounds): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new CliError(`invalid ${flag} value '${raw}' (expected an integer)`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new CliError(`${flag} must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new CliError(`${flag} must be <= ${bounds.max}`);
  }
  return value;
}
