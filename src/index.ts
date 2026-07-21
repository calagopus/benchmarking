import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import colors from 'ansi-colors';
import { type CliConfig, CliError, HELP_TEXT, parseCli } from './core/cli.ts';
import { ensureDependencies } from './core/preflight.ts';
import { formatComparison, formatReport } from './core/report.ts';
import type { Suite } from './core/suite.ts';
import type { SuiteReport } from './core/types.ts';
import { calagopusSuite } from './suites/calagopus.ts';
import { featherpanelSuite } from './suites/featherpanel.ts';
import { hydrodactylSuite } from './suites/hydrodactyl.ts';
import { pelicanSuite } from './suites/pelican.ts';
import { pterodactylSuite } from './suites/pterodactyl.ts';
import { pufferpanelSuite } from './suites/pufferpanel.ts';

const SUITES: Record<string, (config: CliConfig) => Suite> = {
  calagopus: (config) =>
    calagopusSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
  pterodactyl: (config) =>
    pterodactylSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
  pelican: (config) => pelicanSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
  pufferpanel: (config) =>
    pufferpanelSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
  featherpanel: (config) =>
    featherpanelSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
  hydrodactyl: (config) =>
    hydrodactylSuite({ panel: config.panel, scenarios: config.scenarios, variants: config.variants }),
};

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const runAll = parsed.target === 'all';
  const targets = runAll
    ? Object.keys(SUITES)
    : parsed.compare !== undefined
      ? [parsed.target, parsed.compare]
      : [parsed.target];
  const builds = targets.map((target) => {
    const build = SUITES[target];
    if (build === undefined) {
      throw new CliError(
        `unknown benchmark target '${target}' (choose one of: ${[...Object.keys(SUITES), 'all'].join(', ')})`,
      );
    }
    return build;
  });

  if (parsed.json) {
    console.log = (...args: unknown[]): void => {
      console.error(...args);
    };
  }

  await ensureDependencies();
  if (parsed.outputDir !== undefined) {
    await mkdir(parsed.outputDir, { recursive: true });
  }

  const completed: [target: string, report: SuiteReport][] = [];
  const failed: string[] = [];
  for (const [index, build] of builds.entries()) {
    const target = targets[index];
    console.log(colors.cyan(`${target} benchmarking`));
    let report: SuiteReport;
    try {
      report = await build(parsed).run();
    } catch (err) {
      if (!runAll) {
        throw err;
      }
      failed.push(target);
      console.error(colors.red(`${target} failed:`), err);
      continue;
    }
    completed.push([target, report]);
    if (parsed.outputDir !== undefined) {
      await writeFile(join(parsed.outputDir, `${target}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
  }

  const reports = completed.map(([, report]) => report);
  const [report, compared] = reports;

  if (parsed.json) {
    const payload = runAll
      ? Object.fromEntries(completed)
      : compared !== undefined
        ? { baseline: report, compare: compared }
        : report;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const each of reports) {
      console.log(formatReport(each));
    }
    if (parsed.compare !== undefined && compared !== undefined) {
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
