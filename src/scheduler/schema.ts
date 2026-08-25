/**
 * L3 scheduler — jobs 表 DDL（会话篇 §6 迁移链 v7，tick 第一刀）。
 *
 * DDL 文本归 scheduler 模块自带、经 persist 统一迁移框架执行（纪律同
 * memory/goal 表族——persist 提供框架不认识业务表）。v6 = sessions `+app`
 * 列（内核迁移，persist 自注入），v7 = 本表。
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
