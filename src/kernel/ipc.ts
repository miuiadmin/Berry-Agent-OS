import type { ChildProcess } from 'node:child_process';
import type { IpcMessage, IpcMessageType } from './types.js';
import type { MessageBus } from './message-bus.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { TimeoutError } from './errors.js';
import { injectTraceIntoIpc, extractTraceFromIpc, traceStore } from '../observability/trace-context.js';
import { computeBackoff, type BackpressureMonitor, type DeadLetterQueue } from './ipc-resilience.js';

const logger = getLogger('ipc');

// ── IPC 中枢 trace（上帝视角）─────────────────────────────────────────────
// IpcChannel 是 kernel ↔ agent 子进程通信的唯一通道。在入站（child.on message）与
// 出站（writeOrFail）各插一个 tap = 覆盖全部 agent 通信，回答「agent 报了什么 /
// kernel 派了什么」。grep `ipc>` 看全部。
// task.telemetry 的 per-token 增量（text/reasoning delta，agent 逐 token 上报）按 1/50 节流。
const IPC_FP_KEYS = [
  'taskId', 'toolName', 'callId', 'durationMs', 'kind', 'isError', 'summary',
  'reason', 'ok', 'agentName', 'inputTokens', 'outputTokens', 'intent', 'targetAgent',
] as const;
let _ipcTextDeltaN = 0;
let _ipcReasoningDeltaN = 0;
/** 入站 IPC 消息指纹（kernel 侧收到 agent 的消息） */
function traceIpcRecv(msg: IpcMessage): void {
  const type = msg.type;
  const payload = msg.payload as Record<string, unknown> | undefined;
  // task.telemetry 的 per-token 增量节流
  if (type === 'task.telemetry') {
    const kind = payload?.kind;
    if (kind === 'text_delta') { _ipcTextDeltaN++; if (_ipcTextDeltaN % 50 === 1) logger.debug({ type, from: msg.from, kind, n: _ipcTextDeltaN }, 'ipc> recv(1/50 节流)'); return; }
    if (kind === 'reasoning_delta') { _ipcReasoningDeltaN++; if (_ipcReasoningDeltaN % 50 === 1) logger.debug({ type, from: msg.from, kind, n: _ipcReasoningDeltaN }, 'ipc> recv(1/50 节流)'); return; }
  }
  const fp: Record<string, unknown> = { type, from: msg.from };
  if (payload && typeof payload === 'object') {
    for (const k of IPC_FP_KEYS) if (k in payload) fp[k] = payload[k];
    if ('durationMs' in payload) fp.hasDurationMs = payload.durationMs != null;
  }
  logger.debug(fp, 'ipc> recv');
}

type MessageHandler = (msg: IpcMessage) => void;

export class IpcChannel {
  private handlers = new Map<IpcMessageType, MessageHandler[]>();
  private pendingRequests = new Map<string, {
    resolve: (msg: IpcMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private journal: import('./ipc-journal.js').IpcJournal | null = null;
  // C2 修复：注入 IPC 弹性机制（背压监控 + 死信队列）
  // 这些是可选依赖，未注入时退化为现有行为
  private backpressure: BackpressureMonitor | null = null;
  private deadLetterQueue: DeadLetterQueue | null = null;

  constructor(
    private child: ChildProcess,
    private identity: string,
    options?: { journal?: import('./ipc-journal.js').IpcJournal },
  ) {
    if (options?.journal) this.journal = options.journal;
    child.on('message', (raw: unknown) => {
      const msg = raw as IpcMessage;
      // 上帝视角：所有 agent→kernel 入站 IPC 在此到达（见 traceIpcRecv）
      traceIpcRecv(msg);
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
   * C2 修复：注入 IPC 弹性机制
   * - backpressure: 背压监控，超过阈值时拒绝新消息（返回 false）
   * - deadLetterQueue: 永久失败时入死信队列而非静默丢弃
   */
  setResilience(deps: {
    backpressure?: BackpressureMonitor;
    deadLetterQueue?: DeadLetterQueue;
  }): void {
    if (deps.backpressure) this.backpressure = deps.backpressure;
    if (deps.deadLetterQueue) this.deadLetterQueue = deps.deadLetterQueue;
  }

  /**
   * 共享 send 内部逻辑：record → child IPC → markSent / markFailed。
   * 两侧 channel 复用，行为一致。
   */
  private writeOrFail<T>(msg: IpcMessage<T>, type: IpcMessageType, sender: (m: IpcMessage<T>) => boolean): boolean {
    // 上帝视角：所有 kernel→agent 出站 IPC 经此（send / request / emit-to-child 共用）
    logger.debug({ type, to: (msg as IpcMessage).to, from: (msg as IpcMessage).from }, 'ipc> send');
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
    // C2 修复：发送前检查背压。超载时拒绝并入死信队列（不再静默丢弃）
    if (this.backpressure && !this.backpressure.increment(this.identity)) {
      logger.warn({ agent: this.identity, type }, 'IPC 背压：消息被拒绝');
      // 注意：消息尚未构造，无法入死信。死信捕获在 writeOrFail 失败路径处理
      return false;
    }
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
    const ok = this.writeOrFail(msg, type, (m) => this.child.send(m as IpcMessage));
    if (this.backpressure) this.backpressure.decrement(this.identity);
    // C2 修复：永久失败时入死信队列
    if (!ok && this.deadLetterQueue) {
      try {
        this.deadLetterQueue.enqueue(msg, 'send-failed', 1);
      } catch (err) {
        logger.debug({ err, msgId: msg.id }, '死信入队失败');
      }
    }
    return ok;
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
      // C3 修复：走 journal 记录路径，确保 request 消息可被崩溃后重放
      this.writeOrFail(msg, type, (m) => this.child.send(m as unknown as IpcMessage));
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
      // C3 修复：与 send() 一致，先 journal.record 再 process.send，失败时 markFailed
      if (this.journal?.shouldJournal(type)) {
        this.journal.record(msg);
      }
      try {
        const ok = process.send ? process.send(msg) : false;
        if (ok && this.journal?.shouldJournal(type)) {
          this.journal.markSent(msg.id);
        } else if (!ok && this.journal?.shouldJournal(type)) {
          this.journal.markFailed(msg.id);
        }
      } catch (err) {
        if (this.journal?.shouldJournal(type)) {
          try { this.journal.markFailed(msg.id); } catch { /* 二次失败吞掉 */ }
        }
        throw err;
      }
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
