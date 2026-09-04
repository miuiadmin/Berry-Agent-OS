/**
 * ctx.sessions 服务面契约接口（契约篇 §6.13.4 服务面方法级符号——API 治理进化
 * 批刀 B，2026-09-04）。
 *
 * 住位裁决：SERVICE_CATALOG 目录项 sessions 行 module 列 = session——接口缺
 * 失的宿主模块同笔补契约接口声明（§6.13.4 刀 B 条款）。本接口是组合根
 * `provide('sessions')` 对象的**全量形**（app/assembly.ts 内联对象 satisfies 本
 * 型——面漂移编译期即红）；各官方件消费侧的窄结构面（SessionsAppendFace 等）
 * 维持不变——消费窄面与全量契约面并存是既有纪律（结构窄化方向性注记见
 * chat/conversation.ts OverflowCompactionFace 头注）。
 *
 * 抽取器（tools/extract-api-surface.mjs）经 SERVICE_CATALOG faceInterface 列
 * 寻址本接口，逐成员落 `services` 域方法级符号（`sessions.createSession` 形）
 * ——成员增删自此对 diff/判级/查 9/COMPATIBILITY 全链可见。
 */
import type { EventQueryOptions, EventQueryResult, SessionEvent } from '../contracts/events.js';
import type { ProjectedMessage } from './derive.js';

/** ctx.sessions 服务面全量形（provide('sessions') 对象的契约接口） */
export interface SessionsServiceFace {
  /**
   * 导入会话（会话篇 §5.1）：origin='import' 钉死；四道卫生闸洗外部种子 →
   * durable 承诺（ensureSeeded + flush 屏障）→ 返回 sessionId 不返回活引用。
   * persist:false 诊断装配下响亮拒绝（导入 = durable 承诺物理不可履行）。
   */
  createSession(opts: { readonly seed: readonly SessionEvent[] }): Promise<string>;
  /**
   * fork 露头（会话篇 §5.2）：以调用链当前会话的前缀为种子分叉——回退正路
   * （checkpoint-rewind）= fork + adopt 切换后写。无路由落点返回 undefined 降级。
   */
  fork(boundary?: number): Promise<string | undefined>;
  /**
   * 事件追加（应用词专属——核心词写入权属宿主，核心词在此响亮拒绝）；无路由
   * 落点返回 undefined 降级。
   */
  appendEvent(type: string, data: unknown): SessionEvent | undefined;
  /** 当前路由会话 id（无路由落点 undefined） */
  currentSessionId(): string | undefined;
  /**
   * 会话收养（会话篇 §5.3）：S3 open 收养路的件可达导线——fork 产物或任意
   * 持久会话经此切前台。无注册面/未知 id 同 false。
   */
  adopt(sessionId: string): boolean;
  /** run 在跑探针：缺省 = 当前路由会话；不在册会话恒 false */
  isBusy(sessionId?: string): boolean;
  /** 事件枚举（读侧同抛未知词——拼错事件名的无声死不设）；无落点 = 空数组 */
  eventsOfType(type: string): SessionEvent[];
  /**
   * 路由会话的「最后闭合 turn 边界」（回退正路读面针——checkpoint 件 forkSeq
   * 唯一取值口）：物理全日志的闭合前缀长度。无路由落点 = undefined。
   */
  lastClosedBoundary(): number | undefined;
  /** 当前路由会话日志长度（goal 激活锚唯一取值口；无落点 undefined） */
  logLength(): number | undefined;
  /**
   * 遮蔽载体宿主代写（会话篇 §2 增补 6）：应用携 surfaceOp 的 user/message
   * 载体经宿主写权落账（五执法点在装配侧收口）；无路由落点返回 undefined。
   */
  appendWithSurfaceOp(carrier: {
    readonly type: string;
    readonly data: { readonly content: unknown; readonly source: string };
    readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
    readonly sourceEventSeqs: readonly number[];
  }): Promise<SessionEvent | undefined>;
  /** 模型历史投影只读（应用读当前会话投影走此面，禁自扫原始流绕投影） */
  deriveMessages(): ProjectedMessage[];
  /** 投影 JSON 字符总长（compaction 判据底账；无落点降级 2 = 空数组「[]」） */
  projectedJsonChars(): number;
  /**
   * 跨会话有界时间窗查询（会话篇 §3.4 单原语）——sanctioned 直读事实表
   * （读物理库；需精确可传 flushFirst: true）。persist:false 诊断装配返空降级。
   */
  queryEvents(query: EventQueryOptions): Promise<EventQueryResult>;
}
