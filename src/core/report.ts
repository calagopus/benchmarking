import colors from 'ansi-colors';
import type { ResourceLimit, ScenarioResult, SuiteReport, VariantReport } from './types.ts';

export function formatReport(report: SuiteReport): string {
  const lines: string[] = [];
  lines.push(colors.bold(colors.cyan(`\n${report.panel}`)) + colors.dim(`  ${report.startedAt}`));

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
  for (const result of variant.results) {
    lines.push(formatScenario(result));
  }
  return lines.join('\n');
}

function formatScenario(result: ScenarioResult): string {
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
  const statuses = colors.dim(
    `statuses: ${Object.entries(result.statusCounts)
      .map(([code, count]) => `${code}×${count}`)
      .join(' ')}`,
  );

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

  const resourceLine =
    resources === null
      ? colors.dim('      resources: (not sampled)')
      : colors.dim(
          `      resources  cpu mean ${resources.cpuPercentMean.toFixed(0)}% / max ${resources.cpuPercentMax.toFixed(0)}% · ` +
            `mem mean ${resources.memMbMean.toFixed(0)}MB / max ${resources.memMbMax.toFixed(0)}MB (${resources.samples} samples)`,
        );

  return [
    header,
    `      ${counts} ${colors.dim('·')} ${throughput} ${colors.dim(`(${total} reqs)`)}`,
    `      ${statuses}`,
    latencyLine,
    resourceLine,
  ].join('\n');
}

export function formatComparison(baseline: SuiteReport, candidate: SuiteReport): string {
  const lines: string[] = [];
  lines.push(colors.bold(colors.cyan(`\ncomparison: ${baseline.panel} (baseline) vs ${candidate.panel}`)));

  let matchedAny = false;
  for (const variant of baseline.variants) {
    const other = candidate.variants.find((v) => sameLimit(v.limit, variant.limit));
    if (other === undefined) {
      lines.push(colors.yellow(`\n  ${limitLabel(variant.limit)}: only ran for ${baseline.panel}`));
      continue;
    }
    matchedAny = true;
    lines.push(formatVariantComparison(variant, other, baseline.panel, candidate.panel));
  }
  for (const variant of candidate.variants) {
    if (!baseline.variants.some((v) => sameLimit(v.limit, variant.limit))) {
      lines.push(colors.yellow(`\n  ${limitLabel(variant.limit)}: only ran for ${candidate.panel}`));
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
  const lines = [`    ${colors.bold(baseline.scenario.name)} ${colors.dim(`[${baseline.scenario.auth}]`)}`];

  const row = (label: string, value: string) => `      ${colors.dim(label.padEnd(12))}${value}`;

  lines.push(row('req/s', compareMetric(baseline.throughput, candidate.throughput, 0, 'higher')));

  if (baseline.latency !== null && candidate.latency !== null) {
    for (const percentile of ['p50', 'p95', 'p99'] as const) {
      lines.push(
        row(`${percentile} ms`, compareMetric(baseline.latency[percentile], candidate.latency[percentile], 2, 'lower')),
      );
    }
  } else {
    lines.push(colors.dim('      latency: not comparable (missing on one side)'));
  }

  if (baseline.resources !== null && candidate.resources !== null) {
    lines.push(
      row(
        'cpu mean %',
        compareMetric(baseline.resources.cpuPercentMean, candidate.resources.cpuPercentMean, 0, 'lower'),
      ),
    );
    lines.push(
      row('cpu max %', compareMetric(baseline.resources.cpuPercentMax, candidate.resources.cpuPercentMax, 0, 'lower')),
    );
    lines.push(
      row('mem mean MB', compareMetric(baseline.resources.memMbMean, candidate.resources.memMbMean, 0, 'lower')),
    );
    lines.push(row('mem max MB', compareMetric(baseline.resources.memMbMax, candidate.resources.memMbMax, 0, 'lower')));
  } else {
    lines.push(colors.dim('      resources: not comparable (missing on one side)'));
  }

  const failuresA = baseline.failed + baseline.errored;
  const failuresB = candidate.failed + candidate.errored;
  if (failuresA > 0 || failuresB > 0) {
    lines.push(colors.red(`      ${'failures'.padEnd(12)}${failuresA} vs ${failuresB} (failed + errored)`));
  }
  return lines.join('\n');
}

function compareMetric(baseline: number, candidate: number, decimals: number, better: 'higher' | 'lower'): string {
  const pair = `${baseline.toFixed(decimals)} → ${candidate.toFixed(decimals)}`;
  if (baseline === 0) {
    return `${pair} ${colors.dim('(n/a)')}`;
  }
  const deltaPct = ((candidate - baseline) / baseline) * 100;
  const improved = better === 'higher' ? deltaPct > 0 : deltaPct < 0;
  const color = Math.abs(deltaPct) < 1 ? colors.dim : improved ? colors.green : colors.red;
  return `${pair} ${color(`(${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`)}`;
}

function sameLimit(a: ResourceLimit, b: ResourceLimit): boolean {
  return a.cpus === b.cpus && a.memoryMb === b.memoryMb;
}

function limitLabel(limit: ResourceLimit): string {
  return `${limit.cpus} cpu${limit.memoryMb !== undefined ? `, ${limit.memoryMb}MB` : ''}`;
}
