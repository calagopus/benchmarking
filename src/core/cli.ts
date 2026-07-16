import { parseArgs } from 'node:util';
import { DEFAULT_SCENARIOS } from './suite.ts';
import type { Operation, ResourceLimit, Scenario } from './types.ts';

export interface CommonPanelOptions {
  host?: string;
  port?: number;
  image?: string;
  project?: string;
  service?: string;
}

export interface CliConfig {
  readonly target: string;
  readonly panel: CommonPanelOptions;
  readonly variants?: readonly ResourceLimit[];
  readonly scenarios?: readonly Scenario[];
  readonly json: boolean;
  readonly compare?: string;
}

export class CliError extends Error {}

export const HELP_TEXT = `Usage: bench [target] [options]

Targets:
  calagopus (default)      Benchmark the Calagopus panel
  pterodactyl              Benchmark the Pterodactyl panel
  pelican                  Benchmark the Pelican panel
  pufferpanel              Benchmark the PufferPanel panel
  featherpanel             Benchmark the FeatherPanel panel
  hydrodactyl              Benchmark the Hydrodactyl panel

Comparison:
      --compare <target>   Also benchmark this target (in serial, after the
                           first) with the same load/variant settings, then
                           print a comparison. Panel options apply to both runs.

Load shaping (applied to every scenario):
  -c, --concurrency <n>    Concurrent connections
  -d, --duration <s>       Measurement window in seconds (mutually exclusive with --requests)
  -n, --requests <n>       Fixed request count instead of a timed window
  -w, --warmup <s>         Warmup window in seconds (0 disables warmup)
      --scenarios <list>   Only run these operations (comma-separated: health,account,listServers)

Resource sweep:
      --cpus <list>        CPU variants to sweep (comma-separated, e.g. 1,2,4)
      --memory <mb>        Memory limit in MB applied to every variant (0 = unlimited)

Panel:
      --host <host>        Panel host (default localhost)
      --port <n>           Panel port (default random high port)
      --image <ref>        Override the panel container image
      --project <name>     docker compose project name
      --service <name>     docker compose service name

Output:
      --json               Emit the raw report as JSON on stdout (progress to stderr)

  -h, --help               Show this help
`;

const KNOWN_OPERATIONS: readonly Operation[] = ['health', 'login', 'account', 'listServers', 'websocketCredentials'];

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

  const target = positionals[0] ?? 'calagopus';

  const concurrency = optionalInt(values.concurrency, '--concurrency', { min: 1 });
  const durationS = optionalInt(values.duration, '--duration', { min: 1 });
  const requests = optionalInt(values.requests, '--requests', { min: 1 });
  const warmupS = optionalInt(values.warmup, '--warmup', { min: 0 });
  if (durationS !== undefined && requests !== undefined) {
    throw new CliError('--duration and --requests are mutually exclusive');
  }

  const config: CliConfig = {
    target,
    panel: parsePanel(values),
    variants: parseVariants(values),
    scenarios: buildScenarios({ concurrency, durationS, requests, warmupS, filter: values.scenarios }),
    json: values.json === true,
  };
  if (values.compare !== undefined) {
    return { ...config, compare: values.compare };
  }
  return config;
}

const OPTIONS = {
  concurrency: { type: 'string', short: 'c' },
  duration: { type: 'string', short: 'd' },
  requests: { type: 'string', short: 'n' },
  warmup: { type: 'string', short: 'w' },
  scenarios: { type: 'string' },
  cpus: { type: 'string' },
  memory: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  image: { type: 'string' },
  project: { type: 'string' },
  service: { type: 'string' },
  compare: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function parsePanel(values: Values): CommonPanelOptions {
  const panel: CommonPanelOptions = {};
  if (values.host !== undefined) {
    panel.host = values.host;
  }
  const port = optionalInt(values.port, '--port', { min: 1, max: 65_535 });
  if (port !== undefined) {
    panel.port = port;
  }
  if (values.image !== undefined) {
    panel.image = values.image;
  }
  if (values.project !== undefined) {
    panel.project = values.project;
  }
  if (values.service !== undefined) {
    panel.service = values.service;
  }
  return panel;
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

interface LoadOverrides {
  readonly concurrency?: number;
  readonly durationS?: number;
  readonly requests?: number;
  readonly warmupS?: number;
  readonly filter?: string;
}

function buildScenarios(overrides: LoadOverrides): readonly Scenario[] | undefined {
  const hasLoadOverride =
    overrides.concurrency !== undefined ||
    overrides.durationS !== undefined ||
    overrides.requests !== undefined ||
    overrides.warmupS !== undefined;
  if (!hasLoadOverride && overrides.filter === undefined) {
    return undefined;
  }

  const wanted = overrides.filter !== undefined ? parseFilter(overrides.filter) : null;
  const scenarios = DEFAULT_SCENARIOS.filter((scenario) => wanted === null || wanted.has(scenario.operation));
  if (scenarios.length === 0) {
    throw new CliError(`--scenarios matched no operations (available: ${KNOWN_OPERATIONS.join(', ')})`);
  }

  if (!hasLoadOverride) {
    return scenarios;
  }

  return scenarios.map((scenario) => {
    const load = { ...scenario.load };
    if (overrides.concurrency !== undefined) {
      load.concurrency = overrides.concurrency;
    }
    if (overrides.warmupS !== undefined) {
      load.warmupMs = overrides.warmupS * 1000;
    }
    if (overrides.requests !== undefined) {
      load.requests = overrides.requests;
      load.durationMs = undefined;
    } else if (overrides.durationS !== undefined) {
      load.durationMs = overrides.durationS * 1000;
      load.requests = undefined;
    }
    return { ...scenario, load };
  });
}

function parseFilter(raw: string): Set<Operation> {
  const wanted = new Set<Operation>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '') {
      continue;
    }
    if (!KNOWN_OPERATIONS.includes(name as Operation)) {
      throw new CliError(`unknown scenario operation '${name}' (available: ${KNOWN_OPERATIONS.join(', ')})`);
    }
    wanted.add(name as Operation);
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
