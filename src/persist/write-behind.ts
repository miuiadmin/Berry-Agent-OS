/**
 * L1 persist — write-behind 写入链协调器（会话篇 §6 写入链 1-3 步）。
 *
 * Session.append 落内存后经活体通知到达此处；按批量窗口（默认 200ms）聚合，
 * per-session promise chain 串行化（单会话严格有序、跨会话并行），批量经
 * appendCore 落盘。失败保留批次并暂停自动重试（响亮失败，不静默丢批）——
 * 显式 flush()（屏障/关停路径）始终重试。
 */

import { AppError, PERSIST_BATCH_WRITE_FAILED } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import type { Session } from '../session/session.js';
import type { SessionRegistration, Store } from './store.js';

/** write-behind 参数 */
export interface WriteBehindOptions {
  /** 批量窗口毫秒（默认 200，拍板值；可配置） */
  windowMs?: number;
  /** 失败后的错误上报通道（可选；响亮失败的可观测出口） */
  onError?: (error: AppError) => void;
}

/**
 * write-behind 协调器。一个 Persistence 持有一个；持有 Store 与本进程 incarnation。
 * 两类 promise 严格区分：
 * - 串行链（chains）：吞错的 per-session 排队——失败不断链，后续批次仍能续接重试；
 * - 屏障 promise（drainSession 返回值）：真结果，flush() 以此感知失败并 reject。
 */
export class WriteBehind {
  private readonly store: Store;
  private readonly incarnation: string;
  private readonly windowMs: number;
  private readonly onError?: (error: AppError) => void;
  /** 待落盘批次（sessionId → 有序事件队列；失败后保留即「保留批次」） */
  private readonly pending = new Map<string, SessionEvent[]>();
  /** 会话登记素材表（首事件时填充；sessions 行以首次登记为准） */
  private readonly registrations = new Map<string, SessionRegistration>();
  /** per-session 串行链（永不 reject——排队机制，不承担错误传播） */
  private readonly chains = new Map<string, Promise<void>>();
  /** 窗口定时器（单实例轮转全部会话；unref 不阻塞进程退出） */
  private timer: NodeJS.Timeout | null = null;
  /** 失败后暂停自动重试标记（flush() 显式调用会清除并重试） */
  private paused = false;

  constructor(store: Store, incarnation: string, options: WriteBehindOptions = {}) {
    this.store = store;
    this.incarnation = incarnation;
    this.windowMs = options.windowMs ?? 200;
    this.onError = options.onError;
  }

  /**
   * 收活体事件入待写队列（Session 的 emit 回调经 Persistence 接到这里）。
   * 未登记会话按需登记（header + 组合根注入的 cwd/profile 元数据）。
   * fork/delegation 子会话的种子事件（seq 0..seedLength-1）只存在于内存共享引用中，
   * 首次入队时若库内尚无本会话事件，把种子物理复制到子会话名下——子会话事件流
   * 因此自包含且 seq 连续（会话篇 §5：消费者读侧 events.slice(seedLength)）。
   */
  enqueue(session: Session, event: SessionEvent, meta?: { cwd?: string; profile?: string; app?: string }): void {
    const sessionId = session.header.sessionId;
    const queue = this.pending.get(sessionId);
    if (queue) {
      queue.push(event);
    } else {
      const seedLength = session.header.seedLength;
      const needsSeedCopy = seedLength > 0 && this.store.countEvents(sessionId) === 0;
      // 种子（若有且未落盘）在前，活事件随后——批内即保持 seq 连续
      const initial = needsSeedCopy ? [...session.events.slice(0, seedLength)] : [];
      initial.push(event);
      this.pending.set(sessionId, initial);
      this.registrations.set(sessionId, registrationOf(session, meta));
    }
    if (!this.paused) {
      this.scheduleFlush();
    }
  }

  /** 定时触发一次屏障式批量落盘（窗口聚合） */
  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      // 定时路径的失败已由 writeBatch 上报（onError + 暂停）；此处吞掉防 unhandled rejection
      this.flush().catch(() => undefined);
    }, this.windowMs);
    this.timer.unref(); // 不阻塞进程退出（优雅关停走显式 close → flush）
  }

  /**
   * 屏障（会话篇 §4.3）：确保某会话（缺省 = 全部）待写批次已落盘。
   * 危险操作前与关停前调用；失败时 reject（批次保留，下次 flush 重试）。
   */
  flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      return this.drainSession(sessionId);
    }
    const attempted: Array<Promise<void>> = [];
    for (const id of [...this.pending.keys()]) {
      attempted.push(this.drainSession(id));
    }
    return attempted.length > 0 ? Promise.all(attempted).then(() => undefined) : Promise.resolve();
  }

  /**
   * 把单会话待写队列灌入其串行链（链尾追加，天然有序）。
   * @returns 屏障 promise：本批的真实结果（失败 reject；串行链自身永不 reject）
   */
  private drainSession(sessionId: string): Promise<void> {
    const queue = this.pending.get(sessionId);
    if (!queue || queue.length === 0) {
      return Promise.resolve();
    }
    this.pending.delete(sessionId);
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.writeBatch(sessionId, queue));
    // 串行链吞错续命：失败不断链，显式 flush 的重试批仍排在链上正确位置之后
    this.chains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** 实际写批：失败 = 保留批次 + 暂停自动重试 + 响亮上报 */
  private async writeBatch(sessionId: string, batch: SessionEvent[]): Promise<void> {
    const reg = this.registrations.get(sessionId)!;
    try {
      this.store.appendCore(reg, batch, this.incarnation);
    } catch (cause) {
      // 保留批次（放回队首）+ 暂停自动重试：显式 flush 才会再试
      this.paused = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const queue = this.pending.get(sessionId);
      if (queue) {
        queue.unshift(...batch);
      } else {
        this.pending.set(sessionId, batch);
      }
      const err = new AppError(
        PERSIST_BATCH_WRITE_FAILED,
        `批量落盘失败（会话 ${sessionId}，${batch.length} 事件已保留待重试）`,
        { cause },
      );
      this.onError?.(err);
      throw err;
    }
  }

  /** 是否暂停中（诊断用） */
  get isPaused(): boolean {
    return this.paused;
  }

  /** 关停屏障：即使 paused 也做最后一次落盘尝试（关停是最后机会；失败向上抛由关停序列定夺） */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.paused = false;
    await this.flush();
  }

  /** 把全部待写队列灌入对应 chain */
  private drainAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      void this.drainSession(sessionId);
    }
  }
}

/** Session → 首刷登记素材 */
function registrationOf(
  session: Session,
  meta?: { cwd?: string; profile?: string; app?: string },
): SessionRegistration {
  return {
    sessionId: session.header.sessionId,
    origin: session.header.origin,
    parentSession: session.header.parentSession,
    seedLength: session.header.seedLength,
    delegationDepth: session.header.delegationDepth,
    cwd: meta?.cwd,
    profile: meta?.profile,
    app: meta?.app,
  };
}
