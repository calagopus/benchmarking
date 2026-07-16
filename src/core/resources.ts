import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ResourceUsage } from './types.ts';

export class ResourceSampler {
  private readonly cpuSamples: number[] = [];
  private readonly memSamples: number[] = [];
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private readonly containerId: string;
  private readonly intervalMs: number;

  constructor(containerId: string, intervalMs = 500) {
    this.containerId = containerId;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.running = true;
    this.loop = this.sampleUntilStopped();
  }

  async stop(): Promise<ResourceUsage | null> {
    this.running = false;
    await this.loop;

    if (this.cpuSamples.length === 0) {
      return null;
    }
    return {
      cpuPercentMean: mean(this.cpuSamples),
      cpuPercentMax: Math.max(...this.cpuSamples),
      memMbMean: mean(this.memSamples),
      memMbMax: Math.max(...this.memSamples),
      samples: this.cpuSamples.length,
    };
  }

  private async sampleUntilStopped(): Promise<void> {
    while (this.running) {
      const sample = await this.readOnce();
      if (sample !== null) {
        this.cpuSamples.push(sample.cpuPercent);
        this.memSamples.push(sample.memMb);
      }
      if (this.running) {
        await sleep(this.intervalMs);
      }
    }
  }

  private readOnce(): Promise<{ cpuPercent: number; memMb: number } | null> {
    return new Promise((resolve) => {
      const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', this.containerId], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', () => resolve(null));
      child.on('exit', () => resolve(parseStats(stdout)));
    });
  }
}

function parseStats(stdout: string): { cpuPercent: number; memMb: number } | null {
  const line = stdout.trim().split('\n')[0];
  if (!line) {
    return null;
  }
  try {
    const stats = JSON.parse(line) as { CPUPerc?: string; MemUsage?: string };
    const cpuPercent = Number.parseFloat((stats.CPUPerc ?? '0').replace('%', ''));
    const memMb = parseMemUsage(stats.MemUsage ?? '');
    if (Number.isNaN(cpuPercent)) {
      return null;
    }
    return { cpuPercent, memMb };
  } catch {
    return null;
  }
}

function parseMemUsage(memUsage: string): number {
  const used = memUsage.split('/')[0]?.trim() ?? '';
  const match = used.match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) {
    return 0;
  }
  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  const toMb: Record<string, number> = {
    B: 1 / (1024 * 1024),
    KIB: 1 / 1024,
    KB: 1 / 1024,
    MIB: 1,
    MB: 1,
    GIB: 1024,
    GB: 1024,
    TIB: 1024 * 1024,
    TB: 1024 * 1024,
  };
  return value * (toMb[unit] ?? 1);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}
