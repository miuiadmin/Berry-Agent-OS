/**
 * L3 goal — goals 表 DDL（骨架篇 §6.8，user_version=5 + v8 needs_write 列）。
 *
 * DDL 文本归 goal 模块自带、经 persist 统一迁移框架执行（纪律同 memory 表族——
 * persist 提供框架不认识业务表）。v4 已被[记忆与自进化]篇效用进化拍板预留，
 * goal 表落 v5（§6.8 存储条拍板）；v8 增 needs_write 列（第二十四批题3a）。
 *
 * 每会话至多一条 goal（session_id 主键即唯一约束）；状态机词汇与转移约束在
 * machine.ts（纯函数），本表只是持久化载体——status 列的合法值由写入方保证。
 */

import type { MigrationSpec } from '../persist/index.js';

/** goals 表迁移项（唯一事实源——指纹比对与建库都以本文本为准） */
export const GOAL_MIGRATION: MigrationSpec = {
  version: 5,
  name: 'goal',
  sql: `
-- ── 长目标行（骨架篇 §6.8 状态机：每会话至多一条，挂 session_id）──────
CREATE TABLE goals (
  session_id   TEXT PRIMARY KEY,     -- 归属会话（每会话至多一条 goal——主键即唯一）
  objective    TEXT NOT NULL,        -- 目标内容（用户数据——注入提示词时 XML 转义防注入）
  token_budget INTEGER NOT NULL,     -- 预算帽（goal_set 时定；tokens_used ≥ 此值即刹停）
  tokens_used  INTEGER NOT NULL DEFAULT 0,  -- 累计花销（assistant/message usage 汇总额累加）
  status       TEXT NOT NULL,        -- active|needs-resume|completed|blocked|stopped（machine.ts 执法）
  stop_reason  TEXT,                 -- stopped 专用原因列：budget（预算尽）| user（人工停）
  evidence     TEXT,                 -- completed 申报证据 / blocked 阻塞原因（schema 执法位）
  created_at   INTEGER NOT NULL,     -- Unix 毫秒
  updated_at   INTEGER NOT NULL,     -- Unix 毫秒（任何字段变更）
  settled_at   INTEGER               -- 终态落点（completed/blocked/stopped 的时间戳；进行态为 NULL）
) STRICT;

CREATE INDEX idx_goals_status ON goals (status);
`,
};

/**
 * needs_write 列迁移项（user_version=8；2026-08-26 第二十四批题3a——
 * [运行时骨架]篇 §6.8 backgroundWake 轮工具面收窄的开洞申请位）：
 * goal_set 可选 needsWrite 申报后落此列；true = 续跑轮不收窄工具面（写/执行类可用），
 * 缺省 false = 续跑轮只 read 类工具 + goal_get/goal_update（无人值守收紧）。
 * ALTER 而非重建——v5 既有行零迁移成本，缺省 0 即缺省收紧语义。
 */
export const GOAL_NEEDS_WRITE_MIGRATION: MigrationSpec = {
  version: 8,
  name: 'goal-needs-write',
  sql: `
-- ── 续跑轮工具面开洞申请位（第二十四批题3a）────────────────────
ALTER TABLE goals ADD COLUMN needs_write INTEGER NOT NULL DEFAULT 0;
`,
};
