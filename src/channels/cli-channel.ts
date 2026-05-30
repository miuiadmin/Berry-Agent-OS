import type { MessageChannel, MessageHandler, IncomingMessage, OutgoingMessage } from './contract.js';
import type { Socket } from 'node:net';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('cli-channel');

export class CliChannel implements MessageChannel {
  readonly type = 'cli' as const;
  private handlers: MessageHandler[] = [];
  private activeSockets = new Map<string, Socket>();

  start(): Promise<void> {
    logger.info('CLI Channel 就绪');
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.activeSockets.clear();
    return Promise.resolve();
  }

  send(userId: string, message: OutgoingMessage): Promise<void> {
    const socket = this.activeSockets.get(userId);
    if (!socket || socket.destroyed) {
      logger.debug({ userId }, 'CLI send: socket 不可用');
      return Promise.resolve();
    }
    const payload = JSON.stringify({
      type: 'result',
      response: message.text,
      format: message.format ?? 'text',
    });
    socket.write(payload + '\n');
    return Promise.resolve();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  handleSocketMessage(text: string, socket: Socket, sessionId?: string): void {
    const userId = sessionId ?? genId('cli');
    this.activeSockets.set(userId, socket);

    const incoming: IncomingMessage = {
      channelId: genId('msg'),
      channelType: 'cli',
      userId,
      text,
      metadata: { sessionId },
    };

    for (const handler of this.handlers) {
      handler(incoming);
    }
  }

  sendProgress(userId: string, status: string, summary: string): void {
    const socket = this.activeSockets.get(userId);
    if (!socket || socket.destroyed) return;
    const payload = JSON.stringify({ type: 'progress', status, summary });
    socket.write(payload + '\n');
  }
}
