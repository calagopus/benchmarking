import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import colors from 'ansi-colors';
import { type CliConfig, CliError, HELP_TEXT, parseCli } from './core/cli.ts';
import { ensureDependencies } from './core/preflight.ts';
import { capBytes, chooseStorage, type StorageDecision } from './core/ramfs.ts';
import { formatComparison, formatReport } from './core/report.ts';
import { resolveScenarios, type Suite } from './core/suite.ts';
import type { SuiteReport, TargetKind } from './core/types.ts';
import { stagePlan } from './core/wings.ts';
import { calagopusDaemonSuite } from './suites/daemons/calagopus.ts';
import { pelicanDaemonSuite } from './suites/daemons/pelican.ts';
import { pterodactylDaemonSuite } from './suites/daemons/pterodactyl.ts';
import { calagopusSuite } from './suites/panels/calagopus.ts';
import { featherpanelSuite } from './suites/panels/featherpanel.ts';
import { hydrodactylSuite } from './suites/panels/hydrodactyl.ts';
import { pelicanSuite } from './suites/panels/pelican.ts';
import { pterodactylSuite } from './suites/panels/pterodactyl.ts';
import { pufferpanelSuite } from './suites/panels/pufferpanel.ts';

type SuiteConfig = Pick<CliConfig, 'scenarioOptions' | 'variants' | 'pull'>;
type PanelBuild = (options: CliConfig['stack'], config: SuiteConfig) => Suite;
type DaemonBuild = (options: CliConfig['stack'] & CliConfig['daemon'], config: SuiteConfig) => Suite;

const PANELS: Record<string, PanelBuild> = {
  calagopus: (panel, config) => calagopusSuite({ panel, ...config }),
  pterodactyl: (panel, config) => pterodactylSuite({ panel, ...config }),
  pelican: (panel, config) => pelicanSuite({ panel, ...config }),
  pufferpanel: (panel, config) => pufferpanelSuite({ panel, ...config }),
  featherpanel: (panel, config) => featherpanelSuite({ panel, ...config }),
  hydrodactyl: (panel, config) => hydrodactylSuite({ panel, ...config }),
};

const DAEMONS: Record<string, DaemonBuild> = {
  calagopus: (daemon, config) => calagopusDaemonSuite({ daemon, ...config }),
  pterodactyl: (daemon, config) => pterodactylDaemonSuite({ daemon, ...config }),
  pelican: (daemon, config) => pelicanDaemonSuite({ daemon, ...config }),
};

interface TargetEntry {
  readonly kind: TargetKind;
  readonly build: (config: CliConfig) => Suite;
}

const TARGETS: ReadonlyMap<string, TargetEntry> = new Map([
  ...Object.entries(PANELS).map(([name, build]): [string, TargetEntry] => [
    `panel:${name}`,
    { kind: 'panel', build: (config) => build(config.stack, suiteConfig(config)) },
  ]),
  ...Object.entries(DAEMONS).map(([name, build]): [string, TargetEntry] => [
    `daemon:${name}`,
    { kind: 'daemon', build: (config) => build({ ...config.stack, ...config.daemon }, suiteConfig(config)) },
  ]),
]);

const GROUPS: Record<string, (entry: TargetEntry) => boolean> = {
  all: () => true,
  'panel:all': (entry) => entry.kind === 'panel',
  'daemon:all': (entry) => entry.kind === 'daemon',
};

function suiteConfig(config: CliConfig): SuiteConfig {
  return { scenarioOptions: config.scenarioOptions, variants: config.variants, pull: config.pull };
}

function resolveTargets(config: CliConfig): string[] {
  const group = GROUPS[config.target];
  if (group !== undefined) {
    return [...TARGETS.entries()].filter(([, entry]) => group(entry)).map(([name]) => name);
  }
  return config.compare !== undefined ? [config.target, config.compare] : [config.target];
}

async function decideStorage(config: CliConfig): Promise<StorageDecision> {
  if (config.daemon.ramfs === false) {
    return { mode: 'disk', reason: 'disabled by --no-ramfs' };
  }
  if (config.variants?.some((limit) => limit.memoryMb !== undefined && limit.memoryMb > 0)) {
    return { mode: 'disk', reason: 'tmpfs pages would count against the --memory limit' };
  }
  const plan = stagePlan(resolveScenarios('daemon', config.scenarioOptions));
  return chooseStorage(capBytes(plan.pinned, plan.steps));
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli === 'help') {
    console.log(HELP_TEXT);
    return;
  }
  let parsed = cli;

  const runGroup = GROUPS[parsed.target] !== undefined;
  if (parsed.compare !== undefined && (runGroup || GROUPS[parsed.compare] !== undefined)) {
    throw new CliError('--compare cannot be combined with group targets');
  }
  const targets = resolveTargets(parsed);
  const entries = targets.map((target) => {
    const entry = TARGETS.get(target);
    if (entry === undefined) {
      throw new CliError(
        `unknown benchmark target '${target}' (choose one of: ${[...TARGETS.keys(), ...Object.keys(GROUPS)].join(', ')})`,
      );
    }
    return entry;
  });

  if (parsed.json) {
    console.log = (...args: unknown[]): void => {
      console.error(...args);
    };
  }

  await ensureDependencies();
  if (entries.some((entry) => entry.kind === 'daemon')) {
    const decision = await decideStorage(parsed);
    const line = `daemon storage: ${decision.mode} (${decision.reason})`;
    console.log(decision.mode === 'tmpfs' ? colors.dim(line) : colors.yellow(line));
    parsed = { ...parsed, daemon: { ...parsed.daemon, storage: decision.mode } };
  }
  if (parsed.outputDir !== undefined) {
    await mkdir(parsed.outputDir, { recursive: true });
  }

  const completed: [target: string, report: SuiteReport][] = [];
  const failed: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const target = targets[index]!;
    const suite = entry.build(parsed);
    if (suite.scenarioCount === 0) {
      if (!runGroup) {
        throw new CliError(`--scenarios matched no scenarios for target '${target}'`);
      }
      console.log(colors.yellow(`${target}: no scenarios match --scenarios, skipping`));
      continue;
    }

    console.log(colors.cyan(`${target} benchmarking`));
    let report: SuiteReport;
    try {
      report = await suite.run();
    } catch (err) {
      if (!runGroup) {
        throw err;
      }
      failed.push(target);
      console.error(colors.red(`${target} failed:`), err);
      continue;
    }
    completed.push([target, report]);
    if (parsed.outputDir !== undefined) {
      await writeFile(
        join(parsed.outputDir, `${target.replace(':', '-')}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  }

  const reports = completed.map(([, report]) => report);
  const [report, compared] = reports;

  if (parsed.json) {
    const payload = runGroup
      ? Object.fromEntries(completed)
      : compared !== undefined
        ? { baseline: report, compare: compared }
        : report;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const each of reports) {
      console.log(formatReport(each));
    }
    if (parsed.compare !== undefined && report !== undefined && compared !== undefined) {
      console.log(formatComparison(report, compared));
    }
  }

  if (failed.length > 0) {
    console.error(colors.red(`failed targets: ${failed.join(', ')}`));
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(colors.red('error:'), err.message);
    console.error(colors.dim('run with --help for usage'));
    process.exit(2);
  }
  console.error(colors.red('fatal:'), err);
  process.exit(1);
});
