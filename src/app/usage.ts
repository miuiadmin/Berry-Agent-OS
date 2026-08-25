/**
 * L5 app — /usage 面板投影（llm/usage durable 底账的只读聚合读侧）。
 *
 * 会话篇 §1.1 底账设计（2026-08-24 第十一批 #1）的读侧兑现：「花销是事件流
 * 事实、余额是投影」——全部真实 LLM 请求一本账（前台主 loop turn 汇总 +
 * ctx.llm.complete 单发 + 委派后台结算折叠三类写点统一落 llm/usage 事件），
 * 本模块只做跨会话时间窗聚合，零写入、零内核面（契约篇 §8 拍板 27：/usage
 * 刀零契约面触点——只读投影）。
 *
 * 口径纪律（会话篇 §1.1 原文）：token 原始值入账，货币折算在投影查询做
 * （价格表更新不回改历史）——v1 面板纯 token 计数，货币折算待价格表消费面
 * 出现再加（底账已备，投影可随时重算）。
 *
 * goal 联表口径差：goal 自报 tokens_used = assistant/message usage 累计
 * （骨架篇 §6.8），与底账 llm/usage 聚合不同源——面板分列展示不混算，
 * 「底账行」与「goal 行」各自口径随行标注。
 */

import type { DatabaseConnection } from '../persist/index.js';

/** 面板选项（测试注入时钟与宽度用） */
export interface UsagePanelOptions {
  /** 聚合窗口锚点（Unix 毫秒；缺省 Date.now()——「今日」按本地时区零点切） */
  readonly now?: number;
  /** 会话排行长度（缺省 5） */
  readonly topN?: number;
}

/** 一次时间窗聚合的结果（tokens = input+output+cacheRead+cacheWrite 总和） */
interface WindowSum {
  calls: number;
  tokens: number;
}

/** events.data JSON 里 usage 四字段的 SQL 求和表达式（缺字段按 0 计——
 * complete 侧账只带 input/output，cache 两字段 NULL 需 COALESCE 兜底） */
const TOKENS_EXPR = `(COALESCE(json_extract(data, '$.usage.input'), 0)
  + COALESCE(json_extract(data, '$.usage.output'), 0)
  + COALESCE(json_extract(data, '$.usage.cacheRead'), 0)
  + COALESCE(json_extract(data, '$.usage.cacheWrite'), 0))`;

/** 千分位格式化（12,345——人读面板统一形态） */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 本地时区某时刻所在日的零点（「今日」窗口起点） */
function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 单时间窗聚合（time >= since 的 llm/usage 全库聚合——底账跨会话一本账） */
function windowSum(db: DatabaseConnection, since: number): WindowSum {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(${TOKENS_EXPR}), 0) AS tokens
       FROM events WHERE type = 'llm/usage' AND time >= ?`,
    )
    .get(since) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

/**
 * 生成 /usage 面板文本（多行人读——经 ui.notify 呈现，/goal 命令同形态）。
 *
 * 四段：时间窗总量（今日/近 7 日）→ 会话 top N（附 origin 血缘标记）→
 * 模型分布 → goal 联表（goals 表可能未建——goal 件可卸，缺表降级说明行）。
 * @param db 已开库连接（只读查询，不写入）
 */
export function formatUsagePanel(db: DatabaseConnection, opts: UsagePanelOptions = {}): string {
  const now = opts.now ?? Date.now();
  const topN = opts.topN ?? 5;
  const sections: string[] = [];

  /* ---- 段 1：时间窗总量（底账口径）---- */
  const today = windowSum(db, localMidnight(now));
  const week = windowSum(db, now - 7 * 86_400_000);
  sections.push(
    `今日：${fmt(today.tokens)} t（${today.calls} 次调用）\n近 7 日：${fmt(week.tokens)} t（${week.calls} 次调用）`,
  );

  /* ---- 段 2：会话 top N（LEFT JOIN sessions 取 origin——血缘缺失容缺）---- */
  const sessionRows = db
    .prepare(
      `SELECT e.session_id AS sid, s.origin AS origin, COUNT(*) AS calls, SUM(${TOKENS_EXPR}) AS tokens
       FROM events e LEFT JOIN sessions s ON s.id = e.session_id
       WHERE e.type = 'llm/usage'
       GROUP BY e.session_id ORDER BY tokens DESC LIMIT ?`,
    )
    .all(topN) as Array<{ sid: string; origin: string | null; calls: number; tokens: number }>;
  if (sessionRows.length === 0) {
    sections.push('会话 top：（尚无用量记录）');
  } else {
    const lines = sessionRows.map(
      (r, i) => `  ${i + 1}. ${r.sid.slice(0, 8)}…  ${fmt(r.tokens)} t（${r.calls} 次，${r.origin ?? '血缘未知'}）`,
    );
    sections.push(`会话 top ${sessionRows.length}：\n${lines.join('\n')}`);
  }

  /* ---- 段 3：模型分布（model 字段底账必有——缺省容缺列）---- */
  const modelRows = db
    .prepare(
      `SELECT COALESCE(json_extract(data, '$.model'), '(未记模型)') AS model,
              COUNT(*) AS calls, SUM(${TOKENS_EXPR}) AS tokens
       FROM events WHERE type = 'llm/usage'
       GROUP BY model ORDER BY tokens DESC`,
    )
    .all() as Array<{ model: string; calls: number; tokens: number }>;
  if (modelRows.length > 0) {
    const lines = modelRows.map((r) => `  ${r.model}  ${fmt(r.tokens)} t（${r.calls} 次）`);
    sections.push(`模型分布：\n${lines.join('\n')}`);
  }

  /* ---- 段 4：goal 联表（goals 表随 goal 件迁移而建——可卸件缺表降级）---- */
  const hasGoals =
    (db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'goals'`).get() as
      { x: number } | undefined) !== undefined;
  if (!hasGoals) {
    sections.push('goal：（goals 表未建——goal 件未装载或未迁移）');
  } else {
    const goalRows = db
      .prepare(
        `SELECT session_id, status, stop_reason, tokens_used, token_budget FROM goals
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{
      session_id: string;
      status: string;
      stop_reason: string | null;
      tokens_used: number;
      token_budget: number;
    }>;
    if (goalRows.length === 0) {
      sections.push('goal：（无目标记录）');
    } else {
      const lines = goalRows.map(
        (g) =>
          `  ${g.session_id.slice(0, 8)}…  ${g.status}${g.stop_reason ? `/${g.stop_reason}` : ''}  ${fmt(g.tokens_used)} / ${fmt(g.token_budget)} t`,
      );
      sections.push(`goal（自报口径 = assistant/message usage 累计）：\n${lines.join('\n')}`);
    }
  }

  return `用量面板（llm/usage 底账只读投影）\n${sections.join('\n\n')}`;
}
