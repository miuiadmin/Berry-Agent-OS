import type { Socket } from 'node:net';

export interface TransportConnection {
  readonly id: string;
  readonly transport: string;
  readonly metadata: Record<string, unknown>;
  readonly raw?: Socket;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

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

export interface TransportManager {
  register(transport: Transport): void;
  getTransport(name: string): Transport | undefined;
  all(): Transport[];
  write(connectionId: string, data: unknown): boolean;
  broadcast(data: unknown): void;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}

export function createTransportManager(): TransportManager {
  const transports = new Map<string, Transport>();
  const connectionToTransport = new Map<string, string>();

  return {
    register(transport: Transport): void {
      transports.set(transport.name, transport);
      transport.onConnection((conn) => {
        connectionToTransport.set(conn.id, transport.name);
      });
      transport.onDisconnection((connId) => {
        connectionToTransport.delete(connId);
      });
    },

    getTransport(name: string): Transport | undefined {
      return transports.get(name);
    },

    all(): Transport[] {
      return [...transports.values()];
    },

    write(connectionId: string, data: unknown): boolean {
      const transportName = connectionToTransport.get(connectionId);
      if (!transportName) return false;
      const transport = transports.get(transportName);
      if (!transport) return false;
      return transport.write(connectionId, data);
    },

    broadcast(data: unknown): void {
      for (const transport of transports.values()) {
        transport.broadcast(data);
      }
    },

    async startAll(): Promise<void> {
      await Promise.all([...transports.values()].map((t) => t.start()));
    },

    async stopAll(): Promise<void> {
      await Promise.all([...transports.values()].map((t) => t.stop()));
    },
  };
}
