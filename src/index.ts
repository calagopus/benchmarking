import colors from 'ansi-colors';
import { type CliConfig, CliError, HELP_TEXT, parseCli } from './core/cli.ts';
import { ensureDependencies } from './core/preflight.ts';
import { formatComparison, formatReport } from './core/report.ts';
import type { Suite } from './core/suite.ts';
import type { SuiteReport } from './core/types.ts';
import { calagopusSuite } from './suites/calagopus.ts';
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
};

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const targets = parsed.compare !== undefined ? [parsed.target, parsed.compare] : [parsed.target];
  const builds = targets.map((target) => {
    const build = SUITES[target];
    if (build === undefined) {
      throw new CliError(`unknown benchmark target '${target}' (choose one of: ${Object.keys(SUITES).join(', ')})`);
    }
    return build;
  });

  if (parsed.json) {
    console.log = (...args: unknown[]): void => {
      console.error(...args);
    };
  }

  await ensureDependencies();

  const reports: SuiteReport[] = [];
  for (const [index, build] of builds.entries()) {
    console.log(colors.cyan(`${targets[index]} benchmarking`));
    reports.push(await build(parsed).run());
  }

  const [report, compared] = reports;

  if (parsed.json) {
    const payload = compared !== undefined ? { baseline: report, compare: compared } : report;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  for (const each of reports) {
    console.log(formatReport(each));
  }
  if (compared !== undefined) {
    console.log(formatComparison(report, compared));
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
