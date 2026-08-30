/**
 * L3 scheduler — 模块公共面（tick 第一刀 + 第二刀，内核边界篇 §4.1 席 13）。
 *
 * 模块自洽面：DDL（schema）+ 闸门纯函数（gates）+ schedule 词法/判定纯函数
 * （schedule）+ DAO（store）+ 官方件（plugin）。拓扑边：scheduler →
 * contracts / context / persist（spawn 组装上提组合根——件经闭包收
 * runJob，结构上不见 exec）。
 *
 * `migrations` 标准名导出 = 会话篇 §6 静态声明面（第十六批题十五目标态
 * 兑现——带表件以本名声明自带迁移，assembly flatMap 聚合）。
 */

import type { MigrationSpec } from '../persist/index.js';
import { SCHEDULER_MIGRATION, SCHEDULER_V9_MIGRATION, SCHEDULER_V14_MIGRATION } from './schema.js';

/** 件自带迁移链（v7 jobs 表 + v9 三列 + v14 归属三列——组合根机械聚合的标准名） */
export const migrations: MigrationSpec[] = [SCHEDULER_MIGRATION, SCHEDULER_V9_MIGRATION, SCHEDULER_V14_MIGRATION];

export { SCHEDULER_MIGRATION, SCHEDULER_V9_MIGRATION, SCHEDULER_V14_MIGRATION } from './schema.js';
export { discoveryGates, RECENT_USER_MSG_WINDOW_MS, WAKE_CHAIN_CAP } from './gates.js';
export type { DiscoveryGatesInput, DiscoveryGateDecision, DiscoveryGateReason } from './gates.js';
export { parseSchedule, looksLikeSchedule, evaluateDue, MIN_REFIRE_GAP_MS, ONCE_GRACE_MS } from './schedule.js';
export type { Schedule, ScheduleParse, DueDecision } from './schedule.js';
export { JobsStore, JOB_NAME_PATTERN } from './store.js';
export type { AddJobOutcome, ReserveOutcome } from './store.js';
export { createSchedulerApp, goalJobName, GOAL_JOB_OWNER } from './app.js';
export type { SchedulerAppDeps, GoalJobsFace, OsRegistrarFace } from './app.js';
export type { JobRecord, TickRunResult, RunReason } from './types.js';
