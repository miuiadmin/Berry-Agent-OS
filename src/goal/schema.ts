/**
 * L3 goal — goals 表 DDL（骨架篇 §6.8；迁移链 v5〔建表〕→ v8〔+needs_write〕
 * → v13〔goal id 一等整表重构，第三十九批 T1-B〕）。
 *
 * DDL 文本归 goal 模块自带、经 persist 统一迁移框架执行（纪律同 memory 表族——
 * persist 提供框架不认识业务表）。v4 已被[记忆与自进化]篇效用进化拍板预留，
 * goal 表落 v5（§6.8 存储条拍板）；v8 增 needs_write 列（第二十四批题3a）；
 * v13 主键换位 goal_id + session_id 降引用列 + partial unique index + 四新列。
 *
 * 「每会话至多一条激活目标」由 partial unique index 执法（active 行占位、
 * 终态行释放）；状态机词汇与转移约束在 machine.ts（纯函数），本表只是持久化
 * 载体——status / stop_reason 列的合法值由写入方保证。
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

/**
 * goals 表 v13 整表重构迁移项（第三十九批「goal 循环批」T1-B，2026-08-30
 * 规范先行——[运行时骨架]篇 §6.8 存储条）：
 *
 * - 主键 session_id → goal_id（goal id 一等，件内生成 ULID 形短标识——
 *   新行走代码生成器〔store.newGoalId〕，存量行回填 randomblob 十六进制）；
 * - session_id 降**当前会话引用**列（可空可重绑：NULL = 未绑定活载体——
 *   仅历史行 / 领养前降级行，不参与续跑、投递、记账）；
 * - 「每会话至多一条激活目标」由 partial unique index 执法
 *   （ON goals(session_id) WHERE status='active'——终态行释放位，同会话目标史可多行并存）；
 * - 新列四枚：wake_schedule（tick 挂钟节奏，词法复用 scheduler 三形状）/
 *   activated_seq（goal-scoped fold 激活锚——宿主单源日志长度；存量回填不可考
 *   NULL = fold 诚实降级 run-scoped）/ summary + summary_seq（轮间沉淀产物缓存
 *   与水位——事实源是 goal/summary durable 事件，两列只是缓存）；
 * - stop_reason 词面扩 stalls（反空转闸燃尽——列形状 TEXT 不变，写入方执法）。
 *
 * SQLite 改主键必须整表重构（新表建 → 存量搬 → 改名，迁移框架单事务包住）。
 */
export const GOAL_V13_MIGRATION: MigrationSpec = {
  version: 13,
  name: 'goal-goalid-primary',
  sql: `
-- ── goal id 一等重构（第三十九批 T1-B：主键换位 + 会话引用可重绑）──────
CREATE TABLE goals_v13 (
  goal_id       TEXT PRIMARY KEY,    -- 一等身份（件内 ULID 形短标识；存量行回填 32 位十六进制）
  session_id    TEXT,                -- 当前会话引用（可空可重绑——NULL = 未绑定活载体，不参与续跑/投递/记账）
  objective     TEXT NOT NULL,       -- 目标内容（用户数据——注入提示词时 XML 转义防注入）
  token_budget  INTEGER NOT NULL,    -- 预算帽（tokens_used ≥ 此值即刹停）
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,       -- active|needs-resume|completed|blocked|stopped（machine.ts 执法）
  stop_reason   TEXT,                -- stopped 专用：budget|stalls|user（第三十九批扩 stalls）
  evidence      TEXT,                -- completed 申报证据 / blocked 阻塞原因
  needs_write   INTEGER NOT NULL DEFAULT 0,
  wake_schedule TEXT,                -- 挂钟节奏（once@/every@/daily@ 词法；NULL = 无挂钟——第四批刀接线）
  activated_seq INTEGER,             -- goal-scoped fold 激活锚（宿主单源日志长度；NULL = 诚实降级 run-scoped）
  summary       TEXT,                -- 沉淀产物缓存（事实源 = goal/summary durable 事件；丢列从事件回填）
  summary_seq   INTEGER,             -- 沉淀水位（上次沉淀覆盖到的 durable seq 锚）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  settled_at    INTEGER
) STRICT;

-- 存量搬：goal_id 回填 randomblob（SQL 内生成——时间有序性对历史行无意义）；
-- 四新列不搬即 NULL（activated_seq 不可考 = fold 诚实降级，规范拍板形态）
INSERT INTO goals_v13 (goal_id, session_id, objective, token_budget, tokens_used, status, stop_reason,
                       evidence, needs_write, created_at, updated_at, settled_at)
SELECT lower(hex(randomblob(16))), session_id, objective, token_budget, tokens_used, status, stop_reason,
       evidence, needs_write, created_at, updated_at, settled_at
FROM goals;

DROP TABLE goals;
ALTER TABLE goals_v13 RENAME TO goals;

-- 旧 status 索引随 DROP 归零，重建 + 不变式执法位（partial unique——终态行释放位）
CREATE INDEX idx_goals_status ON goals (status);
CREATE UNIQUE INDEX idx_goals_session_active ON goals (session_id) WHERE status = 'active';
`,
};
