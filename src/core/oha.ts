import { spawn } from 'node:child_process';
import type { LatencyStats, LoadProfile, RequestSpec } from './types.ts';

interface OhaJson {
  summary: {
    total: number;
    requestsPerSec: number;
    slowest: number;
    fastest: number;
    average: number;
  };
  latencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  statusCodeDistribution: Record<string, number>;
  errorDistribution: Record<string, number>;
}

export interface Measurement {
  readonly statusCounts: Record<number, number>;
  readonly errored: number;
  readonly elapsedMs: number;
  readonly throughput: number;
  readonly latency: LatencyStats | null;
}

/**
 * Runs the warmup pass. Kept separate from the measured run so callers can start resource sampling
 * afterwards: the warmup is the cold pass, and folding it into the sampled window would overstate
 * CPU per request by a target-dependent amount.
 */
export async function warmupOha(spec: RequestSpec, load: LoadProfile): Promise<void> {
  if (load.warmupMs !== undefined && load.warmupMs > 0) {
    await execOha(buildArgs(spec, { ...load, durationMs: load.warmupMs, requests: undefined }));
  }
}

export async function runOha(spec: RequestSpec, load: LoadProfile): Promise<Measurement> {
  const stdout = await execOha(buildArgs(spec, load));
  return parse(stdout);
}

function buildArgs(spec: RequestSpec, load: LoadProfile): string[] {
  const args = [
    '--output-format',
    'json',
    '--no-tui',
    '-c',
    String(Math.max(1, load.concurrency)),
    '-m',
    spec.method,
    '--disable-compression',
  ];

  if (load.durationMs !== undefined) {
    // Without this oha aborts every in-flight request when the deadline passes and reports exactly
    // `concurrency` errors on every timed run, which would drown out genuine failures.
    args.push('-z', `${load.durationMs}ms`, '--wait-ongoing-requests-after-deadline');
  } else if (load.requests !== undefined) {
    args.push('-n', String(load.requests));
  }

  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    args.push('-H', `${key}: ${value}`);
  }
  if (spec.body !== undefined) {
    args.push('-d', spec.body);
  }

  args.push(spec.url);
  return args;
}

function parse(stdout: string): Measurement {
  const json = JSON.parse(stdout) as OhaJson;

  const statusCounts: Record<number, number> = {};
  for (const [code, count] of Object.entries(json.statusCodeDistribution)) {
    statusCounts[Number(code)] = count;
  }

  let errored = 0;
  for (const count of Object.values(json.errorDistribution)) {
    errored += count;
  }

  const toMs = (seconds: number): number => seconds * 1000;
  const hasResponses = Object.keys(json.statusCodeDistribution).length > 0;

  return {
    statusCounts,
    errored,
    elapsedMs: toMs(json.summary.total),
    throughput: json.summary.requestsPerSec,
    latency: hasResponses
      ? {
          min: toMs(json.summary.fastest),
          max: toMs(json.summary.slowest),
          mean: toMs(json.summary.average),
          p50: toMs(json.latencyPercentiles.p50),
          p90: toMs(json.latencyPercentiles.p90),
          p95: toMs(json.latencyPercentiles.p95),
          p99: toMs(json.latencyPercentiles.p99),
        }
      : null,
  };
}

function execOha(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('oha', args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });

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
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`oha exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}
