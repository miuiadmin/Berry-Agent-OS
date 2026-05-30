import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getLogger } from '../utils/logger.js';
import { createApiRouter } from './api-routes.js';
import { createWsHandler } from './ws-handler.js';
import { WsEventBridge } from './ws-event-bridge.js';
import type { WebServerDependencies } from './types.js';

const logger = getLogger('web-server');

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(__dirname, '../../web/out');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface WebServerOptions {
  port: number;
  host: string;
  deps: WebServerDependencies;
}

export class WebServer {
  private server: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private eventBridge: WsEventBridge | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly deps: WebServerDependencies;
  private readonly apiRouter: ReturnType<typeof createApiRouter>;
  private readonly wsHandler: ReturnType<typeof createWsHandler>;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.host = options.host;
    this.deps = options.deps;
    this.apiRouter = createApiRouter(options.deps);
    this.wsHandler = createWsHandler(options.deps);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.wsHandler(ws, req));
    this.eventBridge = new WsEventBridge(this.wss, this.deps.eventBus);

    this.server.on('upgrade', (req, socket, head) => {
      if (this.deps.secret && !this.verifyWsAuth(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, this.host, () => {
        logger.info({ url: `http://${this.host}:${this.port}` }, 'Web Dashboard 已启动');
        resolve();
      });
    });
  }

  stop(): void {
    if (this.eventBridge) {
      this.eventBridge.dispose();
      this.eventBridge = null;
    }
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, 'server shutting down');
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (this.deps.secret && !this.verifyHttpAuth(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      this.apiRouter(req, res, url);
      return;
    }

    this.serveStatic(pathname, res);
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    if (!existsSync(STATIC_DIR)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Berry Dashboard</h1><p>前端未构建。请运行 <code>npm run build:web</code></p></body></html>');
      return;
    }

    let filePath = resolve(STATIC_DIR, '.' + pathname);

    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (filePath.endsWith('/')) {
      filePath = join(filePath, 'index.html');
    }

    stat(filePath, (err, stats) => {
      if (!err && stats.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
      this.streamFile(filePath, res);
    });
  }

  private streamFile(filePath: string, res: ServerResponse): void {
    stat(filePath, (err) => {
      if (err) {
        const htmlPath = filePath + '.html';
        stat(htmlPath, (err2) => {
          if (!err2) {
            this.pipeFile(htmlPath, res);
          } else {
            const fallback = join(STATIC_DIR, '404.html');
            stat(fallback, (err3) => {
              if (!err3) {
                this.pipeFile(fallback, res, 404);
              } else {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('Not Found');
              }
            });
          }
        });
        return;
      }
      this.pipeFile(filePath, res);
    });
  }

  private pipeFile(filePath: string, res: ServerResponse, status = 200): void {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(status, { 'content-type': contentType });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end('Internal Server Error');
    });
  }

  private verifyHttpAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth) return false;
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token === this.deps.secret;
  }

  private verifyWsAuth(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    return token === this.deps.secret;
  }
}
