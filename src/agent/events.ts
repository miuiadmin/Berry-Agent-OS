/**
 * L1 agent — 活体事件面（骨架篇 §2.5，10 种，内存直推不落日志）。
 *
 * 分层纪律（反模式 #8）：token 级 chunk 只走本事件面直推通道（channels 订阅渲染）；
 * 会话日志只落消息级组装结果 + 请求头快照（「模型可见即落日志」断言作用在
 * durable 事件侧）。顺序严格 start → update* → end。
 */

import type { AssistantMessage, AssistantStreamEvent, ToolResultMessage } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { AgentToolResult } from './tools.js';

/** run 终态三值（骨架篇 §2.6 scaffold-first 钉死；suspended 留 v2 seam） */
export type RunStatus = 'completed' | 'aborted' | 'failed';

/**
 * loop 对外的 10 种活体事件（pi types.ts AgentEvent 联合同构恰 10 型；
 * 勿与 contracts/llm 流式 12 型 AssistantStreamEvent 混淆——那是 LLM 流协议）。
 */
export type AgentEvent =
  // run 生命周期
  | { type: 'agent_start' }
  | { type: 'agent_end'; status: RunStatus; messages: AgentMessage[] }
  // turn 生命周期（一 turn = 一次 assistant 响应 + 其工具批）
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期（user/assistant/toolResult 消息都发）
  | { type: 'message_start'; message: AgentMessage }
  /** 仅 assistant 流式期间（streamEvent 携带 LLM 流原语，token 级在此直推） */
  | { type: 'message_update'; message: AgentMessage; streamEvent: AssistantStreamEvent }
  | { type: 'message_end'; message: AgentMessage }
  // 工具执行生命周期
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: AgentToolResult;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };

/** 活体事件出口（组合根接 channels 订阅 / app harness 落 durable 事件） */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
