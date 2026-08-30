/**
 * L3 goal — 模块公共面（长目标续跑，骨架篇 §6.8）。
 *
 * 模块自洽面：DDL（schema）+ 状态机纯函数（machine）+ DAO（store）+ 提示词资产
 * （prompts）+ 工具三件（tools）+ 官方件（plugin）。组合根从本面取用一切——
 * 拓扑边：goal → contracts/context/persist。
 */

import type { MigrationSpec } from '../persist/index.js';
import { GOAL_MIGRATION, GOAL_NEEDS_WRITE_MIGRATION, GOAL_V13_MIGRATION } from './schema.js';

/** 件自带迁移链（v5 goals 表 + v8 needs_write 列 + v13 goal id 一等整表重构——组合根机械聚合的标准名） */
export const migrations: MigrationSpec[] = [GOAL_MIGRATION, GOAL_NEEDS_WRITE_MIGRATION, GOAL_V13_MIGRATION];

export { GOAL_MIGRATION, GOAL_NEEDS_WRITE_MIGRATION, GOAL_V13_MIGRATION } from './schema.js';
export { GoalStore, newGoalId } from './store.js';
export {
  canSetGoal,
  canResumeGoal,
  canStopGoal,
  canUpdateGoal,
  shouldContinueGoal,
  isDeliveryOutcome,
  DELIVERY_OUTCOMES,
} from './machine.js';
export type { GoalRecord, GoalStatus, DeliveryOutcome } from './machine.js';
export { GOAL_EVENT_TYPES } from './events.js';
export { GoalChannel } from './channel.js';
export type { GoalScopeInfo, TodoFoldItem, GateDiagnosticsFile } from './channel.js';
export { createGoalTools, snapshotOfItems } from './tools.js';
export type { GoalToolsDeps, GoalSessionsFace, TodoPlanSnapshot } from './tools.js';
export {
  escapeXml,
  renderContinuationPrompt,
  renderBudgetExhaustedPrompt,
  GOAL_DISCIPLINE_CLAUSES,
} from './prompts.js';
export { createGoalApp } from './app.js';
export type { GoalAppDeps } from './app.js';
