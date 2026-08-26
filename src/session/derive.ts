/**
 * L1 session — 有效表面与模型历史投影（会话篇 §3「单一转换源」）。
 *
 * 「模型可见即落日志」三条腿中的结构腿：deriveMessages 是模型历史的唯一入口，
 * 纯函数 fold——增量缓存与全量重算共用此处同一个转换函数，永不二写。
 */

import type { SessionEvent } from '../contracts/events.js';
import type { MessageSource } from '../contracts/llm.js';
import type { AssistantMessageData, ToolCallData, ToolResultData, UserMessageData } from './event-types.js';

/** 投影出的工具调用块（挂在 assistant 消息上） */
export interface ProjectedToolCall {
  readonly type: 'toolCall';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: string;
}

/**
 * 模型历史投影的消息形状——结构对齐 pi-ai AgentMessage 联合（user / assistant /
 * toolResult），llm 模块落码时负责与其请求体类型收口适配。
 *
 * seq 锚（2026-08-26 compaction 纵切补）：每型带锚事件 seq（user/assistant =
 * 各自 message 事件 seq；toolResult = tool/result 事件 seq）——遮蔽写者
 * （compaction / 未来 prune）从消息序映射回事件 seq 区间的唯一通用途径；
 * 不带它则写者只能自扫原始流 = 绕投影的第二份账（会话篇 §3.1 单一转换源）。
 */
export type ProjectedMessage =
  | { readonly type: 'user'; readonly seq: number; readonly content: unknown; readonly source?: MessageSource }
  | {
      readonly type: 'assistant';
      readonly seq: number;
      /** 模型响应内容块（text 等，不含工具调用） */
      readonly content: unknown;
      /** 同一响应内发起的工具调用（由 tool/call 事件合成进本消息） */
      readonly toolCalls: readonly ProjectedToolCall[];
      readonly usage?: unknown;
      readonly stopReason?: string;
    }
  | {
      readonly type: 'toolResult';
      readonly seq: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: string;
      readonly output: unknown;
      readonly isError: boolean;
    };

/** fold 内部状态（open assistant 缓冲 + 未结算 tool/call 配对表） */
interface FoldState {
  messages: ProjectedMessage[];
  /** 当前打开的 assistant 消息缓冲：assistant/message 开缓冲，遇到 user/message 或 tool/result 先冲刷 */
  openAssistant: {
    /** 锚事件 seq（assistant/message 事件——投影消息的 seq 来源） */
    seq: number;
    content: unknown;
    usage?: unknown;
    stopReason?: string;
    toolCalls: ProjectedToolCall[];
  } | null;
  /** toolCallId → 调用信息（tool/result 到达时取名字与参数，配对后删除） */
  pendingCalls: Map<string, { name: string; arguments: string }>;
}

/** 空初始状态（增量缓存装配时的起点） */
function emptyFoldState(): FoldState {
  return { messages: [], openAssistant: null, pendingCalls: new Map() };
}

/** 单事件步进（就地修改 state）——全量 fold 与未来增量缓存共用的唯一转换函数 */
function stepFold(state: FoldState, event: SessionEvent): void {
  switch (event.type) {
    case 'user/message': {
      flushAssistant(state);
      const data = event.data as UserMessageData;
      // source 归因原样带出（会话篇 §3.1——缺省不落字段即不进投影，读侧视为 'user'）
      state.messages.push({
        type: 'user',
        seq: event.seq,
        content: data.content,
        ...(data.source !== undefined ? { source: data.source } : {}),
      });
      return;
    }
    case 'assistant/message': {
      // 同一 turn 内多条 assistant/message：先冲刷上一条（罕见，容错处理）
      flushAssistant(state);
      const data = event.data as AssistantMessageData;
      state.openAssistant = {
        seq: event.seq,
        content: data.content,
        usage: data.usage,
        stopReason: data.stopReason,
        toolCalls: [],
      };
      return;
    }
    case 'tool/call': {
      const data = event.data as ToolCallData;
      // 工具调用归属同响应的 assistant 消息；若无打开缓冲（日志残缺），补一个空缓冲兜底
      if (!state.openAssistant) {
        state.openAssistant = { seq: event.seq, content: [], toolCalls: [] };
      }
      state.openAssistant.toolCalls.push({
        type: 'toolCall',
        toolCallId: data.toolCallId,
        toolName: data.name,
        arguments: data.arguments,
      });
      state.pendingCalls.set(data.toolCallId, { name: data.name, arguments: data.arguments });
      return;
    }
    case 'tool/result': {
      // 工具结果消息排在 assistant（含其全部 toolCall 块）之后
      flushAssistant(state);
      const data = event.data as ToolResultData;
      const call = state.pendingCalls.get(data.toolCallId);
      state.pendingCalls.delete(data.toolCallId);
      state.messages.push({
        type: 'toolResult',
        seq: event.seq,
        toolCallId: data.toolCallId,
        toolName: call?.name ?? '',
        arguments: call?.arguments,
        output: data.content,
        isError: data.error !== undefined,
      });
      return;
    }
    default:
      // turn 边界 / request/header / todo/write / log-only 全部不产出消息：
      // todo/write 的模型可见性走「跨 turn 每轮注入当前全表」通道（骨架篇 §6.7），
      // 此处落日志供 UI 投影与注入器读取。
      return;
  }
}

/** 冲刷打开中的 assistant 缓冲为一条投影消息（无缓冲则无事发生） */
function flushAssistant(state: FoldState): void {
  if (!state.openAssistant) {
    return;
  }
  const buf = state.openAssistant;
  state.messages.push({
    type: 'assistant',
    seq: buf.seq,
    content: buf.content,
    toolCalls: buf.toolCalls,
    usage: buf.usage,
    stopReason: buf.stopReason,
  });
  state.openAssistant = null;
}

/** 计算被遮蔽的 seq 集合：遍历所有 surfaceOp 的 [start,end] 区间取并集 */
export function occludedSeqs(events: readonly SessionEvent[]): Set<number> {
  const occluded = new Set<number>();
  for (const event of events) {
    if (event.surfaceOp) {
      for (let seq = event.surfaceOp.start; seq <= event.surfaceOp.end; seq++) {
        occluded.add(seq);
      }
    }
  }
  return occluded;
}

/**
 * 模型历史投影（会话篇 §3）：日志减被遮蔽节点后 fold 出 ProjectedMessage 序列。
 * 纯函数——同输入同输出；未配对的 tool/call（正常路径不存在，恢复协议保证闭合）
 * 容错丢弃：其 toolCall 块保留在 assistant 消息内，但不产出悬空 toolResult。
 */
export function deriveMessages(events: readonly SessionEvent[]): ProjectedMessage[] {
  const occluded = occludedSeqs(events);
  const state = emptyFoldState();
  for (const event of events) {
    if (!occluded.has(event.seq)) {
      stepFold(state, event);
    }
  }
  flushAssistant(state);
  return state.messages;
}
