import colors from 'ansi-colors';
import type {
  LoadResult,
  ResourceLimit,
  ResourceUsage,
  ScenarioResult,
  SuiteReport,
  TaskResult,
  VariantReport,
} from './types.ts';
import { MIB } from './utils.ts';

export function formatReport(report: SuiteReport): string {
  const lines: string[] = [];
  const version = report.version !== null ? ` · v${report.version}` : '';
  const storage = report.storage !== null ? ` · ${report.storage}` : '';
  lines.push(
    colors.bold(colors.cyan(`\n${report.target}`)) +
      colors.dim(`  ${report.kind}${version}${storage} · ${report.startedAt}`),
  );
  for (const note of report.notes) {
    lines.push(colors.dim(`  note: ${note}`));
  }

  if (report.variants.length === 0) {
    lines.push(colors.yellow('  (no variants ran)'));
    return lines.join('\n');
  }

  for (const variant of report.variants) {
    lines.push(formatVariant(variant));
  }
  return lines.join('\n');
}

function formatVariant(variant: VariantReport): string {
  const mem = variant.limit.memoryMb !== undefined ? `, ${variant.limit.memoryMb}MB` : '';
  const lines = [colors.bold(`\n  ${variant.limit.cpus} cpu${mem}`)];
  if (variant.idle !== null) {
    lines.push(
      colors.dim(
        `    idle baseline  cpu ${variant.idle.cpuPercentMean.toFixed(1)}% · heap ${variant.idle.heapMbMean.toFixed(1)}MB`,
      ),
    );
  }
  for (const result of variant.results) {
    lines.push(result.kind === 'load' ? formatLoad(result, variant.limit) : formatTask(result, variant.limit));
  }
  return lines.join('\n');
}

function formatLoad(result: LoadResult, limit: ResourceLimit): string {
  const { scenario, latency, resources } = result;
  const header = `    ${colors.bold(scenario.name)} ${colors.dim(`[${scenario.auth}]`)}`;

  const total = result.ok + result.ratelimited + result.failed + result.errored;
  const okColor = result.failed + result.errored === 0 ? colors.green : colors.yellow;
  const counts = [
    okColor(`${result.ok} ok`),
    result.ratelimited > 0 ? colors.blue(`${result.ratelimited} ratelimited`) : colors.dim('0 ratelimited'),
    result.failed > 0 ? colors.red(`${result.failed} failed`) : colors.dim('0 failed'),
    result.errored > 0 ? colors.red(`${result.errored} errored`) : colors.dim('0 errored'),
  ].join(colors.dim(' · '));

  const throughput = colors.magenta(`${result.throughput.toFixed(0)} req/s`);
  const cpuCost =
    result.cpuMsPerRequest !== null
      ? colors.dim(`      ${'cpu cost'.padEnd(11)}`) +
        colors.magenta(`${result.cpuMsPerRequest.toFixed(3)} cpu-ms per request`)
      : null;
  const statuses = colors.dim(`statuses: ${formatStatuses(result.statusCounts)}`);

  const latencyLine =
    latency === null
      ? colors.dim('      no responses')
      : `      ${colors.dim('latency ms')}  ` +
        [
          `min ${latency.min.toFixed(2)}`,
          `p50 ${latency.p50.toFixed(2)}`,
          `p90 ${latency.p90.toFixed(2)}`,
          `p95 ${latency.p95.toFixed(2)}`,
          `p99 ${latency.p99.toFixed(2)}`,
          `max ${latency.max.toFixed(2)}`,
        ].join(colors.dim(' · '));

  return [
    header,
    `      ${counts} ${colors.dim('·')} ${throughput} ${colors.dim(`(${total} reqs)`)}`,
    `      ${statuses}`,
    latencyLine,
    ...(cpuCost !== null ? [cpuCost] : []),
    formatResources(resources, limit),
  ].join('\n');
}

function formatTask(result: TaskResult, limit: ResourceLimit): string {
  const { scenario, stats, resources } = result;
  const header = `    ${colors.bold(scenario.name)} ${colors.dim('[task]')}`;

  const okColor = result.failed === 0 ? colors.green : colors.yellow;
  const counts = [
    okColor(`${result.ok} ok`),
    result.failed > 0 ? colors.red(`${result.failed} failed`) : colors.dim('0 failed'),
  ].join(colors.dim(' · '));
  const throughput =
    result.mbPerSec !== null
      ? ` ${colors.dim('·')} ${colors.magenta(`${result.mbPerSec.toFixed(1)} MiB/s`)} ${colors.dim(`(${(result.bytes / MIB).toFixed(0)} MiB per run)`)}`
      : '';

  const statsLine =
    stats === null
      ? colors.dim('      no successful runs')
      : `      ${colors.dim('duration ms')} ` +
        [
          `min ${stats.min.toFixed(0)}`,
          `median ${stats.median.toFixed(0)}`,
          `mean ${stats.mean.toFixed(0)}`,
          `max ${stats.max.toFixed(0)}`,
        ].join(colors.dim(' · '));
  const runsLine = colors.dim(
    `      runs: ${result.runsMs.map((ms) => ms.toFixed(0)).join(' ')} · statuses: ${formatStatuses(result.statusCounts)}`,
  );

  const cpuCost =
    result.cpuMsPerRun !== null
      ? colors.dim(`      ${'cpu cost'.padEnd(11)}`) +
        colors.magenta(`${(result.cpuMsPerRun / 1000).toFixed(2)} cpu-s per run`)
      : null;

  const lines = [header, `      ${counts}${throughput}`, statsLine, runsLine];
  if (cpuCost !== null) {
    lines.push(cpuCost);
  }
  lines.push(formatResources(resources, limit));
  for (const failure of result.failures) {
    lines.push(colors.red(`      failure: ${failure}`));
  }
  return lines.join('\n');
}

function formatStatuses(statusCounts: Readonly<Record<number, number>>): string {
  return Object.entries(statusCounts)
    .map(([code, count]) => `${code}×${count}`)
    .join(' ');
}

function formatResources(resources: ResourceUsage | null, limit: ResourceLimit): string {
  if (resources === null) {
    return colors.dim('      resources: (not sampled)');
  }
  const quota = limit.cpus * 100;
  const saturation = ((resources.cpuPercentMean / quota) * 100).toFixed(0);
  return colors.dim(
    `      resources  cpu ${resources.cpuPercentMean.toFixed(0)}% of ${quota}% quota (${saturation}% saturated) · ` +
      `heap mean ${resources.heapMbMean.toFixed(0)}MB / max ${resources.heapMbMax.toFixed(0)}MB (${resources.samples} samples)`,
  );
}

function targetLabel(report: SuiteReport): string {
  return report.version !== null ? `${report.target} v${report.version}` : report.target;
}

export function formatComparison(baseline: SuiteReport, candidate: SuiteReport): string {
  const lines: string[] = [];
  lines.push(
    colors.bold(colors.cyan(`\ncomparison: ${targetLabel(baseline)} (baseline) vs ${targetLabel(candidate)}`)),
  );
  if (baseline.storage !== candidate.storage) {
    lines.push(
      colors.yellow(
        `  warning: storage differs (${baseline.storage ?? 'n/a'} vs ${candidate.storage ?? 'n/a'}), file task results are not comparable`,
      ),
    );
  }

  let matchedAny = false;
  for (const variant of baseline.variants) {
    const other = candidate.variants.find((v) => sameLimit(v.limit, variant.limit));
    if (other === undefined) {
      lines.push(colors.yellow(`\n  ${limitLabel(variant.limit)}: only ran for ${baseline.target}`));
      continue;
    }
    matchedAny = true;
    lines.push(formatVariantComparison(variant, other, baseline.target, candidate.target));
  }
  for (const variant of candidate.variants) {
    if (!baseline.variants.some((v) => sameLimit(v.limit, variant.limit))) {
      lines.push(colors.yellow(`\n  ${limitLabel(variant.limit)}: only ran for ${candidate.target}`));
    }
  }

  if (!matchedAny) {
    lines.push(colors.yellow('  (no matching variants to compare)'));
  }
  return lines.join('\n');
}

function formatVariantComparison(
  baseline: VariantReport,
  candidate: VariantReport,
  baselineName: string,
  candidateName: string,
): string {
  const lines = [colors.bold(`\n  ${limitLabel(baseline.limit)}`)];
  if (baseline.idle !== null || candidate.idle !== null) {
    const row = (label: string, value: string) => `      ${colors.dim(label.padEnd(13))}${value}`;
    lines.push(`    ${colors.bold('idle baseline')}`, ...compareResources(baseline.idle, candidate.idle, row));
  }
  for (const result of baseline.results) {
    const other = candidate.results.find((r) => r.scenario.name === result.scenario.name);
    if (other === undefined) {
      lines.push(colors.yellow(`    ${result.scenario.name}: only ran for ${baselineName}`));
      continue;
    }
    lines.push(formatScenarioComparison(result, other));
  }
  for (const result of candidate.results) {
    if (!baseline.results.some((r) => r.scenario.name === result.scenario.name)) {
      lines.push(colors.yellow(`    ${result.scenario.name}: only ran for ${candidateName}`));
    }
  }
  return lines.join('\n');
}

function formatScenarioComparison(baseline: ScenarioResult, candidate: ScenarioResult): string {
  const row = (label: string, value: string) => `      ${colors.dim(label.padEnd(13))}${value}`;

  if (baseline.kind === 'task' || candidate.kind === 'task') {
    const lines = [`    ${colors.bold(baseline.scenario.name)} ${colors.dim('[task]')}`];
    if (baseline.kind !== 'task' || candidate.kind !== 'task') {
      lines.push(colors.dim('      not comparable (scenario kinds differ)'));
      return lines.join('\n');
    }
    if (baseline.stats !== null && candidate.stats !== null) {
      lines.push(row('median ms', compareMetric(baseline.stats.median, candidate.stats.median, 0, 'lower')));
      lines.push(row('mean ms', compareMetric(baseline.stats.mean, candidate.stats.mean, 0, 'lower')));
      lines.push(row('min ms', compareMetric(baseline.stats.min, candidate.stats.min, 0, 'lower')));
    } else {
      lines.push(colors.dim('      duration: not comparable (no successful runs on one side)'));
    }
    if (baseline.mbPerSec !== null && candidate.mbPerSec !== null) {
      lines.push(row('MiB/s', compareMetric(baseline.mbPerSec, candidate.mbPerSec, 1, 'higher')));
    }
    if (baseline.cpuMsPerRun !== null && candidate.cpuMsPerRun !== null) {
      lines.push(
        row('cpu-s / run', compareMetric(baseline.cpuMsPerRun / 1000, candidate.cpuMsPerRun / 1000, 2, 'lower')),
      );
    }
    lines.push(...compareResources(baseline.resources, candidate.resources, row));
    if (baseline.failed > 0 || candidate.failed > 0) {
      lines.push(colors.red(`      ${'failures'.padEnd(13)}${baseline.failed} vs ${candidate.failed}`));
    }
    return lines.join('\n');
  }

  const lines = [`    ${colors.bold(baseline.scenario.name)} ${colors.dim(`[${baseline.scenario.auth}]`)}`];
  lines.push(row('req/s', compareMetric(baseline.throughput, candidate.throughput, 0, 'higher')));
  if (baseline.cpuMsPerRequest !== null && candidate.cpuMsPerRequest !== null) {
    lines.push(row('cpu-ms / req', compareMetric(baseline.cpuMsPerRequest, candidate.cpuMsPerRequest, 3, 'lower')));
  }

  if (baseline.latency !== null && candidate.latency !== null) {
    for (const percentile of ['p50', 'p95', 'p99'] as const) {
      lines.push(
        row(`${percentile} ms`, compareMetric(baseline.latency[percentile], candidate.latency[percentile], 2, 'lower')),
      );
    }
  } else {
    lines.push(colors.dim('      latency: not comparable (missing on one side)'));
  }

  lines.push(...compareResources(baseline.resources, candidate.resources, row));

  const failuresA = baseline.failed + baseline.errored;
  const failuresB = candidate.failed + candidate.errored;
  if (failuresA > 0 || failuresB > 0) {
    lines.push(colors.red(`      ${'failures'.padEnd(13)}${failuresA} vs ${failuresB} (failed + errored)`));
  }
  return lines.join('\n');
}

function compareResources(
  baseline: ResourceUsage | null,
  candidate: ResourceUsage | null,
  row: (label: string, value: string) => string,
): string[] {
  if (baseline === null || candidate === null) {
    return [colors.dim('      resources: not comparable (missing on one side)')];
  }
  // CPU percent is deliberately not scored: under load it pins to the quota on both sides, and for
  // tasks a higher figure usually means better parallelism rather than waste. 'cpu cost' carries
  // the directional signal instead.
  return [
    row('cpu mean %', compareMetric(baseline.cpuPercentMean, candidate.cpuPercentMean, 0, 'neither')),
    row('cpu max %', compareMetric(baseline.cpuPercentMax, candidate.cpuPercentMax, 0, 'neither')),
    row('heap mean MB', compareMetric(baseline.heapMbMean, candidate.heapMbMean, 0, 'lower')),
    row('heap max MB', compareMetric(baseline.heapMbMax, candidate.heapMbMax, 0, 'lower')),
  ];
}

/**
 * Deltas below this are left uncoloured: with a handful of repetitions and no confidence interval,
 * a smaller difference is not distinguishable from run-to-run noise.
 */
const SIGNIFICANT_DELTA_PCT = 5;

function compareMetric(
  baseline: number,
  candidate: number,
  decimals: number,
  better: 'higher' | 'lower' | 'neither',
): string {
  const pair = `${baseline.toFixed(decimals)} → ${candidate.toFixed(decimals)}`;
  if (Math.abs(baseline) < 10 ** -decimals) {
    return `${pair} ${colors.dim('(n/a)')}`;
  }
  const deltaPct = ((candidate - baseline) / baseline) * 100;
  const delta = `(${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`;
  if (better === 'neither') {
    return `${pair} ${colors.dim(delta)}`;
  }
  const improved = better === 'higher' ? deltaPct > 0 : deltaPct < 0;
  const color = Math.abs(deltaPct) < SIGNIFICANT_DELTA_PCT ? colors.dim : improved ? colors.green : colors.red;
  return `${pair} ${color(delta)}`;
}

function sameLimit(a: ResourceLimit, b: ResourceLimit): boolean {
  return a.cpus === b.cpus && a.memoryMb === b.memoryMb;
}

function limitLabel(limit: ResourceLimit): string {
  return `${limit.cpus} cpu${limit.memoryMb !== undefined ? `, ${limit.memoryMb}MB` : ''}`;
}
