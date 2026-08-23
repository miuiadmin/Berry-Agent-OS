/**
 * L5 app — durable 事件接线（组合根专属职责：活体事件 → 会话事件日志的映射）。
 *
 * 三件东西：
 * ① createDurableSinks：loop 的 AgentEvent → session.append（消息级组装结果 +
 *    turn 边界；token 级 chunk / agent 边界不落日志——骨架篇 §2.5 分层纪律）；
 * ② 守门决议 sink（pipeline onGateDecision → gate/decision）与审批对 sink
 *    （approval → approval/asked + approval/decided）；
 * ③ projectedToAgentMessages：历史投影（ProjectedMessage）→ AgentMessage
 *    （恢复会话续跑 / TUI 历史渲染的形状适配——durable 是压缩态，回读要还原）。
 *
 * 追加顺序不变式（derive fold 依赖，会话篇 §3）：assistant/message 先落、
 * 逐 toolCall 块续落 tool/call、tool/result 到达时 assistant 缓冲已具备配对信息。
 */

import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../agent/messages.js';
import { isStandardMessage } from '../agent/messages.js';
import type { StopReason, TextContent, ToolCallBlock, Usage } from '../contracts/llm.js';
import type { ImageContent, ThinkingContent, ToolResultMessage, UserMessage } from '../contracts/llm.js';
import type { GateDecisionPayload, GateDecisionSink } from '../contracts/tools.js';
import type { Session } from '../session/session.js';
import type { ProjectedMessage } from '../session/derive.js';
import type { TurnEndReason } from '../session/event-types.js';
import type { ApprovalDecisionSink } from '../safety/approval.js';

/** 组合根持有的 durable 接线面（loop emit 的持久化半边 + 两个结构化 sink） */
export interface DurableSinks {
  /** loop 活体事件 → durable（emit 扇出的持久化半边） */
  handle(event: AgentEvent): void;
  /** 守门决议落 durable（接 pipeline 的 onGateDecision） */
  readonly gate: GateDecisionSink;
  /** 审批对落 durable（接 approval 服务的 sink） */
  readonly approval: ApprovalDecisionSink;
}

/** StopReason（LLM 七值）→ TurnEndReason（会话六值）映射 */
function stopReasonToTurnEnd(reason: StopReason): TurnEndReason {
  switch (reason) {
    case 'stop':
    case 'toolUse':
    case 'pending':
    case 'deferred':
      return 'completed';
    case 'length':
      return 'max-tokens';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
  }
}

/** 工具结果错误码（M1 通用码：ToolResultMessage 只携带 isError 布尔，具体码不回传） */
const TOOL_ERROR_CODE = 'TOOL_ERROR';

/** 内容块首段文本（错误说明用；无文本块返回 undefined） */
function firstText(content: readonly (TextContent | ImageContent)[]): string | undefined {
  const text = content.find((block): block is TextContent => block.type === 'text');
  return text?.text;
}

/**
 * 组装 durable 接线面。session.append 的抛错（如载荷不可 JSON 化）直接上抛——
 * 按「回调违约由 app 装配层兜底」纪律，由会话驱动统一合成 error 收尾。
 */
export function createDurableSinks(session: Session): DurableSinks {
  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case 'turn_start':
        session.append('turn/start', {});
        return;
      case 'turn_end': {
        // turn 终态锚定本 turn assistant 消息的 stopReason（三套终态枚举的换算点）
        session.append('turn/end', { reason: stopReasonToTurnEnd(event.message.stopReason) });
        return;
      }
      case 'message_end': {
        const message = event.message;
        // 自定义角色 M1 无内置注册者（角色注册是插件面），无处产生即无需落点；
        // 插件期若引入自定义角色，须先扩事件词汇再在此接线（未覆盖≠驳回）
        if (!isStandardMessage(message)) return;
        if (message.role === 'user') {
          session.append('user/message', { content: message.content });
          return;
        }
        if (message.role === 'assistant') {
          // 消息终态 + 逐工具调用块（arguments 落原始字符串——解析失败留给工具管道）
          session.append('assistant/message', {
            content: message.content,
            usage: message.usage,
            stopReason: message.stopReason,
          });
          for (const block of message.content) {
            if (block.type === 'toolCall') {
              session.append('tool/call', {
                toolCallId: block.id,
                name: block.name,
                arguments: JSON.stringify(block.arguments),
              });
            }
          }
          return;
        }
        // toolResult：isError 携带通用错误码 + 首段文本说明（durable 写码不写长文）
        session.append('tool/result', {
          toolCallId: message.toolCallId,
          content: message.content,
          ...(message.isError ? { error: { code: TOOL_ERROR_CODE, message: firstText(message.content) } } : {}),
        });
        return;
      }
      default:
        // agent_start/agent_end/message_start/message_update/tool_execution_* 不落
        // durable——token 级与生命周期边界走活体事件面（骨架篇 §2.5 分层纪律）
        return;
    }
  };

  return {
    handle,
    gate: (payload: GateDecisionPayload) => {
      session.append('gate/decision', payload);
    },
    approval: {
      asked: (payload) => {
        session.append('approval/asked', payload);
      },
      decided: (payload) => {
        session.append('approval/decided', payload);
      },
    },
  };
}

/* ---------------- 历史投影回读适配（ProjectedMessage → AgentMessage） ---------------- */

/** 零用量兜底（投影缺 usage 时的占位——Usage 是 AssistantMessage 必填） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** tool/call 的 arguments 字符串还原为对象（解析失败回空对象——与首次落库失败对称） */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 历史投影 → AgentMessage 序列（恢复续跑的上下文重建 / TUI 历史渲染共用）。
 * timestamp 不在 durable 内（事件信封有 time），回读置 0——展示层不依赖它，
 * loop 上下文重建也不读历史时间戳（只新消息带真实时间）。
 */
export function projectedToAgentMessages(projected: readonly ProjectedMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of projected) {
    switch (message.type) {
      case 'user':
        out.push({
          role: 'user',
          content: message.content as UserMessage['content'],
          timestamp: 0,
        });
        break;
      case 'assistant': {
        // 工具调用块由 tool/call 事件合成（投影分离态）——还原为 assistant 内联块
        const blocks = [
          ...((message.content ?? []) as (TextContent | ThinkingContent | ToolCallBlock)[]),
          ...message.toolCalls.map((call): ToolCallBlock => ({
            type: 'toolCall',
            id: call.toolCallId,
            name: call.toolName,
            arguments: parseToolArguments(call.arguments),
          })),
        ];
        out.push({
          role: 'assistant',
          content: blocks,
          usage: (message.usage as Usage | undefined) ?? NO_USAGE,
          stopReason: (message.stopReason as StopReason | undefined) ?? 'stop',
          timestamp: 0,
        });
        break;
      }
      case 'toolResult':
        out.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.output as ToolResultMessage['content'],
          isError: message.isError,
          timestamp: 0,
        });
        break;
    }
  }
  return out;
}
