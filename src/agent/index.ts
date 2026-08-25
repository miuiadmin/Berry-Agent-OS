/**
 * L1 agent — 桶出口（loop 骨架 + 消息角色 + 工具族 + 活体事件 + 队列）。
 *
 * 模块边界（地基篇 §4.1）：仅依赖 contracts（与 session 互不依赖、零 import llm
 * ——StreamFn 注入面达成）。app 组合根从此处取 startRun/continueRun 与全部类型。
 */
export {
  startRun,
  continueRun,
  type StreamFn,
  type StreamFnOptions,
  type ThinkingLevel,
  type AgentContext,
  type AgentTurnUpdate,
  type TurnDoneInfo,
  type BeforeToolCallInfo,
  type BeforeToolCallResult,
  type AfterToolCallInfo,
  type AfterToolCallResult,
  type AgentLoopConfig,
  type RunHooks,
  type RunResult,
} from './loop.js';
export {
  type ToolExecutionMode,
  type AgentToolCall,
  type AgentToolResult,
  type ToolUpdateCallback,
  type AgentTool,
} from './tools.js';
export { type RunStatus, type AgentEvent, type AgentEventSink } from './events.js';
export { type QueueMode, PendingMessageQueue } from './queue.js';
