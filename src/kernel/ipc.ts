import type { ChildProcess } from 'node:child_process';
import type { IpcMessage, IpcMessageType } from './types.js';
import type { MessageBus } from './message-bus.js';
import type { IpcBusMessageType } from '../contracts/messages.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { TimeoutError } from './errors.js';
import { injectTraceIntoIpc, extractTraceFromIpc, traceStore } from '../observability/trace-context.js';
import { computeBackoff } from './ipc-resilience.js';

const logger = getLogger('ipc');

type MessageHandler = (msg: IpcMessage) => void;

export class IpcChannel {
  private handlers = new Map<IpcMessageType, MessageHandler[]>();
  private pendingRequests = new Map<string, {
    resolve: (msg: IpcMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private messageBus: MessageBus | null = null;

  constructor(
    private child: ChildProcess,
    private identity: string,
  ) {
    child.on('message', (raw: unknown) => {
      const msg = raw as IpcMessage;
      const pending = this.pendingRequests.get(msg.correlationId ?? '');
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.correlationId!);
        pending.resolve(msg);
        return;
      }

      const traceCtx = extractTraceFromIpc(msg);
      const run = () => {
        const list = this.handlers.get(msg.type);
        if (list) {
          for (const handler of list) handler(msg);
        }
        this.forwardToBus(msg);
      };

      if (traceCtx) {
        traceStore.run(traceCtx, run);
      } else {
        run();
      }
    });
  }

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
  }

  private forwardToBus(msg: IpcMessage): void {
    if (!this.messageBus) return;
    const busType = `ipc:${msg.type}` as IpcBusMessageType;
    if (this.messageBus.listenerCount(busType) > 0) {
      this.messageBus.emit(busType, msg.payload as any);
    }
  }

  send<T>(type: IpcMessageType, to: string, payload: T, correlationId?: string): boolean {
    if (!this.child.connected) return false;
    let msg: IpcMessage<T> = {
      id: genId('msg'),
      correlationId,
      type,
      from: this.identity,
      to,
      payload,
      timestamp: Date.now(),
    };
    msg = injectTraceIntoIpc(msg);
    try {
      this.child.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  async request<T>(type: IpcMessageType, to: string, payload: T, timeoutMs = 30000): Promise<IpcMessage> {
    const t0 = Date.now();
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this._doRequest(type, to, payload, timeoutMs);
        metrics.histogram('ipc_request_duration_ms').observe(Date.now() - t0, { type, to });
        return result;
      } catch (err) {
        if (err instanceof TimeoutError && attempt < maxAttempts - 1) {
          const delay = computeBackoff(attempt);
          logger.debug({ type, to, attempt, delay }, 'IPC request timeout, retrying');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        metrics.histogram('ipc_request_duration_ms').observe(Date.now() - t0, { type, to });
        throw err;
      }
    }
    throw new TimeoutError(`IPC request exhausted retries: ${type} to ${to}`, to);
  }

  private _doRequest<T>(type: IpcMessageType, to: string, payload: T, timeoutMs: number): Promise<IpcMessage> {
    return new Promise((resolve, reject) => {
      const id = genId('msg');
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new TimeoutError(`IPC request timeout: ${type} to ${to}`, to));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timer });

      const msg: IpcMessage<T> = {
        id,
        type,
        from: this.identity,
        to,
        payload,
        timestamp: Date.now(),
      };
      this.child.send(msg);
    });
  }

  onMessage(type: IpcMessageType, handler: MessageHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  destroy(): void {
    this.handlers.clear();
    for (const [, { timer }] of this.pendingRequests) {
      clearTimeout(timer);
    }
    this.pendingRequests.clear();
  }
}

export class IpcChildChannel {
  private handlers = new Map<IpcMessageType, MessageHandler[]>();
  private pendingRequests = new Map<string, {
    resolve: (msg: IpcMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private identity: string) {
    process.on('message', (raw: unknown) => {
      const msg = raw as IpcMessage;
      const pending = this.pendingRequests.get(msg.correlationId ?? '');
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.correlationId!);
        pending.resolve(msg);
        return;
      }
      const list = this.handlers.get(msg.type);
      if (list) {
        const traceCtx = extractTraceFromIpc(msg);
        const run = () => { for (const handler of list) handler(msg); };
        if (traceCtx) {
          traceStore.run(traceCtx, run);
        } else {
          run();
        }
      }
    });
  }

  send<T>(type: IpcMessageType, to: string, payload: T, correlationId?: string): void {
    let msg: IpcMessage<T> = {
      id: genId('msg'),
      correlationId,
      type,
      from: this.identity,
      to,
      payload,
      timestamp: Date.now(),
    };
    msg = injectTraceIntoIpc(msg);
    process.send!(msg);
  }

  async request<T>(type: IpcMessageType, to: string, payload: T, timeoutMs = 30000): Promise<IpcMessage> {
    const t0 = Date.now();
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this._doRequest(type, to, payload, timeoutMs);
        metrics.histogram('ipc_request_duration_ms').observe(Date.now() - t0, { type, to });
        return result;
      } catch (err) {
        if (err instanceof TimeoutError && attempt < maxAttempts - 1) {
          const delay = computeBackoff(attempt);
          logger.debug({ type, to, attempt, delay }, 'IPC request timeout, retrying');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        metrics.histogram('ipc_request_duration_ms').observe(Date.now() - t0, { type, to });
        throw err;
      }
    }
    throw new TimeoutError(`IPC request exhausted retries: ${type} to ${to}`, to);
  }

  private _doRequest<T>(type: IpcMessageType, to: string, payload: T, timeoutMs: number): Promise<IpcMessage> {
    return new Promise((resolve, reject) => {
      const id = genId('msg');
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new TimeoutError(`IPC request timeout: ${type} to ${to}`, to));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timer });

      const msg: IpcMessage<T> = {
        id,
        type,
        from: this.identity,
        to,
        payload,
        timestamp: Date.now(),
      };
      process.send!(msg);
    });
  }

  onMessage(type: IpcMessageType, handler: MessageHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  destroy(): void {
    this.handlers.clear();
    for (const [, { timer }] of this.pendingRequests) {
      clearTimeout(timer);
    }
    this.pendingRequests.clear();
  }
}
