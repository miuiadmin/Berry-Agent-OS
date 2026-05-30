export interface Attachment {
  type: 'file' | 'image' | 'audio' | 'video';
  url?: string;
  path?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

export interface IncomingMessage {
  channelId: string;
  channelType: ChannelType;
  userId: string;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  text: string;
  format?: 'text' | 'markdown' | 'html';
  attachments?: Attachment[];
  replyTo?: string;
}

export type ChannelType = 'cli' | 'telegram' | 'discord' | 'http';

export type MessageHandler = (msg: IncomingMessage) => void;

export interface MessageChannel {
  readonly type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(userId: string, message: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
