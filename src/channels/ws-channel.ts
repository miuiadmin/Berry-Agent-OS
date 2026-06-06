/**
 * WS Channel — WebSocket 传输层通过 MessageChannel 接口统一接入
 *
 * P2-12: 让 WS 走统一的 ChannelManager 路径，消除与 CLI/Telegram 的传输路径分裂。
 *
 * 设计说明：
 * - WS 路径有丰富的消息类型（streaming、permission、delegation），
 *   这些仍然通过 ws-handler.ts 直接处理（MessageChannel 接口无法表达）
 * - WsChannel 处理的是"outbound"方向：其他 channel（如 Telegram）需要
 *   向 WS 客户端推送消息时，通过 channelManager.send('ws', userId, message)
 * - 以及"inbound"方向：基本的文本消息可以走 handleChannelMessage 统一路由
 */
import type { MessageChannel, IncomingMessage, OutgoingMessage, MessageHandler } from './contract.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ws-channel');

/**
 * WS Channel 的消息回调注册表。
 * WS 连接在 ws-handler.ts 中注册，WsChannel 通过此注册表分发消息。
 */
let wsMessageHandler: MessageHandler | null = null;

/** WS 连接时调用，注册消息回调 */
export function registerWsMessageHandler(handler: MessageHandler): void {
  wsMessageHandler = handler;
}

/**
 * 向特定 WS 客户端发送消息的回调表。
 * key = userId（即 clientId），value = send 函数
 */
const wsSenders = new Map<string, (message: OutgoingMessage) => void>();

/** 注册一个 WS 客户端的发送通道 */
export function registerWsSender(userId: string, send: (message: OutgoingMessage) => void): () => void {
  wsSenders.set(userId, send);
  return () => { wsSenders.delete(userId); };
}

/**
 * WsChannel 实现
 *
 * 将 WS 作为 MessageChannel 接入 ChannelManager：
 * - start/stop 为空操作（WS 生命周期由 web/server.ts 管理）
 * - send 通过注册的 sender 发送给特定客户端
 * - onMessage 由 ws-handler.ts 注册回调
 */
export class WsChannel implements MessageChannel {
  readonly type = 'ws' as const;

  async start(): Promise<void> {
    logger.debug('WsChannel 已注册（生命周期由 WebServer 管理）');
  }

  async stop(): Promise<void> {
    wsSenders.clear();
    wsMessageHandler = null;
  }

  async send(userId: string, message: OutgoingMessage): Promise<void> {
    const sender = wsSenders.get(userId);
    if (!sender) {
      logger.debug({ userId }, 'WS 客户端不在线，跳过发送');
      return;
    }
    sender(message);
  }

  onMessage(handler: MessageHandler): void {
    wsMessageHandler = handler;
  }
}

/**
 * 供 ws-handler.ts 调用：将 WS 文本消息通过 ChannelManager 路由。
 * 如果 WsChannel 已注册到 ChannelManager，消息会走 handleChannelMessage 统一路由。
 */
export function dispatchWsChannelMessage(userId: string, text: string): void {
  if (!wsMessageHandler) return;
  wsMessageHandler({
    channelId: `ws-${userId}`,
    channelType: 'ws',
    userId,
    text,
  });
}
