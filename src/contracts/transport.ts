/**
 * 传输层写入通道接口
 *
 * 将 WS（WebSocketBridge）和 CLI（node:net.Socket）统一为同一个接口，
 * 消除 ws-handler.ts 中 `bridge as unknown as Socket` 的 unsafe cast，
 * 以及 PendingRequest.socket 的类型不安全问题。
 *
 * WS 和 CLI 的 write() 语义差异：
 * - WebSocketBridge.write() 返回 boolean（false = 连接已断）
 * - Socket.write() 返回 void（同步，不失败）
 *
 * WritableChannel 统一为 boolean 返回值，让调用方可以检测写入失败。
 */
export interface WritableChannel {
  /**
   * 写入数据到传输通道
   * @param data 要写入的字符串数据
   * @returns true=写入成功 false=连接已断开，无法写入
   */
  write(data: string): boolean;

  /**
   * 结束写入
   * - WS: 空操作（长连接，不关闭）
   * - CLI: 关闭 socket 连接
   */
  end(): void;

  /** 连接是否已销毁（断开/关闭） */
  readonly destroyed: boolean;
}

/**
 * node:net.Socket → WritableChannel 适配器
 *
 * 用于 CLI/Unix socket 路径，将真实的 Socket 包装为 WritableChannel 接口。
 * Socket.write() 返回 void（不失败），适配为始终返回 true。
 * Socket.destroyed 属性直接映射。
 */
import type { Socket } from 'node:net';

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
