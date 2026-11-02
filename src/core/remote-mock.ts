import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import colors from 'ansi-colors';

export interface RemoteMockOptions {
  readonly tokenId: string;
  readonly token: string;
  readonly serverUuid: string;
  readonly userUuid: string;
  readonly server: unknown;
}

const PREFIX = '/api/remote';

export class RemoteMock {
  private readonly options: RemoteMockOptions;
  private readonly seenUnknown = new Set<string>();
  private server: Server | null = null;
  private listeningPort = 0;

  constructor(options: RemoteMockOptions) {
    this.options = options;
  }

  get port(): number {
    return this.listeningPort;
  }

  async start(): Promise<number> {
    if (this.server !== null) {
      return this.listeningPort;
    }
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('remote mock did not bind to a tcp port');
    }
    this.server = server;
    this.listeningPort = address.port;
    return this.listeningPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (!url.pathname.startsWith(PREFIX)) {
      this.unknown(req, url, res);
      return;
    }

    const expected = `Bearer ${this.options.tokenId}.${this.options.token}`;
    if (req.headers.authorization !== expected) {
      json(res, 403, { errors: [{ code: 'AccessDeniedHttpException', detail: 'bad node token' }] });
      return;
    }

    const route = url.pathname.slice(PREFIX.length);
    const method = req.method ?? 'GET';
    const { serverUuid, server } = this.options;

    if (method === 'GET' && route === '/servers') {
      json(res, 200, {
        data: [server],
        meta: { current_page: 1, from: 1, last_page: 1, per_page: 50, to: 1, total: 1 },
      });
      return;
    }
    if (method === 'GET' && route === `/servers/${serverUuid}`) {
      json(res, 200, server);
      return;
    }
    if (method === 'POST' && route === '/servers/reset') {
      empty(res, 204);
      return;
    }
    if (method === 'POST' && route === '/activity') {
      drain(req, () => empty(res, 204));
      return;
    }
    if (method === 'POST' && route === '/sftp/auth') {
      drain(req, () => json(res, 200, { server: serverUuid, user: this.options.userUuid, permissions: ['*'] }));
      return;
    }
    if (
      method === 'POST' &&
      (route === `/servers/${serverUuid}/install` || route === `/servers/${serverUuid}/container/status`)
    ) {
      drain(req, () => empty(res, 204));
      return;
    }

    this.unknown(req, url, res);
  }

  private unknown(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const key = `${req.method ?? 'GET'} ${url.pathname}`;
    if (!this.seenUnknown.has(key)) {
      this.seenUnknown.add(key);
      console.log(colors.yellow(`  remote mock: unhandled ${key}`));
    }
    drain(req, () => json(res, 404, { errors: [{ code: 'NotFoundHttpException', detail: 'not mocked' }] }));
  }
}

function drain(req: IncomingMessage, done: () => void): void {
  req.on('end', done);
  req.resume();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function empty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}
