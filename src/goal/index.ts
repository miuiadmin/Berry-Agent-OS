/**
 * L3 goal — 模块公共面（长目标续跑，骨架篇 §6.8）。
 *
 * 模块自洽面：DDL（schema）+ 状态机纯函数（machine）+ DAO（store）+ 提示词资产
 * （prompts）+ 工具三件（tools）+ 官方件（plugin）。组合根从本面取用一切——
 * 拓扑边：goal → contracts/context/persist。
 */

export { GOAL_MIGRATION } from './schema.js';
export { GoalStore } from './store.js';
export { canSetGoal, canResumeGoal, canStopGoal, canUpdateGoal, shouldContinueGoal } from './machine.js';
export type { GoalRecord, GoalStatus } from './machine.js';
export {
  escapeXml,
  renderContinuationPrompt,
  renderBudgetExhaustedPrompt,
  GOAL_DISCIPLINE_CLAUSES,
} from './prompts.js';
export { createGoalTools } from './tools.js';
export { createGoalPlugin } from './plugin.js';
export type { GoalPluginDeps } from './plugin.js';
