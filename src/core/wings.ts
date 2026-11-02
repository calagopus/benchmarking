import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import colors from 'ansi-colors';
import { DockerDaemon } from './daemon.ts';
import {
  ARCHIVE_FORMATS,
  archiveFileName,
  archiveFootprint,
  archiveKey,
  BLOB_BYTES,
  BLOB_PATH,
  CHUNK_BYTES,
  CHUNK_PATH,
  cleanOutputs,
  copyTree,
  countFiles,
  type Dataset,
  type DatasetRequest,
  ensureDataset,
  fileSize,
  isGeneratedArchive,
  LIST_SIZES,
  listDirName,
  listFootprint,
  OUTPUT_PATHS,
  pageBytes,
  randomBytes,
  SMALL_BYTES,
  SMALL_PATH,
  syncFilesystem,
  TREE_IDS,
  treeDirName,
  treeFootprint,
  UPLOAD_BYTES,
} from './dataset.ts';
import { networkExists, networkRemove } from './docker.ts';
import {
  capBytes,
  FixtureStager,
  mountTmpfs,
  type StagedItem,
  type StageStep,
  type StorageMode,
  unmountTmpfs,
} from './ramfs.ts';
import { RemoteMock } from './remote-mock.ts';
import { SftpClient, type SftpEndpoint, type SftpResult } from './sftp.ts';
import type { TaskOutcome, TaskRunner } from './target.ts';
import type {
  ArchiveFormat,
  AuthContext,
  HttpMethod,
  Operation,
  RequestSpec,
  ResourceLimit,
  Scenario,
  ScenarioParams,
  TaskScenario,
} from './types.ts';
import { benchPort, MIB } from './utils.ts';

export interface WingsDaemonOptions {
  readonly composeFile?: string;
  readonly project?: string;
  readonly host?: string;
  readonly port?: number;
  readonly sftpPort?: number;
  readonly image?: string;
  readonly service?: string;
  readonly workdir?: string;
  readonly settleMs?: number;
  readonly prune?: boolean;
  readonly storage?: StorageMode;
}

export interface WingsConfigContext {
  readonly nodeUuid: string;
  readonly tokenId: string;
  readonly token: string;
  readonly remote: string;
  readonly networkName: string;
  readonly subnetIndex: number;
}

export interface WingsFlavor {
  readonly name: string;
  readonly username: string;
  readonly networkName: string;
  readonly subnetIndex: number;
  readonly composeFile: string;
  readonly compressFormats: readonly ArchiveFormat[];
  readonly notes: readonly string[];
  renderConfig(context: WingsConfigContext): string;
}

export const SERVER_UUID = '3f9d3c5e-0b0f-4d8e-9c1a-1b2c3d4e5f60';
const EGG_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const NODE_UUID = '7c6b5a49-3827-4160-9f8e-7d6c5b4a3928';
const USER_UUID = '5e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN_ID = 'benchmarkNodeId1';
const TOKEN = 'benchmarkbenchmarkbenchmarkbenchmarkbenchmarkbenchmarkbenchmark1';
export const DEFAULT_WORKDIR = path.resolve(process.cwd(), '.bench');
const UPLOAD_SEED = 0x0bad_cafe;

const COMPRESS_FORMAT_NAMES: Readonly<Record<ArchiveFormat, string>> = {
  'tar.gz': 'tar_gz',
  zip: 'zip',
};

export abstract class WingsDaemon extends DockerDaemon implements TaskRunner {
  readonly name: string;

  protected readonly serviceName: string;
  protected readonly healthPath = '/api/system';
  protected readonly compose: {
    readonly file: string;
    readonly project: string;
    readonly env: Record<string, string>;
  };

  private readonly flavor: WingsFlavor;
  private readonly host: string;
  private port: number;
  private sftpPort: number;
  private readonly sftpPinned: boolean;
  private readonly workdir: string;
  private readonly ramDir: string;
  private readonly storageMode: StorageMode;
  private readonly settleMs: number;
  private readonly prune: boolean;
  private readonly mock: RemoteMock;
  private ownsNetwork = false;
  private dataset: Dataset | null = null;
  private uploadBody: Uint8Array<ArrayBuffer> | null = null;
  private readonly sftp: SftpClient;
  private sftpAvailable = false;
  private sftpScenario: TaskScenario | null = null;
  private stager: FixtureStager | null = null;
  private taskOrder: readonly TaskScenario[] = [];
  private stagedScenario: TaskScenario | null = null;

  constructor(flavor: WingsFlavor, options: WingsDaemonOptions = {}) {
    super();
    this.flavor = flavor;
    this.name = flavor.name;
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? benchPort(this.kind, this.name);
    this.sftpPort = options.sftpPort ?? this.port + 1;
    this.sftpPinned = options.sftpPort !== undefined;
    this.portPinned = options.port !== undefined || this.sftpPinned;
    this.serviceName = options.service ?? 'wings';
    this.workdir = path.resolve(options.workdir ?? DEFAULT_WORKDIR, `daemon-${flavor.name}`);
    this.ramDir = path.join(this.workdir, 'ram');
    this.storageMode = options.storage ?? 'disk';
    this.sftp = new SftpClient(this.workdir);
    this.settleMs = options.settleMs ?? 10_000;
    this.prune = options.prune === true;
    this.mock = new RemoteMock({
      tokenId: TOKEN_ID,
      token: TOKEN,
      serverUuid: SERVER_UUID,
      userUuid: USER_UUID,
      server: buildServerDocument(),
    });

    const env: Record<string, string> = {
      WINGS_PORT: String(this.port),
      WINGS_SFTP_PORT: String(this.sftpPort),
      WINGS_WORKDIR: this.workdir,
      WINGS_LIBDIR: path.join(this.liveDir, 'lib'),
      WINGS_TMPDIR: path.join(this.liveDir, 'tmp'),
      WINGS_USERNAME: flavor.username,
    };
    if (options.image !== undefined) {
      env.WINGS_IMAGE = options.image;
    }
    this.compose = {
      file: options.composeFile ?? flavor.composeFile,
      project: options.project ?? `${flavor.name}-daemon-bench`,
      env,
    };
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected get hostPort(): number {
    return this.port;
  }

  protected get extraHostPorts(): readonly number[] {
    return [this.sftpPort];
  }

  protected rebindPort(port: number): void {
    this.port = port;
    this.compose.env.WINGS_PORT = String(port);
    this.sftpPort = port + 1;
    this.compose.env.WINGS_SFTP_PORT = String(this.sftpPort);
  }

  private get sftpEndpoint(): SftpEndpoint {
    return { host: this.host, port: this.sftpPort, username: `bench.${SERVER_UUID.slice(0, 8)}` };
  }

  override get storage(): StorageMode {
    return this.storageMode;
  }

  override get heapIncludesShmem(): boolean {
    return false;
  }

  private get liveDir(): string {
    return this.storageMode === 'tmpfs' ? this.ramDir : this.workdir;
  }

  private get sftpDownloadDir(): string {
    return path.join(this.liveDir, 'sftp', 'download');
  }

  /** The on-disk fixture cache. On disk storage the daemon serves straight out of it. */
  private get cacheRoot(): string {
    return path.join(this.workdir, 'lib', 'volumes', SERVER_UUID);
  }

  get serverRoot(): string {
    return path.join(this.liveDir, 'lib', 'volumes', SERVER_UUID);
  }

  notes(): readonly string[] {
    const notes = [...this.flavor.notes];
    notes.push(
      'archive tasks run warm: the warmup run pulls the tree into page cache, so they compare codecs rather than cold-disk reads',
      'decompress is benchmarked for formats a daemon cannot create, so zip decompress is comparable even where zip compress is not',
      'large directory listings are timed one at a time rather than driven by a load generator, and run warm: the warmup run pulls the entries and inodes into cache, so they compare readdir/stat and serialisation rather than cold metadata reads',
    );
    if (this.storageMode === 'tmpfs') {
      notes.push(
        'files live on tmpfs: fixtures are staged into RAM from the on-disk cache before each task, so writes never reach a disk and fsync is free; only comparable with other tmpfs runs',
        'the delete fixture is restored with a RAM copy, so deletes measure CPU and dentry work rather than disk metadata updates',
      );
    } else if (this.dataset?.reflink === true) {
      notes.push(
        'the delete fixture is restored with a reflink clone, so no byte copy or writeback is charged to the timed delete',
      );
    }
    return notes;
  }

  tasks(): TaskRunner {
    return this;
  }

  protected resourceEnv(limit: ResourceLimit): Record<string, string> {
    return {
      WINGS_CPUS: String(limit.cpus),
      WINGS_MEM: limit.memoryMb !== undefined && limit.memoryMb > 0 ? `${limit.memoryMb}m` : '0',
    };
  }

  protected readinessHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${TOKEN}` };
  }

  async start(limit: ResourceLimit): Promise<void> {
    // Wings appends to its log forever and never rotates it, and Calagopus writes a line per
    // request, so a repeated sweep grows the log past the fixtures it is measuring. Dropping it
    // as the variant starts bounds it to one variant's worth and still leaves it for a post-mortem.
    await rm(path.join(this.workdir, 'log'), { recursive: true, force: true });
    await Promise.all(
      ['etc', 'lib', 'log', 'tmp'].map((dir) => mkdir(path.join(this.workdir, dir), { recursive: true })),
    );
    await mkdir(this.serverRoot, { recursive: true });

    this.ownsNetwork = !(await networkExists(this.flavor.networkName));
    const port = await this.mock.start();
    console.log(colors.dim(`  remote api mock listening on :${port}`));
    const config = this.flavor.renderConfig({
      nodeUuid: NODE_UUID,
      tokenId: TOKEN_ID,
      token: TOKEN,
      remote: `http://host.docker.internal:${port}`,
      networkName: this.flavor.networkName,
      subnetIndex: this.flavor.subnetIndex,
    });
    await writeConfig(path.join(this.workdir, 'etc', 'config.yml'), config);

    await this.bringUp(limit);
    if (this.settleMs > 0) {
      console.log(colors.dim(`  settling for ${this.settleMs / 1000}s (boot-time disk walks)...`));
      await sleep(this.settleMs);
    }
  }

  async stop(): Promise<void> {
    try {
      this.sftpScenario = null;
      await this.sftp.close();
      await super.stop();
    } finally {
      if (this.ownsNetwork) {
        await networkRemove(this.flavor.networkName).catch(() => undefined);
      }
      await this.mock.stop();
      await this.releaseTmpfs();
    }
  }

  private async releaseTmpfs(): Promise<void> {
    this.stager = null;
    this.stagedScenario = null;
    if (this.storageMode === 'tmpfs') {
      await unmountTmpfs(this.ramDir);
    }
  }

  /**
   * The outputs cost nothing to rebuild, so they always go. The fixtures are cached across runs
   * and cost ~40s to regenerate, so they only go when asked: holding every daemon's set at once
   * is what makes a group sweep need tens of gigabytes.
   */
  override async release(): Promise<void> {
    await this.releaseTmpfs();
    await cleanOutputs(this.cacheRoot);
    await rm(this.sftpDownloadDir, { recursive: true, force: true });
    if (this.prune) {
      await rm(this.cacheRoot, { recursive: true, force: true });
      await rm(path.join(this.workdir, 'log'), { recursive: true, force: true });
    }
  }

  async authenticate(): Promise<AuthContext> {
    return { mode: 'authenticated', headers: { Authorization: `Bearer ${TOKEN}` } };
  }

  override async version(): Promise<string | null> {
    const response = await fetch(this.url('/api/system'), { headers: this.readinessHeaders() });
    if (!response.ok) {
      await response.arrayBuffer();
      return null;
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  }

  buildRequest(operation: Operation, auth: AuthContext, params: ScenarioParams = {}): RequestSpec | null {
    switch (operation) {
      case 'system':
        return { method: 'GET', url: this.url('/api/system'), headers: this.authHeaders(auth) };
      case 'listDirectory': {
        const entries = entriesParam(params, operation);
        return {
          method: 'GET',
          url: this.serverUrl(`files/list-directory?directory=${encodeURIComponent(`/${listDirName(entries)}`)}`),
          headers: this.authHeaders(auth),
        };
      }
      case 'fileContents': {
        const file = params.file === 'small' ? SMALL_PATH : CHUNK_PATH;
        return {
          method: 'GET',
          url: this.serverUrl(`files/contents?file=${encodeURIComponent(`/${file}`)}&download=true`),
          headers: this.authHeaders(auth),
        };
      }
      case 'chmod':
        return {
          method: 'POST',
          url: this.serverUrl('files/chmod'),
          headers: { ...this.authHeaders(auth), 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: '/', files: [{ file: SMALL_PATH, mode: '644' }] }),
        };
      default:
        return null;
    }
  }

  async prepare(scenarios: readonly Scenario[]): Promise<Dataset> {
    const trees = new Set<string>();
    const archives = new Set<string>();
    const listSizes = new Set<number>();
    let blob = false;
    let sftp = false;
    for (const scenario of scenarios) {
      // Listing spans both kinds, so its fixture is claimed before load scenarios are skipped.
      if (scenario.operation === 'listDirectory') {
        listSizes.add(entriesParam(scenario.params, scenario.name));
        continue;
      }
      if (scenario.kind === 'load') {
        continue;
      }
      if (scenario.operation.startsWith('sftp')) {
        sftp = true;
      }
      switch (scenario.operation) {
        case 'compress':
        case 'deleteTree':
        case 'sftpGetTree':
        case 'sftpPutTree':
          trees.add(treeParam(scenario));
          break;
        case 'sftpList':
          listSizes.add(entriesParam(scenario.params, scenario.name));
          break;
        case 'sftpUpload':
        case 'sftpDownload':
          blob = true;
          break;
        case 'decompress':
          trees.add(treeParam(scenario));
          archives.add(archiveKey(treeParam(scenario), formatParam(scenario)));
          break;
        default:
          break;
      }
    }
    this.sftpAvailable = sftp && (await SftpClient.available());
    if (this.sftpAvailable) {
      await this.sftp.prepare();
    }
    const request: DatasetRequest = { trees, archives, listSizes, blob };
    this.dataset = await ensureDataset(this.cacheRoot, request);
    if (this.storageMode === 'tmpfs') {
      await this.mountStaging(scenarios);
    }
    return this.dataset;
  }

  private async mountStaging(scenarios: readonly Scenario[]): Promise<void> {
    const plan = stagePlan(scenarios);
    const cap = capBytes(plan.pinned, plan.steps);
    await mountTmpfs(this.ramDir, cap);
    await Promise.all([path.join(this.ramDir, 'tmp'), this.serverRoot].map((dir) => mkdir(dir, { recursive: true })));
    console.log(colors.dim(`  staging fixtures on a ${(cap / MIB).toFixed(0)} MiB tmpfs at ${this.ramDir}`));
    this.stager = new FixtureStager(this.cacheRoot, this.serverRoot, plan.pinned, plan.steps);
    this.taskOrder = plan.order;
    this.stagedScenario = null;
    await this.stager.stagePinned();
  }

  /** Swaps in what the scenario reads before its first run, outside the timed window. */
  private async stage(scenario: TaskScenario): Promise<void> {
    if (this.stager === null || this.stagedScenario === scenario) {
      return;
    }
    await cleanOutputs(this.serverRoot);
    await rm(this.sftpDownloadDir, { recursive: true, force: true });
    await this.stager.enter(this.taskOrder.indexOf(scenario));
    this.stagedScenario = scenario;
  }

  unsupported(scenario: TaskScenario, dataset: Dataset): string | null {
    if (scenario.operation.startsWith('sftp') && !this.sftpAvailable) {
      return 'the OpenSSH client (ssh, sftp, ssh-keygen) is not on PATH';
    }
    switch (scenario.operation) {
      case 'compress': {
        const format = formatParam(scenario);
        return this.flavor.compressFormats.includes(format) ? null : `${this.label} cannot create ${format} archives`;
      }
      case 'decompress': {
        return dataset.archives.has(archiveKey(treeParam(scenario), formatParam(scenario)))
          ? null
          : 'input archive missing';
      }
      case 'listDirectory':
      case 'sftpList': {
        return dataset.lists.has(entriesParam(scenario.params, scenario.name)) ? null : 'list fixture missing';
      }
      case 'sftpUpload':
      case 'sftpDownload':
        return dataset.blob === null ? 'blob fixture missing' : null;
      default:
        return null;
    }
  }

  async reset(scenario: TaskScenario, dataset: Dataset): Promise<void> {
    await this.stage(scenario);
    if (scenario.operation.startsWith('sftp') && scenario.operation !== 'sftpLogin') {
      await this.resetSftp(scenario);
    }
    const root = this.serverRoot;
    switch (scenario.operation) {
      case 'compress':
        await removeMatching(root, (name) => name.startsWith(OUTPUT_PATHS.compressOutput) || isGeneratedArchive(name));
        break;
      case 'decompress':
        await rm(path.join(root, OUTPUT_PATHS.extracted), { recursive: true, force: true });
        break;
      case 'deleteTree': {
        const tree = dataset.trees.get(treeParam(scenario));
        await rm(path.join(root, OUTPUT_PATHS.deleteTree), { recursive: true, force: true });
        if (tree !== undefined) {
          await copyTree(tree.dir, path.join(root, OUTPUT_PATHS.deleteTree));
        }
        break;
      }
      case 'writeFile':
        await rm(path.join(root, OUTPUT_PATHS.upload), { force: true });
        break;
      case 'sftpUpload':
        await rm(path.join(root, OUTPUT_PATHS.sftpUpload), { force: true });
        break;
      case 'sftpPutTree':
        await rm(path.join(root, OUTPUT_PATHS.sftpTree), { recursive: true, force: true });
        break;
      case 'sftpGetTree':
        await rm(this.sftpDownloadDir, { recursive: true, force: true });
        await mkdir(this.sftpDownloadDir, { recursive: true });
        break;
      case 'listDirectory':
      case 'sftpList':
      case 'sftpLogin':
      case 'sftpDownload':
        // Nothing to restore, and no writeback to flush.
        return;
      default:
        break;
    }
    await syncFilesystem(root);
  }

  async run(scenario: TaskScenario, dataset: Dataset, auth: AuthContext): Promise<TaskOutcome> {
    const root = this.serverRoot;
    switch (scenario.operation) {
      case 'compress': {
        const treeId = treeParam(scenario);
        const format = formatParam(scenario);
        const tree = dataset.trees.get(treeId);
        if (tree === undefined) {
          return failure(`tree '${treeId}' missing`);
        }
        const name = `${OUTPUT_PATHS.compressOutput}.${format}`;
        const outcome = await this.request(
          'files/compress',
          auth,
          { root: '/', files: [treeDirName(treeId)], name, format: COMPRESS_FORMAT_NAMES[format] },
          tree.bytes,
        );
        const archiveBytes = await producedArchiveBytes(root);
        return verify(
          outcome,
          archiveBytes >= tree.bytes * MIN_ARCHIVE_RATIO,
          archiveBytes === 0 ? 'archive missing' : `archive implausibly small (${archiveBytes} bytes)`,
        );
      }
      case 'decompress': {
        const treeId = treeParam(scenario);
        const tree = dataset.trees.get(treeId);
        const archive = dataset.archives.get(archiveKey(treeId, formatParam(scenario)));
        if (tree === undefined || archive === undefined) {
          return failure('input archive missing');
        }
        const outcome = await this.request('files/decompress', auth, { root: '/', file: archive }, tree.bytes);
        const extracted = path.join(root, OUTPUT_PATHS.extracted);
        const count = (await fileSize(extracted)) === null ? 0 : await countFiles(extracted);
        return verify(outcome, count === tree.files, `extracted ${count}/${tree.files} files`);
      }
      case 'deleteTree': {
        const tree = dataset.trees.get(treeParam(scenario));
        if (tree === undefined) {
          return failure('tree missing');
        }
        // Deletion cost tracks inode count, not bytes, so no byte total is reported: a MB/s
        // figure derived from the tree size would be meaningless.
        const outcome = await this.request('files/delete', auth, { root: '/', files: [OUTPUT_PATHS.deleteTree] }, 0);
        return verify(
          outcome,
          (await fileSize(path.join(root, OUTPUT_PATHS.deleteTree))) === null,
          'tree still present',
        );
      }
      case 'listDirectory': {
        const entries = entriesParam(scenario.params, scenario.name);
        const { outcome, body } = await this.timedRequest(
          `files/list-directory?directory=${encodeURIComponent(`/${listDirName(entries)}`)}`,
          auth,
          { method: 'GET' },
          0,
        );
        if (!outcome.ok) {
          return outcome;
        }
        const listed = listedEntries(body);
        return verify(
          outcome,
          listed === entries,
          listed === null ? 'listing was not a JSON array' : `listed ${listed}/${entries} entries`,
        );
      }
      case 'writeFile': {
        const body = this.upload(UPLOAD_BYTES);
        const outcome = await this.rawRequest(
          `files/write?file=${encodeURIComponent(`/${OUTPUT_PATHS.upload}`)}`,
          auth,
          body,
          body.length,
        );
        return verify(
          outcome,
          (await fileSize(path.join(root, OUTPUT_PATHS.upload))) === body.length,
          'upload size mismatch',
        );
      }
      case 'sftpLogin': {
        const result = await this.sftp.login(this.sftpEndpoint);
        return sftpOutcome(result, 0);
      }
      case 'sftpUpload': {
        if (dataset.blob === null) {
          return failure('blob fixture missing');
        }
        const outcome = await this.sftpRun(
          [`put ${path.join(dataset.root, dataset.blob)} /${OUTPUT_PATHS.sftpUpload}`],
          BLOB_BYTES,
        );
        return verify(
          outcome,
          (await fileSize(path.join(root, OUTPUT_PATHS.sftpUpload))) === BLOB_BYTES,
          'upload size mismatch',
        );
      }
      case 'sftpDownload': {
        if (dataset.blob === null) {
          return failure('blob fixture missing');
        }
        return this.sftpRun([`get /${dataset.blob} /dev/null`], BLOB_BYTES);
      }
      case 'sftpList': {
        const entries = entriesParam(scenario.params, scenario.name);
        // Unsorted, so the client's sort stays out of the measurement.
        const { outcome, stdout } = await this.sftpRunCapture([`ls -1f /${listDirName(entries)}`], 0);
        const listed = stdout.split('\n').filter((line) => line !== '' && !line.startsWith('sftp>')).length;
        return verify(outcome, listed === entries, `listed ${listed}/${entries} entries`);
      }
      case 'sftpGetTree': {
        const tree = dataset.trees.get(treeParam(scenario));
        if (tree === undefined) {
          return failure('tree missing');
        }
        const local = path.join(this.sftpDownloadDir, 'tree');
        const outcome = await this.sftpRun([`get -r /${path.basename(tree.dir)} ${local}`], tree.bytes);
        const count = (await fileSize(local)) === null ? 0 : await countFiles(local);
        return verify(outcome, count === tree.files, `downloaded ${count}/${tree.files} files`);
      }
      case 'sftpPutTree': {
        const tree = dataset.trees.get(treeParam(scenario));
        if (tree === undefined) {
          return failure('tree missing');
        }
        const remote = path.join(root, OUTPUT_PATHS.sftpTree);
        const outcome = await this.sftpRun([`put -r ${tree.dir} /${OUTPUT_PATHS.sftpTree}`], tree.bytes);
        const count = (await fileSize(remote)) === null ? 0 : await countFiles(remote);
        return verify(outcome, count === tree.files, `uploaded ${count}/${tree.files} files`);
      }
      default:
        return failure(`unsupported task '${scenario.operation}'`);
    }
  }

  /**
   * One master connection per scenario: Calagopus Wings only frees a channel slot on EOF, so a
   * long-lived master would eventually exhaust `max_channels_per_connection` after a failed run.
   */
  private async resetSftp(scenario: TaskScenario): Promise<void> {
    if (this.sftpScenario === scenario && this.sftp.connected) {
      return;
    }
    this.sftpScenario = scenario;
    const result = await this.sftp.open(this.sftpEndpoint);
    if (!result.ok) {
      console.log(colors.yellow(`  sftp master connection failed: ${result.stderr.trim()}`));
    }
  }

  private async sftpRun(commands: readonly string[], bytes: number): Promise<TaskOutcome> {
    return (await this.sftpRunCapture(commands, bytes)).outcome;
  }

  private async sftpRunCapture(
    commands: readonly string[],
    bytes: number,
  ): Promise<{ outcome: TaskOutcome; stdout: string }> {
    if (!this.sftp.connected) {
      return { outcome: failure('sftp master connection is not open'), stdout: '' };
    }
    const result = await this.sftp.run(commands);
    return { outcome: sftpOutcome(result, bytes), stdout: result.stdout };
  }

  private upload(bytes: number): Uint8Array<ArrayBuffer> {
    if (this.uploadBody === null || this.uploadBody.length !== bytes) {
      this.uploadBody = randomBytes(bytes, UPLOAD_SEED);
    }
    return this.uploadBody;
  }

  private serverUrl(suffix: string): string {
    return this.url(`/api/servers/${SERVER_UUID}/${suffix}`);
  }

  private request(suffix: string, auth: AuthContext, payload: unknown, bytes: number): Promise<TaskOutcome> {
    return this.rawRequest(suffix, auth, JSON.stringify(payload), bytes, { 'Content-Type': 'application/json' });
  }

  private async rawRequest(
    suffix: string,
    auth: AuthContext,
    body: string | Uint8Array<ArrayBuffer>,
    bytes: number,
    headers: Record<string, string> = {},
  ): Promise<TaskOutcome> {
    const { outcome } = await this.timedRequest(suffix, auth, { method: 'POST', headers, body }, bytes);
    return outcome;
  }

  /**
   * Times a request end to end, reading the body inside the window but leaving it undecoded:
   * parsing a multi-megabyte response is the harness's cost, not the daemon's.
   */
  private async timedRequest(
    suffix: string,
    auth: AuthContext,
    init: TaskRequest,
    bytes: number,
  ): Promise<{ outcome: TaskOutcome; body: Uint8Array }> {
    const empty = new Uint8Array(0);
    const started = performance.now();
    try {
      const response = await fetch(this.serverUrl(suffix), {
        method: init.method,
        headers: { ...this.authHeaders(auth), ...init.headers, Accept: 'application/json' },
        body: init.body,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const elapsedMs = performance.now() - started;
      if (!response.ok) {
        return {
          outcome: { ok: false, status: response.status, elapsedMs, bytes, detail: decodeDetail(body) },
          body: empty,
        };
      }
      return { outcome: { ok: true, status: response.status, elapsedMs, bytes }, body };
    } catch (error) {
      const elapsedMs = performance.now() - started;
      return { outcome: { ok: false, status: 0, elapsedMs, bytes, detail: String(error) }, body: empty };
    }
  }
}

export interface StagePlan {
  readonly pinned: readonly StagedItem[];
  readonly steps: readonly StageStep[];
  readonly order: readonly TaskScenario[];
}

/**
 * What each task scenario needs resident on tmpfs, in run order. Load scenarios never pass through
 * reset(), so everything they touch is pinned for the whole variant. Client-side sources (sftp
 * put) are read from the on-disk cache and only their server-side copy is reserved.
 */
export function stagePlan(scenarios: readonly Scenario[]): StagePlan {
  const pinned: StagedItem[] = [
    { name: CHUNK_PATH, bytes: pageBytes(CHUNK_BYTES) },
    { name: SMALL_PATH, bytes: pageBytes(SMALL_BYTES) },
  ];
  const steps: StageStep[] = [];
  const order: TaskScenario[] = [];
  const list = (entries: number): StagedItem => ({ name: listDirName(entries), bytes: listFootprint(entries) });
  const tree = (id: string): StagedItem => ({ name: treeDirName(id), bytes: treeFootprint(id) });

  for (const scenario of scenarios) {
    if (scenario.kind === 'load') {
      if (scenario.operation === 'listDirectory') {
        pinned.push(list(entriesParam(scenario.params, scenario.name)));
      }
      continue;
    }
    order.push(scenario);
    steps.push(stageStep(scenario, list, tree));
  }
  return { pinned, steps, order };
}

function stageStep(
  scenario: TaskScenario,
  list: (entries: number) => StagedItem,
  tree: (id: string) => StagedItem,
): StageStep {
  switch (scenario.operation) {
    case 'listDirectory':
    case 'sftpList':
      return { inputs: [list(entriesParam(scenario.params, scenario.name))], outputBytes: 0 };
    case 'compress':
      return { inputs: [tree(treeParam(scenario))], outputBytes: archiveFootprint(treeParam(scenario)) };
    case 'decompress': {
      const id = treeParam(scenario);
      const archive = { name: archiveFileName(id, formatParam(scenario)), bytes: archiveFootprint(id) };
      return { inputs: [archive], outputBytes: treeFootprint(id) };
    }
    case 'deleteTree':
      // Twice the tree: a daemon that trashes before purging can still hold the previous copy.
      return { inputs: [], outputBytes: 2 * treeFootprint(treeParam(scenario)) };
    case 'writeFile':
      return { inputs: [], outputBytes: pageBytes(UPLOAD_BYTES) };
    case 'sftpUpload':
      return { inputs: [], outputBytes: pageBytes(BLOB_BYTES) };
    case 'sftpDownload':
      return { inputs: [{ name: BLOB_PATH, bytes: pageBytes(BLOB_BYTES) }], outputBytes: 0 };
    case 'sftpGetTree':
      return { inputs: [tree(treeParam(scenario))], outputBytes: treeFootprint(treeParam(scenario)) };
    case 'sftpPutTree':
      return { inputs: [], outputBytes: treeFootprint(treeParam(scenario)) };
    default:
      return { inputs: [], outputBytes: 0 };
  }
}

interface TaskRequest {
  readonly method: HttpMethod;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
}

export function treeParam(scenario: TaskScenario): string {
  const id = scenario.params?.tree;
  if (id === undefined) {
    throw new Error(`task scenario '${scenario.name}' is missing a 'tree' parameter`);
  }
  const treeId = String(id);
  if (!TREE_IDS.includes(treeId)) {
    throw new Error(`unknown tree '${treeId}' in scenario '${scenario.name}' (available: ${TREE_IDS.join(', ')})`);
  }
  return treeId;
}

export function formatParam(scenario: TaskScenario): ArchiveFormat {
  const format = String(scenario.params?.format ?? 'tar.gz');
  if (!ARCHIVE_FORMATS.includes(format as ArchiveFormat)) {
    throw new Error(`unknown archive format '${format}'`);
  }
  return format as ArchiveFormat;
}

export function entriesParam(params: ScenarioParams | undefined, label: string): number {
  const raw = params?.entries;
  if (raw === undefined) {
    throw new Error(`scenario '${label}' is missing an 'entries' parameter`);
  }
  const entries = Number(raw);
  if (!LIST_SIZES.includes(entries)) {
    throw new Error(`unknown list size '${entries}' in scenario '${label}' (available: ${LIST_SIZES.join(', ')})`);
  }
  return entries;
}

/**
 * Counts the entries a listing returned, or null if it was not the bare array every daemon serves
 * here. Guards against a daemon reporting success while truncating at a configured entry cap.
 */
function listedEntries(body: Uint8Array): number | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function decodeDetail(body: Uint8Array): string {
  return new TextDecoder().decode(body.subarray(0, 200));
}

/** Guards against a daemon reporting success while writing a truncated or empty archive. */
const MIN_ARCHIVE_RATIO = 0.01;

async function producedArchiveBytes(root: string): Promise<number> {
  const entries = await readdir(root);
  const archives = entries.filter(
    (entry) => entry.startsWith(OUTPUT_PATHS.compressOutput) || isGeneratedArchive(entry),
  );
  let bytes = 0;
  for (const entry of archives) {
    bytes += (await fileSize(path.join(root, entry))) ?? 0;
  }
  return bytes;
}

function sftpOutcome(result: SftpResult, bytes: number): TaskOutcome {
  const status = result.code ?? -1;
  if (result.ok) {
    return { ok: true, status, elapsedMs: result.elapsedMs, bytes };
  }
  return { ok: false, status, elapsedMs: result.elapsedMs, bytes, detail: result.stderr.trim().slice(0, 200) };
}

function failure(detail: string): TaskOutcome {
  return { ok: false, status: 0, elapsedMs: 0, bytes: 0, detail };
}

function verify(outcome: TaskOutcome, condition: boolean, detail: string): TaskOutcome {
  if (!outcome.ok || condition) {
    return outcome;
  }
  return { ...outcome, ok: false, detail };
}

async function removeMatching(dir: string, predicate: (name: string) => boolean): Promise<void> {
  const entries = await readdir(dir);
  await Promise.all(
    entries.filter(predicate).map((name) => rm(path.join(dir, name), { recursive: true, force: true })),
  );
}

async function writeConfig(file: string, content: string): Promise<void> {
  await rm(file, { force: true });
  await writeFile(file, content, { mode: 0o600 });
}

function buildServerDocument(): unknown {
  return {
    uuid: SERVER_UUID,
    id: 1,
    settings: {
      uuid: SERVER_UUID,
      meta: { name: 'benchmark', description: 'benchmark server' },
      suspended: false,
      invocation: 'sleep infinity',
      skip_egg_scripts: true,
      environment: {},
      labels: {},
      allocations: {
        force_outgoing_ip: false,
        default: { ip: '127.0.0.1', port: 25565 },
        mappings: { '127.0.0.1': [25565] },
      },
      build: {
        memory_limit: 512,
        swap: 0,
        io_weight: 500,
        cpu_limit: 100,
        threads: null,
        disk_space: 0,
        oom_disabled: true,
      },
      crash_detection_enabled: false,
      mounts: [],
      egg: { id: EGG_UUID, file_denylist: [] },
      container: { image: '~busybox' },
    },
    process_configuration: {
      startup: { done: [], user_interaction: [], strip_ansi: false },
      stop: { type: 'command', value: 'stop' },
      configs: [],
    },
  };
}
