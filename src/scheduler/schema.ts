/**
 * L3 scheduler — jobs 表 DDL（会话篇 §6 迁移链 v7 + v8，tick 第一刀/第二刀）。
 *
 * DDL 文本归 scheduler 模块自带、经 persist 统一迁移框架执行（纪律同
 * memory/goal 表族——persist 提供框架不认识业务表）。v6 = sessions `+app`
 * 列（内核迁移，persist 自注入），v7 = 建表，v8 = 第二刀三列。
 *
 * 第一刀语义：schedule 字段**存而不执法**（第二刀定时触发的落点）；
 * RunRecord 不建表——durable 事件流即过程留痕（子进程 berry run 会话）。
 */

import type { MigrationSpec } from '../persist/index.js';

/** jobs 表迁移项（唯一事实源——指纹比对与建库都以本文本为准） */
export const SCHEDULER_MIGRATION: MigrationSpec = {
  version: 7,
  name: 'scheduler-jobs',
  sql: `
-- ── tick 任务行（内核边界篇 §4.1 席 13 第一刀：手动触发面）──────────
CREATE TABLE jobs (
  name        TEXT PRIMARY KEY,   -- 任务名（用户面词汇，/tick add <name>——主键即身份，同名拒）
  prompt      TEXT NOT NULL,      -- 任务指令体（原样传 berry run 子进程）
  cwd         TEXT,               -- 执行目录（NULL = 宿主启动目录；第一刀 add 不设，第二刀预留）
  schedule    TEXT,               -- 触发声明（第一刀存而不执法——第二刀三形状 parse 的落点）
  last_run_at INTEGER,            -- 最近触发时刻（抢占条件更新的比对键——双开并发护栏）
  created_at  INTEGER NOT NULL,   -- 建行时刻（Unix 毫秒）
  updated_at  INTEGER NOT NULL    -- 改行时刻（Unix 毫秒）
) STRICT;
`,
};

/**
 * v9 迁移：第二刀三列（内核边界篇 §4.1 席 13 第二刀——触发记因 + 任务↔会话归属标记）。
 *
 * 版本序说明：v8 已被 goal 件（goal-needs-write）占用——user_version 链全局唯一，
 * 本刀顺移 v9（缺号补位无意义，迁移框架只认严格递增）。
 *
 * - `last_run_reason`：最近一次触发记因（'manual' 手动 / 'scheduled' 到点 /
 *   'missed' once 迟到超窗记因不跑）——list 面与诊断可见「上次为何跑/为何没跑」；
 * - `session_id`：会话投递目标声明（NULL = 子进程单发无归属——投递二值拍板①；
 *   会话投递路的归属键，K2-c 命令面写入）；
 * - `last_session_id`：最近一次触发实际跑出的会话 id（子进程会话——K2-c 回写，
 *   任务↔会话精确归属标记，第一刀挂账的本刀兑现）。
 */
export const SCHEDULER_V9_MIGRATION: MigrationSpec = {
  version: 9,
  name: 'scheduler-jobs-v9',
  sql: `
ALTER TABLE jobs ADD COLUMN last_run_reason TEXT;
ALTER TABLE jobs ADD COLUMN session_id TEXT;
ALTER TABLE jobs ADD COLUMN last_session_id TEXT;
`,
};

/**
 * v14 迁移：goal 挂钟归属三列（骨架篇 §6.8 刀四 T7-B——jobs 表承载 goal 挂钟）。
 *
 * 版本序说明：v10-v13 已被 goal 件占用（v13 = goal 表整表重构）——顺移 v14。
 *
 * - `owner`：归属行（NULL = /tick 用户任务——存量行语义不变）。goal 挂钟行
 *   恒 'builtin:goal'（行 id 即身份——禁字符串约定之外的耦合）；
 * - `owner_key`：归属行内键（goal 行 = goalId）——关联经查表零字符串约定，
 *   (owner, owner_key) 联合即「这个 goal 的挂钟行在哪」的唯一寻径；
 * - `enabled`：生命周期位（INTEGER 0/1，缺省 1——/tick 存量行恒 1 不受影响）。
 *   终态/降级同笔置 0（行留史 + OS 注册保留——tick 编排预读发现让路，
 *   免整机装配的真·廉价 no-op）；resume/重挂置 1。/tick enable|disable
 *   动词维持 OS 注册语义不变（那两词管 launchd/crontab，不管本列）。
 */
export const SCHEDULER_V14_MIGRATION: MigrationSpec = {
  version: 14,
  name: 'scheduler-jobs-v14',
  sql: `
ALTER TABLE jobs ADD COLUMN owner TEXT;
ALTER TABLE jobs ADD COLUMN owner_key TEXT;
ALTER TABLE jobs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
`,
};
