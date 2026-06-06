import type { ChildProcess } from 'node:child_process';
import type { IpcMessage, IpcMessageType } from './types.js';
import type { MessageBus } from './message-bus.js';
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
  private journal: import('./ipc-journal.js').IpcJournal | null = null;

  constructor(
    private child: ChildProcess,
    private identity: string,
    options?: { journal?: import('./ipc-journal.js').IpcJournal },
  ) {
    if (options?.journal) this.journal = options.journal;
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
      };

      if (traceCtx) {
        traceStore.run(traceCtx, run);
      } else {
        run();
      }
    });
  }

  /**
   * 注入 journal（用于 agent 重启后由 AgentManager 注入）。
   * 主要给 IpcChildChannel 路径使用（agent 侧没有构造时拿到 journal）。
   */
  setJournal(journal: import('./ipc-journal.js').IpcJournal): void {
    this.journal = journal;
  }

  /**
   * 共享 send 内部逻辑：record → child IPC → markSent / markFailed。
   * 两侧 channel 复用，行为一致。
   */
  private writeOrFail<T>(msg: IpcMessage<T>, type: IpcMessageType, sender: (m: IpcMessage<T>) => boolean): boolean {
    if (this.journal?.shouldJournal(type)) {
      this.journal.record(msg as unknown as IpcMessage);
    }
    try {
      const ok = sender(msg);
      if (ok && this.journal?.shouldJournal(type)) {
        this.journal.markSent(msg.id);
      } else if (!ok && this.journal?.shouldJournal(type)) {
        this.journal.markFailed(msg.id);
      }
      return ok;
    } catch (err) {
      if (this.journal?.shouldJournal(type)) {
        try { this.journal.markFailed(msg.id); } catch {}
      }
      logger.debug({ err, msgId: msg.id, type }, 'IPC send 失败');
      return false;
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
    return this.writeOrFail(msg, type, (m) => this.child.send(m as IpcMessage));
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
  /**
   * IPC journal（agent 侧）。Agent 进程启动时由 ResidentAgent / ModuleAgent
   * 通过 setJournal 注入；为空时等同于未启用 journal（普通 send 走 process.send）。
   */
  private journal: import('./ipc-journal.js').IpcJournal | null = null;

  constructor(
    private identity: string,
    options?: { journal?: import('./ipc-journal.js').IpcJournal },
  ) {
    if (options?.journal) this.journal = options.journal;
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

  /**
   * 注入 journal（agent 启动时由宿主调用）。agent 侧在 db 已初始化后调用。
   */
  setJournal(journal: import('./ipc-journal.js').IpcJournal): void {
    this.journal = journal;
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
    // agent→core 方向也必须 journal：保证 agent 崩溃后未投递的消息能由 core 端 replay
    if (this.journal?.shouldJournal(type)) {
      this.journal.record(msg as unknown as IpcMessage);
    }
    try {
      // process.send 返回 boolean（false 表示 channel 已关闭）
      const ok = process.send ? process.send(msg) : false;
      if (ok) {
        this.journal?.markSent(msg.id);
      } else {
        this.journal?.markFailed(msg.id);
      }
    } catch (err) {
      logger.debug({ err, msgId: msg.id, type }, 'IpcChildChannel.send 失败');
      this.journal?.markFailed(msg.id);
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
