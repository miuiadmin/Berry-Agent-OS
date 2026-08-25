/**
 * L3 scheduler — 模块公共面（tick 第一刀，内核边界篇 §4.1 席 13）。
 *
 * 模块自洽面：DDL（schema）+ 闸门纯函数（gates）+ DAO（store）+ 官方件
 * （plugin）。拓扑边：scheduler → contracts / context / persist（spawn
 * 组装上提组合根——件经闭包收 runJob，结构上不见 exec）。
 *
 * `migrations` 标准名导出 = 会话篇 §6 静态声明面（第十六批题十五目标态
 * 兑现——带表件以本名声明自带迁移，assembly flatMap 聚合）。
 */

import type { MigrationSpec } from '../persist/index.js';
import { SCHEDULER_MIGRATION } from './schema.js';

/** 件自带迁移链（v7 jobs 表——组合根机械聚合的标准名） */
export const migrations: MigrationSpec[] = [SCHEDULER_MIGRATION];

export { SCHEDULER_MIGRATION } from './schema.js';
export { discoveryGates, RECENT_USER_MSG_WINDOW_MS } from './gates.js';
export type { DiscoveryGatesInput, DiscoveryGateDecision, DiscoveryGateReason } from './gates.js';
export { JobsStore, JOB_NAME_PATTERN } from './store.js';
export type { AddJobOutcome, ReserveOutcome } from './store.js';
export { createSchedulerPlugin } from './plugin.js';
export type { SchedulerPluginDeps } from './plugin.js';
export type { JobRecord, TickRunResult } from './types.js';
