import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyTree } from './dataset.ts';
import { MIB } from './utils.ts';

export type StorageMode = 'tmpfs' | 'disk';

export interface StorageDecision {
  readonly mode: StorageMode;
  readonly reason: string;
}

export const RAMFS_HEADROOM_BYTES = 2048 * MIB;
export const RAMFS_SLACK_BYTES = 256 * MIB;

export interface StagedItem {
  readonly name: string;
  readonly bytes: number;
}

export interface StageStep {
  readonly inputs: readonly StagedItem[];
  readonly outputBytes: number;
}

export function capBytes(pinned: readonly StagedItem[], steps: readonly StageStep[]): number {
  let peak = 0;
  for (const step of steps) {
    peak = Math.max(
      peak,
      sumBytes(step.inputs.filter((item) => !pinned.some((p) => p.name === item.name))) + step.outputBytes,
    );
  }
  return sumBytes(pinned) + peak + RAMFS_SLACK_BYTES;
}

export class FixtureStager {
  private readonly source: string;
  private readonly target: string;
  private readonly pinned: readonly StagedItem[];
  private readonly steps: readonly StageStep[];
  private readonly cap: number;
  private readonly resident = new Map<string, number>();

  constructor(source: string, target: string, pinned: readonly StagedItem[], steps: readonly StageStep[]) {
    this.source = source;
    this.target = target;
    this.pinned = pinned;
    this.steps = steps;
    this.cap = capBytes(pinned, steps) - RAMFS_SLACK_BYTES;
  }

  async stagePinned(): Promise<void> {
    for (const item of this.pinned) {
      await this.load(item);
    }
  }

  async enter(index: number): Promise<void> {
    const step = this.steps[index];
    if (step === undefined) {
      return;
    }
    const wanted = new Set(step.inputs.map((item) => item.name));
    const evictable = [...this.resident.keys()].filter((name) => !wanted.has(name) && !this.isPinned(name));
    for (const name of evictable) {
      if (this.nextUse(name, index) === Number.POSITIVE_INFINITY) {
        await this.evict(name);
      }
    }

    const missing = step.inputs.filter((item) => !this.resident.has(item.name));
    const needed = sumBytes(missing) + step.outputBytes;
    const candidates = [...this.resident.keys()]
      .filter((name) => !wanted.has(name) && !this.isPinned(name))
      .sort((a, b) => this.nextUse(b, index) - this.nextUse(a, index));
    for (const name of candidates) {
      if (this.residentBytes() + needed <= this.cap) {
        break;
      }
      await this.evict(name);
    }
    for (const item of missing) {
      await this.load(item);
    }
  }

  private isPinned(name: string): boolean {
    return this.pinned.some((item) => item.name === name);
  }

  private nextUse(name: string, after: number): number {
    for (let index = after + 1; index < this.steps.length; index += 1) {
      if (this.steps[index]!.inputs.some((item) => item.name === name)) {
        return index;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  private residentBytes(): number {
    let total = 0;
    for (const bytes of this.resident.values()) {
      total += bytes;
    }
    return total;
  }

  private async load(item: StagedItem): Promise<void> {
    if (this.resident.has(item.name)) {
      return;
    }
    const target = path.join(this.target, item.name);
    await rm(target, { recursive: true, force: true });
    await copyTree(path.join(this.source, item.name), target);
    this.resident.set(item.name, item.bytes);
  }

  private async evict(name: string): Promise<void> {
    await rm(path.join(this.target, name), { recursive: true, force: true });
    this.resident.delete(name);
  }
}

function sumBytes(items: readonly StagedItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.bytes;
  }
  return total;
}

export async function mountTmpfs(dir: string, bytes: number): Promise<void> {
  await unmountTmpfs(dir);
  await mkdir(dir, { recursive: true });
  const result = await exec('mount', ['-t', 'tmpfs', '-o', `size=${bytes},mode=0755`, 'bench-ramfs', dir]);
  if (!result.ok) {
    throw new Error(`mounting tmpfs at ${dir} failed: ${result.stderr.trim()}`);
  }
}

export async function unmountTmpfs(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8 && (await isMountPoint(dir)); attempt += 1) {
    if (!(await exec('umount', [dir])).ok) {
      await exec('umount', ['-l', dir]);
    }
  }
}

async function isMountPoint(dir: string): Promise<boolean> {
  const resolved = await realpath(dir).catch(() => null);
  if (resolved === null) {
    return false;
  }
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  return mountinfo.split('\n').some((line) => unescapeMountPath(line.split(' ')[4] ?? '') === resolved);
}

function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function memAvailableBytes(): Promise<number | null> {
  const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return match !== null ? Number(match[1]) * 1024 : null;
}

export async function chooseStorage(capBytesNeeded: number): Promise<StorageDecision> {
  const available = await memAvailableBytes();
  const needed = capBytesNeeded + RAMFS_HEADROOM_BYTES;
  if (available === null) {
    return { mode: 'disk', reason: 'cannot read MemAvailable from /proc/meminfo' };
  }
  if (available < needed) {
    return {
      mode: 'disk',
      reason: `needs ${gib(needed)} GiB available memory (cap + headroom), only ${gib(available)} GiB available`,
    };
  }

  const probe = await mkdtemp(path.join(tmpdir(), 'bench-ramfs-probe-'));
  try {
    await mountTmpfs(probe, MIB);
  } catch (error) {
    return { mode: 'disk', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await unmountTmpfs(probe);
    await rmdir(probe).catch(() => undefined);
  }
  return { mode: 'tmpfs', reason: `tmpfs capped at ${gib(capBytesNeeded)} GiB` };
}

function gib(bytes: number): string {
  return (bytes / 1024 / MIB).toFixed(1);
}

function exec(command: string, args: readonly string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args as string[], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ ok: false, stderr: String(error) }));
    child.on('exit', (code) => resolve({ ok: code === 0, stderr }));
  });
}
