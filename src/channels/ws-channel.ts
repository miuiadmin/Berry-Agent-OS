/**
 * WS Channel — WebSocket 传输层通过 MessageChannel 接口统一接入
 *
 * P2-12: 让 WS 走统一的 ChannelManager 路径，消除与 CLI/Telegram 的传输路径分裂。
 *
 * 设计说明：
 * - WS 路径有丰富的消息类型（streaming、permission、delegation），
 *   这些仍然通过 ws-handler.ts 直接处理（MessageChannel 接口无法表达）
 * - WsChannel 当前仅用作 inbound 通道（ChannelManager 注册 onMessage 回调）
 * - outbound 推送通过 ChannelManager.initEventBridge 订阅 EventBus
 *   conversation.result 事件分发到对应 channel
 *
 * 注意：registerWsSender / dispatchWsChannelMessage 已在 PR-8 中删除。
 * outbound 路径统一走 ChannelManager.initEventBridge（EventBus 订阅模式）。
 */
import type { MessageChannel, IncomingMessage, OutgoingMessage, MessageHandler } from './contract.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ws-channel');

/**
 * WsChannel 实现
 *
 * 将 WS 作为 MessageChannel 接入 ChannelManager：
 * - start/stop 为空操作（WS 生命周期由 web/server.ts 管理）
 * - send 通过 ChannelManager.initEventBridge 的 EventBus 订阅实现 outbound 推送
 * - onMessage 由 ChannelManager.register → WsChannel.onMessage 注册 inbound 回调
 */
export class WsChannel implements MessageChannel {
  readonly type = 'ws' as const;
  /** inbound 消息回调（ChannelManager.register 时设置） */
  private messageHandler: MessageHandler | null = null;

  async start(): Promise<void> {
    logger.debug('WsChannel 已注册（生命周期由 WebServer 管理）');
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
  }

  /**
   * outbound 发送：通过 ChannelManager.initEventBridge 订阅
   * EventBus conversation.result 事件后，由 ChannelManager.send() 调用。
   * 当前 WS 的 outbound 不走此路径（WS 由 WsEventBridge 独立处理），
   * 此方法仅作为 MessageChannel 接口的必要实现。
   */
  async send(_userId: string, _message: OutgoingMessage): Promise<void> {
    // WS outbound 走 WsEventBridge（EventBus 订阅模式），不走 ChannelManager.send
    logger.debug('WsChannel.send: WS outbound 走 WsEventBridge，此路径不应被调用');
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
}
