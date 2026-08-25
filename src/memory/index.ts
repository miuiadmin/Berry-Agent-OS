/**
 * L3 memory 公共面——跨模块只许 import 本文件（拓扑白名单边：memory→persist 经 index）。
 *
 * 纵切一：表族迁移项 + 合并管线纯函数 + MemoryStore DAO；
 * 纵切五：session_fts 迁移/索引 + 官方件模块（createMemoryPlugin——组合根内置
 * 注册表收纳，`builtin:memory` 行激活）。
 */

import type { MigrationSpec } from '../persist/index.js';
import { MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION } from './schema.js';
import { SESSION_FTS_MIGRATION } from './session-fts.js';

/** 件自带迁移链（v2 表族 + v3 session_fts + v4 效用列——组合根机械聚合的标准名，tick 第一刀同批改造） */
export const migrations: MigrationSpec[] = [MEMORY_MIGRATION, SESSION_FTS_MIGRATION, MEMORY_UTILITY_MIGRATION];

export { MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION } from './schema.js';
export { uuidV7, shortIdOf } from './id.js';
export { BRIEFING_SECTION_ID, renderBriefingSection } from './briefing.js';
export { CITATION_INSTRUCTION, citationMarker, parseCitationShortIds, textOfAssistantContent } from './citation.js';
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
  utilityScore,
  type MemoryKind,
  type MemoryStatus,
  type MemorySourceRef,
  type MemoryRecord,
  type MemoryInput,
  type AddMemoryOutcome,
} from './store.js';
// canonical 工作区根已收编宿主 context（2026-08-25 检索族纵切批——记忆篇 §3
// 挂账「三处同源」兑现：memory owner_key / skills 信任判定 / 未来 project 域键；
// 从 context/index.js 导入，本模块不再转出）
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
export {
  runReviewOnce,
  runConsolidationOnce,
  collectConsolidationCandidates,
  attachPeriodicReview,
  mergeReasonPasses,
  type ReviewLlmFace,
  type PeriodicReviewOptions,
  type ReviewReport,
  type ConsolidationReport,
  type ReviewHandle,
} from './review.js';
export { SESSION_FTS_MIGRATION, SessionFtsIndex, type SessionFtsHit, type SessionFtsSource } from './session-fts.js';
export {
  MEMORY_DIFF_TYPE,
  briefingFace,
  faceFingerprint,
  diffFaces,
  deriveDiffView,
  sameDiffView,
  type MemoryDiffOp,
  type MemoryDiffEntry,
  type MemoryDiffData,
  type FaceEntry,
} from './diff.js';
export { createMemoryPlugin, type MemoryPluginDeps, type MemoryPluginStoreFace } from './plugin.js';
