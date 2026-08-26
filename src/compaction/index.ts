/**
 * L3 compaction — 模块公共面（长会话上下文治理，会话篇 §2 增补七条）。
 *
 * 模块自洽面：策略纯函数（policy）+ durable 词汇宿主面注册（events）+ 官方件
 * （plugin）。组合根从本面取用一切——拓扑边：compaction → contracts/context。
 * 零新表族：压缩状态全在会话事件日志，无迁移链。
 */

export { createCompactionPlugin, compactionConfig } from './plugin.js';
export { COMPACTION_EVENT_TYPES } from './events.js';
export {
  SUMMARY_PREFIX,
  buildSummaryPrompt,
  evaluateDebounce,
  evaluateThreshold,
  inCooldown,
  planSegment,
  summaryBudgetFor,
} from './policy.js';
export type {
  DebounceInput,
  DebounceVerdict,
  SegmentPlan,
  SummaryBudget,
  ThresholdInput,
  ThresholdVerdict,
} from './policy.js';
