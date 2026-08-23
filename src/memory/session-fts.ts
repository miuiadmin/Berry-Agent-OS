/**
 * L3 memory — 跨会话全文检索投影（会话篇 §9 第 7 项定稿 + 记忆篇 §10，user_version=3）。
 *
 * DDL/维护/检索全归 memory 模块（跨会话检索 v1 唯一消费方持有投影）：
 * session 模块保持纯 TS 物理零依赖、persist 提供框架不认识业务表——两边都不该
 * 背这张表。表可丢弃可重建（FTS 投影纪律）：插件卸载即停维护，重激活对账自愈。
 *
 * 维护三点（会话篇 §9 定稿注记）：
 * 1. 激活期对账 synchronize()：空索引全量重建 / 有水位按会话补差；
 * 2. 运行期增量：session/event 活体镜像逐事件 indexEvent()；
 * 3. 卸载即停：宿主只在该插件作用域存活期间订阅。
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
 * 会话日志读源（Store 公共读脸的结构面）：宿主装配闭包注入（官方内置件 = 宿主
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
 * 会话全文索引（FTS 投影 + 水位一体 DAO）。
 * 一个索引两用：跨会话检索（不带 sessionId）与会话内检索（带 sessionId 过滤）。
 */
export class SessionFtsIndex {
  private readonly db: DatabaseConnection;

  constructor(db: DatabaseConnection) {
    this.db = db;
  }

  /**
   * 运行期增量索引单事件（session/event 活体镜像逐事件调用）：
   * - 遮蔽事件（surfaceOp）：先删被遮蔽区间 [start, end] 的已索引行（遮蔽语义与
   *   派生表面同构——改历史的唯一合法形态），再走常规插入（改写事件本身也是新事件）；
   * - 文本事件（user/message、assistant/message）：body 非空才插行；
   * - 水位前进：无论是否产出行，处理过即 MAX 前进（对账补差以「已处理」为准）。
   */
  indexEvent(sessionId: string, event: SessionEvent): void {
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
   * 激活期对账（插件装载时调用一次，尽力而为——失败由调用方记日志不杀启动）：
   * - 索引为空 → 全量重建（清残留水位防半态，逐会话整卷重放）；
   * - 有水位 → 按会话补差（只重放 seq > 水位的事件——append-only 日志的增量读）。
   * 全程单事务：对账中途崩溃不留半态（下次重来）。
   */
  synchronize(source: SessionFtsSource): void {
    const run = this.db.transaction(() => {
      const isEmpty = (this.db.prepare(`SELECT COUNT(*) AS n FROM session_fts`).get() as { n: number }).n === 0;
      if (isEmpty) {
        this.db.prepare(`DELETE FROM session_fts_state`).run();
      }
      for (const sessionId of source.listSessionIds()) {
        // 水位缺失 = 该会话从未进索引（如插件禁用期间新建）→ -1 起整卷重放（补差不漏会话）
        const watermark = isEmpty
          ? -1
          : ((
              this.db.prepare(`SELECT seq FROM session_fts_state WHERE session_id = ?`).get(sessionId) as
                { seq: number } | undefined
            )?.seq ?? -1);
        for (const event of source.loadEvents(sessionId)) {
          if (event.seq <= watermark) continue;
          this.indexEvent(sessionId, event);
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
