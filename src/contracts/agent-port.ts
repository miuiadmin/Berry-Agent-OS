/**
 * AgentPort — 13.0 灵魂版统一 Agent 间通信契约。
 *
 * 设计目标：
 * - 6 个原语覆盖 Agent 间所有通信模式
 * - 实现 100% 封装现有 dialogue.send/reply IPC，零新协议
 * - 安全门禁：禁止直接发消息给 Brain（to: 'brain' 在实现层拒绝）
 */

import type { ToolResult } from '../tools/types.js';
import { FORBIDDEN_TARGETS, DEFAULT_REQUEST_TIMEOUT_MS } from './agent-port-constants.js';

// ─────────────────────────────────────────────────────────────────
// 消息类型
// ─────────────────────────────────────────────────────────────────

/** 13.0 §2.3: 跨 agent 调用链条目 — 用于追踪多级串联调用的路径 */
export interface CallChainEntry {
  /** 发起方 agent */
  from: string;
  /** 接收方 agent */
  to: string;
  /** 调用时间戳 */
  ts: number;
}

/** Agent 间通信的消息载荷 */
export interface PortMessage {
  /** 目标 Agent 名称（禁止 'brain'，见 FORBIDDEN_TARGETS） */
  to: string;
  /** 消息内容（纯文本或结构化 JSON） */
  content: string;
  /** 附加上下文（文件路径、查询参数等） */
  context?: Record<string, unknown>;
  /** 13.0 §2.3: 跨 agent 调用链 — 由调用方传入，KernelRouter 用于循环检测 */
  callChain?: CallChainEntry[];
}

/** PortMessage 顶层元数据 */
export interface PortMessageMetadata {
  /** 自定义超时（ms），覆盖 request() 第二个参数 */
  timeoutMs?: number;
  /** 期望的最低置信度（0-1），低于此值的回复会被标记 needsClarification */
  confidenceFloor?: number;
}

/** request() 返回的回复 */
export interface PortReply {
  /** 回复方 Agent 名称 */
  from: string;
  /** 回复内容 */
  content: string;
  /** 回复方附加的元数据（对应 dialogue.reply 的 DialogueMetadata） */
  metadata?: PortReplyMetadata;
  /** 13.0 §2.3: 回复携带的调用链（调用方可用于调试和决策） */
  callChain?: CallChainEntry[];
}

/** 回复方附加的元数据 */
export interface PortReplyMetadata {
  /** 是否最终结果 */
  isFinal?: boolean;
  /** 是否需要澄清 */
  needsClarification?: boolean;
  /** 置信度 0-1 */
  confidence?: number;
}

// ─────────────────────────────────────────────────────────────────
// Agent 发现
// ─────────────────────────────────────────────────────────────────

/** 可用 Agent 的描述信息（discover() 返回值） */
export interface AgentInfo {
  /** Agent 名称（如 'memory', 'code', 'conversation'） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 该 Agent 支持的能力标签 */
  capabilities: string[];
  /**
   * L5: Agent 运行时状态。
   * - 'online': 进程已注册到 AgentManager 且 ready
   * - 'offline': 已安装但未启动 / 启动失败
   *
   * 不传时默认为 'online'（向后兼容）。
   */
  status?: 'online' | 'offline';
}

// ─────────────────────────────────────────────────────────────────
// askUser 选项
// ─────────────────────────────────────────────────────────────────

/** 向用户提问时的选项 */
export interface PortAskUserOptions {
  /** 选项列表（如 ['yes', 'no']），Agent 可以从中选择 */
  options?: string[];
  /** 附加上下文（帮助用户理解为什么被问） */
  context?: string;
  /** 超时时间（毫秒），默认 300000（§5.3.5 独立于 request 的 5 分钟超时） */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────
// port.on() 事件类型
// ─────────────────────────────────────────────────────────────────

/**
 * port.on() 接收到的事件载荷。
 *
 * 13.0 §2.1 AgentMessage 的简化版 — 去掉 Agent 记录的生命周期字段
 * （persistedAt / dispatchedAt 等），只保留事件核心属性。
 * 与 IpcMessage 字段对应，但 type 为自由 string（支持通配符匹配）。
 */
export interface PortEvent {
  /** 消息唯一 ID */
  id: string;
  /** 发送方 agent */
  from: string;
  /** 接收方 agent */
  to: string;
  /** 消息类型（如 'brain.observe', 'turn.correction'） */
  type: string;
  /** 消息内容 */
  payload: unknown;
  /** 消息时间戳 */
  timestamp: number;
  /** 关联 ID（串联 request ↔ response） */
  correlationId?: string;
  /** 所属会话 ID */
  sessionId?: string;
  /** 所属任务 ID */
  taskId?: string;
  /** 13.0 §2.3: 跨 agent 调用链 */
  callChain?: CallChainEntry[];
}

// ─────────────────────────────────────────────────────────────────
// AgentPort 接口（6 原语）
// ─────────────────────────────────────────────────────────────────

/**
 * Agent 间统一通信端口。
 *
 * 核心通信（3 个）：
 * - request: 请求-响应，等待回复（封装 dialogue.send → dialogue.reply）
 * - send: 即发即弃通知
 * - on: 注册事件处理器，支持通配符（如 'tool.*'）
 *
 * 便捷封装（3 个）：
 * - discover: 发现可用 Agent（不暴露 brain）
 * - askUser: 向用户提问（委托 ModuleAgentContext.askUser）
 * - useTool: 使用已注册工具（走 ToolRegistry）
 */
export interface AgentPort {
  /**
   * 请求-响应：发送消息并等待目标 Agent 回复。
   * 内部封装 dialogue.send → dialogue.reply IPC。
   *
   * @param msg 消息载荷（to 禁止为 'brain'）
   * @param timeoutMs 超时毫秒，默认 60000（与 DIALOGUE_DEFAULTS.replyTimeoutMs 一致）
   * @throws Error 当 to='brain'、目标不可用、超时、对话被中断时
   */
  request(msg: PortMessage, timeoutMs?: number): Promise<PortReply>;

  /**
   * 13.0 §4.4.6: 流式请求 — 发送消息并以 AsyncGenerator 形式逐 chunk 接收目标 Agent 输出。
   * 内部封装 dialogue.send + 持续接收 dialogue.reply（同 dialogueId）。
   * isFinal=true 时 generator 完成。
   *
   * 用途：
   *   - Code Agent 通过 Claude SDK 流式输出工具调用 + 推理
   *   - Conversation Agent 流式生成回复（前端 SSE 推送）
   *   - 长任务实时进度反馈
   *
   * 注意：当前 Kernel IPC 协议基于 request/reply（一次性），流式实现需要
   * Kernel 端先把流式 chunk 通过 EventBus → ws-event-bridge 推给调用方。
   * 本接口作为 v2 契约，运行时如目标 agent 不支持流式会降级为单次 request。
   *
   * @param msg 消息载荷
   * @param timeoutMs 整体超时（含所有 chunks）
   */
  requestStreaming(msg: PortMessage, timeoutMs?: number): AsyncGenerator<PortReply, void, undefined>;

  /**
   * 即发即弃通知。不等待回复，不抛超时错误。
   * 适用于日志、状态推送等场景。
   *
   * @param msg 消息载荷（to 禁止为 'brain'）
   */
  send(msg: PortMessage): void;

  /**
   * 13.0 §2.1 核心原语之一：注册事件处理器。
   *
   * 支持通配符模式（如 'tool.*' 匹配 'tool.audit'、'tool.started' 等）。
   * 返回取消注册函数 — 调用即移除该处理器。
   *
   * 实现层：对具体 type 直接注册 ipc.onMessage()；
   * 对通配符模式，注册所有匹配的已知 IPC 消息类型的分发器。
   *
   * @param type 消息类型或通配符模式（如 'brain.observe', 'tool.*', '*'）
   * @param handler 事件处理器
   * @returns 取消注册函数
   */
  on(type: string, handler: (msg: PortEvent) => Promise<void> | void): () => void;

  /**
   * 发现可用 Agent 列表。
   * 自动过滤掉 brain（Agent 不应知道 Brain 的存在）。
   */
  discover(): Promise<AgentInfo[]>;

  /**
   * 向用户提问，等待回复。
   * 委托给 ModuleAgentContext.askUser（已有的 agent.ask_user / agent.user_reply 协议）。
   *
   * @param question 问题文本
   * @param opts 选项（选项列表、超时等）
   */
  askUser(question: string, opts?: PortAskUserOptions): Promise<string>;

  /**
   * 使用当前进程已注册的工具。
   * 直接调用 ToolRegistry.execute，不走 IPC。
   *
   * @param name 工具名称
   * @param input 工具输入
   * @returns 工具执行结果
   */
  useTool(name: string, input: unknown): Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────
// Re-exports（实现层需要的常量在 agent-port-constants.ts）
// ─────────────────────────────────────────────────────────────────

export { FORBIDDEN_TARGETS, DEFAULT_REQUEST_TIMEOUT_MS };
