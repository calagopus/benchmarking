import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, deflateRawSync } from 'node:zlib';
import colors from 'ansi-colors';
import type { ArchiveFormat } from './types.ts';
import { MIB } from './utils.ts';

export const LIST_SIZES: readonly number[] = [50, 5_000, 50_000];
export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = ['tar.gz', 'zip'];
export const UPLOAD_BYTES = 256 * MIB;

const TEXT_BYTES = 4096;
const SMALL_TEXT_BYTES = 256;
const REGION_BYTES = MIB;
const JAR_BYTES = 32 * MIB;

export interface TreeProfile {
  readonly id: string;
  readonly label: string;
  readonly textFiles: number;
  readonly textBytes: number;
  readonly regionFiles: number;
  readonly jarFiles: number;
}

function mixedProfile(id: string, label: string, sizeMiB: number): TreeProfile {
  const textFiles = Math.round((sizeMiB * 0.08 * MIB) / TEXT_BYTES / 100) * 100;
  const jarFiles = Math.max(1, Math.round(sizeMiB / 128));
  const remaining = sizeMiB * MIB - textFiles * TEXT_BYTES - jarFiles * JAR_BYTES;
  return {
    id,
    label,
    textFiles,
    textBytes: TEXT_BYTES,
    regionFiles: Math.max(1, Math.round(remaining / REGION_BYTES)),
    jarFiles,
  };
}

export const TREE_PROFILES: readonly TreeProfile[] = [
  mixedProfile('100m', '100 MiB', 100),
  mixedProfile('1g', '1 GiB', 1024),
  {
    id: 'many',
    label: '50k small files',
    textFiles: 50_000,
    textBytes: SMALL_TEXT_BYTES,
    regionFiles: 0,
    jarFiles: 0,
  },
];

export const TREE_IDS: readonly string[] = TREE_PROFILES.map((profile) => profile.id);

export function treeProfile(id: string): TreeProfile {
  const profile = TREE_PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new Error(`unknown tree profile '${id}' (available: ${TREE_IDS.join(', ')})`);
  }
  return profile;
}

export interface DatasetRequest {
  readonly trees: ReadonlySet<string>;
  readonly archives: ReadonlySet<string>;
  readonly listSizes: ReadonlySet<number>;
  readonly blob: boolean;
}

export interface TreeInfo {
  readonly dir: string;
  readonly files: number;
  readonly bytes: number;
}

export interface Dataset {
  readonly root: string;
  readonly trees: ReadonlyMap<string, TreeInfo>;
  readonly archives: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<number, string>;
  readonly blob: string | null;
  readonly reflink: boolean;
}

export const OUTPUT_PATHS = {
  extracted: 'extracted',
  deleteTree: 'delete-me',
  upload: 'upload.bin',
  compressOutput: 'bench-output',
  sftpUpload: 'sftp-upload.bin',
  sftpTree: 'sftp-tree',
} as const;

export const CHUNK_PATH = 'chunk.bin';
export const SMALL_PATH = 'small.bin';
export const BLOB_PATH = 'blob.bin';
export const BLOB_BYTES = 256 * MIB;
const CHUNK_BYTES = 8 * MIB;
const SMALL_BYTES = 4096;

export function archiveKey(treeId: string, format: ArchiveFormat): string {
  return `${treeId}:${format}`;
}

export function treeDirName(treeId: string): string {
  return `tree-${treeId}`;
}

export function listDirName(entries: number): string {
  return `list-${entries}`;
}

function archiveFileName(treeId: string, format: ArchiveFormat): string {
  return `input-${treeId}.${format}`;
}

function treeBytes(profile: TreeProfile): number {
  return profile.textFiles * profile.textBytes + profile.regionFiles * REGION_BYTES + profile.jarFiles * JAR_BYTES;
}

export function treeFiles(profile: TreeProfile): number {
  return profile.textFiles + profile.regionFiles + profile.jarFiles;
}

export async function ensureDataset(root: string, request: DatasetRequest): Promise<Dataset> {
  await mkdir(root, { recursive: true });
  await cleanOutputs(root);
  const started = performance.now();
  const trees = new Map<string, TreeInfo>();
  const archives = new Map<string, string>();
  const lists = new Map<number, string>();

  for (const profile of TREE_PROFILES.filter((candidate) => request.trees.has(candidate.id))) {
    const dir = path.join(root, treeDirName(profile.id));
    await component(root, treeDirName(profile.id), profile, async () => {
      await rm(dir, { recursive: true, force: true });
      await writeTree(dir, profile, new Xorshift(seedOf(profile.id)));
    });
    trees.set(profile.id, { dir, files: treeFiles(profile), bytes: treeBytes(profile) });
  }

  for (const key of request.archives) {
    const [treeId, format] = key.split(':') as [string, ArchiveFormat];
    const tree = trees.get(treeId);
    if (tree === undefined) {
      continue;
    }
    const name = archiveFileName(treeId, format);
    const file = path.join(root, name);
    await component(root, name, { format, profile: treeProfile(treeId) }, async () => {
      await rm(file, { force: true });
      await createArchive(tree.dir, OUTPUT_PATHS.extracted, file, format);
    });
    archives.set(key, name);
  }

  for (const entries of request.listSizes) {
    const dir = path.join(root, listDirName(entries));
    await component(root, listDirName(entries), { entries }, async () => {
      await rm(dir, { recursive: true, force: true });
      await writeFlat(dir, entries, new Xorshift(0x11f7 + entries));
    });
    lists.set(entries, listDirName(entries));
  }

  await component(root, CHUNK_PATH, { bytes: CHUNK_BYTES }, async () => {
    await writeRandomFile(path.join(root, CHUNK_PATH), CHUNK_BYTES, new Xorshift(0xc4c4));
  });
  await component(root, SMALL_PATH, { bytes: SMALL_BYTES }, async () => {
    await writeRandomFile(path.join(root, SMALL_PATH), SMALL_BYTES, new Xorshift(0x5a11));
  });

  let blob: string | null = null;
  if (request.blob) {
    await component(root, BLOB_PATH, { bytes: BLOB_BYTES }, async () => {
      await writeRandomFile(path.join(root, BLOB_PATH), BLOB_BYTES, new Xorshift(0xb10b));
    });
    blob = BLOB_PATH;
  }

  const reflink = await probeReflink(root);
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed > 1) {
    console.log(colors.dim(`  dataset ready in ${elapsed.toFixed(1)}s`));
  }
  return { root, trees, archives, lists, blob, reflink };
}

const TIMESTAMPED_ARCHIVE = /^archive-.*\.(tar\.gz|zip)$/;

/** Both Go wings implementations ignore the requested archive name and emit their own timestamped one. */
export function isGeneratedArchive(name: string): boolean {
  return TIMESTAMPED_ARCHIVE.test(name);
}

function isOutput(name: string): boolean {
  return (
    name === OUTPUT_PATHS.extracted ||
    name === OUTPUT_PATHS.deleteTree ||
    name === OUTPUT_PATHS.upload ||
    name === OUTPUT_PATHS.sftpUpload ||
    name === OUTPUT_PATHS.sftpTree ||
    name.startsWith(OUTPUT_PATHS.compressOutput) ||
    TIMESTAMPED_ARCHIVE.test(name)
  );
}

export async function cleanOutputs(root: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    entries.filter(isOutput).map((name) => rm(path.join(root, name), { recursive: true, force: true })),
  );
}

/**
 * Copies a directory tree, preferring a reflink clone so that restoring a fixture between
 * repetitions neither costs the byte copy nor leaves dirty pages for the timed operation to
 * flush. `--reflink=auto` silently degrades to a full copy on filesystems without clone support.
 */
export async function copyTree(source: string, target: string): Promise<void> {
  if (!(await probe('cp', ['-a', '--reflink=auto', source, target]))) {
    await cp(source, target, { recursive: true });
  }
}

/**
 * Flushes the filesystem holding `root` so that writes made while restoring a fixture are not
 * charged to the timed operation that follows.
 */
export async function syncFilesystem(root: string): Promise<void> {
  await probe('sync', ['-f', root]);
}

async function component(root: string, name: string, spec: unknown, build: () => Promise<void>): Promise<void> {
  const marker = path.join(root, `.bench-${name}.json`);
  const expected = JSON.stringify({ version: 3, spec });
  try {
    if ((await readFile(marker, 'utf8')).trim() === expected && (await fileSize(path.join(root, name))) !== null) {
      return;
    }
  } catch {
    // no marker yet
  }
  console.log(colors.dim(`  generating ${name}...`));
  await rm(marker, { force: true });
  await build();
  await writeFile(marker, `${expected}\n`);
}

export function randomBytes(bytes: number, seed: number): Uint8Array<ArrayBuffer> {
  const backing = new ArrayBuffer(bytes);
  new Xorshift(seed).fill(Buffer.from(backing));
  return new Uint8Array(backing);
}

export async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(path.join(dir, entry.name));
    } else {
      count += 1;
    }
  }
  return count;
}

export async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function writeTree(dir: string, profile: TreeProfile, rng: Xorshift): Promise<void> {
  const textDirs = Math.ceil(profile.textFiles / 100);
  for (let d = 0; d < textDirs; d += 1) {
    const target = path.join(dir, 'plugins', `plugin-${String(d).padStart(3, '0')}`);
    await mkdir(target, { recursive: true });
    const count = Math.min(100, profile.textFiles - d * 100);
    await batched(count, (f) =>
      writeFile(path.join(target, `config-${String(f).padStart(3, '0')}.yml`), textBuffer(profile.textBytes, rng)),
    );
  }

  if (profile.regionFiles > 0) {
    const regionDir = path.join(dir, 'world', 'region');
    await mkdir(regionDir, { recursive: true });
    for (let f = 0; f < profile.regionFiles; f += 1) {
      await writeRandomFile(path.join(regionDir, `r.${Math.floor(f / 32)}.${f % 32}.mca`), REGION_BYTES, rng);
    }
  }

  if (profile.jarFiles > 0) {
    const jarDir = path.join(dir, 'libraries');
    await mkdir(jarDir, { recursive: true });
    for (let f = 0; f < profile.jarFiles; f += 1) {
      await writeRandomFile(path.join(jarDir, `library-${f}.jar`), JAR_BYTES, rng);
    }
  }
  await mkdir(dir, { recursive: true });
}

function seedOf(treeId: string): number {
  let seed = 0x7ee0;
  for (const char of treeId) {
    seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  }
  return seed;
}

async function writeFlat(dir: string, entries: number, rng: Xorshift): Promise<void> {
  await mkdir(dir, { recursive: true });
  const digits = String(entries - 1).length;
  await batched(entries, (f) =>
    writeFile(path.join(dir, `entry-${String(f).padStart(digits, '0')}.dat`), textBuffer(256, rng)),
  );
}

async function batched(count: number, write: (index: number) => Promise<void>): Promise<void> {
  const pending: Promise<void>[] = [];
  for (let i = 0; i < count; i += 1) {
    pending.push(write(i));
    if (pending.length >= 64) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
}

const WORDS = [
  'server',
  'player',
  'world',
  'chunk',
  'entity',
  'plugin',
  'config',
  'enabled',
  'true',
  'false',
  'level',
  'spawn',
  'region',
  'ticks',
  'memory',
  'thread',
  'network',
  'packet',
  'session',
  'token',
  'backup',
  'schedule',
  'daemon',
  'volume',
  'archive',
  'restore',
  'warning',
  'error',
  'info',
  'debug',
];

function textBuffer(bytes: number, rng: Xorshift): Buffer {
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    const line = `${rng.pick(WORDS)}_${rng.pick(WORDS)}=${rng.pick(WORDS)} ${rng.nextU32() % 10_000}\n`;
    parts.push(line);
    length += line.length;
  }
  return Buffer.from(parts.join('').slice(0, bytes), 'latin1');
}

async function writeRandomFile(file: string, bytes: number, rng: Xorshift): Promise<void> {
  const chunkBytes = 4 * MIB;
  let remaining = bytes;
  const chunks = function* (): Generator<Buffer> {
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, remaining));
      rng.fill(chunk);
      remaining -= chunk.length;
      yield chunk;
    }
  };
  await pipeline(Readable.from(chunks()), createWriteStream(file));
}

interface Entry {
  readonly name: string;
  readonly path: string | null;
}

async function walk(dir: string, prefix: string): Promise<Entry[]> {
  const out: Entry[] = [{ name: `${prefix}/`, path: null }];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const entryName = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walk(entryPath, entryName)));
    } else {
      out.push({ name: entryName, path: entryPath });
    }
  }
  return out;
}

async function createArchive(sourceDir: string, prefix: string, outFile: string, format: ArchiveFormat): Promise<void> {
  switch (format) {
    case 'tar.gz':
      await createTarGz(sourceDir, prefix, outFile);
      return;
    case 'zip':
      await createZip(sourceDir, prefix, outFile);
      return;
    default:
      throw new Error(`unsupported archive format '${format satisfies never}'`);
  }
}

async function createTarGz(sourceDir: string, prefix: string, outFile: string): Promise<void> {
  const mtime = Math.floor(Date.now() / 1000);
  const entries = await walk(sourceDir, prefix);
  const chunks = async function* (): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      if (entry.path === null) {
        yield tarHeader(entry.name, 0, '5', mtime);
        continue;
      }
      const content = await readFile(entry.path);
      yield tarHeader(entry.name, content.length, '0', mtime);
      yield content;
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) {
        yield Buffer.alloc(padding);
      }
    }
    yield Buffer.alloc(1024);
  };
  await pipeline(Readable.from(chunks()), createGzip({ level: 1 }), createWriteStream(outFile));
}

function tarHeader(name: string, size: number, type: '0' | '5', mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar entry name too long: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, type === '5' ? 0o755 : 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtime, 136, 12);
  header.fill(' ', 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii');
  header.write('root', 297, 4, 'ascii');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

const ZIP_LIMIT = 0xffff_ffff;

async function createZip(sourceDir: string, prefix: string, outFile: string): Promise<void> {
  const entries = await walk(sourceDir, prefix);
  if (entries.length >= 0xffff) {
    throw new Error('zip writer does not support more than 65534 entries (zip64 not implemented)');
  }
  const dosTime = dosDateTime(new Date());
  const central: Buffer[] = [];
  let offset = 0;

  const chunks = async function* (): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const content = entry.path === null ? Buffer.alloc(0) : await readFile(entry.path);
      const method = entry.path === null ? 0 : 8;
      const data = method === 8 ? deflateRawSync(content, { level: 1 }) : content;
      const crc = crc32(content);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x0403_4b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(dosTime, 10);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(content.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x0201_4b50, 0);
      record.writeUInt16LE(0x031e, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt32LE(dosTime, 12);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(data.length, 20);
      record.writeUInt32LE(content.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      record.writeUInt32LE(((entry.path === null ? 0o40755 : 0o100644) << 16) >>> 0, 38);
      if (offset > ZIP_LIMIT) {
        throw new Error('zip writer does not support archives over 4 GiB (zip64 not implemented)');
      }
      record.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([record, name]));

      yield local;
      yield name;
      yield data;
      offset += local.length + name.length + data.length;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const record of central) {
      centralSize += record.length;
      yield record;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x0605_4b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    yield end;
  };
  await pipeline(Readable.from(chunks()), createWriteStream(outFile));
}

function dosDateTime(date: Date): number {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return ((day << 16) | time) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function probeReflink(root: string): Promise<boolean> {
  const source = path.join(root, '.reflink-probe');
  const target = `${source}.copy`;
  await writeFile(source, 'probe');
  const ok = await probe('cp', ['--reflink=always', source, target]);
  await Promise.all([rm(source, { force: true }), rm(target, { force: true })]);
  return ok;
}

function probe(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args as string[], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

class Xorshift {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e37_79b9;
  }

  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.nextU32() % values.length]!;
  }

  fill(buffer: Buffer): void {
    const words = buffer.length >>> 2;
    for (let i = 0; i < words; i += 1) {
      buffer.writeUInt32LE(this.nextU32(), i * 4);
    }
    for (let i = words * 4; i < buffer.length; i += 1) {
      buffer[i] = this.nextU32() & 0xff;
    }
  }
}
