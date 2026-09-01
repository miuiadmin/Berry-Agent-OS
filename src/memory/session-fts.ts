/**
 * L3 memory — 跨会话全文检索投影（会话篇 §9 第 7 项定稿 + 记忆篇 §10，user_version=3）。
 *
 * DDL/维护/检索全归 memory 模块（跨会话检索 v1 唯一消费方持有投影）：
 * session 模块保持纯 TS 物理零依赖、persist 提供框架不认识业务表——两边都不该
 * 背这张表。表可丢弃可重建（FTS 投影纪律）：应用卸载即停维护，重激活对账自愈。
 *
 * 维护三点（会话篇 §9 定稿注记）：
 * 1. 激活期对账 synchronize()——对账成本三档（遗漏大扫 20260901 O-8）：读侧预检
 *    （deferred 读事务零写锁）按 session_fts_state.verified_count 通过标记豁免未变
 *    会话（零 loadEvents 全量读）；有变化会话分会话小事务（BEGIN IMMEDIATE 只持
 *    该会话——boot 不持全库写锁做全量读核验；原子性会话级，中途崩溃下次自愈）；
 *    空索引全量重建同改分会话事务。核验语义不变：空索引重建 / 有水位先会话级核验
 *    （实有行数 ≠ 折算期望 → 清行整卷重放并校直水位——fork 种子段被活体水位越过
 *    〔种子不上活体总线〕与崩溃半态残留两形状同判据，复盘 20260901 D-1/D-2）/
 *    核验通过按水位补差；
 * 2. 运行期增量：session/event 活体镜像逐事件 indexEvent()——单事件三语句单事务原子；
 *    零语句事件（无遮蔽且无可索引文本）免事务免 fsync（遗漏大扫 20260901 L-8——
 *    水位在此类事件上滞后无害：MAX 语义追平 + 对账补差幂等重放）；
 * 3. 卸载即停：宿主只在该应用作用域存活期间订阅。
 *
 * 索引文本面 v1 = user/message + assistant/message（tool 载荷不进——价值密度低体积大）；
 * 遮蔽事件（surfaceOp）按区间删除被遮蔽行（遮蔽语义与派生表面同构）。
 */

import type { DatabaseConnection } from '../persist/index.js';
import type { MigrationSpec } from '../persist/index.js';
import type { SessionEvent } from '../contracts/events.js';

/**
 * 跨会话检索迁移项（user_version=3，统一迁移框架执行；唯一事实源——指纹比对与
 * 建库都以本文本为准）。水位表 per-session 记最后已处理 seq——增量补差的锚点。
 */
export const SESSION_FTS_MIGRATION: MigrationSpec = {
  version: 3,
  name: 'session-fts',
  sql: `
-- ── 会话全文检索投影（会话篇 §9 第 7 项；可丢弃可重建）────────────
-- tokenize=trigram：中英混排 substring 检索（与 memory_fts 同选型）；
-- session_id/seq UNINDEXED——MATCH 只打 body，命中行携带定位（可跳转回放）
CREATE VIRTUAL TABLE session_fts USING fts5(
  session_id UNINDEXED,
  seq       UNINDEXED,
  body,
  tokenize='trigram'
);

-- ── per-session 水位（该会话最后已处理事件 seq——对账补差锚点）──────
CREATE TABLE session_fts_state (
  session_id TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL
) STRICT;
`,
};

/**
 * 对账通过标记列（user_version=15，遗漏大扫 20260901 O-8）：verified_count =
 * 该会话核验+补差收敛时的存量事件总数——下次对账预检未变即整会话豁免（免
 * loadEvents 全量读 + 行集折算）。NULL = 从未通过核验（首验/半态自愈后落值）。
 */
export const SESSION_FTS_VERIFY_MIGRATION: MigrationSpec = {
  version: 15,
  name: 'session-fts-verify-count',
  sql: `
ALTER TABLE session_fts_state ADD COLUMN verified_count INTEGER;
`,
};

/** 检索命中行（记忆篇 §10：带来源定位——sessionId + seq 可跳转回放） */
export interface SessionFtsHit {
  readonly sessionId: string;
  readonly seq: number;
  readonly snippet: string;
}

/**
 * 会话日志读源（Store 公共读脸的结构面）：宿主装配闭包注入（官方件 = 宿主
 * 装配特权，不新开 ctx 服务名——契约篇 §1.5 表尾）。接口窄化到对账所需的两个
 * 方法，Store 结构性满足。
 */
export interface SessionFtsSource {
  /** 全部会话 id 清单（对账遍历面） */
  listSessionIds(): string[];
  /** 整卷重放某会话事件日志（append-only 原始序——遮蔽事件含在其内） */
  loadEvents(sessionId: string): SessionEvent[];
  /**
   * 某会话已存事件数（廉价 COUNT 读——对账预检通过标记的比对值；Store.countEvents
   * 同源既有方法，fork 种子物理复制判据同款，零新增语句）。
   */
  countEvents(sessionId: string): number;
}

/** 进索引的事件类型（索引文本面 v1：user/message + assistant/message only） */
const INDEXED_TYPES = new Set(['user/message', 'assistant/message']);

/**
 * 提取事件可索引文本。content 两形态（durable 预算截断后的产物）：
 * 纯字符串（user 消息常见）或块数组（text 块取 .text；thinking/image 不进索引——
 * 前者是模型独白非会话内容，后者无文本）。非索引类型返回空串。
 */
function eventText(event: SessionEvent): string {
  if (!INDEXED_TYPES.has(event.type)) return '';
  const content = (event.data as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * 折算会话期望行数（对账核验判据的右值——与 applyEvent 三语句效果逐一同构的
 * 纯函数半边：文本事件加入行集、surfaceOp 按区间移除行集；只折算 seq ≤ 水位的
 * 段——行不可能超出水位，日志尾增长留给补差路径）。
 * 为什么对照行集不对照水位：水位是「已处理」的 max 记录，结构性看不见「处理过
 * 但没索引」的区段（fork 种子段被活体水位越过 / 崩溃半态残留），只有行集能作证。
 */
function expectedRowCount(events: readonly SessionEvent[], watermark: number): number {
  const rows = new Set<number>();
  for (const event of events) {
    if (event.seq > watermark) break;
    if (event.surfaceOp !== undefined) {
      for (let seq = event.surfaceOp.start; seq <= event.surfaceOp.end; seq++) rows.delete(seq);
    }
    if (eventText(event).length > 0) rows.add(event.seq);
  }
  return rows.size;
}

/**
 * 会话全文索引（FTS 投影 + 水位一体 DAO）。
 * 一个索引两用：跨会话检索（不带 sessionId）与会话内检索（带 sessionId 过滤）。
 */
export class SessionFtsIndex {
  private readonly db: DatabaseConnection;
  /**
   * 单事件原子包裹（复盘 20260901 D-2）：applyEvent 三语句（遮蔽删除/正文插入/
   * 水位前进）包单事务——崩溃窗不留「行在、水位没跟上」的半态（该半态会让补差
   * 重插双行）。构造期缓存事务函数（免逐事件重建；嵌套调用自动降级 savepoint）。
   */
  private readonly atomicIndex: (sessionId: string, event: SessionEvent) => void;

  constructor(db: DatabaseConnection) {
    this.db = db;
    this.atomicIndex = db.transaction((sessionId: string, event: SessionEvent) => this.applyEvent(sessionId, event));
  }

  /**
   * 三语句核心（无事务边界——事务责任在调用方：活体入口 atomicIndex 包单事务；
   * synchronize 外层事务内直调，免逐事件 savepoint 开销）：
   * - 遮蔽事件（surfaceOp）：先删被遮蔽区间 [start, end] 的已索引行（遮蔽语义与
   *   派生表面同构——改历史的唯一合法形态），再走常规插入（改写事件本身也是新事件）；
   * - 文本事件（user/message、assistant/message）：body 非空才插行；
   * - 水位前进：无论是否产出行，处理过即 MAX 前进（对账补差以「已处理」为准）。
   */
  private applyEvent(sessionId: string, event: SessionEvent): void {
    if (event.surfaceOp !== undefined) {
      this.db
        .prepare(`DELETE FROM session_fts WHERE session_id = ? AND seq BETWEEN ? AND ?`)
        .run(sessionId, event.surfaceOp.start, event.surfaceOp.end);
    }
    const body = eventText(event);
    if (body.length > 0) {
      this.db
        .prepare(`INSERT INTO session_fts (session_id, seq, body) VALUES (?, ?, ?)`)
        .run(sessionId, event.seq, body);
    }
    this.db
      .prepare(
        `INSERT INTO session_fts_state (session_id, seq) VALUES (?, ?)
           ON CONFLICT(session_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      )
      .run(sessionId, event.seq);
  }

  /**
   * 运行期增量索引单事件（session/event 活体镜像逐事件调用）——单事件单事务原子
   * （语义细节见 applyEvent）。
   * 零语句事件免事务（遗漏大扫 20260901 L-8）：无遮蔽且无可索引文本 → 三语句退化
   * 为零语句（原本只有水位记账会写）——直接返回免事务免 fsync（主库
   * synchronous=FULL 下每活体事件省一次）。水位在此类事件上滞后无害：MAX 语义
   * （后继文本事件追平）+ 对账补差幂等重放同判据；行集核验判据不受滞后影响
   * （期望折算只数文本行，文本行的 seq 恒 ≤ 水位——其自身的 applyEvent 已推进）。
   */
  indexEvent(sessionId: string, event: SessionEvent): void {
    if (event.surfaceOp === undefined && eventText(event).length === 0) return;
    this.atomicIndex(sessionId, event);
  }

  /**
   * 激活期对账（应用装载时调用一次，尽力而为——失败由调用方记日志不杀启动）。
   * 对账成本三档（遗漏大扫 20260901 O-8——boot//reload 成本不随库内总事件数线性涨、
   * 不持全库写锁做全量读核验）：
   * - 读侧预检（deferred 读事务零写锁）：session_fts_state.verified_count 通过标记
   *   （v15 列）与该会话存量事件总数（countEvents 廉价 COUNT）比对——未变即整会话
   *   豁免（loadEvents 全量读 + 行集折算双免）；标记缺失 = 从未通过核验，进工作集；
   * - 有变化会话分会话小事务（BEGIN IMMEDIATE 只持该会话核验+补差；原子性会话级，
   *   中途崩溃半态自愈——未收敛会话无标记，下次对账重入）；
   * - 空索引全量重建同改分会话事务（清残留水位先行独立小事务防半态）。
   * 单会话语义不变：水位缺失/核验失配（fork 种子段被越过 / 三语句崩溃半态残留——
   * 复盘 20260901 D-1/D-2）→ 清行整卷重放并校直水位；核验通过 → 按 seq > 水位补差。
   */
  synchronize(source: SessionFtsSource): void {
    // 读侧预检：deferred 读事务（纯读零写锁——稳态 boot 不再申请写锁）
    const precheck = this.db.transaction(() => {
      const counts = new Map<string, number>(
        (
          this.db.prepare(`SELECT session_id AS sid, COUNT(*) AS n FROM session_fts GROUP BY session_id`).all() as {
            sid: string;
            n: number;
          }[]
        ).map((row) => [row.sid, row.n]),
      );
      const work: string[] = [];
      for (const sessionId of source.listSessionIds()) {
        const row = counts.size > 0 ? this.stateRow(sessionId) : undefined;
        if (row === undefined || row.verifiedCount === null || row.verifiedCount !== source.countEvents(sessionId)) {
          work.push(sessionId);
        }
      }
      return { isEmpty: counts.size === 0, work };
    });
    const { isEmpty, work } = precheck();
    if (isEmpty) {
      // 空索引 = 全量重建路径：清残留水位独立小事务（半态水位不拦重建）
      this.db
        .transaction(() => {
          this.db.prepare(`DELETE FROM session_fts_state`).run();
        })
        .immediate();
    }
    const runOne = this.db.transaction((sessionId: string) => this.reconcileSession(source, sessionId));
    for (const sessionId of work) {
      runOne.immediate(sessionId); // 分会话小事务——写锁只握单个会话的核验+补差时长
    }
  }

  /** 读会话状态行（水位 + 核验通过标记两列一次取） */
  private stateRow(sessionId: string): { seq: number; verifiedCount: number | null } | undefined {
    return this.db
      .prepare(`SELECT seq, verified_count AS verifiedCount FROM session_fts_state WHERE session_id = ?`)
      .get(sessionId) as { seq: number; verifiedCount: number | null } | undefined;
  }

  /**
   * 单会话对账体（BEGIN IMMEDIATE 小事务内执行）：
   * - 事务内重读标记防预检后并发收敛（他路已同步 → 幂等退出）；
   * - 核验：水位在场但行集对不上（种子段被越过 / 崩溃半态残留）→ 整卷重建 + 校直
   *   水位（直写重放尾值——不走 MAX，半态水位虚高不滞留）；通过 → 常规补差；
   * - 通过标记在 loadEvents **之后**重读事件总数入账（撕裂尾修复可能删行——预检值
   *   不信任）；重建腿校直语句同笔写标记，补差腿只补标记不动水位（水位由 applyEvent
   *   MAX 独占管理——两腿都不越权）。
   */
  private reconcileSession(source: SessionFtsSource, sessionId: string): void {
    const row = this.stateRow(sessionId);
    const count = source.countEvents(sessionId);
    if (row !== undefined && row.verifiedCount === count) return; // 预检后已被并发对账收敛
    const events = source.loadEvents(sessionId);
    const watermark = row?.seq ?? -1;
    // 实有行数（核验判据左值——事务内现读，不用预检快照）
    const actual = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM session_fts WHERE session_id = ?`).get(sessionId) as { n: number }
    ).n;
    if (watermark === -1 || actual !== expectedRowCount(events, watermark)) {
      this.db.prepare(`DELETE FROM session_fts WHERE session_id = ?`).run(sessionId);
      for (const event of events) {
        this.applyEvent(sessionId, event);
      }
      // 校直水位：直写重放尾值（不走 applyEvent 的 MAX——半态水位虚高于日志尾
      // 〔撕裂尾修复等〕时 MAX 会永久滞留错值，让核验每次对账都误判重建）
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : -1;
      const finalCount = source.countEvents(sessionId); // loadEvents 撕裂尾修复可能删行——重读
      this.db
        .prepare(
          `INSERT INTO session_fts_state (session_id, seq, verified_count) VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq, verified_count = excluded.verified_count`,
        )
        .run(sessionId, lastSeq, finalCount);
      return;
    }
    // 常规补差：只重放 seq > 水位的事件（append-only 日志的增量读——增量不重复）
    for (const event of events) {
      if (event.seq <= watermark) continue;
      this.applyEvent(sessionId, event);
    }
    // 通过标记（只补标记不动水位——水位由 applyEvent 的 MAX 独占管理）
    const finalCount = source.countEvents(sessionId);
    this.db
      .prepare(
        `INSERT INTO session_fts_state (session_id, seq, verified_count) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET verified_count = excluded.verified_count`,
      )
      .run(sessionId, watermark, finalCount);
  }

  /**
   * 检索（trigram 分词；查询转义与 memory_fts 同式：token 逐个小写、加引号、空格
   * 连接 = FTS5 隐式 AND——用户输入不可能炸 MATCH 语法，<3 字符 token 天然不命中）。
   * @param opts.sessionId 给定即会话内检索（一个索引两用），缺省跨会话
   * @param opts.limit 命中条数上限（缺省 5）
   */
  search(query: string, opts: { limit?: number; sessionId?: string } = {}): SessionFtsHit[] {
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const limit = opts.limit ?? 5;
    const sql =
      `SELECT session_id AS sessionId, seq, snippet(session_fts, 2, '【', '】', '…', 12) AS snippet
         FROM session_fts WHERE session_fts MATCH ?` +
      (opts.sessionId !== undefined ? ` AND session_id = ?` : '') +
      ` ORDER BY rank LIMIT ?`;
    const args: unknown[] = opts.sessionId !== undefined ? [match, opts.sessionId, limit] : [match, limit];
    return this.db.prepare(sql).all(...args) as SessionFtsHit[];
  }
}
