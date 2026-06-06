import type { MessageChannel, MessageHandler, IncomingMessage, OutgoingMessage } from './contract.js';
import type { EventBus } from '../kernel/event-bus.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('channel-manager');

export class ChannelManager {
  private channels = new Map<string, MessageChannel>();
  private handlers: MessageHandler[] = [];
  /** EventBus conversation.result 订阅取消函数 */
  private eventUnsubscribe: (() => void) | null = null;

  register(channel: MessageChannel): void {
    if (this.channels.has(channel.type)) {
      logger.warn({ type: channel.type }, '覆盖已注册的同类型 channel');
    }
    this.channels.set(channel.type, channel);
    channel.onMessage((msg) => this.dispatch(msg));
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async startAll(): Promise<void> {
    for (const [type, channel] of this.channels) {
      try {
        await channel.start();
        logger.info({ type }, 'Channel 已启动');
      } catch (err) {
        logger.error({ type, err: (err as Error).message }, 'Channel 启动失败');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [type, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        logger.debug({ type, err: (err as Error).message }, 'Channel 关闭异常');
      }
    }
    this.channels.clear();
  }

  async send(channelType: string, userId: string, message: OutgoingMessage): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      logger.warn({ channelType }, '目标 channel 不存在');
      return;
    }
    await channel.send(userId, message);
  }

  getChannel<T extends MessageChannel>(type: string): T | undefined {
    return this.channels.get(type) as T | undefined;
  }

  /**
   * 订阅 EventBus 的 conversation.result 事件，将结果分发到对应 channel。
   * sessionId 格式为 channel-{channelType}-{userId}（非 channel 前缀的忽略，
   * WS 由 WsEventBridge 独立处理）。
   */
  initEventBridge(eventBus: EventBus): void {
    this.eventUnsubscribe = eventBus.on('conversation.result', (payload) => {
      const match = payload.sessionId.match(/^channel-(\w+)-(.+)$/);
      if (!match) return; // 非 channel 前缀的 sessionId（如 WS 的 ses-xxx），忽略
      const [, channelType, userId] = match;
      this.send(channelType, userId, { text: payload.response }).catch((err) => {
        logger.error({ channelType, userId, err: (err as Error).message }, 'conversation.result → channel 分发失败');
      });
    });
  }

  /** 取消 EventBus 订阅（服务关闭时调用） */
  disposeEventBridge(): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
  }

  private dispatch(msg: IncomingMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
