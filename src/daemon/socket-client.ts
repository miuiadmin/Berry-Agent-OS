import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

const MAX_BUFFER_SIZE = 10_000_000;
const MAX_QUEUE_SIZE = 1000;

export interface SocketClientOptions {
  socketPath: string;
  reconnectIntervalMs?: number;
  maxReconnectMs?: number;
}

export class SocketClient extends EventEmitter {
  private socketPath: string;
  private reconnectIntervalMs: number;
  private maxReconnectMs: number;
  private socket: Socket | null = null;
  private buffer = '';
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoff: number;
  private destroyed = false;
  private outgoingQueue: string[] = [];
  private draining = false;

  constructor(opts: SocketClientOptions) {
    super();
    this.socketPath = opts.socketPath;
    this.reconnectIntervalMs = opts.reconnectIntervalMs ?? 1000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 30_000;
    this.currentBackoff = this.reconnectIntervalMs;
  }

  connect(): void {
    if (this.destroyed) return;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.socket = connect(this.socketPath);

    this.socket.on('connect', () => {
      this.connected = true;
      this.currentBackoff = this.reconnectIntervalMs;
      this.emit('connected');
      this.flushQueue();
    });

    this.socket.on('data', (data) => {
      this.buffer += data.toString();

      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.emit('error', new Error('Buffer overflow: message too large'));
        this.buffer = '';
        this.socket?.destroy();
        return;
      }

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.emit('message', msg);
        } catch {
          // skip malformed lines
        }
      }
    });

    this.socket.on('drain', () => {
      this.draining = false;
      this.flushQueue();
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.draining = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  send(msg: object): boolean {
    const line = JSON.stringify(msg) + '\n';
    if (this.connected && this.socket && !this.socket.destroyed && !this.draining) {
      const ok = this.socket.write(line);
      if (!ok) this.draining = true;
      return ok;
    }
    if (this.outgoingQueue.length >= MAX_QUEUE_SIZE) {
      this.outgoingQueue.shift();
    }
    this.outgoingQueue.push(line);
    return false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.outgoingQueue = [];
  }

  private flushQueue(): void {
    while (this.outgoingQueue.length > 0 && this.connected && this.socket && !this.draining) {
      const line = this.outgoingQueue[0];
      const ok = this.socket.write(line);
      if (!ok) {
        this.draining = true;
        return;
      }
      this.outgoingQueue.shift();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.currentBackoff);

    this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxReconnectMs);
  }
}
