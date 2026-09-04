/**
 * L3 compaction — 模块公共面（长会话上下文治理，会话篇 §2 增补七条）。
 *
 * 模块自洽面：策略纯函数（policy）+ durable 词汇宿主面注册（events）+ 官方件
 * （plugin）。组合根从本面取用一切——拓扑边：compaction → contracts/context。
 * 零新表族：压缩状态全在会话事件日志，无迁移链。
 */

export { createCompactionApp, compactionConfig } from './app.js';
// ctx.compaction 服务面契约接口（API 治理进化刀 B——SERVICE_CATALOG faceInterface
// 寻址位；官方件 provide 对象 satisfies 本型）
export type { CompactionServiceFace } from './app.js';
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
