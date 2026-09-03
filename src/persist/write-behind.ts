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
  /**
   * 批落延迟打点（可选；基建大扫 #27——纯测量非执法，装载分区计时同款
   * 先例）：每批成功落盘后回调一次（批大小与耗时毫秒）。消费方自行定级
   * （组合根接 debug 档）；不传 = 零开销。
   */
  onBatchLatency?: (info: { sessionId: string; events: number; ms: number }) => void;
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
  /** 批落延迟打点（#27——每批成功后回调；测量面与执法面分离） */
  private readonly onBatchLatency?: (info: { sessionId: string; events: number; ms: number }) => void;
  /** 待落盘批次（sessionId → 有序事件队列；失败后保留即「保留批次」） */
  private readonly pending = new Map<string, SessionEvent[]>();
  /**
   * 种子会话首队时捕获的种子快照（sessionId → seq 0..seedLength-1 副本；
   * writeBatch 首次写该会话时核对并消费——B8 第十一轮遗漏大扫 20260904-b：
   * enqueue 位于 Session.append 推入内存日志之后〔emitLive 观察者位〕，
   * 路径上任何同步 SQL 抛出都会让该事件永缺席持久化队列〔无重试登记〕，
   * 后续批次建队即留 seq 洞 → 重启 loadEvents 按撕裂尾截断丢活区尾部——
   * 故 enqueue 路径零 SQL，「库内是否已有本会话事件」核对挪到写路径
   * 〔那里已有失败保留 + 暂停重试机器兜底〕）。writeBatch 消费或尾链清理
   * 时删除（键域有界，与 pending/chains 同生命周期纪律）
   */
  private readonly seeds = new Map<string, SessionEvent[]>();
  /** 会话登记素材表（首事件时填充；sessions 行以首次登记为准） */
  private readonly registrations = new Map<string, SessionRegistration>();
  /** per-session 串行链（永不 reject——排队机制，不承担错误传播） */
  private readonly chains = new Map<string, Promise<void>>();
  /** 窗口定时器（单实例轮转全部会话；unref 不阻塞进程退出） */
  private timer: NodeJS.Timeout | null = null;
  /** 失败后暂停自动重试标记（任一批成功即复位——显式 flush / 他会话批次成功都是恢复机会） */
  private paused = false;

  constructor(store: Store, incarnation: string, options: WriteBehindOptions = {}) {
    this.store = store;
    this.incarnation = incarnation;
    this.windowMs = options.windowMs ?? 200;
    this.onError = options.onError;
    this.onBatchLatency = options.onBatchLatency;
  }

  /**
   * 收活体事件入待写队列（Session 的 emit 回调经 Persistence 接到这里）。
   * 未登记会话按需登记（header + 组合根注入的 cwd/profile 元数据）。
   * fork/delegation 子会话的种子事件（seq 0..seedLength-1）只存在于内存共享引用中，
   * 首次入队时若库内尚无本会话事件，把种子物理复制到子会话名下——子会话事件流
   * 因此自包含且 seq 连续（会话篇 §5：消费者读侧 events.slice(seedLength)）。
   */
  enqueue(
    session: Session,
    event: SessionEvent,
    meta?: { cwd?: string; profile?: string; app?: string; importer?: string },
  ): void {
    const sessionId = session.header.sessionId;
    const queue = this.pending.get(sessionId);
    if (queue) {
      queue.push(event);
    } else {
      // 首队捕获种子快照（纯内存零 SQL——B8 第十一轮遗漏大扫 20260904-b）：
      // fork/导入子会话的种子物理复制核对（库内是否已有本会话事件）由
      // writeBatch 写路径承担；修前在此同步查库，SQL 抛出即本事件永缺席
      // 持久化队列（enqueue 位于 Session.append 推日志之后——观察者位异常
      // 上抛不回滚内存日志），后续批次建队留 seq 洞。种子判定语义不变：
      // seedLength = 0 无种子（普通会话）不进簿
      if (session.header.seedLength > 0) {
        this.seeds.set(sessionId, [...session.events.slice(0, session.header.seedLength)]);
      }
      this.pending.set(sessionId, [event]);
      this.registrations.set(sessionId, registrationOf(session, meta));
    }
    if (!this.paused) {
      this.scheduleFlush();
    }
  }

  /**
   * 未落盘种子（若有）：seedLength > 0 且库内尚无本会话事件时返回种子快照，
   * 否则 null。ensureSeeded 显式落库路径专用判定（会话篇 §5.1「seedLength
   * 语义钉死」——导入 seedLength = 种子全长，本判定天然覆盖）。注意 enqueue
   * 首队路径**不在此查库**（B8：同步 SQL 在观察者位抛出即事件蒸发——核对
   * 挪到 writeBatch 写路径，见 seeds 簿注）。
   */
  private pendingSeed(session: Session): SessionEvent[] | null {
    const seedLength = session.header.seedLength;
    if (seedLength === 0) {
      return null;
    }
    return this.store.countEvents(session.header.sessionId) === 0 ? [...session.events.slice(0, seedLength)] : null;
  }

  /**
   * 显式触发种子物理落库（会话篇 §5.1「落库即时性」——导入 = durable 承诺）。
   * fork 的种子复制是惰性的（首队时承担，委派时序保证子会话必有活体事件）；
   * 导入无此预期（用户可能导入后不续聊），故服务面在返回前显式调本方法：
   * 先排空该会话待写队列（若种子已在队列头则随批落盘），仍未落盘则直写——
   * appendCore 唯一物理写口不旁路，sessions 行随首片登记（含 importer 归因）。
   * 失败上抛（导入承诺语义：durable 不可履行时调用方必须看到）。
   */
  async ensureSeeded(
    session: Session,
    meta?: { cwd?: string; profile?: string; app?: string; importer?: string },
  ): Promise<void> {
    const sessionId = session.header.sessionId;
    // 显式路径与 flush 同款：排空队列重试（paused 不阻——显式调用是恢复机会）
    await this.drainSession(sessionId);
    const seed = this.pendingSeed(session);
    if (seed) {
      this.store.appendCore(registrationOf(session, meta), seed, this.incarnation);
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
    const tail = next.catch(() => undefined);
    this.chains.set(sessionId, tail);
    // 尾链结算清理（遗漏大扫 20260902-c #10——会话篇 §6 键域有界性统策）：
    // 链尾结算且仍为尾链（无后继批链上）、且 pending 无残余（失败重试批回队时
    // writeBatch 仍读 registrations——回队发生在 writeBatch catch 块内，微任务序
    // 先于本清理）→ 两键皆死重同删；再入队由 enqueue 首队路径重建。删的是结算
    // 后的死重不是链——串行化语义零变。
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail && !this.pending.has(sessionId)) {
        this.chains.delete(sessionId);
        this.registrations.delete(sessionId);
        this.seeds.delete(sessionId); // 防御位（B8）：种子簿随死重同删——正常路 writeBatch 已消费；此位只兜批未灌链的角落，防簿项滞留
      }
    });
    return next;
  }

  /** 实际写批：失败 = 保留批次 + 暂停自动重试 + 响亮上报；成功 = 复位暂停并灌积压 */
  private async writeBatch(sessionId: string, incoming: SessionEvent[]): Promise<void> {
    const reg = this.registrations.get(sessionId)!;
    const beganAt = performance.now(); // 批落延迟打点起点（#27——成功路终点回读）
    let batch = incoming;
    try {
      // 种子补齐（B8——第十一轮遗漏大扫 20260904-b）：种子会话首批落盘前，
      // 若库内尚无本会话事件则把首队捕获的种子快照前置到批头（fork/导入子
      // 会话事件流自包含且 seq 连续——会话篇 §5）。核对在写路径内：失败走
      // 既有失败机器（保留批 + 暂停 + 重试——seeds 簿不删，下轮 writeBatch
      // 重新核对）；核对成功即删簿（种子已在本批或已在库，重试批不再重复
      // 核对——appendCore 部分写后 remainder 过滤按自有边界自洽续片）
      const seed = this.seeds.get(sessionId);
      if (seed !== undefined && this.store.countEvents(sessionId) === 0) {
        batch = [...seed, ...batch];
      }
      if (seed !== undefined) this.seeds.delete(sessionId);
      this.store.appendCore(reg, batch, this.incarnation);
    } catch (cause) {
      /* 部分写裁剪（契约篇 §1.6 资源护栏族 #13，2026-08-27 刀〇b——**强制不变式**）：
       * appendCore 片化后已提交片保持 durable（部分写如实），重试面只回未写部分。
       * 全批原样回放会撞片首 cursor 连续性校验 SESSION_WRITE_CONFLICT，该会话
       * 队列永久卡死（m-5 冷读死锁陷阱）。
       *
       * 裁剪依据 = **自有提交边界**（2026-09-01 全面复盘 C-1 修法，会话篇 §6
       * 写入链第 2 步）：只认本进程经 appendCore 提交到的 seq（Store 内记账）；
       * 库内 max(seq) 是全库事实——超出自有边界的行必是外部写者所落，一概不裁
       * （修前按库内 maxSeq 裁剪：跨进程双开时另一进程的行被误认「本批已写」，
       * 本进程事件静默蒸发 + 文案谎报战果 + 重试片错位续写他人日志）。 */
      this.paused = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const ownUpto = this.store.ownCommittedSeq(sessionId);
      const remainder = ownUpto === undefined ? batch : batch.filter((event) => event.seq > ownUpto);
      const written = batch.length - remainder.length;
      if (remainder.length > 0) {
        const queue = this.pending.get(sessionId);
        if (queue) {
          queue.unshift(...remainder);
        } else {
          this.pending.set(sessionId, remainder);
        }
      }
      // 两成因分报：库内尾超自有边界 = 外部写者已占用 seq 段（双开同一会话属
      // 误用，会话篇 §6 多实例姿态③——报错即护栏；保留批重试恒撞 cursor 响亮
      // 拒，绝不静默续写他人日志）
      const dbMax = this.store.maxSeq(sessionId);
      const external = dbMax !== undefined && (ownUpto === undefined ? dbMax >= batch[0]!.seq : dbMax > ownUpto);
      const err = new AppError(
        PERSIST_BATCH_WRITE_FAILED,
        external
          ? `批量落盘失败（会话 ${sessionId}：外部写者冲突——库内 max(seq)=${dbMax} 超本进程自有提交边界` +
              `${ownUpto === undefined ? '（本批零提交）' : `=${ownUpto}`}，剩 ${remainder.length} 条保留待重试；` +
              '双开同一会话属误用，重试将恒撞 cursor 护栏响亮拒绝）'
          : `批量落盘失败（会话 ${sessionId}，已写 ${written} 条、剩 ${remainder.length} 条保留待重试）`,
        { cause },
      );
      this.onError?.(err);
      throw err;
    }
    // 成功即复位暂停旗（遗漏大扫 20260901-b #6）：任一批成功 = 故障条件已消除
    // （显式 flush 重试成功 / 他会话批次成功）——恢复自动调度，暂停期积压队列
    // 即刻灌链（不等下一窗口）。修前唯一复位位 close()：一次失败后 durable 退
    // 化为纯机会性落盘（只有显式 flush/close 兜底），恒败会话之外的健康流量也被
    // 拖停。持续失败则每次重试照旧逐次响亮上报（失败分支在上）。
    if (this.paused) {
      this.paused = false;
      this.drainAll();
    }
    // 批落延迟打点（#27）：成功路的纯测量——消费方自行定级，本类零解释
    this.onBatchLatency?.({ sessionId, events: batch.length, ms: performance.now() - beganAt });
  }

  /** 是否暂停中（诊断用） */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 待写积压会话数（诊断披露，基建大扫 #27）：pending Map 的键数 = 已确认待写
   * （含失败保留批）的会话数。在飞批次（已灌 chain 未落盘）不计——200ms 窗口
   * 内的瞬态，非医疗信号；paused 恒败时此数持续增长才是积压事实。
   */
  get pendingSessionCount(): number {
    return this.pending.size;
  }

  /**
   * 待写积压事件数（诊断披露，#27）：pending Map 全部队列长度之和。health 载荷
   * 的 writeBehind.events 数据源——绿披露不转红（阈值与裁剪策略挂账保留策略
   * 判据制）。
   */
  get pendingEventCount(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
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

  /**
   * 把全部待写队列灌入对应 chain（成功复位后的 piggyback 灌链口）。
   * 屏障结果吞掉：失败已由 writeBatch 的 onError 响亮上报（逐次触发），
   * 屏障 reject 只服务显式 flush 的调用方——此处吞掉防 unhandled rejection。
   */
  private drainAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.drainSession(sessionId).catch(() => undefined);
    }
  }
}

/** Session → 首刷登记素材 */
function registrationOf(
  session: Session,
  meta?: { cwd?: string; profile?: string; app?: string; importer?: string },
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
    // 导入者归因（会话篇 §5.1 冷读闸补）：origin='import' 行服务面强制非空
    importer: meta?.importer,
  };
}
