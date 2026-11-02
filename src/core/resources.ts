import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ResourceUsage } from './types.ts';
import { MIB } from './utils.ts';

interface Snapshot {
  readonly at: number;
  readonly cpuNs: number;
  readonly heapBytes: number;
}

interface StatsJson {
  read?: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number } };
  memory_stats?: { stats?: { anon?: number; shmem?: number } };
}

/**
 * Docker stamps `read` at the instant it samples the cgroup counters. Timing intervals from our
 * own clock instead would measure when the response callback got scheduled, which on a busy event
 * loop skews short intervals badly enough to report rates above the container's CPU quota.
 */
function sampleTime(json: StatsJson): number {
  const parsed = json.read !== undefined ? Date.parse(json.read) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function dockerSocketPath(): string {
  const host = process.env.DOCKER_HOST;
  if (host !== undefined && host.startsWith('unix://')) {
    return host.slice('unix://'.length);
  }
  return '/var/run/docker.sock';
}

export function readContainerSnapshot(containerId: string, includeShmem = true): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: dockerSocketPath(),
        path: `/containers/${containerId}/stats?stream=false&one-shot=true`,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(body) as StatsJson;
            const cpuNs = json.cpu_stats?.cpu_usage?.total_usage;
            const anon = json.memory_stats?.stats?.anon;
            if (cpuNs === undefined || anon === undefined) {
              resolve(null);
              return;
            }
            const shmem = includeShmem ? (json.memory_stats?.stats?.shmem ?? 0) : 0;
            resolve({ at: sampleTime(json), cpuNs, heapBytes: anon + shmem });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

export class ResourceSampler {
  private readonly snapshots: Snapshot[] = [];
  private readonly containerId: string;
  private readonly intervalMs: number;
  private readonly includeShmem: boolean;
  private readonly stopped = new AbortController();
  private loop: Promise<void> = Promise.resolve();

  constructor(containerId: string, intervalMs = 500, includeShmem = true) {
    this.containerId = containerId;
    this.intervalMs = intervalMs;
    this.includeShmem = includeShmem;
  }

  /**
   * Resolves once the opening snapshot is in, so the caller can start the work it wants measured
   * without any of it falling outside the sampling window.
   */
  async start(): Promise<void> {
    await this.take();
    this.loop = this.sampleUntilStopped();
  }

  async stop(): Promise<ResourceUsage | null> {
    this.stopped.abort();
    await this.loop;
    await this.take();
    return summarize(this.snapshots);
  }

  private async sampleUntilStopped(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      try {
        await sleep(this.intervalMs, undefined, { signal: this.stopped.signal });
      } catch {
        return;
      }
      await this.take();
    }
  }

  private async take(): Promise<void> {
    const snapshot = await readContainerSnapshot(this.containerId, this.includeShmem);
    if (snapshot !== null) {
      this.snapshots.push(snapshot);
    }
  }
}

function summarize(snapshots: readonly Snapshot[]): ResourceUsage | null {
  if (snapshots.length < 2) {
    return null;
  }
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const wallMs = last.at - first.at;
  if (wallMs <= 0) {
    return null;
  }

  let cpuPercentMax = 0;
  let heapSum = 0;
  let heapMax = 0;
  // Snapshot 0 is taken before the measured work starts; it anchors the CPU delta but including
  // its idle heap in the average would credit whichever target finished faster with a lower mean.
  for (let i = 1; i < snapshots.length; i += 1) {
    const current = snapshots[i]!;
    const previous = snapshots[i - 1]!;
    heapSum += current.heapBytes;
    heapMax = Math.max(heapMax, current.heapBytes);
    const intervalMs = current.at - previous.at;
    if (intervalMs > 0) {
      cpuPercentMax = Math.max(cpuPercentMax, cpuPercent(current.cpuNs - previous.cpuNs, intervalMs));
    }
  }

  const measured = snapshots.length - 1;
  const cpuMs = (last.cpuNs - first.cpuNs) / 1_000_000;
  return {
    cpuMs,
    windowMs: wallMs,
    cpuPercentMean: (cpuMs / wallMs) * 100,
    cpuPercentMax,
    heapMbMean: heapSum / measured / MIB,
    heapMbMax: heapMax / MIB,
    samples: snapshots.length,
  };
}

function cpuPercent(cpuNs: number, wallMs: number): number {
  return (cpuNs / 1_000_000 / wallMs) * 100;
}
