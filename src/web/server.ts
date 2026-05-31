import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getLogger } from '../utils/logger.js';
import { createApiRouter } from './api-routes.js';
import { createWsHandler } from './ws-handler.js';
import { WsEventBridge } from './ws-event-bridge.js';
import type { WebServerDependencies } from './types.js';

const logger = getLogger('web-server');

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(__dirname, '../../web/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
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
  private readonly hasStaticDir: boolean;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.host = options.host;
    this.deps = options.deps;

    // Auto-generate secret when binding to non-localhost without an explicit secret
    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(options.host);
    if (!isLocalhost && !this.deps.secret) {
      const generated = randomBytes(32).toString('hex');
      (this.deps as { secret: string }).secret = generated;
      logger.warn('非本机绑定但未配置 web.secret，已自动生成随机 secret — 请在 config.yaml 中设置以保持稳定');
    }
    this.apiRouter = createApiRouter(options.deps);
    this.wsHandler = createWsHandler(options.deps);
    this.hasStaticDir = existsSync(STATIC_DIR);
    if (this.hasStaticDir) {
      logger.info({ dir: STATIC_DIR }, '前端静态文件目录已找到');
    } else {
      logger.info('前端静态文件目录未找到，仅提供 API 模式');
    }
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.wsHandler(ws, req));
    this.eventBridge = new WsEventBridge(this.wss, this.deps.eventBus);

    this.server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '/';
      if (!url.startsWith('/ws')) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.deps.secret && !this.isLocalRequest(req) && !this.verifyWsAuth(req)) {
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
        logger.info({ url: `http://${this.host}:${this.port}` }, 'Server 已启动');
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
    const pathname = decodeURIComponent(url.pathname);

    // 1. API routes
    if (pathname.startsWith('/api/')) {
      if (this.deps.secret && !this.isLocalRequest(req) && !this.verifyHttpAuth(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      this.apiRouter(req, res, url);
      return;
    }

    // 2. Static files (SPA)
    if (this.hasStaticDir && req.method === 'GET') {
      this.serveStatic(pathname, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    // Try exact file first, then fall back to index.html for SPA routing
    const candidates = [
      join(STATIC_DIR, pathname),
      join(STATIC_DIR, pathname, 'index.html'),
    ];

    // If not a known asset extension, also try SPA fallback
    const ext = extname(pathname);
    if (!ext || ext === '.html') {
      // SPA fallback: serve index.html for all non-file paths
      candidates.push(join(STATIC_DIR, 'index.html'));
    }

    for (const filePath of candidates) {
      // Security: prevent path traversal
      const resolved = resolve(filePath);
      if (!resolved.startsWith(STATIC_DIR)) continue;

      if (existsSync(resolved) && statSync(resolved).isFile()) {
        const fileExt = extname(resolved);
        const contentType = MIME_TYPES[fileExt] ?? 'application/octet-stream';
        const stat = statSync(resolved);

        res.writeHead(200, {
          'content-type': contentType,
          'content-length': stat.size,
          'cache-control': fileExt === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        });
        createReadStream(resolved).on('error', (err) => {
          logger.error({ err, path: resolved }, 'Static file stream error');
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('Internal Server Error');
        }).pipe(res);
        return;
      }
    }

    // Final SPA fallback: index.html for client-side routing
    const indexPath = join(STATIC_DIR, 'index.html');
    if (existsSync(indexPath)) {
      const stat = statSync(indexPath);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      });
      createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
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

  private isLocalRequest(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress;
    if (!remote) return false;
    const ip = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
    return isPrivateNetwork(ip);
  }
}

function isPrivateNetwork(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const parts = ip.split('.');
    if (parts.length >= 2) {
      const second = parseInt(parts[1], 10);
      if (!isNaN(second) && second >= 16 && second <= 31) return true;
    }
  }
  if (ip.startsWith('fe80:')) return true;
  return false;
}
