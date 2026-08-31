/**
 * L3 memory — 跨会话全文检索投影（会话篇 §9 第 7 项定稿 + 记忆篇 §10，user_version=3）。
 *
 * DDL/维护/检索全归 memory 模块（跨会话检索 v1 唯一消费方持有投影）：
 * session 模块保持纯 TS 物理零依赖、persist 提供框架不认识业务表——两边都不该
 * 背这张表。表可丢弃可重建（FTS 投影纪律）：应用卸载即停维护，重激活对账自愈。
 *
 * 维护三点（会话篇 §9 定稿注记）：
 * 1. 激活期对账 synchronize()：空索引全量重建 / 有水位先会话级核验（实有行数 ≠
 *    折算期望 → 清行整卷重放并校直水位——fork 种子段被活体水位越过〔种子不上
 *    活体总线〕与崩溃半态残留两形状同判据，复盘 20260901 D-1/D-2）/ 核验通过按水位补差；
 * 2. 运行期增量：session/event 活体镜像逐事件 indexEvent()——单事件三语句单事务原子；
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
   */
  indexEvent(sessionId: string, event: SessionEvent): void {
    this.atomicIndex(sessionId, event);
  }

  /**
   * 激活期对账（应用装载时调用一次，尽力而为——失败由调用方记日志不杀启动）：
   * - 索引为空 → 全量重建（清残留水位防半态，逐会话整卷重放）；
   * - 有水位 → 先**会话级核验**（复盘 20260901 D-1/D-2）：实有行数 ≠ 按 applyEvent
   *   语义折算的期望行数 → 该会话清行整卷重放并校直水位——fork/委派子会话种子段
   *   （种子物理复制但不上活体总线，首条活体事件直接把水位推过未索引区段）与
   *   三语句崩溃半态残留两形状同判据；核验通过才走常规补差（只重放 seq > 水位）；
   * - 水位缺失 = 该会话从未进索引（如应用禁用期间新建）→ 同路整卷重放（清行先行
   *   保幂等——半态残留行不双计）。
   * 全程单事务：对账中途崩溃不留半态（下次重来）。
   */
  synchronize(source: SessionFtsSource): void {
    const run = this.db.transaction(() => {
      // 每会话实有行数（一次扫描取全——核验判据的对照左值）
      const counts = new Map<string, number>(
        (
          this.db.prepare(`SELECT session_id AS sid, COUNT(*) AS n FROM session_fts GROUP BY session_id`).all() as {
            sid: string;
            n: number;
          }[]
        ).map((row) => [row.sid, row.n]),
      );
      const isEmpty = counts.size === 0;
      if (isEmpty) {
        this.db.prepare(`DELETE FROM session_fts_state`).run();
      }
      for (const sessionId of source.listSessionIds()) {
        const events = source.loadEvents(sessionId);
        // 水位缺失 = 从未进索引（或索引为空的整库重建）→ -1 起整卷重放
        const watermark = isEmpty
          ? -1
          : ((
              this.db.prepare(`SELECT seq FROM session_fts_state WHERE session_id = ?`).get(sessionId) as
                { seq: number } | undefined
            )?.seq ?? -1);
        // 核验：水位在场但行集对不上（种子段被越过 / 崩溃半态残留）→ 整卷重建
        if (watermark === -1 || counts.get(sessionId) !== expectedRowCount(events, watermark)) {
          this.db.prepare(`DELETE FROM session_fts WHERE session_id = ?`).run(sessionId);
          for (const event of events) {
            this.applyEvent(sessionId, event);
          }
          // 校直水位：直写重放尾值（不走 applyEvent 的 MAX——半态水位虚高于日志尾
          // 〔撕裂尾修复等〕时 MAX 会永久滞留错值，让核验每次对账都误判重建）
          const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : -1;
          this.db
            .prepare(
              `INSERT INTO session_fts_state (session_id, seq) VALUES (?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq`,
            )
            .run(sessionId, lastSeq);
          continue;
        }
        // 常规补差：只重放 seq > 水位的事件（append-only 日志的增量读——增量不重复）
        for (const event of events) {
          if (event.seq <= watermark) continue;
          this.applyEvent(sessionId, event);
        }
      }
    });
    run.immediate();
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
