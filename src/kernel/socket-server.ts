import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import type { SocketRequestType } from '../contracts/socket-protocol.js';
import type { MessageBus } from './message-bus.js';
import type { SocketMessageType, MessageContext } from '../contracts/messages.js';
import type { Transport, TransportConnection } from './transport.js';
import { createHandshakeResponse } from './protocol-version.js';
import { authenticateConnection, type AuthConfig, type ConnectionAuthState, DEFAULT_AUTH_CONFIG } from './auth-middleware.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('socket-server');

export type SocketHandler = (
  request: Record<string, unknown>,
  socket: Socket,
) => void | Promise<void>;

export interface ConnectionMeta {
  protocolVersion: string;
  capabilities: string[];
  authenticated: boolean;
  connectedAt: number;
}

export class SocketServer implements Transport {
  readonly name = 'unix-socket';
  private socketPath: string;
  private server: Server | null = null;
  private handlers = new Map<string, SocketHandler>();
  private connections = new Map<string, Socket>();
  private messageBus: MessageBus | null = null;
  private connectionHandlers: Array<(conn: TransportConnection) => void> = [];
  private disconnectionHandlers: Array<(connId: string, reason?: string) => void> = [];
  private sequenceCounters = new Map<string, number>();
  private connectionMetadata = new Map<string, ConnectionMeta>();
  private authConfig: AuthConfig;

  constructor(socketPath: string, authConfig?: Partial<AuthConfig>) {
    this.socketPath = socketPath;
    this.authConfig = { ...DEFAULT_AUTH_CONFIG, ...authConfig };
  }

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
  }

  register(type: SocketRequestType, handler: SocketHandler): void {
    this.handlers.set(type, handler);
  }

  onConnection(handler: (conn: TransportConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  onDisconnection(handler: (connId: string, reason?: string) => void): void {
    this.disconnectionHandlers.push(handler);
  }

  write(connectionId: string, data: unknown): boolean {
    const socket = this.connections.get(connectionId);
    if (!socket || socket.destroyed) return false;
    return socket.write(JSON.stringify(data) + '\n');
  }

  writeBatch(connectionId: string, messages: unknown[]): boolean {
    const socket = this.connections.get(connectionId);
    if (!socket || socket.destroyed) return false;
    const payload = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    return socket.write(payload);
  }

  broadcast(data: unknown): void {
    const line = JSON.stringify(data) + '\n';
    for (const socket of this.connections.values()) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  isWritable(connectionId: string): boolean {
    const socket = this.connections.get(connectionId);
    return !!socket && !socket.destroyed && socket.writable;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async drain(): Promise<void> {
    const drainPromises: Promise<void>[] = [];
    for (const socket of this.connections.values()) {
      if (!socket.destroyed && socket.writableLength > 0) {
        drainPromises.push(new Promise((resolve) => {
          socket.once('drain', resolve);
          setTimeout(resolve, 2000);
        }));
      }
    }
    if (drainPromises.length > 0) await Promise.all(drainPromises);
  }

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      logger.debug('检测到残留 socket 文件，清理');
      unlinkSync(this.socketPath);
    }

    this.server = createServer((socket) => {
      const connId = genId('conn');
      this.connections.set(connId, socket);
      this.sequenceCounters.set(connId, 0);
      this.connectionMetadata.set(connId, {
        protocolVersion: '',
        capabilities: [],
        authenticated: !this.authConfig.enabled,
        connectedAt: Date.now(),
      });

      const conn: TransportConnection = {
        id: connId,
        transport: this.name,
        metadata: {},
        raw: socket,
        onMessage: () => {},
        onClose: () => {},
      };
      for (const handler of this.connectionHandlers) {
        try { handler(conn); } catch {}
      }

      let buffer = '';
      let processing = false;
      const queue: string[] = [];

      socket.on('error', (err) => {
        logger.debug({ err }, '连接错误');
        this.connections.delete(connId);
        this.sequenceCounters.delete(connId);
        this.connectionMetadata.delete(connId);
        for (const handler of this.disconnectionHandlers) {
          try { handler(connId, err.message); } catch {}
        }
      });

      socket.on('close', () => {
        this.connections.delete(connId);
        this.sequenceCounters.delete(connId);
        this.connectionMetadata.delete(connId);
        for (const handler of this.disconnectionHandlers) {
          try { handler(connId); } catch {}
        }
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        if (buffer.length > 1_048_576) {
          logger.warn('Socket buffer 超出 1MB 限制，断开连接');
          socket.destroy();
          return;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          if (queue.length >= 1000) {
            logger.warn('Socket 消息队列已满，丢弃消息');
            continue;
          }
          queue.push(line);
        }
        if (!processing) processQueue().catch(err => logger.error({ err }, 'Socket processQueue unhandled error'));
      });

      const processQueue = async () => {
        processing = true;
        while (queue.length > 0) {
          const line = queue.shift()!;
          try {
            const request = JSON.parse(line) as Record<string, unknown>;
            await this.dispatch(request, socket, connId);
          } catch {
            this.safeWrite(socket, JSON.stringify({ error: '无效的 JSON 请求' }) + '\n');
          }
        }
        processing = false;
      };
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        logger.info({ socketPath: this.socketPath }, 'Socket 服务已开始监听');
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.destroy();
    }
    this.connections.clear();
    if (this.server) {
      this.server.close();
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
    }
  }

  private safeWrite(socket: Socket, data: string): boolean {
    if (socket.destroyed) return false;
    return socket.write(data);
  }

  getConnectionAuthState(connectionId: string): ConnectionAuthState | undefined {
    const meta = this.connectionMetadata.get(connectionId);
    if (!meta) return undefined;
    return { authenticated: meta.authenticated, connectedAt: meta.connectedAt };
  }

  getAuthConfig(): AuthConfig {
    return this.authConfig;
  }

  private async dispatch(request: Record<string, unknown>, socket: Socket, connectionId: string): Promise<void> {
    const type = request.type as string;
    metrics.counter('socket_requests_total').inc({ type });

    if (type === 'handshake') {
      const clientVersion = (request.protocolVersion as string) ?? '0.0.0';
      const token = request.token as string | undefined;

      const authResult = await authenticateConnection(token, this.authConfig);
      const response = createHandshakeResponse(clientVersion);

      if (!authResult.ok) {
        response.ok = false;
        response.error = authResult.error;
      }

      this.connectionMetadata.set(connectionId, {
        protocolVersion: clientVersion,
        capabilities: (request.capabilities as string[]) ?? [],
        authenticated: authResult.ok,
        connectedAt: this.connectionMetadata.get(connectionId)?.connectedAt ?? Date.now(),
      });

      this.safeWrite(socket, JSON.stringify(response) + '\n');
      if (!response.ok) {
        const t = setTimeout(() => socket.destroy(), 1000);
        t.unref();
      }
      return;
    }

    const seq = (this.sequenceCounters.get(connectionId) ?? 0) + 1;
    this.sequenceCounters.set(connectionId, seq);

    const busType = `socket:${type}` as SocketMessageType;
    if (this.messageBus?.hasHandler(busType)) {
      let ackCalled = false;
      const ctx: MessageContext = {
        socket,
        correlationId: request.correlationId as string | undefined,
        connectionId,
        sequenceNum: seq,
      };

      if (request.requireAck) {
        ctx.ack = () => { ackCalled = true; };
      }

      try {
        await this.messageBus.send(busType, request as any, ctx);
      } catch (err) {
        logger.error({ err, type }, 'Socket handler 异常');
        this.safeWrite(socket, JSON.stringify({ error: '内部错误' }) + '\n');
      }

      if (request.requireAck && !ackCalled) {
        const timer = setTimeout(() => {
          if (!ackCalled) {
            logger.warn({ type, connectionId, sequenceNum: seq }, 'Message not acknowledged');
            metrics.counter('socket_unacknowledged_total').inc({ type });
          }
        }, 5_000);
        timer.unref();
      }
      return;
    }

    const handler = this.handlers.get(type);
    if (handler) {
      try {
        await handler(request, socket);
      } catch (err) {
        logger.error({ err, type }, 'Socket handler 异常');
        this.safeWrite(socket, JSON.stringify({ error: '内部错误' }) + '\n');
      }
    } else {
      metrics.counter('socket_requests_total').inc({ type: '_unknown' });
      this.safeWrite(socket, JSON.stringify({ error: '未知的请求类型' }) + '\n');
    }
  }
}
