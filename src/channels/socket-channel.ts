/**
 * node:net.Socket → WritableChannel 适配器
 *
 * 用于 CLI/Unix socket 路径，将真实的 Socket 包装为 WritableChannel 接口。
 * Socket.write() 返回 void（不失败），适配为始终返回 true。
 * Socket.destroyed 属性直接映射。
 *
 * R15 解耦审计：从 contracts/transport.ts 迁出，contracts 层只保留纯接口定义。
 */
import type { Socket } from 'node:net';
import type { WritableChannel } from '../contracts/transport.js';

export class SocketChannel implements WritableChannel {
  constructor(private socket: Socket) {}

  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  write(data: string): boolean {
    if (this.socket.destroyed) return false;
    this.socket.write(data);
    return true;
  }

  end(): void {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }
}
