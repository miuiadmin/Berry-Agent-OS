import type { MessageChannel, MessageHandler, IncomingMessage, OutgoingMessage } from './contract.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('channel-manager');

export class ChannelManager {
  private channels = new Map<string, MessageChannel>();
  private handlers: MessageHandler[] = [];

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

  private dispatch(msg: IncomingMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
