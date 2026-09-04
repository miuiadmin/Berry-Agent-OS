/**
 * L1 session — 会话事件日志模块出口。
 * 对外面（agent/persist/记忆等）只暴露：Session 类、事件词汇注册表、投影纯函数、恢复纯函数。
 */

export { Session } from './session.js';
export type { SessionHeader, SessionOptions, AppendOptions } from './session.js';
export {
  registerSessionEventType,
  getSessionEventType,
  listSessionEventTypes,
  CORE_EVENT_TYPES,
  usageLedgerBuckets,
  ledgerModel,
  turnUsageCallId,
  delegationUsageCallId,
  isDelegationUsageCallId,
} from './event-types.js';
export type {
  SessionEventTypeDefinition,
  SessionEventCategory,
  TurnEndReason,
  UserMessageData,
  AssistantMessageData,
  ToolCallData,
  ToolResultData,
  TodoWriteData,
  RequestHeaderData,
  ApprovalAskedData,
  ApprovalDecidedData,
  GateDecisionData,
  SandboxModeData,
  LlmUsageData,
} from './event-types.js';
export { deriveMessages, occludedSeqs } from './derive.js';
export type { ProjectedMessage, ProjectedToolCall } from './derive.js';
// ctx.sessions 服务面契约接口（API 治理进化刀 B——SERVICE_CATALOG faceInterface
// 寻址位；组合根 provide 对象 satisfies 本型）
export type { SessionsServiceFace } from './service-face.js';
export { interruptedTurnClosers, lastClosedTurnBoundary } from './recover.js';
export type { SyntheticCloser } from './recover.js';
export { snapshotJsonValue, deepFreeze, jsonBytes } from './snapshot.js';
// 预算刀（第九轮 #7/#12 迁入共享件）：durable 落账前的内容预算截断——
// compaction/goal/assembly 宿主代写面/todo 与 chat 共用（详见 budget.ts 头注）
export {
  DURABLE_CONTENT_BUDGET_BYTES,
  DURABLE_ERROR_MESSAGE_BUDGET_BYTES,
  TRUNCATED_MARKER,
  blockBytes,
  escapedBytes,
  budgetString,
  truncateForDurable,
} from './budget.js';
export type { DurableBlock } from './budget.js';
