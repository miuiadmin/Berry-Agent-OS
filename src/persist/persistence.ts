/**
 * L1 persist — Persistence 门面：组合根面对的唯一入口。
 *
 * 组装 Store（物理层）+ WriteBehind（批量链）+ Session（逻辑层）三件：
 * - createSession：新建会话并接线活体通知 → write-behind；
 * - forkSession：fork 子会话并接线（种子物理复制由 write-behind 首队时承担）；
 * - loadSession：loadStored 恢复（撕裂尾修复 + 血缘 header 还原）并续接线；
 * - flush：屏障（危险操作前/关停前先落盘）；
 * - close：优雅关停（flush 屏障 → 关库）。
 * M1 的 incarnation 即本 Persistence 实例 UUID。
 */

import { randomUUID } from 'node:crypto';
import type { AppError } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import { Session } from '../session/session.js';
import type { SessionOptions } from '../session/session.js';
import { openStore } from './store.js';
import type { Store, StoreOptions } from './store.js';
import { WriteBehind } from './write-behind.js';
import type { WriteBehindOptions } from './write-behind.js';

/** 门面参数（Store 与 WriteBehind 参数合并 + 活体镜像回调） */
export type PersistenceOptions = StoreOptions &
  WriteBehindOptions & {
    /**
     * 会话活体事件镜像（契约篇 §2.2 session/event 行的 persist 半边）：
     * 每个 SessionEvent 入 write-behind 队列**之后**同步回调——组合根用它接
     * ctx.emit('session/event', { sessionId, event })。
     * 顺序纪律：先 enqueue（durable 优先）后镜像（观察侧）；观察者异常隔离
     * 由 ctx.emit 提供，本回调自身不应抛错。
     */
    onLiveEvent?: (sessionId: string, event: SessionEvent) => void;
  };

export class Persistence {
  readonly store: Store;
  readonly writeBehind: WriteBehind;
  /** 本进程生命周期 UUID（revision 复位边界；跨进程变更检测的一半） */
  readonly incarnation: string;
  /** createSession 附带的会话元数据（cwd/profile/app——sessions 表登记素材） */
  private readonly sessionMeta = new Map<string, { cwd?: string; profile?: string; app?: string }>();
  /** 原始打开参数（活体镜像回调在其中） */
  private readonly options: PersistenceOptions;

  private constructor(store: Store, options: PersistenceOptions) {
    this.store = store;
    this.options = options;
    this.incarnation = randomUUID();
    this.writeBehind = new WriteBehind(store, this.incarnation, options);
  }

  /**
   * 会话活体事件统一落点（三处接线共用）：write-behind 入队（durable 优先）
   * → 组合根镜像通知（session/event 活体镜像，观察侧）。
   */
  private sink(
    session: Session,
    event: SessionEvent,
    meta: { cwd?: string; profile?: string; app?: string } | undefined,
  ): void {
    this.writeBehind.enqueue(session, event, meta);
    this.options.onLiveEvent?.(session.header.sessionId, event);
  }

  /** 打开（或初始化）持久层（版本门禁失败响亮拒绝） */
  static open(options: PersistenceOptions): Persistence {
    return new Persistence(openStore(options), options);
  }

  /**
   * 新建会话并接线持久化：Session 的活体事件直达 write-behind 队列。
   * @param opts Session 构造参数 + cwd/profile/app（会话登记元数据，落 sessions 表；
   *   app = 应用域打标——默认启动即 'chat'，契约篇 §5.4 冷读裁决）
   */
  createSession(opts: SessionOptions & { cwd?: string; profile?: string; app?: string } = {}): Session {
    const { cwd, profile, app, ...sessionOpts } = opts;
    // 闭包经变量引用自身：首个事件总在构造返回之后才发生，赋值先于首次 emit
    let session!: Session;
    session = new Session({
      ...sessionOpts,
      emit: (event) => this.sink(session, event, this.sessionMeta.get(session.header.sessionId)),
    });
    if (cwd !== undefined || profile !== undefined || app !== undefined) {
      this.sessionMeta.set(session.header.sessionId, { cwd, profile, app });
    }
    return session;
  }

  /**
   * fork 出子会话并接线持久化（Session.fork 默认不带 emit——接线责任在此）。
   * 子会话种子事件（seq < seedLength）首次入队时由 write-behind 物理复制到子会话名下。
   * @param opts Session.fork 参数 + cwd/profile/app（子会话登记元数据，缺省继承父会话——
   *   **app 血缘继承**：delegation fork 归属随创建时血缘落定，不运行时推断）
   */
  forkSession(
    parent: Session,
    opts: Parameters<Session['fork']>[0] & { cwd?: string; profile?: string; app?: string } = {},
  ): Session {
    const { cwd, profile, app, ...forkOpts } = opts;
    const inherited = this.sessionMeta.get(parent.header.sessionId);
    // 同 createSession 的自引用手法：子会话首事件总在构造返回之后
    let child!: Session;
    child = parent.fork({
      ...forkOpts,
      emit: (event) =>
        this.sink(child, event, {
          cwd: cwd ?? inherited?.cwd,
          profile: profile ?? inherited?.profile,
          app: app ?? inherited?.app,
        }),
    });
    return child;
  }

  /**
   * 恢复会话（loadStored）：读物理事件（撕裂尾截断在此发生）+ 还原血缘 header，
   * 重建 Session 并续接线（后续 append 走同一 write-behind）。
   * 恢复协议的语义半边（interruptedTurnClosers + commitRepair）由调用方驱动：
   * `const s = loadSession(id); s.recoverFromInterruption(); await flush(id)`。
   * @returns 会话不存在时 undefined
   */
  loadSession(sessionId: string): Session | undefined {
    const row = this.store.sessionRow(sessionId);
    if (!row) {
      return undefined;
    }
    const events = this.store.loadEvents(sessionId);
    let session!: Session;
    session = new Session({
      sessionId,
      seed: events,
      // seedLength 以 sessions 表血缘为准（种子数组可能含 fork 活区回读事件）
      seedLength: row.seed_length ?? events.length,
      origin: row.origin as SessionOptions['origin'],
      parentSession: row.parent_session ?? undefined,
      delegationDepth: row.delegation_depth,
      emit: (event) => this.sink(session, event, this.sessionMeta.get(sessionId)),
    });
    if (row.cwd !== null || row.profile !== null || row.app !== null) {
      this.sessionMeta.set(sessionId, {
        cwd: row.cwd ?? undefined,
        profile: row.profile ?? undefined,
        app: row.app ?? undefined,
      });
    }
    return session;
  }

  /** 屏障：某会话（缺省全部）待写批次落盘完成（失败 reject，批次保留） */
  flush(sessionId?: string): Promise<void> {
    return this.writeBehind.flush(sessionId);
  }

  /**
   * 某工作区最新会话 id（TUI 启动续接策略取数；无匹配 undefined）。
   * 应用域过滤透传 store（chat 域含 NULL 存量回退 / 第三方严格域——契约篇 §5.4）。
   */
  latestSessionId(cwd: string, domain?: { app: string; includeNullApp?: boolean }): string | undefined {
    return this.store.latestSessionId(cwd, domain);
  }

  /** revision 指纹（storeIdentity:incarnation:revision——投影缓存跨进程变更检测） */
  revisionString(sessionId: string): string {
    return this.store.revisionString(sessionId, this.incarnation);
  }

  /** 优雅关停：屏障刷完 → 关库；失败上抛由关停序列定夺（§1.3 优雅退出序列的存储半边） */
  async close(): Promise<void> {
    await this.writeBehind.close();
    this.store.close();
  }
}
