import type {
  MessageType,
  MessagePayload,
  MessageResult,
  MessageHandler,
  MessageListener,
  MessageContext,
} from '../contracts/messages.js';
import type { Middleware } from './middleware.js';
import type { MessagePolicy } from './bus-policies.js';
import { composeSendChain, composeEmitChain } from './middleware.js';
import { getPolicy, matchesPattern } from './bus-policies.js';
import { BackpressureError } from './errors.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('message-bus');

let instance: MessageBus | null = null;

export function initMessageBus(): MessageBus {
  instance = new MessageBus();
  return instance;
}

export function getMessageBus(): MessageBus {
  if (!instance) throw new Error('MessageBus not initialized');
  return instance;
}

type PatternListener = {
  pattern: string;
  listener: (type: string, payload: unknown) => void;
};

export class MessageBus {
  private handlers = new Map<string, MessageHandler<any>>();
  private listeners = new Map<string, Set<MessageListener<any>>>();
  private patternListeners: PatternListener[] = [];
  private middlewares: Middleware[] = [];
  private draining = false;
  private inFlightCount = 0;
  private drainResolvers: Array<() => void> = [];
  private pendingByType = new Map<string, number>();

  private sendChain: ReturnType<typeof composeSendChain> | null = null;
  private emitChain: ReturnType<typeof composeEmitChain> | null = null;

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
    this.rebuildChains();
  }

  private rebuildChains(): void {
    this.sendChain = null;
    this.emitChain = null;
  }

  private getSendChain() {
    if (!this.sendChain) {
      this.sendChain = composeSendChain(
        this.middlewares,
        (type, payload, ctx) => this.executeSend(type as MessageType, payload, ctx),
      );
    }
    return this.sendChain;
  }

  private getEmitChain() {
    if (!this.emitChain) {
      this.emitChain = composeEmitChain(
        this.middlewares,
        (type, payload) => this.executeEmit(type as MessageType, payload),
      );
    }
    return this.emitChain;
  }

  handle<T extends MessageType>(type: T, handler: MessageHandler<T>): void {
    if (this.handlers.has(type)) {
      logger.warn({ type }, 'Overwriting existing handler');
    }
    this.handlers.set(type, handler);
  }

  on<T extends MessageType>(type: T, listener: MessageListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    return () => this.off(type, listener);
  }

  once<T extends MessageType>(type: T, listener: MessageListener<T>): () => void {
    const wrapper: MessageListener<T> = (payload) => {
      this.off(type, wrapper);
      listener(payload);
    };
    return this.on(type, wrapper);
  }

  off<T extends MessageType>(type: T, listener: MessageListener<T>): void {
    this.listeners.get(type)?.delete(listener);
  }

  onPattern(pattern: string, listener: (type: string, payload: unknown) => void): () => void {
    const entry: PatternListener = { pattern, listener };
    this.patternListeners.push(entry);
    return () => {
      const idx = this.patternListeners.indexOf(entry);
      if (idx >= 0) this.patternListeners.splice(idx, 1);
    };
  }

  async send<T extends MessageType>(
    type: T,
    payload: MessagePayload<T>,
    ctx?: MessageContext,
  ): Promise<MessageResult<T>> {
    if (this.draining) {
      throw new Error(`MessageBus is draining, rejecting send: ${type}`);
    }
    const chain = this.getSendChain();
    return chain(type, payload, ctx ?? {}) as Promise<MessageResult<T>>;
  }

  emit<T extends MessageType>(type: T, payload: MessagePayload<T>): void {
    const chain = this.getEmitChain();
    chain(type, payload);
  }

  private async executeSend(type: MessageType, payload: unknown, ctx: MessageContext): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for message type: ${type}`);
    }

    const policy = getPolicy(type);
    const timeoutMs = policy.timeoutMs ?? 30_000;
    const maxAttempts = (policy.retryCount ?? 0) + 1;

    if (policy.maxPending !== undefined) {
      const current = this.pendingByType.get(type) ?? 0;
      if (current >= policy.maxPending) {
        throw new BackpressureError(`maxPending (${policy.maxPending}) exceeded for ${type}`, type);
      }
      this.pendingByType.set(type, current + 1);
    }

    let lastError: Error | undefined;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this.inFlightCount++;
        const timeout = this.createTimeout(timeoutMs, type);
        try {
          const result = await Promise.race([
            handler(payload, ctx),
            timeout.promise,
          ]);
          timeout.cancel();
          return result;
        } catch (err) {
          timeout.cancel();
          lastError = err as Error;
          if (!this.isRetryable(err) || attempt >= maxAttempts - 1) {
            throw err;
          }
          logger.debug({ type, attempt, maxAttempts }, 'Retrying send');
          const delay = this.computeDelay(attempt, policy);
          await this.sleep(delay);
        } finally {
          this.inFlightCount--;
          if (this.draining && this.inFlightCount === 0) {
            for (const resolve of this.drainResolvers) resolve();
            this.drainResolvers = [];
          }
        }
      }
      throw lastError!;
    } finally {
      if (policy.maxPending !== undefined) {
        const count = (this.pendingByType.get(type) ?? 1) - 1;
        if (count <= 0) this.pendingByType.delete(type);
        else this.pendingByType.set(type, count);
      }
    }
  }

  private executeEmit(type: MessageType, payload: unknown): void {
    const set = this.listeners.get(type);
    if (set) {
      for (const fn of set) {
        try {
          fn(payload);
        } catch (err) {
          logger.error({ err, type }, 'MessageBus listener error');
        }
      }
    }

    for (const { pattern, listener } of this.patternListeners) {
      if (matchesPattern(type, pattern)) {
        try {
          listener(type, payload);
        } catch (err) {
          logger.error({ err, type, pattern }, 'MessageBus pattern listener error');
        }
      }
    }
  }

  private createTimeout(ms: number, type: MessageType): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    let rejectFn: (err: Error) => void;
    const promise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      timer = setTimeout(() => {
        reject(new Error(`MessageBus send timeout (${ms}ms): ${type}`));
      }, ms);
      timer.unref();
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        promise.catch(() => {});
      },
    };
  }

  async drain(timeoutMs = 5_000): Promise<void> {
    this.draining = true;
    if (this.inFlightCount === 0) return;

    await Promise.race([
      new Promise<void>((resolve) => {
        this.drainResolvers.push(resolve);
      }),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref();
      }),
    ]);
  }

  isDraining(): boolean {
    return this.draining;
  }

  hasHandler(type: MessageType): boolean {
    return this.handlers.has(type);
  }

  // R6-7: 删除 listenerCount() 探测孔（dead code — 无 caller）。

  removeAll(): void {
    this.handlers.clear();
    this.listeners.clear();
    this.patternListeners = [];
    this.draining = false;
    this.inFlightCount = 0;
    this.drainResolvers = [];
    this.pendingByType.clear();
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof Error) {
      if (err.message.includes('timeout')) return true;
      if ('retryable' in err && (err as Record<string, unknown>).retryable === true) return true;
    }
    return false;
  }

  private computeDelay(attempt: number, policy: MessagePolicy): number {
    const baseMs = 500;
    const maxMs = 10_000;
    const backoff = policy.retryBackoff ?? 'exponential';

    let raw: number;
    switch (backoff) {
      case 'exponential':
        raw = baseMs * 2 ** attempt;
        break;
      case 'linear':
        raw = baseMs * (attempt + 1);
        break;
      case 'fixed':
        raw = baseMs;
        break;
    }

    const jitter = raw * (0.8 + Math.random() * 0.4);
    return Math.min(jitter, maxMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });
  }
}
