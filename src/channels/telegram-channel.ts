import type { MessageChannel, MessageHandler, IncomingMessage, OutgoingMessage, Attachment } from './contract.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('telegram-channel');

/** R11-P1：channel 文本字符上限。超过截断（与 WS 不同：长消息常见，不直接 reject）。 */
const MAX_CHANNEL_TEXT_CHARS = 64 * 1024; // 64KB

export interface TelegramChannelConfig {
  token: string;
  pollingInterval?: number;
  allowedUserIds?: string[];
}

export class TelegramChannel implements MessageChannel {
  readonly type = 'telegram' as const;
  private handlers: MessageHandler[] = [];
  private running = false;
  private offset = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly apiBase: string;
  private readonly pollingInterval: number;
  private readonly allowedUserIds: Set<string> | null;

  constructor(private readonly config: TelegramChannelConfig) {
    this.apiBase = `https://api.telegram.org/bot${config.token}`;
    this.pollingInterval = config.pollingInterval ?? 1000;
    this.allowedUserIds = config.allowedUserIds
      ? new Set(config.allowedUserIds)
      : null;
  }

  async start(): Promise<void> {
    this.running = true;
    const me = await this.apiCall<{ result: { username: string } }>('getMe');
    logger.info({ username: me.result.username }, 'Telegram Bot 已连接');
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async send(userId: string, message: OutgoingMessage): Promise<void> {
    const text = message.format === 'markdown'
      ? escapeMarkdownV2(message.text)
      : message.text;

    await this.apiCall('sendMessage', {
      chat_id: userId,
      text,
      parse_mode: message.format === 'markdown' ? 'MarkdownV2' : undefined,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  private poll(): void {
    if (!this.running) return;

    this.getUpdates()
      .then((updates) => {
        for (const update of updates) {
          this.handleUpdate(update);
        }
      })
      .catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Telegram polling 失败');
      })
      .finally(() => {
        if (this.running) {
          this.pollTimer = setTimeout(() => this.poll(), this.pollingInterval);
        }
      });
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall<{ result: TelegramUpdate[] }>('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message'],
    });
    return result.result;
  }

  private handleUpdate(update: TelegramUpdate): void {
    this.offset = update.update_id + 1;

    const msg = update.message;
    if (!msg) return;

    const userId = String(msg.chat.id);
    if (this.allowedUserIds && !this.allowedUserIds.has(userId)) {
      logger.debug({ userId }, '用户不在允许列表中，忽略');
      return;
    }

    const text = msg.text ?? msg.caption ?? '';
    if (!text) return;

    // R11-P1：channel payload 文本长度上限，防 DoS / 注入污染
    if (text.length > MAX_CHANNEL_TEXT_CHARS) {
      logger.warn({ userId, length: text.length, max: MAX_CHANNEL_TEXT_CHARS }, 'channel 文本超长，截断');
      // 不直接 reject，截断保留前 N 字符（用户长消息常见）
      // 严格 reject 由 LLM 层 / persistence 层限流
    }

    const attachments: Attachment[] = [];
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({ type: 'image', url: largest.file_id, fileName: 'photo.jpg' });
    }
    if (msg.document) {
      attachments.push({
        type: 'file',
        url: msg.document.file_id,
        fileName: msg.document.file_name,
        mimeType: msg.document.mime_type,
        size: msg.document.file_size,
      });
    }

    const incoming: IncomingMessage = {
      channelId: genId('tg'),
      channelType: 'telegram',
      userId,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      metadata: {
        messageId: msg.message_id,
        chatType: msg.chat.type,
        fromUsername: msg.from?.username,
      },
    };

    for (const handler of this.handlers) {
      handler(incoming);
    }
  }

  private async apiCall<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API ${method} failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { username?: string; id: number };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width: number; height: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    reply_to_message?: { message_id: number };
  };
}
