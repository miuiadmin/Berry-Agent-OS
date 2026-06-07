/**
 * WebSocket 客户端工厂默认实现。
 *
 * 将 import('ws') 集中在此文件（src/lib/，不属于 kernel），
 * 使 kernel/runtime/drivers/custom-driver.ts 不再直接依赖 ws 模块。
 */
import type { WsClientConnection, WsClientFactory } from '../contracts/agent-runtime.js';

/**
 * ws 库原始 WebSocket 到 WsClientConnection 接口的适配器。
 * 将 ws 的事件系统映射到 WsClientConnection 的 on 方法签名。
 */
class WsClientAdapter implements WsClientConnection {
  constructor(private ws: import('ws').WebSocket) {}

  send(data: string): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  on(event: 'open' | 'close' | 'message' | 'error', handler: (...args: unknown[]) => void): void {
    if (event === 'message') {
      this.ws.on('message', (data) => handler(data));
    } else if (event === 'error') {
      this.ws.on('error', (err) => handler(err));
    } else {
      // open / close 事件：handler 无参数
      this.ws.on(event, handler as () => void);
    }
  }
}

/**
 * 默认 WebSocket 客户端工厂。
 * 使用 ws 库创建连接，返回 WsClientConnection 抽象。
 */
export const createWsConnection: WsClientFactory = async (url, headers) => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(url, { headers });
  return new WsClientAdapter(ws);
};
