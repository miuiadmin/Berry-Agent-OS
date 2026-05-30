import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { getLogger } from '../utils/logger.js';
import { createApiRouter } from './api-routes.js';
import { createWsHandler } from './ws-handler.js';
import { WsEventBridge } from './ws-event-bridge.js';
import type { WebServerDependencies } from './types.js';

const logger = getLogger('web-server');

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
        logger.info({ url: `http://${this.host}:${this.port}` }, 'API Server 已启动');
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

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
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
