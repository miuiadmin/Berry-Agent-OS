/**
 * 智能体间对话协议契约。
 *
 * dialogue 是 11.0 引入的 Agent 间通信机制：
 * Conversation Agent 通过 dialogue 工具与其他 Agent 进行多轮消息交互，
 * 所有消息经 Kernel 中转（审计、镜像、Brain 异步监听）。
 */

import type { IntentAnchor } from './intent.js';

// ─────────────────────────────────────────────────────────────────
// 核心消息载荷
// ─────────────────────────────────────────────────────────────────

/** dialogue 消息元数据（目标 Agent 回复时附加） */
export interface DialogueMetadata {
  /** 目标 Agent 标记这是最终结果，Conversation 可以不再追问 */
  isFinal?: boolean;
  /** 目标 Agent 标记需要澄清 */
  needsClarification?: boolean;
  /** 置信度（0-1），低于阈值 Conversation 可能追问 */
  confidence?: number;
  /**
   * VF-3: 类型化错误码，供 Agent LLM 做出合理决策。
   * - AGENT_TIMEOUT: Agent 还活着但卡住，可安全重试
   * - AGENT_CRASHED: Agent 进程已崩溃，不应重试
   * - AGENT_UNAVAILABLE: Agent 未注册或离线
   */
  errorCode?: string;
}

/** dialogue.send / dialogue.reply 共用的消息载荷 */
export interface DialogueMessagePayload {
  /** 对话 ID（同一次用户请求内的多轮交互共享） */
  dialogueId: string;
  /** 本消息在对话中的序号（0-based） */
  sequenceNumber: number;
  /** 发送方 agent 名 */
  from: string;
  /** 接收方 agent 名 */
  to: string;
  /** 消息内容（纯文本或结构化指令） */
  content: string;
  /** 附加上下文（文件内容、工具结果、sessionId 等） */
  context?: Record<string, unknown>;
  /** 回复方的元数据标记 */
  metadata?: DialogueMetadata;
}

/** dialogue.end 载荷 */
export interface DialogueEndPayload {
  dialogueId: string;
  reason: 'completed' | 'timeout' | 'interrupted' | 'budget_exceeded' | 'agent_crashed';
}

/** dialogue.observe 载荷（Kernel → Brain 的消息副本） */
export interface DialogueObservePayload {
  /** 被观察的消息 */
  message: DialogueMessagePayload;
  /** 当前对话已进行的轮次 */
  currentRound: number;
  /** 该对话关联的 sessionId */
  sessionId: string;
  /**
   * L1: 该对话关联的 taskId（correlationId 解析后）。
   * 供 Brain 漂移检测按 (sessionId, taskId) 隔离 IntentAnchor，
   * 防止同 session 多 task 串台。
   */
  taskId?: string;
  /** 12.0: 意图锚点（供 Brain 语义漂移检测用） */
  intentAnchor?: IntentAnchor;
}

// ─────────────────────────────────────────────────────────────────
// DialogueRouter 接口
// ─────────────────────────────────────────────────────────────────

/** 对话状态（Kernel 内存维护） */
export interface DialogueState {
  dialogueId: string;
  sessionId: string;
  correlationId: string;
  initiator: string;
  target: string;
  /** 当前轮次（每一对 send+reply 计为一轮） */
  currentRound: number;
  /** 对话创建时间戳 */
  createdAt: number;
  /** 对话状态 */
  status: 'active' | 'completed' | 'timeout' | 'interrupted';
  /** 本轮 ephemeral taskId（Code 用于推送 telemetry） */
  ephemeralTaskId?: string;
  /** 累计字符数（send+reply 的 content.length 之和，用于预算守护） */
  totalChars: number;
}

/** DialogueRouter 创建对话的参数 */
export interface CreateDialogueParams {
  sessionId: string;
  correlationId: string;
  initiator: string;
  target: string;
}

// ─────────────────────────────────────────────────────────────────
// 预算配置
// ─────────────────────────────────────────────────────────────────

/** dialogue 预算默认值 */
export const DIALOGUE_DEFAULTS = {
  /** 单个 dialogue 的最大轮次 */
  maxRounds: 10,
  /** 单次用户请求内最多开启的对话数 */
  maxDialoguesPerRequest: 3,
  /** 13.0 §13.3: 同 target agent 同时进行的对话数上限（避免被多 worker 同时轰炸） */
  maxDialoguesPerTarget: 2,
  /** 单轮回复超时（ms） */
  replyTimeoutMs: 60_000,
  /** dialogue.reply 内容的最大字符数（超过则截断） */
  maxReplyChars: 20_000,
  /** 单个对话的总字符数上限（发+收，粗略 token 估算基于 1 token ≈ 3.5 字符） */
  maxTotalChars: 280_000,
} as const;

// ─────────────────────────────────────────────────────────────────
// dialogue 工具的输入 schema
// ─────────────────────────────────────────────────────────────────

/** Conversation Agent 调用 dialogue 工具时的输入 */
export interface DialogueToolInput {
  /** 目标智能体名称（如 code、learning） */
  target: string;
  /** 要发送的消息内容 */
  message: string;
  /** 附加上下文 */
  context?: Record<string, unknown>;
  /** 已有对话的 ID（续接对话时使用） */
  dialogueId?: string;
}

// ─────────────────────────────────────────────────────────────────
// 前端 Socket 事件
// ─────────────────────────────────────────────────────────────────

/** 推送给前端的对话状态事件 */
export interface DialogueStatusEvent {
  type: 'dialogue_status';
  dialogueId: string;
  status: 'started' | 'round_complete' | 'ended';
  from: string;
  to: string;
  round: number;
  /** Conversation 决定是否暴露的对话概要 */
  summary?: string;
}
