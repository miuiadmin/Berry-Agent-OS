import type { Transport } from './transport.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('stream-channel');

export interface StreamChannelOptions {
  connectionId: string;
  transport: Transport;
  throttleMs?: number;
  maxBufferSize?: number;
}

export interface StreamChannel {
  readonly id: string;
  readonly connectionId: string;
  write(chunk: unknown): boolean;
  flush(): Promise<void>;
  end(finalChunk?: unknown): void;
  onDrain(handler: () => void): void;
  onClose(handler: (reason?: string) => void): void;
  isClosed(): boolean;
}

export function createStreamChannel(options: StreamChannelOptions): StreamChannel {
  const { connectionId, transport, throttleMs = 50, maxBufferSize = 200 } = options;
  const id = genId('stream');

  let buffer: unknown[] = [];
  let closed = false;
  let inFlightPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainHandlers: Array<() => void> = [];
  let closeHandlers: Array<(reason?: string) => void> = [];
  let lastSentAt = 0;
  let wasBackpressured = false;

  const doFlush = (): Promise<void> => {
    if (buffer.length === 0) return Promise.resolve();

    const batch = buffer;
    buffer = [];

    const writable = transport.isWritable(connectionId);
    if (!writable) {
      buffer = batch.concat(buffer);
      return Promise.resolve();
    }

    const ok = transport.writeBatch(connectionId, batch);
    if (!ok) {
      logger.debug({ id, connectionId, batchSize: batch.length }, 'Write failed, buffering');
      buffer = batch.concat(buffer);
    } else {
      lastSentAt = Date.now();
      if (wasBackpressured && buffer.length < maxBufferSize) {
        wasBackpressured = false;
        for (const handler of drainHandlers) {
          try { handler(); } catch {}
        }
      }
    }
    return Promise.resolve();
  };

  const scheduleFlush = () => {
    if (timer || closed) return;
    const elapsed = Date.now() - lastSentAt;
    const delay = Math.max(0, throttleMs - elapsed);
    timer = setTimeout(() => {
      timer = undefined;
      doFlush().catch((err) => {
        logger.error({ err, id }, 'Background flush error');
      });
      if (buffer.length > 0) scheduleFlush();
    }, delay);
  };

  return {
    id,
    connectionId,

    write(chunk: unknown): boolean {
      if (closed) return false;
      buffer.push(chunk);

      if (buffer.length >= maxBufferSize) {
        wasBackpressured = true;
        doFlush();
        return false;
      }

      scheduleFlush();
      return true;
    },

    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await doFlush();
      if (inFlightPromise) await inFlightPromise;
    },

    end(finalChunk?: unknown): void {
      if (closed) return;
      if (finalChunk !== undefined) buffer.push(finalChunk);
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      doFlush();
      for (const handler of closeHandlers) {
        try { handler(); } catch {}
      }
    },

    onDrain(handler: () => void): void {
      drainHandlers.push(handler);
    },

    onClose(handler: (reason?: string) => void): void {
      closeHandlers.push(handler);
    },

    isClosed(): boolean {
      return closed;
    },
  };
}
