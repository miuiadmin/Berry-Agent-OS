/**
 * L3 memory 公共面——跨模块只许 import 本文件（拓扑白名单边：memory→persist 经 index）。
 *
 * 纵切一暴露：表族迁移项（MEMORY_MIGRATION）+ 合并管线纯函数 + MemoryStore DAO。
 * 插件装配（纵切二起）在此追加。
 */

export { MEMORY_MIGRATION } from './schema.js';
export { uuidV7 } from './id.js';
export { BRIEFING_SECTION_ID, renderBriefingSection } from './briefing.js';
export {
  FUZZY_THRESHOLD,
  POLARITY_OVERLAP_THRESHOLD,
  tokenize,
  jaccard,
  overlapScore,
  detectPolarity,
  isPolarityConflict,
  classifyMerge,
  type MergeDecision,
} from './merge.js';
export {
  MemoryStore,
  projectOwnerKey,
  type MemoryKind,
  type MemoryStatus,
  type MemorySourceRef,
  type MemoryRecord,
  type MemoryInput,
  type AddMemoryOutcome,
} from './store.js';
export {
  detectSecret,
  detectInstructionInjection,
  quoteAsCitation,
  sanitizeForModel,
  guardedAddMemory,
  type SanitizedEntry,
  type SanitizeResult,
  type GuardedWriteResult,
} from './scan.js';
export {
  detectCorrection,
  userTextFromContent,
  attachCorrectionExtractor,
  type CorrectionExtractorOptions,
} from './extract.js';
export { createMemoryTools, type MemoryToolsOptions } from './tools.js';
