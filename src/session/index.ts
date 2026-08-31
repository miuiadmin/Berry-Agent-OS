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
export { interruptedTurnClosers, lastClosedTurnBoundary } from './recover.js';
export type { SyntheticCloser } from './recover.js';
export { snapshotJsonValue, deepFreeze, jsonBytes } from './snapshot.js';
