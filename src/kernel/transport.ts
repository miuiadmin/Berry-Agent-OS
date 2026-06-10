import type { Socket } from 'node:net';

/** 传输层连接抽象（SocketServer implements Transport） */
export interface TransportConnection {
  readonly id: string;
  readonly transport: string;
  readonly metadata: Record<string, unknown>;
  readonly raw?: Socket;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

/** 传输层接口（SocketServer 是唯一实现） */
export interface Transport {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  write(connectionId: string, data: unknown): boolean;
  writeBatch(connectionId: string, messages: unknown[]): boolean;
  broadcast(data: unknown): void;
  onConnection(handler: (conn: TransportConnection) => void): void;
  onDisconnection(handler: (connId: string, reason?: string) => void): void;
  isWritable(connectionId: string): boolean;
  connectionCount(): number;
  drain(): Promise<void>;
}
